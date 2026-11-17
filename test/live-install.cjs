// Live proof of the install folder: a copy of the extension in a throwaway git repo whose hooks export each
// commit to a throwaway install folder. Checks the export (committed files only, stale files removed, other
// files kept, never from another worktree, never failing git), then loads the repo copy, the install folder and a
// third copy into a throwaway headless browser: the install folder brings the repo copy's undo history over once,
// the third copy is refused it, and a commit reloads the install folder's copy by itself.
// BROWSER_PATH picks another Chromium-based browser that honours --load-extension.
// Usage: node test/live-install.cjs <playwright module dir> <out dir>
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const [pwDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-install.cjs <playwright dir> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
const { unpackedId } = require('../tools/export-install.cjs');
const SRC = path.resolve(__dirname, '..');
const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ALARM_MS = 30000;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

fs.mkdirSync(outDir, { recursive: true });
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-install-')));
const repo = path.join(base, 'repo'), dest = path.join(base, 'Installed copy'), other = path.join(base, 'other');
const SHIPPED = ['manifest.json', 'background.js', 'content.js', 'panel', 'src', 'vendor', 'icons', 'tools', '.gitignore'];
for (const p of SHIPPED) {
  fs.cpSync(path.join(SRC, p), path.join(repo, p), { recursive: true });
  fs.cpSync(path.join(SRC, p), path.join(other, p), { recursive: true });
}
const gitArgs = (args) => ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args];
const git = (...args) => execFileSync('git', gitArgs(args), { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
// chrome.storage hands objects back with their keys sorted, so compare canonical JSON.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const stampOf = (dir) => JSON.parse(read(dir, 'build.json'));
const logTail = () => read(repo, '.git', 'nfsu2-install.log').trim().split('\n').pop();
let n = 0;
const noopCommit = () => { fs.writeFileSync(path.join(repo, 'noop.txt'), `no-op ${++n}\n`); git('add', 'noop.txt'); git('commit', '-q', '-m', `no-op ${n}`); return git('rev-parse', '--short=7', 'HEAD'); };

git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-q', '-m', 'base');
execFileSync(process.execPath, ['tools/install-hooks.cjs', '--install-dir', dest], { cwd: repo, windowsHide: true });
const headFiles = () => git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean).sort();
const destFiles = () => {
  const out = [];
  const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), `${pre}${e.name}/`); else out.push(pre + e.name); } };
  walk(dest, '');
  return out.sort();
};

// ---- The export ----
const extra = ['.install-files.json', 'build.json'];
check('the install folder holds exactly the committed files, plus its record and build.json',
  JSON.stringify(destFiles()) === JSON.stringify([...headFiles(), ...extra].sort()), `${destFiles().length} files`);
check('its build.json names HEAD and the repo copy as the history source',
  stampOf(dest).commit === git('rev-parse', 'HEAD') && JSON.stringify(stampOf(dest).historyFrom) === JSON.stringify([unpackedId(repo)]));
check('the repo build.json lets only the install folder read its history', JSON.stringify(stampOf(repo).historyReaders) === JSON.stringify([unpackedId(dest)]));
check('build.json and the export stay out of git', git('status', '--porcelain') === '', git('status', '--porcelain') || 'clean');

const css = path.join('panel', 'panel.css');
const cssCommitted = read(repo, css);
fs.appendFileSync(path.join(repo, css), '\n/* work in progress */\n');
fs.writeFileSync(path.join(dest, 'my notes.txt'), 'not the export\'s\n');
noopCommit();
check('work in progress never reaches the install folder', read(dest, css) === cssCommitted);
fs.writeFileSync(path.join(repo, css), cssCommitted);
check('a commit updates the install folder', fs.existsSync(path.join(dest, 'noop.txt')) && stampOf(dest).commit === git('rev-parse', 'HEAD'), logTail());
git('rm', '-q', 'noop.txt');
git('commit', '-q', '-m', 'drop noop');
check('a file HEAD no longer has is removed from the install folder', !fs.existsSync(path.join(dest, 'noop.txt')));
check('a file the export did not write is left alone', fs.existsSync(path.join(dest, 'my notes.txt')));

const before = stampOf(dest).commit;
const wt = path.join(base, 'wt');
git('worktree', 'add', '-q', '-b', 'side', wt);
execFileSync('git', gitArgs(['commit', '-q', '--allow-empty', '-m', 'side']), { cwd: wt, windowsHide: true });
check('a commit in another worktree does not export', stampOf(dest).commit === before, read(repo, '.git', 'nfsu2-install.log').trim().split('\n').slice(-2).join(' | '));
// The install branch checked out in a linked worktree still does not export: only the main worktree does.
git('switch', '-q', '-c', 'parked');
check('switching the main worktree to another branch does not export', stampOf(dest).commit === before, logTail());
const inWt = (...args) => execFileSync('git', gitArgs(args), { cwd: wt, windowsHide: true });
inWt('switch', '-q', 'main');
inWt('commit', '-q', '--allow-empty', '-m', 'main from a linked worktree');
check('a commit on the install branch in a linked worktree does not export', stampOf(dest).commit === before, logTail());
inWt('switch', '-q', 'side');
git('switch', '-q', 'main');

git('config', 'nfsu2.installDir', path.join(dest, 'my notes.txt', 'cannot'));
const bad = spawnSync('git', gitArgs(['commit', '-q', '--allow-empty', '-m', 'export fails']), { cwd: repo, windowsHide: true });
check('a failing export never fails the git command', bad.status === 0 && /export failed/.test(logTail()), logTail().slice(0, 140));
git('config', 'nfsu2.installDir', dest);
noopCommit();

(async () => {
  // The third copy asks the repo copy for its history too; the repo copy lists only the install folder.
  fs.writeFileSync(path.join(other, 'build.json'), JSON.stringify({ commit: '0'.repeat(40), short: '0000000', historyFrom: [unpackedId(repo)] }));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-install-chrome-'));
  const all = [repo, dest, other].join(',');
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: BROWSER, viewport: { width: 420, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${all}`, `--load-extension=${all}`],
  });
  try {
    const want = { repo: unpackedId(repo), dest: unpackedId(dest), other: unpackedId(other) };
    const t0 = Date.now();
    while (ctx.serviceWorkers().length < 3 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 250));
    const loaded = ctx.serviceWorkers().map((w) => new URL(w.url()).host);
    check('the browser gives each folder the ID tools/export-install.cjs computes', Object.values(want).every((id) => loaded.includes(id)), loaded.join(' '));
    const worker = (id) => ctx.serviceWorkers().find((w) => w.url().includes(id));
    const local = (id, key) => worker(id).evaluate((k) => chrome.storage.local.get(k).then((r) => r[k] ?? null), key);

    const hist = { original: { at: 1, hash: 'h0', career: 'AA==', garage: null }, entries: [{ id: 'e1', at: 2, label: 'Money set to $1', career: 'AA==', garage: null }] };
    await worker(want.repo).evaluate((h) => chrome.storage.local.set({ 'hist:save/Racer': h, musicScan: { folder: 'Music', when: 1, files: 0, scanned: 0, zips: 0, found: [], rows: [] }, gameDb: { big: true } }), hist);

    const openPanel = async (id) => {
      const p = await ctx.newPage();
      await p.goto(`chrome-extension://${id}/panel/panel.html`);
      await p.waitForFunction(() => document.getElementById('conn').textContent.trim().length > 0, null, { timeout: 20000 });
      await p.waitForTimeout(1500);
      return p;
    };
    let panel = await openPanel(want.dest);
    const toast = (await panel.textContent('#toastText')) || '';
    check('the install folder copy says it brought the history over', /Brought over the undo history of 1 profile/.test(toast), toast);
    const got = await local(want.dest, 'hist:save/Racer');
    check('the history arrives whole, original included', same(got, hist), JSON.stringify(got).slice(0, 200));
    check('the music check comes too, the game data does not', (await local(want.dest, 'musicScan'))?.folder === 'Music' && (await local(want.dest, 'gameDb')) === null);
    await panel.screenshot({ path: path.join(outDir, 'panel-imported.png') });
    await panel.close();
    panel = await openPanel(want.dest);
    check('the import note shows once', !/Brought over/.test((await panel.textContent('#toastText')) || ''));
    // B13: a malformed music check in the old install is not carried over. The import runs again with its marker cleared.
    await worker(want.repo).evaluate(() => chrome.storage.local.set({ musicScan: { folder: 'Music', found: 'x', rows: 5 } }));
    await worker(want.dest).evaluate(() => chrome.storage.local.remove(['historyImported', 'musicScan']));
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'importHistory' }));
    check('B13 a malformed music check from the old install is not carried over', (await local(want.dest, 'musicScan')) === null && (await local(want.dest, 'historyImported')) !== null);
    await panel.close();

    panel = await openPanel(want.other);
    check('a copy the repo does not list gets nothing', (await local(want.other, 'hist:save/Racer')) === null && (await local(want.other, 'historyImported')) === null);
    await panel.close();

    // A commit exports to the install folder, and its copy reloads itself.
    await worker(want.dest).evaluate(() => chrome.storage.session.set({ testMarker: 1 }));
    const c = noopCommit();
    check('the commit reached the install folder', stampOf(dest).short === c, logTail());
    let secs = null;
    const t1 = Date.now();
    while (Date.now() - t1 < ALARM_MS + 15000) {
      await new Promise((r) => setTimeout(r, 1000));
      const w = worker(want.dest);
      if (w && await w.evaluate(async () => (await chrome.storage.session.get('testMarker')).testMarker === undefined).catch(() => false)) { secs = (Date.now() - t1) / 1000; break; }
    }
    check('the install folder copy reloads itself after the commit', secs != null, secs != null ? `${secs.toFixed(0)}s` : 'no reload');
    check('its undo history survives that reload', same(await local(want.dest, 'hist:save/Racer'), hist));
  } catch (err) {
    check('live install run', false, String(err && err.stack || err));
  } finally {
    await ctx.close();
    console.log(`\n${pass}/${pass + fail} pass`);
    process.exitCode = fail ? 1 : 0;
  }
})();
