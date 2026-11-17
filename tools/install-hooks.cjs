// Installs the git hooks that keep build.json current and export each commit to the install folder, so the
// installed unpacked extension updates itself after every commit. Run once per clone:
//   node tools/install-hooks.cjs --install-dir "<folder Chrome loads>"
// Without --install-dir the folder set before is kept (git config nfsu2.installDir).
// A hook file that someone else wrote is left alone and reported, never overwritten.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const hooksDir = path.resolve(root, git('rev-parse', '--git-path', 'hooks'));
const MARK = '# nfsu2-save-editor-ext: build stamp';
// post-rewrite covers rebase and amend; post-checkout and post-merge cover branch switches and pulls.
const HOOKS = ['post-commit', 'post-checkout', 'post-merge', 'post-rewrite'];
const body = `#!/bin/sh\n${MARK} (tools/install-hooks.cjs). It never fails the git command.\nnode tools/stamp-build.cjs >/dev/null 2>&1 || true\n`;

const at = process.argv.indexOf('--install-dir');
if (at > 0) {
  const dir = process.argv[at + 1];
  if (!dir) { console.error('--install-dir needs a folder'); process.exit(2); }
  git('config', 'nfsu2.installDir', path.resolve(dir));
}

fs.mkdirSync(hooksDir, { recursive: true });
let skipped = 0;
for (const name of HOOKS) {
  const file = path.join(hooksDir, name);
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARK)) {
    console.log(`left alone: ${file} (not ours). Add this line to it: node tools/stamp-build.cjs`);
    skipped++;
    continue;
  }
  fs.writeFileSync(file, body, { mode: 0o755 });
  console.log(`installed: ${name}`);
}
execFileSync(process.execPath, [path.join(__dirname, 'stamp-build.cjs'), '--print'], { cwd: root, stdio: 'inherit', windowsHide: true });
process.exitCode = skipped ? 1 : 0;
