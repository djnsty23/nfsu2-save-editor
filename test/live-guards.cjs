// Live guard test: the panel against a site tab that changes under it. The unpacked extension runs in a throwaway
// headless Chrome profile on https://nfsu2.xyz with a planted test profile, and every check changes the save, the
// tab or the panel's timing behind the panel's back, then checks what the panel shows and what it refuses to write.
// Usage: node test/live-guards.cjs <playwright module dir> <GLOBALB.BUN> <test profile folder> <out dir>
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const [pwDir, bunPath, profDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-guards.cjs <playwright dir> <GLOBALB.BUN> <profile folder> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
// NFSU2_EXT runs the suite against another copy, such as the store build in dist/store.
const EXT = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NAME = path.basename(profDir), NAME2 = 'guardtwo';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileUrl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

(async () => {
  const ops = await import(fileUrl(path.join(EXT, 'src/ops.js')));
  const music = await import(fileUrl(path.join(EXT, 'src/music.js')));
  const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(fs.readFileSync(bunPath))))));
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-guards-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));

    const initial = { career: new Uint8Array(fs.readFileSync(path.join(profDir, NAME))), garage: fs.existsSync(path.join(profDir, 'GARAGE.DAT')) ? new Uint8Array(fs.readFileSync(path.join(profDir, 'GARAGE.DAT'))) : null };
    const cars = ops.summary(initial, db).cars;
    const car0 = cars[0];

    // The swapped save is test data (a car sold and bought in game), made with the build's own Change car.
    const other = ops.carChoices(initial, db).find((c) => c.player && c.available && c.hash !== car0.hash && !cars.some((x) => x.hash === c.hash));
    const swapped = ops.changeCar(initial, car0.index, other.hash, db);

    // ---- U1: no site tab yet. The panel says how to connect and offers Retry; the Music card waits too.
    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 400, height: 1000 });
    const errors = [];
    panel.on('pageerror', (e) => errors.push(String(e)));
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.waitForFunction(() => /Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    const shown = (sel) => panel.$eval(sel, (n) => getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().height > 0);
    check('U1 disconnected: Retry is visible', await shown('#retry'), await panel.textContent('#conn'));
    check('U1 disconnected: the text names Retry, not a hidden Refresh', /click Retry/.test(await panel.textContent('#conn')) && !(await shown('#refresh')));
    check('U11 disconnected: the Music card is hidden', !(await shown('#music')));
    await panel.screenshot({ path: path.join(outDir, 'guards-disconnected.png'), fullPage: true });

    // Open the site with two planted profiles: the test profile and a copy whose first car is another model.
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    const plant = (name, st) => site.evaluate(async ({ name, career, garage }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await (await root.getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true })).getDirectoryHandle(name, { create: true });
      const put = async (n, bytes) => { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); };
      await put(name, career);
      if (garage) await put('GARAGE.DAT', garage); else await dir.removeEntry('GARAGE.DAT').catch(() => {});
    }, { name, career: [...st.career], garage: st.garage ? [...st.garage] : null });
    await plant(NAME, initial);
    await plant(NAME2, swapped);
    const readOpfs = async (name = NAME) => {
      const r = await site.evaluate(async (name) => {
        const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
        const get = async (n) => { try { return [...new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer())]; } catch { return null; } };
        return { career: await get(name), garage: await get('GARAGE.DAT') };
      }, name);
      return { career: new Uint8Array(r.career), garage: r.garage ? new Uint8Array(r.garage) : null };
    };
    const same = (a, b) => sha(a.career) === sha(b.career) && (a.garage ? sha(a.garage) : '') === (b.garage ? sha(b.garage) : '');

    await panel.click('#retry');
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    check('U1 Retry connects once the site is open, and hides itself', !(await shown('#retry')) && await shown('#app'), await panel.textContent('#conn'));
    await panel.selectOption('#profile', NAME);
    // Game data gives the panel the same car names as ops here.
    await panel.setInputFiles('#dbFile', bunPath);
    await panel.waitForFunction(() => /Loaded/.test(document.getElementById('dbState').textContent), null, { timeout: 30000 });
    await panel.waitForFunction((n) => document.querySelector('#cars .car-name')?.textContent === n, car0.name, { timeout: 15000 });

    // ---- U2: no edits yet, so Restore original is hidden for real (computed style, not just the attribute).
    check('U2 Restore original is not shown before any edit', !(await shown('#restoreOriginal')));

    const toastText = async () => (await panel.textContent('#toastText')) || '';
    const clickAndWait = async (act) => {
      const n = await panel.evaluate(() => Number(document.body.dataset.edits || 0));
      if (typeof act === 'function') await act(); else await panel.click(act);
      await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: 600000 });
      return toastText();
    };
    const carName0 = () => panel.textContent('#cars details:first-of-type .car-name');

    // ---- B1: the first car is swapped in the save behind the panel's back (as selling and buying in game would).
    // A click on the stale row's button must refuse, name both cars, and write nothing.
    await panel.click('#cars details:first-of-type summary');
    await plant(NAME, swapped);
    const msg = await clickAndWait('#cars details:first-of-type button:has-text("Max this car")');
    check('B1 a stale car button refuses when the slot now holds another car, naming both', /now holds the .* not the /.test(msg) && msg.includes(car0.name) && /Nothing was written/.test(msg), msg.slice(0, 140));
    check('B1 the refused click wrote nothing', same(await readOpfs(), swapped));
    check('B1 after the refusal the panel shows the car that is there now', (await carName0()) === other.name, await carName0());
    // A load in the site tab redraws the panel on its own: put the original back and load a page of the site that
    // never sets data-phase (robots.txt), so only the tab's own load event can trigger the redraw. No panel clicks.
    await plant(NAME, initial);
    await site.goto('https://nfsu2.xyz/robots.txt', { waitUntil: 'load' });
    let redrawn = true;
    try { await panel.waitForFunction((n) => document.querySelector('#cars .car-name')?.textContent === n, car0.name, { timeout: 15000 }); } catch { redrawn = false; }
    check('B1 a load in the site tab redraws the cars without any click', redrawn, await carName0());
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load' });
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });

    // ---- B2: two renders overlap. Reads of the test profile answer 1.5 s late, the copy at once: selecting the test
    // profile and then the copy must end on the copy's cars, not the late answer's.
    await panel.evaluate((slow) => {
      const real = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (id, msg, ...rest) => {
        const r = await real(id, msg, ...rest);
        if (msg?.type === 'read' && msg.profile === slow) { window.slowReads = (window.slowReads || 0) + 1; await new Promise((res) => setTimeout(res, 1500)); }
        return r;
      };
    }, NAME);
    await panel.selectOption('#profile', NAME2);
    await panel.waitForFunction((n) => document.querySelector('#cars .car-name')?.textContent === n, other.name, { timeout: 15000 });
    await panel.selectOption('#profile', NAME);
    await panel.waitForTimeout(100);
    await panel.selectOption('#profile', NAME2);
    await panel.waitForTimeout(2500);
    const sel = await panel.$eval('#profile', (s) => s.value);
    const rows = await panel.$$eval('#cars .car-name', (n) => n.map((x) => x.textContent));
    const want = ops.summary(swapped, db).cars.map((c) => c.name);
    const slow = await panel.evaluate(() => window.slowReads || 0);
    check('B2 overlapping renders end on the selected profile\'s cars, and only those', slow > 0 && sel === NAME2 && rows.join() === want.join(), `${slow} slow reads, ${sel}: ${rows.length} rows, first ${rows[0]}`);
    await panel.evaluate(() => location.reload());
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    await panel.selectOption('#profile', NAME);
    await panel.waitForFunction((n) => document.querySelector('#cars .car-name')?.textContent === n, car0.name, { timeout: 15000 });

    // ---- B17: Play and quit on the site move the status at once; closing the tab shows the disconnected state.
    await site.evaluate(() => { document.body.dataset.phase = 'playing'; });
    let followed = true;
    try { await panel.waitForFunction(() => /Read only: The game is running/.test(document.getElementById('conn').textContent), null, { timeout: 8000 }); } catch { followed = false; }
    check('B17 pressing Play turns the status to read only without a click', followed, await panel.textContent('#conn'));
    await site.evaluate(() => { document.body.dataset.phase = 'ready'; });
    followed = true;
    try { await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 8000 }); } catch { followed = false; }
    check('B17 quitting the game turns it back to safe to edit', followed, await panel.textContent('#conn'));

    // ---- U3: a car at Level 3 with lower parts still flagged, or with the research transmission, reads maxed: the
    // facts line counts it and its row says maxed, never "custom".
    const maxedWant = ops.summary(initial, db).cars.filter((c) => c.maxed).length;
    // I2: the Cars heading counts maxed cars, and each row's first badge reads Best or Maxed for a maxed car.
    const factsMaxed = await panel.textContent('#carsChip');
    const sums = ops.summary(initial, db).cars;
    const firstPill = await panel.$$eval('#cars .car-meta', (n) => n.map((x) => x.querySelector('.pill')?.textContent ?? ''));
    const pillRows = await panel.$$eval('#cars .car-meta', (n) => n.map((x) => [...x.querySelectorAll('.pill')].map((p) => p.textContent)));
    check('U3 the Cars heading counts maxed cars, and maxed rows read Best or Maxed, never Custom mix', maxedWant > 0 && factsMaxed === `${maxedWant} of ${cars.length} maxed` &&
      firstPill.filter((m) => /^(Best|Maxed)$/.test(m)).length === maxedWant && sums.every((c, i) => !c.maxed || /^(Best|Maxed)$/.test(firstPill[i])), `${factsMaxed} | ${firstPill.slice(0, 4).join(',')}`);
    check('I2 every car row has three badges: level, uniques of 9, setups of 5', pillRows.length === sums.length && pillRows.every((p, i) => p.length === 3 &&
      p[1] === `${sums[i].uniques.filter(Boolean).length}/9 uniques` && p[2] === `${sums[i].tuned.filter(Boolean).length}/5 setups`), JSON.stringify(pillRows[0]));
    const labels = await panel.$$eval('#cars details:first-of-type .perf-rows select', (n) => n.map((s) => s.selectedOptions[0]?.textContent));
    check('U3 every category of a maxed car names a level, not Custom mix', !ops.summary(initial, db).cars[0].maxed || !labels.includes('Custom mix'), labels.join(','));

    // ---- Write safety. Helpers: wait for the next finished edit with a short timeout, read the history, run code in
    // the content script's own world (chrome.scripting shares the isolated world of this extension's content script).
    const edits = () => panel.evaluate(() => Number(document.body.dataset.edits || 0));
    const nextEdit = async (n, ms = 30000) => { try { await panel.waitForFunction((n) => Number(document.body.dataset.edits || 0) > n, n, { timeout: ms }); return true; } catch { return false; } };
    const history = () => panel.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? { original: null, entries: [] }, `hist:save/${NAME}`);
    // Refresh, then wait until the profile and History are drawn from what is on disk now, so a field filled next
    // is not overwritten by a redraw still under way.
    const reconnect = async () => {
      await panel.click('#refresh');
      await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
      const money = String(ops.summary(await readOpfs(), db).money);
      await panel.waitForFunction((m) => document.getElementById('money').value === m, money, { timeout: 15000 });
      const n = (await history()).entries.length;
      await panel.waitForFunction((n) => document.querySelectorAll('#history li:not(.empty)').length === n, n, { timeout: 15000 });
    };
    const unpatch = () => panel.evaluate(() => { if (window.realSend) chrome.tabs.sendMessage = window.realSend; if (window.realSet) chrome.storage.local.set = window.realSet; if (window.realGet) chrome.storage.local.get = window.realGet; });
    // Each edit redraws the panel when it ends; wait for that redraw to show the new money before the next fill.
    const setMoney = async (v) => {
      await panel.fill('#money', String(v));
      const t = await clickAndWait('#setMoney');
      const money = String(ops.summary(await readOpfs(), db).money);
      await panel.waitForFunction((m) => document.getElementById('money').value === m, money, { timeout: 15000 }).catch(() => {});
      return t;
    };
    const flip = (bytes, at) => { const out = bytes.slice(); out[at] ^= 0xff; return out; };

    // B14: a profile folder with a 32-character name is not listed, as every read of it would fail.
    const longName = 'x'.repeat(32);
    await plant(longName, initial);
    await reconnect();
    const listed = await panel.$$eval('#profile option', (o) => o.map((x) => x.value));
    check('B14 a 32-character profile name is not listed', listed.includes(NAME) && !listed.includes(longName), listed.join(','));

    // B3: GARAGE.DAT changes between the panel's read and its write (the game saved a garage meanwhile). The write
    // must be refused and leave the new garage alone, and History must not list it.
    await plant(NAME, initial);
    await reconnect();
    const changedGarage = flip(initial.garage, 40);
    await panel.evaluate(({ garage }) => {
      window.realSend = window.realSend || chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (id, msg, ...rest) => {
        if (msg?.type === 'write' && !window.garageMoved) {
          window.garageMoved = true;
          await chrome.scripting.executeScript({ target: { tabId: id }, args: [msg.profile, garage], func: async (name, bytes) => {
            const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(name);
            const w = await (await dir.getFileHandle('GARAGE.DAT')).createWritable(); await w.write(new Uint8Array(bytes)); await w.close();
          } });
        }
        return window.realSend(id, msg, ...rest);
      };
    }, { garage: [...changedGarage] });
    const histB3 = (await history()).entries.length;
    const b3 = await setMoney(4321);
    await unpatch();
    const afterB3 = await readOpfs();
    check('B3 a GARAGE.DAT changed between read and write refuses the write', /changed since it was read/.test(b3) && sha(afterB3.career) === sha(initial.career) && sha(afterB3.garage) === sha(changedGarage), b3.slice(0, 120));
    check('B3 the refused write leaves no History entry', (await history()).entries.length === histB3);

    // B8: the page takes a write and its answer is lost. The write landed, so its Undo entry must stay; it used to be
    // sent again, refused, and the entry of a real write deleted.
    await plant(NAME, initial);
    await reconnect();
    await panel.evaluate(() => {
      window.realSend = window.realSend || chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (id, msg, ...rest) => { const r = await window.realSend(id, msg, ...rest); return msg?.type === 'write' ? undefined : r; };
    });
    const b8 = await setMoney(5555);
    await unpatch();
    const h8 = await history();
    check('B8 a write whose answer is lost keeps its Undo entry, and says the save may have changed', h8.entries.at(-1)?.label === 'Money set to $5,555' && /may have changed/.test(b8) &&
      ops.summary(await readOpfs(), db).money === 5555, `${h8.entries.at(-1)?.label} | ${b8.slice(0, 100)}`);
    await reconnect();

    // B15: the write never reached the page and its History entry cannot be removed: the message says so.
    await panel.evaluate(() => {
      window.realSend = window.realSend || chrome.tabs.sendMessage.bind(chrome.tabs);
      window.realSet = window.realSet || chrome.storage.local.set.bind(chrome.storage.local);
      chrome.tabs.sendMessage = async (id, msg, ...rest) => {
        if (msg?.type === 'write') { window.failSets = true; throw new Error('Could not establish connection. Receiving end does not exist.'); }
        return window.realSend(id, msg, ...rest);
      };
      chrome.storage.local.set = async (v) => { if (window.failSets) throw new Error('disk full'); return window.realSet(v); };
    });
    const b15 = await setMoney(6666);
    await panel.evaluate(() => { window.failSets = false; });
    await unpatch();
    check('B15 a History entry that cannot be removed is reported', /could not be removed \(disk full\)/.test(b15), b15.slice(0, 160));
    await reconnect();

    // B16: the redraw after a write fails. The failure shows in the message instead of escaping as an uncaught error.
    const errs16 = errors.length;
    await panel.evaluate(() => {
      window.realSend = window.realSend || chrome.tabs.sendMessage.bind(chrome.tabs);
      window.realGet = window.realGet || chrome.storage.local.get.bind(chrome.storage.local);
      chrome.tabs.sendMessage = async (id, msg, ...rest) => { const r = await window.realSend(id, msg, ...rest); if (msg?.type === 'write') window.failGets = true; return r; };
      chrome.storage.local.get = async (k) => { if (window.failGets) throw new Error('storage gone'); return window.realGet(k); };
    });
    const n16 = await edits();
    await panel.fill('#money', '7777');
    await panel.click('#setMoney');
    const settled = await nextEdit(n16);
    await panel.evaluate(() => { window.failGets = false; });
    await unpatch();
    const t16 = await toastText();
    check('B16 a failed redraw after a write is reported, not thrown', settled && /could not redraw after the edit \(storage gone\)/.test(t16) && errors.length === errs16, `${settled} | ${t16.slice(0, 120)} | ${errors.slice(errs16).join(' ')}`);
    await reconnect();

    // B4 and B5: no GARAGE.DAT yet, two edits, then the game writes a GARAGE.DAT. Undo of the older edit must ask
    // first, naming the later edit, the game progress and the garage file, and write nothing until confirmed.
    const bare = { career: initial.career, garage: null };
    await plant(NAME, bare);
    await reconnect();
    await setMoney(1111);
    await setMoney(2222);
    const afterTwo = await readOpfs();
    const gameGarage = { career: afterTwo.career, garage: initial.garage };
    await plant(NAME, gameGarage);
    await reconnect();
    await panel.click('#history li:nth-child(2) button');
    let asked = true;
    try { await panel.waitForFunction(() => !document.getElementById('undoConfirm').hidden, null, { timeout: 8000 }); } catch { asked = false; }
    const ask = asked ? await panel.textContent('#undoConfirmText') : '';
    check('B4 Undo of an older entry asks first and names the later edit and the game progress', asked && /"Money set to \$2,222"/.test(ask) && /in game/.test(ask) && same(await readOpfs(), gameGarage), ask.slice(0, 200));
    check('B5 the question says GARAGE.DAT is deleted', /GARAGE\.DAT is deleted/.test(ask));
    // The save changes after the question: the confirmed Undo refuses.
    const moved = { career: ops.setMoney(gameGarage, 3333).career, garage: initial.garage };
    await plant(NAME, moved);
    const stale = await clickAndWait('#undoConfirmYes');
    check('B4 a save that changed after the question refuses the Undo', /changed since you confirmed/.test(stale) && same(await readOpfs(), moved), stale.slice(0, 120));
    await reconnect();
    await panel.click('#history li:nth-child(2) button');
    await panel.waitForFunction(() => !document.getElementById('undoConfirm').hidden, null, { timeout: 8000 });
    const done = await clickAndWait('#undoConfirmYes');
    const afterUndo = await readOpfs();
    check('B5 the confirmed Undo puts back the career and deletes the newer GARAGE.DAT', sha(afterUndo.career) === sha(initial.career) && afterUndo.garage === null, `${done.slice(0, 80)} | garage ${afterUndo.garage ? afterUndo.garage.length : 'none'}`);
    // The newest entry is that Undo, and nothing changed since: undoing it runs at once and brings back `moved`.
    const n4 = await edits();
    await panel.click('#history li:nth-child(1) button');
    const directRan = await nextEdit(n4, 15000);
    check('B4 Undo of the newest entry with nothing since runs at once, without asking', directRan && (await panel.$eval('#undoConfirm', (n) => n.hidden)) && same(await readOpfs(), moved), (await toastText()).slice(0, 100));

    // B6: a damaged history entry and damaged bytes sent straight to the page are both refused.
    await panel.evaluate(async (k) => { const h = (await chrome.storage.local.get(k))[k]; h.entries.at(-1).career = btoa('short'); await chrome.storage.local.set({ [k]: h }); }, `hist:save/${NAME}`);
    await reconnect();
    const beforeB6 = await readOpfs();
    await panel.click('#history li:nth-child(1) button');
    await panel.waitForTimeout(1500);
    const t6 = await toastText();
    check('B6 Undo of a damaged history entry is refused before any write', /history entry is damaged/.test(t6) && same(await readOpfs(), beforeB6), t6.slice(0, 120));
    // Both shas match the disk, so only the size check can refuse it.
    const direct6 = await panel.evaluate(async ({ name, cur, garage }) => {
      const tab = (await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' }))[0].id;
      const hex = async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))), (x) => x.toString(16).padStart(2, '0')).join('');
      const short = btoa(String.fromCharCode(...new Uint8Array(cur.slice(0, 1000))));
      return chrome.tabs.sendMessage(tab, { type: 'write', saveDir: 'save', profile: name, expectCareerSha: await hex(cur), expectGarageSha: garage ? await hex(garage) : null, career: short, garage: null });
    }, { name: NAME, cur: [...beforeB6.career], garage: beforeB6.garage ? [...beforeB6.garage] : null });
    check('B6 the page refuses a career of the wrong size sent to it directly', direct6?.ok === false && /right size/.test(direct6?.why || '') && same(await readOpfs(), beforeB6), direct6?.why);

    // B9: another holder of the saves lock while this tab's own lock id cannot be read: refuse, do not assume.
    await site.evaluate(() => { navigator.locks.request('nfsu2-saves:save', () => new Promise(() => {})); });
    await panel.evaluate(async () => {
      const tab = (await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' }))[0].id;
      await chrome.scripting.executeScript({ target: { tabId: tab }, func: () => {
        const q = navigator.locks.query.bind(navigator.locks);
        navigator.locks.query = async () => { const r = await q(); r.held = r.held.map((l) => (l.name.startsWith('nfsu2-ext-self-') ? { ...l, clientId: undefined } : l)); return r; };
      } });
    });
    await panel.click('#refresh');
    await panel.waitForTimeout(1500);
    const c9 = await panel.textContent('#conn');
    check('B9 an unreadable lock id makes the panel read only instead of skipping the check', /cannot tell which nfsu2\.xyz tab owns the saves/.test(c9), c9);
    await site.reload({ waitUntil: 'load' });
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });

    // B12: a long write renews its lease while it runs. The renewal runs every 200 ms here and the write is held for
    // 1.5 s, so the lease's timestamp must move on while it waits. reconnect() first: the reload above leaves a redraw
    // under way that would put the old money back into the field after the fill.
    await reconnect();
    await panel.evaluate(() => {
      document.body.dataset.leaseRenewMs = '200';
      window.realSend = window.realSend || chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (id, msg, ...rest) => {
        if (msg?.type === 'write') {
          const read = async () => Object.values((await chrome.storage.session.get('writeLeases')).writeLeases || {});
          const first = await read();
          await new Promise((r) => setTimeout(r, 1500));
          window.leaseSeen = { first, later: await read() };
        }
        return window.realSend(id, msg, ...rest);
      };
    });
    const t12 = await setMoney(8888);
    await unpatch();
    const seen = await panel.evaluate(() => { delete document.body.dataset.leaseRenewMs; return window.leaseSeen; });
    const left = await panel.evaluate(async () => Object.keys((await chrome.storage.session.get('writeLeases')).writeLeases || {}).length);
    // The store build strips the write lease (it only holds a dev self-update back; writeBegin is on its BANNED list), so there it must never appear.
    const leaseShipped = await panel.evaluate(async () => (await (await fetch(chrome.runtime.getURL('panel/panel.js'))).text()).includes('writeBegin'));
    if (leaseShipped) check('B12 a long write renews its lease while it runs, and ends it after', seen?.first.length === 1 && seen.later.length === 1 && seen.later[0] >= seen.first[0] + 1000 && left === 0, `${JSON.stringify(seen)} left ${left} | ${t12.slice(0, 80)}`);
    else check('B12 (store build) no write lease is ever taken, and the write still saves', seen?.first.length === 0 && seen.later.length === 0 && left === 0 && /saved/.test(t12), `${JSON.stringify(seen)} left ${left} | ${t12.slice(0, 80)}`);

    // ---- MORE: checks of later groups go here, before the tab closes.

    // ---- U4-U12: the panel's look and states. Transitions off, so computed styles read their end values.
    await panel.emulateMedia({ reducedMotion: 'reduce' });
    await reconnect();

    // U4: an arrow on every car row, turned when the row is open.
    const arrow = await panel.evaluate(() => {
      const s = document.querySelector('#cars details.car > summary'), d = s.parentElement, was = d.open;
      const read = () => { const cs = getComputedStyle(s, '::before'); return { content: cs.content, w: parseFloat(cs.width) || 0, t: cs.transform }; };
      d.open = false; const closed = read(); d.open = true; const opened = read(); d.open = was;
      return { closed, opened };
    });
    check('U4 car rows show an arrow that turns when the row opens', arrow.closed.content !== 'none' && arrow.closed.w > 0 && arrow.closed.t !== arrow.opened.t, JSON.stringify(arrow));

    // U10: at 400 px every car row is the same height, and the name and the details each stay on one line, whole.
    const rowsU10 = await panel.$$eval('#cars details.car > summary', (ss) => ss.map((s) => {
      const one = (e) => e.getBoundingClientRect().height <= (parseFloat(getComputedStyle(e).lineHeight) || 19) * 1.3 && e.scrollWidth <= e.clientWidth;
      return { h: Math.round(s.getBoundingClientRect().height), one: one(s.querySelector('.car-name')) && one(s.querySelector('.car-meta')) };
    }));
    check('U10 at 400 px car rows are even, name and details on one line each, nothing cut off', rowsU10.length > 1 && rowsU10.every((r) => r.h === rowsU10[0].h && r.one), JSON.stringify(rowsU10.slice(0, 4)));

    // Open the first car with its Looks and Change car, so their controls are on screen for U6, U8 and U9.
    await panel.evaluate(() => { const d = document.querySelector('#cars details.car'); d.open = true; d.querySelector('.ctabs button[data-tab="looks"]').click(); });
    await panel.waitForSelector('#cars details.car .looks-rows select', { timeout: 15000 });
    await panel.click('#cars details:first-of-type .swap-toggle');
    await panel.evaluate(() => { const l = document.getElementById('storyLocks'); if (!l.hidden) l.open = true; });

    // U8: a tuned setup says "tuned" in words, with no underline.
    const tunedU8 = await panel.$$eval('#cars details:first-of-type .presets .btn.tuned', (bs) => bs.map((b) => ({
      tag: b.querySelector('.tag')?.textContent ?? '', line: getComputedStyle(b.querySelector('span')).textDecorationLine,
    })));
    check('U8 tuned setups are marked "tuned" in words, not underlined', tunedU8.length > 0 && tunedU8.every((t) => t.tag === 'tuned' && t.line === 'none'), JSON.stringify(tunedU8));

    // U9: in every Looks group at 400 px, the chosen part fits its dropdown, and the tooltip names it in full.
    const cutU9 = await panel.evaluate(async () => {
      const d = document.querySelector('#cars details.car'), c = document.createElement('canvas').getContext('2d'), out = [];
      let n = 0;
      for (const t of [...d.querySelectorAll('.looks-tabs button')]) {
        t.click();
        await new Promise((r) => setTimeout(r, 30));
        for (const s of d.querySelectorAll('.looks-rows select')) {
          n++;
          const cs = getComputedStyle(s), text = s.selectedOptions[0]?.textContent ?? '';
          c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20, need = c.measureText(text).width;
          if (need > room) out.push(`${t.textContent}: ${text} ${Math.round(need)}>${Math.round(room)}`);
          if (!('locked' in s.dataset) && s.title !== text) out.push(`${t.textContent}: no tooltip for ${text}`);
        }
      }
      d.querySelector('.looks-tabs button').click();
      return { n, out };
    });
    check('U9 every Looks choice fits its dropdown at 400 px, with the full name as tooltip', cutU9.n > 0 && cutU9.out.length === 0, `${cutU9.n} selects; ${cutU9.out.slice(0, 4).join(' | ')}`);

    // U6: every control on screen, the open car included, is at least 44 px each way. A checkbox or radio counts
    // its label, which is what takes the tap.
    const smallU6 = await panel.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const out = [];
      let n = 0;
      for (const e of document.querySelectorAll('button, select, input, summary, a[href], label.btn')) {
        if (e.type === 'hidden') continue;
        const box = e.type === 'checkbox' || e.type === 'radio' || e.type === 'file' ? (e.closest('label') || (e.id && document.querySelector(`label[for="${e.id}"]`)) || e) : e;
        if (!vis(box)) continue;
        n++;
        const r = box.getBoundingClientRect();
        if (Math.min(r.width, r.height) < 43.5) out.push(`${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}.${String(e.className).split(' ')[0]} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return { n, out };
    });
    check('U6 every visible control is at least 44 px each way', smallU6.n > 50 && smallU6.out.length === 0, `${smallU6.n} controls, ${smallU6.out.length} small: ${smallU6.out.slice(0, 6).join(', ')}`);
    await panel.click('#cars details:first-of-type .swap-toggle');

    // U12: the History label of the money button carries the dollar sign.
    await clickAndWait('#maxMoney');
    const h12 = (await history()).entries.at(-1)?.label;
    check('U12 the money button\'s History label reads "Money set to $9,999,999"', h12 === `Money set to $${ops.MAX_BUTTON_MONEY.toLocaleString('en-US')}`, h12);

    // U5: a success toast goes by itself and is not styled as an error; a failure stays until dismissed; a pointer on
    // a success toast holds it. Times shortened through data-toast-ms (a saved toast with Reload doubles it).
    const colour = (v) => panel.evaluate((v) => { const e = document.createElement('i'); e.style.color = `var(${v})`; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; }, v);
    const [okC, badC, accentC] = [await colour('--ok'), await colour('--bad'), await colour('--accent')];
    await panel.evaluate(() => { document.body.dataset.toastMs = '1500'; });
    await setMoney(7777);
    const okEdge = await panel.$eval('#toast', (t) => getComputedStyle(t).borderLeftColor);
    const okRole = await panel.$eval('#toast', (t) => t.getAttribute('role'));
    await panel.waitForTimeout(4500);
    const okGone = await panel.isHidden('#toast');
    await setMoney(7778);
    await panel.hover('#toast');
    await panel.waitForTimeout(4500);
    const held = await panel.isVisible('#toast');
    await panel.mouse.move(1, 1);
    await panel.waitForTimeout(4500);
    const heldGone = await panel.isHidden('#toast');
    await panel.fill('#money', '-5');
    await panel.click('#setMoney');
    const badEdge = await panel.$eval('#toast', (t) => getComputedStyle(t).borderLeftColor);
    await panel.waitForTimeout(4500);
    const badStays = await panel.isVisible('#toast');
    if (await panel.isVisible('#toast')) await panel.click('#dismiss');
    await panel.evaluate(() => { delete document.body.dataset.toastMs; });
    check('U5 a success toast goes by itself, held while the pointer is on it, with a green edge, not the error colour', okGone && held && heldGone && okEdge === okC && okEdge !== accentC && okRole === 'status', `${okGone} ${held} ${heldGone} ${okEdge} ok ${okC} accent ${accentC} ${okRole}`);
    check('U5 a failure toast stays until dismissed, with a red edge', badStays && badEdge === badC, `${badStays} ${badEdge} bad ${badC}`);

    // U7: read only says why and what to do, and hides the cards that would only show disabled buttons.
    const cardShown = (sel) => panel.$eval(sel, (n) => { const c = n.closest('.needs-write, .needs-profile, section'); return getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0; });
    await site.evaluate(() => { document.body.dataset.phase = 'playing'; });
    await panel.waitForFunction(() => /Read only/.test(document.getElementById('conn').textContent), null, { timeout: 8000 });
    const ro = { guide: await shown('#guide'), title: await panel.textContent('#guideTitle'), text: await panel.textContent('#guideText'), again: await shown('#guideRefresh'),
      money: await cardShown('#money'), oneClick: await cardShown('#unlockAll'), stage: await cardShown('#stage'), cars: await cardShown('#cars'), history: await cardShown('#history') };
    await panel.screenshot({ path: path.join(outDir, 'guards-readonly.png'), fullPage: true });
    check('U7 read only: a card says why and what to do, and the write-only cards are hidden', ro.guide && ro.title === 'Read only' && /game is running/.test(ro.text) && /Reload nfsu2\.xyz/.test(ro.text) && ro.again &&
      !ro.money && !ro.oneClick && !ro.stage && ro.cars && ro.history, JSON.stringify(ro));
    await site.evaluate(() => { document.body.dataset.phase = 'ready'; });
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 8000 });
    check('U7 back to safe to edit: the guide goes and every card returns', !(await shown('#guide')) && await cardShown('#money') && await cardShown('#unlockAll'));
    // No career at all: the status lists no profiles.
    await panel.evaluate(() => {
      window.realSend = window.realSend || chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (id, msg, ...rest) => { const r = await window.realSend(id, msg, ...rest); return msg?.type === 'status' && r ? { ...r, profiles: [] } : r; };
    });
    await panel.click('#refresh');
    await panel.waitForFunction(() => /no career profiles/.test(document.getElementById('conn').textContent), null, { timeout: 8000 });
    const np = { guide: await shown('#guide'), title: await panel.textContent('#guideTitle'), text: await panel.textContent('#guideText'), again: await shown('#guideRefresh'),
      profile: await cardShown('#profile'), money: await cardShown('#money'), cars: await cardShown('#cars'), history: await cardShown('#history'), db: await cardShown('#dbState') };
    await panel.screenshot({ path: path.join(outDir, 'guards-noprofile.png'), fullPage: true });
    check('U7 no career: a card says to create one in game and check again; the empty cards are hidden', np.guide && np.title === 'Start a career' && /create a profile/.test(np.text) && np.again &&
      !np.profile && !np.money && !np.cars && !np.history && np.db, JSON.stringify(np));
    await unpatch();
    await panel.click('#guideRefresh');
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });

    // U11: Forget shows only when a folder check is saved.
    const forgetBefore = await shown('#musicForget');
    const goodScan = { folder: 'Music', when: Date.now(), files: 1, scanned: 1, zips: 0, found: music.EA_TRAX.map(() => null), rows: [] };
    await panel.evaluate((v) => chrome.storage.local.set({ musicScan: v }), goodScan);
    await panel.evaluate(() => location.reload());
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 15000 });
    await panel.waitForFunction(() => /audio files/.test(document.getElementById('musicState').textContent), null, { timeout: 8000 });
    const forgetWith = await shown('#musicForget');
    if (forgetWith) await panel.click('#musicForget');
    const forgetAfter = await shown('#musicForget');
    check('U11 Forget is hidden with nothing saved, shown with a folder check, hidden again after Forget', !forgetBefore && forgetWith && !forgetAfter, `${forgetBefore} ${forgetWith} ${forgetAfter}`);
    await panel.selectOption('#profile', NAME);
    await panel.emulateMedia({ reducedMotion: null });


    const siteId = await panel.evaluate(async () => (await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' }))[0]?.id);
    await site.close();
    followed = true;
    try { await panel.waitForFunction(() => /Not connected/.test(document.getElementById('conn').textContent), null, { timeout: 8000 }); } catch { followed = false; }
    check('B17 closing the site tab shows the disconnected state with Retry', followed && await shown('#retry'), `tab ${siteId}: ${await panel.textContent('#conn')}`);
    check('no errors in the panel console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await ctx.close();
  }
  console.log(`\n${pass}/${pass + fail} pass`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
