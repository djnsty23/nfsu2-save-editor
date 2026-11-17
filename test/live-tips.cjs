// Headless check of panel/tips.js on the static panel page served from localhost: every control has a tip, titles
// become tips, and a tip shows after 1.3 s of hover or keyboard focus, never before.
// Usage: node test/live-tips.cjs <playwright module dir> <out dir>
const http = require('http'), fs = require('fs'), path = require('path');
const [pwDir, shots] = process.argv.slice(2);
if (!shots) { console.error('usage: node test/live-tips.cjs <playwright dir> <out dir>'); process.exit(2); }
const { chromium } = require(pwDir);
const root = path.join(__dirname, '..');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  [${d}]` : ''}`); };
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); r.end(b); });
}).listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${srv.address().port}/panel/panel.html`;
  const b = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const p = await b.newPage({ viewport: { width: 400, height: 800 } });
    await p.goto(url);
    await p.waitForFunction(() => document.getElementById('tip'));
    // Show everything the panel would show once connected, and build a car row like panel.js does.
    await p.evaluate(() => {
      for (const n of document.querySelectorAll('[hidden]:not(#tip):not(input[type=file])')) n.hidden = false;
      document.getElementById('cars').innerHTML = `<details class="car" open><summary><span class="car-name">Car</span></summary>
        <div class="ctabs"><button data-tab="perf">Performance</button></div>
        <div class="cpanel" data-tab="perf"><div class="perf-rows"><select><option>Level 3</option></select><label class="uniq"><input type="checkbox">Unique</label>
        <button class="btn parts-btn">Parts</button></div><div class="grid"><button class="btn">Max this car</button><button class="btn">All uniques</button></div></div></details>`;
      const own = document.createElement('button'); own.id = 'own'; own.className = 'btn'; own.title = 'Own title'; own.textContent = 'Own';
      document.getElementById('cars').append(own);
    });
    await p.waitForTimeout(50);
    const s = await p.evaluate(() => {
      const titled = [...document.querySelectorAll('[title]')].filter((n) => n.tagName !== 'IFRAME').map((n) => n.id || n.outerHTML.slice(0, 60));
      const controls = [...document.querySelectorAll('button, select, input:not([type=file]), summary, a[href], a#musicPlug, label.file, label.uniq, label.agree')];
      const missing = controls.filter((n) => !n.closest('[data-tip]') && !n.closest('dialog')).map((n) => n.id || `${n.tagName} ${n.textContent.trim().slice(0, 30)}`);
      const ownTip = document.getElementById('own').dataset.tip, ownTitle = document.getElementById('own').getAttribute('title');
      return { titled, missing, n: controls.length, ownTip, ownTitle,
        car: ['.parts-btn', '.perf-rows select', '.grid .btn:first-child', 'label.uniq'].map((q) => !!document.querySelector(`#cars ${q}`)?.dataset.tip) };
    });
    check('no native title left outside iframes', !s.titled.length, s.titled.join(', '));
    check('every control outside the first-run dialog has a tip', !s.missing.length, `${s.n} controls, missing: ${s.missing.join(' | ')}`);
    check('a title set later by the panel becomes the tip', s.ownTip === 'Own title' && s.ownTitle === null, JSON.stringify([s.ownTip, s.ownTitle]));
    check('controls built later get their table tips', s.car.every(Boolean), JSON.stringify(s.car));

    const vis = () => p.evaluate(() => { const t = document.getElementById('tip'); const r = t.getBoundingClientRect(); return { on: !t.hidden, text: t.textContent, r: [r.left, r.top, r.right, r.bottom], vw: document.documentElement.clientWidth }; });
    await p.locator('#setMoney').scrollIntoViewIfNeeded();
    await p.hover('#setMoney');
    const t0 = Date.now();
    await p.waitForTimeout(1000);
    const early = await vis();
    await p.waitForTimeout(450);
    const late = await vis();
    check('hidden at 1.0 s of hover', !early.on, `${Date.now() - t0} ms`);
    check('shown by 1.45 s with the Set tip', late.on && /Writes the amount/.test(late.text), late.text);
    check('inside the viewport', late.r[0] >= 0 && late.r[2] <= late.vw && late.r[1] >= 0, JSON.stringify(late));
    await p.screenshot({ path: path.join(shots, 'tip-400.png') });
    await p.mouse.move(5, 790);
    await p.waitForTimeout(100);
    check('moving away hides it', !(await vis()).on);

    await p.hover('#musicPrev'); // disabled until a song plays
    { const r = await p.locator('#musicPrev').boundingBox(); await p.mouse.move(r.x + r.width / 2 + 1, r.y + r.height / 2 + 1); } // a move after the scroll arms it
    await p.waitForTimeout(1450);
    const dis = await vis();
    check('a disabled control still shows its tip', dis.on && dis.text === 'Previous song.', dis.text);
    await p.mouse.move(5, 790);

    await p.locator('#profile').focus();
    await p.keyboard.press('Tab');
    await p.waitForTimeout(1450);
    const kb = await vis();
    check('keyboard focus shows the tip after the same delay', kb.on, kb.text);
    await p.keyboard.press('Escape');
    check('Escape hides it', !(await vis()).on);
  } finally { await b.close(); srv.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; }
});
