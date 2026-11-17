// Change car's donor blocks, built from the player's own GLOBALB.BUN (src/donors.js), against what the game wrote.
// node test/donors.test.mjs <GLOBALB.BUN> <site backup zip or career file> ...
// The game writes a car's stock blocks when it sells that car. Every slot in the given saves that holds a car is
// compared word by word, skipping only what the player changed since (docs/m2-donor-study.md). The header's first
// word, the stock performance rating, may differ by 1 ULP: the game recomputes it whenever parts change, and the
// 240SX's saves carry 0x4343EC41 where the BUN stores 0x4343EC40.
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../src/ops.js';
import { buildDonor, SLOT_BLOCKS } from '../src/donors.js';
import { readZip } from '../src/zip.js';
import * as layout from '../vendor/hackch/model/layout.js';

const [bunPath, ...savePaths] = process.argv.slice(2);
if (!bunPath || !savePaths.length) { console.error('usage: node test/donors.test.mjs <GLOBALB.BUN> <save or zip> ...'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(fs.readFileSync(bunPath))))));
const cat = ops.visualCatalog(db);
const byHash = new Map(cat.parts.map((p) => [p.hash, p]));
const players = db.dyno.cars.filter((c) => c.rating != null);
const built = new Map(players.map((c) => [c.hash, buildDonor(db, cat, c.hash)]));
check('D1 every player car with a rating record builds a donor, and no traffic vehicle does',
  players.length === 31 && [...built.values()].every((d) => d.blocks) && db.dyno.cars.filter((c) => c.rating == null).every((c) => !buildDonor(db, cat, c.hash).blocks),
  `${players.length} player cars, ${[...built.values()].filter((d) => d.blocks).length} built, ${db.dyno.cars.length - players.length} without a rating`);
check('D2 a donor is the three slot blocks hackch writes, with the car type hash at +0x14',
  [...built.values()].every((d) => d.blocks.length === 3 && d.blocks.every((b, i) => b.off === layout.SLOT_BASE + SLOT_BLOCKS[i][0] && b.bytes.length === SLOT_BLOCKS[i][1]) && u32(d.blocks[0].bytes, 0x14) === d.hash));

/**
 * The stock-identity words of a game-written slot that differ from a donor. Played words (what the player changed
 * after buying) are skipped: a part above level 0, paint, vinyl and dial colours (63-65, 163-166), small or large
 * decal rectangles, and slots the game derives from a played part (hood underside from the hood, widebody doors and
 * decals from the widebody, the rear wheel from the front wheel).
 */
function identityDiff(data, base, donor) {
  const lvl = (k) => byHash.get(u32(data, base + 0x18 + k * 4))?.level ?? 0;
  let n = 0;
  const bad = [];
  for (const [i, blk] of donor.blocks.entries()) for (let o = 0; o < blk.bytes.length; o += 4) {
    const rel = SLOT_BLOCKS[i][0] + o, want = u32(blk.bytes, o), got = u32(data, base + rel);
    const p = byHash.get(got), s = (rel - 0x18) / 4;
    if (rel >= 0x18) {
      const derived = (s === 25 && lvl(9) > 0) || (((s >= 17 && s <= 22) || (s >= 59 && s <= 62)) && lvl(6) > 0) || (s === 30 && lvl(29) > 0) || (s >= 163 && s <= 166);
      const played = derived || (p && p.level > 0) || [63, 64, 65].includes(s)
        || (s >= 52 && s <= 62 && got !== want && p?.level === 0 && /SMALL|LARGE/.test(p.name))
        || (s >= 17 && s <= 22 && /WIDEBODY/.test(p?.name ?? ''));
      if (played) continue;
    }
    n++;
    // Header +0x00 is a positive float: adjacent bit patterns are 1 ULP apart.
    const ok = rel === 0 ? Math.abs(want - got) <= 1 : want === got;
    if (!ok) bad.push(`${rel < 0x18 ? `h+${rel.toString(16)}` : `v${s}`} game ${p?.name ?? got.toString(16)} built ${byHash.get(want)?.name ?? want.toString(16)}`);
  }
  return { n, bad };
}

const files = [];
for (const s of savePaths) {
  const bytes = new Uint8Array(fs.readFileSync(s));
  if (bytes[0] === 0x50) { for (const e of await readZip(bytes)) if (e.data.length === layout.PROFILE_SIZE && !/GARAGE/i.test(e.name)) files.push([`${path.basename(s)}:${e.name.split('/').pop()}`, e.data]); }
  else files.push([path.basename(s), bytes]);
}
const measured = new Map();
for (const [name, data] of files) for (let slot = 0; slot < 5; slot++) {
  const base = layout.SLOT_BASE + slot * layout.SLOT_STRIDE;
  if (!data[base + layout.SLOT_BOUGHT_REL]) continue;
  const hash = u32(data, base + 0x14), donor = built.get(hash);
  if (!donor?.blocks) continue;
  const { n, bad } = identityDiff(data, base, donor);
  const car = db.dyno.cars.find((c) => c.hash === hash).name;
  measured.set(car, (measured.get(car) ?? 0) + 1);
  check(`D3 ${car} (${name} slot ${slot + 1}): every stock-identity word equals the built donor, header +0x00 within 1 ULP`, n >= 20 && !bad.length, `${n - bad.length}/${n}${bad.length ? ' ' + bad.join('; ') : ''}`);
}
// The five cars the saves hold: the Miata and AE86 were bought in game; the R34, 240SX and 206 are consistent but
// not proven (they first appear in a profile that may have been written with the old table).
const FIVE = ['MIATA', 'COROLLA', 'SKYLINE', '240SX', 'PEUGOT'];
check('D4 the saves measure all five cars', FIVE.every((c) => measured.has(c)), [...measured].map(([c, k]) => `${c} x${k}`).join(', '));

// Base paint (slot 63) is skipped above, since players repaint. The second profile's R34, 240SX and 206 were never
// repainted, so their paint word is the factory one, and it must equal the built donor's. In-game row C7 proves it.
// Its name is read from NFSU2_SECOND_PROFILE, so no real profile name sits in the repository.
const SECOND = process.env.NFSU2_SECOND_PROFILE;
const paintRows = [];
for (const [name, data] of files) {
  if (!SECOND || !name.endsWith(':' + SECOND)) continue;
  for (let slot = 0; slot < 5; slot++) {
    const base = layout.SLOT_BASE + slot * layout.SLOT_STRIDE, hash = u32(data, base + 0x14);
    const car = players.find((c) => c.hash === hash);
    if (!car || !['SKYLINE', '240SX', 'PEUGOT'].includes(car.name)) continue;
    const donor = built.get(hash), want = u32(donor.blocks[1].bytes, 0x18 + 63 * 4 - SLOT_BLOCKS[1][0]);
    paintRows.push(`${car.name} ${u32(data, base + 0x18 + 63 * 4) === want ? 'same' : 'DIFFERS'}`);
  }
}
if (!SECOND) console.log('SKIP  D6 needs NFSU2_SECOND_PROFILE');
else check('D6 the never-repainted R34, 240SX and 206 carry the built base paint', paintRows.length >= 3 && paintRows.every((r) => r.endsWith('same')), paintRows.join(', '));

// Plants: the comparison must fire on a wrong byte, and on a rating 2 ULP off, and pass 1 ULP.
const [plantName, plantData] = files.find(([, d]) => [0, 1, 2, 3, 4].some((s) => u32(d, layout.SLOT_BASE + s * layout.SLOT_STRIDE + 0x14) === players.find((c) => c.name === 'MIATA').hash)) ?? [];
if (plantData) {
  const slot = [0, 1, 2, 3, 4].find((s) => u32(plantData, layout.SLOT_BASE + s * layout.SLOT_STRIDE + 0x14) === players.find((c) => c.name === 'MIATA').hash);
  const base = layout.SLOT_BASE + slot * layout.SLOT_STRIDE, donor = built.get(u32(plantData, base + 0x14));
  const planted = (rel, delta) => ({ ...donor, blocks: donor.blocks.map((b) => { const c = b.bytes.slice(); const at = rel - (b.off - layout.SLOT_BASE); if (at >= 0 && at + 4 <= c.length) new DataView(c.buffer).setUint32(at, (u32(c, at) + delta) >>> 0, true); return { ...b, bytes: c }; }) });
  check(`D5 a wrong byte in the stock body word (visual slot 0) turns the comparison red (${plantName})`, identityDiff(plantData, base, planted(0x18, 1)).bad.length === 1);
  check('D5 a wrong car type hash turns it red', identityDiff(plantData, base, planted(0x14, 1)).bad.length === 1);
  check('D5 a rating 2 ULP off turns it red, 1 ULP passes', identityDiff(plantData, base, planted(0, 2)).bad.length === 1 && identityDiff(plantData, base, planted(0, 1)).bad.length === 0);
} else check('D5 the plants need a save holding the Miata', false);

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
