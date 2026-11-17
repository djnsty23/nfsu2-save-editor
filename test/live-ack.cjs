// Live check of the first-run offline-only notice and the reminder beside each write group, in a throwaway headless
// Chrome profile on https://nfsu2.xyz with a planted test profile. Screenshots at 400 and 1400 px go to <out dir>.
// The notice is NOT confirmed up front here, unlike every other live suite.
// Usage: node test/live-ack.cjs <playwright module dir> <test profile folder> <out dir>
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const [pwDir, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-ack.cjs <playwright dir> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
const EXT = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NAME = path.basename(profDir);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-ack-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  const errors = [];
  try {
    // No video is fetched: the player frame gets an empty page.
    await ctx.route('https://spotivibly.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }));
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const local = (k) => sw.evaluate((key) => chrome.storage.local.get(key).then((r) => r[key] ?? null), k);

    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    const initial = { career: [...fs.readFileSync(path.join(profDir, NAME))], garage: fs.existsSync(path.join(profDir, 'GARAGE.DAT')) ? [...fs.readFileSync(path.join(profDir, 'GARAGE.DAT'))] : null };
    await site.evaluate(async ({ name, career, garage }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true })).getDirectoryHandle(name, { create: true });
      const put = async (n, bytes) => { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); };
      await put(name, career);
      if (garage) await put('GARAGE.DAT', garage);
    }, { name: NAME, ...initial });
    const opfsSha = async () => sha(Buffer.from(await site.evaluate(async (name) => {
      const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
      return [...new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer())];
    }, NAME)));
    const shaInitial = sha(Buffer.from(initial.career));

    const panel = await ctx.newPage();
    panel.on('pageerror', (e) => errors.push(String(e)));
    await panel.setViewportSize({ width: 400, height: 900 });
    await panel.emulateMedia({ reducedMotion: 'reduce' });
    const open = async () => {
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
      await panel.click('#retry', { timeout: 3000 }).catch(() => {});
      await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 20000 });
      await panel.waitForFunction(() => document.querySelector('#cars .car-name'), null, { timeout: 15000 });
    };
    const shots = async (name, prep) => {
      for (const width of [400, 1400]) {
        await panel.setViewportSize({ width, height: width === 400 ? 900 : 1000 });
        await panel.waitForTimeout(200);
        if (prep) await prep();
        await panel.screenshot({ path: path.join(outDir, `${name}-${width}.png`) });
        check(`${name}: no sideways scroll at ${width} px`, await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await panel.setViewportSize({ width: 400, height: 900 });
    };
    const modal = () => panel.evaluate(() => { const d = document.getElementById('ack'); return d.open && d.matches(':modal'); });
    const writeIds = ['setMoney', 'maxMoney', 'setStage', 'bestGarage', 'maxPerf', 'uniques', 'restoreOriginal'];
    const allDisabled = () => panel.evaluate((ids) => ids.every((id) => document.getElementById(id).disabled)
      && [...document.querySelectorAll('#cars [data-write]')].every((b) => b.disabled), writeIds);
    const edits = () => panel.evaluate(() => Number(document.body.dataset.edits || 0));

    // ---- First run: the notice is a modal, every write is off, and nothing can be written.
    await open();
    check('A1 on first run the notice opens as a modal', await modal());
    const text = (await panel.textContent('#ack')).replace(/\s+/g, ' ');
    check('A2 it says offline only, that online use is cheating and can be flagged or banned',
      /offline play only/i.test(text) && /cheating/.test(text) && /flag or ban/.test(text) && /races, leaderboards/.test(text), text.slice(0, 160));
    check('A3 it says not affiliated with EA or nfsu2.xyz, no warranty, keep backups',
      /not made by, endorsed by or connected to EA or nfsu2\.xyz/.test(text) && /no warranty/.test(text) && /backups/.test(text));
    check('A4 every write button is disabled until it is confirmed', await allDisabled());
    await panel.keyboard.press('Escape');
    await panel.waitForTimeout(200);
    check('A5 Escape does not dismiss it', await modal());
    // Forcing a write button past its disabled state still writes nothing: edit() itself refuses.
    const before = await edits();
    await panel.evaluate(() => { const b = document.getElementById('maxMoney'); b.disabled = false; document.getElementById('ack').close(); b.click(); });
    await panel.waitForTimeout(1500);
    check('A6 a forced write is refused and the notice comes back', await modal() && await edits() === before && await opfsSha() === shaInitial);
    check('A7 nothing was confirmed or recorded', await local('offlineAck') === null && (await local(`hist:save/${NAME}`)) === null);
    await shots('ack-first-run');

    // ---- Confirm: stored, closed, writes back on.
    await panel.click('#ackYes');
    await panel.waitForFunction(() => !document.getElementById('ack').open, null, { timeout: 5000 });
    const ack = await local('offlineAck');
    check('A8 confirming stores offlineAck version 1 in chrome.storage.local', ack?.version === 1 && Number.isFinite(ack?.at), JSON.stringify(ack));
    check('A9 the write buttons come back', await panel.evaluate(() => !document.getElementById('setMoney').disabled && !document.getElementById('maxMoney').disabled));
    await panel.fill('#money', '123456');
    const b2 = await edits();
    await panel.click('#setMoney');
    await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, b2, { timeout: 60000 });
    check('A10 an edit writes after confirming', await opfsSha() !== shaInitial);
    const h1 = await local(`hist:save/${NAME}`);
    check('A11 the edit is in the undo history', h1?.entries?.length === 1, String(h1?.entries?.length));

    // ---- Reminder beside every write group.
    const where = await panel.evaluate(() => ['.oneclick', '#urlWinsBox', '#historyCard', '#backupCard', '#dangerCard', '#carsCard']
      .map((s) => [s, document.querySelectorAll(`${s} .offline-line`).length]));
    check('A12 one reminder line beside each write group (career, carbon wins, history, backup, unlock, cars)', where.every(([, n]) => n === 1) && await panel.$$eval('.offline-line', (n) => n.length) === 6, JSON.stringify(where));
    const line = (await panel.textContent('.oneclick .offline-line')).trim();
    check('A13 the reminder says offline only and the ban risk', /^Offline play only\./.test(line) && /banned on nfsu2\.xyz/.test(line), line);
    await panel.evaluate(() => { document.getElementById('toast').hidden = true; });
    await shots('ack-reminder', () => panel.$eval('.oneclick .offline-line', (n) => n.scrollIntoView({ block: 'center' })));

    // ---- Reopen: no notice again.
    await open();
    check('A14 once confirmed, the notice does not come back', !(await modal()));

    // ---- An install that had history before the notice existed: the notice shows, the history still loads and undoes.
    await sw.evaluate(() => chrome.storage.local.remove('offlineAck'));
    await open();
    check('A15 with no confirmation stored, the notice shows again', await modal());
    check('A16 the old history is listed behind it', await panel.$$eval('#history li', (l) => l.length) === 1);
    await panel.click('#ackYes');
    await panel.waitForFunction(() => !document.getElementById('ack').open, null, { timeout: 5000 });
    check('A17 after confirming, the history entry is still there', (await local(`hist:save/${NAME}`))?.entries?.length === 1 && await panel.$$eval('#history li', (l) => l.length) === 1);
    const b3 = await edits();
    await panel.click('#history li button');
    await panel.click('#undoConfirmYes', { timeout: 2000 }).catch(() => {});
    await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, b3, { timeout: 60000 });
    check('A18 Undo on that old entry puts the save back byte for byte', await opfsSha() === shaInitial);

    // ---- README carries the same notice.
    const readme = fs.existsSync(path.join(EXT, 'README.md')) ? fs.readFileSync(path.join(EXT, 'README.md'), 'utf8') : null;
    if (readme === null) console.log('SKIP  A19 README check: this copy ships no README');
    else check('A19 the README has the offline-only notice', /offline play only/i.test(readme) && /cheating/.test(readme) && /no warranty/i.test(readme));
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
