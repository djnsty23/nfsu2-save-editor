// Live proof that an install still running an old copy heals itself from the panel (a real install, 2026-11-14:
// every Carbon switch said "The editor's background did not answer, so nothing was read or written."). An unpacked
// install keeps the manifest and worker it loaded until the extension reloads, while the panel is read fresh from
// disk. So the folder here starts at the first commit (975707e: no message listener, no scripting or host
// permission), the extension loads it, and then today's files land on disk with no reload, as a git pull or a
// commit in the folder does. Opening the panel must reload the extension once, and the reopened panel must connect
// and save a Carbon switch, with the same extension id and storage. A restart that did not help is not repeated
// within two minutes, and the self-update from build.json still works afterwards.
// Uses Edge (--load-extension): an extension loaded over the DevTools pipe is unloaded, not reloaded, by
// chrome.runtime.reload().
// Usage: node test/live-worker-heal.cjs <playwright module dir> <test profile folder, first car with carbon parts> <out dir> <GLOBALB.BUN>
// HEAL_GIT names the git checkout that holds commit 975707e (default: this one). HEAL_FROM=worker starts instead from
// today's files with a worker that registers no message listener: a current manifest and a mute worker, the panel
// that connects but whose every write is refused, as seen on that install.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const [pwDir, profDir, outDir, bunPath] = process.argv.slice(2);
if (!bunPath) { console.error('usage: node test/live-worker-heal.cjs <playwright dir> <profile folder> <out dir> <GLOBALB.BUN>'); process.exit(2); }
const { chromium } = require(pwDir);
const SRC = path.resolve(__dirname, '..');
const GIT = process.env.HEAL_GIT || SRC;
const OLD = '975707e';
const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const NAME = path.basename(profDir);
const FROM = process.env.HEAL_FROM === 'worker' ? 'worker' : 'commit';
const SHIP = ['manifest.json', 'background.js', 'content.js', 'panel', 'src', 'vendor', 'icons'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

fs.mkdirSync(outDir, { recursive: true });
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-heal-'));
// The first commit's files, straight from git; or today's files with a mute worker.
if (FROM === 'worker') {
  for (const p of SHIP) fs.cpSync(path.join(SRC, p), path.join(ext, p), { recursive: true });
  const bg = path.join(ext, 'background.js');
  fs.writeFileSync(bg, `chrome.runtime.onMessage.addListener = chrome.alarms.onAlarm.addListener = () => {}; // an old worker: no message channel, no update alarm
${fs.readFileSync(bg, 'utf8')}`);
} else for (const f of execFileSync('git', ['ls-tree', '-r', '--name-only', OLD, '--', ...SHIP], { cwd: GIT, encoding: 'utf8' }).trim().split('\n')) {
  fs.mkdirSync(path.dirname(path.join(ext, f)), { recursive: true });
  fs.writeFileSync(path.join(ext, f), execFileSync('git', ['show', `${OLD}:${f}`], { cwd: GIT, maxBuffer: 64 << 20 }));
}
const stampFile = path.join(ext, 'build.json');
const stamp = (c) => fs.writeFileSync(stampFile, JSON.stringify({ commit: c.repeat(40).slice(0, 40), short: c.repeat(7).slice(0, 7), at: new Date().toISOString() }, null, 2));

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-heal-browser-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: BROWSER, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // Storage written by the old copy: must still be there under the same id after the heal.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 }, healProbe: 'written by the old copy' }));

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
    const saveBytes = () => site.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
      return [...new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer())].join(',');
    }, NAME);

    // Today's files land on disk; the running copy stays the old one. build.json as the repo's hooks write it.
    for (const p of SHIP) fs.cpSync(path.join(SRC, p), path.join(ext, p), { recursive: true });
    stamp('a');
    const marker = (w) => w.evaluate(async () => (await chrome.storage.session.get('healMarker')).healMarker === 1).catch(() => null);
    const setMarker = async () => { for (const w of ctx.serviceWorkers().filter((x) => x.url().includes(extId))) await w.evaluate(() => chrome.storage.session.set({ healMarker: 1 })).catch(() => {}); };
    // The extension reloaded when the session marker is gone (session storage does not survive a reload).
    const waitReload = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await sleep(500);
        for (const w of ctx.serviceWorkers().filter((x) => x.url().includes(extId))) if (await marker(w) === false) return (Date.now() - t0) / 1000;
      }
      return null;
    };
    await setMarker();
    const running = await sw.evaluate(() => chrome.runtime.getManifest().permissions.join(',')).catch((e) => e.message);
    if (FROM === 'commit') check('the running copy is still the first commit after the files changed on disk', running === 'storage,sidePanel', running);

    const det = '#cars details:first-of-type';
    const panelPage = async () => {
      const p = await ctx.newPage();
      await p.setViewportSize({ width: 420, height: 1000 });
      await p.goto(`chrome-extension://${extId}/panel/panel.html`);
      return p;
    };
    const toastText = async (p) => ((await p.textContent('#toastText').catch(() => '')) || '');

    // 1. The user opens the side panel: today's panel finds the old copy running and reloads the extension once.
    let panel = await panelPage();
    await panel.waitForFunction(() => /Connected|Read only|Not connected|Updating/.test(document.getElementById('conn').textContent), null, { timeout: 30000 }).catch(() => {});
    const t1 = await toastText(panel), conn1 = await panel.textContent('#conn').catch(() => '');
    const secs = await waitReload(15000);
    check('opening the panel on the old copy says it is updating the editor', /Updating the editor/.test(t1), `${t1.slice(0, 140)} | ${conn1}`);
    check('the extension reloads itself, with no click and no chrome://extensions', secs != null, secs != null ? `${secs.toFixed(1)}s` : 'no reload in 15 s');
    const nowPerms = await (async () => { for (const w of ctx.serviceWorkers().filter((x) => x.url().includes(extId))) { const r = await w.evaluate(() => chrome.runtime.getManifest().permissions.join(',')).catch(() => null); if (r) return r; } return null; })();
    check('after the reload the running copy has today\'s permissions', /scripting/.test(nowPerms || ''), nowPerms || 'no worker');

    // 2. The panel opened again: connected, says what happened once, and the Miata's Carbon switch saves.
    if (!panel.isClosed()) await panel.close().catch(() => {});
    panel = await panelPage();
    await panel.waitForFunction(() => /Connected|Read only|Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 30000 });
    const note = await toastText(panel);
    check('the reopened panel says the editor reloaded itself to its current version', /reloaded itself to its current version/.test(note), note.slice(0, 160));
    check('the reopened panel connects to the site tab', /safe to edit/.test(await panel.textContent('#conn')), await panel.textContent('#conn'));
    const probe = await panel.evaluate(async () => [chrome.runtime.id, (await chrome.storage.local.get('healProbe')).healProbe]);
    check('same extension id and the old copy\'s storage kept', probe[0] === extId && probe[1] === 'written by the old copy', JSON.stringify(probe));
    await panel.selectOption('#profile', NAME).catch(() => {});
    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 60000 });
    await panel.waitForSelector(det, { timeout: 30000 });
    await panel.evaluate((det) => { const d = document.querySelector(det); if (!d.open) d.querySelector('summary').click(); }, det);
    await panel.click(`${det} .ctabs button[data-tab="carbon"]`);
    const carbonGroup = () => panel.$$eval(`${det} .seg`, (s) => s.map((x) => [x.getAttribute('aria-label'), x.querySelector('button[aria-pressed="true"]')?.textContent])
      .filter((x) => x[1] === 'Carbon').map((x) => x[0])[0] ?? null);
    const pressPlain = async (group) => {
      const n0 = await panel.evaluate(() => Number(document.body.dataset.edits || 0));
      await panel.click(`${det} .seg[aria-label="${group}"] button:text-is("Plain")`);
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n0, { timeout: 30000 });
      return toastText(panel);
    };
    const car = await panel.textContent(`${det} .car-name`);
    const g2 = await carbonGroup(), b2 = await saveBytes();
    const t2 = g2 ? await pressPlain(g2) : 'no carbon part on the first car';
    check(`${car}: ${g2} Plain saves after the self-heal`, /saved/.test(t2) && await saveBytes() !== b2 && (await carbonGroup()) !== g2, t2.slice(0, 120));
    await panel.screenshot({ path: path.join(outDir, 'heal-after-restart.png'), fullPage: true });

    // 3. If the worker still does not answer within two minutes of that restart, no second restart: the manual steps.
    await setMarker();
    await panel.evaluate(() => {
      const real = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (msg, ...a) => { if (msg?.type === 'writeBegin') throw new Error('Could not establish connection. Receiving end does not exist.'); return real(msg, ...a); };
    });
    const g3 = await carbonGroup(), b3 = await saveBytes();
    const t3 = g3 ? await pressPlain(g3) : '';
    const again = await waitReload(8000);
    check('a second failure within two minutes gives the chrome://extensions steps and does not restart again',
      /out of date and restarting it did not help.*chrome:\/\/extensions/.test(t3) && again == null && await saveBytes() === b3 && !panel.isClosed(), t3.slice(0, 160));
    await panel.close();

    // 4. The healed copy keeps updating itself from build.json, and a current copy opens without a restart.
    await setMarker();
    stamp('b');
    const upd = await waitReload(75000);
    check('the healed copy still reloads itself when build.json changes', upd != null, upd != null ? `${upd.toFixed(0)}s` : 'no reload in 75 s');
    await setMarker();
    panel = await panelPage();
    await panel.waitForFunction(() => /Connected|Read only|Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 30000 });
    const t4 = await toastText(panel);
    const extra = await waitReload(6000);
    check('a current copy opens the panel with no restart', extra == null && !/Updating the editor/.test(t4) && /Updated to bbbbbbb/.test(t4), t4.slice(0, 160) || 'no toast');
  } catch (err) {
    check('live worker heal run', false, String(err && err.stack || err));
  } finally {
    await ctx.close();
    console.log(`\n${pass}/${pass + fail} pass`);
    process.exitCode = fail ? 1 : 0;
  }
})();
