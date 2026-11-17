// JDLZ decoder checks. Usage: node test/jdlz.test.mjs [<GlobalB.lzc> <GLOBALB.BUN>]
// Always: a hand-built stream with literals and a copy, plus two malformed inputs. With the two files: the real
// cache decompresses to the plain BUN byte for byte, and a one-byte corruption is detected.
import fs from 'node:fs';
import { decompressJdlz, isJdlz } from '../src/jdlz.js';
let fails = 0;
const check = (name, ok, value) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${value}`); if (!ok) fails++; };
const header = (size, body) => { const h = new Uint8Array(16 + body.length); h.set([0x4a, 0x44, 0x4c, 0x5a, 0x02, 0x10]);
  new DataView(h.buffer).setUint32(8, size, true); new DataView(h.buffer).setUint32(12, h.length, true); h.set(body, 16); return h; };

// "ABCD" literal, then copy 4 bytes back 4 (short form: flags2 bit 1).
const body = [0b110000, 0b01, 0x41, 0x42, 0x43, 0x44, 0x03, 0x01, 0x11, 0x00];
// Short form: length = (b1 | (b0 & 0xf0) << 4) + 3 = 4, back = (b0 & 0x0f) + 1 = 4.
const s1 = decompressJdlz(header(8, Uint8Array.from(body.slice(0, 8))));
check('literals and a short copy', new TextDecoder().decode(s1) === 'ABCDABCD', new TextDecoder().decode(s1));
check('rejects non-JDLZ input', (() => { try { decompressJdlz(new Uint8Array(32)); return false; } catch { return true; } })(), 'throws');
check('refuses a header claiming more than 64 MB before allocating', (() => { const h = new Uint8Array(16); h.set([0x4a, 0x44, 0x4c, 0x5a, 0x02, 0x10]); new DataView(h.buffer).setUint32(8, 0xffffffff, true); try { decompressJdlz(h); return false; } catch (e) { return /more than/.test(e.message); } })(), 'throws');
check('rejects a back reference before the start', (() => { try { decompressJdlz(header(4, Uint8Array.from([0x01, 0x01, 0x03, 0x01]))); return false; } catch { return true; } })(), 'throws');

const [lzc, bun] = process.argv.slice(2);
if (lzc && bun) {
  const src = new Uint8Array(fs.readFileSync(lzc)), ref = new Uint8Array(fs.readFileSync(bun));
  check('real cache is JDLZ', isJdlz(src), `${src.length} bytes`);
  const out = decompressJdlz(src);
  const same = out.length === ref.length && out.every((b, i) => b === ref[i]);
  check('real cache equals the plain BUN', same, `${out.length} vs ${ref.length}`);
  const bad = src.slice(); bad[src.length >> 1] ^= 0xff;
  let caught; try { const o = decompressJdlz(bad); caught = !(o.length === ref.length && o.every((b, i) => b === ref[i])); } catch { caught = true; }
  check('planted corruption changes the output', caught, 'detected');
} else console.log('SKIP  real cache checks: pass <GlobalB.lzc> <GLOBALB.BUN>');
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exitCode = fails ? 1 : 0;
