// The carbon body kit shortcut on a real profile: it records only the URL races the kit gate still needs as won.
// Checks the story locks it opens, that item 26 opens, and that no byte changes outside those win-list entries and the
// checksums: same stage, money, event flags, other races and garage. It also checks where the shortcut refuses.
// Usage: node test/url-wins.test.mjs <GLOBALB.BUN or GlobalB.lzc> <profile dir>
// The profile dir holds <NAME> (the career) and usually GARAGE.DAT. Nothing is written to it.
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as ops from '../src/ops.js';
import * as career from '../vendor/hackch/model/career.js';
import * as layout from '../vendor/hackch/model/layout.js';
import * as save from '../vendor/hackch/model/save-file.js';
import * as web from '../vendor/hackch/model/nfsu2-web.js';

const [bunPath, dir] = process.argv.slice(2);
if (!bunPath || !dir) { console.error('usage: node test/url-wins.test.mjs <GLOBALB.BUN> <profile dir>'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const eq = (a, b) => (a == null && b == null) || (a && b && a.length === b.length && a.every((x, i) => x === b[i]));
const CHECKSUM_BYTES = new Set([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);

const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(readFileSync(bunPath))))));
const name = basename(dir), garagePath = join(dir, 'GARAGE.DAT');
const state = { career: new Uint8Array(readFileSync(join(dir, name))), garage: existsSync(garagePath) ? new Uint8Array(readFileSync(garagePath)) : null };
const shut = (s) => career.careerReport(s.career, db).parts.filter((p) => !p.passed);
const stageOf = (s) => layout.dataView(s.career).getUint32(layout.CURRENT_STAGE_OFF, true);

const plan = ops.urlWinsPlan(state, db);
console.log(`plan: ${plan.applies ? `records ${plan.races.length} ${plan.stage} URL races: ${plan.races.join(', ')}` : `refuses: ${plan.reason}`}`);
if (plan.applies) {
  // The game data names the races this list counts S4_URL_*: the story list must call them URL races, not sponsor races.
  const kitLock = ops.storyLocks(state, db).find((l) => l.named.includes('carbon fibre body kits'));
  check('the story-locked list asks for URL race wins for the body kits', /^Win \d+ more .+ URL races?$/.test(kitLock?.need ?? ''), kitLock?.need);
  const after = ops.recordUrlWins(state, db);
  const before = shut(state), now = shut(after);
  console.log(`story locks ${before.length} -> ${now.length}; opened: ${before.filter((p) => !now.some((q) => q.name === p.name)).map((p) => p.name).join(', ')}`);
  check('the races it records are URL races of the kit gate\'s stage', plan.races.every((n) => /_URL_\d+$/.test(n)), plan.races.join(', '));
  check('the story locks drop to what the preview said', before.length === plan.gatesBefore && now.length === plan.gatesAfter && now.length < before.length, `${before.length} -> ${now.length}`);
  check('the carbon fibre body kits (item 26) open at every level', !now.some((p) => p.name.startsWith('Item 26,')) && before.some((p) => p.name.startsWith('Item 26,')));
  check('no lock that was open closes', now.every((p) => before.some((q) => q.name === p.name)));
  // Only the win-list entries it filled and the checksum change: stage, money, event flags and every other list stay.
  const base = career.STAGE_OFF + db.parts.find((p) => p.item === 26 && p.type === 3).requirement / 65536 * career.STAGE_STRIDE + 0x9c;
  const changed = []; for (let i = 0; i < after.career.length; i++) if (after.career[i] !== state.career[i] && !CHECKSUM_BYTES.has(i)) changed.push(i);
  check('only the URL win-list entries change in the career', changed.length > 0 && changed.every((i) => i >= base && i < base + 40), `${changed.length} bytes`);
  check('stage, event records and race counts other than these URL wins are unchanged',
    stageOf(after) === stageOf(state) && eq(after.career.subarray(career.EVENT_COUNT_OFF, career.EVENT_OFF + career.EVENT_CAPACITY * 8), state.career.subarray(career.EVENT_COUNT_OFF, career.EVENT_OFF + career.EVENT_CAPACITY * 8)));
  check('checksums verify and the garage still matches the career', Object.values(save.verifyChecksums(after.career)).every(Boolean) && (!after.garage || web.checkGarage(after.garage, after.career).state === 'loaded'));
  check('the garage file is byte for byte the same', eq(after.garage, state.garage));
  const again = ops.urlWinsPlan(after, db);
  check('once recorded, the shortcut refuses: the kits are already open', !again.applies && /already open/.test(again.reason), again.reason);
  let threw = ''; try { ops.recordUrlWins(after, db); } catch (err) { threw = err.message; }
  check('and recordUrlWins refuses rather than writing again', /already open/.test(threw), threw || 'it wrote');
}
// On another stage the game counts no URL races toward the kits: the shortcut refuses and says why.
const other = { career: save.recalculateChecksums(career.setCareerStage(state.career, stageOf(state) === 3 ? 2 : 3)), garage: null };
const off = ops.urlWinsPlan(other, db);
check('on another stage it refuses and names the stage it needs', !off.applies && /^Only on /.test(off.reason), off.reason);

// B10: gates on two stages. The plan must take the stage and count from the gates of the career's own stage, not from
// whichever gate comes first. Move the first gate to the next stage with a count of 1 and put the career on the
// stage of the others.
{
  const gates = db.parts.filter((p) => p.item === 26 && p.type === 3);
  const S = gates[0].requirement >>> 16, moved = gates[0];
  const db2 = { ...db, parts: db.parts.map((p) => (p === moved ? { ...p, requirement: ((S + 1) << 16) | 1 } : p)) };
  const rest = gates.filter((p) => p !== moved).map((p) => p.requirement & 0xffff);
  const atS = { career: save.recalculateChecksums(career.setCareerStage(state.career, S)), garage: null };
  const p2 = ops.urlWinsPlan(atS, db2), p1 = ops.urlWinsPlan(atS, db);
  check('B10 with gates on two stages, the plan uses the gates of the career\'s stage', gates.length > 1 && !/^Only on /.test(p2.reason) && p2.stage === p1.stage && p2.required === Math.max(...rest), `${p2.stage} ${p2.required} | ${p2.reason}`);
  const atOther = { career: save.recalculateChecksums(career.setCareerStage(state.career, S === 1 ? 3 : 1)), garage: null };
  const p3 = ops.urlWinsPlan(atOther, db2);
  check('B10 on a stage with no gate, the refusal names both gated stages', !p3.applies && /^Only on .+ or .+, where/.test(p3.reason), p3.reason);
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exitCode = fail ? 1 : 0;
