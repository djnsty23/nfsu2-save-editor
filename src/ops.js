// Pure edit operations on one nfsu2.xyz profile: { career, garage }.
// Every function returns new bytes and never mutates its input.
// The save model is hackch (MIT, Copyright (c) 2025 Christopher Hack), vendored under vendor/hackch.
import * as layout from '../vendor/hackch/model/layout.js';
import * as save from '../vendor/hackch/model/save-file.js';
import * as web from '../vendor/hackch/model/nfsu2-web.js';
import * as slots from '../vendor/hackch/model/slots.js';
import * as perf from '../vendor/hackch/model/perf.js';
import * as unlocks from '../vendor/hackch/model/unlocks.js';
import * as career from '../vendor/hackch/model/career.js';
import * as dyno from '../vendor/hackch/model/dyno.js';
import * as visual from '../vendor/hackch/model/visual.js';
import { buildDonor, donorProblem, readRatings } from './donors.js';
import { CAR_NAMES, displayName } from './car-names.js';
import { decompressJdlz, isJdlz } from './jdlz.js';
import * as designs from './garage-designs.js';
import { UNLOCK_CATEGORIES } from '../vendor/hackch/data/unlock-table.js';
import { PERF_PARTS, TUNING_PERF_CATEGORIES, TUNING_PERF_INDICES, UNIQUE_PERF_PARTS } from '../vendor/hackch/data/perf-parts.js';

export const MAX_MONEY = layout.MAX_MONEY;
/** The Max button. Far below the int32 ceiling, so race winnings can never wrap the money negative. */
export const MAX_BUTTON_MONEY = 9_999_999;
/** Highest amount the field accepts: 9 digits leaves room for every prize in the game. */
export const FIELD_MAX_MONEY = 999_999_999;
export const UNIQUE_PARTS = UNIQUE_PERF_PARTS.map((u) => ({ index: u.index, label: u.label }));
export const STAGES = [
  { value: 0, label: 'Stage 1' }, { value: 1, label: 'Stage 2' }, { value: 2, label: 'Stage 3' },
  { value: 3, label: 'Stage 4' }, { value: 4, label: 'Stage 5' }, { value: 5, label: 'Final stage' },
  { value: 6, label: 'Career finished' },
];

/** Throws unless the bytes are a valid career profile and, when present, a matching GARAGE.DAT. */
export function validate(state) {
  if (!(state.career instanceof Uint8Array)) throw new TypeError('Career bytes missing.');
  const check = save.checkSave(state.career);
  if (!check.ok) throw new Error(check.error);
  if (state.career.length !== layout.PROFILE_SIZE) throw new Error(`Career save is ${state.career.length} bytes, expected ${layout.PROFILE_SIZE}.`);
  return garageUsable(state);
}

/**
 * The checks every write passes first, Undo snapshots and imported history included: a career that validate accepts,
 * and a GARAGE.DAT, when there is one, of the right size and signature. Throws with the reason.
 */
export function validateWrite(state) {
  validate(state);
  const g = state.garage;
  if (g != null && (!(g instanceof Uint8Array) || g.length !== web.GARAGE_SIZE || web.GARAGE_MAGIC.some((b, i) => g[i] !== b))) {
    throw new Error(`GARAGE.DAT is ${g?.length ?? 0} bytes or has the wrong signature, expected ${web.GARAGE_SIZE} bytes starting N2GA.`);
  }
}

function garageUsable(state) {
  if (!state.garage) return false;
  return web.checkGarage(state.garage, state.career).state === 'loaded';
}

function working(state) {
  return garageUsable(state) ? web.mergeGarage(state.career, state.garage) : state.career.slice();
}

function finish(state, data) {
  const careerOut = save.recalculateChecksums(data.subarray(0, layout.PROFILE_SIZE));
  const garageOut = garageUsable(state) ? web.buildGarage(state.garage, data, careerOut) : state.garage;
  return { career: careerOut, garage: garageOut };
}

function usedSlots(data) {
  const out = [];
  for (let s = 0; s < layout.slotCount(data); s++) if (slots.isSlotUsed(data, s)) out.push(s);
  return out;
}

/** Story progress from the career bytes alone (no game data): events won and the current stage. Both only go up in game. */
export function careerProgress(careerBytes) {
  const dv = layout.dataView(careerBytes);
  return { events: dv.getUint32(career.EVENT_COUNT_OFF, true), stage: dv.getUint32(layout.CURRENT_STAGE_OFF, true) };
}

export function setMoney(state, value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_MONEY) throw new RangeError(`Money must be a whole number from 0 to ${MAX_MONEY.toLocaleString('en-US')}.`);
  return finish(state, save.setMoney(working(state), value));
}

// ---- Performance levels per car ---------------------------------------------------------------
// Each category sells Level 1, 2 and 3 parts. A higher part replaces the lower part it conflicts with
// (Level 2 headers replace Level 1 headers), and the owned bits keep every part bought up to the level.
// This rule reproduces every category of a real career save; test/ops.test.mjs checks it.

export const TIERS = [
  { value: 0, label: 'Stock' }, { value: 1, label: 'Level 1' }, { value: 2, label: 'Level 2' }, { value: 3, label: 'Level 3' },
];
export const PERF_GROUPS = TUNING_PERF_CATEGORIES.map((c, unique) => ({
  code: c.code, label: c.label, unique,
  parts: c.indices.filter((i) => PERF_PARTS[i].active),
}));
function groupByCode(code) {
  const g = PERF_GROUPS.find((x) => x.code === code);
  if (!g) throw new RangeError(`Unknown performance category ${code}.`);
  return g;
}

/** Parts installed at a level: every part up to it, minus those a higher part up to it replaces. */
export function tierParts(group, tier) {
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) throw new RangeError('Level must be 0 to 3.');
  const upTo = group.parts.filter((i) => PERF_PARTS[i].level <= tier);
  return upTo.filter((i) => !PERF_PARTS[i].conflicts.some((j) => upTo.includes(j) && PERF_PARTS[j].level > PERF_PARTS[i].level));
}

const CAMBER_KIT = PERF_PARTS.findIndex((p) => p.label === 'Camber Kit');

/**
 * The level a car's installed parts reach, or null when they reach none (a custom mix). A level counts when every
 * part it installs is on and no higher part is. Lower parts left flagged beside a higher one do not lower it (a save
 * can keep them, a real career does), and the camber kit is left out: it is a per-car choice the setups make.
 */
export function getTier(data, slot, group) {
  const on = group.parts.filter((i) => i !== CAMBER_KIT && perf.getPerfFlag(data, slot, i));
  if (!on.length) return 0;
  for (let tier = 3; tier >= 1; tier--) {
    if (on.some((i) => PERF_PARTS[i].level > tier)) continue;
    if (tierParts(group, tier).every((i) => i === CAMBER_KIT || on.includes(i))) return tier;
  }
  return null;
}

/**
 * Whether a car is maxed: Level 3 in every category, except the transmission, which may also sit at the level the
 * research picks for that car (stock on most cars). `carName` is its game data name, or null when unknown.
 */
export function isMaxed(tiers, carName) {
  const tr = carName ? researchParts(carName).TR : 0;
  return tiers.every((t, i) => t === 3 || (PERF_GROUPS[i].code === 'TR' && t === tr));
}

function setOwned(data, slot, index, on) {
  const out = data.slice();
  const off = perf.perfPurchaseOffset(slot, index), bit = 1 << (index & 7);
  out[off] = on ? out[off] | bit : out[off] & ~bit;
  return out;
}

function applyTier(data, slot, group, tier) {
  const want = tierParts(group, tier);
  for (const i of group.parts) {
    data = perf.setPerfFlag(data, slot, i, want.includes(i));
    data = setOwned(data, slot, i, PERF_PARTS[i].level <= tier);
  }
  return data;
}

function checkSlot(data, slot) {
  if (!usedSlots(data).includes(slot)) throw new RangeError(`Garage slot ${slot + 1} has no car.`);
}

/**
 * One car's performance: levels and uniques by category code, for example
 * { tiers: { EN: 3 }, uniques: { EN: true } }. Categories left out stay as they are.
 */
export function setCarPerformance(state, slot, { tiers = {}, uniques = {} } = {}) {
  let data = working(state);
  checkSlot(data, slot);
  for (const [code, tier] of Object.entries(tiers)) data = applyTier(data, slot, groupByCode(code), tier);
  for (const [code, on] of Object.entries(uniques)) data = perf.setUniquePerfFlag(data, slot, groupByCode(code).unique, !!on);
  return finish(state, data);
}

/**
 * One car's performance parts, per category: each part's index, label, level, whether it is fitted (on), whether
 * the car owns it, the higher parts that would replace it (higher), and the fitted one that does (replacedBy). Levels come from getTier, so a part can be
 * off and the category still read Level 3 when a higher part replaces it.
 */
export function carParts(state, slot) {
  const data = working(state);
  checkSlot(data, slot);
  return PERF_GROUPS.map((g) => ({
    code: g.code, label: g.label, tier: getTier(data, slot, g),
    parts: g.parts.map((i) => {
      const p = PERF_PARTS[i];
      const higher = p.conflicts.filter((j) => g.parts.includes(j) && PERF_PARTS[j].level > p.level);
      const by = higher.find((j) => perf.getPerfFlag(data, slot, j));
      return {
        index: i, label: p.label, level: p.level,
        on: perf.getPerfFlag(data, slot, i), owned: perf.getPerfPurchased(data, slot, i),
        higher, replacedBy: by == null ? null : PERF_PARTS[by].label,
      };
    }),
  }));
}

const PART_GROUP = new Map(PERF_GROUPS.flatMap((g) => g.parts.map((i) => [i, g])));

/**
 * Fit or remove single parts on one car: { partIndex: true | false }. Fitting a part also marks it owned, as the
 * game's shop does. Removing one keeps it owned, so the game lists it as bought and it can go back on for free.
 * Only the named parts' installed flags and owned bits change. Unknown parts and an empty change are refused.
 */
export function setCarParts(state, slot, changes) {
  const entries = Object.entries(changes ?? {});
  if (!entries.length) throw new RangeError('No parts to change.');
  let data = working(state);
  checkSlot(data, slot);
  for (const [k, on] of entries) {
    const i = Number(k);
    if (!Number.isInteger(i) || !PART_GROUP.has(i)) throw new RangeError(`Unknown performance part ${k}.`);
    if (typeof on !== 'boolean') throw new TypeError(`Part ${k} needs true or false.`);
    data = perf.setPerfFlag(data, slot, i, on);
    if (on) data = setOwned(data, slot, i, true);
  }
  return finish(state, data);
}

/**
 * The dyno at a neutral setup for one car's parts, with { partIndex: bool } changes applied on top of what is
 * fitted, without writing anything: power, quarter mile, 0-60, top speed, and the setup controls those parts make
 * adjustable with the range each one allows. Null without game data. The dyno does not model every part (nitrous,
 * brakes, suspension and tires change no number here), so read a zero change as "not on the dyno".
 */
export function partsDyno(state, slot, db, changes = {}) {
  const data = working(state);
  checkSlot(data, slot);
  const d = dyno.readSlotDyno(data, slot);
  const car = dynoCar(db, d.hash);
  if (!car) return null;
  const installed = d.installed.slice();
  for (const [k, on] of Object.entries(changes)) {
    const i = Number(k);
    if (!PART_GROUP.has(i)) throw new RangeError(`Unknown performance part ${k}.`);
    installed[i] = !!on;
  }
  const game = { cars: [car], packages: db.dyno.packages, tuning: db.dyno.tuning };
  const model = new dyno.DynoModel(game, car, installed, d.uniques);
  const neutral = new Array(dyno.SETUP_SIZE).fill(dyno.NEUTRAL_BYTE);
  const controls = {};
  for (const r of model.scalarTuning(neutral)) if (r.editable) controls[r.label] = [r.min, r.max];
  for (const r of model.gearing(neutral)?.rows ?? []) controls[r.label] = [r.min, r.max];
  if (model.ecuTunable) controls['ECU curve'] = [0, 1];
  if (model.turboTunable) controls['Turbo curve'] = [0, 1];
  return { ...stats(model.evaluate(neutral)), controls };
}

/**
 * What one part's change does to the setup controls: the ones it locks (gone), narrows (smaller range), widens
 * (larger range) and unlocks (new).
 */
export function controlChanges(before, after) {
  const locks = [], narrows = [], widens = [], opens = [];
  for (const [k, [lo, hi]] of Object.entries(before)) {
    const q = after[k];
    if (!q) locks.push(k);
    else if (q[1] - q[0] < hi - lo - 1e-9) narrows.push(k);
    else if (q[1] - q[0] > hi - lo + 1e-9) widens.push(k);
  }
  for (const k of Object.keys(after)) if (!before[k]) opens.push(k);
  return { locks, narrows, widens, opens };
}

const ALL_MAX = Object.fromEntries(PERF_GROUPS.map((g) => [g.code, 3]));
const ALL_UNIQUE = Object.fromEntries(PERF_GROUPS.map((g) => [g.code, true]));

/** Level 3 in every category on every bought car, installed the way the game installs it. */
export function maxPerformance(state) {
  let data = working(state);
  for (const s of usedSlots(data)) for (const g of PERF_GROUPS) data = applyTier(data, s, g, 3);
  return finish(state, data);
}

/** One car: Level 3 everywhere plus every unique. */
export function maxCar(state, slot) {
  return setCarPerformance(state, slot, { tiers: ALL_MAX, uniques: ALL_UNIQUE });
}

/** The nine unique performance upgrades on every bought car, or on one car when `slot` is given. */
export function applyUniques(state, slot = null) {
  let data = working(state);
  if (slot != null) checkSlot(data, slot);
  for (const s of slot == null ? usedSlots(data) : [slot]) for (const u of UNIQUE_PARTS) data = perf.setUniquePerfFlag(data, s, u.index, true);
  return finish(state, data);
}

// ---- Carbon fibre ------------------------------------------------------------------------------
// NFSU2 sells a carbon twin of every hood, spoiler, roof scoop and wing mirror: a separate part with its own
// hash, the same level and variant, and the attribute CARBONFIBRE = 1 (GLOBALB.BUN visual database).
// The game lists the plain parts first and the carbon twins after them in the same order, so the n-th plain
// part pairs with the n-th carbon part. A pair counts only if its name (less " CARBON FIBRE") or its level and
// variant agree: the data has two quirks (BLASTBACK DUAL's twin is named BLASTBACK; WAND is Level 2 plain but
// Level 3 carbon on some cars), and both agreements failing means the order broke, so no toggle is offered.
// Bumpers, side skirts and wide-body kits have no carbon twins. Their carbon is one switch per car instead:
// visual slot 93 (KIT_CARBON) holds "CARBON FIBRE NONE" (Level 0) or "CARBON FIBRE" (Level 3), and the game
// draws the fitted aftermarket bumpers, skirts or wide body in carbon (checked in game on a Corolla, 2026-11-13).
// Slots 94-96 (HOOD_, DOOR_ and TRUNK_CARBON) use the same Level 0 / Level 3 pair, and the game's carbon wide
// kits set all four, so the switch moves 93-96 together. Carbon on is offered only on an aftermarket kit
// (carbon on a stock kit was not checked in game); carbon off is always offered.
// Writes go through hackch's VisualCatalog.edit, which repeats what the game does on purchase
// (hood underside, vinyls a carbon hood cannot carry, body-kit aero flags).

export const CARBON_GROUPS = [
  { code: 'hood', label: 'Hood', slots: [9] },
  { code: 'spoiler', label: 'Spoiler', slots: [12] },
  { code: 'roof', label: 'Roof scoop', slots: [7] },
  { code: 'mirrors', label: 'Mirrors', slots: [32] },
  // The game's carbon wide kits switch all four carbon flags on (kit, hood, doors, trunk), so the body kit
  // switch moves them together: turning only 93 off left the rest carbon (a real career, 2026-11-13).
  { code: 'kit', label: 'Body kit', slots: [93, 94, 95, 96], flag: true },
];
const KIT_SLOTS = [1, 2, 11, 6];
const CARBONFIBRE = visual.gameHash('CARBONFIBRE');
const isCarbon = (part) => (part?.attributes.get(CARBONFIBRE)?.[0] ?? 0) !== 0;

/** For one car and visual slot: a Map from each part hash to its twin's hash, or null when the slot has no carbon twins. */
export function carbonTwins(catalog, carHash, visualSlot) {
  const opts = catalog.options(carHash, visualSlot);
  const carbon = opts.filter(isCarbon), plain = opts.filter((p) => !isCarbon(p) && p.level > 0);
  if (!carbon.length || carbon.length !== plain.length) return null;
  const twins = new Map();
  for (const [i, p] of plain.entries()) {
    const c = carbon[i];
    const sameName = c.name.replace(/ CARBON FIBRE$/, '') === p.name;
    if (!sameName && !(c.level === p.level && c.variant === p.variant)) return null;
    twins.set(p.hash, c.hash).set(c.hash, p.hash);
  }
  return twins;
}

/** For a switch slot (KIT_CARBON): its Level 0 "off" and Level 3 "on" parts, or null unless there is exactly one of each. */
export function carbonSwitch(catalog, carHash, visualSlot) {
  const opts = catalog.options(carHash, visualSlot);
  const off = opts.filter((p) => p.level === 0), on = opts.filter((p) => p.level > 0);
  return off.length === 1 && on.length === 1 ? { off: off[0].hash, on: on[0].hash } : null;
}

/** One visual slot: { state, target(on) } when it can be toggled, else null. */
function carbonSlot(catalog, car, refs, g, v) {
  if (g.flag) {
    const sw = carbonSwitch(catalog, car, v);
    if (!sw || ![sw.off, sw.on].includes(refs[v])) return null;
    // Turning carbon on needs an aftermarket kit; turning it off is always offered, so no carbon flag is stuck.
    const kit = KIT_SLOTS.some((k) => (catalog.part(car, k, refs[k])?.level ?? 0) > 0);
    if (!kit && refs[v] !== sw.on) return null;
    return { state: refs[v] === sw.on ? 'carbon' : 'plain', target: (on) => (on ? sw.on : sw.off) };
  }
  const twins = carbonTwins(catalog, car, v);
  if (!twins?.has(refs[v]) || catalog.hidden(refs, car, v)) return null;
  const state = isCarbon(catalog.part(car, v, refs[v])) ? 'carbon' : 'plain';
  return { state, target: () => twins.get(refs[v]) };
}

/** Per group: 'carbon', 'plain', or null when the fitted part has no carbon version (stock, none, hidden, unknown). */
function carbonState(catalog, data, slot) {
  const car = slots.getCarTypeHash(data, slot), refs = visual.readVisual(data, slot);
  return CARBON_GROUPS.map((g) => {
    // Any carbon flag left on reads as carbon, so the switch can always turn the whole group off.
    const states = g.slots.map((v) => carbonSlot(catalog, car, refs, g, v)?.state).filter(Boolean);
    return states.includes('carbon') ? 'carbon' : states.length ? 'plain' : null;
  });
}

const VINYL_LAYERS = [64, 65, 66, 67];

/**
 * Switches the groups in `codes`. With `keepVinyls`, a group whose switch would remove a vinyl layer is left as
 * it is and its code is returned in `skipped`: the game clears the vinyls a carbon hood or carbon kit cannot
 * carry (a real 240SX lost vinyl layer 4 to Best car's carbon kit, 2026-11-13).
 */
function applyCarbon(catalog, data, slot, codes, on, { keepVinyls = false } = {}) {
  const car = slots.getCarTypeHash(data, slot), skipped = [];
  for (const g of CARBON_GROUPS.filter((x) => codes.includes(x.code))) {
    let next = data;
    for (const v of g.slots) {
      const c = carbonSlot(catalog, car, visual.readVisual(next, slot), g, v);
      if (!c || (c.state === 'carbon') === on) continue;
      next = catalog.edit(next, slot, v, c.target(on));
    }
    if (keepVinyls && next !== data) {
      const before = visual.readVisual(data, slot), after = visual.readVisual(next, slot);
      if (VINYL_LAYERS.some((v) => before[v] !== after[v])) { skipped.push(g.code); continue; }
    }
    data = next;
  }
  return keepVinyls ? { data, skipped } : data;
}

/** Labels of the plain groups Best car leaves plain, because carbon there would remove a vinyl layer. */
function vinylKept(catalog, data, slot, carbon) {
  const plain = CARBON_GROUPS.filter((g, i) => carbon[i] === 'plain').map((g) => g.code);
  if (!plain.length) return [];
  const { skipped } = applyCarbon(catalog, data, slot, plain, true, { keepVinyls: true });
  return CARBON_GROUPS.filter((g) => skipped.includes(g.code)).map((g) => g.label);
}

/**
 * What Best car aims for, read the way Best car writes it: maxed, every unique, and carbon on every group that has
 * a carbon version, except the groups it leaves plain to keep a vinyl (2026-11-16: the 240SX and RX-7 read "Maxed"
 * with 5/5 setups straight after Best version of every car). A car whose fitted parts have no carbon version at all
 * is Best once maxed. Without the game data (carbon null) it cannot be told, so it is not.
 */
function isBestCar(c) {
  return c.maxed && c.uniques.every(Boolean) && !!c.carbon
    && c.carbon.every((x, i) => x !== 'plain' || c.carbonKept.includes(CARBON_GROUPS[i].label));
}

function needCatalog(db) {
  const catalog = visualCatalog(db);
  if (!catalog) throw new Error('Load the game data first: visual parts are read from GLOBALB.BUN.');
  return catalog;
}

/**
 * Carbon or plain for some part groups of one car, or of every car when `slot` is null.
 * `codes` defaults to every group. Groups whose fitted part has no carbon version are left alone.
 */
export function setCarbon(state, slot, on, db, codes = CARBON_GROUPS.map((g) => g.code)) {
  const catalog = needCatalog(db);
  let data = working(state);
  if (slot != null) checkSlot(data, slot);
  for (const s of slot == null ? usedSlots(data) : [slot]) data = applyCarbon(catalog, data, s, codes, !!on);
  return finish(state, data);
}

// ---- Visual editor -----------------------------------------------------------------------------
// Every visual slot hackch maps, per car: body parts, rims, paint, vinyls, decals, window tint, neon,
// trunk audio, door style, hydraulics, NOS purge and gauges. Writes go through VisualCatalog.edit, like the
// carbon toggles, so the game's purchase side effects follow (rear rims match the front, hood underside,
// wide-body doors and decals, vinyls a carbon part cannot carry, body-kit aero flags).
// The carbon slots 93-96 stay out: the body kit switch above moves them together.

export const VISUAL_GROUPS = [
  { code: 'body', label: 'Body parts', category: 'Body parts' },
  { code: 'paint', label: 'Paint', category: 'Paint' },
  { code: 'vinyl', label: 'Vinyls', category: 'Vinyl layers' },
  { code: 'vinylColour', label: 'Vinyl colours', category: 'Vinyl colours' },
  { code: 'decals', label: 'Decals', category: 'Decals' },
  { code: 'tint', label: 'Window tint', category: 'Window tint' },
  { code: 'lights', label: 'Neon and lights', category: 'Lighting' },
  { code: 'audio', label: 'Trunk audio', category: 'Trunk audio' },
  { code: 'special', label: 'Doors, hydraulics, NOS', category: 'Specialties' },
  { code: 'dials', label: 'Gauges', category: 'Dials' },
];
const EDITABLE = new Set(visual.VISUAL_SLOTS.filter((s) => VISUAL_GROUPS.some((g) => g.category === s.category)).map((s) => s.id));
const SLOT_LABELS = {
  1: 'Front bumper', 2: 'Rear bumper', 6: 'Wide body kit', 7: 'Roof scoop', 8: 'Roof', 9: 'Hood', 10: 'Trunk',
  11: 'Side skirts', 12: 'Spoiler', 13: 'Engine dress-up', 14: 'Headlights', 15: 'Tail lights', 16: 'Exhaust tips',
  29: 'Rims', 31: 'Spinners', 32: 'Side mirrors', 34: 'Trunk layout', 63: 'Body paint', 68: 'Engine paint',
  69: 'Spoiler paint', 70: 'Brake caliper paint', 71: 'Exhaust paint', 72: 'Trunk audio paint', 73: 'Rim paint',
  74: 'Spinner paint', 75: 'Roof scoop paint', 76: 'Mirror paint', 153: 'Window tint', 154: 'Underglow neon',
  155: 'Engine neon', 156: 'Cabin neon', 157: 'Trunk neon', 159: 'Headlight bulbs', 160: 'Door style',
  161: 'Hydraulics', 162: 'NOS purge', 163: 'Gauge style', 164: 'Gauge backing colour', 165: 'Gauge needle colour',
  166: 'Gauge text colour',
};
// Slots whose empty value (0) is a real choice: no vinyl, no decal, or the game's default colour for a part.
const NONE_LABEL = (id) => ((id >= 64 && id <= 67) || (id >= 105 && id <= 152) ? 'None' : id >= 68 && id <= 76 ? 'Game default' : null);
const INNER_RADIUS = visual.gameHash('INNER_RADIUS'), OUTER_RADIUS = visual.gameHash('OUTER_RADIUS');
const titleCase = (text) => text.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).trim();

function slotLabel(s) {
  if (SLOT_LABELS[s.id]) return SLOT_LABELS[s.id];
  let m;
  if ((m = /^VINYL_LAYER(\d)$/.exec(s.name))) return `Vinyl layer ${Number(m[1]) + 1}`;
  if ((m = /^VINYL_COLOUR(\d)_(\d)$/.exec(s.name))) return `Layer ${Number(m[1]) + 1}, colour ${Number(m[2]) + 1}`;
  if ((m = /^DECAL_(.+)_TEX(\d)$/.exec(s.name))) return `${titleCase(m[1].replaceAll('_', ' '))} ${Number(m[2]) + 1}`;
  if ((m = /^TRUNK_AUDIO_COMP_(\d+)$/.exec(s.name))) return `Component ${Number(m[1]) + 1}`;
  return titleCase(s.label);
}

const optionCache = new WeakMap();
/** The choices for one car and visual slot: { hash, label, group?, color?, size? }, labels unique within the slot. */
function visualOptions(catalog, car, id) {
  if (!optionCache.has(catalog)) optionCache.set(catalog, new Map());
  const cache = optionCache.get(catalog), key = `${car}:${id}`;
  if (cache.has(key)) return cache.get(key);
  const parts = catalog.selectableOptions(car, id);
  let out;
  if (visual.isVisualColorSlot(id)) {
    out = visual.colorPalettes(parts).flatMap((pal) => {
      // Palette names look like GLOSS_L1_COLOR##, METAL_L2_NEW_## or Colours (named swatches, no number).
      const m = /^(.*?)_L(\d)_?(.*?)_?$/.exec(pal.name.split('##')[0]);
      const words = m ? `${m[1]} ${m[3].replace(/^COLOR$/, '')}` : pal.name;
      const group = `${titleCase(words.replaceAll('_', ' '))}${m ? ` (level ${m[2]})` : ''}`;
      return pal.swatches.map((w) => ({ hash: w.hash, label: m ? `${group} ${w.number}` : w.name, group, color: w.color }));
    });
  } else {
    out = parts.map((p) => {
      const o = { hash: p.hash, label: p.name.replaceAll('_', ' ').trim() }; // the game's own names, as its shop shows them
      if (isCarbon(p) && !/CARBON/i.test(o.label)) o.label += ' CARBON FIBRE';
      if (id === 29 && p.attributes.has(INNER_RADIUS)) {
        o.group = o.label;
        o.size = `${p.attributes.get(INNER_RADIUS)[0]}" rim, ${p.attributes.get(OUTER_RADIUS)?.[0] ?? '?'}" wheel`;
        o.label = `${o.group} ${o.size}`;
      } else if (id >= 64 && id <= 67) o.group = `Vinyl group ${p.variant + 1}`;
      if (id >= 154 && id <= 159 && p.level > 0 && /^#[0-9a-f]{6}$/i.test(p.color ?? '')) o.color = p.color;
      return o;
    });
  }
  const seen = new Map();
  for (const o of out) {
    const n = (seen.get(o.label) ?? 0) + 1;
    seen.set(o.label, n);
    if (n > 1) o.label += ` (${n})`;
  }
  const none = NONE_LABEL(id);
  if (none) out.unshift({ hash: 0, label: none });
  cache.set(key, out);
  return out;
}

/**
 * The visual editor for one car: per group, every slot the car can change, with its choices and what is
 * fitted. `hidden` marks a slot the fitted parts cover (a wide body hides the bumpers and skirts).
 */
export function visualEditor(state, slot, db) {
  const catalog = needCatalog(db);
  const data = working(state);
  checkSlot(data, slot);
  const car = slots.getCarTypeHash(data, slot), refs = visual.readVisual(data, slot);
  return VISUAL_GROUPS.map((g) => ({
    code: g.code, label: g.label,
    slots: visual.VISUAL_SLOTS.filter((s) => s.category === g.category).flatMap((s) => {
      let options = visualOptions(catalog, car, s.id);
      if (options.length < 2) return [];
      const value = refs[s.id];
      if (!options.some((o) => o.hash === value)) options = [{ hash: value, label: value === 0 ? 'Not set' : 'Unknown part' }, ...options];
      return [{ id: s.id, label: slotLabel(s), value, hidden: catalog.hidden(refs, car, s.id), color: visual.isVisualColorSlot(s.id), wheel: s.id === 29, options }];
    }),
  })).filter((g) => g.slots.length);
}

/** Fits one visual part (or colour) on one car, with the game's purchase side effects. */
export function setVisual(state, slot, visualSlot, hash, db) {
  const catalog = needCatalog(db);
  if (!EDITABLE.has(visualSlot)) throw new RangeError('This visual slot is not editable here.');
  if (!Number.isInteger(hash) || hash < 0 || hash > 0xffffffff) throw new RangeError('Invalid part.');
  const data = working(state);
  checkSlot(data, slot);
  return finish(state, catalog.edit(data, slot, visualSlot, hash));
}

// ---- Dyno setups and recommended tuning --------------------------------------------------------
// The game stores five setups per car. The optimizer is hackch's port of the game's own dyno code
// (SPEED2.EXE): it tunes the ECU curve, turbo curve and gearing against the car's physics in GLOBALB.BUN.
// The RPM band each race type aims for is hackch's heuristic, not a constant from the game.
// Suspension, brakes, tires, downforce and nitrous stay as they are: nothing in the game data says
// what is best for them, so the preset does not guess.

export const SETUPS = dyno.SETUP_NAMES.map((label, value) => ({ value, label }));
export const PRESET_SOURCE = 'Parts: Level 3 and every unique, no camber kit where steering goes to its highest ratio, and the stock transmission except on the drag cars (Level 3 on the 240SX and RX-7). Sliders: published setups by top players (Ewil\'s Corolla speedrun setups, chilas\'s Civic setups for every other car). ECU, turbo and gearing: the game\'s own dyno simulation (hackch port). Circuit also fills the URL setup, because Career uses Circuit tuning for Sprint and URL. Untested in game.';

// ---- Research-based sliders ---------------------------------------------------------------------
// Slider targets by setup byte (dyno.js SCALARS): 0-3 front springs, shocks, sway bar, ride height; 4-7 the
// rear ones; 8 steering ratio; 16 nitrous duration (s); 18 brake bias; 19-20 tire grip; 21-22 downforce.
// 'min' and 'max' are the slider's ends for this car and its parts (ride height 'min' is the lowest), a
// number is the value the game's tuning screen shows. Sliders not listed stay as they are.
const COMMON = { 19: 'max', 20: 'max' };
const RESEARCH_SLIDERS = {
  // Ewil, NFSU2 speedrun setups for the Corolla (speedrun.com/nfsu2/guides/wtr6d): front low and soft,
  // rear high and stiff, steering 1.14, brake bias 0.21, nitrous 6 s; drag with no downforce and 4 s nitrous.
  corolla: {
    0: { ...COMMON, 3: 'min', 7: 'max', 0: 'min', 4: 'max', 1: 'min', 5: 'min', 2: 'min', 6: 'min', 8: 'max', 21: 'max', 22: 'max', 18: 0.21, 16: 6 },
    1: { ...COMMON, 3: 'min', 7: 'max', 0: 'min', 4: 'max', 1: 'min', 5: 'min', 21: 'min', 22: 'min', 16: 4 },
    3: { ...COMMON, 3: 'min', 7: 'max', 0: 'min', 4: 'max', 1: 'min', 5: 'min', 2: 'min', 6: 'min', 8: 'max', 21: 'max', 22: 'max', 18: 0.21 },
  },
  // chilas, Civic Si setups for all five race types (GameFAQs NFSU2 FAQ 34283), the only full published set.
  // Drag downforce is 'min' as in Ewil's and Gameswelt's drag setups (chilas notes it does not matter on the dyno).
  any: {
    0: { ...COMMON, 3: 'min', 7: 'min', 0: 'max', 4: 'max', 1: 'max', 5: 'max', 2: 'min', 6: 'min', 8: 'max', 21: 'max', 22: 'max', 18: 'max', 16: 'max' },
    1: { ...COMMON, 3: 'min', 7: 'min', 0: 'max', 4: 'max', 1: 'max', 5: 'max', 2: 'max', 6: 'max', 8: 'max', 21: 'min', 22: 'min', 16: 4 },
    2: { ...COMMON, 3: 'min', 7: 'min', 0: 'min', 4: 'min', 1: 'max', 5: 'max', 2: 'min', 6: 'min', 8: 'min', 21: 'max', 22: 'max', 18: 'max' },
    3: { ...COMMON, 3: 'min', 7: 'min', 0: 'min', 4: 'min', 1: 'max', 5: 'max', 2: 'min', 6: 'min', 8: 'min', 21: 'max', 22: 'max', 18: 'max' },
  },
};
RESEARCH_SLIDERS.corolla[2] = RESEARCH_SLIDERS.any[2]; // no published Corolla drift setup: chilas's drift sliders

/** The slider targets for a car and race type; URL uses the Circuit sliders, as every source does. */
export function researchSliders(carName, setup) {
  const set = /COROLLA/i.test(carName) ? RESEARCH_SLIDERS.corolla : RESEARCH_SLIDERS.any;
  return set[setup === 4 ? 0 : setup];
}

/** Writes slider targets into a setup's bytes through the game's own encoding; locked sliders are skipped. */
function withSliders(model, setup, targets) {
  let out = Uint8Array.from(setup);
  for (const [k, target] of Object.entries(targets)) {
    const param = Number(k);
    const row = model.scalarTuning(out).find((r) => r.param === param);
    if (!row || !row.editable) continue;
    const value = target === 'min' ? row.min : target === 'max' ? row.max : target === 'stock' ? row.stock
      : row.min + (target - row.displayMin) * (row.max - row.min) / (row.displayMax - row.displayMin);
    out = model.withScalarValue(out, param, value);
  }
  return out;
}

function dynoCar(db, hash) {
  const car = db?.dyno?.cars.find((c) => c.hash === hash);
  if (!car) return null;
  return { ...car, view: new DataView(car.phys.buffer, car.phys.byteOffset, car.phys.byteLength) };
}

function dynoModel(data, slot, db) {
  const d = dyno.readSlotDyno(data, slot);
  const car = dynoCar(db, d.hash);
  if (!car) return null;
  const game = { cars: [car], packages: db.dyno.packages, tuning: db.dyno.tuning };
  return { model: new dyno.DynoModel(game, car, d.installed, d.uniques), setups: d.setups };
}

function stats(r) {
  return { t60: r.t60, t100: r.t100, quarter: r.quarterExact, top: r.topSpeed, hp: r.peakPower * dyno.KW_TO_HP };
}

// hackch's own weights per race type for 0-60, 0-100, quarter mile and top speed (optimizeDynoSetup).
const RACE_WEIGHTS = { 1: [0.05, 0.1, 0.35, 0.5], 2: [0.6, 0.25, 0.1, 0.05], 3: [0.6, 0.25, 0.1, 0.05] };
const DEFAULT_WEIGHTS = [0.2, 0.2, 0.3, 0.3];

/** Lower is better. Times and top speed relative to a reference run, weighted for the race type. */
function raceScore(r, ref, setup) {
  const [a, b, c, d] = RACE_WEIGHTS[setup] ?? DEFAULT_WEIGHTS;
  const rel = (x, y) => (Number.isFinite(x) && Number.isFinite(y) && y > 0 ? x / y : Infinity);
  return a * rel(r.t60, ref.t60) + b * rel(r.t100, ref.t100) + c * rel(r.quarterExact, ref.quarterExact) - d * rel(r.topSpeed, ref.topSpeed);
}

/** Candidate setups from the dyno optimizer; the best by race score, never worse than the start. */
function bestSetup(model, start, setup) {
  const ref = model.evaluate(start);
  const candidates = [{ bytes: start, r: ref }];
  const attempt = (fn) => { try { const out = fn(); candidates.push({ bytes: out.setup, r: model.evaluate(out.setup) }); } catch { /* no smooth gearing: skip this candidate */ } };
  attempt(() => dyno.optimizeDynoSetup(model, start, setup, true));
  attempt(() => dyno.optimizeDynoSetup(model, start, setup, false));
  attempt(() => dyno.optimizeSetup(model, start, setup === 1 ? 'quarter' : 'accel', true));
  let best = candidates[0], bestScore = raceScore(ref, ref, setup);
  for (const c of candidates.slice(1)) {
    const v = raceScore(c.r, ref, setup);
    if (v < bestScore - 1e-6) { best = c; bestScore = v; }
  }
  return { bytes: best.bytes, before: ref, after: best.r, changed: best !== candidates[0] };
}

/** The car's tuning sliders for one setup as the game's tuning screen shows them, or null without game data. */
export function setupSliders(state, slot, setup, db) {
  const data = working(state);
  checkSlot(data, slot);
  const m = dynoModel(data, slot, db);
  return m ? m.model.scalarTuning(m.setups[setup]) : null;
}

/** The car's simulated numbers for one setup, or null without game data. */
export function setupStats(state, slot, setup, db) {
  const data = working(state);
  checkSlot(data, slot);
  const m = dynoModel(data, slot, db);
  return m ? stats(m.model.evaluate(m.setups[setup])) : null;
}

/**
 * Recommended preset for one car and race type: the parts bestCar fits (Level 3, every unique, the research
 * transmission, no camber kit), then the setup's ECU, turbo and gearing optimized for that race type. Parts are
 * shared by every setup of the car, so they are the same whichever race type is pressed, and a car with another
 * setup already tuned keeps its parts (only the uniques are added), as bestCar does. Returns the new state, the
 * simulated change and whether the parts were kept.
 */
export function applyPreset(state, slot, setup, db) {
  if (!db?.dyno) throw new Error('Load the game data first: presets are computed from the car physics in GLOBALB.BUN.');
  checkSlot(working(state), slot);
  const d = dyno.readSlotDyno(working(state), slot);
  const carName = dynoCar(db, d.hash)?.name;
  if (!carName) throw new Error('This car is not in the game data.');
  const targets = setup === 0 || setup === 4 ? [0, 4] : [setup];
  const partsKept = d.setups.some((b, k) => !targets.includes(k) && b.some((x) => x !== dyno.NEUTRAL_BYTE));
  const base = partsKept ? applyUniques(state, slot) : maxCar(state, slot);
  let data = working(base);
  if (!partsKept) {
    // The transmission level is chosen per car (researchParts). The camber kit comes off: it lowers the steering
    // ratio (Corolla 1.14 to 1.10, Ewil), and with it fitted for one race type and not another, applying one
    // setup would shift the steering under the others.
    data = applyTier(data, slot, groupByCode('TR'), researchParts(carName).TR);
    data = perf.setPerfFlag(data, slot, CAMBER_KIT, false);
  }
  const r = writePreset(data, slot, setup, db, carName, targets);
  return { state: finish(base, r.data), before: r.before, after: r.after, tuningChanged: true, partsKept, source: sliderSource(carName) };
}
// ---- Research parts per car --------------------------------------------------------------------
// Measured on the game's dyno model for all 10 cars of a full career, one category or unique changed at a time
// from Level 3 everywhere: Level 3 weight, engine, turbo and ECU are the fastest on every car, and every unique
// helps or changes nothing. Nitrous, suspension, brakes and tires are not in the straight-line model, so their
// Level 3 rests on the players' setups. The transmission is the one part that differs per car. Speedrunners
// measured Level 2-3 about a second slower per event on the Corolla (speedrun.com/nfsu2/forums/z469r), and on the
// dyno Level 3 is slower or within its error on the Skyline, Supra, 350Z, Lancer and Impreza. The 240SX and RX-7
// are the drag record cars, where Level 3 cuts the dyno's quarter mile from 9.60 to 8.91 s and 10.04 to 9.59 s.
// Parts are per car, not per race type: setup bytes are relative to the parts, so changing the gearbox for one
// race type would quietly change every other setup of that car.
const DRAG_GEARBOX = new Set(['240SX', 'RX7']);
/** The transmission level research picks for a car (by its game data name); every other group is Level 3. */
export function researchParts(carName) {
  return { TR: DRAG_GEARBOX.has(String(carName).toUpperCase()) ? 3 : 0 };
}
const sliderSource = (carName) => (/COROLLA/i.test(carName) ? 'Ewil (Corolla)' : 'chilas (Civic)');

/** Research sliders, then the dyno's ECU, turbo and gearing, for one race type on the car's current parts. */
function writePreset(data, slot, setup, db, carName, targets) {
  const m = dynoModel(data, slot, db);
  const start = m.setups[setup];
  const r = bestSetup(m.model, withSliders(m.model, start, researchSliders(carName, setup)), setup);
  for (const target of targets) data = dyno.setSetupTuning(data, slot, target, r.bytes, true, true);
  return { data, before: stats(m.model.evaluate(start)), after: stats(r.after) };
}

// ---- Best car ----------------------------------------------------------------------------------
// One action that makes a car the best version of itself, from the same research as the presets:
// Level 3 parts and every unique with the research transmission and no camber kit, the body-kit aero at Level 3,
// carbon on every part that has a carbon version, and the research preset for every race type.
// It never overwrites a setup the player has tuned, and a car with any tuned setup keeps its parts (only the
// uniques are added), so the player's own tuning still means what it meant. Paint, rims, vinyls and the
// choice of kit are taste: the action fits a Level 3 kit part only where the fitted one is lower.

// Front bumper, rear bumper, side skirts and spoiler: VisualCatalog.edit sets the body-kit aero flags from
// their levels (Level 3 on all four under a wide body).
const AERO_SLOTS = [1, 2, 11, 12];
// The race types a best car gets. URL is not listed: Circuit writes it too, as Career uses Circuit for URL.
const BEST_SETUPS = [0, 1, 2, 3];

function bestAero(catalog, data, slot) {
  const car = slots.getCarTypeHash(data, slot);
  const level = (v) => catalog.part(car, v, visual.readVisual(data, slot)[v])?.level ?? 0;
  if (level(6) > 0) return { data, fitted: [] };
  const fitted = [];
  for (const v of AERO_SLOTS) {
    if (level(v) >= 3) continue;
    const pick = catalog.selectableOptions(car, v).find((p) => p.level >= 3 && !isCarbon(p));
    if (!pick) continue;
    data = catalog.edit(data, slot, v, pick.hash);
    fitted.push({ slot: v, label: SLOT_LABELS[v], part: pick.name.replaceAll('_', ' ').trim() });
  }
  return { data, fitted };
}

/**
 * The best version of one car. Returns the new state and a report: whether the parts were kept, the kit
 * parts fitted, the carbon state per group, and per race type whether its setup was written or kept.
 */
export function bestCar(state, slot, db) {
  if (!db?.dyno) throw new Error('Load the game data first: the best car is computed from the car physics in GLOBALB.BUN.');
  const catalog = needCatalog(db);
  let data = working(state);
  checkSlot(data, slot);
  const d = dyno.readSlotDyno(data, slot);
  const carName = dynoCar(db, d.hash)?.name;
  if (!carName) throw new Error('This car is not in the game data.');
  const tuned = d.setups.map((b) => b.some((x) => x !== dyno.NEUTRAL_BYTE));
  const partsKept = tuned.some(Boolean);
  const base = partsKept ? applyUniques(state, slot) : maxCar(state, slot);
  data = working(base);
  if (!partsKept) {
    data = applyTier(data, slot, groupByCode('TR'), researchParts(carName).TR);
    data = perf.setPerfFlag(data, slot, CAMBER_KIT, false);
  }
  const aero = bestAero(catalog, data, slot);
  const carbon = applyCarbon(catalog, aero.data, slot, CARBON_GROUPS.map((g) => g.code), true, { keepVinyls: true });
  data = carbon.data;
  const carbonKept = carbon.skipped.map((code) => CARBON_GROUPS.find((g) => g.code === code).label);
  const setups = [];
  for (const setup of BEST_SETUPS) {
    const label = SETUPS[setup].label;
    if (tuned[setup]) { setups.push({ setup, label, kept: true }); continue; }
    const targets = setup === 0 && !tuned[4] ? [0, 4] : [setup];
    const r = writePreset(data, slot, setup, db, carName, targets);
    data = r.data;
    setups.push({ setup, label, kept: false, urlToo: targets.includes(4), before: r.before, after: r.after });
  }
  return {
    state: finish(base, data),
    report: { slot, car: displayName(carName), partsKept, transmission: partsKept ? null : researchParts(carName).TR, aero: aero.fitted, carbon: carbonState(catalog, data, slot), carbonKept, setups, source: sliderSource(carName) },
  };
}

/** bestCar on every car in the garage; `onCar(i, total, name)` is called before each car. */
export function bestGarage(state, db, onCar = () => {}) {
  const list = usedSlots(working(state));
  const reports = [];
  for (const [i, s] of list.entries()) {
    onCar(i, list.length, s);
    const r = bestCar(state, s, db);
    state = r.state;
    reports.push(r.report);
  }
  return { state, reports };
}

/**
 * Unlock all: every garage slot, the full part unlock table on every bought car, and the career completed.
 * Pearlescent paint, level-3 parts and the whole-menu carbon conversions (carbon fibre body kits, the carbon
 * trunk) are gated on the career stage and its race and sponsor results, not on the unlock table: a career at
 * Stage 5 with the full table still showed both carbon menus padlocked (a real RX-7, 2026-11-13). So it
 * needs the game data, and refuses without it rather than unlocking half and calling it everything.
 */
export function unlockAll(state, db) {
  if (!db) throw new Error('Load the game data first: without it, carbon fibre conversions, pearlescent paint and other story-gated parts stay locked.');
  let data = working(state);
  for (let s = 0; s < layout.slotCount(data); s++) if (slots.isSlotLocked(data, s)) data = slots.setSlotLocked(data, s, false);
  for (const s of usedSlots(data)) data = unlocks.setUnlocks(data, s, true);
  data = career.completeCareer(data, db);
  return finish(state, data);
}

// ---- Change car ----------------------------------------------------------------------------------
// A slot's model is its car type hash (+0x014) plus the body data around it. hackch's setSlotCar writes a donor
// car's three slot blocks (identity and body, stock visual parts, end-of-car data), clears the vinyls, decals
// and neon, and resets the installed part flags. The donors are built from the player's own game data
// (src/donors.js): every player car the game data describes gets one, and the 15 traffic vehicles, which have no
// stock rating record, get none. The story gate on a car only controls whether its dealer sells it; a locked car can
// still be written, and the picker says when it is locked.

const donorCache = new WeakMap();
/** The donor built for a car from this game data, or { why } when it cannot be built. */
function donorFor(db, hash) {
  if (!db) return { why: 'no game data' };
  let byHash = donorCache.get(db);
  if (!byHash) donorCache.set(db, (byHash = new Map()));
  if (!byHash.has(hash)) byHash.set(hash, buildDonor(db, visualCatalog(db), hash));
  return byHash.get(hash);
}

/** "Complete S4_URL_2" as a player reads it: the race to win in game. */
function carLockWords(reason) {
  const m = /^Complete S(\d)_URL_(\d+)$/.exec(reason);
  return m ? `Win Stage ${m[1]} URL race ${m[2]}` : reason.replace(/^Complete /, 'Win ');
}

/** Every car in the game data, for the Change car picker: display name, whether it can go in a slot, and its story lock. */
export function carChoices(state, db) {
  if (!db) throw new Error('Load the game data first: the car list comes from GLOBALB.BUN.');
  const locks = new Map();
  try { for (const c of career.careerReport(working(state), db).cars) locks.set(c.name, c.passed ? '' : carLockWords(c.reason)); } catch { /* no lock notes */ }
  return db.cars.map((c) => ({
    hash: c.hash,
    internal: c.name,
    name: displayName(c.name),
    region: CAR_NAMES[c.name]?.region ?? '',
    // A player car is one with a stock rating record; available means its donor builds from this game data.
    player: db.dyno.cars.find((d) => d.hash === c.hash)?.rating != null,
    available: !donorProblem(db, visualCatalog(db), c.hash),
    locked: locks.get(c.name) ?? '',
  }));
}

/** The car type hash in a slot. */
export const carHashInSlot = (state, slot) => slots.getCarTypeHash(working(state), slot);

/** The car type hash in a slot, or null when the slot holds no car. */
export function slotCarHash(state, slot) {
  const data = working(state);
  return usedSlots(data).includes(slot) ? slots.getCarTypeHash(data, slot) : null;
}

/** The car in a slot by its display name. */
export function carNameInSlot(state, slot, db) {
  const hash = carHashInSlot(state, slot);
  const car = db?.cars.find((c) => c.hash === hash);
  return car ? displayName(car.name) : `car 0x${hash.toString(16)}`;
}

/**
 * Puts another model in a garage slot. `keep: false` starts it stock: stock parts, no uniques, stock tuning
 * sliders. `keep: true` carries over what fits every car: the installed performance parts, the uniques and the
 * five tuning setups. Looks never carry (body parts belong to one model): the new car arrives with its stock
 * body, and vinyls, decals and neon are removed. Every other slot, the money and the career stay as they were.
 * `db` is the loaded game data the donor is built from.
 */
export function changeCar(state, slot, hash, db, { keep = false } = {}) {
  let data = working(state);
  checkSlot(data, slot);
  if (!db) throw new Error('Load the game data first: Change car builds the car from GLOBALB.BUN.');
  const donor = donorFor(db, hash);
  if (!donor.blocks) throw new RangeError(`That vehicle cannot go in a garage slot: ${donor.why}.`);
  if (slots.getCarTypeHash(data, slot) === hash) throw new RangeError('That slot already holds this car.');
  const installed = TUNING_PERF_INDICES.filter((i) => perf.getPerfFlag(data, slot, i));
  data = slots.setSlotCar(data, slot, donor);
  if (keep) {
    for (const i of installed) data = perf.setPerfFlag(data, slot, i, true);
  } else {
    for (const g of PERF_GROUPS) data = applyTier(data, slot, g, 0);
    for (const u of UNIQUE_PARTS) data = perf.setUniquePerfFlag(data, slot, u.index, false);
    for (let k = 0; k < dyno.SETUP_COUNT; k++) {
      const at = dyno.setupOffset(slot, k);
      data.fill(dyno.NEUTRAL_BYTE, at, at + dyno.SETUP_SIZE);
    }
  }
  return finish(state, data);
}

/** Carbon conversions the game sells, each with the visual slots that hold its carbon parts. */
export const CARBON_CONVERSIONS = [
  { code: 'hood', label: 'Hood', slots: [9] },
  { code: 'spoiler', label: 'Spoiler', slots: [12] },
  { code: 'roof', label: 'Roof scoop', slots: [7] },
  { code: 'mirrors', label: 'Mirrors', slots: [32] },
  { code: 'kit', label: 'Body kit', slots: [93, 94, 95] },
  { code: 'trunk', label: 'Trunk', slots: [96] },
];

/**
 * Everything still locked, as readable lines: locked garage slots, each car's unlock-table categories that are
 * not full, every career part gate that fails, and per car each carbon conversion with the number of failing
 * gates at the levels its carbon parts sit at. The game data maps no gate to a menu name, so a carbon
 * conversion counts as open only when no gate at its parts' levels is left.
 */
export function lockedCategories(state, db) {
  const data = working(state), out = [];
  for (let s = 0; s < layout.slotCount(data); s++) if (slots.isSlotLocked(data, s)) out.push(`garage slot ${s + 1}`);
  const name = (s) => { const c = db.cars.find((c) => c.hash === slots.getCarTypeHash(data, s)); return c ? displayName(c.name) : `slot ${s + 1}`; };
  for (const s of usedSlots(data)) {
    for (const cat of Object.keys(UNLOCK_CATEGORIES)) {
      const total = UNLOCK_CATEGORIES[cat].reduce((n, [a, b]) => n + b - a + 1, 0), on = unlocks.countUnlockedCategory(data, s, cat);
      if (on < total) out.push(`${name(s)}: unlock table ${cat} ${on}/${total}`);
    }
  }
  const failing = career.careerReport(data, db).parts.filter((p) => !p.passed);
  for (const p of failing) out.push(`story gate ${p.name}: ${p.reason}`);
  const failingAt = (level) => failing.filter((p) => Number(/level (\d)/.exec(p.name)?.[1]) === level).length;
  const catalog = visualCatalog(db);
  for (const s of usedSlots(data)) {
    const car = slots.getCarTypeHash(data, s);
    for (const c of CARBON_CONVERSIONS) {
      const levels = [...new Set(c.slots.flatMap((v) => catalog.options(car, v).filter((p) => p.level > 0 && (isCarbon(p) || v >= 93)).map((p) => p.level)))];
      if (!levels.length) continue;
      const shut = levels.reduce((n, l) => n + failingAt(l), 0);
      if (shut) out.push(`${name(s)}: carbon ${c.label.toLowerCase()} (levels ${levels.sort().join('/')}) behind ${shut} failing story gates`);
    }
  }
  return out;
}

// Two gated parts are known by the menus they padlock (a real RX-7, 2026-11-13): the game data names no part.
const CAREER_ITEM_NAMES = { 26: 'carbon fibre body kits', 28: 'carbon trunk' };
// hackch's gate labels name the win lists by offset, and two are swapped: the 10-entry list at +0x9c it calls
// "sponsors" holds the URL races (the game data names them S4_URL_1..7) and the 4-entry list at +0x8c it calls
// "urls" holds the sponsor races (S4_SPON_*). These words follow the game data's names.
const RESULT_WORDS = { races: ['race', 'races'], sponsors: ['URL race', 'URL races'], urls: ['sponsor race', 'sponsor races'] };
const stageLabel = (n) => STAGES.find((x) => x.value === n)?.label ?? `stage ${n}`;

/**
 * What the story still locks, as what to do in game: one entry per requirement, with how many part gates it
 * opens and the names of known parts among them. Each gate reads only the stage's list of won races or the
 * current stage, so no edit clears one without recording wins or moving the stage (a real save, 2026-11-13).
 */
export function storyLocks(state, db) {
  const groups = new Map();
  for (const p of career.careerReport(working(state), db).parts) {
    if (p.passed) continue;
    const item = Number(/^Item (\d+),/.exec(p.name)?.[1]);
    const count = /^Stage (\d): (\d+)\/(\d+) (races|sponsors|urls) results$/.exec(p.reason);
    const stage = /^Requires stage (\d)$/.exec(p.reason);
    let need = p.reason, order = 1000;
    if (count) {
      const left = Number(count[3]) - Number(count[2]), [one, many] = RESULT_WORDS[count[4]];
      need = `Win ${left} more ${stageLabel(Number(count[1]))} ${left === 1 ? one : many}`;
      order = Number(count[1]) * 100 + left;
    } else if (stage) {
      need = `Reach the ${stageLabel(Number(stage[1]))}`.replace('the Stage', 'Stage');
      order = Number(stage[1]) * 100 - 1;
    }
    const g = groups.get(need) ?? { need, order, gates: 0, named: [] };
    g.gates++;
    if (CAREER_ITEM_NAMES[item] && !g.named.includes(CAREER_ITEM_NAMES[item])) g.named.push(CAREER_ITEM_NAMES[item]);
    groups.set(need, g);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order).map(({ need, gates, named }) => ({ need, gates, named }));
}

/** What Unlock everything changes in the career, for its confirm step: now and after. */
export function finishStoryChanges(state, db) {
  const r = career.careerReport(working(state), db);
  return {
    stage: stageLabel(r.stage), events: r.completion.events, totalEvents: r.completion.totalEvents,
    photos: r.completion.photos, totalPhotos: r.completion.totalPhotos, gates: r.parts.filter((p) => !p.passed).length,
    finished: r.completion.complete,
  };
}

// The carbon fibre body kits (item 26) are gated on a count of URL race wins in one stage (gate type 3, the
// +0x9c list): 7 Stage 5 URL races on the game data checked, 2026-11-13.
const KIT_ITEM = 26, URL_LIST = 0x9c, URL_LIST_SIZE = 10, URL_KIND = 2;

/**
 * Whether recording URL race wins would open the carbon fibre body kits, and what it would write: the URL races of
 * the kit gate's stage not yet in its win list, in game-data order, as many as the gate still needs. Applies only on
 * that stage, while the kit gate is shut. `reason` says why not otherwise.
 */
export function urlWinsPlan(state, db) {
  const data = working(state), dv = layout.dataView(data);
  const gates = db.parts.filter((p) => p.item === KIT_ITEM && p.type === 3);
  if (!gates.length) return { applies: false, reason: 'This game data has no URL-race gate on the carbon fibre body kits.' };
  // Each gate names its stage in the high half and its URL win count in the low half. Gates on several stages each
  // count their own stage's list, so the plan uses the gates of the career's stage, or the earliest gated stage.
  const counts = new Map();
  for (const p of gates) counts.set(p.requirement >>> 16, Math.max(counts.get(p.requirement >>> 16) ?? 0, p.requirement & 0xffff));
  const stage = dv.getUint32(layout.CURRENT_STAGE_OFF, true);
  const gateStage = counts.has(stage) ? stage : Math.min(...counts.keys()), required = counts.get(gateStage);
  const where = [...counts.keys()].sort((a, b) => a - b).map(stageLabel).join(' or ');
  const report = career.careerReport(data, db);
  const shut = report.parts.filter((p) => !p.passed);
  const base = career.STAGE_OFF + gateStage * career.STAGE_STRIDE + URL_LIST;
  const listed = Array.from({ length: URL_LIST_SIZE }, (_, i) => dv.getUint32(base + i * 4, true));
  const have = listed.filter(Boolean).length;
  const out = { applies: false, reason: '', stage: stageLabel(gateStage), have, required, races: [], gatesBefore: shut.length, gatesAfter: shut.length };
  if (stage !== gateStage) return { ...out, reason: `Only on ${where}, where the game counts the URL races that open the carbon fibre body kits. This career is on ${stageLabel(stage)}.` };
  if (have >= required) return { ...out, reason: `The carbon fibre body kits are already open: ${have} of ${required} ${stageLabel(gateStage)} URL races won.` };
  const unwon = [...db.events.values()].filter((e) => e.stage === gateStage && e.kind === URL_KIND && !listed.includes(e.hash));
  const races = unwon.slice(0, required - have);
  if (races.length < required - have || have + races.length > URL_LIST_SIZE) return { ...out, reason: `${stageLabel(gateStage)} has too few URL races left to record (${unwon.length} for ${required - have} needed).` };
  const after = recordWins(data, base, races.map((e) => e.hash));
  return { ...out, applies: true, races: races.map((e) => e.name), hashes: races.map((e) => e.hash), listOff: base, gatesAfter: career.careerReport(after, db).parts.filter((p) => !p.passed).length };
}

// Each hash goes into the first empty entry, as the game fills the list when a race is won (FUN_00513390).
function recordWins(data, base, hashes) {
  const out = data.slice(), dv = layout.dataView(out);
  for (const hash of hashes) {
    let i = 0;
    while (i < URL_LIST_SIZE && dv.getUint32(base + i * 4, true) !== 0) i++;
    if (i === URL_LIST_SIZE) throw new Error('The URL race win list is full.');
    dv.setUint32(base + i * 4, hash, true);
  }
  return out;
}

/**
 * Records the URL races urlWinsPlan names as won, and nothing else: no stage, money, event flag or other list
 * changes. The game will count them as won, so the carbon fibre body kits open without finishing the story.
 */
export function recordUrlWins(state, db) {
  const plan = urlWinsPlan(state, db);
  if (!plan.applies) throw new Error(plan.reason);
  return finish(state, recordWins(working(state), plan.listOff, plan.hashes));
}

export function setStage(state, stage) {
  return finish(state, career.setCareerStage(working(state), stage));
}

/** Read-only summary for the panel. */
export function summary(state, db) {
  const data = working(state);
  const dv = layout.dataView(data);
  const used = usedSlots(data);
  const carName = (s) => {
    const hash = slots.getCarTypeHash(data, s);
    const car = db?.cars.find((c) => c.hash === hash);
    return car ? displayName(car.name) : `car 0x${hash.toString(16)}`;
  };
  const cars = used.map((s) => ({
    slot: s + 1,
    index: s,
    hash: slots.getCarTypeHash(data, s),
    name: carName(s),
    perf: TUNING_PERF_INDICES.filter((i) => perf.getPerfFlag(data, s, i)).length,
    perfTotal: TUNING_PERF_INDICES.length,
    uniques: UNIQUE_PARTS.map((u) => perf.getUniquePerfValue(data, s, u.index) !== 0),
    tiers: PERF_GROUPS.map((g) => getTier(data, s, g)),
    maxed: isMaxed(PERF_GROUPS.map((g) => getTier(data, s, g)), dynoCar(db, slots.getCarTypeHash(data, s))?.name ?? null),
    camber: perf.getPerfFlag(data, s, CAMBER_KIT),
    tuned: dyno.readSlotDyno(data, s).setups.map((b) => b.some((x) => x !== dyno.NEUTRAL_BYTE)),
    unlocks: unlocks.countUnlocked(data, s),
    unlocksTotal: unlocks.UNLOCK_COUNT,
    carbon: visualCatalog(db) ? carbonState(visualCatalog(db), data, s) : null,
  }));
  for (const c of cars) {
    // Only a car that is otherwise Best pays for the vinyl check, which switches each plain group on a copy.
    const near = c.maxed && c.uniques.every(Boolean) && c.carbon?.includes('plain');
    c.carbonKept = near ? vinylKept(visualCatalog(db), data, c.index, c.carbon) : [];
    c.best = isBestCar(c);
  }
  let report = null;
  if (db) {
    const r = career.careerReport(data, db);
    report = { ...r.completion, partsFailing: r.parts.filter((p) => !p.passed).length, partsTotal: r.parts.length };
  }
  return {
    name: save.getName(data),
    money: save.getMoney(data),
    stage: dv.getUint32(layout.CURRENT_STAGE_OFF, true),
    slotCount: layout.slotCount(data),
    lockedSlots: Array.from({ length: layout.slotCount(data) }, (_, s) => slots.isSlotLocked(data, s)).filter(Boolean).length,
    garage: garageUsable(state),
    cars,
    report,
  };
}

// ---- Game data (career database) -------------------------------------------------------------
// Parsed from the player's own GLOBALB.BUN, which nfsu2.xyz caches in its browser storage.
// Only the derived tables and the visual part tables are kept, and only in this browser.
// The site caches it plain (GLOBALB.BUN) or JDLZ-compressed (GlobalB.lzc); both are accepted.

export function parseGameDb(input) {
  const bun = isJdlz(input) ? decompressJdlz(input) : input;
  const game = dyno.parseGameData(bun);
  const db = career.parseCareerDatabase(bun, game.cars);
  visual.parseVisualData(bun, game.cars); // throws here, not later in the panel, when the visual tables are unreadable
  return serializeDb(db, game, visualChunks(bun), readRatings(bun, game.cars.length));
}

// The visual part tables hackch's parseVisualData reads, copied out of GLOBALB.BUN as a flat chunk list (about 290 KB).
const VISUAL_CHUNKS = [0x34603, 0x34604, 0x34605, 0x34606, 0x34607, 0x3460b, 0x3460c];
function visualChunks(bun) {
  const dv = layout.dataView(bun), parts = [];
  (function walk(start, end) {
    for (let off = start; off + 8 <= end;) {
      const id = dv.getUint32(off, true), next = off + 8 + dv.getUint32(off + 4, true);
      if (id & 0x80000000) walk(off + 8, Math.min(next, end));
      else if (VISUAL_CHUNKS.includes(id)) parts.push(bun.subarray(off, next));
      off = next;
    }
  })(0, bun.length);
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  parts.reduce((at, x) => (out.set(x, at), at + x.length), 0);
  return out;
}

const catalogs = new WeakMap();
/** The visual part catalog, parsed on first use and kept per database object; null without game data. */
export function visualCatalog(db) {
  if (!db?.visual) return null;
  if (!catalogs.has(db)) catalogs.set(db, visual.parseVisualData(db.visual, db.dyno.cars));
  return catalogs.get(db);
}

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (text) => { const s = atob(text), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

/**
 * JSON for chrome.storage: the career tables, each car's physics record (about 2 KB a car) and stock rating word, and
 * the visual part tables. Version 4 added the rating, which Change car's donors need.
 */
export function serializeDb(db, game, visualBytes, ratings = []) {
  return {
    version: 4,
    visual: b64(visualBytes),
    events: [...db.events.values()],
    shops: db.shops, parts: db.parts, carGates: db.carGates, stages: db.stages, photos: db.photos,
    cars: db.cars.map((c) => ({ index: c.index, name: c.name, hash: c.hash })),
    dyno: {
      cars: game.cars.map((c) => ({ index: c.index, name: c.name, hash: c.hash, rating: ratings[c.index] ?? null,
        phys: b64(new Uint8Array(c.view.buffer, c.view.byteOffset, c.view.byteLength)) })),
      packages: game.packages, tuning: game.tuning,
    },
  };
}

/** Back from JSON. An older version returns null, so the panel reads the game data again. */
export function hydrateDb(json) {
  if (!json || json.version !== 4) return null;
  return {
    ...json,
    visual: unb64(json.visual),
    events: new Map(json.events.map((e) => [e.hash, e])),
    dyno: { ...json.dyno, cars: json.dyno.cars.map((c) => ({ ...c, phys: unb64(c.phys) })) },
  };
}

// ---- Ready-made garage ----------------------------------------------------------------------------
// Ten finished cars ship in src/garage-data.js (src/garage-designs.js describes and checks the format). A design is
// one car's whole slot as the game reads it: the 170 visual part hashes, the performance part flags and owned bits,
// the nine unique flags and the five setups. Setup bytes are relative to the car and its parts, so they only mean the
// same thing on the same model with the same parts: applying a design writes all of it together, after putting
// that model in the slot (Change car) when another model is there.

/** The design of one garage car, in the shipped format less its name, reason and tuning codes. */
export function readDesign(state, slot) {
  const data = working(state);
  checkSlot(data, slot);
  const base = layout.slotBase(slot);
  const visualBytes = data.slice(base + layout.VISUAL_OFF, base + layout.VISUAL_OFF + designs.VISUAL_COUNT * 4);
  const owned = new Uint8Array(designs.OWNED_BYTES);
  for (let i = 0; i < designs.PERF_COUNT; i++) if (perf.getPerfPurchased(data, slot, i)) owned[i >> 3] |= 1 << (i & 7);
  return {
    hash: slots.getCarTypeHash(data, slot),
    visual: designs.toHex(visualBytes),
    perf: designs.toHex(data.slice(base + layout.PERF_OFF, base + layout.PERF_OFF + designs.PERF_COUNT)),
    owned: designs.toHex(owned),
    uniques: UNIQUE_PARTS.map((u) => (perf.getUniquePerfValue(data, slot, u.index) !== 0 ? 1 : 0)),
    setups: dyno.readSlotDyno(data, slot).setups.map((b) => designs.toHex(b)),
  };
}

/** The game data hash of a design's car, or null when this game data has no such car. */
export function designCarHash(design, db) {
  return db?.cars.find((c) => c.name === design.car)?.hash ?? null;
}

const BODY_PAINT = 63;
/** A body paint no car's shop sells: the factory paints some models arrive with (the Impreza and RSX ones). */
function factoryPaint(catalog, db, hash) {
  return !db.cars.some((c) => catalog.part(c.hash, BODY_PAINT, hash));
}

/**
 * Visual parts in a slot that its own model does not list, other than a factory paint: leftovers of an earlier
 * model in that slot. Returns their visual slot ids. The ready-made garage replaces them before it ships.
 */
export function foreignParts(state, slot, db) {
  const catalog = needCatalog(db), data = working(state);
  checkSlot(data, slot);
  const hash = slots.getCarTypeHash(data, slot);
  return visual.readVisual(data, slot).flatMap((v, i) => (v !== 0 && !catalog.part(hash, i, v) && !(i === BODY_PAINT && factoryPaint(catalog, db, v)) ? [i] : []));
}

/** The donor swap Change car does, on bytes. */
function swapModel(data, slot, hash, db) {
  const donor = donorFor(db, hash);
  if (!donor.blocks) throw new RangeError(`${displayName(db.cars.find((c) => c.hash === hash)?.name ?? 'That car')} cannot go in a garage slot with this game data: ${donor.why}.`);
  return slots.setSlotCar(data, slot, donor);
}

/**
 * Writes a design into one slot, on bytes. Visual parts this game data does not list for the car are left as they
 * were and named in `skipped`: the rest of the design still applies.
 */
function writeDesign(data, slot, design, db) {
  const catalog = needCatalog(db);
  const hash = designCarHash(design, db);
  if (hash == null) throw new RangeError(`This game data has no ${displayName(design.car)}.`);
  const changedModel = slots.getCarTypeHash(data, slot) !== hash;
  data = changedModel ? swapModel(data, slot, hash, db) : data.slice();
  const base = layout.slotBase(slot), dv = layout.dataView(data);
  const want = designs.visualRefs(design), have = visual.readVisual(data, slot);
  const skipped = [];
  want.forEach((v, i) => {
    if (v === have[i]) return;
    if (v !== 0 && !catalog.part(hash, i, v) && !(i === BODY_PAINT && factoryPaint(catalog, db, v))) { skipped.push(i); return; }
    dv.setUint32(base + layout.VISUAL_OFF + i * 4, v, true);
  });
  const flags = designs.fromHex(design.perf), owned = designs.fromHex(design.owned);
  for (let i = 0; i < designs.PERF_COUNT; i++) {
    data[base + layout.PERF_OFF + i] = flags[i];
    data = setOwned(data, slot, i, (owned[i >> 3] & (1 << (i & 7))) !== 0);
  }
  for (const [k, u] of UNIQUE_PARTS.entries()) data = perf.setUniquePerfFlag(data, slot, u.index, design.uniques[k] === 1);
  for (let k = 0; k < dyno.SETUP_COUNT; k++) data.set(designs.fromHex(design.setups[k]), dyno.setupOffset(slot, k));
  const label = (i) => SLOT_LABELS[i] ?? titleCase(visual.VISUAL_SLOTS.find((s) => s.id === i)?.label ?? `visual slot ${i}`);
  return { data, changedModel, skipped: skipped.map(label) };
}

function checkDesign(design) {
  const bad = designs.checkGarageData({ schema: designs.SCHEMA, saved: '2000-01-01', cars: [design] });
  if (bad.length) throw new RangeError(`That ready-made car is damaged (${bad[0]}). Nothing was written.`);
}

/**
 * One ready-made car into one garage slot: its looks, parts and five setups. When the slot holds another model, that
 * model is replaced (Change car) first. Only that slot changes. Returns the new state and a report.
 */
export function applyDesign(state, slot, design, db) {
  if (!db) throw new Error('Load the game data first: ready-made cars are built from GLOBALB.BUN.');
  checkDesign(design);
  const data = working(state);
  checkSlot(data, slot);
  const before = carNameInSlot(state, slot, db);
  const r = writeDesign(data, slot, design, db);
  return { state: finish(state, r.data), report: { slot, car: displayName(design.car), replaced: r.changedModel ? before : null, skipped: r.skipped } };
}

/** How many of a slot's five setups differ from the game's neutral setup. */
function tunedCount(data, slot) {
  return dyno.readSlotDyno(data, slot).setups.filter((b) => b.some((x) => x !== dyno.NEUTRAL_BYTE)).length;
}

/**
 * Where each ready-made car goes in "replace my whole garage": the n-th ready-made car into the n-th car in the
 * garage, with what that slot holds now. Cars past the garage's last car are not placed. Reads only.
 */
export function replacePlan(state, garage, db) {
  const data = working(state), used = usedSlots(data);
  const placed = garage.cars.slice(0, used.length).map((design, i) => ({
    slot: used[i], from: carNameInSlot(state, used[i], db), to: displayName(design.car), tuned: tunedCount(data, used[i]),
  }));
  return { placed, unplaced: garage.cars.slice(used.length).map((d) => displayName(d.car)) };
}

/**
 * Every ready-made car into the garage at once, per replacePlan. All or nothing: if any car cannot be built, it
 * throws and nothing changes. Refuses unless { confirmed: true }: the panel passes it only after the player ticks the
 * warning that names what is lost. Returns the new state, one report per car and the cars that found no slot.
 */
export function replaceGarage(state, garage, db, { confirmed = false } = {}) {
  if (confirmed !== true) throw new Error('Replacing the whole garage needs the confirm: tick that you understand what is lost, then press Replace. Nothing was written.');
  if (!db) throw new Error('Load the game data first: ready-made cars are built from GLOBALB.BUN.');
  const bad = designs.checkGarageData(garage);
  if (bad.length) throw new RangeError(`The ready-made garage is damaged (${bad[0]}). Nothing was written.`);
  const plan = replacePlan(state, garage, db);
  if (!plan.placed.length) throw new RangeError('This career has no car in its garage to replace. Nothing was written.');
  let data = working(state);
  const reports = [];
  for (const [i, p] of plan.placed.entries()) {
    let r;
    try { r = writeDesign(data, p.slot, garage.cars[i], db); } catch (err) { throw new Error(`Slot ${p.slot + 1} (${p.to}): ${err.message} Nothing was written.`); }
    data = r.data;
    reports.push({ slot: p.slot, car: p.to, replaced: r.changedModel ? p.from : null, skipped: r.skipped });
  }
  return { state: finish(state, data), reports, unplaced: plan.unplaced };
}

/**
 * Tuning for the ready-made garage: slider targets (as researchSliders gives them, plus 'stock'), then the dyno's
 * ECU, turbo and gearing for the race type. Reads only; returns the setup bytes and the simulated change.
 */
export function tuneSetup(state, slot, setup, db, targets) {
  const data = working(state);
  checkSlot(data, slot);
  const m = dynoModel(data, slot, db);
  if (!m) throw new Error('This car is not in the game data.');
  const start = m.setups[setup];
  const r = bestSetup(m.model, withSliders(m.model, start, targets), setup);
  return { bytes: r.bytes, before: stats(m.model.evaluate(start)), after: stats(r.after) };
}

/** A setup's slider targets as 'min', 'max' or the value the tuning screen shows, read from a car's own setup. */
export function sliderTargets(state, slot, setup, db) {
  const rows = setupSliders(state, slot, setup, db) ?? [];
  const out = {};
  for (const r of rows) {
    if (!r.editable || r.param === 17) continue; // nitrous flow follows its duration
    out[r.param] = r.byte <= r.minByte ? 'min' : r.byte >= r.maxByte ? 'max' : r.displayValue;
  }
  return out;
}

/** The scalar slider bytes of a setup (suspension, steering, nitrous, brakes, tires, downforce), for comparing setups. */
export function sliderBytes(bytes) {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 17, 18, 19, 20, 21, 22].map((i) => bytes[i]);
}

/** A car's drivetrain and weight on its fitted parts: share of drive to the rear (0 to 1), mass in tonnes, peak hp. */
export function carDrive(state, slot, db) {
  const data = working(state);
  checkSlot(data, slot);
  const m = dynoModel(data, slot, db);
  if (!m) return null;
  const p = m.model.tuned(m.setups[0]);
  return { rear: p.f[0x1c0 >> 2], mass: p.f[0x110 >> 2], hp: m.model.evaluate(m.setups[0]).peakPower * dyno.KW_TO_HP };
}

/** A setup's bytes with slider targets written and nothing optimised, for comparing a setup with a preset. Reads only. */
export function previewSliders(state, slot, setup, db, targets) {
  const data = working(state);
  checkSlot(data, slot);
  const m = dynoModel(data, slot, db);
  if (!m) throw new Error('This car is not in the game data.');
  return withSliders(m.model, m.setups[setup], targets);
}
