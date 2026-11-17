// Live check of Backup and Restore (B1-B3) in a throwaway headless browser on the real nfsu2.xyz page.
// - Backup downloads nfsu2-saves-<date>_<time>.zip holding every career and GARAGE.DAT, byte for byte as stored.
// - Restore of a zip adds and replaces profiles after a confirmation listing each one, keeps every replaced profile in
//   its History, and "Undo the last restore" puts all of them back (added ones removed) byte for byte.
// - A backup restored later gives back exactly the bytes it was taken from.
// - Corrupt, truncated, wrong-size and magazine-only files are refused with nothing written, and the page refuses a
//   restore while the game runs, while another tab holds the saves, on a stale read, and as a whole when any one
//   profile in it fails.
// - nfsu2.xyz's own Saves > Restore takes our zip, and our Restore takes the site's own Saves backup.
// Usage: node test/live-backup.cjs <playwright dir> <profile folder A> <profile folder B> <out dir> [extension dir]
// The profile folders hold a career file named like the folder plus GARAGE.DAT. Their copies stay in <out dir>.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const [pwDir, dirA, dirB, outDir, extArg] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-backup.cjs <playwright dir> <profile A> <profile B> <out dir> [extension dir]'); process.exit(2); }
const { chromium } = require(pwDir);
const EXT = path.resolve(extArg || process.env.NFSU2_EXT || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const A = path.basename(dirA), B = path.basename(dirB);
const sha = (b) => (b == null ? null : crypto.createHash('sha256').update(Buffer.from(b)).digest('hex'));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const read = (dir, n) => fs.readFileSync(path.join(dir, n));

(async () => {
  const { writeZip, readZip } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'zip.js')).href);
  fs.mkdirSync(outDir, { recursive: true });
  const careerA = read(dirA, A), garageA = read(dirA, 'GARAGE.DAT'), careerB = read(dirB, B), garageB = read(dirB, 'GARAGE.DAT');
  const zipOf = (files) => Buffer.from(writeZip(files.map(([name, data]) => ({ name, data: new Uint8Array(data), mtime: Date.now() }))));
  const put = (name, bytes) => { const p = path.join(outDir, name); fs.writeFileSync(p, bytes); return p; };
  const R = 'NFS Underground 2';
  const fixtureZip = put('fixture-two.zip', zipOf([[`${R}/${A}/${A}`, careerA], [`${R}/${A}/GARAGE.DAT`, garageA], [`${R}/${B}/${B}`, careerB], [`${R}/${B}/GARAGE.DAT`, garageB]]));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-backup-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 }, acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    // Only profile A at first, so a restore of the two-profile zip both replaces (A) and adds (B).
    await site.evaluate(async ([name, c, g]) => {
      const nfs = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true });
      const dir = await nfs.getDirectoryHandle(name, { create: true });
      for (const [n, bytes] of [[name, c], ['GARAGE.DAT', g]]) { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); }
    }, [A, [...careerA], [...garageA]]);
    await site.reload({ waitUntil: 'load' });
    await site.waitForTimeout(2500);
    /** Every profile folder on disk with the sha of each file in it. */
    const disk = () => site.evaluate(async () => {
      const hex = async (f) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer())), (b) => b.toString(16).padStart(2, '0')).join('');
      const out = {};
      let nfs;
      try { nfs = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2'); } catch { return out; }
      for await (const [name, h] of nfs.entries()) {
        if (h.kind !== 'directory') continue;
        out[name] = {};
        for await (const [n, f] of h.entries()) if (f.kind === 'file') out[name][n] = await hex(await f.getFile());
      }
      return out;
    });

    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    const isExt = (w) => w.url().startsWith('chrome-extension://');
    let sw = ctx.serviceWorkers().find(isExt);
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { predicate: isExt, timeout: 15000 });
    const extId = new URL(sw.url()).host;
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    await site.waitForTimeout(1500);
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 400, height: 1000 });
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.evaluate(() => { document.body.dataset.toastMs = '600000'; });
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 20000 });
    // The game tab, fixed now: a second nfsu2.xyz tab opened later must not take its messages.
    const siteTab = await panel.evaluate(async () => (await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' }))[0].id);
    const ask = (msg) => panel.evaluate(([tab, msg]) => chrome.tabs.sendMessage(tab, msg), [siteTab, msg]);
    const hideToast = () => panel.evaluate(() => { document.getElementById('toast').hidden = true; });
    const confirmShown = async () => {
      await panel.waitForFunction(() => !document.getElementById('restoreConfirm').hidden || (!document.getElementById('toast').hidden && document.getElementById('toast').dataset.kind === 'bad'), null, { timeout: 20000 });
      if (await panel.isHidden('#restoreConfirm')) throw new Error(`no confirmation: ${await panel.textContent('#toastText')}`);
    };
    const counter = (k) => panel.evaluate((k) => Number(document.body.dataset[k] || 0), k);
    const waitCounter = async (k, n) => panel.waitForFunction(([k, n]) => Number(document.body.dataset[k] || 0) >= n, [k, n], { timeout: 30000 })
      .catch(async (e) => { throw new Error(`${k} never reached ${n}; the toast says: ${await panel.textContent('#toastText').catch(() => '?')}; money field ${JSON.stringify(await panel.inputValue('#money').catch(() => '?'))} (${e.message.split('\n')[0]})`); });
    const toastText = () => panel.textContent('#toastText');
    const hist = (p) => sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, `hist:save/${p}`);
    const shots = async (name) => {
      for (const w of [400, 1400]) {
        await panel.setViewportSize({ width: w, height: w === 400 ? 1000 : 900 });
        await panel.$eval('#backupCard', (n) => n.scrollIntoView({ block: 'start' }));
        await panel.waitForTimeout(150);
        await panel.screenshot({ path: path.join(outDir, `${name}-${w}.png`) });
      }
      await panel.setViewportSize({ width: 400, height: 1000 });
    };

    // ---- An edit first, so A on disk differs from the fixture.
    let edits = await counter('edits');
    await panel.click('#maxMoney');
    await waitCounter('edits', edits + 1);
    const d0 = await disk();
    const editedA = d0[A];
    check('setup: A was edited (max money) and differs from the fixture', editedA && editedA[A] !== sha(careerA), JSON.stringify(d0));
    await shots('backup-card');

    // ---- B1 Backup.
    const [dl] = await Promise.all([panel.waitForEvent('download', { timeout: 20000 }), panel.click('#backupAll')]);
    const backupPath = path.join(outDir, `ours-${dl.suggestedFilename()}`);
    await dl.saveAs(backupPath);
    check('B1 the backup is named nfsu2-saves-<YYYY-MM-DD>_<HHMMSS>.zip like the site\'s', /^nfsu2-saves-\d{4}-\d{2}-\d{2}_\d{6}\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const backupBytes = fs.readFileSync(backupPath);
    const entries = await readZip(new Uint8Array(backupBytes));
    const names = entries.map((e) => e.name).sort();
    check('B1 it holds every career and GARAGE.DAT under "NFS Underground 2/<profile>/"', JSON.stringify(names) === JSON.stringify([`${R}/${A}/${A}`, `${R}/${A}/GARAGE.DAT`].sort()), JSON.stringify(names));
    const ent = (n) => entries.find((e) => e.name === n)?.data;
    check('B1 each file is byte for byte what is on disk', sha(ent(`${R}/${A}/${A}`)) === editedA[A] && sha(ent(`${R}/${A}/GARAGE.DAT`)) === editedA['GARAGE.DAT']);
    check('B1 the toast names the file', (await toastText()).includes(dl.suggestedFilename()), await toastText());

    // ---- B2 Restore: replace A, add B.
    const histA0 = (await hist(A))?.entries.length ?? 0;
    await panel.setInputFiles('#restoreFile', fixtureZip);
    await confirmShown();
    const confirmText = await panel.textContent('#restoreConfirmText');
    const rows = await panel.$$eval('#restoreDiff li', (ls) => ls.map((l) => l.textContent));
    check('B2 the confirmation says it adds 1 and replaces 1', /adds 1 profile and replaces 1 profile/.test(confirmText), confirmText);
    check('B2 it lists A as replaced with what changes, and B as added', rows.some((r) => r.startsWith(A) && /Replaced/.test(r)) && rows.some((r) => r.startsWith('Money')) && rows.some((r) => r.startsWith(B) && /Added as a new profile/.test(r)), JSON.stringify(rows));
    check('B2 nothing is written before Restore is pressed', JSON.stringify(await disk()) === JSON.stringify(d0));
    await shots('restore-confirm');
    let restores = await counter('restores');
    await panel.click('#restoreYes');
    await waitCounter('restores', restores + 1);
    const d1 = await disk();
    check('B2 A now holds the backup\'s bytes', d1[A]?.[A] === sha(careerA) && d1[A]?.['GARAGE.DAT'] === sha(garageA), JSON.stringify(d1[A]));
    check('B2 B was added with the backup\'s bytes', d1[B]?.[B] === sha(careerB) && d1[B]?.['GARAGE.DAT'] === sha(garageB), JSON.stringify(d1[B]));
    const opts = await panel.$$eval('#profile option', (os) => os.map((o) => o.value));
    check('B2 the Profile list shows both', opts.includes(A) && opts.includes(B), JSON.stringify(opts));
    const hA = await hist(A);
    check('B2 A\'s state before the restore is in its History', hA?.entries.length === histA0 + 1 && /^Restore from fixture-two\.zip$/.test(hA.entries.at(-1).label), JSON.stringify(hA?.entries.map((e) => e.label)));
    check('B2 the toast offers Undo and Reload', !(await panel.isHidden('#toastUndo')) && !(await panel.isHidden('#reload')), await toastText());
    check('B2 "Undo the last restore" is shown', !(await panel.isHidden('#undoRestore')));
    await shots('restore-done');

    // ---- B3 Undo of the whole restore: A back to the edited bytes, B removed.
    restores = await counter('restores');
    await panel.click('#undoRestore');
    await waitCounter('restores', restores + 1);
    const d2 = await disk();
    check('B3 one Undo puts A back byte for byte', JSON.stringify(d2[A]) === JSON.stringify(editedA), JSON.stringify(d2[A]));
    check('B3 and removes the added B, folder included', !(B in d2), JSON.stringify(Object.keys(d2)));
    check('B3 the undo button goes once used', await panel.isHidden('#undoRestore'));

    // ---- Round trip: restore the fixture again, then our earlier backup: A is exactly what the backup was taken from.
    for (const f of [fixtureZip, backupPath]) {
      await panel.setInputFiles('#restoreFile', f);
      await confirmShown();
      restores = await counter('restores');
      await panel.click('#restoreYes');
      await waitCounter('restores', restores + 1);
    }
    const d3 = await disk();
    check('B3 backup then restore is byte for byte (career and GARAGE.DAT)', JSON.stringify(d3[A]) === JSON.stringify(editedA), JSON.stringify(d3[A]));
    check('B3 a restore leaves profiles that are not in the zip alone', d3[B]?.[B] === sha(careerB));

    // ---- Refusals in the panel: each leaves every file as it was and opens no confirmation.
    const refused = async (label, file, why) => {
      const before = JSON.stringify(await disk());
      await hideToast();
      await panel.setInputFiles('#restoreFile', file);
      await panel.waitForFunction(() => !document.getElementById('toast').hidden && document.getElementById('toast').dataset.kind === 'bad', null, { timeout: 15000 });
      const t = await toastText();
      check(`B3 ${label} is refused with nothing written`, why.test(t) && await panel.isHidden('#restoreConfirm') && JSON.stringify(await disk()) === before, t);
    };
    await refused('a file that is not a zip', put('not-a-zip.zip', crypto.randomBytes(5000)), /cannot be restored/);
    await refused('a truncated zip', put('truncated.zip', backupBytes.subarray(0, Math.floor(backupBytes.length / 2))), /cannot be restored/);
    await refused('a career of the wrong size', put('wrong-size.zip', zipOf([[`${R}/${A}/${A}`, Buffer.concat([careerA, Buffer.alloc(1)])]])), /bytes, but a career save is 54,966 bytes/);
    const mag = Buffer.alloc(196644); mag.write('20CM', 0, 'latin1');
    await refused('a zip with only a magazine folder', put('magazine-only.zip', zipOf([[`${R}/${A} Magazine 7/${A} Magazine 7`, mag]])), /no career/i);
    const damaged = Buffer.from(careerA); damaged[0x100] ^= 0xff;
    await refused('a career whose checksum does not match', put('damaged.zip', zipOf([[`${R}/${A}/${A}`, damaged], [`${R}/${A}/GARAGE.DAT`, garageA]])), /checksums do not match/);

    // A magazine folder beside a real career is left out and named, not restored.
    await hideToast();
    await panel.setInputFiles('#restoreFile', put('with-magazine.zip', zipOf([[`${R}/${B}/${B}`, careerB], [`${R}/${B} Magazine 3/${B} Magazine 3`, mag]])));
    await confirmShown();
    const skipped = await panel.textContent('#restoreSkipped');
    check('B3 a magazine folder in the zip is left out and named', /Magazine 3/.test(skipped) && /magazine cover or DVD replay/.test(skipped), skipped);
    await panel.click('#restoreNo');

    // A single career file, picked on its own, restores that profile and keeps its own GARAGE.DAT.
    const before4 = await disk();
    await panel.setInputFiles('#restoreFile', path.join(dirB, B));
    await confirmShown();
    restores = await counter('restores');
    await panel.click('#restoreYes');
    await waitCounter('restores', restores + 1);
    const d4 = await disk();
    check('B2 a single career file restores that profile and keeps its GARAGE.DAT', d4[B]?.[B] === sha(careerB) && d4[B]?.['GARAGE.DAT'] === before4[B]['GARAGE.DAT'], JSON.stringify(d4[B]));

    // ---- Refusals in the page itself (content.js), whatever the panel sent.
    const cur = await disk();
    const item = (p, career, garage, extra = {}) => ({ profile: p, mode: 'replace', career: career.toString('base64'), garage: garage ? garage.toString('base64') : null, expectCareerSha: cur[p][p], expectGarageSha: cur[p]['GARAGE.DAT'] ?? null, ...extra });
    const newC = { profile: 'ZZNEW', mode: 'add', career: careerB.toString('base64'), garage: null };
    const pageRefuses = async (label, msg, why) => {
      const before = JSON.stringify(await disk());
      const res = await ask({ type: 'restore', saveDir: 'save', ...msg });
      check(`B3 the page refuses ${label}, nothing written`, res?.ok === false && why.test(res.why || '') && JSON.stringify(await disk()) === before, JSON.stringify(res).slice(0, 160));
    };
    await pageRefuses('a stale read', { items: [item(A, careerB, garageB, { expectCareerSha: '0'.repeat(64) })] }, /changed since/);
    await pageRefuses('the whole restore when one profile fails (all or nothing)', { items: [newC, item(A, careerA, garageA, { expectCareerSha: '0'.repeat(64) })] }, /changed since/);
    check('B3 the valid profile of that refused restore was not created', !('ZZNEW' in await disk()));
    await pageRefuses('a career of the wrong size', { items: [item(A, Buffer.concat([careerA, Buffer.alloc(1)]), garageA)] }, /right size/);
    await pageRefuses('adding a profile that exists in another letter case', { items: [{ ...newC, profile: A.toUpperCase() === A ? A.toLowerCase() : A.toUpperCase() }] }, /already exists/);
    await pageRefuses('a name with a slash', { items: [{ ...newC, profile: 'a/b' }] }, /not valid/);
    await pageRefuses('removing a profile that changed', { items: [{ profile: B, mode: 'remove', expectCareerSha: '0'.repeat(64), expectGarageSha: cur[B]['GARAGE.DAT'] ?? null }] }, /changed since/);
    // The game running in the tab.
    await site.evaluate(() => { document.body.dataset.phaseWas = document.body.dataset.phase || ''; document.body.dataset.phase = 'playing'; });
    await pageRefuses('while the game is running', { items: [newC] }, /game is running/);
    await panel.waitForFunction(() => document.getElementById('restoreFile').disabled, null, { timeout: 10000 }).catch(() => {});
    check('B3 the panel turns Restore off while the game runs', await panel.$eval('#restoreFile', (n) => n.disabled));
    await site.evaluate(() => { document.body.dataset.phase = document.body.dataset.phaseWas; });
    // A second nfsu2.xyz tab: the site keeps the saves lock in the first tab for as long as it is open, so the second
    // one waits, and a restore sent to it must be refused.
    const other = await ctx.newPage();
    await other.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    await other.waitForTimeout(2500);
    const otherTab = await panel.evaluate(async (mine) => (await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' })).map((x) => x.id).find((id) => id !== mine), siteTab);
    {
      const before = JSON.stringify(await disk());
      const res = await panel.evaluate(([tab, msg]) => chrome.tabs.sendMessage(tab, msg), [otherTab, { type: 'restore', saveDir: 'save', items: [newC] }]);
      check('B3 a second nfsu2.xyz tab (not the one holding the saves) refuses a restore, nothing written', res?.ok === false && /Another nfsu2\.xyz tab/.test(res.why || '') && JSON.stringify(await disk()) === before, JSON.stringify(res).slice(0, 160));
    }
    await other.close();
    await panel.click('#refresh');
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 20000 });

    // ---- The site's own Saves: Restore takes our zip, and its Backup restores here.
    // Put A to the fixture first, so taking our backup back in is a visible change.
    await panel.setInputFiles('#restoreFile', fixtureZip);
    await confirmShown();
    restores = await counter('restores');
    await panel.click('#restoreYes');
    await waitCounter('restores', restores + 1);
    check('setup: A is the fixture again', (await disk())[A]?.[A] === sha(careerA));
    await site.setInputFiles('#import', backupPath);
    const addBtn = site.getByRole('button', { name: /^(Add profiles?|Restore backup)$/ });
    await addBtn.waitFor({ timeout: 15000 });
    const siteKind = await addBtn.textContent();
    await addBtn.click();
    await site.waitForFunction(() => /Added|Restored/.test(document.getElementById('saves-msg')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    const siteMsg = await site.evaluate(() => document.getElementById('saves-msg')?.textContent || '');
    const d5 = await disk();
    check('B1 nfsu2.xyz\'s own Saves > Restore takes our zip as a profiles import', /Add profile/.test(siteKind) && /Added/.test(siteMsg), `${siteKind} | ${siteMsg}`);
    check('B1 and writes exactly our backup\'s bytes', d5[A]?.[A] === editedA[A] && d5[A]?.['GARAGE.DAT'] === editedA['GARAGE.DAT'], JSON.stringify(d5[A]));

    const [sdl] = await Promise.all([site.waitForEvent('download', { timeout: 20000 }), site.evaluate(() => document.getElementById('export').click())]);
    const sitePath = path.join(outDir, `site-${sdl.suggestedFilename()}`);
    await sdl.saveAs(sitePath);
    const siteEntries = (await readZip(new Uint8Array(fs.readFileSync(sitePath)))).map((e) => e.name);
    check('B2 the site\'s own backup has the same name pattern and layout', /^nfsu2-saves-\d{4}-\d{2}-\d{2}_\d{6}\.zip$/.test(sdl.suggestedFilename()) && siteEntries.includes(`${R}/${A}/${A}`), `${sdl.suggestedFilename()} ${JSON.stringify(siteEntries)}`);
    // Change A here, then take the site's backup back in through our Restore.
    edits = await counter('edits');
    await panel.selectOption('#profile', A);
    // Choosing the profile re-renders it, which rewrites the money field. A fill that lands mid-render appends to the
    // old value, so fill until the field keeps it.
    for (let i = 0; i < 5 && (await panel.inputValue('#money')) !== '12345'; i++) { await panel.fill('#money', '12345'); await panel.waitForTimeout(400); }
    await panel.click('#setMoney');
    await waitCounter('edits', edits + 1);
    await hideToast();
    await panel.setInputFiles('#restoreFile', sitePath);
    await confirmShown();
    const siteSkipped = await panel.textContent('#restoreSkipped');
    restores = await counter('restores');
    await panel.click('#restoreYes');
    await waitCounter('restores', restores + 1);
    const d6 = await disk();
    check('B2 our Restore takes the site\'s backup: A is back to its bytes', JSON.stringify(d6[A] && { c: d6[A][A], g: d6[A]['GARAGE.DAT'] }) === JSON.stringify({ c: d5[A][A], g: d5[A]['GARAGE.DAT'] }), JSON.stringify(d6[A]));
    check('B2 the site settings and root files in it are left out and named', /left out|not restored/i.test(siteSkipped) || siteSkipped === '', siteSkipped);

    const errs = [];
    panel.on('pageerror', (e) => errs.push(String(e)));
    await panel.waitForTimeout(300);
    check('no page errors in the panel', errs.length === 0, errs.join(' | '));
  } catch (err) {
    check('the run finished', false, String(err && err.stack || err).slice(0, 600));
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
