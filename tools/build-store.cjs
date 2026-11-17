// Builds the Chrome Web Store copy of the extension: dist/store (load it unpacked to try it) and a zip beside it to
// upload. The Desktop dev install is untouched: it keeps loading the repo's files, build.json and all.
//
// What the store copy leaves out, and why:
// - the code between "// @dev-only begin <name>" and "// @dev-only end <name>" (background.js and panel/panel.js):
//   the build.json self-reload, its alarm, the write lease that holds an update back, and the undo history handover
//   between install folders (historyFrom, historyReaders, onMessageExternal). Chrome updates a store install itself.
// - the "alarms" permission, which only the self-reload used;
// and what it adds: "unlimitedStorage" (no install warning). Every profile's original stays in the undo history, so
// the 10 MB default quota fills in time and every edit is then refused. The dev install can be reloaded instead.
// - build.json, tools/, test/, README.md, package.json and every other file not listed in SHIP;
//
// The build refuses (exit 1, nothing usable written) when a region named in REGIONS is missing, unclosed or nested,
// when any other file carries a marker, when a shipped file still names dev-only machinery (BANNED), or when a
// relative reference in a shipped file points at a file the build does not ship.
//
// Usage: node tools/build-store.cjs [--out <dir>]     (default: dist/store, zip at dist/<name>-<version>.zip)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(root, 'dist', 'store'));

/** Shipped paths: files, or folders taken whole. */
const SHIP = ['manifest.json', 'background.js', 'content.js', 'panel', 'src', 'icons', 'vendor/hackch', 'THIRD-PARTY.md'];
/** Every dev-only region, per file. Each must appear exactly once. */
const REGIONS = {
  'background.js': ['worker'],
  'panel/panel.js': ['worker-call', 'lease-vars', 'write-lease', 'write-lease-end', 'update-note', 'history-import', 'update-check',
    'stale-check', 'group-lease-vars', 'group-lease', 'group-lease-end'],
};
/**
 * Text that only the old prebuilt donor table carried ("hex" block strings of third-party origin). Change car now
 * builds its blocks from the player's own GLOBALB.BUN, and no shipped file may
 * hold the table again.
 */
const DONOR_MARK = /"hex"\s*:/;
/** The store manifest's permissions, exactly. */
const PERMISSIONS = ['storage', 'sidePanel', 'scripting', 'unlimitedStorage'];
/** Names of dev-only machinery that must not survive in any shipped text file. */
const BANNED = ['@dev-only', 'build.json', 'chrome.alarms', 'onMessageExternal', 'historyFrom', 'historyReaders',
  'writeBegin', 'writeRenew', 'writeEnd', 'checkUpdate', 'importHistory', 'runtime.reload', 'updateNote', 'importNote', 'workerHeal'];
const TEXT = /\.(js|json|html|css|txt|md)$/i;
const MARK = /^\s*\/\/ @dev-only (begin|end) ([a-z-]+)\s*$/;

const fail = (why) => { throw new Error(why); };
const rel = (p) => p.split(path.sep).join('/');

function listShipped() {
  const files = [];
  const walk = (r) => {
    const abs = path.join(root, r);
    if (!fs.existsSync(abs)) fail(`missing shipped path: ${r}`);
    if (fs.statSync(abs).isDirectory()) for (const e of fs.readdirSync(abs).sort()) walk(`${r}/${e}`);
    else files.push(r);
  };
  for (const s of SHIP) walk(s);
  return files;
}

/** Removes the named regions, markers included. Exported for the test. */
function strip(file, text, names) {
  const lines = text.split('\n'), keep = [], seen = new Map();
  let open = null;
  lines.forEach((line, i) => {
    const m = MARK.exec(line);
    if (!m) { if (!open) keep.push(line); return; }
    const [, kind, name] = m;
    if (!names.includes(name)) fail(`${file}:${i + 1}: unknown dev-only region "${name}"`);
    if (kind === 'begin') {
      if (open) fail(`${file}:${i + 1}: region "${name}" begins inside "${open.name}"`);
      if (seen.has(name)) fail(`${file}:${i + 1}: region "${name}" appears twice`);
      open = { name, line: i + 1 };
      seen.set(name, 0);
    } else {
      if (!open || open.name !== name) fail(`${file}:${i + 1}: end of "${name}" without its begin`);
      seen.set(name, i + 1 - open.line + 1);
      open = null;
    }
  });
  if (open) fail(`${file}:${open.line}: region "${open.name}" never ends`);
  for (const n of names) if (!seen.has(n)) fail(`${file}: dev-only region "${n}" not found`);
  return { text: keep.join('\n'), removed: Object.fromEntries(seen) };
}

function storeManifest(text) {
  const m = JSON.parse(text);
  m.permissions = (m.permissions || []).filter((p) => p !== 'alarms');
  if (!m.permissions.includes('unlimitedStorage')) m.permissions.push('unlimitedStorage');
  const want = [...PERMISSIONS].sort().join(','), got = [...m.permissions].sort().join(',');
  if (got !== want) fail(`store manifest permissions are [${got}], expected [${want}]`);
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** Relative references a shipped file makes: imports, workers, injected scripts, html src and href. */
function references(file, text) {
  const refs = [];
  const add = (r) => { if (!/^(https?:|data:|chrome:|#|\/)/.test(r)) refs.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), r))); };
  for (const m of text.matchAll(/\bfrom\s+'(\.{1,2}\/[^']+)'/g)) add(m[1]);
  for (const m of text.matchAll(/\bimport\s*\(\s*'(\.{1,2}\/[^']+)'/g)) add(m[1]);
  for (const m of text.matchAll(/new Worker\(\s*new URL\('([^']+)'/g)) add(m[1]);
  for (const m of text.matchAll(/files:\s*\[([^\]]+)\]/g)) for (const f of m[1].matchAll(/'([^']+)'/g)) refs.push(f[1]);
  if (file.endsWith('.html')) for (const m of text.matchAll(/\b(?:src|href)="([^"]+)"/g)) add(m[1]);
  return refs;
}

/** A zip of `entries` ([{ name, data }]), deflated, with a fixed timestamp so the same files give the same bytes. */
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1; // 1980-01-01 00:00
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, deflated);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(DOS_TIME, 12); cen.writeUInt16LE(DOS_DATE, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(deflated.length, 20);
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

function build() {
  const files = listShipped();
  const shipped = new Set(files);
  const entries = [], removed = {};
  for (const f of files) {
    let data = fs.readFileSync(path.join(root, f));
    if (TEXT.test(f)) {
      let text = data.toString('utf8');
      if (DONOR_MARK.test(text)) fail(`${f} carries donor table blocks, which the store build must not ship`);
      if (REGIONS[f]) { const r = strip(f, text, REGIONS[f]); text = r.text; removed[f] = r.removed; }
      else if (text.includes('@dev-only')) fail(`${f} carries a dev-only marker but is not listed in REGIONS`);
      if (f === 'manifest.json') text = storeManifest(text);
      for (const b of BANNED) if (text.includes(b)) fail(`${f} still names dev-only "${b}" in the store build`);
      for (const r of references(f, text)) if (!shipped.has(r)) fail(`${f} refers to ${r}, which the store build does not ship`);
      data = Buffer.from(text, 'utf8');
    }
    entries.push({ name: f, data });
  }
  for (const f of Object.keys(REGIONS)) if (!shipped.has(f)) fail(`${f} has dev-only regions but is not shipped`);
  // Every shipped script must still parse once its regions are gone.
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'store-check-'));
  try {
    for (const e of entries.filter((x) => x.name.endsWith('.js'))) {
      const p = path.join(tmp, e.name.replace(/[\\/]/g, '__').replace(/\.js$/, '.mjs'));
      fs.writeFileSync(p, e.data);
      try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe', windowsHide: true }); } catch (err) {
        fail(`${e.name} does not parse in the store build: ${String(err.stderr || err.message).split('\n').slice(0, 4).join(' | ')}`);
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  const zipName = `nfsu2-save-editor-${manifest.version}.zip`;
  const zipPath = path.join(path.dirname(out), zipName);
  const top = path.resolve(root);
  // The output folder is replaced whole, so it must be a folder of its own: never the repo or anything above it.
  if (out === top || top.startsWith(out + path.sep) || out === path.parse(out).root) fail(`refusing to replace ${out}`);
  fs.rmSync(out, { recursive: true, force: true });
  for (const e of entries) { const p = path.join(out, e.name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, e.data); }
  const z = zip(entries);
  fs.writeFileSync(zipPath, z);
  return {
    out, zip: zipPath, zipBytes: z.length, zipSha256: crypto.createHash('sha256').update(z).digest('hex'),
    files: entries.length, bytes: entries.reduce((n, e) => n + e.data.length, 0), permissions: manifest.permissions,
    hostPermissions: manifest.host_permissions, removed,
  };
}

module.exports = { strip, storeManifest, references, zip, SHIP, REGIONS, DONOR_MARK, BANNED, PERMISSIONS };

if (require.main === module) {
  try {
    console.log(JSON.stringify(build(), null, 2));
  } catch (err) {
    console.error(`build:store failed: ${err.message}`);
    process.exitCode = 1;
  }
}
