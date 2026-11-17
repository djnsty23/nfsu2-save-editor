// Offline proof that every action edits only what it should and that undo is byte exact.
// Usage: node test/ops.test.mjs <GLOBALB.BUN> <profile folder> [<profile folder> ...]
// A profile folder holds <NAME> (the career) and usually GARAGE.DAT. Nothing is written to it.
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as ops from '../src/ops.js';
import * as hist from '../src/history.js';
import * as save from '../vendor/hackch/model/save-file.js';
import * as web from '../vendor/hackch/model/nfsu2-web.js';
import * as layout from '../vendor/hackch/model/layout.js';
import * as perf from '../vendor/hackch/model/perf.js';
import * as dyno from '../vendor/hackch/model/dyno.js';
import * as visual from '../vendor/hackch/model/visual.js';

const [bunPath, ...dirs] = process.argv.slice(2);
// Profiles the game itself wrote (not edited by a tool): the level rule must read all of their categories.
const REAL = (process.env.REAL_PROFILES || '').split(',').filter(Boolean);
const workingOf = (s) => (s.garage && web.checkGarage(s.garage, s.career).state === 'loaded' ? web.mergeGarage(s.career, s.garage) : s.career);
if (!bunPath || !dirs.length) { console.error('usage: node test/ops.test.mjs <GLOBALB.BUN> <profile folder>...'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const eq = (a, b) => (a == null && b == null) || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
const diff = (a, b) => { const out = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };
const sumsOk = (career) => Object.values(save.verifyChecksums(career)).every(Boolean);
const garageOk = (s) => !s.garage || web.checkGarage(s.garage, s.career).state === 'loaded';
const CHECKSUM_BYTES = new Set([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);

const dbJson = ops.parseGameDb(new Uint8Array(readFileSync(bunPath)));
const db = ops.hydrateDb(JSON.parse(JSON.stringify(dbJson))); // the same round trip chrome.storage does
check('game data parses and survives JSON storage', db.events.size > 0 && db.stages.length === 6, `${db.events.size} events`);

// Carbon twins: every player car pairs hood, spoiler, roof scoop and mirrors; bumpers, skirts and wide bodies have none.
const catalog = ops.visualCatalog(db);
const playerCars = db.dyno.cars.filter((c) => catalog.options(c.hash, 9).length > 1);
const twinCounts = (c, v) => ops.carbonTwins(catalog, c.hash, v)?.size ?? 0;
check('every player car has carbon twins for hood, spoiler, roof scoop and mirrors', playerCars.length >= 30 && playerCars.every((c) => [9, 12, 7, 32].every((v) => twinCounts(c, v) > 0)), `${playerCars.length} cars`);
check('no car has carbon twins for bumpers, skirts or wide body', db.dyno.cars.every((c) => [1, 2, 11, 6].every((v) => twinCounts(c, v) === 0)));
// Plant: a carbon list whose order breaks (name and level both disagree) must give no twins at all.
const fake = (parts) => ({ options: () => parts });
const cf = new Map([[0x721aff7c, [1]]]), none = new Map();
const P1 = { hash: 1, name: 'A', level: 1, variant: 0, attributes: none }, P2 = { hash: 2, name: 'B', level: 2, variant: 0, attributes: none };
const C1 = { hash: 11, name: 'A', level: 1, variant: 0, attributes: cf }, C2 = { hash: 12, name: 'B CARBON FIBRE', level: 3, variant: 0, attributes: cf };
const Cx = { hash: 13, name: 'Z', level: 3, variant: 4, attributes: cf };
check('carbon pairing accepts a name match with a level quirk', ops.carbonTwins(fake([P1, P2, C1, C2]), 0, 9)?.get(2) === 12);
// KIT_CARBON (slot 93) is one Level 0 / Level 3 switch on every player car; two "on" parts must give no switch.
check('every player car has a KIT_CARBON switch', playerCars.every((c) => ops.carbonSwitch(catalog, c.hash, 93) !== null));
check('a switch slot with two "on" parts gives no switch', ops.carbonSwitch(fake([{ hash: 1, level: 0 }, { hash: 2, level: 3 }, { hash: 3, level: 3 }]), 0, 93) === null);
check('carbon pairing gives no twins when the order breaks', ops.carbonTwins(fake([P1, P2, C1, Cx]), 0, 9) === null && ops.carbonTwins(fake([P1, P2, C1]), 0, 9) === null);

for (const dir of dirs) {
  const name = basename(dir);
  const careerPath = join(dir, name), garagePath = join(dir, 'GARAGE.DAT');
  const base = { career: new Uint8Array(readFileSync(careerPath)), garage: existsSync(garagePath) ? new Uint8Array(readFileSync(garagePath)) : null };
  const P = `[${name}]`;
  const hasGarage = ops.validate(base);
  const s0 = ops.summary(base, db);
  console.log(`${P} start: money ${s0.money}, stage ${s0.stage}, ${s0.cars.length} cars, garage ${hasGarage}, story ${s0.report.percent.toFixed(0)}%, part gates failing ${s0.report.partsFailing}`);

  // Money: only the money dword and the checksums change.
  const m = ops.setMoney(base, 1234567);
  const moneyDiff = diff(base.career, m.career).filter((i) => !CHECKSUM_BYTES.has(i));
  check(`${P} money reads back`, save.getMoney(m.career) === 1234567 && sumsOk(m.career) && garageOk(m));
  check(`${P} money touches only its 4 bytes`, moneyDiff.every((i) => i >= layout.MONEY_OFF && i < layout.MONEY_OFF + 4), `changed ${moneyDiff.length}`);
  check(`${P} max money is 2,147,483,647`, save.getMoney(ops.setMoney(base, ops.MAX_MONEY).career) === 2147483647);
  let threw = false; try { ops.setMoney(base, -1); } catch { threw = true; }
  check(`${P} negative money is refused`, threw);

  // The level rule must read a real, game-written career with no "custom mix" left over.
  if (REAL.includes(name)) {
    const nulls = s0.cars.flatMap((c) => c.tiers.map((t, i) => (t == null ? `${c.name}/${ops.PERF_GROUPS[i].code}` : null))).filter(Boolean);
    check(`${P} level rule reads every category of the real save`, nulls.length === 0, nulls.join(' ') || s0.cars.map((c) => `${c.name} ${c.tiers.join('')}`).join(', '));
  }

  // U3: lower parts left flagged beside Level 3 (a real career keeps them) and the camber kit off still read Level 3, and a car at
  // Level 3 with the transmission research picks counts as maxed. A real mix still reads as one.
  {
    const c = s0.cars[0], en = ops.PERF_GROUPS.find((g) => g.code === 'EN');
    let w = workingOf(ops.maxCar(base, c.index));
    for (const g of ops.PERF_GROUPS) for (const i of g.parts) w = perf.setPerfFlag(w, c.index, i, i !== 36);
    const read = ops.PERF_GROUPS.map((g) => ops.getTier(w, c.index, g));
    check(`${P} ${c.name} with every lower part still on and no camber kit reads Level 3 in every category`, read.every((t) => t === 3), read.join(''));
    const mix = ops.tierParts(en, 3).slice(1).reduce((x, i) => perf.setPerfFlag(x, c.index, i, true), en.parts.reduce((x, i) => perf.setPerfFlag(x, c.index, i, false), w));
    check(`${P} Level 3 engine parts with one missing still read as a custom mix`, ops.getTier(mix, c.index, en) === null);
    const lvl = (tr, en3 = 3) => ops.PERF_GROUPS.map((g) => (g.code === 'TR' ? tr : g.code === 'EN' ? en3 : 3));
    check(`${P} maxed means Level 3 with the research transmission`, ops.isMaxed(lvl(0), 'SUPRA') && ops.isMaxed(lvl(3), 'SUPRA') && ops.isMaxed(lvl(3), '240SX') &&
      !ops.isMaxed(lvl(0), '240SX') && !ops.isMaxed(lvl(2), 'SUPRA') && !ops.isMaxed(lvl(0, 2), 'SUPRA') && !ops.isMaxed(lvl(0, null), 'SUPRA'));
    const full = s0.cars.filter((x) => x.tiers.every((t) => t === 3));
    check(`${P} every car at Level 3 everywhere reads maxed`, full.every((x) => x.maxed), `${full.length} of ${s0.cars.length} at Level 3`);
  }

  // Max performance: Level 3 in every category of every car, the game's way, owned bits set.
  const p = ops.maxPerformance(base), ps = ops.summary(p, db);
  check(`${P} max performance: Level 3 everywhere on every car`, ps.cars.length > 0 && ps.cars.every((c) => c.tiers.every((t) => t === 3)) && sumsOk(p.career) && garageOk(p), `${ps.cars.length} cars`);
  const pw = workingOf(p), slot0 = s0.cars[0].index;
  check(`${P} max performance sets the owned bit of every part up to Level 3`, ops.PERF_GROUPS.every((g) => g.parts.every((i) => perf.getPerfPurchased(pw, slot0, i))));

  // One car, one category: each level reads back and only that car's part bytes change.
  const car = s0.cars[0], en = ops.PERF_GROUPS.find((g) => g.code === 'EN');
  const sb = layout.slotBase(car.index);
  const inPerf = (i) => (i >= sb + layout.PERF_OFF && i < sb + layout.PERF_OFF + 68) || (i >= sb + layout.PERF_PURCHASE_OFF && i < sb + layout.PERF_PURCHASE_OFF + 9);
  let tiersOk = true;
  for (const t of ops.TIERS) {
    const x = ops.setCarPerformance(base, car.index, { tiers: { EN: t.value } });
    const d = diff(base.career, x.career).filter((i) => !CHECKSUM_BYTES.has(i));
    if (ops.getTier(workingOf(x), car.index, en) !== t.value || !d.every(inPerf) || !sumsOk(x.career) || !garageOk(x)) tiersOk = false;
  }
  check(`${P} ${car.name} engine Stock, 1, 2, 3 read back and touch only that car's part bytes`, tiersOk);
  const uOn = ops.setCarPerformance(base, car.index, { uniques: { TU: true } }), uOff = ops.setCarPerformance(uOn, car.index, { uniques: { TU: false } });
  const uDiff = diff(base.career, uOn.career).filter((i) => !CHECKSUM_BYTES.has(i));
  const tuOff = sb + layout.UNIQUE_PERF_OFF + 4 * ops.PERF_GROUPS.find((g) => g.code === 'TU').unique;
  check(`${P} ${car.name} turbo unique on and off touches only its dword`, ops.summary(uOn, db).cars[0].uniques[4] && !ops.summary(uOff, db).cars[0].uniques[4] && uDiff.every((i) => i >= tuOff && i < tuOff + 4));
  // Single parts: only that part's flag byte and owned bit change, removing keeps it owned, the level follows.
  {
    const lv3 = ops.setCarPerformance(base, car.index, { tiers: { EN: 3 } });
    const enParts = ops.carParts(lv3, car.index).find((g) => g.code === 'EN');
    const top = enParts.parts.find((p) => p.level === 3 && p.on);
    const flagByte = perf.perfOffset(car.index, top.index);
    const off = ops.setCarParts(lv3, car.index, { [top.index]: false });
    const offDiff = diff(workingOf(lv3), workingOf(off)).filter((i) => !CHECKSUM_BYTES.has(i));
    const offRead = ops.carParts(off, car.index).find((g) => g.code === 'EN');
    check(`${P} ${car.name} removing one Level 3 engine part touches only its flag byte, keeps it owned, reads Custom mix`,
      offDiff.length === 1 && offDiff[0] === flagByte && offRead.tier === null && perf.getPerfPurchased(workingOf(off), car.index, top.index) && sumsOk(off.career) && garageOk(off),
      `${top.label}, changed ${offDiff.join(',')}, flag byte ${flagByte}`);
    const back = ops.setCarParts(off, car.index, { [top.index]: true });
    check(`${P} ${car.name} fitting it again reads Level 3 and the bytes equal the Level 3 write`, ops.carParts(back, car.index).find((g) => g.code === 'EN').tier === 3 && eq(back.career, lv3.career) && eq(back.garage, lv3.garage));
    const stock = ops.setCarPerformance(base, car.index, { tiers: { EN: 0 } });
    const one = enParts.parts.find((p) => p.level === 1);
    const fit = ops.setCarParts(stock, car.index, { [one.index]: true });
    const fitDiff = diff(workingOf(stock), workingOf(fit)).filter((i) => !CHECKSUM_BYTES.has(i));
    const ownB = perf.perfPurchaseOffset(car.index, one.index);
    check(`${P} ${car.name} fitting one part on a stock engine sets only its flag and owned bit`,
      fitDiff.every((i) => i === perf.perfOffset(car.index, one.index) || i === ownB) && perf.getPerfFlag(workingOf(fit), car.index, one.index) && perf.getPerfPurchased(workingOf(fit), car.index, one.index),
      `${one.label}, changed ${fitDiff.join(',')}`);
    let refused = 0;
    for (const bad of [{}, { 9999: true }, { [one.index]: 'yes' }, { 56: true }]) { try { ops.setCarParts(base, car.index, bad); } catch { refused++; } }
    check(`${P} setCarParts refuses an empty change, an unknown part, a non-boolean and a body-kit aero flag`, refused === 4, `${refused} of 4`);
  }
  const mc = ops.maxCar(base, car.index), mcs = ops.summary(mc, db);
  check(`${P} max this car leaves the other cars untouched`, mcs.cars[0].tiers.every((t) => t === 3) && mcs.cars[0].uniques.every(Boolean) &&
    mcs.cars.slice(1).every((c, i) => JSON.stringify({ ...c, name: 0 }) === JSON.stringify({ ...s0.cars[i + 1], name: 0 })));
  let badSlot = false; try { ops.maxCar(base, 99); } catch { badSlot = true; }
  check(`${P} a slot with no car is refused`, badSlot);

  // Preset: research parts (per-car transmission, no camber kit) plus the race setup.
  const setupAt = (k) => sb + dyno.TUNING_OFF + k * dyno.SETUP_SIZE;
  const inSetup = (i, ks) => ks.some((k) => i >= setupAt(k) && i < setupAt(k) + dyno.SETUP_SIZE);
  const trParts = ops.PERF_GROUPS.find((g) => g.code === 'TR').parts, camber = 36;
  const partBytes = new Set([...trParts, camber].flatMap((i) => [perf.perfOffset(car.index, i), perf.perfPurchaseOffset(car.index, i)]));
  // A preset keeps the parts of a car with another setup tuned (B7), so these checks start from the car with every
  // setup at the game's neutral bytes, as a car bought in game has.
  const fresh = (() => {
    const w = workingOf(base).slice();
    for (let k = 0; k < dyno.SETUP_COUNT; k++) w.fill(dyno.NEUTRAL_BYTE, setupAt(k), setupAt(k) + dyno.SETUP_SIZE);
    return { career: save.recalculateChecksums(w), garage: base.garage };
  })();
  const mcFresh = ops.maxCar(fresh, car.index);
  for (const [setup, label] of [[1, 'Drag'], [0, 'Circuit'], [2, 'Drift'], [3, 'Street X']]) {
    const pr = ops.applyPreset(fresh, car.index, setup, db);
    const prw = workingOf(pr.state);
    const written = setup === 0 ? [0, 4] : [setup];
    const prDiff = diff(workingOf(mcFresh), prw).filter((i) => !CHECKSUM_BYTES.has(i));
    check(`${P} ${car.name} ${label} preset changes only setup ${written.map((k) => k + 1).join(' and ')} and the transmission and camber parts on top of max parts`,
      prDiff.every((i) => inSetup(i, written) || partBytes.has(i)), `${prDiff.length} bytes`);
    const ps = ops.summary(pr.state, db).cars.find((c) => c.index === car.index);
    const targets = ops.researchSliders(car.name, setup);
    check(`${P} ${car.name} ${label} preset: ${ops.researchParts(car.name).TR ? 'Level 3' : 'stock'} transmission, every unique, camber kit off`,
      !pr.partsKept && ps.tiers[ops.PERF_GROUPS.findIndex((g) => g.code === 'TR')] === ops.researchParts(car.name).TR && ps.uniques.every(Boolean) && !perf.getPerfFlag(prw, car.index, camber));
    // Every slider lands on its published target: the slider's last byte step at either end (the game shows
    // about 9.95 there, as chilas's numbers do), or the shown value within one byte step.
    const rows = ops.setupSliders(pr.state, car.index, setup, db);
    const misses = Object.entries(targets).filter(([k, t]) => {
      const r = rows.find((x) => x.param === Number(k));
      if (!r) return false;
      if (t === 'min') return r.byte !== r.minByte;
      if (t === 'max') return r.byte !== r.maxByte;
      const step = (r.displayMax - r.displayMin) / Math.max(1, r.maxByte - r.minByte);
      return Math.abs(r.displayValue - t) > step * 0.51 + 1e-6;
    }).map(([k]) => k);
    check(`${P} ${car.name} ${label} preset sets every published slider`, misses.length === 0, misses.length ? `missed ${misses.join(',')}` : `${Object.keys(targets).length} sliders`);
    const reSim = ops.setupStats(pr.state, car.index, setup, db);
    check(`${P} ${car.name} ${label} preset re-simulates from the saved bytes to the reported result`, Math.abs(reSim.quarter - pr.after.quarter) < 1e-9 && Math.abs(reSim.top - pr.after.top) < 1e-9,
      `1/4 ${pr.before.quarter.toFixed(2)} to ${pr.after.quarter.toFixed(2)}s, top ${pr.before.top.toFixed(0)} to ${pr.after.top.toFixed(0)} mph`);
    if (setup === 0) {
      check(`${P} ${car.name} Circuit preset fills URL with the same bytes (Career uses Circuit tuning for URL)`,
        prw.subarray(setupAt(0), setupAt(1)).every((b, i) => b === prw[setupAt(4) + i]));
    }
  }
  // B7: parts are shared by every setup of the car. Circuit, then Drift on the result: the Drift preset keeps every
  // part Circuit fitted (the camber kit stays off) and changes only the Drift setup, and says the parts were kept.
  {
    const circuit = ops.applyPreset(fresh, car.index, 0, db).state;
    const drift = ops.applyPreset(circuit, car.index, 2, db);
    const cw = workingOf(circuit), dw = workingOf(drift.state);
    const moved = diff(cw, dw).filter((i) => !CHECKSUM_BYTES.has(i));
    check(`${P} B7 ${car.name} Drift after Circuit keeps the parts (camber kit stays off) and changes only the Drift setup`,
      drift.partsKept && moved.length > 0 && moved.every((i) => inSetup(i, [2])) && perf.getPerfFlag(dw, car.index, camber) === perf.getPerfFlag(cw, car.index, camber),
      `${moved.length} bytes, camber ${perf.getPerfFlag(cw, car.index, camber)} to ${perf.getPerfFlag(dw, car.index, camber)}`);
    // A tuned car with the camber kit on and a Level 1 transmission keeps both when a preset for another race type runs.
    let tuned = workingOf(circuit);
    tuned = perf.setPerfFlag(tuned, car.index, camber, true);
    const kept = ops.applyPreset({ career: tuned, garage: circuit.garage }, car.index, 1, db);
    check(`${P} B7 ${car.name} a preset on a car with another setup tuned leaves the camber kit and transmission alone`,
      kept.partsKept && perf.getPerfFlag(workingOf(kept.state), car.index, camber) && trParts.every((i) => perf.getPerfFlag(workingOf(kept.state), car.index, i) === perf.getPerfFlag(tuned, car.index, i)));
  }
  // Per-car transmission: Level 3 on the drag record cars (240SX, RX-7), stock elsewhere, whichever race type is pressed.
  const trIdx = ops.PERF_GROUPS.findIndex((g) => g.code === 'TR');
  check(`${P} the drag-gearbox car names exist in the game data`, ['240SX', 'RX7'].every((n) => db.dyno.cars.some((c) => c.name === n) && ops.researchParts(n).TR === 3));
  for (const c of s0.cars.filter((x) => ['240SX', 'COROLLA'].includes(x.name))) {
    const want = c.name === '240SX' ? 3 : 0;
    const got = [1, 0].map((setup) => ops.summary(ops.applyPreset(base, c.index, setup, db).state, db).cars.find((x) => x.index === c.index).tiers[trIdx]);
    check(`${P} ${c.name} Drag and Circuit presets both fit the ${want ? 'Level 3' : 'stock'} transmission`, got.every((t) => t === want), got.join(','));
  }
  // Ground truth: Ewil's published Corolla Circuit setup reads steering 1.14 (camber kit off), brake bias 0.21, nitrous 6 s.
  const corolla = s0.cars.find((c) => /COROLLA/.test(c.name));
  if (corolla) {
    const cr = ops.applyPreset(base, corolla.index, 0, db);
    const rows = ops.setupSliders(cr.state, corolla.index, 0, db), shown = (p) => rows.find((r) => r.param === p)?.displayValue;
    check(`${P} COROLLA Circuit preset shows Ewil's numbers: steering 1.14, brake bias 0.21, nitrous 6 s`,
      Math.abs(shown(8) - 1.14) < 0.005 && Math.abs(shown(18) - 0.21) < 0.006 && Math.abs(shown(16) - 6) < 0.06,
      `steering ${shown(8)?.toFixed(3)}, bias ${shown(18)?.toFixed(3)}, nitrous ${shown(16)?.toFixed(2)}`);
  }
  // Best car: on one car with a tuned setup and one without (the full search takes 10-50 s a car).
  const slotSize = layout.slotBase(1) - layout.slotBase(0);
  const sliderMisses = (state, slot, carName, setup) => {
    const targets = ops.researchSliders(carName, setup), rows = ops.setupSliders(state, slot, setup, db);
    return Object.entries(targets).filter(([k, t]) => {
      const r = rows.find((x) => x.param === Number(k));
      if (!r) return false;
      if (t === 'min') return r.byte !== r.minByte;
      if (t === 'max') return r.byte !== r.maxByte;
      // A car with lower parts can have a shorter range (Level 1 nitrous lasts 1-3 s): the target clamps to it.
      // An out-of-range target sits on the slider's end byte, which the game shows a step short (2.98 for 3).
      const lo = Math.min(r.displayMin, r.displayMax), hi = Math.max(r.displayMin, r.displayMax);
      if (t < lo || t > hi) {
        const endByte = (t > hi) === (r.displayMax >= r.displayMin) ? r.maxByte : r.minByte;
        return r.byte !== endByte;
      }
      const step = (hi - lo) / Math.max(1, r.maxByte - r.minByte);
      return Math.abs(r.displayValue - t) > step * 0.51 + 1e-6;
    }).map(([k]) => k);
  };
  const picks = [...new Set([s0.cars.find((c) => c.tuned.some(Boolean)), s0.cars.find((c) => !c.tuned.some(Boolean)), s0.cars.find((c) => c.name.endsWith('240SX') && !c.tuned.some(Boolean))])].filter(Boolean);
  for (const bc of picks) {
    const Q = `${P} ${bc.name} best car`;
    const t0 = Date.now();
    const { state: bs, report } = ops.bestCar(base, bc.index, db);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const bw = workingOf(bs), w0 = workingOf(base), lo = layout.slotBase(bc.index);
    const at = (k) => lo + dyno.TUNING_OFF + k * dyno.SETUP_SIZE;
    const bDiff = diff(w0, bw).filter((i) => !CHECKSUM_BYTES.has(i));
    check(`${Q} changes only this car's slot`, bDiff.every((i) => i >= lo && i < lo + slotSize) && sumsOk(bs.career) && garageOk(bs), `${bDiff.length} bytes, ${secs}s`);
    const after = ops.summary(bs, db), bcAfter = after.cars.find((c) => c.index === bc.index);
    check(`${Q} leaves the other cars untouched`, after.cars.filter((c) => c.index !== bc.index).every((c) => JSON.stringify(c) === JSON.stringify(s0.cars.find((x) => x.index === c.index))));
    const tunedKept = bc.tuned.map((t, k) => (t ? k : -1)).filter((k) => k >= 0);
    check(`${Q} keeps every setup the player tuned byte for byte`, tunedKept.every((k) => eq(w0.subarray(at(k), at(k) + dyno.SETUP_SIZE), bw.subarray(at(k), at(k) + dyno.SETUP_SIZE))),
      tunedKept.length ? `kept ${tunedKept.map((k) => ops.SETUPS[k].label).join(', ')}` : 'none tuned');
    const trI = ops.PERF_GROUPS.findIndex((g) => g.code === 'TR');
    const partsOk = report.partsKept
      ? JSON.stringify(bcAfter.tiers) === JSON.stringify(bc.tiers) && perf.getPerfFlag(bw, bc.index, camber) === perf.getPerfFlag(w0, bc.index, camber)
      : report.transmission === (/240SX|RX-7/.test(bc.name) ? 3 : 0) && bcAfter.tiers.every((t, i) => t === (i === trI ? report.transmission : 3)) && bcAfter.maxed && !perf.getPerfFlag(bw, bc.index, camber);
    check(`${Q} ${report.partsKept ? 'keeps the parts of a car with a tuned setup' : `fits Level 3 with the ${report.transmission ? 'Level 3' : 'stock'} transmission and no camber kit`}, every unique on`,
      report.partsKept === tunedKept.length > 0 && partsOk && bcAfter.uniques.every(Boolean), bcAfter.tiers.map((t) => t ?? 'mix').join(','));
    const aeroOn = [56, 62, 59, 65].every((first) => bw[lo + layout.PERF_OFF + first + 2] === 1);
    check(`${Q} sets every body-kit aero flag to Level 3`, aeroOn, report.aero.length ? report.aero.map((a) => `${a.label} ${a.part}`).join(', ') : 'kit already Level 3');
    // A group may stay plain only when carbon there would remove a vinyl layer, and the report must say so.
    const plainGroups = ops.CARBON_GROUPS.filter((g, i) => bcAfter.carbon[i] === 'plain').map((g) => g.label);
    const vinylCost = (label) => {
      const code = ops.CARBON_GROUPS.find((g) => g.label === label).code;
      const v0 = visual.readVisual(bw, bc.index), v1 = visual.readVisual(workingOf(ops.setCarbon(bs, bc.index, true, db, [code])), bc.index);
      return [64, 65, 66, 67].some((v) => v0[v] !== v1[v]);
    };
    check(`${Q} leaves no plain part that has a carbon version, except where carbon would remove a vinyl`,
      JSON.stringify(plainGroups) === JSON.stringify(report.carbonKept) && plainGroups.every(vinylCost), `${bcAfter.carbon.join('/')}${report.carbonKept.length ? `, kept plain: ${report.carbonKept.join(', ')}` : ''}`);
    // The row badge reads summary.best: a maxed car Best car has finished is Best, vinyl-kept groups included
    // (2026-11-16: the 240SX and RX-7 read "Maxed" with 5/5 setups after Best version of every car).
    check(`${Q} reads Best in the summary when it ends maxed, and not otherwise`, bcAfter.best === bcAfter.maxed,
      `best ${bcAfter.best}, maxed ${bcAfter.maxed}, kept plain ${JSON.stringify(bcAfter.carbonKept)}`);
    // Too loose guard: a group put back to plain that carbon would not cost a vinyl is not a kept group.
    const carbonI = bcAfter.carbon.findIndex((x, i) => x === 'carbon' && ops.CARBON_GROUPS[i].code !== 'kit');
    if (carbonI >= 0) {
      const g = ops.CARBON_GROUPS[carbonI], plainOne = ops.summary(ops.setCarbon(bs, bc.index, false, db, [g.code]), db).cars.find((c) => c.index === bc.index);
      check(`${Q} is no longer Best with its ${g.label.toLowerCase()} put back to plain`, plainOne.carbon[carbonI] === 'plain' && plainOne.best === false,
        `best ${plainOne.best}, kept plain ${JSON.stringify(plainOne.carbonKept)}`);
    }
    const refs0 = visual.readVisual(w0, bc.index), refs1 = visual.readVisual(bw, bc.index);
    check(`${Q} leaves paint, rims and vinyls alone`, [63, 29, 64, 65, 66, 67, 105].every((v) => refs0[v] === refs1[v]));
    const writtenSetups = report.setups.filter((s) => !s.kept);
    const missed = writtenSetups.flatMap((s) => sliderMisses(bs, bc.index, bc.name, s.setup).map((k) => `${s.label}:${k}`));
    check(`${Q} writes the research sliders into every untuned setup`, writtenSetups.length + report.setups.filter((s) => s.kept).length === 4 && missed.length === 0,
      missed.length ? `missed ${missed.join(',')}` : writtenSetups.map((s) => s.label).join(', ') || 'all kept');
    if (!bc.tuned[0] && !bc.tuned[4]) {
      check(`${Q} fills URL with the Circuit bytes`, bw.subarray(at(0), at(1)).every((b, i) => b === bw[at(4) + i]));
    }
    const again = ops.bestCar(bs, bc.index, db);
    check(`${Q} run twice changes nothing more`, eq(again.state.career, bs.career) && eq(again.state.garage, bs.garage) && again.report.setups.every((s) => s.kept));
  }

  const u = ops.applyUniques(base), us = ops.summary(u, db);
  check(`${P} all 9 unique upgrades on every car`, us.cars.every((c) => c.uniques.length === 9 && c.uniques.every(Boolean)) && sumsOk(u.career) && garageOk(u));

  // Unlock all, with game data: story finished, no part gate left. Without game data it refuses.
  const a = ops.unlockAll(base, db), as = ops.summary(a, db);
  check(`${P} unlock all finishes the story`, as.stage === 6 && as.report.complete, `${as.report.percent.toFixed(0)}%`);
  check(`${P} unlock all leaves 0 locked part gates (pearlescent included)`, as.report.partsFailing === 0, `${as.report.partsFailing} of ${as.report.partsTotal}`);
  check(`${P} unlock all fills every car's unlock table and opens every slot`, as.cars.every((c) => c.unlocks === c.unlocksTotal) && as.lockedSlots === 0 && sumsOk(a.career) && garageOk(a));
  let unlockNoDb = ''; try { ops.unlockAll(base, null); } catch (err) { unlockNoDb = err.message; }
  check(`${P} unlock all without game data is refused`, /game data/.test(unlockNoDb), unlockNoDb || 'it ran');
  check(`${P} unlock all leaves nothing locked, carbon conversions included`, ops.lockedCategories(a, db).length === 0, ops.lockedCategories(a, db).slice(0, 2).join('; '));

  // Stage picker: every value reads back and touches only the stage dword.
  let stagesOk = true;
  for (const st of ops.STAGES) {
    const x = ops.setStage(base, st.value);
    const d = diff(base.career, x.career).filter((i) => !CHECKSUM_BYTES.has(i));
    if (ops.summary(x, db).stage !== st.value || !d.every((i) => i >= layout.CURRENT_STAGE_OFF && i < layout.CURRENT_STAGE_OFF + 4) || !sumsOk(x.career)) stagesOk = false;
  }
  check(`${P} stage picker 0-6 reads back, touches only the stage`, stagesOk);

  // Carbon: the game-written state reads back, all carbon / all plain flip only carbon-capable parts of that car.
  if (s0.cars[0].name === 'MIATA' && [process.env.NFSU2_MAIN_PROFILE, 'QATEST'].includes(name)) {
    check(`${P} the game-written Miata reads hood plain, spoiler, roof scoop and mirrors carbon, body kit plain`, s0.cars[0].carbon.join() === 'plain,carbon,carbon,carbon,plain', s0.cars[0].carbon.join());
  }
  const visualBlock = (slot) => [layout.slotBase(slot) + layout.VISUAL_OFF, layout.slotBase(slot) + layout.VISUAL_OFF + layout.VISUAL_COUNT * 4];
  const aeroBlock = (slot) => [layout.slotBase(slot) + layout.PERF_OFF + 56, layout.slotBase(slot) + layout.PERF_OFF + 68];
  const inside = (i, blocks) => blocks.some(([lo, hi]) => i >= lo && i < hi);
  const cOn = ops.setCarbon(base, null, true, db), cOff = ops.setCarbon(base, null, false, db);
  const sOn = ops.summary(cOn, db), sOff = ops.summary(cOff, db);
  check(`${P} all carbon on every car leaves no plain part that has a carbon twin`, sOn.cars.every((c) => !c.carbon.includes('plain')) && sumsOk(cOn.career) && garageOk(cOn), sOn.cars.map((c) => c.carbon.join('/')).join(' '));
  check(`${P} all plain on every car leaves no carbon part`, sOff.cars.every((c) => !c.carbon.includes('carbon')) && sumsOk(cOff.career) && garageOk(cOff));
  const carSlots = s0.cars.map((c) => c.index);
  const cDiff = diff(workingOf(base), workingOf(cOn)).filter((i) => !CHECKSUM_BYTES.has(i));
  check(`${P} all carbon writes only visual part hashes and body-kit aero flags`, cDiff.length > 0 && cDiff.every((i) => inside(i, carSlots.flatMap((s) => [visualBlock(s), aeroBlock(s)]))), `${cDiff.length} bytes`);
  const one = ops.setCarbon(base, car.index, true, db, ['hood']);
  const oneDiff = diff(workingOf(base), workingOf(one)).filter((i) => !CHECKSUM_BYTES.has(i));
  const hoodBefore = s0.cars[0].carbon[0];
  check(`${P} ${car.name} hood carbon touches only that car's visual block`, hoodBefore !== 'plain' || (oneDiff.length > 0 && oneDiff.every((i) => inside(i, [visualBlock(car.index)])) && ops.summary(one, db).cars[0].carbon[0] === 'carbon'), `hood was ${hoodBefore}, ${oneDiff.length} bytes`);
  check(`${P} carbon and plain twice are no-ops`, eq(ops.setCarbon(cOn, null, true, db).career, cOn.career) && eq(ops.setCarbon(cOff, null, false, db).career, cOff.career));
  // Body kit: carbon writes only slot 93 (plus the vinyls the game clears); on a stock kit no toggle is offered.
  const kitIdx = ops.CARBON_GROUPS.findIndex((g) => g.code === 'kit');
  const vis = await import('../vendor/hackch/model/visual.js'), slotsMod = await import('../vendor/hackch/model/slots.js');
  const stateOf = (st, w) => { const career = save.recalculateChecksums(w.subarray(0, layout.PROFILE_SIZE)); return { career, garage: st.garage ? web.buildGarage(st.garage, w, career) : null }; };
  const kitCar = s0.cars.find((c) => c.carbon[kitIdx] === 'plain');
  if (kitCar) {
    const k = ops.setCarbon(base, kitCar.index, true, db, ['kit']);
    const kDiff = diff(workingOf(base), workingOf(k)).filter((i) => !CHECKSUM_BYTES.has(i));
    const vb = visualBlock(kitCar.index)[0], kitSlot = [vb + 93 * 4, vb + 97 * 4], vinyls = [vb + 64 * 4, vb + 68 * 4];
    const kRefs = vis.readVisual(workingOf(k), kitCar.index), kHash = slotsMod.getCarTypeHash(workingOf(k), kitCar.index);
    check(`${P} ${kitCar.name} body kit carbon writes slots 93-96 and cleared vinyls only, all four on`, kDiff.length > 0 && kDiff.every((i) => inside(i, [kitSlot, vinyls])) &&
      [93, 94, 95, 96].every((v) => kRefs[v] === ops.carbonSwitch(catalog, kHash, v).on) && ops.summary(k, db).cars.find((c) => c.index === kitCar.index).carbon[kitIdx] === 'carbon', `${kDiff.length} bytes`);
    const back = ops.setCarbon(k, kitCar.index, false, db, ['kit']);
    check(`${P} ${kitCar.name} body kit plain again reads plain`, ops.summary(back, db).cars.find((c) => c.index === kitCar.index).carbon[kitIdx] === 'plain');
    let w = workingOf(base); const carHash = slotsMod.getCarTypeHash(w, kitCar.index);
    for (const v of [6, 1, 2, 11]) w = catalog.edit(w, kitCar.index, v, catalog.options(carHash, v).find((p) => p.level === 0)?.hash ?? 0);
    check(`${P} ${kitCar.name} on a stock kit offers no body kit toggle`, [6, 1, 2, 11].some((v) => vis.readVisual(w, kitCar.index)[v] !== vis.readVisual(workingOf(base), kitCar.index)[v]) && ops.summary(stateOf(base, w), db).cars.find((c) => c.index === kitCar.index).carbon[kitIdx] === null);
    // Stuck carbon: flags left on after the kit went stock still read carbon, and Plain clears every one.
    let st = workingOf(k);
    for (const v of [6, 1, 2, 11]) st = catalog.edit(st, kitCar.index, v, catalog.options(carHash, v).find((p) => p.level === 0)?.hash ?? 0);
    const stuck = stateOf(base, st), stuckRead = ops.summary(stuck, db).cars.find((c) => c.index === kitCar.index).carbon[kitIdx];
    const freed = vis.readVisual(workingOf(ops.setCarbon(stuck, kitCar.index, false, db, ['kit'])), kitCar.index);
    check(`${P} ${kitCar.name} carbon flags on a stock kit read carbon and Plain clears all four`, stuckRead === 'carbon' && [93, 94, 95, 96].every((v) => freed[v] === ops.carbonSwitch(catalog, carHash, v).off), stuckRead);
  }
  // A real career: carbon wide kits set 93-96 on every car; the body kit switch must read carbon and clear all four.
  const allKit = ops.setCarbon(base, null, false, db, ['kit']);
  const kitLeft = s0.cars.filter((c) => { const r = vis.readVisual(workingOf(allKit), c.index), h = slotsMod.getCarTypeHash(workingOf(allKit), c.index); return [93, 94, 95, 96].some((v) => r[v] === ops.carbonSwitch(catalog, h, v)?.on); });
  check(`${P} body kit plain on every car leaves no carbon flag in 93-96`, kitLeft.length === 0 && ops.summary(allKit, db).cars.every((c) => c.carbon[kitIdx] !== 'carbon'), `start ${s0.cars.map((c) => c.carbon[kitIdx]).join('/')}`);
  let noDb = false; try { ops.setCarbon(base, null, true, null); } catch { noDb = true; }
  check(`${P} carbon without game data is refused`, noDb);

  // Looks: every car's editor lists the fitted value among its choices, labels are unique, and a write
  // touches only that car's visual block (plus aero flags for body parts), with the game's side effects.
  const eds = s0.cars.map((c) => ({ c, ed: ops.visualEditor(base, c.index, db) }));
  const edSlots = eds.flatMap(({ ed }) => ed.flatMap((g) => g.slots));
  check(`${P} the looks editor opens on every car with every fitted value among its choices`,
    eds.every(({ ed }) => ed.length >= 8) && edSlots.every((s) => s.options.some((o) => o.hash === s.value)), `${edSlots.length} slots on ${eds.length} cars`);
  check(`${P} looks choices have unique labels per slot`, edSlots.every((s) => new Set(s.options.map((o) => o.label)).size === s.options.length));
  check(`${P} looks never offers the carbon slots 93-96`, edSlots.every((s) => s.id < 93 || s.id > 96));
  const ed = eds[0].ed, find = (id) => ed.flatMap((g) => g.slots).find((s) => s.id === id);
  const vb0 = visualBlock(car.index)[0], slotBytes = (id) => [vb0 + id * 4, vb0 + id * 4 + 4];
  const changed = (st) => diff(workingOf(base), workingOf(st)).filter((i) => !CHECKSUM_BYTES.has(i));
  const paint = find(63), paintPick = paint.options.find((o) => o.hash !== paint.value);
  const paintW = ops.setVisual(base, car.index, 63, paintPick.hash, db), pDiff = changed(paintW);
  check(`${P} ${car.name} body paint writes only its 4 bytes and reads back`, pDiff.length > 0 && pDiff.every((i) => inside(i, [slotBytes(63)])) && vis.readVisual(workingOf(paintW), car.index)[63] === paintPick.hash && sumsOk(paintW.career) && garageOk(paintW), paintPick.label);
  const rims = find(29), rimPick = rims.options.find((o) => o.hash !== rims.value && o.size);
  const rw = ops.setVisual(base, car.index, 29, rimPick.hash, db), rRefs = vis.readVisual(workingOf(rw), car.index);
  check(`${P} ${car.name} rims set the rear wheel too and nothing else`, rRefs[29] === rimPick.hash && rRefs[30] === rimPick.hash && changed(rw).every((i) => inside(i, [slotBytes(29), slotBytes(30)])), rimPick.label);
  const neon = find(154), neonPick = neon.options.find((o) => o.hash !== neon.value && o.color);
  const nw = ops.setVisual(base, car.index, 154, neonPick.hash, db);
  check(`${P} ${car.name} neon reads back in the editor`, ops.visualEditor(nw, car.index, db).flatMap((g) => g.slots).find((s) => s.id === 154).value === neonPick.hash, neonPick.label);
  check(`${P} writing the fitted value again changes nothing`, eq(ops.setVisual(base, car.index, 63, paint.value, db).career, base.career));
  const wide = find(6).options.find((o) => o.label !== 'NO WIDEBODY' && o.hash !== 0);
  let hiddenRefused = false;
  if (wide) {
    const ww = ops.setVisual(base, car.index, 6, wide.hash, db);
    const front = ops.visualEditor(ww, car.index, db).flatMap((g) => g.slots).find((s) => s.id === 1);
    try { ops.setVisual(ww, car.index, 1, front.options.find((o) => o.hash !== front.value).hash, db); } catch { hiddenRefused = front.hidden; }
  }
  check(`${P} ${car.name} a wide body hides the front bumper and its write is refused`, hiddenRefused, wide?.label);
  const refused = (fn) => { try { fn(); return false; } catch { return true; } };
  check(`${P} looks refuses a carbon slot, a bad hash, a part from another slot and no game data`,
    refused(() => ops.setVisual(base, car.index, 94, 0, db)) && refused(() => ops.setVisual(base, car.index, 63, -1, db)) &&
    refused(() => ops.setVisual(base, car.index, 63, rimPick.hash, db)) && refused(() => ops.setVisual(base, car.index, 63, paintPick.hash, null)));

  // Idempotence: the second click changes nothing.
  check(`${P} second click is a no-op`, eq(ops.maxPerformance(p).career, p.career) && eq(ops.applyUniques(u).career, u.career) && eq(ops.unlockAll(a, db).career, a.career));

  // Undo: record before every write, apply everything in a chain, undo in reverse, compare bytes.
  const mem = new Map(), store = { get: async (k) => mem.get(k) && JSON.parse(mem.get(k)), set: async (k, v) => { mem.set(k, JSON.stringify(v)); } };
  const key = hist.historyKey('save', name);
  const steps = [
    ['money', (s) => ops.setMoney(s, 777)], ['perf', ops.maxPerformance], ['uniques', ops.applyUniques],
    ['unlock', (s) => ops.unlockAll(s, db)], ['stage', (s) => ops.setStage(s, 2)],
    ['engine level 1', (s) => ops.setCarPerformance(s, car.index, { tiers: { EN: 1 } })],
    ['drift preset', (s) => ops.applyPreset(s, car.index, 2, db).state],
    ['all carbon', (s) => ops.setCarbon(s, null, true, db)], ['hood plain', (s) => ops.setCarbon(s, car.index, false, db, ['hood'])],
    ['body paint', (s) => ops.setVisual(s, car.index, 63, paintPick.hash, db)], ['rims', (s) => ops.setVisual(s, car.index, 29, rimPick.hash, db)],
  ];
  let cur = base; const states = [base];
  for (const [label, fn] of steps) { const next = fn(cur); await hist.record(store, key, label, cur, next); cur = next; states.push(cur); }
  const h = await hist.load(store, key);
  let undoOk = h.entries.length === steps.length;
  for (let i = h.entries.length - 1; i >= 0; i--) {
    const back = hist.decode(h.entries[i]);
    if (!eq(back.career, states[i].career) || !eq(back.garage, states[i].garage)) undoOk = false;
  }
  check(`${P} undo of each of ${steps.length} edits restores the exact bytes`, undoOk);
  const orig = hist.decode(h.original);
  check(`${P} restore original is byte identical to the untouched files`, eq(orig.career, base.career) && eq(orig.garage, base.garage));
  check(`${P} history hashes match the states`, h.entries.every((e, i) => e.beforeHash && e.afterHash) && h.original.hash === await hist.stateHash(base));

  // Plant: a one-byte change in a snapshot must fail the same comparison.
  const planted = hist.decode(h.entries[0]); planted.career[layout.MONEY_OFF] ^= 1;
  check(`${P} planted byte in a snapshot is caught`, !eq(planted.career, states[0].career));

  // Drop: a refused write leaves no entry and no original behind.
  const mem2 = new Map(), store2 = { get: async (k) => mem2.get(k), set: async (k, v) => { mem2.set(k, v); } };
  const e1 = await hist.record(store2, key, 'refused', base, m);
  await hist.drop(store2, key, e1.id);
  const h2 = await hist.load(store2, key);
  check(`${P} a refused first write leaves no history`, h2.entries.length === 0 && h2.original === null);
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exitCode = fail ? 1 : 0;
