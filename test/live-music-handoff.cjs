// Live check that music keeps playing after the side panel closes (background.js hands the song to an offscreen
// page) and that the next panel takes it back, against the real Spotivibly player and YouTube, in a throwaway headless
// Chrome profile with Chrome's user-gesture autoplay policy. Load a store build: node tools/build-store.cjs --out <dir>.
// Usage: node test/live-music-handoff.cjs <playwright module dir> <unpacked extension dir> <out dir>
const fs = require('fs'), path = require('path'), os = require('os');
const [pwDir, ext, outDir] = process.argv.slice(2);
const { chromium } = require(pwDir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-handoff-')), {
    headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', viewport: { width: 1280, height: 900 },
    // Headless Chrome is muted by default, and Chrome closes a silent AUDIO_PLAYBACK document after about 30 seconds.
    // Unmuted into a null audio output, Chrome measures real sound and nothing reaches the speakers.
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=document-user-activation-required', '--disable-audio-output'],
  });
  let pass = 0, fail = 0;
  const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  [${d}]` : ''}`); };
  try {
    const site = ctx.pages()[0] || await ctx.newPage();
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: ext });
    const isExt = (w) => w.url().startsWith('chrome-extension://');
    const sw = ctx.serviceWorkers().find(isExt) || await ctx.waitForEvent('serviceworker', { predicate: isExt, timeout: 15000 });
    const extId = new URL(sw.url()).host;
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    const offOpen = () => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
    const session = () => sw.evaluate(() => chrome.storage.session.get(null));
    const errors = [];
    const openPanel = async () => {
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await site.waitForTimeout(500);
      await p.goto(`chrome-extension://${extId}/panel/panel.html`);
      await p.waitForFunction(() => !document.getElementById('music').hidden, null, { timeout: 20000 });
      return p;
    };
    const state = (p) => p.evaluate(() => ({ count: document.getElementById('musicCount').textContent, title: document.getElementById('musicTitle').textContent, time: document.getElementById('musicTime').textContent, toggle: document.getElementById('musicToggle').getAttribute('aria-label') }));
    const secs = (s) => { const [m, x] = s.split(':').map(Number); return m * 60 + x; };

    // 1. Play the first NFSU1 song in the panel.
    let panel = await openPanel();
    await panel.$eval('#music', (m) => m.scrollIntoView());
    await panel.locator('#musicTab-u1').click();
    await panel.waitForFunction(() => document.querySelectorAll('#musicList .song').length > 0 && !document.querySelector('#musicList .song .song-btn').disabled, null, { timeout: 30000 });
    const first = await panel.$$eval('#musicList .song .song-t b', (l) => l.slice(0, 3).map((b) => b.textContent));
    check('NFSU1 list starts with Get Low', first[0] === 'Get Low', first.join(' | '));
    const idle = await state(panel);
    check('before any song, the card shows the first row', idle.title === 'Get Low' && idle.count === '1 of 22', JSON.stringify(idle));
    await panel.locator('#musicToggle').click();
    await panel.waitForFunction(() => document.getElementById('musicToggle').getAttribute('aria-label') === 'Pause', null, { timeout: 30000 });
    await sleep(9000);
    const before = await state(panel);
    check('the panel plays Get Low', before.title === 'Get Low' && before.toggle === 'Pause', JSON.stringify(before));
    check('the panel reported the song to the worker', (await session()).musicPanel?.status === 'playing', JSON.stringify((await session()).musicPanel));

    // 2. Close the panel: the song goes on offscreen from the same second.
    const closedAt = Date.now();
    await panel.close();
    await sleep(3000);
    check('an offscreen player opens when the panel closes mid-song', (await offOpen()) === 1);
    await sleep(8000);
    const off1 = (await session()).musicOff;
    await sleep(5000);
    const off2 = (await session()).musicOff;
    console.log('offscreen states', JSON.stringify(off1), JSON.stringify(off2));
    check('the offscreen player plays the same song', off2?.status === 'playing' && off2?.key === 'u1', JSON.stringify(off2));
    check('the offscreen song moves on (time advances)', off1 && off2 && off2.time > off1.time + 2, `${off1?.time} -> ${off2?.time}`);
    const expected = secs(before.time) + (Date.now() - closedAt) / 1000;
    check('it carried on from where the panel left it, not from 0', off2 && Math.abs(off2.time - expected) < 8, `at ${off2?.time?.toFixed(1)}s, expected about ${expected.toFixed(1)}s`);
    // Chrome closes an AUDIO_PLAYBACK document after about 30 seconds without audible sound: it must outlive that.
    await sleep(Math.max(0, closedAt + 50000 - Date.now()));
    const off3 = (await session()).musicOff;
    check('50 seconds after the panel closed, the offscreen player is still open and playing', (await offOpen()) === 1 && off3?.status === 'playing' && off3.time > off2.time + 20, `${off2?.time?.toFixed(1)} -> ${off3?.time?.toFixed(1)}`);

    // 3. Reopen: the panel takes the song back, the offscreen player closes, no double audio.
    panel = await openPanel();
    await panel.waitForFunction(() => document.getElementById('musicToggle').getAttribute('aria-label') === 'Pause', null, { timeout: 40000 }).catch(() => {});
    await sleep(6000);
    const after = await state(panel);
    const tab = await panel.$eval('#musicTabs [aria-selected="true"]', (b) => b.dataset.set);
    check('the reopened panel is on NFSU1, playing Get Low', tab === 'u1' && after.title === 'Get Low' && after.toggle === 'Pause', `${tab} ${JSON.stringify(after)}`);
    const want = secs(before.time) + (Date.now() - closedAt) / 1000;
    check('the panel picked up near the offscreen second', Math.abs(secs(after.time) - want) < 12, `at ${after.time}, expected about ${want.toFixed(0)}s`);
    check('the offscreen player is closed once the panel has the song', (await offOpen()) === 0);
    await panel.screenshot({ path: path.join(outDir, 'handoff-reopened.png') });

    // 4. Paused, then closed: nothing plays offscreen.
    await panel.locator('#musicToggle').click();
    await panel.waitForFunction(() => document.getElementById('musicToggle').getAttribute('aria-label') === 'Play', null, { timeout: 10000 });
    await sleep(1000);
    await panel.close();
    await sleep(4000);
    check('a paused song stays stopped when the panel closes', (await offOpen()) === 0);
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally { await ctx.close(); }
  console.log(`${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('ERR', e.message); process.exitCode = 1; });
