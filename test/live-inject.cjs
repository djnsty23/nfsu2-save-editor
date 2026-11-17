// Live check that the panel reaches an nfsu2.xyz tab that has no content script from this copy of the extension.
// A: the extension is installed while the site tab is already open (Chrome injects manifest content scripts only
//    into pages loaded after the install). B: the tab's copy stops answering after the panel connected.
// Both must end in a saved write with no tab reload. Same throwaway headless Chrome profile and planted test
// profile as test/live-safety.cjs.
// Usage: node test/live-inject.cjs <playwright module dir> <test profile folder> <out dir> [extension dir]
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const [pwDir, profDir, outDir, extArg] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-inject.cjs <playwright dir> <profile folder> <out dir> [extension dir]'); process.exit(2); }
const { chromium } = require(pwDir);
const EXT = path.resolve(extArg || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NAME = path.basename(profDir);
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-inject-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    // The site tab first, with the profile planted, before the extension exists.
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
    // Lives in the page until the tab reloads or navigates: proves no step below reloaded the game.
    await site.evaluate(() => { window.__notReloaded = 'yes'; });
    const notReloaded = () => site.evaluate(() => window.__notReloaded === 'yes').catch(() => false);

    const readOpfs = () => site.evaluate(async (name) => {
      const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
      const get = async (n) => [...new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer())];
      return { career: await get(name), garage: await get('GARAGE.DAT') };
    }, NAME);
    const same = (a, b) => sha(a.career) === sha(b.career) && sha(a.garage) === sha(b.garage);

    // ---- A: install while the site tab is open ----
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    // The site has a service worker of its own, already running: wait for the extension's.
    const isExt = (w) => w.url().startsWith('chrome-extension://');
    let sw = ctx.serviceWorkers().find(isExt);
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { predicate: isExt, timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    await site.waitForTimeout(1500);
    // Asked from an extension page that runs none of the panel's code, so only the install itself can have injected.
    const probe = await ctx.newPage();
    await probe.goto(`chrome-extension://${extId}/icons/icon16.png`);
    const workerPing = await probe.evaluate(async () => {
      if (!globalThis.chrome?.tabs) return 'no extension APIs on the probe page';
      const [tab] = await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' });
      return chrome.tabs.sendMessage(tab.id, { type: 'ping' }).then((r) => r?.ok === true, (e) => String(e?.message || e));
    });
    await probe.close();
    check('A the install puts the content script into the open site tab', workerPing === true, String(workerPing));

    const errors = [];
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 400, height: 1000 });
    panel.on('pageerror', (e) => errors.push(String(e)));
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    const connected = await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 }).then(() => true, () => false);
    check('A the panel connects to the tab without a reload', connected, await panel.textContent('#conn'));
    if (!connected) throw new Error('panel never connected');
    await panel.selectOption('#profile', NAME);
    await panel.waitForTimeout(800);

    const edits = () => panel.evaluate(() => Number(document.body.dataset.edits || 0));
    const histCount = () => panel.evaluate(async (k) => ((await chrome.storage.local.get(k))[k]?.entries ?? []).length, `hist:save/${NAME}`);
    let money = 4321;
    const setMoney = async () => {
      const n = await edits();
      await panel.fill('#money', String(++money));
      await panel.click('#setMoney');
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 30000 });
      return (await panel.textContent('#toastText')) || '';
    };
    {
      const pre = await readOpfs();
      const msg = await setMoney().catch((e) => `no result: ${e.message}`);
      check('A a write right after the install saves', /saved/.test(msg) && !same(await readOpfs(), pre), msg.slice(0, 90));
      check('A the site tab was never reloaded', await notReloaded());
    }

    // ---- B: the tab's copy stops answering after the panel connected ----
    // Makes the running copy ignore every message, as a copy cut off from the extension does.
    const silence = () => panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => { globalThis.__nfsu2EditorOwner = Symbol('stale'); } });
      return chrome.tabs.sendMessage(tab.id, { type: 'ping' }).then((r) => `answered ${JSON.stringify(r)}`, (e) => String(e?.message || e));
    });
    {
      const raw = await silence();
      check('B plant check: the silenced tab no longer answers', !/^answered \{"ok":true\}/.test(raw), raw.slice(0, 90));
      const pre = await readOpfs();
      const msg = await setMoney().catch((e) => `no result: ${e.message}`);
      check('B a write to a tab that stopped answering injects, retries once and saves', /saved/.test(msg) && !same(await readOpfs(), pre), msg.slice(0, 90));
      check('B the header still reads connected and safe to edit', /safe to edit/.test(await panel.textContent('#conn')), await panel.textContent('#conn'));
      check('B the site tab was never reloaded', await notReloaded());
    }

    // ---- C: a tab nothing can be injected into: the panel says so and blocks writes ----
    {
      await silence();
      await panel.evaluate(() => {
        // Injection refused, as on a tab Chrome will not script; the content script stays silent.
        window.__realInject = chrome.scripting.executeScript;
        chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page.'); };
      });
      const h0 = await histCount();
      const pre = await readOpfs();
      const n = await edits();
      await panel.fill('#money', String(++money));
      await panel.click('#setMoney');
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 30000 }).catch(() => {});
      const st = await panel.evaluate(() => ({
        toast: document.getElementById('toastText').textContent,
        conn: document.getElementById('conn').textContent,
        state: document.getElementById('conn').dataset.state,
        write: document.getElementById('setMoney').disabled,
      }));
      check('C the toast says to reload the nfsu2.xyz tab and that nothing was written', /Reload that tab/.test(st.toast) && /Nothing was written/.test(st.toast), st.toast.slice(0, 120));
      check('C the header stops saying Connected and asks for a reload', /Reload the nfsu2\.xyz tab/.test(st.conn) && !/Connected/.test(st.conn) && st.state === 'bad', st.conn);
      check('C write buttons are blocked until Refresh', st.write);
      check('C nothing was written and no history entry was added', same(await readOpfs(), pre) && (await histCount()) === h0);
    }

    // ---- D: the read reaches the tab, the write does not: the undo entry recorded for it is dropped ----
    {
      await panel.evaluate(() => { chrome.scripting.executeScript = window.__realInject; });
      await panel.click('#refresh');
      const back = await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 }).then(() => true, () => false);
      check('D Refresh reconnects once the tab answers again', back, await panel.textContent('#conn'));
      await panel.selectOption('#profile', NAME);
      await panel.waitForTimeout(800);
      await panel.evaluate(() => {
        const real = chrome.tabs.sendMessage.bind(chrome.tabs);
        chrome.tabs.sendMessage = (id, msg) => (msg?.type === 'write'
          ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
          : real(id, msg));
        chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page.'); };
      });
      const h0 = await histCount();
      const pre = await readOpfs();
      const msg = await setMoney().catch((e) => `no result: ${e.message}`);
      check('D the write that never arrived says to reload, not to Undo', /Reload that tab/.test(msg) && !/Undo/.test(msg), msg.slice(0, 120));
      check('D nothing was written and its undo entry was dropped', same(await readOpfs(), pre) && (await histCount()) === h0);
    }

    check('no errors in the panel console', errors.length === 0, errors.slice(0, 3).join(' | '));
    await panel.screenshot({ path: path.join(outDir, 'panel-lost-tab.png'), fullPage: true });
  } catch (err) {
    check('live inject run', false, String(err && err.stack || err).slice(0, 400));
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  console.log(`\n${pass}/${pass + fail} pass`);
  process.exitCode = fail ? 1 : 0;
})();
