// Live proof of the self-update: a copy of the extension in its own throwaway git repo, loaded unpacked into a
// throwaway headless Chrome profile on https://nfsu2.xyz. A no-op commit must reload the extension within one
// alarm period, keep the undo history, keep the site tab working without reloading it, and show the update
// note once. A commit while a save write holds its lease must wait for the write to end.
// BROWSER_PATH picks another Chromium-based browser that honours --load-extension.
// Usage: node test/live-update.cjs <playwright module dir> <test profile folder> <out dir> [GLOBALB.BUN]
// With GLOBALB.BUN it also runs Best version of every car with a commit landing mid-run, and the worker-channel checks.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const [pwDir, profDir, outDir, bunPath] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-update.cjs <playwright dir> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
const SRC = path.resolve(__dirname, '..');
const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const NAME = path.basename(profDir);
const ALARM_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

// The copy: the extension's shipped files only, committed in a fresh repo with the hooks installed.
fs.mkdirSync(outDir, { recursive: true });
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-update-'));
for (const p of ['manifest.json', 'background.js', 'content.js', 'panel', 'src', 'vendor', 'icons', 'tools', '.gitignore']) {
  fs.cpSync(path.join(SRC, p), path.join(repo, p), { recursive: true });
}
const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q');
git('add', '.');
git('commit', '-q', '-m', 'base');
execFileSync(process.execPath, ['tools/install-hooks.cjs'], { cwd: repo, windowsHide: true });
const stamp = () => JSON.parse(fs.readFileSync(path.join(repo, 'build.json'), 'utf8'));
let n = 0;
const noopCommit = () => {
  fs.writeFileSync(path.join(repo, 'noop.txt'), `no-op ${++n}\n`);
  git('add', 'noop.txt');
  git('commit', '-q', '-m', `no-op ${n}`);
  return git('rev-parse', '--short=7', 'HEAD');
};
check('install-hooks stamps the current commit', stamp().commit === git('rev-parse', 'HEAD'), stamp().short);
check('build.json stays out of git', git('status', '--porcelain') === '', git('status', '--porcelain') || 'clean');

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-update-chrome-'));
  // Loaded with --load-extension, the same unpacked install as Load unpacked. An extension added over the DevTools
  // pipe (Extensions.loadUnpacked) is unloaded, not reloaded, by chrome.runtime.reload(), so it cannot prove this.
  // Branded Chrome 137+ ignores --load-extension; Edge, the same engine, still honours it.
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: BROWSER, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${repo}`, `--load-extension=${repo}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));

    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    const files = { [NAME]: [...fs.readFileSync(path.join(profDir, NAME))] };
    if (fs.existsSync(path.join(profDir, 'GARAGE.DAT'))) files['GARAGE.DAT'] = [...fs.readFileSync(path.join(profDir, 'GARAGE.DAT'))];
    await site.evaluate(async ({ name, files }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true })).getDirectoryHandle(name, { create: true });
      for (const [n, bytes] of Object.entries(files)) { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); }
    }, { name: NAME, files });
    await site.reload({ waitUntil: 'load' });
    await site.waitForTimeout(2500);
    // A marker in the page: if the site tab were reloaded, it would be gone.
    await site.evaluate(() => { window.__notReloaded = 1; });

    const openPanel = async () => {
      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
      await panel.waitForFunction(() => /Connected|Read only|Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 20000 });
      await panel.selectOption('#profile', NAME).catch(() => {});
      return panel;
    };
    const history = (panel) => panel.evaluate(async (name) => (await chrome.storage.local.get(`hist:save/${name}`))[`hist:save/${name}`]?.entries?.length ?? 0, NAME);
    // The extension reloaded when its session storage (cleared by a reload) loses the marker set here.
    const markSession = (panel) => panel.evaluate(() => chrome.storage.session.set({ testMarker: 1 }));
    // Asked of the service worker, not a panel page: opening the panel would use up the one-time update note.
    const waitReload = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await new Promise((r) => setTimeout(r, 1000));
        for (const w of ctx.serviceWorkers().filter((x) => x.url().includes(extId))) {
          const gone = await w.evaluate(async () => (await chrome.storage.session.get('testMarker')).testMarker === undefined).catch(() => false);
          if (gone) return { probe: w, secs: (Date.now() - t0) / 1000 };
        }
      }
      return { probe: null, secs: null };
    };

    let panel = await openPanel();
    check('panel connects to the site tab', /safe to edit/.test(await panel.textContent('#conn')), await panel.textContent('#conn'));
    const edits = await panel.evaluate(() => Number(document.body.dataset.edits || 0));
    await panel.click('#maxMoney');
    await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, edits, { timeout: 60000 });
    const histBefore = await history(panel);
    check('a write before the update lands in undo history', histBefore >= 1, `${histBefore} entries`);
    await markSession(panel);
    await panel.close();

    // 1. A no-op commit reloads the extension within one alarm period.
    const c1 = noopCommit();
    check('the post-commit hook stamps the new commit', stamp().short === c1, c1);
    let r = await waitReload(ALARM_MS + 15000);
    check('the extension reloads by itself within one alarm period', r.secs != null, r.secs != null ? `${r.secs.toFixed(0)}s` : 'no reload');
    panel = await openPanel();
    const toast1 = (await panel.textContent('#toastText')) || '';
    check('the panel says "Updated to <hash>" after the reload', toast1.includes(`Updated to ${c1}`), toast1);
    check('the panel still talks to the same, unreloaded site tab', /safe to edit/.test(await panel.textContent('#conn')) && await site.evaluate(() => window.__notReloaded === 1), await panel.textContent('#conn'));
    check('undo history survives the reload', (await history(panel)) === histBefore, `${await history(panel)} entries`);
    await panel.screenshot({ path: path.join(outDir, 'panel-after-update.png'), fullPage: true });
    await panel.close();
    panel = await openPanel();
    const toast2 = (await panel.textContent('#toastText')) || '';
    check('the update note shows once', !toast2.includes('Updated to') && await panel.isHidden('#toast'), toast2 || 'no toast');

    // 2. While a write holds its lease, a new commit waits; it applies once the write ends.
    const lease = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'writeBegin' }));
    check('a write gets a lease', lease?.ok === true);
    await markSession(panel);
    const c2 = noopCommit();
    await sleep(ALARM_MS + 15000); // not panel.waitForTimeout: a reload that closes the panel must fail the check below, not crash
    const still = await panel.evaluate(async () => (await chrome.storage.session.get('testMarker')).testMarker === 1).catch(() => false);
    check('no reload while a write is in progress', still && !panel.isClosed());
    const waiting = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'checkUpdate' })).catch(() => null);
    check('the worker reports the update as waiting', waiting?.waiting === c2, JSON.stringify(waiting));
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'writeEnd', id }), lease.id);
    r = await waitReload(ALARM_MS + 15000);
    check('the waiting update applies after the write ends', r.secs != null, r.secs != null ? `${r.secs.toFixed(0)}s` : 'no reload');
    if (r.probe) {
      const note = await r.probe.evaluate(async () => (await chrome.storage.local.get('updateNote')).updateNote ?? null);
      check('the note names the new commit', note?.to === c2, JSON.stringify(note));
    }
    // 3. The worker refuses messages from anything but the panel.
    const fromSite = await site.evaluate(() => typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage).catch(() => false);
    check('the site page cannot message the worker (no chrome.runtime there)', fromSite === false);

    // 4. With game data (the optional GLOBALB.BUN argument), at a 1429 px panel like the one in the bug report.
    if (bunPath) {
      panel = await openPanel();
      await panel.setViewportSize({ width: 1429, height: 1353 });
      await panel.setInputFiles('#dbFile', bunPath);
      await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
      const edits = () => panel.evaluate(() => Number(document.body.dataset.edits || 0));
      const clickAndWait = async (sel, ms = 60000) => { const n0 = await edits(); await panel.click(sel); await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n0, { timeout: ms }); return (await panel.textContent('#toastText')) || ''; };
      // Chrome's own error when the background worker takes no message (starting, stopping or swapped by an update),
      // for the first `times` messages to it.
      const dropWorker = (times) => panel.evaluate((times) => {
        window.realRuntimeSend = window.realRuntimeSend || chrome.runtime.sendMessage.bind(chrome.runtime);
        let left = times;
        chrome.runtime.sendMessage = async (...a) => { if (left-- > 0) throw new Error('Could not establish connection. Receiving end does not exist.'); return window.realRuntimeSend(...a); };
      }, times);
      const undrop = () => panel.evaluate(() => { if (window.realRuntimeSend) chrome.runtime.sendMessage = window.realRuntimeSend; });
      const saveBytes = () => site.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory();
        const dir = await (await (await root.getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
        return [...new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer())].join(',');
      }, NAME);

      // A redraw after the game data loads can refill the money field: fill until it holds.
      const fillMoney = async (v) => { for (let i = 0; i < 5; i++) { await panel.fill('#money', v); await panel.waitForTimeout(600); if (await panel.inputValue('#money') === v) return; } throw new Error('the money field would not keep ' + v); };
      await panel.waitForFunction(() => document.querySelector('#cars .car-name'), null, { timeout: 15000 });
      // 4a. Two dropped messages, then the worker answers: the edit goes through.
      await fillMoney('43210');
      await dropWorker(2);
      const t4a = await clickAndWait('#setMoney');
      await undrop();
      check('a write goes through when the background worker misses its first two messages', /saved/.test(t4a), t4a);

      // 4b. The worker never answers: a clear message, nothing read or written, no history entry, and a restart is
      // scheduled. The restart itself is held off here (test/live-worker-heal.cjs proves it with a real stale worker).
      const h4b = await history(panel), b4b = await saveBytes();
      await fillMoney('43211');
      await panel.evaluate(() => { document.body.dataset.healDelayMs = String(1e9); });
      await dropWorker(99);
      const t4b = await clickAndWait('#setMoney');
      await undrop();
      const heal4b = await panel.evaluate(async () => (await chrome.storage.local.get('workerHeal')).workerHeal ?? null);
      check('a background worker that never answers gives a clear message, not Chrome\'s error, writes nothing and restarts the editor',
        /did not answer \(.+\), so nothing was read or written.*Updating the editor/.test(t4b) && !/Receiving end/.test(t4b) && heal4b?.shown === false
          && await history(panel) === h4b && await saveBytes() === b4b, t4b);
      await panel.evaluate(() => chrome.storage.local.remove('workerHeal'));

      // 4c. Best version of every car with a commit landing mid-run: no reload until it ends, then the update applies.
      await markSession(panel);
      const n4c = await edits();
      await panel.click('#bestGarage');
      await sleep(8000);
      const c3 = noopCommit();
      await sleep(ALARM_MS + 10000);
      const midRun = await panel.evaluate(async () => ({ marker: (await chrome.storage.session.get('testMarker')).testMarker, busy: document.getElementById('bestGarage').disabled })).catch((e) => ({ err: e.message }));
      check('no reload while Best version of every car runs, though a commit landed mid-run', midRun.marker === 1 && midRun.busy === true && !panel.isClosed(), JSON.stringify(midRun));
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n4c, { timeout: 900000 });
      const t4c = (await panel.textContent('#toastText')) || '';
      await panel.screenshot({ path: path.join(outDir, 'best-version-after-commit-1429.png') });
      check('Best version of every car finishes with the update waiting', /Best version of every car: (saved|already done)/.test(t4c), t4c.slice(0, 160));
      r = await waitReload(ALARM_MS + 15000);
      check('the update waiting on Best version applies once it ends', r.secs != null, r.secs != null ? `${r.secs.toFixed(0)}s` : 'no reload');

      // 4d. A click while a new version waits on disk starts no write: the update applies and the panel says so.
      let t4d = null;
      for (let tries = 0; tries < 2 && t4d == null; tries++) {
        panel = await openPanel();
        await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 20000 });
        await markSession(panel);
        const h4d = await history(panel);
        noopCommit();
        // Asked at once, before the 30 s alarm would see the commit (a rare alarm in between closes the panel: retried).
        const res = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'writeBegin', id: crypto.randomUUID() })).catch(() => null);
        if (res) t4d = { res, h4d };
        await waitReload(ALARM_MS + 15000);
      }
      check('a write asked for while a new version waits on disk is refused, and the update applies at once',
        t4d?.res?.ok === false && /updating to [0-9a-f]{7}.*nothing was written/.test(t4d.res.why), JSON.stringify(t4d?.res));
    }
  } catch (err) {
    check('live update run', false, String(err && err.stack || err));
  } finally {
    await ctx.close();
    console.log(`\n${pass}/${pass + fail} pass`);
    process.exitCode = fail ? 1 : 0;
  }
})();
