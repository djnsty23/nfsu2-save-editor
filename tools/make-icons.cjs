// Draws the toolbar icons (no dependencies): an orange tile with a white speed chevron.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
function crc(buf) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); }
function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1)), r = size * 0.18;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4, u = (x + .5) / size, v = (y + .5) / size;
      const dx = Math.max(r - (x + .5), 0, (x + .5) - (size - r)), dy = Math.max(r - (y + .5), 0, (y + .5) - (size - r));
      const inside = dx * dx + dy * dy <= r * r;
      const d1 = Math.abs((u - 0.22) - Math.abs(v - 0.5) * 0.9), d2 = Math.abs((u - 0.52) - Math.abs(v - 0.5) * 0.9);
      const chevron = (d1 < 0.09 || d2 < 0.09) && v > 0.18 && v < 0.82;
      const [R, G, B] = chevron ? [255, 255, 255] : [214, 69, 27];
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(__dirname, '..', 'icons', `icon${s}.png`), png(s));
console.log('icons written');
