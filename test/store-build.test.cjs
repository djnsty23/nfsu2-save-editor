// The Chrome Web Store build (tools/build-store.cjs): what it ships, what it leaves out, and that it refuses a broken
// marker instead of shipping dev code. Builds into a temp folder, never into dist/.
// Usage: node test/store-build.test.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { strip } = require('../tools/build-store.cjs');

const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
// sha256 prefixes of the owner's names, lower case. Add one with:
// node -e "console.log(require('crypto').createHash('sha256').update('<name>').digest('hex').slice(0,16))"
// Also the two real in-game profile names, so a comment naming a real career cannot ship again.
const OWNER_DIGESTS = new Set(['6177321eac992341', 'b9352494463399aa', '76432c875374f452', '8213c36adcda5bae', '6c3de7f9faa33014', 'fe48ee602b0981ce']);
const digest = (w) => require('crypto').createHash('sha256').update(w).digest('hex').slice(0, 16);
function ownerScan(entries) {
  const user = path.basename(os.homedir()).toLowerCase();
  const hits = [];
  for (const { name, data } of entries) {
    for (const [where, text] of [['name', name], ['content', data.toString('utf8')], ['utf16', data.toString('utf16le')]]) {
      const pathHit = text.match(/[A-Za-z]:[\\/]+Users[\\/]|\/Users\/|\/home\//);
      if (pathHit) hits.push(`${name} ${where}: user-profile path`);
      for (const w of new Set(text.toLowerCase().match(/[a-z0-9]+/g) || [])) {
        if (w === user || OWNER_DIGESTS.has(digest(w))) { hits.push(`${name} ${where}: owner word ${digest(w)}`); break; }
      }
    }
  }
  return hits;
}
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-build-test-'));
const out = path.join(tmp, 'store');
try {
  let report = null, err = '';
  try { report = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/build-store.cjs'), '--out', out], { encoding: 'utf8', windowsHide: true })); }
  catch (e) { err = String(e.stderr || e.message); }
  check('the store build runs on the repo as it is', !!report, err.trim());
  if (report) {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.relative(out, path.join(d, e.name)).split(path.sep).join('/')); };
    walk(out);
    const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
    const manifest = JSON.parse(read('manifest.json'));
    check('the store manifest asks for storage, unlimitedStorage, sidePanel and scripting only (no alarms)', manifest.permissions.slice().sort().join(',') === 'scripting,sidePanel,storage,unlimitedStorage', manifest.permissions.join(','));
    check('the store manifest keeps the one host permission, nfsu2.xyz', JSON.stringify(manifest.host_permissions) === '["https://nfsu2.xyz/*"]', JSON.stringify(manifest.host_permissions));
    check('the store manifest declares no externally_connectable, web_accessible_resources or content_security_policy override',
      !('externally_connectable' in manifest) && !('web_accessible_resources' in manifest) && !('content_security_policy' in manifest));
    const devOnly = files.filter((f) => /^(test|tools|dist)\/|^(README\.md|package\.json|build\.json|\.gitignore)$/.test(f));
    check('no dev file ships (test/, tools/, README.md, package.json, build.json)', devOnly.length === 0, devOnly.join(', '));
    for (const f of ['manifest.json', 'background.js', 'content.js', 'panel/panel.html', 'panel/panel.js', 'panel/music-card.js', 'src/ops.js', 'src/preset-worker.js', 'vendor/hackch/LICENSE', 'icons/icon128.png']) {
      check(`ships ${f}`, files.includes(f));
    }
    const bg = read('background.js');
    check('the store worker keeps the side panel behaviour and the content script re-injection', bg.includes('setPanelBehavior') && bg.includes('onInstalled') && bg.includes("files: ['content.js']"));
    // Session storage stays for the music handover (panel/now-playing.js). The dev-only stamp and write leases must not.
    check('the store worker has no message listener, alarm, stamp, lease or reload', !/onMessage|alarms|build\.json|runtime\.reload|loadedBuild|writeLeases/.test(bg), bg.match(/onMessage\w*|alarms|build\.json|runtime\.reload|loadedBuild|writeLeases/g)?.join(',') || '');
    check('the store worker keeps the music handover to the player window', bg.includes("'panel/player.html'") && bg.includes('onConnect') && bg.includes('setPopup'));
    const panel = read('panel/panel.js');
    check('the store panel keeps the edit path (write, history, Undo)', panel.includes('async function edit(') && panel.includes("type: 'write'") && panel.includes('hist.record('));
    check('the store panel never messages the worker', !/runtime\.sendMessage|toWorker|\blease\b/.test(panel), panel.match(/runtime\.sendMessage|toWorker|\blease\b/g)?.join(',') || '');
    // E6: the old prebuilt donor table is gone from both builds. The mark must fire on a line in the old table's shape,
    // and no shipped file, nor any file the repo tracks, may carry it.
    const { DONOR_MARK } = require('../tools/build-store.cjs');
    check('E6 the donor mark fires on a line in the old table\'s shape', DONOR_MARK.test('{ "off": 22640, "hex": "0A FF 3C" }'));
    const carrying = files.filter((f) => /\.(js|json|html|md)$/.test(f) && DONOR_MARK.test(read(f)));
    check('E6 no shipped file carries donor table blocks', carrying.length === 0, carrying.join(', '));
    const tracked = require('child_process').execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => /\.(js|mjs|cjs|json)$/.test(f) && !f.startsWith('test/'));
    const inRepo = tracked.filter((f) => fs.existsSync(path.join(root, f)) && DONOR_MARK.test(fs.readFileSync(path.join(root, f), 'utf8')));
    check('E6 no file in the repo carries donor table blocks, and car-donors.js is gone', tracked.length > 20 && inRepo.length === 0 && !fs.existsSync(path.join(root, 'vendor/hackch/data/car-donors.js')) && !files.includes('vendor/hackch/data/car-donors.js'), `${tracked.length} tracked files read; ${inRepo.join(', ')}`);
    check('E6 the store build ships the donor builder', files.includes('src/donors.js'));
    check('ships THIRD-PARTY.md', files.includes('THIRD-PARTY.md'));
    check('ships the ready-made garage and its format, not its generator', files.includes('src/garage-data.js') && files.includes('src/garage-designs.js') && !files.some((f) => /garage-refresh/.test(f)));
    let garageBad = '';
    try { execFileSync(process.execPath, [path.join(root, 'test/check-garage-file.mjs'), path.join(out, 'src/garage-data.js')], { encoding: 'utf8', windowsHide: true }); } catch (err) { garageBad = String(err.stdout || err.message).trim() || 'refused'; }
    check('the store copy of the ready-made garage passes the allowlist (no profile name or other stray text)', !garageBad, garageBad);
    // Read the zip back with zlib alone: every entry inflates to the same bytes as the folder.
    const z = fs.readFileSync(report.zip);
    const count = z.readUInt16LE(z.length - 22 + 10), cenAt = z.readUInt32LE(z.length - 22 + 16);
    let p = cenAt, same = 0;
    const bad = [], entries = [];
    for (let i = 0; i < count; i++) {
      const nameLen = z.readUInt16LE(p + 28), local = z.readUInt32LE(p + 42), size = z.readUInt32LE(p + 20);
      const name = z.toString('utf8', p + 46, p + 46 + nameLen);
      const lname = z.readUInt16LE(local + 26), start = local + 30 + lname;
      const data = zlib.inflateRawSync(z.subarray(start, start + size));
      entries.push({ name, data });
      if (data.equals(fs.readFileSync(path.join(out, name)))) same++; else bad.push(name);
      p += 46 + nameLen;
    }
    check('the zip holds every shipped file, byte for byte', count === files.length && same === files.length, `${same}/${count} entries match, ${files.length} files${bad.length ? `, differ: ${bad.join(',')}` : ''}`);
    // No owner identity ships: whole-word owner names (kept here as digests, never plaintext), this machine's user
    // folder name, and any path under a user profile, in every zip entry's name and inflated contents.
    const ownerHits = ownerScan(entries);
    check('no zip entry name or content carries an owner name, the user folder name or a user-profile path', ownerHits.length === 0, ownerHits.slice(0, 5).join(' | '));
    check('the owner scan fires on a planted hit', ownerScan([{ name: 'x.js', data: Buffer.from(`// see C:\\Users\\${path.basename(os.homedir())}\\x`) }]).length > 0);
  }

  // strip() refuses every broken marker shape.
  const B = '// @dev-only begin a', E = '// @dev-only end a';
  check('strip removes a region and its markers', strip('f', `x\n${B}\ny\n${E}\nz`, ['a']).text === 'x\nz');
  check('strip refuses a missing region', /not found/.test(throws(() => strip('f', 'x', ['a']))));
  check('strip refuses a region that never ends', /never ends/.test(throws(() => strip('f', `${B}\ny`, ['a']))));
  check('strip refuses an end without a begin', /without its begin/.test(throws(() => strip('f', `y\n${E}`, ['a']))));
  check('strip refuses a nested region', /begins inside/.test(throws(() => strip('f', `${B}\n// @dev-only begin b\n// @dev-only end b\n${E}`, ['a', 'b']))));
  check('strip refuses a region twice', /twice/.test(throws(() => strip('f', `${B}\n${E}\n${B}\n${E}`, ['a']))));
  check('strip refuses an unknown region name', /unknown/.test(throws(() => strip('f', '// @dev-only begin zz\n// @dev-only end zz', ['a']))));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
