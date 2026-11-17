// Copies the committed tree (HEAD, never the working tree) into the install folder that Chrome loads, so a commit
// updates the installed extension and work in progress never reaches it. Set the folder once per clone:
//   node tools/install-hooks.cjs --install-dir "<folder>"
// It runs from tools/stamp-build.cjs after every commit, checkout, merge and rewrite, and only:
// - in the main worktree, on the install branch (git config nfsu2.installBranch, default main), never detached;
// - into the configured folder, and never into this repo.
// Files are written then renamed. A file is removed only when an earlier export wrote it and HEAD no longer has
// it, so anything else in the folder is left alone. build.json is written last: the installed extension reloads
// when it changes (background.js), so it never sees half an export.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RECORD = '.install-files.json';
const run = (root, args, opts = {}) => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 64 << 20, ...opts });
const git = (root, ...args) => run(root, args, { encoding: 'utf8' }).trim();
const gitOr = (root, fallback, ...args) => { try { return git(root, ...args); } catch { return fallback; } };

/** The ID Chromium gives an unpacked extension on Windows: SHA-256 of the folder path in UTF-16, first 32 hex digits as a-p. */
function unpackedId(dir) {
  let p = path.resolve(dir);
  try { p = fs.realpathSync.native(p); } catch { /* not there yet: use the path as given */ }
  const hex = crypto.createHash('sha256').update(Buffer.from(p.replace(/\//g, '\\'), 'utf16le')).digest('hex');
  return hex.slice(0, 32).replace(/./g, (h) => String.fromCharCode(97 + parseInt(h, 16)));
}

/** Sync pause for a retry: OneDrive can hold a file open for a moment. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (err) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      pause(150 * (i + 1));
    }
  }
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-install`;
  retry(() => fs.writeFileSync(tmp, data));
  retry(() => fs.renameSync(tmp, file));
}

/** Where to export, or why not. */
function target(root) {
  const dir = gitOr(root, '', 'config', '--get', 'nfsu2.installDir');
  if (!dir) return { skip: 'no install folder set' };
  const out = path.resolve(dir);
  const top = path.resolve(root);
  if (out === top || out.startsWith(top + path.sep) || top.startsWith(out + path.sep)) return { skip: `install folder overlaps the repo: ${out}` };
  const gitDir = path.resolve(root, git(root, 'rev-parse', '--git-dir'));
  const common = path.resolve(root, git(root, 'rev-parse', '--git-common-dir'));
  if (gitDir !== common) return { skip: 'not the main worktree' };
  const branch = gitOr(root, '', 'symbolic-ref', '--quiet', '--short', 'HEAD');
  const want = gitOr(root, 'main', 'config', '--get', 'nfsu2.installBranch') || 'main';
  if (branch !== want) return { skip: `on ${branch || 'a detached HEAD'}, installs from ${want}` };
  return { dir: out };
}

/**
 * Exports HEAD to the install folder. stamp is the repo's build.json content; the folder's own build.json adds
 * historyFrom, the repo install's ID, so the installed copy can bring its undo history over (background.js).
 */
function exportInstall(root, stamp) {
  const t = target(root);
  if (t.skip) return { skipped: t.skip };
  const { dir } = t;
  fs.mkdirSync(dir, { recursive: true });
  const recordFile = path.join(dir, RECORD);
  let before = {};
  try { before = JSON.parse(fs.readFileSync(recordFile, 'utf8')).files || {}; } catch { /* first export */ }

  const files = {};
  for (const line of git(root, 'ls-tree', '-r', '-z', 'HEAD').split('\0').filter(Boolean)) {
    const m = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/s.exec(line);
    if (!m || m[1] === '120000') continue; // symlinks and submodules are not shipped
    const rel = m[3];
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep) || rel === RECORD || rel === 'build.json') continue;
    files[rel] = m[2];
  }
  let written = 0, removed = 0;
  for (const [rel, sha] of Object.entries(files)) {
    const abs = path.resolve(dir, rel);
    if (before[rel] === sha && fs.existsSync(abs)) continue;
    writeAtomic(abs, run(root, ['cat-file', 'blob', sha]));
    written++;
  }
  for (const rel of Object.keys(before)) {
    if (files[rel]) continue;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) continue;
    try { retry(() => fs.unlinkSync(abs)); removed++; } catch (err) { if (err.code !== 'ENOENT') throw err; }
    // Folders the export emptied go too; one with anything else in it stays.
    for (let d = path.dirname(abs); d !== dir && d.startsWith(dir + path.sep); d = path.dirname(d)) {
      try { fs.rmdirSync(d); } catch { break; }
    }
  }
  writeAtomic(recordFile, `${JSON.stringify({ commit: stamp.commit, files }, null, 2)}\n`);
  writeAtomic(path.join(dir, 'build.json'), `${JSON.stringify({ ...stamp, historyFrom: [unpackedId(root)] }, null, 2)}\n`);
  return { dir, written, removed, files: Object.keys(files).length };
}

module.exports = { exportInstall, target, unpackedId };
