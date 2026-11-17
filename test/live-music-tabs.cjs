// Live check of the Music card's soundtrack tabs, by mouse and keyboard, at a phone-wide (400px) and a desktop-wide
// (1400px) panel, in a throwaway headless Chrome profile.
// Spotivibly's player is replaced by a stand-in page that speaks the same postMessage protocol, so the checks do not
// depend on YouTube playing headless. The stand-in sends the NFSU2 list from src/music.js and, for NFSU1, three
// made-up songs ("Test Artist N - Song N"): no tracklist is typed here.
// Two runs: the extension as it is (NFSU1 has its playlist id, so its tab lists that player's songs), and a copy with
// the id emptied, which keeps the "Playlist coming soon" branch covered.
// Usage: node test/live-music-tabs.cjs <playwright module dir> <out dir> [extension dir]
const fs = require('fs'), path = require('path'), os = require('os');
const [pwDir, outDir, extArg] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-music-tabs.cjs <playwright dir> <out dir> [extension dir]'); process.exit(2); }
const { chromium } = require(pwDir);
const EXT = path.resolve(extArg || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const U1_SONGS = [1, 2, 3].map((n) => ({ name: `Song ${n}`, artist: `Test Artist ${n}` }));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const toUrl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:');

/** A stand-in Spotivibly player: answers hello with its tracks, and load with a playing state on that track. */
const stub = (tracks) => `<!doctype html><title>player stub</title><script>
const tracks = ${JSON.stringify(tracks)};
let index = 0;
const say = (m) => parent.postMessage(m, '*');
const state = (status) => say({ type: 'spotivibly:state', version: 1, index, total: tracks.length, status, started: status !== 'idle', time: 0, duration: 200, failed: [], unavailable: false });
addEventListener('message', (e) => {
  const c = e.data;
  if (!c || c.type !== 'spotivibly:command') return;
  if (c.action === 'hello') { say({ type: 'spotivibly:ready', tracks }); state('idle'); }
  if (c.action === 'load') { index = c.index; state('playing'); }
});
</script>`;

/** The extension with the NFSU1 playlist id emptied, as it was before the playlist existed. */
function withoutId() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-u1-'));
  fs.cpSync(EXT, dir, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
  const f = path.join(dir, 'src/music.js');
  const s = fs.readFileSync(f, 'utf8');
  const line = /export const NFSU1_PLAYLIST = '[0-9a-f-]{36}';/;
  if (!line.test(s)) throw new Error('NFSU1_PLAYLIST does not hold a playlist id: the shipped extension must have one');
  fs.writeFileSync(f, s.replace(line, "export const NFSU1_PLAYLIST = '';"));
  return dir;
}

async function run(ext, label) {
  const music = await import(toUrl(path.join(ext, 'src/music.js')));
  const u1 = music.SOUNDTRACKS.find((t) => t.key === 'u1');
  const soon = !u1.embed;
  if (label === 'with-id') check('the shipped extension frames an NFSU1 player', !soon, String(u1.embed));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-tabs-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    const embeds = [];
    await ctx.route('https://spotivibly.com/embed/**', (r) => {
      const u = r.request().url();
      embeds.push(u);
      const tracks = u === music.SPOTIVIBLY_EMBED ? music.EA_TRAX.map((s) => ({ name: s.title, artist: s.artist })) : U1_SONGS;
      return r.fulfill({ status: 200, contentType: 'text/html', body: stub(tracks) });
    });
    await ctx.route('https://spotivibly.com/generate**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>generator stub</title>' }));
    // The Music card shows once the panel reaches a site tab; an empty profile list is enough.
    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: ext });
    const isExt = (w) => w.url().startsWith('chrome-extension://');
    let sw = ctx.serviceWorkers().find(isExt);
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { predicate: isExt, timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    const panel = await ctx.newPage();
    const errors = [];
    panel.on('pageerror', (e) => errors.push(e.message));
    // A third-party player frame can log a permissions-policy warning of its own (compute-pressure). It comes from
    // that frame's script, not ours, so it is noted and not counted. Any other error, or one from our pages, counts.
    panel.on('console', (m) => {
      if (m.type() !== 'error') return;
      const from = m.location()?.url || '';
      if (/^Permissions policy violation/.test(m.text()) && !from.startsWith('chrome-extension://')) { console.log(`note: third-party frame warning ignored: ${m.text()} (${from || 'no url'})`); return; }
      errors.push(m.text());
    });
    const open = async () => {
      await panel.waitForFunction(() => !document.getElementById('music').hidden, null, { timeout: 20000 });
    };
    await site.waitForTimeout(1500);
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await open();

    const vis = (sel) => panel.$eval(sel, (e) => !e.closest('[hidden]') && e.getClientRects().length > 0).catch(() => false);
    const selected = () => panel.$eval('#musicTabs [aria-selected="true"]', (b) => b.dataset.set).catch(() => null);
    const rows = () => panel.$$eval('#musicList .song', (l) => l.length);
    const readyNote = () => panel.waitForFunction(() => document.getElementById('musicPlayerNote').textContent.startsWith('Player: Spotivibly'), null, { timeout: 15000 });
    const playing = (i, n) => {
      return panel.waitForFunction(({ i, n }) => document.getElementById('musicCount').textContent === `${i + 1} of ${n}`
        && document.querySelector(`#musicList .song[data-i="${i}"]`)?.getAttribute('aria-current') === 'true', { i, n }, { timeout: 8000 }).then(() => true, () => false);
    };
    const generate = async () => {
      const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), panel.locator('#musicGenerate').click()]);
      await tab.waitForLoadState('domcontentloaded');
      const url = tab.url();
      await tab.close();
      return url;
    };

    for (const width of [400, 1400]) {
      const at = `${label}, ${width}px:`;
      await panel.setViewportSize({ width, height: 1100 });
      await panel.locator('#music').scrollIntoViewIfNeeded();
      const tabs = await panel.$$eval('#musicTabs [role="tab"]', (l) => l.map((b) => b.textContent));
      check(`${at} the NFSU2 | NFSU1 tabs show above the player, NFSU2 selected`, (await vis('#musicTabs')) && tabs.join('|') === 'NFSU2|NFSU1' && (await selected()) === 'u2', `${tabs.join('|')} ${await selected()}`);
      const tabH = await panel.$eval('#musicTab-u1', (b) => b.getBoundingClientRect().height);
      check(`${at} each tab is at least 36px tall`, tabH >= 36, String(tabH));

      // NFSU2: its own 27 songs, the folder check, and a row click plays that song.
      await readyNote();
      check(`${at} NFSU2 lists its 27 songs and keeps the folder check`, (await rows()) === 27 && (await vis('#musicScan')) && !(await vis('#musicNoFolder')) && !(await vis('#musicSoon')));
      await panel.locator('#musicList .song[data-i="4"] .song-btn').click();
      check(`${at} clicking NFSU2 row 5 plays it`, await playing(4, 27), await panel.$eval('#musicCount', (e) => e.textContent));
      check(`${at} NFSU2 Generate opens the NFSU2 tracklist`, (await generate()) === music.SPOTIVIBLY_GENERATE);

      // NFSU1 by mouse.
      await panel.locator('#musicTab-u1').click();
      check(`${at} clicking NFSU1 selects it`, (await selected()) === 'u1');
      check(`${at} NFSU1 has no folder check, and says why`, !(await vis('#musicScan')) && !(await vis('#musicRadioNote')) && (await vis('#musicNoFolder')));
      const frame = await panel.$eval('#musicPlayer', (f) => f.src);
      if (soon) {
        check(`${at} NFSU1 without a playlist says "Playlist coming soon" in place of the player and song list`,
          (await vis('#musicSoon')) && /Playlist coming soon/.test(await panel.$eval('#musicSoon', (e) => e.textContent))
          && !(await vis('#music .mp')) && !(await vis('#music .songs-head')) && (await rows()) === 0);
        check(`${at} NFSU1 without a playlist frames nothing`, frame === 'about:blank', frame);
        check(`${at} NFSU1 Generate stays enabled and asks Spotivibly for the soundtrack by name`,
          !(await panel.$eval('#musicGenerate', (b) => b.disabled)) && (await generate()) === music.generateFor('Need for Speed Underground', []));
      } else {
        check(`${at} NFSU1 frames its own player`, frame === u1.embed, frame);
        await readyNote();
        check(`${at} NFSU1 lists the player's songs, not the coming-soon note`, (await rows()) === 3 && !(await vis('#musicSoon'))
          && (await panel.$eval('#musicList .song[data-i="1"] .song-t b', (e) => e.textContent)) === 'Song 2');
        await panel.locator('#musicList .song[data-i="1"] .song-btn').click();
        check(`${at} clicking NFSU1 row 2 plays it`, await playing(1, 3), await panel.$eval('#musicCount', (e) => e.textContent));
        const songs = U1_SONGS.map((t) => ({ artist: t.artist, title: t.name }));
        check(`${at} NFSU1 Generate opens the NFSU1 tracklist`, (await generate()) === music.generateFor('Need for Speed Underground', songs));
      }
      check(`${at} Generate is still the only primary button`, (await panel.$$eval('#music .btn.primary', (l) => l.map((b) => b.id))).join() === 'musicGenerate');
      await panel.locator('#music').screenshot({ path: path.join(outDir, `tabs-${label}-u1-${width}.png`) });

      // The pick survives reopening the panel.
      await panel.reload();
      await open();
      await panel.waitForFunction(() => document.querySelector('#musicTabs [aria-selected="true"]')?.dataset.set === 'u1', null, { timeout: 8000 }).catch(() => {});
      check(`${at} NFSU1 is still selected after the panel reopens`, (await selected()) === 'u1');

      // Back to NFSU2 by keyboard: Left arrow on the focused tab.
      await panel.locator('#musicTab-u1').focus();
      await panel.keyboard.press('ArrowLeft');
      check(`${at} Left arrow moves to NFSU2 and focuses it`, (await selected()) === 'u2' && (await panel.evaluate(() => document.activeElement?.id)) === 'musicTab-u2');
      await readyNote();
      check(`${at} back on NFSU2: its player, 27 songs and the folder check return`, (await panel.$eval('#musicPlayer', (f) => f.src)) === music.SPOTIVIBLY_EMBED
        && (await rows()) === 27 && (await vis('#musicScan')) && (await vis('#music .mp')) && !(await vis('#musicSoon')));
      await panel.locator('#music').screenshot({ path: path.join(outDir, `tabs-${label}-u2-${width}.png`) });
    }
    check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    check(`${label}: only Spotivibly embeds were framed`, embeds.every((u) => u === music.SPOTIVIBLY_EMBED || u === u1.embed), embeds.filter((u) => u !== music.SPOTIVIBLY_EMBED).join(' '));
  } finally {
    await ctx.close();
  }
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await run(EXT, 'with-id');
    await run(withoutId(), 'no-id');
  } catch (e) {
    fail++;
    console.log(`FAIL  crashed: ${e.stack || e}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
