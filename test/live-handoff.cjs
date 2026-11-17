// Live check of the music handover: closing the panel mid-song moves the music to a small player window, which
// resumes the same song near the same time; the toolbar popup, the media key path and a reopened panel drive that
// window; closing it stops the music and puts the toolbar button back to opening the panel.
// Runs the unpacked extension in a throwaway headless Chrome profile. The Spotivibly player is a local stand-in that
// logs the commands it gets, so no video is fetched and nfsu2.xyz is never opened.
// Usage: node test/live-handoff.cjs <playwright module dir> <out dir>
const fs = require('fs'), path = require('path'), os = require('os');
const [pwDir, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-handoff.cjs <playwright dir> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
const EXT = path.resolve(process.env.NFSU2_EXT || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const fileUrl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

/** A stand-in player with a clock: one song second per 100 ms while playing. It keeps every command in window.log. */
const stub = (tracks) => `<!doctype html><title>player stub</title><script>
const tracks = ${JSON.stringify(tracks)};
let index = 0, status = 'idle', time = 0;
window.log = [];
const say = (m) => parent.postMessage(m, '*');
const state = () => say({ type: 'spotivibly:state', version: 1, index, total: tracks.length, status, started: status !== 'idle', time, duration: 200, failed: [], unavailable: false });
setInterval(() => { if (status === 'playing') { time = Math.min(200, time + 1); state(); } }, 100);
addEventListener('message', (e) => {
  const c = e.data;
  if (!c || c.type !== 'spotivibly:command') return;
  log.push(c.action + (c.index !== undefined ? ':' + c.index : '') + (c.seconds !== undefined ? '@' + c.seconds : ''));
  if (c.action === 'hello') { say({ type: 'spotivibly:ready', tracks }); state(); }
  if (c.action === 'load') { index = c.index; status = 'playing'; time = 0; state(); }
  if (c.action === 'toggle') { status = status === 'playing' ? 'paused' : 'playing'; state(); }
  if (c.action === 'next') { index = (index + 1) % tracks.length; time = 0; status = 'playing'; state(); }
  if (c.action === 'prev') { index = (index + tracks.length - 1) % tracks.length; time = 0; status = 'playing'; state(); }
  if (c.action === 'seek') { time = c.seconds; state(); }
});
</script>`;

(async () => {
  const music = await import(fileUrl(path.join(EXT, 'src/music.js')));
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-handoff-')), {
    headless: true, executablePath: CHROME, viewport: { width: 400, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  const errors = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_|nfsu2\.xyz/.test(m.text())) errors.push(m.text()); }); };
  try {
    await ctx.route('https://spotivibly.com/embed/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: stub(music.EA_TRAX.map((s) => ({ name: s.title, artist: s.artist }))) }));
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(sw.url()).host, base = `chrome-extension://${id}/panel/`;
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    const now = () => sw.evaluate(() => chrome.storage.session.get(['nowPlaying', 'musicWindow']));
    const popupSetting = () => sw.evaluate(() => chrome.action.getPopup({}));
    const panelOnClick = () => sw.evaluate(() => chrome.sidePanel.getPanelBehavior().then((b) => b.openPanelOnActionClick));
    const until = async (fn, ms = 6000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return v; };

    // 1. Play song 5 in the panel, let it run, then close the panel.
    const panel = await ctx.newPage();
    watch(panel);
    await panel.goto(`${base}panel.html`);
    // Without an nfsu2.xyz tab the editor stays hidden behind its connect screen; the Music card needs no site, so show it.
    await panel.evaluate(() => { const s = document.createElement('style'); s.textContent = '#app[hidden] { display: block !important; }'; document.head.append(s); document.getElementById('music').scrollIntoView(); });
    await panel.waitForFunction(() => !document.querySelector("#musicList .song-btn")?.disabled, null, { timeout: 10000 });
    await panel.click('#musicList li[data-i="4"] .song-btn');
    await panel.waitForTimeout(1500);
    const before = (await now()).nowPlaying;
    check('the panel writes what it plays to session storage', before?.where === 'panel' && before.song === 4 && before.status === 'playing' && before.time > 5, JSON.stringify(before));
    check('the toolbar button still opens the panel while the panel plays', (await popupSetting()) === '' && (await panelOnClick()) === true);

    const winPage = ctx.waitForEvent('page', { timeout: 8000 });
    await panel.close();
    const win = await winPage;
    watch(win);
    await win.waitForLoadState();
    check('closing the panel mid-song opens the player window', win.url() === `${base}player.html`, win.url());
    const handed = await until(async () => { const s = (await now()).nowPlaying; return s?.where === 'window' && s.started ? s : null; });
    check('the window takes over the same song', handed?.song === 4 && handed.title === music.EA_TRAX[4].title, JSON.stringify(handed));
    const frame = () => win.frames().find((f) => f.url().startsWith('https://spotivibly.com/'));
    const log = await until(async () => { const l = await frame()?.evaluate(() => window.log).catch(() => null); return l?.some((c) => c.startsWith('seek@')) ? l : null; });
    const seekAt = Number(log?.find((c) => c.startsWith('seek@'))?.slice(5));
    check('the window resumes near where the panel stopped', seekAt >= before.time - 1 && seekAt <= before.time + 3, `${log?.join(' ')}; panel was at ${before.time}`);
    const box = await win.$eval('.mp-video', (n) => { const r = n.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    check('the video is at least 200 by 200 px, as YouTube asks of an embedded player', box[0] >= 200 && box[1] >= 200, box.join('x'));
    check('the toolbar button shows the popup, not the panel, while the window plays', (await popupSetting()).endsWith('/panel/popup.html') && (await panelOnClick()) === false, await popupSetting());
    await win.screenshot({ path: path.join(outDir, 'player-window.png') });

    // 2. The popup shows the song and drives the window.
    const pop = await ctx.newPage();
    watch(pop);
    await pop.setViewportSize({ width: 300, height: 260 });
    await pop.goto(`${base}popup.html`);
    await pop.waitForFunction(() => !document.getElementById('popPlaying').hidden);
    check('the popup shows the song playing in the window', (await pop.textContent('#popTitle')) === music.EA_TRAX[4].title, await pop.textContent('#popTitle'));
    check('the popup offers Show player', await pop.isVisible('#popShow'));
    await pop.screenshot({ path: path.join(outDir, 'popup.png') });
    await pop.click('#popNext');
    const afterNext = await until(async () => { const s = (await now()).nowPlaying; return s?.song === 5 ? s : null; });
    check('popup Next moves the window to the next song', afterNext?.song === 5, JSON.stringify(afterNext));
    await pop.click('#popToggle');
    const paused = await until(async () => { const s = (await now()).nowPlaying; return s?.status === 'paused' ? s : null; });
    check('popup Play/Pause pauses the window', !!paused);
    await pop.waitForFunction(() => document.getElementById('popToggle').getAttribute('aria-label') === 'Play');
    check('the popup follows to the paused state', true);

    // 3. The media key path: the worker broadcasts the command, the window acts on it.
    await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'music:cmd', action: 'toggle' }));
    check('a media key command from the worker resumes the window', !!(await until(async () => (await now()).nowPlaying?.status === 'playing')));

    // 4. A command from outside the extension's own pages is refused.
    const refused = await pop.evaluate(async () => {
      const { readCommand } = await import('./now-playing.js');
      const me = chrome.runtime.id;
      return [readCommand({ type: 'music:cmd', action: 'next' }, { id: me, url: 'https://nfsu2.xyz/' }),
        readCommand({ type: 'music:cmd', action: 'next' }, { id: 'other', url: location.href }),
        readCommand({ type: 'music:cmd', action: 'eval' }, { id: me, url: location.href }),
        readCommand({ type: 'music:cmd', action: 'seek', seconds: -4 }, { id: me, url: location.href }),
        readCommand({ type: 'music:cmd', action: 'next' }, { id: me, url: location.href })];
    });
    check('commands from the site, another extension or with bad values are refused', refused.slice(0, 4).every((r) => r === null) && refused[4]?.action === 'next', JSON.stringify(refused));
    await pop.close();

    // 5. A reopened panel is a remote for the window, Prev in the dock included, and its own frame stays silent.
    const again = await ctx.newPage();
    watch(again);
    await again.goto(`${base}panel.html`);
    await again.waitForFunction(() => /player window/.test(document.getElementById('musicPlayerNote').textContent), null, { timeout: 8000 });
    check('a reopened panel says the window plays and shows its song', (await again.textContent('#musicTitle')) === music.EA_TRAX[5].title, await again.textContent('#musicTitle'));
    await again.evaluate(() => { const s = document.createElement('style'); s.textContent = '#app[hidden] { display: block !important; }'; document.head.append(s); document.getElementById('musicPlayer').scrollIntoView(); });
    await again.waitForTimeout(300);
    await again.click('#musicNext');
    check('the panel Next drives the window', !!(await until(async () => (await now()).nowPlaying?.song === 6)));
    await again.click('#musicList li[data-i="1"] .song-btn');
    check('a song picked in the panel plays in the window', !!(await until(async () => { const s = (await now()).nowPlaying; return s?.song === 1 && s.where === 'window'; })));
    await again.evaluate(() => scrollTo(0, 0));
    await again.waitForFunction(() => !document.getElementById('musicMini').hidden);
    await again.click('#miniPrev');
    check('the dock Prev drives the window', !!(await until(async () => (await now()).nowPlaying?.song === 0)));
    const own = await again.frames().find((f) => f.url().startsWith('https://spotivibly.com/'))?.evaluate(() => window.log).catch(() => null);
    check('the panel\'s own player never plays while the window does', !own || !own.some((c) => /^(load|toggle|next|prev)/.test(c)), own?.join(' ') ?? 'no frame loaded');
    await again.screenshot({ path: path.join(outDir, 'panel-remote.png') });

    // 6. Closing the window stops the music and gives the toolbar button back to the panel.
    await win.close();
    const gone = await until(async () => { const s = await now(); return !s.nowPlaying && !s.musicWindow ? s : null; });
    check('closing the window clears what is playing', !!gone, JSON.stringify(await now()));
    check('the toolbar button opens the panel again', (await until(async () => (await popupSetting()) === '' && (await panelOnClick()) === true)) === true);
    await again.waitForFunction(() => /Player: Spotivibly/.test(document.getElementById('musicPlayerNote').textContent));
    check('the open panel takes its own player back', true);

    // 7. The popup has an idle state, and closing an idle panel opens no window.
    const idle = await ctx.newPage();
    await idle.goto(`${base}popup.html`);
    await idle.waitForTimeout(300);
    check('the popup says nothing plays when nothing does', await idle.isVisible('#popIdle') && !(await idle.isVisible('#popPlaying')));
    await idle.close();
    const pagesBefore = ctx.pages().length;
    await again.close();
    await new Promise((r) => setTimeout(r, 1500));
    check('closing a panel that plays nothing opens no window', ctx.pages().length === pagesBefore - 1, `${ctx.pages().map((p) => p.url()).join(', ')}`);

    // 7b. A soundtrack switch blanks the frame, so the song it played is over: the shared state must say so.
    const sw2 = await ctx.newPage();
    watch(sw2);
    await sw2.goto(`${base}panel.html`);
    await sw2.addStyleTag({ content: '#app[hidden] { display: block !important; }' });
    await sw2.evaluate(() => document.getElementById('music').scrollIntoView());
    await sw2.waitForFunction(() => !document.querySelector('#musicList .song-btn')?.disabled, null, { timeout: 10000 });
    await sw2.click('#musicList li[data-i="3"] .song-btn');
    await until(async () => (await now()).nowPlaying?.where === 'panel');
    await sw2.click('#musicTab-u1');
    check('switching soundtrack mid-song clears what was playing', !!(await until(async () => !(await now()).nowPlaying)), JSON.stringify(await now()));
    await sw2.click('#musicTab-u2'); // the pick is remembered: leave NFSU2 for the next step
    const count = ctx.pages().length;
    await sw2.close();
    await new Promise((r) => setTimeout(r, 1500));
    check('and closing the panel then opens no window', ctx.pages().length === count - 1, ctx.pages().map((p) => p.url()).join(', '));

    // 8. A real song plays for minutes, long after the worker went to sleep. Stop the worker while the panel plays: the
    // panel must reconnect (which wakes it), and closing the panel must still move the music to the window. Playwright
    // keeps no handle on the restarted worker, so the state is read from an extension page and CDP from here on.
    const late = await ctx.newPage();
    watch(late);
    await late.goto(`${base}panel.html`);
    await late.addStyleTag({ content: '#app[hidden] { display: block !important; }' });
    await late.evaluate(() => document.getElementById('music').scrollIntoView());
    await late.waitForFunction(() => !document.querySelector('#musicList .song-btn')?.disabled, null, { timeout: 10000 });
    await late.click('#musicList li[data-i="2"] .song-btn');
    await late.waitForTimeout(800);
    // The stop is real when the old worker's context is gone. Whether the panel woke a new one shows next: only a live
    // worker holding the panel's new port can open the window (a panel that never reconnects fails there).
    const page = await ctx.newCDPSession(late);
    await page.send('ServiceWorker.enable');
    await page.send('ServiceWorker.stopAllWorkers');
    const stopped = await until(() => sw.evaluate(() => 'alive').then(() => false, () => true));
    check('the worker was stopped while the panel played', stopped === true);
    await late.waitForTimeout(1200);
    const lateWin = ctx.waitForEvent('page', { timeout: 8000 });
    await late.close();
    const w2 = await lateWin.catch(() => null);
    await w2?.waitForLoadState();
    check('after the worker slept, closing the panel still opens the player window', w2?.url() === `${base}player.html`, w2?.url() ?? 'no window');
    const probe = await ctx.newPage();
    await probe.goto(`${base}popup.html`);
    const s2 = await until(() => probe.evaluate(() => chrome.storage.session.get('nowPlaying').then((g) => (g.nowPlaying?.where === 'window' && g.nowPlaying.started ? g.nowPlaying : null))));
    check('and the window plays the same song', s2?.song === 2, JSON.stringify(s2));
    const ui = await probe.evaluate(async () => [await chrome.action.getPopup({}), (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick]);
    check('and the toolbar button shows the popup', ui[0].endsWith('/panel/popup.html') && ui[1] === false, JSON.stringify(ui));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    check('the run finished', false, String(err?.stack || err));
  } finally {
    await ctx.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();
