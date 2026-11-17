// Live proof of the Ready-made garage card through the real panel and worker, headless: the card says what to do
// without game data, one car applies to the slot picked and nothing else, and Replace my whole garage writes nothing
// until its box is ticked (a click on the greyed button is the plant), then saves exactly the offline result.
// Usage: node test/live-garage.cjs <playwright module dir> <GLOBALB.BUN> <profile folder> <out dir>
const fs = require('fs'), path = require('path'), os = require('os');
const { pathToFileURL } = require('url');
const [pwDir, bunPath, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-garage.cjs <playwright dir> <GLOBALB.BUN> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
const SRC = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const NAME = path.basename(profDir);
const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const eq = (a, b) => (a == null && b == null) || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const ops = await import(pathToFileURL(path.join(SRC, 'src/ops.js')).href);
  const garage = (await import(pathToFileURL(path.join(SRC, 'src/garage-data.js')).href)).default;
  const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(fs.readFileSync(bunPath))))));
  const files = {};
  for (const f of fs.readdirSync(profDir)) if (fs.statSync(path.join(profDir, f)).isFile()) files[f] = fs.readFileSync(path.join(profDir, f));
  const state = { career: new Uint8Array(files[NAME]), garage: files['GARAGE.DAT'] ? new Uint8Array(files['GARAGE.DAT']) : null };
  const cars = ops.summary(state, db).cars;

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-garage-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: BROWSER, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    const cdp = await ctx.browser().newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: SRC });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    await site.evaluate(async ({ name, files }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true })).getDirectoryHandle(name, { create: true });
      for (const [n, bytes] of Object.entries(files)) { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); }
    }, { name: NAME, files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, [...b]])) });
    await site.reload({ waitUntil: 'load' });
    await site.waitForTimeout(2500);
    const saved = () => site.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
      const out = {};
      for await (const [n, h] of dir.entries()) if (h.kind === 'file') out[n] = [...new Uint8Array(await (await h.getFile()).arrayBuffer())];
      return out;
    }, NAME);
    const edits = () => panel.evaluate(() => Number(document.body.dataset.edits || 0));

    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 420, height: 1000 });
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.waitForFunction(() => /Connected|Read only|Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    await panel.selectOption('#profile', NAME);
    await panel.waitForFunction(() => document.querySelectorAll('#garageList li').length > 0, null, { timeout: 15000 });

    // No game data yet: the card says so and nothing in it can be pressed.
    const noDb = await panel.evaluate(() => ({
      note: document.getElementById('garageNote').textContent,
      live: [...document.querySelectorAll('#garageList button, #garageList select, #garageReplace')].filter((b) => !b.disabled).length,
      rows: document.querySelectorAll('#garageList li').length,
    }));
    check('without game data the card lists every ready-made car and says to load the game data', noDb.rows === garage.cars.length && /Load the game data/.test(noDb.note), noDb.note);
    check('without game data no Apply, slot pick or Replace can be pressed', noDb.live === 0, `${noDb.live} enabled`);

    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
    await panel.waitForFunction(() => ![...document.querySelectorAll('#garageList button')].some((b) => b.disabled), null, { timeout: 15000 });

    // One car into a slot holding another model, chosen in the slot list.
    const i = garage.cars.findIndex((d) => ops.designCarHash(d, db) !== ops.carHashInSlot(state, cars[0].index));
    const slot = cars[0].index;
    const offline = ops.applyDesign(state, slot, garage.cars[i], db).state;
    const row = panel.locator('#garageList li').nth(i);
    await row.locator('select').selectOption(String(slot));
    let n = await edits();
    await row.locator('button').click();
    await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 60000 });
    const t1 = await panel.textContent('#toastText');
    check('Apply saves one car and names the car it replaced, in one clean sentence', /saved/.test(t1) && !/ {2}/.test(t1) && t1.includes(`replaced the ${cars[0].name}`), t1.slice(0, 200));
    let disk = await saved();
    check('the saved files are exactly the offline one-car result: only that slot changed', eq(disk[NAME], [...offline.career]) && eq(disk['GARAGE.DAT'] ?? null, offline.garage ? [...offline.garage] : null));

    // Replace my whole garage: the warning names each slot, and the greyed button writes nothing.
    await panel.click('#garageReplace');
    const confirm = await panel.evaluate(() => ({
      shown: !document.getElementById('garageConfirm').hidden,
      rows: document.querySelectorAll('#garageDiff li').length,
      text: document.getElementById('garageConfirmText').textContent,
      yesDisabled: document.getElementById('garageReplaceYes').disabled,
      backup: !!document.getElementById('garageBackup') && !document.getElementById('garageBackup').disabled,
    }));
    const expectRows = Math.min(cars.length, garage.cars.length);
    check('the warning lists every slot it overwrites and what is lost', confirm.shown && confirm.rows === expectRows && /replaces all \d+ cars/.test(confirm.text), `${confirm.rows} rows: ${confirm.text.slice(0, 160)}`);
    check('the warning offers a backup first', confirm.backup);
    check('Replace is greyed until the box is ticked', confirm.yesDisabled);
    n = await edits();
    await panel.evaluate(() => document.getElementById('garageReplaceYes').click());
    await panel.waitForTimeout(1500);
    disk = await saved();
    check('plant: pressing the greyed Replace writes nothing', (await edits()) === n && eq(disk[NAME], [...offline.career]));

    const whole = ops.replaceGarage(offline, garage, db, { confirmed: true }).state;
    await panel.check('#garageAgree');
    check('ticking the box enables Replace', !(await panel.locator('#garageReplaceYes').isDisabled()));
    await panel.click('#garageReplaceYes');
    await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 60000 });
    const t2 = await panel.textContent('#toastText');
    disk = await saved();
    check('Replace saves the whole ready-made garage exactly as computed offline', /saved/.test(t2) && eq(disk[NAME], [...whole.career]) && eq(disk['GARAGE.DAT'] ?? null, whole.garage ? [...whole.garage] : null), t2.slice(0, 200));
    check('after Replace the warning is closed and its box unticked', await panel.evaluate(() => document.getElementById('garageConfirm').hidden && !document.getElementById('garageAgree').checked));
    await panel.locator('#garageCard').screenshot({ path: path.join(outDir, 'garage-card.png') });
  } catch (err) {
    check('live garage run', false, String(err && err.stack || err));
  } finally {
    await ctx.close();
    console.log(`\n${pass}/${pass + fail} pass`);
    process.exitCode = fail ? 1 : 0;
  }
})();
