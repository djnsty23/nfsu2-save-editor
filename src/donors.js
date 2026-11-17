// Change car's donor blocks, built from the player's own GLOBALB.BUN. No table of game data ships with the editor.
// A donor is the three blocks of a garage slot that make it a stock copy of one car (docs/m2-donor-study.md):
//   slot +0x000, 148 bytes   six header words, then visual slots 0 to 30
//   slot +0x0E0,  64 bytes   visual slots 50 to 65
//   slot +0x2B0,  16 bytes   visual slots 166 to 169
// Header: +0x00 the car's stock performance rating (chunk 0x34A31, record +4), +0x04..+0x10 the constants 1, 4, 1, 0,
// +0x14 the car type hash. Visual slots: the first level-0 part in the car's own group, from the visual catalog,
// except slot 63 (base paint), which is the word at +0x73C in the car's record in chunk 0x34600 (dyno's phys view).
import { SLOT_BASE } from '../vendor/hackch/model/layout.js';

export const SLOT_BLOCKS = [[0x000, 148], [0x0e0, 64], [0x2b0, 16]];
const RATING_CHUNK = 0x34a31;
const HEADER_CONSTANTS = [[0x04, 1], [0x08, 4], [0x0c, 1], [0x10, 0]];
const HASH_REL = 0x14, VISUAL_REL = 0x18, VISUAL_COUNT = 170, PAINT_SLOT = 63, PAINT_PHYS = 0x73c;
const SLOT_SIZE = 0x2c0;

/**
 * The stock performance rating word of every car, in car-list order, or null for a car without a rating record
 * (a traffic vehicle's record rates it 0). Each 0x34A31 record is a count, then 16-byte entries; entry 0 is
 * the stock car, and its first word is the rating as a float's bits.
 */
export function readRatings(bun, carCount) {
  const dv = new DataView(bun.buffer, bun.byteOffset, bun.byteLength), recs = [];
  (function walk(start, end) {
    for (let off = start; off + 8 <= end;) {
      const id = dv.getUint32(off, true), next = off + 8 + dv.getUint32(off + 4, true);
      if (id & 0x80000000) walk(off + 8, Math.min(next, end));
      else if (id === RATING_CHUNK) recs.push([off + 8, next]);
      off = next;
    }
  })(0, bun.length);
  if (recs.length !== carCount) return Array(carCount).fill(null);
  return recs.map(([at, end]) => {
    const n = end - at >= 4 ? dv.getUint32(at, true) : 0;
    // A traffic vehicle's record holds one entry rated 0.
    return n > 0 && 4 + n * 16 === end - at ? dv.getUint32(at + 4, true) || null : null;
  });
}

/**
 * Why this game data cannot build a car's donor, or null when it can. Cheap: the car list asks it for every car,
 * and only Change car itself builds the blocks. `catalog` is ops.visualCatalog(db).
 */
export function donorProblem(db, catalog, hash) {
  const car = db?.dyno?.cars.find((c) => c.hash === hash);
  if (!car) return 'not in the game data';
  if (car.rating == null) return 'no stock rating record';
  if (!catalog) return 'no visual part tables';
  if (!car.phys || car.phys.length < PAINT_PHYS + 4) return 'no car record';
  // A car with no stock body part in its own group is not one the visual tables describe: building it would put
  // another car's parts on it.
  if (!catalog.options(hash, 0).some((p) => p.level === 0 && p.group === hash)) return 'no stock body in the visual tables';
  return null;
}

/**
 * The donor for one car: { name, hash, blocks: [{ off, bytes }] } in the shape hackch's setSlotCar writes, or
 * { why } when this game data cannot build it (donorProblem).
 */
export function buildDonor(db, catalog, hash) {
  const why = donorProblem(db, catalog, hash);
  if (why) return { why };
  const car = db.dyno.cars.find((c) => c.hash === hash), phys = car.phys;
  const slot = new Uint8Array(SLOT_SIZE), sv = new DataView(slot.buffer);
  sv.setUint32(0, car.rating, true);
  for (const [at, v] of HEADER_CONSTANTS) sv.setUint32(at, v, true);
  sv.setUint32(HASH_REL, hash, true);
  for (let s = 0; s < VISUAL_COUNT; s++) {
    const stock = catalog.options(hash, s).filter((p) => p.level === 0);
    const own = stock.find((p) => p.group === hash) ?? stock[0];
    sv.setUint32(VISUAL_REL + s * 4, own?.hash ?? 0, true);
  }
  sv.setUint32(VISUAL_REL + PAINT_SLOT * 4, new DataView(phys.buffer, phys.byteOffset, phys.byteLength).getUint32(PAINT_PHYS, true), true);
  return { name: car.name, hash, blocks: SLOT_BLOCKS.map(([rel, n]) => ({ off: SLOT_BASE + rel, bytes: slot.slice(rel, rel + n) })) };
}
