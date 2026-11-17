// Live proof that a car Best car has just finished reads Best in its row (reported 2026-11-16: cars still read Maxed
// after Best car). Best car leaves a carbon group plain when carbon there would remove a vinyl layer
// (the 240SX's lost vinyl, 2026-11-13), and the row badge used to demand carbon on every group, so a car with
// vinyls on its body kit read "Maxed" with 5/5 setups straight after Best car.
// The career must hold an untuned car whose Best car keeps a group plain for its vinyls: the test finds the first
// one offline, presses Best car on it through the real panel and worker, and checks the badge, the setups count,
// the toast and the saved bytes against the offline result. It also checks that Carbon off is greyed on exactly the
// cars with no carbon part fitted.
// Usage: node test/live-best-badge.cjs <playwright module dir> <GLOBALB.BUN> <profile folder> <out dir>
const fs = require('fs'), path = require('path'), os = require('os');
const { pathToFileURL } = require('url');
const [pwDir, bunPath, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-best-badge.cjs <playwright dir> <GLOBALB.BUN> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
// NFSU2_EXT runs the panel from another copy, such as the store build in dist/store.
const SRC = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const NAME = path.basename(profDir);
const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const eq = (a, b) => (a == null && b == null) || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const ops = await import(pathToFileURL(path.join(SRC, 'src/ops.js')).href);
  const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(fs.readFileSync(bunPath))))));
  const files = {};
  for (const f of fs.readdirSync(profDir)) if (fs.statSync(path.join(profDir, f)).isFile()) files[f] = fs.readFileSync(path.join(profDir, f));
  const state = { career: new Uint8Array(files[NAME]), garage: files['GARAGE.DAT'] ? new Uint8Array(files['GARAGE.DAT']) : null };
  const s0 = ops.summary(state, db);
  // The first untuned car whose Best car keeps a group plain for its vinyls and ends maxed.
  let target = null;
  for (const c of s0.cars.filter((x) => !x.tuned.some(Boolean))) {
    const r = ops.bestCar(state, c.index, db);
    const after = ops.summary(r.state, db).cars.find((x) => x.index === c.index);
    if (r.report.carbonKept.length && after.maxed) { target = { car: c, want: r.state, report: r.report }; break; }
  }
  check('the career holds an untuned car whose Best car keeps a group plain for its vinyls', !!target,
    target ? `${target.car.name}: kept plain ${target.report.carbonKept.join(', ')}` : s0.cars.map((c) => c.name).join(', '));
  if (!target) { console.log(`\n${pass}/${pass + fail} pass`); process.exitCode = 1; return; }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-bestbadge-'));
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

    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 420, height: 1000 });
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.waitForFunction(() => /Connected|Read only|Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    await panel.selectOption('#profile', NAME);
    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
    await panel.waitForSelector('#cars details', { timeout: 30000 });
    // Every car row: its name, its badges, and whether Carbon off is greyed (the row is opened to read the button).
    const rows = () => panel.$$eval('#cars details', (ds) => ds.filter((d) => d.querySelector(':scope > summary .car-name')).map((d) => {
      if (!d.open) d.querySelector('summary').click();
      const off = [...d.querySelectorAll('.car-top button')].find((b) => /Carbon off/.test(b.textContent));
      return { name: d.querySelector(':scope > summary .car-name').textContent, pills: [...d.querySelectorAll(':scope > summary .car-meta .pill')].map((p) => p.textContent), offGreyed: !off || off.disabled || off.dataset.locked != null };
    }));
    const before = await rows();
    const greyWrong = before.filter((r) => {
      const c = s0.cars.find((x) => x.name === r.name);
      return r.offGreyed !== !c.carbon?.includes('carbon');
    });
    check('Carbon off is greyed on exactly the cars with no carbon part fitted', before.length === s0.cars.length && greyWrong.length === 0,
      greyWrong.length ? greyWrong.map((r) => r.name).join(', ') : `${before.filter((r) => r.offGreyed).length} of ${before.length} greyed`);

    const n = await panel.evaluate(() => Number(document.body.dataset.edits || 0));
    await panel.$$eval('#cars details', (ds, name) => { ds.find((d) => d.querySelector(':scope > summary .car-name')?.textContent === name).dataset.probe = '1'; }, target.car.name);
    await panel.click('#cars details[data-probe] .car-top button:has-text("Best car")');
    await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 240000 });
    const toast = await panel.textContent('#toastText');
    check('Best car saves and names the group it kept plain for the vinyls', /best car: saved/.test(toast) && toast.toLowerCase().includes(`except ${target.report.carbonKept.join(', ').toLowerCase()}`), toast.slice(0, 220));
    const row = (await rows()).find((r) => r.name === target.car.name);
    check(`${target.car.name} reads Best in its row after Best car`, row?.pills[0] === 'Best', row?.pills.join(' | '));
    check(`${target.car.name} reads 5/5 setups after Best car`, row?.pills.includes('5/5 setups'), row?.pills.join(' | '));
    const saved = await site.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
      const out = {};
      for await (const [n, h] of dir.entries()) if (h.kind === 'file') out[n] = [...new Uint8Array(await (await h.getFile()).arrayBuffer())];
      return out;
    }, NAME);
    check('the saved career and GARAGE.DAT are exactly the offline Best car result', eq(saved[NAME], [...target.want.career]) && eq(saved['GARAGE.DAT'] ?? null, target.want.garage ? [...target.want.garage] : null));
    await panel.screenshot({ path: path.join(outDir, 'best-badge.png') });
  } catch (err) {
    check('live best badge run', false, String(err && err.stack || err));
  } finally {
    await ctx.close();
    console.log(`\n${pass}/${pass + fail} pass`);
    process.exitCode = fail ? 1 : 0;
  }
})();
