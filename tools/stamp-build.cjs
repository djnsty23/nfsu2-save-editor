// Writes build.json, the commit this folder is at, then exports that commit to the install folder
// (tools/export-install.cjs). The installed unpacked extension reads build.json from disk and reloads itself when
// it changes (background.js). The git hooks from tools/install-hooks.cjs run this after every commit, checkout,
// merge and rebase. build.json is not committed: it names the commit that holds it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { exportInstall, unpackedId } = require('./export-install.cjs');

const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const print = process.argv.includes('--print');
const commit = git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`git rev-parse HEAD printed ${JSON.stringify(commit)}`);
const stamp = { commit, short: commit.slice(0, 7), at: new Date().toISOString() };

let installDir = '';
try { installDir = git('config', '--get', 'nfsu2.installDir'); } catch { /* none set */ }
// This copy hands its undo history only to the install folder's copy, which asks for it once (background.js).
const own = installDir ? { ...stamp, historyReaders: [unpackedId(installDir)] } : stamp;
// Write then rename, so the extension never reads half a file.
const out = path.join(root, 'build.json'), tmp = `${out}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(own, null, 2)}\n`);
fs.renameSync(tmp, out);
if (print) console.log(`build.json: ${stamp.short} at ${stamp.at}`);

// The export never fails the git command. Its outcome goes to a log in the git folder, since hooks print nowhere.
let line;
try {
  const r = exportInstall(root, stamp);
  line = r.skipped ? `skipped: ${r.skipped}` : `exported ${stamp.short} to ${r.dir}: ${r.written} written, ${r.removed} removed, ${r.files} files`;
} catch (err) {
  line = `export failed: ${String(err && err.stack || err).replace(/\s*\n\s*/g, ' | ')}`;
  process.exitCode = 1;
}
try { fs.appendFileSync(path.resolve(root, git('rev-parse', '--git-path', 'nfsu2-install.log')), `${new Date().toISOString()} ${line}\n`); } catch { /* the log is best effort */ }
if (print) console.log(`install: ${line}`);
