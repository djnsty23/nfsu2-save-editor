// Takes the four 1280x800 Chrome Web Store screenshots from the store build (dist/store, built first) in a throwaway
// headless Chrome profile on https://nfsu2.xyz, with a test career planted in the site's storage. The panel is shown
// in a tab at 1280x800, its two-column layout. The offline-only notice is confirmed up front.
// The music player frame is a plain stand-in that speaks Spotivibly's postMessage protocol with the EA Trax list from
// src/music.js, and the real Spotivibly and YouTube hosts are refused: a YouTube thumbnail is game or album art, which
// must not reach a public screenshot.
// Usage: node tools/store-screenshots.cjs <playwright module dir> <GLOBALB.BUN> <test profile folder> <out dir>
// Use a test career whose name and contents carry nothing personal: the screenshots are meant to be public.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const [pwDir, bunPath, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node tools/store-screenshots.cjs <playwright dir> <GLOBALB.BUN> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
const root = path.resolve(__dirname, '..');
const EXT = path.join(root, 'dist', 'store');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NAME = path.basename(profDir);
const W = 1280, H = 800;
const MUSIC_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(spotivibly\.com|youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com|ggpht\.com)\//;
/** A stand-in player: a dark video box with a plain caption, answering hello with the tracks. */
const stub = (tracks) => `<!doctype html><title>player stand-in</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#111;color:#bbb;font:14px system-ui">Video plays here, from YouTube<script>
const tracks = ${JSON.stringify(tracks)};
const say = (m) => parent.postMessage(m, '*');
addEventListener('message', (e) => {
  const c = e.data;
  if (!c || c.type !== 'spotivibly:command' || c.action !== 'hello') return;
  say({ type: 'spotivibly:ready', tracks });
  say({ type: 'spotivibly:state', version: 1, index: 0, total: tracks.length, status: 'idle', started: false, time: 0, duration: 0, failed: [], unavailable: false });
});
</script>`;

(async () => {
  execFileSync(process.execPath, [path.join(root, 'tools/build-store.cjs')], { stdio: 'ignore', windowsHide: true });
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-store-shots-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: W, height: H },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  const errors = [];
  const music = await import('file:///' + path.join(EXT, 'src/music.js').replace(/\\/g, '/'));
  await ctx.route(MUSIC_HOSTS, (r) => (r.request().url() === music.SPOTIVIBLY_EMBED
    ? r.fulfill({ status: 200, contentType: 'text/html', body: stub(music.EA_TRAX.map((s) => ({ name: s.title, artist: s.artist }))) })
    : r.abort('blockedbyclient')));
  try {
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));

    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    const files = fs.readdirSync(profDir).filter((f) => f === NAME || f === 'GARAGE.DAT');
    await site.evaluate(async ({ name, files }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true })).getDirectoryHandle(name, { create: true });
      for (const [n, bytes] of Object.entries(files)) { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); }
    }, { name: NAME, files: Object.fromEntries(files.map((f) => [f, [...fs.readFileSync(path.join(profDir, f))]])) });

    const panel = await ctx.newPage();
    panel.on('pageerror', (e) => errors.push(String(e)));
    await panel.emulateMedia({ reducedMotion: 'reduce' });
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.click('#retry', { timeout: 5000 }).catch(() => {});
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 20000 });
    await panel.selectOption('#profile', NAME);
    await panel.waitForFunction(() => document.querySelector('#cars .car-name'), null, { timeout: 15000 });
    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
    await panel.waitForSelector('#cars details[open]', { timeout: 15000 });
    await panel.waitForTimeout(500);
    const shot = async (name) => { await panel.waitForTimeout(400); await panel.screenshot({ path: path.join(outDir, name) }); console.log('wrote', name); };
    const hideToast = () => panel.evaluate(() => { document.getElementById('toast').hidden = true; });

    await hideToast();
    await panel.evaluate(() => scrollTo(0, 0));
    await shot('1-career.png');

    // A second car open on its Looks tab, the first one closed, so the shot differs from the first.
    const det2 = '#cars details.car:nth-of-type(2)';
    await panel.evaluate((sel) => { const d = document.querySelector(sel); if (!d.open) d.querySelector('summary').click(); }, det2);
    await panel.click(`${det2} .ctabs [data-tab="looks"]`, { timeout: 10000 });
    await panel.$eval(det2, (n) => n.scrollIntoView({ block: 'start' }));
    await panel.evaluate(() => scrollBy(0, -16));
    await shot('2-car.png');

    // A real edit, so History and the toast's Undo show. The test career may already hold the maximum money.
    const before = await panel.evaluate(() => Number(document.body.dataset.edits || 0));
    await panel.evaluate(() => scrollTo(0, 0));
    await panel.fill('#money', '250000');
    await panel.click('#setMoney');
    await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, before, { timeout: 60000 });
    await panel.waitForFunction(() => !document.getElementById('toastUndo').hidden, null, { timeout: 15000 });
    await panel.$eval('#historyCard', (n) => n.scrollIntoView({ block: 'center' }));
    await shot('3-history.png');

    await hideToast();
    await panel.waitForFunction(() => document.querySelectorAll('#musicList .song').length > 0, null, { timeout: 45000 });
    await panel.waitForFunction(() => document.getElementById('musicPlayerNote').textContent.startsWith('Player: Spotivibly'), null, { timeout: 20000 });
    await panel.$eval('#music', (n) => n.scrollIntoView({ block: 'start' }));
    await panel.waitForTimeout(1500);
    await shot('4-music.png');

    // The Ready-made garage's Replace warning: every car lost, the backup button and the unticked box. Opening it
    // writes nothing, and the shot is taken before anything is ticked.
    await panel.waitForFunction(() => !document.getElementById('garageReplace').disabled, null, { timeout: 15000 });
    await panel.click('#garageReplace');
    await panel.waitForFunction(() => !document.getElementById('garageConfirm').hidden, null, { timeout: 5000 });
    await panel.$eval('#garageConfirm', (n) => n.scrollIntoView({ block: 'center' }));
    await shot('5-garage.png');
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
  process.exitCode = errors.length ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
