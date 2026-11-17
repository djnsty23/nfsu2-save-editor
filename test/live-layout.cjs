// Live check of layout A: one scroll with section tabs at 400 px, two columns at 1400 px, and the redesign items
// I1-I17b, each driven through the real controls of the unpacked extension in a throwaway headless Chrome profile on
// https://nfsu2.xyz with a planted test profile. Every state is screenshotted at 400 and 1400 px into <out dir>.
// The Spotivibly player is a local stand-in, so no video is fetched.
// Usage: node test/live-layout.cjs <playwright module dir> <GLOBALB.BUN> <test profile folder> <out dir>
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const [pwDir, bunPath, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-layout.cjs <playwright dir> <GLOBALB.BUN> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
// NFSU2_EXT runs the suite against another copy, such as the store build in dist/store.
const EXT = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NAME = path.basename(profDir);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileUrl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

/** A stand-in player: hello lists the tracks; load plays a track; toggle and next behave as the real one. */
const stub = (tracks) => `<!doctype html><title>player stub</title><script>
const tracks = ${JSON.stringify(tracks)};
let index = 0, status = 'idle';
const say = (m) => parent.postMessage(m, '*');
const state = () => say({ type: 'spotivibly:state', version: 1, index, total: tracks.length, status, started: status !== 'idle', time: 0, duration: 200, failed: [], unavailable: false });
addEventListener('message', (e) => {
  const c = e.data;
  if (!c || c.type !== 'spotivibly:command') return;
  if (c.action === 'hello') { say({ type: 'spotivibly:ready', tracks }); state(); }
  if (c.action === 'load') { index = c.index; status = 'playing'; state(); }
  if (c.action === 'toggle') { status = status === 'playing' ? 'paused' : 'playing'; state(); }
  if (c.action === 'next') { index = (index + 1) % tracks.length; status = 'playing'; state(); }
});
</script>`;

(async () => {
  const ops = await import(fileUrl(path.join(EXT, 'src/ops.js')));
  const music = await import(fileUrl(path.join(EXT, 'src/music.js')));
  const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(fs.readFileSync(bunPath))))));
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-layout-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    await ctx.route('https://spotivibly.com/embed/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: stub(music.EA_TRAX.map((s) => ({ name: s.title, artist: s.artist }))) }));
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    const initial = { career: new Uint8Array(fs.readFileSync(path.join(profDir, NAME))), garage: fs.existsSync(path.join(profDir, 'GARAGE.DAT')) ? new Uint8Array(fs.readFileSync(path.join(profDir, 'GARAGE.DAT'))) : null };
    const sum = ops.summary(initial, db);

    const panel = await ctx.newPage();
    const errors = [];
    panel.on('pageerror', (e) => errors.push(String(e)));
    panel.on('console', (m) => { if (m.type() === 'error' && !/spotivibly|favicon|ERR_/.test(m.text())) errors.push(m.text()); });
    await panel.setViewportSize({ width: 400, height: 900 });
    await panel.emulateMedia({ reducedMotion: 'reduce' });
    const shown = (sel) => panel.$eval(sel, (n) => !n.closest('[hidden]') && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0).catch(() => false);
    const rect = (sel) => panel.$eval(sel, (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; });
    const noHScroll = () => panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    /** Screenshots one state at both widths. `prep` runs after each resize (to scroll or reopen something). */
    const shots = async (name, prep) => {
      const wide = [];
      // A leftover toast from an earlier step would sit over the page; only the toast states keep theirs.
      if (!name.startsWith('toast')) await panel.evaluate(() => { document.getElementById('toast').hidden = true; });
      for (const width of [400, 1400]) {
        await panel.setViewportSize({ width, height: width === 400 ? 900 : 1000 });
        await panel.waitForTimeout(150);
        if (prep) await prep(width); else { await panel.evaluate(() => scrollTo(0, 0)); await panel.waitForTimeout(100); }
        await panel.screenshot({ path: path.join(outDir, `${name}-${width}.png`), fullPage: !prep });
        wide.push(await noHScroll());
      }
      await panel.setViewportSize({ width: 400, height: 900 });
      await panel.waitForTimeout(100);
      check(`${name}: no sideways scroll at 400 or 1400 px`, wide.every(Boolean), wide.join(' '));
    };

    // ---- I10: disconnected. Open nfsu2.xyz and Retry, side by side, and nothing else.
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.waitForFunction(() => /Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    check('I10 disconnected: Open nfsu2.xyz and Retry show, the cards do not', await shown('#openSite') && await shown('#retry') && !(await shown('#app')), await panel.textContent('#conn'));
    await shots('disconnected');
    const [site] = await Promise.all([ctx.waitForEvent('page', { timeout: 15000 }), panel.click('#openSite')]);
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.waitForLoadState('load', { timeout: 60000 });
    check('I10 Open nfsu2.xyz opens the site in a new tab', /^https:\/\/nfsu2\.xyz\//.test(site.url()), site.url());

    const plant = (st) => site.evaluate(async ({ name, career, garage }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true })).getDirectoryHandle(name, { create: true });
      const put = async (n, bytes) => { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); };
      await put(name, career);
      if (garage) await put('GARAGE.DAT', garage); else await dir.removeEntry('GARAGE.DAT').catch(() => {});
    }, { name: NAME, career: [...st.career], garage: st.garage ? [...st.garage] : null });
    const readOpfs = async () => {
      const r = await site.evaluate(async (name) => {
        const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
        const get = async (n) => { try { return [...new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer())]; } catch { return null; } };
        return { career: await get(name), garage: await get('GARAGE.DAT') };
      }, NAME);
      return { career: new Uint8Array(r.career), garage: r.garage ? new Uint8Array(r.garage) : null };
    };
    const same = (a, b) => sha(a.career) === sha(b.career) && (a.garage ? sha(a.garage) : '') === (b.garage ? sha(b.garage) : '');
    await plant(initial);
    // The new site tab took the front; the panel goes back in front so its scroll and visibility observers run.
    // Coming back to the front may reconnect by itself, so Retry is clicked only while it is still offered.
    await panel.bringToFront();
    await panel.click('#retry', { timeout: 3000 }).catch(() => {});
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    await panel.selectOption('#profile', NAME);
    await panel.waitForFunction(() => document.querySelector('#cars .car-name'), null, { timeout: 15000 });
    check('I10 Retry connects and the offline buttons go', !(await shown('#offline')) && await shown('#app'));

    // ---- I13: before the game data, the Game data card offers both ways to load it; after, one status line.
    check('I13 without the game data, both load buttons show and Change does not', await shown('#dbFromSite') && !(await shown('#dbChange')));
    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
    await panel.waitForFunction((n) => document.querySelector('#cars .car-name')?.textContent === n, sum.cars[0].name, { timeout: 15000 });
    check('I13 with the game data, one status line and a Change button', await panel.$eval('#dbCard', (c) => c.classList.contains('loaded')) && !(await shown('#dbLoad')) && await shown('#dbChange'));
    await panel.click('#dbChange');
    const dbOpen = await shown('#dbLoad') && await panel.getAttribute('#dbChange', 'aria-expanded') === 'true';
    await panel.click('#dbChange');
    check('I13 Change opens the load buttons and closes them again', dbOpen && !(await shown('#dbLoad')));

    const edits = () => panel.evaluate(() => Number(document.body.dataset.edits || 0));
    const clickAndWait = async (act) => {
      const n = await edits();
      if (typeof act === 'function') await act(); else await panel.click(act);
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 600000 });
      return (await panel.textContent('#toastText')) || '';
    };

    // ---- Normal state, 400 px: section tabs (I12), money in the facts (I4), the stage bar (I17b).
    const jump = await panel.$$eval('#jump button', (b) => b.map((x) => ({ to: x.dataset.to, text: x.textContent.trim(), hidden: x.hidden })));
    check('I12 four section tabs: Career, Cars, Music, History', jump.map((j) => j.text).join() === 'Career,Cars,Music,History' && jump.every((j) => !j.hidden), JSON.stringify(jump));
    check('I12 the section tabs stay on screen while scrolling', await panel.$eval('#jump', (n) => getComputedStyle(n).position) === 'sticky');
    await panel.click('#jump button[data-to="carsCard"]');
    await panel.waitForTimeout(400);
    const carsTop = (await rect('#carsCard')).y, jumpB = (await rect('#jump')).b;
    check('I12 the Cars tab scrolls the Cars card to just under the tabs and marks itself', carsTop >= jumpB - 2 && carsTop <= jumpB + 80 && await panel.getAttribute('#jump button[data-to="carsCard"]', 'aria-current') === 'true', `${Math.round(carsTop)} under ${Math.round(jumpB)}`);
    await panel.click('#jump button[data-to="historyCard"]');
    await panel.waitForTimeout(400);
    check('I12 the History tab marks itself after scrolling', await panel.getAttribute('#jump button[data-to="historyCard"]', 'aria-current') === 'true');
    await panel.evaluate(() => scrollTo(0, 0));
    await panel.waitForTimeout(150);

    const moneyIn = await panel.$eval('#money', (m) => !!m.closest('#facts'));
    const factsDt = await panel.$$eval('#facts dt', (d) => d.map((x) => x.textContent));
    check('I4 money is edited inside the facts list, next to Name and Cars', moneyIn && factsDt.includes('Money') && factsDt[0] === 'Name', factsDt.join(','));
    const cap = await panel.textContent('#stageCount');
    const m = /^(\d+) of (\d+) events · (\d+)%$/.exec(cap || '');
    const barP = await panel.$eval('#stageBar', (b) => b.style.getPropertyValue('--p'));
    check('I17b the stage bar shows events done of total and fills to that share', !!m && Number(m[3]) === Math.round((100 * Number(m[1])) / Number(m[2])) && barP === `${m[3]}%` && await panel.getAttribute('#stageBar', 'aria-valuenow') === m[3] && await shown('#stageName'), `${cap} ${barP}`);

    // I1: one main button for the career, the secondary ones under it, Unlock everything apart in red.
    check('I1 Best version of every car is the one main button; Unlock everything sits in its own red card', await panel.$eval('#bestGarage', (b) => b.classList.contains('primary')) &&
      await panel.$$eval('.oneclick .btn.primary', (b) => b.length) === 1 && await panel.$eval('#unlockAll', (b) => !!b.closest('#dangerCard') && b.classList.contains('dangerbtn')));
    // I6 and I14: the reasons sit behind Why?, closed; the uniques are one line with Details.
    check('I6 the reasons are behind closed "Why?" lines', await panel.$$eval('#careerCard details.why', (d) => d.length > 0 && d.every((x) => !x.open)));
    const uniq = await panel.$eval('#uniqueBox', (d) => ({ open: d.open, title: d.querySelector('#uniqueTitle').textContent, dot: !!d.querySelector('.dot') }));
    check('I14 uniques are one closed line with a status dot', !uniq.open && uniq.dot && /^Uniques: (all 9|\d of 9) on every car$/.test(uniq.title), uniq.title);
    // I3: Next unlocks, closest first, with the carbon body kit shortcut as its row's button where that lock is listed.
    const locks = await panel.$$eval('#storyLocksList > li', (l) => l.map((x) => ({ kit: 'kit' in x.dataset, row: !!x.querySelector('.check-row'), btn: !!x.querySelector('#urlWins') })));
    const plan = ops.urlWinsPlan(initial, db);
    check('I3 each lock is one checklist row, and the carbon body kit row carries the shortcut', locks.every((l) => l.row) && locks.filter((l) => l.kit).every((l) => l.btn) && (locks.some((l) => l.kit) || !(await panel.$eval('#urlWins', (b) => !!b.closest('#storyLocksList')))), JSON.stringify(locks.slice(0, 3)));
    const lockRows = await panel.$$eval('#storyLocksList > li', (l) => l.length);
    const visLocks = () => panel.$$eval('#storyLocksList > li', (l) => l.filter((x) => !x.hidden).length);
    if (lockRows > 6) {
      const few = await visLocks();
      await panel.click('#storyLocksMore');
      const all = await visLocks(), label = await panel.textContent('#storyLocksMore');
      await panel.click('#storyLocksMore');
      check('I3 Next unlocks shows the closest 5 (plus the body kit row), and Show all opens the rest', few <= 6 && all === lockRows && /^Show the closest 5$/.test(label) && await visLocks() === few, `${few} then ${all} of ${lockRows}`);
    } else check('I3 a short Next unlocks list needs no Show all', !(await shown('#storyLocksMore')));
    await shots('normal');

    // ---- 1400 px: two columns, Career left and Cars right, Music across the bottom, no section tabs.
    await panel.setViewportSize({ width: 1400, height: 1000 });
    await panel.waitForTimeout(150);
    const [career, carsR, musicR, layoutR] = [await rect('#careerCard'), await rect('#carsCard'), await rect('#music'), await rect('#app')];
    check('I12 at 1400 px Career is on the left, Cars on the right, side by side', career.r <= carsR.x + 1 && Math.abs(career.y - carsR.y) < 4 && carsR.w > career.w, `${Math.round(career.x)}-${Math.round(career.r)} | ${Math.round(carsR.x)}-${Math.round(carsR.r)}`);
    check('I12 at 1400 px Music spans both columns and the section tabs are gone', musicR.w > 0.95 * layoutR.w && !(await shown('#jump')), `${Math.round(musicR.w)} of ${Math.round(layoutR.w)}`);
    await panel.waitForSelector('#cars[data-auto-car]', { state: 'attached', timeout: 15000 });
    const openCars = () => panel.$$eval('#cars details.car', (d) => d.map((x) => x.open));
    const openWide = await openCars();
    await panel.setViewportSize({ width: 400, height: 900 });
    await panel.waitForTimeout(150);
    const openNarrow = await openCars();
    check('I12 at 1400 px a car opens beside the career (no car edited yet: the first), and it closes again at 400 px', openWide[0] === true && openWide.filter(Boolean).length === 1 && openNarrow.every((o) => !o), `${JSON.stringify(openWide)} then ${JSON.stringify(openNarrow)}`);

    // ---- I7: confirmations list each change from and to. Unlock everything first, then the carbon body kit shortcut.
    {
      const bytes0 = await readOpfs();
      await panel.click('#unlockAll');
      const diff = await panel.$$eval('#unlockDiff li', (l) => l.map((x) => ({ k: x.querySelector('.k')?.textContent, from: x.querySelector('s')?.textContent, to: x.querySelector('b')?.textContent })));
      check('I7 Unlock everything lists stage, events, photo goals and story locks, each from and to', diff.map((d) => d.k).join() === 'Stage,Events won,Photo goals,Story-locked part levels' && diff.every((d) => d.from != null && d.to != null), JSON.stringify(diff));
      await shots('confirm-unlock', async () => { await panel.$eval('#unlockConfirm', (n) => n.scrollIntoView({ block: 'center' })); });
      await panel.click('#unlockConfirmNo');
      check('I7 Cancel writes nothing', same(await readOpfs(), bytes0));
      if (plan.applies) {
        await panel.click('#urlWins');
        const d2 = await panel.$$eval('#urlWinsDiff li', (l) => l.map((x) => `${x.querySelector('.k')?.textContent}:${x.querySelector('s')?.textContent}>${x.querySelector('b')?.textContent}`));
        check('I7 the carbon body kit shortcut lists URL wins, story locks and the kits, from and to', d2.length === 3 && /^URL races won:/.test(d2[0]) && /^Carbon fibre body kits:Locked>Open$/.test(d2[2]), d2.join(' | '));
        await shots('confirm-urlwins', async () => { await panel.$eval('#urlWinsConfirm', (n) => n.scrollIntoView({ block: 'center' })); });
        await panel.click('#urlWinsNo');
      } else check('I7 the carbon body kit shortcut does not apply to this profile (skipped)', true, plan.reason);
    }

    // ---- I9: a success toast offers Undo for that edit; Undo puts the bytes back.
    {
      await panel.evaluate(() => { document.body.dataset.toastMs = '60000'; });
      const bytes0 = await readOpfs();
      const msg = await clickAndWait('#maxMoney');
      check('I9 a saved edit\'s toast offers Undo', /saved/.test(msg) && await shown('#toastUndo'), msg.slice(0, 60));
      await shots('toast-undo', async () => { await panel.$eval('#toast', (n) => n.scrollIntoView({ block: 'end' })); });
      const undoMsg = await clickAndWait('#toastUndo');
      check('I9 Undo in the toast restores the exact bytes and offers no Undo of the undo', /saved/.test(undoMsg) && same(await readOpfs(), bytes0) && !(await shown('#toastUndo')), undoMsg.slice(0, 60));
      // I9 progress: Best version of every car runs in a worker and draws a bar under the text while it runs.
      await panel.evaluate(() => {
        window.progSeen = [];
        new MutationObserver(() => { const b = document.getElementById('toastProg'); if (!b.hidden) window.progSeen.push(b.getAttribute('aria-valuenow')); })
          .observe(document.getElementById('toast'), { subtree: true, attributes: true, childList: true, characterData: true });
      });
      const before = await readOpfs();
      let midShot = false;
      const n = await edits();
      await panel.click('#bestGarage');
      try {
        await panel.waitForFunction(() => !document.getElementById('toastProg').hidden, null, { timeout: 60000 });
        await panel.$eval('#toast', (t) => t.scrollIntoView({ block: 'end' }));
        await panel.screenshot({ path: path.join(outDir, 'toast-progress-400.png') });
        midShot = true;
      } catch { /* finished before a frame showed the bar */ }
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 600000 });
      const seen = await panel.evaluate(() => window.progSeen);
      check('I9 a long job shows a progress bar that ends hidden', midShot && seen.length > 0 && !(await shown('#toastProg')), `${seen.length} updates, last ${seen.at(-1)}`);
      const best = await readOpfs();
      check('I9 Best version of every car writes the offline result', same(best, ops.bestGarage(before, db).state));
      await clickAndWait('#toastUndo');
      check('I9 Undo in the toast after a long job restores the bytes', same(await readOpfs(), before));
      await panel.evaluate(() => { delete document.body.dataset.toastMs; document.getElementById('toast').hidden = true; });
    }

    // ---- I2 and I5: car rows carry badges; an open car shows Best car first and one tab of controls at a time.
    {
      const det = '#cars details:first-of-type';
      await panel.click(`${det} summary`);
      const pills = await panel.$$eval('#cars .car-meta', (n) => n.map((x) => [...x.querySelectorAll('.pill')].map((p) => p.textContent)));
      check('I2 each car row carries a level badge, uniques of 9 and setups of 5', pills.length === sum.cars.length && pills.every((p, i) => p.length === 3 &&
        p[1] === `${sum.cars[i].uniques.filter(Boolean).length}/9 uniques` && p[2] === `${sum.cars[i].tuned.filter(Boolean).length}/5 setups`), JSON.stringify(pills[0]));
      {
        await panel.click(`${det} .swap-toggle`);
        const legends = await panel.$$eval(`${det} .swap .swap-group > legend`, (l) => l.map((x) => x.textContent));
        const focused = await panel.evaluate(() => document.activeElement?.type === 'search');
        check('I15 Change car opens with its search focused and the cars under their makes, A to Z', focused && legends.length > 3 && legends.join() === [...legends].sort((x, y) => x.localeCompare(y)).join(), legends.slice(0, 5).join(','));
        await shots('change-car', async () => { await panel.$eval(det, (n) => n.scrollIntoView({ block: 'start' })); await panel.evaluate(() => scrollBy(0, -60)); });
        await panel.click(`${det} .swap-toggle`);
      }
      const top = await panel.$$eval(`${det} .car-top .btn`, (b) => b.map((x) => x.textContent.trim()));
      const wantTop = 'Best car,Carbon off,Change car';
      check('I5 an open car starts with Best car (main), then Carbon off and Change car', top.join() === wantTop && await panel.$eval(`${det} .car-top .btn`, (b) => b.classList.contains('primary')), top.join());
      const tabs = await panel.$$eval(`${det} .ctabs [role="tab"]`, (b) => b.map((x) => `${x.textContent}:${x.getAttribute('aria-selected')}`));
      check('I5 four tabs, Performance selected', tabs.join() === 'Performance:true,Carbon:false,Looks:false,Setups:false', tabs.join());
      const visiblePanels = () => panel.$$eval(`${det} .cpanel`, (p) => p.filter((x) => !x.hidden).map((x) => x.dataset.tab).join());
      await panel.focus(`${det} .ctabs [data-tab="perf"]`);
      await panel.keyboard.press('ArrowRight');
      const afterKey = await panel.evaluate(() => document.activeElement?.dataset.tab);
      check('I5 Right arrow moves to Carbon and focuses it, one panel shown', afterKey === 'carbon' && await visiblePanels() === 'carbon', `${afterKey} ${await visiblePanels()}`);
      await panel.keyboard.press('ArrowLeft');
      await panel.keyboard.press('ArrowLeft');
      check('I5 Left arrow wraps from Performance to Setups', await panel.evaluate(() => document.activeElement?.dataset.tab) === 'setups' && await visiblePanels() === 'setups');
      for (const t of ['perf', 'carbon', 'looks', 'setups']) {
        await panel.click(`${det} .ctabs [data-tab="${t}"]`);
        if (t === 'looks') await panel.waitForSelector(`${det} .looks-tabs button`, { timeout: 15000 });
        await shots(`car-${t}`, async () => { await panel.$eval(det, (n) => n.scrollIntoView({ block: 'start' })); await panel.evaluate(() => scrollBy(0, -60)); });
      }
      // The tab is remembered across the re-render an edit causes.
      await panel.click(`${det} .ctabs [data-tab="carbon"]`);
      const car0 = sum.cars[0];
      const b0 = await readOpfs();
      await clickAndWait(`${det} button:has-text("All carbon")`);
      check('I5 the open tab survives the re-render after an edit', await panel.getAttribute(`${det} .ctabs [data-tab="carbon"]`, 'aria-selected') === 'true' && await visiblePanels() === 'carbon');
      // I16: part names in words, a carbon part tagged in words.
      await panel.click(`${det} .ctabs [data-tab="looks"]`);
      await panel.waitForSelector(`${det} .looks-tabs button`, { timeout: 15000 });
      const looks = await panel.evaluate((det) => {
        const d = document.querySelector(det), out = { caps: [], tagged: 0, carbonSel: 0 };
        for (const t of d.querySelectorAll('.looks-tabs button')) {
          t.click();
          for (const s of d.querySelectorAll('.looks-rows select')) {
            const txt = s.selectedOptions[0]?.textContent ?? '';
            if (/CARBON FIBRE|\b[A-Z]{6,}\b/.test(txt)) out.caps.push(txt);
            if (/· carbon$/.test(txt)) out.carbonSel++;
          }
          out.tagged += d.querySelectorAll('.looks-rows .ctag').length;
        }
        d.querySelector('.looks-tabs button').click();
        return out;
      }, det);
      check('I16 Looks names parts in words (no shouted part codes), and every carbon part chosen carries the carbon tag', looks.caps.length === 0 && looks.carbonSel > 0 && looks.tagged === looks.carbonSel, JSON.stringify({ ...looks, caps: looks.caps.slice(0, 3) }));
      await clickAndWait('#toastUndo').catch(async () => clickAndWait('#history li:first-child button'));
      check(`${car0.name}: Undo after All carbon restores the bytes`, same(await readOpfs(), b0));
      await panel.click(`${det} summary`);
    }

    // ---- I11: Missing only, and the compact player while the full one is scrolled away.
    {
      const found = music.EA_TRAX.map((_, i) => (i % 3 === 0 ? { path: `Music/${i}.mp3` } : null));
      await panel.evaluate((v) => chrome.storage.local.set({ musicScan: v }), { folder: 'Music', when: Date.now(), files: 9, scanned: 9, zips: 0, found, rows: [] });
      await panel.evaluate(() => location.reload());
      await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
      await panel.waitForFunction(() => /audio files/.test(document.getElementById('musicState').textContent), null, { timeout: 8000 });
      await panel.waitForFunction(() => document.getElementById('musicPlayerNote').textContent.startsWith('Player: Spotivibly'), null, { timeout: 15000 });
      const visSongs = () => panel.$$eval('#musicList .song', (l) => l.filter((x) => getComputedStyle(x).display !== 'none').length);
      check('I11 Missing only shows once a folder check exists, with All pressed', await shown('#musicFilter') && await panel.getAttribute('#musicAll', 'aria-pressed') === 'true' && await visSongs() === music.EA_TRAX.length);
      await panel.click('#musicMissing');
      const want = found.filter((f) => !f).length;
      check('I11 Missing only hides the songs in the folder', await visSongs() === want && await panel.getAttribute('#musicMissing', 'aria-pressed') === 'true' && !(await shown('#musicNoneMissing')), `${await visSongs()} of ${want}`);
      await shots('music-missing', async () => { await panel.$eval('#music .songs-head', (n) => n.scrollIntoView({ block: 'start' })); });
      await panel.click('#musicAll');
      check('I11 All shows every song again', await visSongs() === music.EA_TRAX.length);

      // Play a song, then scroll the player away: the compact player shows, mirrors it and controls it.
      await panel.click('#musicMissing');
      await panel.$eval('#music .mp', (n) => n.scrollIntoView({ block: 'center' }));
      await panel.click('#musicList .song[data-i="1"] .song-btn');
      await panel.waitForFunction(() => document.querySelector('#musicList .song[data-i="1"]')?.getAttribute('aria-current') === 'true', null, { timeout: 8000 });
      check('I11 the compact player stays hidden while the full player is in view', !(await shown('#musicMini')));
      await panel.evaluate(() => scrollTo(0, 0));
      await panel.waitForFunction(() => !document.getElementById('musicMini').hidden, null, { timeout: 5000 }).catch(() => {});
      const mini = { on: await shown('#musicMini'), title: await panel.textContent('#miniTitle'), artist: await panel.textContent('#miniArtist'), label: await panel.getAttribute('#miniToggle', 'aria-label') };
      check('I11 scrolled away, the compact player shows the song playing with Pause', mini.on && mini.title === music.EA_TRAX[1].title && mini.artist === music.EA_TRAX[1].artist && mini.label === 'Pause', JSON.stringify(mini));
      await shots('music-mini', async () => { await panel.evaluate(() => scrollTo(0, 0)); await panel.waitForTimeout(250); });
      await panel.evaluate(() => scrollTo(0, 0));
      await panel.waitForTimeout(250);
      await panel.click('#miniToggle');
      await panel.waitForFunction(() => document.getElementById('miniToggle').getAttribute('aria-label') === 'Play', null, { timeout: 5000 }).catch(() => {});
      const paused = await panel.getAttribute('#miniToggle', 'aria-label') === 'Play' && await panel.getAttribute('#musicToggle', 'aria-label') === 'Play';
      await panel.click('#miniNext');
      await panel.waitForFunction((t) => document.getElementById('miniTitle').textContent === t, music.EA_TRAX[2].title, { timeout: 5000 }).catch(() => {});
      check('I11 the compact player pauses and skips through the real player', paused && await panel.textContent('#miniTitle') === music.EA_TRAX[2].title, await panel.textContent('#miniTitle'));
      await panel.$eval('#music .mp', (n) => n.scrollIntoView({ block: 'center' }));
      const hid = await panel.waitForFunction(() => document.getElementById('musicMini').hidden, null, { timeout: 5000 }).then(() => true, () => false);
      check('I11 the compact player hides again when the full player is back in view', hid);
      // Every song in the folder: Missing only says so.
      await panel.evaluate((v) => chrome.storage.local.set({ musicScan: v }), { folder: 'Music', when: Date.now(), files: 27, scanned: 27, zips: 0, found: music.EA_TRAX.map((_, i) => ({ path: `Music/${i}.mp3` })), rows: [] });
      await panel.evaluate(() => location.reload());
      await panel.waitForFunction(() => /audio files/.test(document.getElementById('musicState').textContent), null, { timeout: 15000 });
      await panel.click('#musicMissing');
      check('I11 with every song in the folder, Missing only says so', await shown('#musicNoneMissing') && await visSongs() === 0);
      await panel.evaluate(() => chrome.storage.local.remove('musicScan'));
      await panel.evaluate(() => location.reload());
      await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
      check('I11 with no folder check, Missing only is hidden', !(await shown('#musicFilter')));
    }

    // ---- I12: the car edited last is the one that opens at 1400 px.
    if (sum.cars.length > 1) {
      const det2 = '#cars details:nth-of-type(2)';
      await panel.evaluate((sel) => { const d = document.querySelector(sel); if (!d.open) d.querySelector('summary').click(); }, det2);
      await panel.click(`${det2} .ctabs [data-tab="perf"]`);
      await clickAndWait(`${det2} button:has-text("All uniques")`);
      await panel.setViewportSize({ width: 1400, height: 1000 });
      await panel.evaluate(() => location.reload());
      await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
      await panel.waitForSelector('#cars[data-auto-car]', { state: 'attached', timeout: 15000 });
      const open = await panel.$$eval('#cars details.car', (d) => d.map((x) => x.open));
      check('I12 at 1400 px the car edited last opens, not the first', open[1] === true && open.filter(Boolean).length === 1, JSON.stringify(open));
      await panel.evaluate(() => { document.getElementById('toast').hidden = true; scrollTo(0, 0); });
      await panel.screenshot({ path: path.join(outDir, 'auto-car-edited-1400.png'), fullPage: true });
      await panel.setViewportSize({ width: 400, height: 900 });
      await panel.waitForTimeout(150);
    }

    // ---- Read only: money as text (I4), the write cards and their section tab gone.
    await panel.selectOption('#profile', NAME).catch(() => {});
    await site.evaluate(() => { document.body.dataset.phase = 'playing'; });
    await panel.waitForFunction(() => /Read only/.test(document.getElementById('conn').textContent), null, { timeout: 8000 });
    const ro = { read: await shown('#moneyRead'), edit: await shown('#money'), text: await panel.textContent('#moneyRead'), danger: await shown('#dangerCard') };
    check('I4 read only shows money as text, without the edit box or the red card', ro.read && !ro.edit && /^\$[\d,]+$/.test(ro.text) && !ro.danger, JSON.stringify(ro));
    await shots('readonly');
    await site.evaluate(() => { document.body.dataset.phase = 'ready'; });
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 8000 });

    // ---- No career: the guide, and only the tabs whose cards remain.
    await panel.evaluate(() => {
      window.realSend = window.realSend || chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (id, msg, ...rest) => { const r = await window.realSend(id, msg, ...rest); return msg?.type === 'status' && r ? { ...r, profiles: [] } : r; };
    });
    await panel.click('#refresh');
    await panel.waitForFunction(() => /no career profiles/.test(document.getElementById('conn').textContent), null, { timeout: 8000 });
    const npTabs = await panel.$$eval('#jump button', (b) => b.filter((x) => !x.hidden).map((x) => x.dataset.to));
    check('no career: "Start a career", and the section tabs keep only Music', await panel.textContent('#guideTitle') === 'Start a career' && npTabs.join() === 'music', npTabs.join());
    await shots('noprofile');
    await panel.evaluate(() => { chrome.tabs.sendMessage = window.realSend; });

    check('no page errors in the panel', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    check('the run finished', false, err.stack?.split('\n').slice(0, 3).join(' '));
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
