// Applying the ready-made garage to another career: one car at a time and the whole garage, on the real save format.
// Usage: node test/garage-apply.test.mjs <GLOBALB.BUN> <profile folder>
// The profile folder holds <NAME> (the career) and usually GARAGE.DAT. Nothing is written to it.
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as ops from '../src/ops.js';
import * as designs from '../src/garage-designs.js';
import garage from '../src/garage-data.js';
import * as save from '../vendor/hackch/model/save-file.js';
import * as web from '../vendor/hackch/model/nfsu2-web.js';
import * as layout from '../vendor/hackch/model/layout.js';

const [bunPath, dir] = process.argv.slice(2);
if (!bunPath || !dir) { console.error('usage: node test/garage-apply.test.mjs <GLOBALB.BUN> <profile folder>'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const throws = (fn) => { try { fn(); return null; } catch (err) { return err.message; } };
const merged = (s) => (s.garage && web.checkGarage(s.garage, s.career).state === 'loaded' ? web.mergeGarage(s.career, s.garage) : s.career);
const sound = (s) => Object.values(save.verifyChecksums(s.career)).every(Boolean) && (!s.garage || web.checkGarage(s.garage, s.career).state === 'loaded');
const record = (data, slot) => data.subarray(layout.slotBase(slot), layout.slotBase(slot) + layout.SLOT_RECORD_END_REL);
const sameDesign = (got, d) => got.visual === d.visual && got.perf === d.perf && got.owned === d.owned && eq(got.uniques, d.uniques) && eq(got.setups, d.setups);

const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(readFileSync(bunPath))))));
const name = basename(dir), gp = join(dir, 'GARAGE.DAT');
const state = { career: new Uint8Array(readFileSync(join(dir, name))), garage: existsSync(gp) ? new Uint8Array(readFileSync(gp)) : null };
ops.validate(state);
const cars = ops.summary(state, db).cars;
console.log(`target career: ${cars.length} cars`);
const slot = cars[0].index;

// Acceptance: every ready-made car lands exactly, on a stock car of its model built from this game data.
const missed = [], others = [], unsound = [];
for (const d of garage.cars) {
  const hash = ops.designCarHash(d, db);
  let s = state;
  // A stock car of another model first, so the design always goes through Change car's donor.
  const alt = ops.carChoices(state, db).find((c) => c.player && c.available && c.hash !== hash).hash;
  if (ops.carHashInSlot(s, slot) === hash) s = ops.changeCar(s, slot, alt, db);
  const r = ops.applyDesign(s, slot, d, db);
  if (!sameDesign(ops.readDesign(r.state, slot), d) || r.report.skipped.length) missed.push(`${d.car}${r.report.skipped.length ? ` skipped ${r.report.skipped.join(', ')}` : ''}`);
  if (ops.carHashInSlot(r.state, slot) !== hash) missed.push(`${d.car}: wrong model`);
  const a = merged(s), b = merged(r.state);
  for (const c of cars) if (c.index !== slot && !eq(record(a, c.index), record(b, c.index))) others.push(`${d.car}: slot ${c.index + 1}`);
  if (!sound(r.state)) unsound.push(d.car);
}
check('every ready-made car applies exactly: looks, parts, uniques and five setups read back as shipped', !missed.length, missed.join('; '));
check('applying a car leaves every other slot byte for byte', !others.length, others.join('; '));
check('every applied career has valid checksums and a matching garage file', !unsound.length, unsound.join(', '));

// Same model in the slot: no model change, nothing reported replaced.
const d0 = garage.cars[0], h0 = ops.designCarHash(d0, db);
const onModel = ops.carHashInSlot(state, slot) === h0 ? state : ops.applyDesign(state, slot, d0, db).state;
const again = ops.applyDesign(onModel, slot, d0, db);
check('a car of the same model is updated in place, not replaced', again.report.replaced === null && sameDesign(ops.readDesign(again.state, slot), d0));
const other = ops.applyDesign(onModel, slot, garage.cars[1], db);
check('a car of another model names the car it replaced', typeof other.report.replaced === 'string' && other.report.replaced.length > 0, other.report.replaced);

// Refusals.
check('no game data: applying is refused', /Load the game data first/.test(throws(() => ops.applyDesign(state, slot, d0, null)) ?? ''));
check('no game data: replacing is refused', /Load the game data first/.test(throws(() => ops.replaceGarage(state, garage, null, { confirmed: true })) ?? ''));
check('a damaged design is refused before anything is written', /damaged/.test(throws(() => ops.applyDesign(state, slot, { ...d0, perf: 'zz' }, db)) ?? ''));
const empty = Array.from({ length: layout.slotCount(merged(state)) }, (_, i) => i).find((i) => !cars.some((c) => c.index === i));
if (empty !== undefined) check('an empty garage slot is refused', throws(() => ops.applyDesign(state, empty, d0, db)) !== null);

// Replace the whole garage: refused without the confirm, all or nothing with it.
const unconfirmed = throws(() => ops.replaceGarage(state, garage, db));
check('plant: replacing the whole garage without the confirm is refused', /needs the confirm/.test(unconfirmed ?? ''), unconfirmed);
check('plant: a confirm that is not exactly true is refused', /needs the confirm/.test(throws(() => ops.replaceGarage(state, garage, db, { confirmed: 'yes' })) ?? ''));
const plan = ops.replacePlan(state, garage, db);
check('the plan names every slot it overwrites, with what is there now and its tuned setups', plan.placed.length === Math.min(cars.length, garage.cars.length) && plan.placed.every((p) => p.from && p.to && Number.isInteger(p.tuned)));
check('cars past the career\'s garage are listed as not placed', plan.unplaced.length === Math.max(0, garage.cars.length - cars.length), plan.unplaced.join(', '));
const whole = ops.replaceGarage(state, garage, db, { confirmed: true });
const wrong = plan.placed.filter((p, i) => !sameDesign(ops.readDesign(whole.state, p.slot), garage.cars[i]));
check('with the confirm every placed car reads back as shipped', !wrong.length && sound(whole.state), wrong.map((p) => p.to).join(', '));
check('money and story stay as they were', ops.summary(whole.state, db).money === ops.summary(state, db).money && ops.summary(whole.state, db).stage === ops.summary(state, db).stage);
// Plant a failure on the last car: game data without its model. Nothing may be written, and the error says which.
const brokenDb = { ...db, cars: db.cars.filter((c) => c.name !== garage.cars[plan.placed.length - 1].car) };
const partial = throws(() => ops.replaceGarage(state, garage, brokenDb, { confirmed: true }));
check('plant: one car failing fails the whole replace, naming the slot', /Slot \d+ .*Nothing was written/.test(partial ?? ''), partial);
const small = { ...garage, cars: garage.cars.slice(0, 2) };
const two = ops.replaceGarage(state, small, db, { confirmed: true });
check('a smaller ready-made garage replaces only that many cars', two.reports.length === Math.min(2, cars.length) && !two.unplaced.length);

console.log(`\n${pass}/${pass + fail} pass`);
process.exitCode = fail ? 1 : 0;
