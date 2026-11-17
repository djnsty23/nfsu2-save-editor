// Live safety checks: what the panel does when a write or a computation goes wrong. Same throwaway headless Chrome
// profile and planted test profile as test/live.cjs; faults are planted inside the extension's own content script
// world, so the code under test runs unchanged.
// Usage: node test/live-safety.cjs <playwright module dir> <GLOBALB.BUN> <test profile folder> <out dir>
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const [pwDir, bunPath, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-safety.cjs <playwright dir> <GLOBALB.BUN> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
// NFSU2_EXT runs the suite against another copy, such as the store build in dist/store.
const EXT = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NAME = path.basename(profDir);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-safety-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));

    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    const files = { [NAME]: [...fs.readFileSync(path.join(profDir, NAME))], 'GARAGE.DAT': [...fs.readFileSync(path.join(profDir, 'GARAGE.DAT'))] };
    await site.evaluate(async ({ name, files }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true })).getDirectoryHandle(name, { create: true });
      for (const [n, bytes] of Object.entries(files)) { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); }
    }, { name: NAME, files });
    await site.reload({ waitUntil: 'load' });
    await site.waitForTimeout(2500);

    const readOpfs = async () => {
      const r = await site.evaluate(async (name) => {
        const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
        const get = async (n) => [...new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer())];
        return { career: await get(name), garage: await get('GARAGE.DAT') };
      }, NAME);
      return { career: new Uint8Array(r.career), garage: new Uint8Array(r.garage) };
    };
    const same = (a, b) => sha(a.career) === sha(b.career) && sha(a.garage) === sha(b.garage);

    const errors = [];
    const openPanel = async () => {
      const p = await ctx.newPage();
      await p.setViewportSize({ width: 400, height: 1000 });
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.goto(`chrome-extension://${extId}/panel/panel.html`);
      await p.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
      await p.selectOption('#profile', NAME);
      return p;
    };
    let panel = await openPanel();
    const histCount = () => panel.evaluate(async (k) => ((await chrome.storage.local.get(k))[k]?.entries ?? []).length, `hist:save/${NAME}`);
    const edits = () => panel.evaluate(() => Number(document.body.dataset.edits || 0));
    const clickAndWait = async (sel, timeout = 120000) => {
      const n = await edits();
      if (typeof sel === 'function') await sel(); else await panel.click(sel);
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout });
      return (await panel.textContent('#toastText')) || '';
    };
    // Plants a createWritable fault in the content script's world: 'second' fails the second file once,
    // 'stuck' fails every file from the second on (so the rollback fails too), 'clear' removes it.
    const fault = (mode) => panel.evaluate(async (mode) => {
      const [tab] = await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'ISOLATED', args: [mode],
        func: (mode) => {
          const P = FileSystemFileHandle.prototype;
          globalThis.__realCreateWritable ??= P.createWritable;
          const real = globalThis.__realCreateWritable;
          if (mode === 'clear') { P.createWritable = real; return; }
          let n = 0;
          P.createWritable = function (...a) {
            if (++n >= 2) {
              if (mode === 'second') P.createWritable = real;
              return Promise.reject(new DOMException('planted disk failure', 'InvalidStateError'));
            }
            return real.apply(this, a);
          };
        },
      });
    }, mode);
    let money = 1000;
    const setMoney = () => clickAndWait(async () => { await panel.fill('#money', String(++money)); await panel.click('#setMoney'); });

    // ---- F1: a write that fails after the career file was written ----
    {
      const pre = await readOpfs(), n0 = await histCount();
      await fault('second');
      const msg = await setMoney();
      check('F1 a failed garage write puts the career file back: both files as before', same(await readOpfs(), pre), msg.slice(0, 90));
      check('F1 the rolled-back write leaves no history entry and says nothing changed', (await histCount()) === n0 && /nothing changed/.test(msg));

      await fault('stuck');
      const msg2 = await setMoney();
      const mid = await readOpfs();
      await fault('clear');
      check('F1 plant check: the stuck fault really leaves half an edit', sha(mid.career) !== sha(pre.career) && sha(mid.garage) === sha(pre.garage));
      check('F1 when the rollback fails too, the history entry is kept and the panel points to Undo', (await histCount()) === n0 + 1 && /Undo/.test(msg2), msg2.slice(0, 90));
      if ((await histCount()) > n0) {
        const undoMsg = await clickAndWait('#history li:first-child button');
        check('F1 that kept entry undoes the half edit to the exact bytes', /saved/.test(undoMsg) && same(await readOpfs(), pre), undoMsg.slice(0, 60));
      } else {
        check('F1 that kept entry undoes the half edit to the exact bytes', false, 'no entry to undo: the half edit is permanent');
      }
    }

    // ---- F2: a tab switch while a long edit runs ----
    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
    const car0 = '#cars details:first-of-type';
    {
      await panel.click(`${car0} summary`);
      const pre = await readOpfs(), n = await edits();
      await panel.click(`${car0} button:has-text("Best car")`);
      await panel.waitForFunction(() => document.getElementById('maxMoney').disabled, null, { timeout: 5000 });
      // Activating another tab and then the game tab fires chrome.tabs.onActivated twice, as a user switching would.
      const other = await ctx.newPage();
      await other.bringToFront();
      await site.bringToFront();
      await panel.waitForTimeout(1500);
      const mid = await panel.evaluate(() => {
        const d = (id) => document.getElementById(id).disabled;
        return { edits: Number(document.body.dataset.edits || 0), write: d('maxMoney'), history: [...document.querySelectorAll('#history button')].every((b) => b.disabled), profile: d('profile'), refresh: d('refresh'), db: d('dbFromSite') && d('dbFile') };
      });
      check('F2 plant check: the edit is still running after the tab switch', mid.edits === n, JSON.stringify(mid));
      check('F2 a tab switch mid-edit leaves the write and Undo buttons disabled', mid.write && mid.history);
      check('F2 profile, Refresh and game data controls are locked while the write runs', mid.profile && mid.refresh && mid.db);
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 240000 });
      const msg = (await panel.textContent('#toastText')) || '';
      const after = await panel.evaluate(() => ['maxMoney', 'profile', 'refresh'].every((id) => !document.getElementById(id).disabled));
      check('F2 the edit still saves, and every control comes back when it ends', /saved/.test(msg) && !same(await readOpfs(), pre) && after, msg.slice(0, 80));
      await other.close();
    }

    // ---- F3: the computation worker crashes ----
    {
      // A fresh panel has no worker yet, so the stub below is the one it starts.
      await panel.close();
      panel = await openPanel();
      await panel.evaluate(() => {
        window.realWorker = Worker;
        window.terminated = 0;
        window.Worker = class extends EventTarget {
          postMessage() { setTimeout(() => this.dispatchEvent(new ErrorEvent('error', { message: 'planted crash' })), 50); }
          terminate() { window.terminated++; }
        };
      });
      await panel.click(`${car0} summary`);
      // The presets live on the car's Setups tab.
      await panel.click(`${car0} .ctabs button[data-tab="setups"]`);
      const pre = await readOpfs(), h0 = await histCount();
      let msg = null;
      try { msg = await clickAndWait(`${car0} button:has-text("Drag")`, 30000); } catch { /* stuck: checked below */ }
      const st = await panel.evaluate(() => ({ kind: document.getElementById('toast').dataset.kind, write: !document.getElementById('maxMoney').disabled, profile: !document.getElementById('profile').disabled, terminated: window.terminated }));
      check('F3 a crashed worker ends the edit with a clear message', msg != null && /computation stopped \(planted crash\)/.test(msg) && /Nothing was written/.test(msg) && st.kind === 'bad', (msg ?? 'still busy after 30 s').slice(0, 100));
      check('F3 the panel is not left busy: write buttons and profile are enabled', st.write && st.profile, JSON.stringify(st));
      check('F3 nothing was written and no history entry was added', same(await readOpfs(), pre) && (await histCount()) === h0);
      check('F3 the crashed worker is terminated', st.terminated === 1);
      await panel.evaluate(() => { window.Worker = window.realWorker; });
      const again = await clickAndWait(`${car0} button:has-text("Drag")`, 120000).catch(() => 'still busy');
      check('F3 the next computation starts a fresh worker and works', /saved|already done/.test(again), again.slice(0, 80));
    }

    // ---- F4: extension storage is full ----
    {
      const key = `hist:save/${NAME}`;
      // Fill chrome.storage.local to about one undo entry short of its real quota.
      const fill = await panel.evaluate(async () => {
        const used = await chrome.storage.local.getBytesInUse(null), quota = chrome.storage.local.QUOTA_BYTES;
        await chrome.storage.local.set({ filler: 'x'.repeat(quota - used - 150000) });
        return { used, quota, now: await chrome.storage.local.getBytesInUse(null) };
      });
      const origHash = await panel.evaluate(async (k) => (await chrome.storage.local.get(k))[k]?.original?.hash, key);
      const h0 = await histCount();
      const msgs = [];
      for (let i = 0; i < 3; i++) msgs.push(await setMoney());
      const after = await panel.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
      check('F4 with storage full, every edit still saves', msgs.every((m) => /saved/.test(m)), `${fill.now} of ${fill.quota} bytes used; ${msgs.map((m) => m.slice(0, 40)).join(' | ')}`);
      // The store build holds "unlimitedStorage": the 10 MB quota is not enforced, so nothing is ever dropped and
      // every edit keeps its entry. The dev build has the quota and must say when it drops old entries.
      const unlimited = await panel.evaluate(() => chrome.runtime.getManifest().permissions.includes('unlimitedStorage'));
      if (unlimited) check('F4 with unlimitedStorage (store build) no undo entry is dropped and nothing claims one was', after.entries.length === h0 + 3 && !msgs.some((m) => /dropped/.test(m)), `${h0} entries before, ${after.entries.length} after`);
      else check('F4 the panel says when old entries were dropped to make room', msgs.some((m) => /oldest undo entr(y was|ies were) dropped/.test(m)), msgs.find((m) => /dropped/.test(m))?.slice(0, 160) ?? 'never said');
      check("F4 the profile's original survives the pruning", !!origHash && after?.original?.hash === origHash);
      check('F4 history holds the newest entries and stays within the quota', after.entries.length >= 1 && after.entries.length <= h0 + 3 && /Money set to \$/.test(after.entries.at(-1).label), `${h0} entries before, ${after.entries.length} after`);
      await panel.evaluate(() => chrome.storage.local.remove('filler'));
    }

    check('F no errors in the panel console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    check('live safety run', false, String(err && err.stack || err).slice(0, 400));
  } finally {
    await ctx.close();
  }
  console.log(`\n${pass}/${pass + fail} pass`);
  process.exitCode = fail ? 1 : 0;
})();
