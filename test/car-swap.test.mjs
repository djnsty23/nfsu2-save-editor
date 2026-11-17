// Change car on a real profile: every player car into the first slot, stock and carried over. The slot must read back
// as the new model with only parts that model has, every other slot and every byte outside the slot record must stay,
// the checksums must verify and the garage must still pair. Traffic vehicles, the same car and an empty slot are refused.
// Usage: node test/car-swap.test.mjs <GLOBALB.BUN or GlobalB.lzc> <profile dir>
// The profile dir holds <NAME> (the career) and usually GARAGE.DAT. Nothing is written to it.
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as ops from '../src/ops.js';
import * as layout from '../vendor/hackch/model/layout.js';
import * as save from '../vendor/hackch/model/save-file.js';
import * as web from '../vendor/hackch/model/nfsu2-web.js';
import * as dyno from '../vendor/hackch/model/dyno.js';

const [bunPath, dir] = process.argv.slice(2);
if (!bunPath || !dir) { console.error('usage: node test/car-swap.test.mjs <GLOBALB.BUN> <profile dir>'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(readFileSync(bunPath))))));
const name = basename(dir), garagePath = join(dir, 'GARAGE.DAT');
const state = { career: new Uint8Array(readFileSync(join(dir, name))), garage: existsSync(garagePath) ? new Uint8Array(readFileSync(garagePath)) : null };
const merged = (s) => (s.garage && web.checkGarage(s.garage, s.career).state === 'loaded' ? web.mergeGarage(s.career, s.garage) : s.career);
const flat = (setups) => setups.flatMap((x) => [...x]);
const fitted = (s, slot) => ops.visualEditor(s, slot, db).flatMap((g) => g.slots);
// Body parts every stock car has fitted: bumpers, roof scoop, hood, skirts, spoiler, engine, lights, exhaust, rims, paint.
const CORE = [1, 2, 7, 9, 11, 12, 13, 14, 15, 16, 29, 63];
const missingCore = (s, slot) => { const f = fitted(s, slot); return CORE.filter((id) => !f.some((x) => x.id === id && x.value !== 0)); };
const unknownParts = (s, slot) => fitted(s, slot).filter((x) => x.options[0].label === 'Unknown part').map((x) => x.label);

const choices = ops.carChoices(state, db);
const players = choices.filter((c) => c.player), traffic = choices.filter((c) => !c.player);
check('the picker lists all 46 cars: 31 player cars and 15 traffic vehicles', choices.length === 46 && players.length === 31 && traffic.length === 15,
  `${choices.length}, ${players.length}, ${traffic.length}`);
check('every player car is available: its donor builds from this game data', players.every((c) => c.available) && traffic.every((c) => !c.available), players.filter((c) => !c.available).map((c) => c.internal).join(', '));
check('every car shows a real name, not the internal one', players.every((c) => c.name !== c.internal && !/^[A-Z0-9_]+$/.test(c.name)),
  players.filter((c) => c.name === c.internal).map((c) => c.internal).join(', '));
const locked = players.filter((c) => c.locked);
check('story-locked cars say which race unlocks them', locked.length > 0 && locked.every((c) => /^Win Stage \d URL race \d+$/.test(c.locked)),
  locked.map((c) => `${c.internal}: ${c.locked}`).join('; '));
console.log(`locked on this profile: ${locked.length} (${locked.map((c) => c.internal).join(', ')})`);

const s0 = ops.summary(state, db);
// The car with the most uniques and tuned setups, so Carry over has something to carry.
const score = (c) => c.uniques.filter(Boolean).length + c.tuned.filter(Boolean).length;
const before = [...s0.cars].sort((x, y) => score(y) - score(x))[0];
const slot = before.index, from = ops.carHashInSlot(state, slot);
const a = merged(state), n = layout.slotCount(a);
console.log(`slot ${before.slot} holds the ${before.name} (${score(before)} uniques and tuned setups); trying every other player car there`);
check('the original car has no unknown parts and every core body part (baseline)', !unknownParts(state, slot).length && !missingCore(state, slot).length, [...unknownParts(state, slot), ...missingCore(state, slot)].join(', '));

// Every body paint any player car's shop sells, read from the game data.
const sold = new Set(players.flatMap((c) => { const o = c.hash === from ? state : ops.changeCar(state, slot, c.hash, db); return fitted(o, slot).filter((x) => x.label === 'Body paint').flatMap((x) => x.options.filter((p) => p.label !== 'Unknown part').map((p) => p.hash)); }));
const factoryPaint = (hash) => !sold.has(hash);
const bad = { hash: [], core: [], parts: [], others: [], outside: [], sums: [], stock: [], keep: [] };
for (const c of players) {
  if (c.hash === from) continue;
  for (const keep of [false, true]) {
    const out = ops.changeCar(state, slot, c.hash, db, { keep });
    const b = merged(out);
    const tag = `${c.internal}${keep ? ' keep' : ''}`;
    if (ops.carHashInSlot(out, slot) !== c.hash) bad.hash.push(tag);
    // A body paint no car's shop list sells is a factory paint: the RSX and Impreza donors, read from real game saves,
    // carry 0xb8bcbdeb. Any other part the new model does not offer would be left over from the old car.
    const unknown = fitted(out, slot).filter((x) => x.options[0].label === 'Unknown part' && !(x.label === 'Body paint' && factoryPaint(x.value))).map((x) => x.label);
    const gone = missingCore(out, slot);
    if (gone.length) bad.core.push(`${tag}: slots ${gone.join(', ')}`);
    if (unknown.length) bad.parts.push(`${tag}: ${unknown.join(', ')}`);
    for (let s = 0; s < n; s++) {
      if (s === slot) continue;
      const base = layout.slotBase(s), end = base + layout.SLOT_RECORD_END_REL;
      if (!eq(a.subarray(base, end), b.subarray(base, end))) bad.others.push(`${tag}: slot ${s + 1}`);
    }
    const mask = new Uint8Array(a.length);
    for (let s = 0; s < n; s++) mask.fill(1, layout.slotBase(s), layout.slotBase(s) + layout.SLOT_RECORD_END_REL);
    let outside = 0;
    for (let i = 0x1c; i < a.length; i++) if (!mask[i] && a[i] !== b[i]) outside++;
    if (outside || a.length !== b.length) bad.outside.push(`${tag}: ${outside}`);
    if (!save.checkSave(out.career).ok || (out.garage && web.checkGarage(out.garage, out.career).state !== 'loaded')) bad.sums.push(tag);
    const car = ops.summary(out, db).cars.find((x) => x.index === slot);
    const setups = dyno.readSlotDyno(b, slot).setups;
    if (!keep && (car.tiers.some((t) => t !== 0) || car.uniques.some(Boolean) || !setups.every((x) => x.every((y) => y === dyno.NEUTRAL_BYTE)))) bad.stock.push(tag);
    if (keep && (!eq(car.uniques, before.uniques) || !eq(car.tiers, before.tiers) || !eq(flat(setups), flat(dyno.readSlotDyno(a, slot).setups)))) bad.keep.push(tag);
  }
}
const list = (x) => x.slice(0, 6).join('; ') + (x.length > 6 ? ` and ${x.length - 6} more` : '');
check('the slot reads back as the new model, for all 30 other player cars', !bad.hash.length, list(bad.hash));
check('the new car has its own stock body: every core body part fitted', !bad.core.length, list(bad.core));
check('the new car carries only parts that model has', !bad.parts.length, list(bad.parts));
check('no other slot changes', !bad.others.length, list(bad.others));
check('no byte outside the slot records changes (money, career, header)', !bad.outside.length, list(bad.outside));
check('checksums verify and the garage still pairs', !bad.sums.length, list(bad.sums));
check('Start stock: stock parts, no uniques, neutral tuning sliders', !bad.stock.length, list(bad.stock));
check('Carry over: part levels, uniques and the five setups stay', !bad.keep.length, list(bad.keep));

const throws = (fn) => { try { fn(); return ''; } catch (err) { return err.message; } };
const t = throws(() => ops.changeCar(state, slot, traffic[0].hash, db));
check('a traffic vehicle is refused', /cannot go in a garage slot/.test(t), t || 'it wrote');
const same = throws(() => ops.changeCar(state, slot, from, db));
const noDb = throws(() => ops.changeCar(state, slot, players.find((c) => c.hash !== from).hash, null));
check('Change car without game data is refused', /game data first/.test(noDb), noDb || 'it wrote');
check('the car already in the slot is refused', /already holds/.test(same), same || 'it wrote');
const empty = s0.cars.length < n ? [...Array(n).keys()].find((i) => !s0.cars.some((x) => x.index === i)) : null;
if (empty != null) {
  const e = throws(() => ops.changeCar(state, empty, players[0].hash, db));
  check('an empty slot is refused', e !== '', e || 'it wrote');
}
check('the input state is untouched', eq(state.career, new Uint8Array(readFileSync(join(dir, name)))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
