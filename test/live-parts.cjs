// Live proof of per-part installs (layout A, 2026-11-16): the Parts button on each Performance category opens its
// parts by level, a tick waits in the Apply bar with its dyno effect, and Apply writes exactly what
// ops.setCarParts writes offline. One car is first set to Level 1 everywhere on the copy, so every category has a
// Level 2 part to fit. Categories 1 to 5 are fitted at 400px wide, 6 to 9 at 1400px, and after each Apply the saved
// career and GARAGE.DAT are read back from the site's storage and compared byte for byte. It also checks Discard
// writes nothing and puts the ticks back, and that no width scrolls sideways with a parts list open.
// Usage: node test/live-parts.cjs <playwright module dir> <GLOBALB.BUN> <profile folder> <out dir>
const fs = require('fs'), path = require('path'), os = require('os');
const { pathToFileURL } = require('url');
const [pwDir, bunPath, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-parts.cjs <playwright dir> <GLOBALB.BUN> <profile folder> <out dir>'); process.exit(2); }
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
  const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(fs.readFileSync(bunPath))))));
  const files = {};
  for (const f of fs.readdirSync(profDir)) if (fs.statSync(path.join(profDir, f)).isFile()) files[f] = fs.readFileSync(path.join(profDir, f));
  const orig = { career: new Uint8Array(files[NAME]), garage: files['GARAGE.DAT'] ? new Uint8Array(files['GARAGE.DAT']) : null };
  const car = ops.summary(orig, db).cars[0];
  // The copy starts with this car at Level 1 everywhere, written offline before the site loads it.
  let want = ops.setCarPerformance(orig, car.index, { tiers: Object.fromEntries(ops.PERF_GROUPS.map((g) => [g.code, 1])) });
  files[NAME] = Buffer.from(want.career);
  if (want.garage) files['GARAGE.DAT'] = Buffer.from(want.garage);
  const picks = ops.carParts(want, car.index).map((g) => ({ code: g.code, label: g.label, part: g.parts.find((p) => p.level === 2 && !p.on) }));
  check('every category has a Level 2 part to fit on the Level 1 copy', picks.every((p) => p.part), picks.map((p) => `${p.code}:${p.part?.label}`).join(', '));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-parts-'));
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
    const savedFiles = () => site.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
      const out = {};
      for await (const [n, h] of dir.entries()) if (h.kind === 'file') out[n] = [...new Uint8Array(await (await h.getFile()).arrayBuffer())];
      return out;
    }, NAME);

    const panel = await ctx.newPage();
    const errors = [];
    panel.on('pageerror', (e) => errors.push(String(e)));
    await panel.setViewportSize({ width: 400, height: 1000 });
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.waitForFunction(() => /Connected|Read only|Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    await panel.selectOption('#profile', NAME);
    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
    await panel.waitForSelector('#cars details', { timeout: 30000 });
    const carSel = `#cars details.car:has(#tier-${car.index}-EN)`;
    if (!(await panel.$eval(carSel, (d) => d.open))) await panel.click(`${carSel} > summary`);
    const edits = () => panel.evaluate(() => Number(document.body.dataset.edits || 0));
    const sideways = () => panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    const fitOne = async ({ code, label, part }, width) => {
      const btn = `${carSel} button[aria-controls="parts-${car.index}-${code}"]`;
      if ((await panel.getAttribute(btn, 'aria-expanded')) !== 'true') await panel.click(btn);
      const chk = `#part-${car.index}-${part.index}`;
      await panel.waitForSelector(chk, { state: 'visible' });
      await panel.check(chk);
      const bar = await panel.$eval(`${carSel} .parts-bar`, (b) => ({ hidden: b.hidden, text: b.textContent }));
      const effect = await panel.$eval(chk, (c) => c.closest('.part').querySelector('.part-effect').textContent);
      const over = await sideways();
      const n = await edits();
      await panel.click(`${carSel} .parts-bar button:has-text("Apply")`);
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 60000 });
      await panel.waitForSelector(chk);
      want = ops.setCarParts(want, car.index, { [part.index]: true });
      const saved = await savedFiles();
      const after = await panel.evaluate(({ chk, bar }) => ({ checked: document.querySelector(chk)?.checked, barHidden: document.querySelector(bar)?.hidden }), { chk, bar: `${carSel} .parts-bar` });
      const toast = await panel.textContent('#toastText');
      // The ticked part's line describes the tick itself, and agrees with the strip on whether the dyno moved
      // (the first tick on a car once read "no change" from a stale pending list while the strip showed one).
      const stripMoved = !/hp \(same\), quarter mile [\d.]+ s \(same\)/.test(bar.text);
      check(`${width}px ${label}: ticking ${part.label} shows 1 change, its own "Fitting it" line and the dyno strip`, !bar.hidden && /1 change not applied/.test(bar.text) && /With these changes: .* hp .*Neutral setup, dyno model, untested in game\./.test(bar.text) &&
        /^(Replaced by [^.]*\. )?Fitting it: /.test(effect) && (stripMoved ? !/no change on the dyno/.test(effect) : true) &&
        // A Level 2 nitrous, suspension, brake or tire part moves no number but gives its sliders more range.
        (['NO', 'SU', 'BR', 'TI'].includes(code) ? /widens|unlocks/.test(effect) : true),
        `${effect} | ${bar.text.slice(0, 160)}`);
      check(`${width}px ${label}: Apply saves exactly the offline setCarParts bytes, career and GARAGE.DAT`, eq(saved[NAME], [...want.career]) && eq(saved['GARAGE.DAT'] ?? null, want.garage ? [...want.garage] : null), toast.slice(0, 120));
      check(`${width}px ${label}: after the save the part stays ticked, the list stays open and the bar is gone`, after.checked === true && after.barHidden === true && over <= 0, `sideways ${over}px`);
    };

    for (const p of picks.slice(0, 5)) await fitOne(p, 400);
    await panel.locator(carSel).screenshot({ path: path.join(outDir, 'parts-400.png') });
    await panel.setViewportSize({ width: 1400, height: 1000 });
    for (const p of picks.slice(5)) await fitOne(p, 1400);
    await panel.locator(carSel).screenshot({ path: path.join(outDir, 'parts-1400.png') });

    // Discard: two ticks in one category, then Discard writes nothing and puts both back.
    const en = ops.carParts(want, car.index).find((g) => g.code === 'EN');
    const two = en.parts.filter((p) => p.level === 3 && !p.on).slice(0, 2);
    const n0 = await edits();
    for (const p of two) await panel.check(`#part-${car.index}-${p.index}`);
    const count = await panel.textContent(`${carSel} .parts-count`);
    await panel.click(`${carSel} .parts-bar button:has-text("Discard")`);
    await panel.waitForTimeout(300);
    const ticks = await panel.evaluate((ids) => ids.map((id) => document.getElementById(id).checked), two.map((p) => `part-${car.index}-${p.index}`));
    const saved = await savedFiles();
    check('Discard after two ticks writes nothing and unticks both', two.length === 2 && /2 changes not applied/.test(count) && ticks.every((t) => !t) && (await edits()) === n0 && eq(saved[NAME], [...want.career]), `${count}, ticks ${ticks}`);
    check('the panel threw no errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } catch (err) {
    check('live parts run', false, String(err && err.stack || err));
  } finally {
    await ctx.close();
    console.log(`\n${pass}/${pass + fail} pass`);
    process.exitCode = fail ? 1 : 0;
  }
})();
