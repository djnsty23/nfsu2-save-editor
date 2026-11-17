// Live check of the Music card against the site itself: the same synthesized fixture folder is given to
// nfsu2.xyz's Radio ("Choose folder" in its Music dialog) and to the extension's Music card, in a throwaway
// headless Chrome profile, and the songs each one finds are compared.
// The folder reaches both pages through a stand-in for the folder picker that returns an OPFS copy of it.
// Usage: node test/live-music.cjs <playwright module dir> <out dir>
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const [pwDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-music.cjs <playwright dir> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
const { FIXTURES } = require('./make-music-fixtures.cjs');
// NFSU2_EXT runs the suite against another copy, such as the store build in dist/store.
const EXT = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FOLDER = 'radiotest';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

/** Every file of the fixture folder as [relative path, byte array]. */
function readTree(root) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r); else out.push([r, [...fs.readFileSync(a)]]);
    }
  };
  walk(root, '');
  return out;
}

/** Copy the tree into the page origin's OPFS under FOLDER. */
const plant = (page, tree) => page.evaluate(async ({ folder, tree }) => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(folder, { recursive: true }); } catch {}
  const base = await root.getDirectoryHandle(folder, { create: true });
  for (const [rel, bytes] of tree) {
    const parts = rel.split('/');
    let dir = base;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(new Uint8Array(bytes)); await w.close();
  }
}, { folder: FOLDER, tree });

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-music-live-'));
  execFileSync(process.execPath, [path.join(__dirname, 'make-music-fixtures.cjs'), fixtures], { stdio: 'inherit' });
  const tree = readTree(fixtures);
  const expectCard = FIXTURES.filter(([, , w]) => w.by).map(([, , w]) => w.song).sort((a, b) => a - b);
  const expectSite = FIXTURES.filter(([, , w]) => w.by || w.zip).map(([, , w]) => w.song).sort((a, b) => a - b);

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-music-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  // The folder picker cannot be driven headless: hand back the OPFS copy instead.
  await ctx.addInitScript((folder) => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
  }, FOLDER);
  try {
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));

    // ---- the site's Radio ----
    const site = ctx.pages()[0] || await ctx.newPage();
    const siteLog = [];
    site.on('console', (m) => siteLog.push(m.text()));
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    await plant(site, tree);
    await site.waitForTimeout(2000);
    const opened = await site.evaluate(() => {
      const link = document.querySelector('a[href="#music"]');
      const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-describedby')?.includes('set-music-help'));
      const target = btn || link;
      if (!target) return null;
      target.click();
      return target.outerHTML.slice(0, 120);
    });
    check('site: Music dialog opened', !!opened && await site.locator('#music').evaluate((d) => d.open).catch(() => false), opened ?? 'no opener found');
    const choose = site.locator('#music-body button', { hasText: /^Choose (folder|files)$/ }).first();
    await choose.click({ timeout: 10000 });
    const stateRe = /Game songs: (\d+) of 27/;
    let stateText = '';
    for (let i = 0; i < 40 && !stateRe.test(stateText); i++) {
      await site.waitForTimeout(500);
      stateText = await site.evaluate(() => document.body.innerText);
    }
    await site.screenshot({ path: path.join(outDir, 'site-music.png') });
    const siteCount = Number(stateRe.exec(stateText)?.[1] ?? -1);
    check(`site: Radio finds ${expectSite.length} of 27`, siteCount === expectSite.length, `${siteCount}`);
    const foundLine = siteLog.find((l) => /songs found:/.test(l)) ?? '';
    fs.writeFileSync(path.join(outDir, 'site-console.txt'), siteLog.join('\n'));

    // ---- the extension's Music card ----
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 390, height: 900 });
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    // The toast's own "display: grid" once beat the [hidden] attribute and left an empty bar pinned on screen.
    check('panel: the hidden toast takes no space', await panel.evaluate(() => getComputedStyle(document.getElementById('toast')).display) === 'none');
    await plant(panel, tree);
    await panel.click('#musicScan');
    await panel.waitForFunction(() => /^\d+ of 27 in your folder$/.test(document.getElementById('musicChip').textContent), null, { timeout: 20000 });
    const card = await panel.evaluate(() => ({
      state: document.getElementById('musicState').textContent,
      chip: document.getElementById('musicChip').textContent,
      statuses: [...document.querySelectorAll('#musicList li')].map((li) => li.dataset.st),
      have: [...document.querySelectorAll('#musicList li')].map((li, i) => (li.dataset.have === 'true' ? i : -1)).filter((i) => i >= 0),
      fixes: [...document.querySelectorAll('#musicFixList li')].map((li) => li.textContent),
      zips: document.getElementById('musicZips').hidden ? '' : document.getElementById('musicZips').textContent,
      links: [...document.querySelectorAll('#musicList a')].map((a) => a.href),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    await panel.screenshot({ path: path.join(outDir, 'panel-music.png'), fullPage: true });
    check(`card: finds ${expectCard.join(',')}`, card.have.join() === expectCard.join(), card.have.join());
    check('card: the site found the card\'s songs plus the zipped one, no other', siteCount === card.have.length + 1 && card.zips.includes('1 zip file'), `${siteCount} vs ${card.have.length} + zip`);
    // The site logs "9 of the game's 27 songs found: 1=#11 2=#7 ...": song number (1-based) = file number.
    const siteSongs = [...foundLine.matchAll(/(\d+)=#\d+/g)].map((m) => Number(m[1]) - 1).sort((a, b) => a - b);
    check(`site log: songs ${expectSite.join(',')}`, siteSongs.join() === expectSite.join(), foundLine.slice(0, 200) || 'no log line');
    check('site songs = card songs + the zipped Skindred', siteSongs.filter((i) => i !== 24).join() === card.have.join());
    check('card: five skipped files explained', card.fixes.length === 5, card.fixes.map((f) => f.slice(0, 60)).join(' | '));
    check('card: no per-song links', card.links.length === 0);
    check('card: the chip counts the found songs', card.chip === `${card.have.length} of 27 in your folder`, card.chip);
    check('card: every row shows found, rename or missing, and the found rows are the found songs',
      card.statuses.every((s) => ['found', 'rename', 'missing'].includes(s)) && card.statuses.flatMap((s, i) => (s === 'found' ? [i] : [])).join() === card.have.join(), card.statuses.join());
    check('card: no sideways scroll at 390 px', !card.overflow);
    await panel.click('#musicForget');
    check('card: Forget clears the result', /No folder checked yet/.test(await panel.textContent('#musicState')));
  } finally {
    await ctx.close();
    fs.rmSync(fixtures, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
