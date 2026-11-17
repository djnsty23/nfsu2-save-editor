// Lists every locked category on a profile before and after Unlock everything: garage slots, each car's unlock
// table, every career part gate, and per car each carbon conversion (hood, spoiler, roof scoop, mirrors, body kit,
// trunk). "Before" is the part-table-only unlock the panel used to run without game data, which is what left the
// carbon body kit and carbon trunk menus padlocked on a Stage 5 career.
// Usage: node test/unlock-coverage.test.mjs <GLOBALB.BUN or GlobalB.lzc> <profile dir>
// The profile dir holds <NAME> (the career) and usually GARAGE.DAT. Nothing is written to it.
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as ops from '../src/ops.js';
import * as web from '../vendor/hackch/model/nfsu2-web.js';
import * as layout from '../vendor/hackch/model/layout.js';
import * as slots from '../vendor/hackch/model/slots.js';
import * as unlocks from '../vendor/hackch/model/unlocks.js';
import * as save from '../vendor/hackch/model/save-file.js';

const [bunPath, dir] = process.argv.slice(2);
if (!bunPath || !dir) { console.error('usage: node test/unlock-coverage.test.mjs <GLOBALB.BUN> <profile dir>'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(readFileSync(bunPath))))));
const name = basename(dir);
const garagePath = join(dir, 'GARAGE.DAT');
const state = { career: new Uint8Array(readFileSync(join(dir, name))), garage: existsSync(garagePath) ? new Uint8Array(readFileSync(garagePath)) : null };
const loaded = state.garage && web.checkGarage(state.garage, state.career).state === 'loaded';

// The old no-game-data path: open every slot and fill every car's unlock table, career untouched.
function tableOnly(s) {
  let data = loaded ? web.mergeGarage(s.career, s.garage) : s.career.slice();
  for (let i = 0; i < layout.slotCount(data); i++) {
    if (slots.isSlotLocked(data, i)) data = slots.setSlotLocked(data, i, false);
    if (slots.isSlotUsed(data, i)) data = unlocks.setUnlocks(data, i, true);
  }
  const career = save.recalculateChecksums(data.subarray(0, layout.PROFILE_SIZE));
  return { career, garage: loaded ? web.buildGarage(s.garage, data, career) : s.garage };
}

const show = (title, list) => { console.log(`\n${title}: ${list.length} locked`); for (const line of list) console.log(`  ${line}`); };
const now = ops.lockedCategories(state, db);
const before = ops.lockedCategories(tableOnly(state), db);
show('As saved', now);
show('Before the fix (unlock table only)', before);

let refused = '', after = null;
try { ops.unlockAll(state, null); } catch (err) { refused = err.message; }
const unlocked = ops.unlockAll(state, db);
after = ops.lockedCategories(unlocked, db);
show('After Unlock everything (game data loaded)', after);
console.log('');

const summary = ops.summary(tableOnly(state), db);
const tableFull = summary.cars.every((c) => c.unlocks === c.unlocksTotal);
const carbonBefore = before.filter((l) => / carbon /.test(l));
check('the table-only unlock fills every car\'s unlock table', tableFull);
if (summary.report.partsFailing) {
  check('with the table full, story gates still lock parts (what the old path left)', before.some((l) => l.startsWith('story gate')), `${summary.report.partsFailing} gates`);
  check('and the carbon conversions behind them are listed per car', carbonBefore.length > 0, `${carbonBefore.length} carbon lines`);
}
// The trunk conversion is its own unlock (TRUNK_CARBON, visual slot 96), not the spoiler: it gets its own line.
const trunkCars = summary.cars.filter((c) => ops.visualCatalog(db).options(slots.getCarTypeHash(loaded ? web.mergeGarage(state.career, state.garage) : state.career, c.index), 96).some((p) => p.level > 0));
if (carbonBefore.length) check('every car with a carbon trunk lists it apart from the spoiler', trunkCars.every((c) => carbonBefore.some((l) => l.startsWith(`${c.name}: carbon trunk`))), `${trunkCars.length} cars`);
// What the panel lists instead of finishing the story: every shut gate, as what to win or reach in game.
const locks = ops.storyLocks(state, db);
show('Still locked by the story, as what to do in game', locks.map((l) => `${l.need}: ${l.gates} part levels${l.named.length ? ` (${l.named.join(', ')})` : ''}`));
check('the story-locked list covers every shut gate once, in game words', locks.reduce((n, l) => n + l.gates, 0) === (summary.report.partsFailing ?? 0) && locks.every((l) => /^(Win \d+ more .+ (race|races)|Reach .+|Complete .+|Discover .+)$/.test(l.need)), `${locks.length} requirements`);
const changes = ops.finishStoryChanges(state, db);
console.log(`Unlock everything would change: stage ${changes.stage} to Career finished, events ${changes.events} to ${changes.totalEvents}, photos ${changes.photos} to ${changes.totalPhotos}`);
check('Unlock everything without game data is refused, not run half', /game data/.test(refused), refused || 'it ran');
check('after Unlock everything nothing is locked: slots, unlock tables, story gates, every carbon conversion', after.length === 0, after.slice(0, 3).join('; '));
check('after Unlock everything the story is finished', ops.summary(unlocked, db).stage === 6);

console.log(`\n${pass}/${pass + fail} pass`);
process.exitCode = fail ? 1 : 0;
