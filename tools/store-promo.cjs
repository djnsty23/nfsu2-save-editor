// Renders the Chrome Web Store small promo tile (440x280 PNG) in headless Chrome. Three designs, all from the
// extension's own colours and its double-chevron icon, with no game art, car maker logo or screenshot.
// Usage: node tools/store-promo.cjs <playwright module dir> <out dir> [design: chevron | panel | stripes]
// With no design it renders all three, as promo-<design>.png.
const fs = require('fs'), path = require('path');
const [pwDir, outDir, only] = process.argv.slice(2);
if (!outDir) { console.error('usage: node tools/store-promo.cjs <playwright dir> <out dir> [chevron|panel|stripes]'); process.exit(2); }
const { chromium } = require(pwDir);

const W = 440, H = 280;
const C = { dark: '#111116', surface: '#1b1b22', line: '#2e2e38', fg: '#ececf1', muted: '#a3a3b2', accent: '#ff6a3d', deep: '#c23d15', ok: '#5fd08e' };
const chevrons = (size, color) => `<svg width="${size}" height="${size}" viewBox="0 0 128 128" aria-hidden="true">
  <path d="M70 24 L34 64 L70 104 L84 104 L48 64 L84 24 Z" fill="${color}"/>
  <path d="M104 24 L68 64 L104 104 L118 104 L82 64 L118 24 Z" fill="${color}"/></svg>`;
const base = `*{box-sizing:border-box;margin:0}html,body{width:${W}px;height:${H}px;overflow:hidden}
p{text-wrap:balance}body{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}`;

const designs = {
  // Dark ground, one large chevron mark, the name and one promise.
  chevron: `<style>${base}
    body{background:${C.dark};color:${C.fg};display:grid;grid-template-columns:150px 1fr;align-items:center;padding:0 28px 0 18px;position:relative}
    body::after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;background:${C.accent}}
    h1{font-size:34px;line-height:1.05;font-weight:800;letter-spacing:-.5px}
    h1 span{color:${C.accent}}
    p{margin-top:12px;font-size:16px;line-height:1.35;color:${C.muted}}
    small{display:block;margin-top:14px;font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.muted}}
  </style><div>${chevrons(150, C.accent)}</div>
  <div><h1>NFSU2<br><span>Save Editor</span></h1><p>Best car, unlock everything, a ready-made garage. Undo any edit.</p><small>For nfsu2.xyz · offline play</small></div>`,

  // Orange ground, the name on the left, a drawn panel card on the right listing what it does.
  panel: `<style>${base}
    body{background:${C.deep};color:#fff;display:grid;grid-template-columns:1fr 196px;gap:18px;align-items:center;padding:0 22px 0 26px}
    h1{font-size:32px;line-height:1.05;font-weight:800;letter-spacing:-.5px}
    p{margin-top:10px;font-size:15px;line-height:1.35;color:#ffe3d8}
    .card{background:${C.surface};border:1px solid ${C.line};border-radius:12px;padding:12px 14px;color:${C.fg};box-shadow:0 10px 30px rgba(0,0,0,.35)}
    .row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:7px 0;border-bottom:1px solid ${C.line}}
    .row:last-child{border:0}
    .row b{font-weight:600}.row i{font-style:normal;color:${C.ok};font-size:12px}
    .btn{margin-top:8px;text-align:center;background:${C.accent};color:#14080a;font-weight:700;font-size:13px;border-radius:8px;padding:7px}
  </style><div>${chevrons(44, '#fff')}<h1>NFSU2<br>Save Editor</h1><p>Edit your nfsu2.xyz career in one click. Every edit can be undone.</p></div>
  <div class="card"><div class="row"><b>Best car</b><i>Level 3</i></div><div class="row"><b>Unlock everything</b><i>done</i></div>
  <div class="row"><b>Ready-made garage</b><i>10 cars</i></div><div class="btn">Undo</div></div>`,

  // Dark ground cut by orange speed stripes, the name centred.
  stripes: `<style>${base}
    body{background:${C.dark};color:${C.fg};display:grid;place-items:center;text-align:center;position:relative}
    .s{position:absolute;height:14px;background:${C.accent};transform:skewX(-35deg)}
    h1{position:relative;font-size:40px;font-weight:800;letter-spacing:-.5px;line-height:1}
    h1 span{color:${C.accent}}
    p{position:relative;margin-top:12px;font-size:16px;color:${C.muted}}
  </style>
  <div class="s" style="left:-20px;top:34px;width:170px"></div><div class="s" style="left:-20px;top:56px;width:110px;opacity:.6"></div>
  <div class="s" style="right:-20px;bottom:56px;width:110px;opacity:.6"></div><div class="s" style="right:-20px;bottom:34px;width:170px"></div>
  <div><h1>NFSU2 <span>Save Editor</span></h1><p>Your nfsu2.xyz career, edited safely. Undo anything.</p></div>`,
};

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    for (const [name, html] of Object.entries(designs)) {
      if (only && name !== only) continue;
      await page.setContent(`<!doctype html><meta charset="utf-8"><body>${html}</body>`);
      const file = path.join(outDir, `promo-${name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height: H } });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight);
      console.log(`${file}  ${overflow ? 'OVERFLOW' : 'fits'}`);
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
