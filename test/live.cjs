// Live end-to-end test: the unpacked extension in a throwaway headless Chrome profile on https://nfsu2.xyz.
// It plants a test profile into that throwaway profile's site storage, drives the side panel page,
// and checks every action and its undo against bytes computed offline by src/ops.js.
// Usage: node test/live.cjs <playwright module dir> <GLOBALB.BUN> <test profile folder> <out dir>
// NFSU2_BLOCK_MUSIC=1 runs every check with the music player's hosts refused (Spotivibly, YouTube and its media
// hosts): the editor must work fully without them, and the Music card falls back to the Generate link.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const [pwDir, bunPath, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live.cjs <playwright dir> <GLOBALB.BUN> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
// NFSU2_EXT runs the suite against another copy, such as the store build in dist/store.
const EXT = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NAME = path.basename(profDir);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

(async () => {
  const ops = await import(path.join(EXT, 'src/ops.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const music = await import(path.join(EXT, 'src/music.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(fs.readFileSync(bunPath))))));
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-live-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    // Branded Chrome ignores --load-extension, so load the unpacked folder over the DevTools pipe.
    args: ['--enable-unsafe-extension-debugging'],
  });
  const blockMusic = process.env.NFSU2_BLOCK_MUSIC === '1', blocked = [];
  const MUSIC_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(spotivibly\.com|youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com|ggpht\.com)\//;
  if (blockMusic) await ctx.route(MUSIC_HOSTS, (r) => { blocked.push(r.request().url()); return r.abort('blockedbyclient'); });
  try {
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    check('extension loaded in the throwaway profile', !!extId, extId);

    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    // Plant the test profile into this throwaway profile's site storage.
    const files = { [NAME]: [...fs.readFileSync(path.join(profDir, NAME))] };
    if (fs.existsSync(path.join(profDir, 'GARAGE.DAT'))) files['GARAGE.DAT'] = [...fs.readFileSync(path.join(profDir, 'GARAGE.DAT'))];
    await site.evaluate(async ({ name, files }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true })).getDirectoryHandle(name, { create: true });
      for (const [n, bytes] of Object.entries(files)) { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); }
    }, { name: NAME, files });
    await site.reload({ waitUntil: 'load' });
    await site.waitForTimeout(2500);

    const readOpfs = async () => {
      const r = await site.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory();
        const dir = await (await (await root.getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
        const get = async (n) => { try { return [...new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer())]; } catch { return null; } };
        return { career: await get(name), garage: await get('GARAGE.DAT') };
      }, NAME);
      return { career: new Uint8Array(r.career), garage: r.garage ? new Uint8Array(r.garage) : null };
    };
    const same = (a, b) => sha(a.career) === sha(b.career) && (a.garage ? sha(a.garage) : '') === (b.garage ? sha(b.garage) : '');
    const initial = await readOpfs();

    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 400, height: 1000 });
    const errors = [], panelHosts = new Set();
    panel.on('pageerror', (e) => errors.push(String(e)));
    // With the music hosts refused, the refused loads log a network error: that is the refusal, not a fault.
    panel.on('console', (m) => { if (m.type() === 'error' && !(blockMusic && /ERR_BLOCKED_BY_CLIENT/.test(m.text()))) errors.push(m.text()); });
    panel.on('request', (r) => { const u = r.url(); if (!/^(chrome-extension|data|blob):/.test(u)) panelHosts.add(u.replace(/^(https?:\/\/[^/]+).*$/, '$1')); });
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.waitForFunction(() => /Connected|Read only|Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    const conn = await panel.textContent('#conn');
    check('panel finds the nfsu2.xyz tab and says it is safe to edit', /safe to edit/.test(conn), conn);
    check('panel lists the planted profile', (await panel.$$eval('#profile option', (o) => o.map((x) => x.value))).includes(NAME));
    await panel.selectOption('#profile', NAME);

    // Same Web Locks client as the page: this tab is the holder, not "another tab".
    const tabs = await panel.evaluate(async () => {
      const out = [];
      for (const t of await chrome.tabs.query({})) { try { const r = await chrome.tabs.sendMessage(t.id, { type: 'status', saveDir: 'save' }); out.push({ id: t.id, lock: r.gate.lock, ok: r.gate.ok }); } catch { /* not the site */ } }
      return out;
    });
    check('content script shares the page lock client (lock = this-tab)', tabs.length === 1 && tabs[0].lock === 'this-tab', JSON.stringify(tabs));

    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
    check('game data loads from a chosen GLOBALB.BUN', true, await panel.textContent('#dbState'));
    await panel.screenshot({ path: path.join(outDir, 'panel-start.png'), fullPage: true });

    const toastText = async () => (await panel.textContent('#toastText')) || '';
    // sel is a selector to click, or a function that performs the action itself and returns null.
    const clickAndWait = async (sel) => {
      const n = await panel.evaluate(() => Number(document.body.dataset.edits || 0));
      if (typeof sel === 'function') await sel(); else await panel.click(sel);
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 600000 });
      return toastText();
    };
    // Unlock everything finishes the story, so its first click only asks: nothing is written until the confirm.
    {
      const locks = ops.storyLocks(initial, db), change = ops.finishStoryChanges(initial, db);
      const shown = await panel.$$eval('#storyLocksList li', (li) => li.map((x) => x.textContent));
      check('the story-locked list shows one line per requirement when gates are shut', (await panel.isHidden('#storyLocks')) === !locks.length && shown.length === locks.length, shown.slice(0, 2).join('; ') || 'no gates shut');
      const edits0 = await panel.evaluate(() => Number(document.body.dataset.edits || 0)), bytes0 = await readOpfs();
      await panel.click('#unlockAll');
      const ask = (await panel.isVisible('#unlockConfirm')) ? await panel.textContent('#unlockConfirmText') : '';
      check('Unlock everything asks first and names what it changes', change.finished ? /already finished/.test(ask) : /Career finished/.test(ask) && ask.includes(`now ${change.events}`) && ask.includes(`${change.totalEvents} events`), ask.slice(0, 120));
      await panel.click('#unlockConfirmNo');
      check('Cancel hides the question and writes nothing', await panel.isHidden('#unlockConfirm') && same(await readOpfs(), bytes0) && await panel.evaluate(() => Number(document.body.dataset.edits || 0)) === edits0);
    }
    // The carbon body kit shortcut: shown with the game data, disabled with its reason where it does not apply.
    // Where it applies: the first click names the races and writes nothing, the second writes exactly the offline
    // result, and Undo restores the bytes.
    {
      const plan = ops.urlWinsPlan(initial, db);
      const note = await panel.textContent('#urlWinsNote');
      check('the carbon body kit shortcut shows, enabled only where it applies', await panel.isVisible('#urlWins') && (await panel.isDisabled('#urlWins')) === !plan.applies && (plan.applies || note === plan.reason), note.slice(0, 100));
      if (plan.applies) {
        const label = await panel.textContent('#urlWinsLabel'), aria = await panel.getAttribute('#urlWins', 'aria-label');
        check('its label says how many URL race wins it records', label.includes(`Record ${plan.races.length} win`) && aria.includes(`records ${plan.races.length} ${plan.stage} URL race`), `${label} | ${aria}`);
        const bytes0 = await readOpfs();
        await panel.click('#urlWins');
        const ask = await panel.textContent('#urlWinsConfirmText');
        check('the first click lists every race by name, says the game counts them as won, and writes nothing',
          plan.races.every((n) => ask.includes(n)) && /count them as won/.test(ask) && same(await readOpfs(), bytes0), ask.slice(0, 140));
        const msg = await clickAndWait('#urlWinsYes');
        const after = await readOpfs();
        check('Record the wins writes exactly the offline result', /saved/.test(msg) && same(after, ops.recordUrlWins(bytes0, db)), msg.slice(0, 80));
        check('after it, the shortcut is disabled and says the kits are open', await panel.isDisabled('#urlWins') && /already open/.test(await panel.textContent('#urlWinsNote')));
        const undoMsg = await clickAndWait('#history li:first-child button');
        check('Undo after the shortcut restores the exact bytes', /saved/.test(undoMsg) && same(await readOpfs(), bytes0));
      }
    }
    const confirmUnlock = async () => { await panel.click('#unlockAll'); await panel.click('#unlockConfirmYes'); };
    // The first car's controls live in a collapsed block: open it (the panel keeps it open across re-renders).
    const car0 = ops.summary(initial, db).cars[0];
    await panel.waitForSelector('#cars[data-auto-car]', { state: 'attached', timeout: 15000 });
    await panel.evaluate(() => { const d = document.querySelector('#cars details:first-of-type'); if (!d.open) d.querySelector('summary').click(); });
    const tuOn = car0.uniques[ops.PERF_GROUPS.findIndex((g) => g.code === 'TU')];
    const carBtn = (text) =>`#cars details:first-of-type button:has-text("${text}")`;
    // I5: an open car shows one tab of controls at a time. Opens a tab, then returns the selector to click in it.
    const inTab = (tab, sel, det = '#cars details:first-of-type') => async () => { await panel.click(`${det} .ctabs button[data-tab="${tab}"]`); return sel; };
    // The unique chips count what is fitted, under their own label, apart from the story locks.
    {
      const title = await panel.isVisible('#uniqueTitle') ? await panel.textContent('#uniqueTitle') : '';
      const chips = await panel.$$eval('#uniqueList li', (li) => li.map((x) => x.textContent));
      const order = await panel.evaluate(() => !!(document.getElementById('uniqueBox').compareDocumentPosition(document.getElementById('storyLocks')) & Node.DOCUMENT_POSITION_FOLLOWING));
      check('the unique chips have a label, say "on N of M cars", and sit above the story locks',
        /^Uniques: (all 9|\d of 9) on every car$/.test(title) && chips.length === 9 && chips.every((t) => /: on (all \d+|\d+ of \d+) cars?$/.test(t)) && order, chips.slice(0, 2).join('; '));
      const names = await panel.$$eval('#cars .car-name', (n) => n.map((x) => x.textContent));
      check('car rows show real car names, not internal ones', names.length > 0 && names.every((t) => !/^[A-Z0-9_]+$/.test(t)), names.join(', '));
    }
    // Change car: the picker lists every car in the game data, previews, writes one edit, and Undo restores the bytes.
    {
      const here = ops.carHashInSlot(initial, car0.index);
      const choices = ops.carChoices(initial, db);
      const target = choices.find((c) => c.player && c.locked && c.hash !== here) ?? choices.find((c) => c.player && c.hash !== here);
      const box = '#cars details:first-of-type .swap';
      const before = await readOpfs();
      await panel.click('#cars details:first-of-type .swap-toggle');
      const players = choices.filter((c) => c.player && c.available).length;
      const rows = await panel.$$eval(`${box} .swap-row`, (r) => r.map((x) => x.textContent));
      check('Change car lists every player car with real names', rows.length === players && !rows.some((t) => /\b(PEUGOT|LANCEREVO8|IMPREZAWRX)\b/.test(t)), `${rows.length} rows of ${players}`);
      // I15: the list opens with the search focused, grouped under makes, traffic left out.
      const legends = await panel.$$eval(`${box} fieldset.swap-group legend`, (l) => l.map((x) => x.textContent));
      const traffic = choices.filter((c) => !c.player).map((c) => c.name);
      check('I15 Change car groups cars under their make, sorted, with no traffic group', legends.length > 3 && legends.join() === [...legends].sort((a, b) => a.localeCompare(b)).join() && !legends.some((l) => /traffic/i.test(l)) && !rows.some((t) => traffic.includes(t.trim())), legends.join(', '));
      check('I15 opening Change car focuses its search box', await panel.evaluate((id) => document.activeElement?.id === id, `swap-${car0.index}-find`));
      const curDisabled = await panel.$$eval(`${box} .swap-row input:disabled`, (i) => i.length);
      check('I15 only the car in this slot is disabled', curDisabled === 1, String(curDisabled));
      check('story-locked cars say so in the list', target.locked ? (await panel.textContent(`label[for="swap-${car0.index}-${target.internal}"]`)).includes(target.locked) : true, target.locked || 'none locked');
      await panel.fill(`#swap-${car0.index}-find`, target.name.split(' ').slice(1).join(' '));
      const shown = await panel.$$eval(`${box} .swap-row:not([hidden])`, (r) => r.map((x) => x.querySelector('.swap-name').textContent));
      check('search narrows the list', shown.includes(target.name) && shown.length < 46, shown.join(', '));
      await panel.check(`#swap-${car0.index}-${target.internal}`);
      await panel.click(`${box} button:has-text("Preview the change")`);
      const ask = await panel.textContent(`#swap-${car0.index}-text`);
      check('the preview names both cars, what resets and any story lock, and writes nothing',
        ask.includes(target.name) && ask.includes(car0.name) && /vinyls, decals and neon/.test(ask) && (!target.locked || ask.includes(target.locked)) && same(await readOpfs(), before), ask.slice(0, 160));
      const msg = await clickAndWait(`${box} .confirm button:has-text("Change car")`);
      check('Change car writes exactly the offline swap', /saved/.test(msg) && same(await readOpfs(), ops.changeCar(before, car0.index, target.hash, db)), msg.slice(0, 80));
      check('the row and the newest history entry name the new car',
        (await panel.textContent('#cars details:first-of-type .car-name')) === target.name && (await panel.textContent('#history li:first-child span')).includes(target.name));
      const undoMsg = await clickAndWait('#history li:first-child button');
      check('Undo after Change car restores the exact bytes', /saved/.test(undoMsg) && same(await readOpfs(), before));
    }
    const actions = [
      ['Max money', '#maxMoney', (s) => ops.setMoney(s, ops.MAX_BUTTON_MONEY)],
      ['Set money 4,242', async () => { await panel.fill('#money', '4242'); return '#setMoney'; }, (s) => ops.setMoney(s, 4242)],
      ['Max performance', '#maxPerf', (s) => ops.maxPerformance(s)],
      ['All unique upgrades', '#uniques', (s) => ops.applyUniques(s)],
      ['Unlock everything', async () => { await panel.click('#unlockAll'); return '#unlockConfirmYes'; }, (s) => ops.unlockAll(s, db)],
      ['Stage picker (Stage 2)', async () => { await panel.selectOption('#stage', '1'); return '#setStage'; }, (s) => ops.setStage(s, 1)],
      [`${car0.name}: engine Level 2`, async () => () => panel.selectOption(`#tier-${car0.index}-EN`, '2'), (s) => ops.setCarPerformance(s, car0.index, { tiers: { EN: 2 } })],
      // Flip the turbo unique from whatever the profile has, so the change event always fires.
      [`${car0.name}: turbo unique ${tuOn ? 'off' : 'on'}`, async () => () => panel.setChecked(`#uniq-${car0.index}-TU`, !tuOn), (s) => ops.setCarPerformance(s, car0.index, { uniques: { TU: !tuOn } })],
      [`${car0.name}: Max this car`, inTab('perf', carBtn('Max this car')), (s) => ops.maxCar(s, car0.index)],
      [`${car0.name}: All uniques (one car)`, inTab('perf', carBtn('All uniques')), (s) => ops.applyUniques(s, car0.index)],
      [`${car0.name}: recommended Drag setup`, inTab('setups', carBtn('Drag')), (s) => ops.applyPreset(s, car0.index, 1, db).state],
      // Each switch is pressed toward the state the profile does not have yet, so every press writes.
      // The body kit switch moves all four carbon flags (93-96). Groups the car cannot switch are skipped.
      ...['hood', 'spoiler', 'kit'].filter((code) => car0.carbon[ops.CARBON_GROUPS.findIndex((x) => x.code === code)]).map((code) => {
        const g = ops.CARBON_GROUPS.find((x) => x.code === code), on = car0.carbon[ops.CARBON_GROUPS.indexOf(g)] !== 'carbon';
        return [`${car0.name}: ${code} ${on ? 'carbon' : 'plain'}`, inTab('carbon', `#cars details:first-of-type .seg[aria-label="${g.label} material"] button:text-is("${on ? 'Carbon' : 'Plain'}")`), (s) => ops.setCarbon(s, car0.index, on, db, [code])];
      }),
      [`${car0.name}: all carbon (one car)`, inTab('carbon', carBtn('All carbon')), (s) => ops.setCarbon(s, car0.index, true, db)],
      [`${car0.name}: all plain (one car)`, inTab('carbon', carBtn('All plain')), (s) => ops.setCarbon(s, car0.index, false, db)],
      ['All carbon fibre (every car)', '#carbonAll', (s) => ops.setCarbon(s, null, true, db)],
      [`${car0.name}: Best car`, carBtn('Best car'), (s) => ops.bestCar(s, car0.index, db).state],
      ['Best version of every car', '#bestGarage', (s) => ops.bestGarage(s, db).state],
    ];
    for (const [label, sel, fn] of actions) {
      const before = await readOpfs();
      const selector = typeof sel === 'function' ? await sel() : sel;
      const msg = await clickAndWait(selector);
      const after = await readOpfs();
      const expected = fn(before);
      if (same(expected, before)) {
        check(`${label}: already true, panel says so and writes nothing`, /already done/.test(msg) && same(after, before), msg.slice(0, 60));
        continue;
      }
      check(`${label}: written bytes equal the offline result`, /saved/.test(msg) && same(after, expected), msg.slice(0, 60));
      const undoMsg = await clickAndWait('#history li:first-child button');
      const back = await readOpfs();
      check(`${label}: Undo restores the exact bytes`, /saved/.test(undoMsg) && same(back, before), undoMsg.slice(0, 40));
    }

    // Carbon off, in the car's top row: every carbon part on the car plain, in one write and one Undo entry.
    {
      const before = await readOpfs();
      // History keeps the newest entries only, so one entry shows as one new tail entry on top of the old tail.
      const tail = () => panel.evaluate(async (k) => ((await chrome.storage.local.get(k))[k]?.entries ?? []).slice(-2).map((e) => [e.id, e.label]), `hist:save/${NAME}`);
      const top = await panel.$$eval('#cars details:first-of-type .car-top button', (b) => b.map((x) => x.textContent.trim()));
      check('Carbon off sits in the car\'s top row between Best car and Change car', top.join() === 'Best car,Carbon off,Change car', top.join());
      if (!ops.summary(before, db).cars[0].carbon.includes('carbon')) {
        check(`${car0.name}: Carbon off is off when nothing on the car is carbon`, await panel.isDisabled(carBtn('Carbon off')));
      } else {
        const t0 = await tail();
        const msg = await clickAndWait(carBtn('Carbon off'));
        const after = await readOpfs();
        check(`${car0.name}: Carbon off writes every carbon part plain, equal to the offline result`,
          /carbon off: saved/.test(msg) && same(after, ops.setCarbon(before, car0.index, false, db)) && !ops.summary(after, db).cars[0].carbon.includes('carbon'),
          `${msg.slice(0, 60)} ${ops.summary(after, db).cars[0].carbon.join('/')}`);
        const t1 = await tail();
        check(`${car0.name}: Carbon off is one Undo entry`, t1[0]?.[0] === t0.at(-1)?.[0] && /carbon off/.test(t1[1]?.[1] ?? ''), JSON.stringify(t1.map((e) => e[1])));
        check(`${car0.name}: Carbon off turns off once nothing on the car is carbon`, await panel.isDisabled(carBtn('Carbon off')));
        const undoMsg = await clickAndWait('#history li:first-child button');
        check(`${car0.name}: Undo after Carbon off restores the exact bytes`, /saved/.test(undoMsg) && same(await readOpfs(), before), undoMsg.slice(0, 40));
      }
    }

    // Build up a state, then Restore original.
    await clickAndWait('#maxMoney');
    await clickAndWait(confirmUnlock);
    await panel.screenshot({ path: path.join(outDir, 'panel-after-edits.png'), fullPage: true });
    // Restore original reverts every edit since the first, so it asks first and names them; it writes on the second click.
    await panel.click('#restoreOriginal');
    await panel.waitForFunction(() => !document.getElementById('undoConfirm').hidden, null, { timeout: 8000 });
    check('Restore original asks first and names the edits it reverts', /later edits: /.test(await panel.textContent('#undoConfirmText')), (await panel.textContent('#undoConfirmText')).slice(0, 120));
    await clickAndWait('#undoConfirmYes');
    check('Restore original returns the untouched bytes', same(await readOpfs(), initial));

    // Carbon proof for the game: the car with the most plain parts goes all carbon, then Undo. Both states are
    // exported next to the screenshots so the game can load exactly the bytes the panel wrote.
    {
      const cars = ops.summary(initial, db).cars;
      const pick = cars.reduce((best, c, i) => (c.carbon.filter((x) => x === 'plain').length > cars[best].carbon.filter((x) => x === 'plain').length ? i : best), 0);
      const det = `#cars details:nth-of-type(${pick + 1})`;
      await panel.evaluate((sel) => { const d = document.querySelector(sel); if (d && !d.open) d.querySelector('summary').click(); }, det);
      const exportState = (tag, st) => {
        const d = path.join(outDir, tag, NAME); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, NAME), st.career); if (st.garage) fs.writeFileSync(path.join(d, 'GARAGE.DAT'), st.garage);
      };
      const before = await readOpfs();
      const msg = await clickAndWait(await inTab('carbon', `${det} button:has-text("All carbon")`, det)());
      const after = await readOpfs();
      check(`${cars[pick].name}: all carbon written equals the offline result`, /saved/.test(msg) && same(after, ops.setCarbon(before, cars[pick].index, true, db)), ops.summary(after, db).cars[pick].carbon.join('/'));
      await panel.waitForSelector(`${det} .seg`);
      await (await panel.$(det)).screenshot({ path: path.join(outDir, 'carbon-toggles.png') });
      await panel.screenshot({ path: path.join(outDir, 'carbon-panel.png'), fullPage: true });
      exportState('carbon-state', after);
      const undoMsg = await clickAndWait('#history li:first-child button');
      const back = await readOpfs();
      check(`${cars[pick].name}: Undo after all carbon restores the exact bytes`, /saved/.test(undoMsg) && same(back, before));
      await (await panel.$(det)).screenshot({ path: path.join(outDir, 'carbon-toggles-undone.png') });
      exportState('undo-state', back);
      const pressed = await panel.$$eval(`${det} .seg button[aria-pressed="true"]`, (b) => b.map((x) => x.textContent));
      check(`${cars[pick].name}: toggles show the undone state`, pressed.join() === ops.summary(back, db).cars[pick].carbon.filter(Boolean).map((x) => (x === 'carbon' ? 'Carbon' : 'Plain')).join(), pressed.join());
    }

    // Looks proof: open the first car's Looks block, change body paint, rims and neon through the real controls,
    // compare each write with the offline result, export the state for the game, then Undo all three.
    {
      const car = ops.summary(initial, db).cars[0], idx = car.index;
      const det = '#cars details.car:nth-of-type(1)';
      await panel.evaluate((sel) => { const d = document.querySelector(sel); if (d && !d.open) d.querySelector('summary').click(); }, det);
      await panel.click(`${det} .ctabs button[data-tab="looks"]`);
      await panel.waitForSelector(`${det} .looks-tabs button`);
      const looksBox = `${det} .cpanel[data-tab="looks"]`;
      check(`${car.name}: I5 the Looks tab shows only its own panel`, await panel.$$eval(`${det} .cpanel`, (p) => p.filter((x) => !x.hidden).map((x) => x.dataset.tab).join()) === 'looks' &&
        await panel.getAttribute(`${det} .ctabs button[data-tab="looks"]`, 'aria-selected') === 'true');
      const groups = ops.visualEditor(initial, idx, db);
      const tabs = await panel.$$eval(`${det} .looks-tabs button`, (b) => b.map((x) => x.textContent));
      check(`${car.name}: Looks shows one tab per part group`, tabs.join() === groups.map((g) => g.label).join(), tabs.join(', '));
      const slotOf = (st, id) => ops.visualEditor(st, idx, db).flatMap((g) => g.slots).find((s) => s.id === id);
      const start = await readOpfs();
      await (await panel.$(looksBox)).screenshot({ path: path.join(outDir, 'looks-body.png') });
      const steps = [
        ['body paint', 'Paint', 63, async (s) => s.options.find((o) => o.hash !== s.value && /Metal|Pearl|Candy/i.test(o.label)) ?? s.options.find((o) => o.hash !== s.value)],
        ['rims', 'Body parts', 29, async (s) => s.options.find((o) => o.size && o.group !== s.options.find((x) => x.hash === s.value)?.group)],
        ['underglow neon', 'Neon and lights', 154, async (s) => s.options.find((o) => o.hash !== s.value && o.color)],
      ];
      for (const [label, tab, id, choose] of steps) {
        await panel.click(`${det} .looks-tabs button:text-is("${tab}")`);
        const before = await readOpfs(), s = slotOf(before, id), pick = await choose(s);
        const msg = await clickAndWait(async () => {
          if (id === 29) await panel.selectOption(`#look-${idx}-29`, pick.group);
          else await panel.selectOption(`#look-${idx}-${id}`, String(pick.hash));
        });
        const after = await readOpfs(), got = slotOf(after, id).value;
        const ok = id === 29 ? s.options.find((o) => o.hash === got)?.group === pick.group : got === pick.hash;
        check(`${car.name}: ${label} through Looks equals the offline write`, /saved/.test(msg) && ok && same(after, ops.setVisual(before, idx, id, got, db)), s.options.find((o) => o.hash === got)?.label);
        if (id === 63) await (await panel.$(looksBox)).screenshot({ path: path.join(outDir, 'looks-paint.png') });
      }
      const looked = await readOpfs();
      const d = path.join(outDir, 'looks-state', NAME); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, NAME), looked.career); if (looked.garage) fs.writeFileSync(path.join(d, 'GARAGE.DAT'), looked.garage);
      await (await panel.$(looksBox)).screenshot({ path: path.join(outDir, 'looks-neon.png') });
      // Undo writes an entry's "before" snapshot, so undoing the oldest of the three returns to the start.
      // It reverts the two later Looks edits too, so it asks first.
      await panel.click(`#history li:nth-child(${steps.length}) button`);
      await panel.waitForFunction(() => !document.getElementById('undoConfirm').hidden, null, { timeout: 8000 });
      await clickAndWait('#undoConfirmYes');
      check(`${car.name}: Undo of the first Looks edit restores the exact bytes`, same(await readOpfs(), start));
    }

    // Gate 1: game running in this tab.
    const phase = await site.evaluate(() => { const p = document.body.dataset.phase; document.body.dataset.phase = 'playing'; return p; });
    const pre = await readOpfs();
    // The page tells the panel the phase changed, so the panel turns read only and says why (B17).
    await panel.waitForFunction(() => document.getElementById('maxMoney').disabled, null, { timeout: 10000 }).catch(() => {});
    const conn1 = await panel.textContent('#conn');
    check('while the game runs the panel turns read only and says why', (await panel.isDisabled('#maxMoney')) && /game is running/.test(conn1), conn1.slice(0, 80));
    // A write sent anyway is refused by the page's own gate.
    const gameRes = await panel.evaluate(async (name) => {
      const tab = (await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' }))[0].id;
      return chrome.tabs.sendMessage(tab, { type: 'write', saveDir: 'save', profile: name, expectCareerSha: '', expectGarageSha: null, career: '', garage: null });
    }, NAME);
    check('write refused while the game runs, files untouched', gameRes?.ok === false && /game is running/.test(gameRes?.why || '') && same(await readOpfs(), pre), gameRes?.why);
    await site.evaluate((p) => { document.body.dataset.phase = p; }, phase);
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });

    // Gate 2: a second nfsu2.xyz tab does not own the saves lock and must refuse.
    const site2 = await ctx.newPage();
    await site2.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    await site2.waitForTimeout(2000);
    const second = await panel.evaluate(async (first) => {
      for (const t of await chrome.tabs.query({})) {
        try {
          const st = await chrome.tabs.sendMessage(t.id, { type: 'status', saveDir: 'save' });
          if (st.gate.lock !== 'this-tab') {
            const w = await chrome.tabs.sendMessage(t.id, { type: 'write', saveDir: 'save', profile: first, career: 'AA==', expectCareerSha: 'x' });
            return { lock: st.gate.lock, refused: w.refused === true, why: w.why };
          }
        } catch { /* not the site */ }
      }
      return null;
    }, NAME);
    check('second nfsu2.xyz tab is read only and refuses writes', !!second && second.lock === 'other' && second.refused, JSON.stringify(second));
    await site2.close();
    check('files unchanged by the refused write', same(await readOpfs(), pre));

    // A stale read is refused: the career changes between read and write. The bytes sent are a well-formed career (the
    // one on disk), so only the hash check can refuse it.
    const onDisk = await readOpfs();
    const garageSha = onDisk.garage ? require('crypto').createHash('sha256').update(onDisk.garage).digest('hex') : null;
    const stale = await panel.evaluate(async ([name, career, expectGarageSha]) => {
      const [t] = (await Promise.all((await chrome.tabs.query({})).map(async (t) => { try { await chrome.tabs.sendMessage(t.id, { type: 'ping' }); return t; } catch { return null; } }))).filter(Boolean);
      return chrome.tabs.sendMessage(t.id, { type: 'write', saveDir: 'save', profile: name, career, expectCareerSha: '0'.repeat(64), expectGarageSha });
    }, [NAME, Buffer.from(onDisk.career).toString('base64'), garageSha]);
    check('write refused when the save changed since it was read', stale.refused === true && /changed/.test(stale.why), stale.why);

    // Leave the edits to check in game: max money, unlock everything (stage 6 finishes the story),
    // and the first car with Level 3, every unique and the recommended Drag setup.
    // The Drag preset runs first: Best car fills the Drag setup with the same research values, so after it the preset
    // has nothing left to write (B7 keeps the parts of a car with another setup tuned).
    await clickAndWait('#maxMoney');
    await clickAndWait(confirmUnlock);
    const presetMsg = await clickAndWait(await inTab('setups', carBtn('Drag'))());
    check('preset toast reports the simulated change and "untested in game"', /Untested in game|only the parts changed/.test(presetMsg), presetMsg.slice(0, 160));
    const bestMsg = await clickAndWait(carBtn('Best car'));
    check('best car toast says what it changed and kept, and "untested in game"', /carbon on/.test(bestMsg) && /Untested in game/.test(bestMsg), bestMsg.slice(0, 200));
    const final = await readOpfs();
    fs.writeFileSync(path.join(outDir, `${NAME}.career`), final.career);
    if (final.garage) fs.writeFileSync(path.join(outDir, 'GARAGE.DAT'), final.garage);
    await panel.screenshot({ path: path.join(outDir, 'panel-final.png'), fullPage: true });
    // The site itself reads the edited profile after a reload.
    await site.reload({ waitUntil: 'load' });
    await site.waitForTimeout(3000);
    const siteText = await site.evaluate(() => document.body.innerText);
    check('site still lists the edited profile after reload', siteText.includes(NAME));
    // The EA Trax player plays inside the panel; Generate in Spotivibly opens the prefilled generator in a new tab.
    const frames = await panel.$$eval('iframe', (fs) => fs.map((f) => f.src));
    check('the Music card frames the Spotivibly EA Trax player, and nothing else', frames.length === 1 && frames[0] === music.SPOTIVIBLY_EMBED, frames.join(' '));
    check('the song list has no per-song links, and each of its 27 rows is a button', (await panel.$$('#musicList a')).length === 0 && (await panel.$$eval('#musicList .song .song-btn', (l) => l.length)) === 27);
    check('Generate in Spotivibly is the only primary button in the Music card', (await panel.$$eval('#music .btn.primary', (l) => l.map((b) => b.id))).join() === 'musicGenerate');
    check('the video box is at least 200x200', await panel.$eval('#musicPlayer', (f) => { const r = f.getBoundingClientRect(); return r.width >= 200 && r.height >= 200; }));
    await ctx.route('https://spotivibly.com/generate**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>generator stub</title>' }));
    const [genTab] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), panel.click('#musicGenerate')]);
    await genTab.waitForLoadState('domcontentloaded');
    check('Generate in Spotivibly opens the generator prefilled with the tracklist', genTab.url() === music.SPOTIVIBLY_GENERATE, genTab.url().slice(0, 120));
    await genTab.close();
    // The Spotivibly plug: a quiet link with the logo, Spotivibly's own line and its home page, never a second button.
    const plug = await panel.$eval('#musicPlug', (a) => {
      const img = a.querySelector('img'), r = a.getBoundingClientRect();
      return { href: a.href, cls: a.className, logo: img.complete && img.naturalWidth > 0, text: a.innerText.replace(/\s+/g, ' ').trim(), h: r.height, visible: r.width > 0, last: a === a.parentElement.lastElementChild };
    });
    check('the Spotivibly plug shows the logo, its own one-line pitch and spotivibly.com, at the end of the card', plug.visible && plug.logo && plug.last
      && /Spotivibly Generate AI playlists for Spotify & YouTube\. spotivibly\.com/.test(plug.text) && plug.h >= 44, JSON.stringify(plug));
    check('the plug is a link, not a button, so Generate stays the one primary action', plug.cls === 'plug' && !(await panel.$('#music button.plug, #music .plug .btn')));
    // A missing or broken href is a failed check, not a crash that hides the checks after it.
    const home = URL.canParse(plug.href) ? new URL(plug.href) : null;
    check('the plug opens Spotivibly\'s home page with utm tags only, no song or personal data', !!home && home.origin + home.pathname === 'https://spotivibly.com/'
      && [...home.searchParams.keys()].join() === 'utm_source,utm_medium,utm_campaign' && plug.href === music.SPOTIVIBLY_HOME, plug.href);
    await ctx.route('https://spotivibly.com/?**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>home stub</title>' }));
    const homeTab = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), panel.click('#musicPlug')]).then(([t]) => t, () => null);
    if (homeTab) await homeTab.waitForLoadState('domcontentloaded');
    check('clicking the plug opens spotivibly.com in a new tab', homeTab?.url() === music.SPOTIVIBLY_HOME, homeTab ? homeTab.url() : 'no tab opened');
    await homeTab?.close();
    if (blockMusic) {
      check('O4 the panel asked for the music player and the request was refused', blocked.some((u) => u.startsWith(music.SPOTIVIBLY_EMBED)), `${blocked.length} refused`);
      check('O4 every request the panel made went to a music host (all refused) or the extension itself', panelHosts.size > 0 && [...panelHosts].every((h) => MUSIC_HOSTS.test(`${h}/`)), [...panelHosts].join(' '));
      const fellBack = await panel.waitForFunction(() => /did not answer/.test(document.getElementById('musicPlayerNote').textContent), null, { timeout: 45000 }).then(() => true, () => false);
      const card = await panel.evaluate(() => ({ note: document.getElementById('musicPlayerNote').textContent, controls: ['musicPrev', 'musicToggle', 'musicNext'].map((id) => document.getElementById(id).disabled), gen: document.getElementById('musicGenerate').disabled }));
      check('O4 the Music card says the player did not answer, turns its controls off and keeps Generate', fellBack && card.controls.every(Boolean) && !card.gen, JSON.stringify(card));
    }
    check('no errors in the panel console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(`\n${pass}/${pass + fail} pass`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
