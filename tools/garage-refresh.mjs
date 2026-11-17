// Builds the ready-made garage (src/garage-data.js) and its per-car table (docs/garage-defaults.md) from one career.
//
// Usage: node tools/garage-refresh.mjs --bun <GLOBALB.BUN> --from <save zip | folder of save zips | profile folder>
//          [--profile <name>] [--out src/garage-data.js] [--doc docs/garage-defaults.md] [--check]
//
// --from a folder of zips takes the newest nfsu2-saves-*.zip in it (the editor's "Download backup" file). In a zip or
// a save folder the career written last is used, unless --profile names one. Snapshot copies the game keeps beside a
// career ("<name> DVD 4", "<name> Magazine 10") are never picked.
//
// What ships is derived values only (src/garage-designs.js says which). Before anything is written, the output must
// pass the allowlist check and must not contain the career's profile name in any spelling: plain text in any case,
// UTF-16 or hex. Any failure exits 1 and leaves the old files as they were. Exit 0 with "unchanged" when the career
// gives the same garage as the shipped one. --check only compares and writes nothing (exit 3 when it would change).
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.js';
import * as designs from '../src/garage-designs.js';
import { readZip } from '../src/zip.js';
import * as save from '../vendor/hackch/model/save-file.js';
import * as dyno from '../vendor/hackch/model/dyno.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAREER_SIZE = 54966;
const SNAPSHOT = /\s(DVD|Magazine)\s+\d+$/i;
const STREET_X = 3, DRAG = 1, DRIFT = 2;
// A rear-drive car this heavy keeps its rear ride height stock in the grip setups (measured mass in tonnes on its
// parts: Supra 1.374, 350Z 1.300; the light ones are 0.92 to 1.12).
const HEAVY_TONNES = 1.29;

function args(argv) {
  const out = { out: join(root, 'src', 'garage-data.js'), doc: join(root, 'docs', 'garage-defaults.md') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (['--bun', '--from', '--profile', '--out', '--doc'].includes(a)) out[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.bun || !out.from) throw new Error('usage: node tools/garage-refresh.mjs --bun <GLOBALB.BUN> --from <zip | folder> [--profile <name>] [--check]');
  return out;
}

const ymd = (d) => d.toISOString().slice(0, 10);

/** The modified date of each entry in a zip's table of contents (DOS time), by name. */
function zipDates(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder();
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  const out = new Map();
  if (end < 0) return out;
  let p = dv.getUint32(end + 16, true);
  for (let n = dv.getUint16(end + 10, true); n > 0; n--) {
    const time = dv.getUint16(p + 12, true), date = dv.getUint16(p + 14, true);
    const nameLen = dv.getUint16(p + 28, true), skip = nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.set(name, new Date(Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2)));
    p += 46 + skip;
  }
  return out;
}

/** Careers in a zip or a folder: [{ name, career, garage, written }]. */
async function careersFrom(from) {
  const st = statSync(from);
  if (st.isDirectory()) {
    const zips = readdirSync(from).filter((f) => /^nfsu2-saves-.*\.zip$/i.test(f)).map((f) => join(from, f));
    if (zips.length) return careersFrom(zips.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]);
    const name = basename(from), career = join(from, name);
    if (!existsSync(career)) throw new Error(`${from} holds no nfsu2-saves-*.zip and no career file named after the folder`);
    const g = join(from, 'GARAGE.DAT');
    return [{ name, career: new Uint8Array(readFileSync(career)), garage: existsSync(g) ? new Uint8Array(readFileSync(g)) : null, written: statSync(career).mtime, source: from }];
  }
  const bytes = new Uint8Array(readFileSync(from));
  const entries = await readZip(bytes, { want: (n, size) => size === CAREER_SIZE || /(^|\/)GARAGE\.DAT$/i.test(n) });
  const dates = zipDates(bytes), files = new Map(entries.filter((e) => e.data).map((e) => [e.name, e.data]));
  const out = [];
  for (const [path, data] of files) {
    const parts = path.split('/');
    if (parts.length < 2 || data.length !== CAREER_SIZE) continue;
    const name = parts.at(-1), folder = parts.at(-2);
    if (name !== folder || SNAPSHOT.test(name)) continue;
    const g = [...parts.slice(0, -1), 'GARAGE.DAT'].join('/');
    out.push({ name, career: data, garage: files.get(g) ?? null, written: dates.get(path) ?? statSync(from).mtime, source: from });
  }
  return out;
}

function pickCareer(list, want) {
  if (!list.length) throw new Error('no career found');
  if (want) {
    const hit = list.find((c) => c.name === want);
    if (!hit) throw new Error(`no career named as given among ${list.length}`);
    return hit;
  }
  return [...list].sort((a, b) => b.written - a.written)[0];
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const neutral = (bytes) => ops.sliderBytes(bytes).every((x) => x === dyno.NEUTRAL_BYTE);

/** The ready-made garage from one career: { data, rows } where rows feed the per-car table. */
export function buildGarage(state, db, saved) {
  const sum = ops.summary(state, db);
  const cars = sum.cars;
  if (!cars.length) throw new Error('the career has no car');
  const corolla = cars.find((c) => /COROLLA/i.test(dbName(db, state, c.index)));
  const template = corolla ? ops.sliderTargets(state, corolla.index, STREET_X, db) : ops.researchSliders('COROLLA', STREET_X);
  const out = [], rows = [];
  for (const c of cars.slice(0, designs.MAX_CARS)) {
    const slot = c.index, name = dbName(db, state, slot);
    const drive = ops.carDrive(state, slot, db);
    if (!drive) throw new Error(`${c.name} is not in the game data`);
    const rear = drive.rear >= 0.7, front = drive.rear <= 0.3, heavy = rear && drive.mass >= HEAVY_TONNES;
    const isTemplate = corolla && slot === corolla.index;
    const reason = isTemplate ? 'template' : front ? 'fwd' : !rear ? 'awd' : heavy ? 'rwdHeavy' : 'rwd';
    const design = ops.readDesign(state, slot);
    // Parts left over from an earlier model in this slot do not ship: each becomes the part a stock car of this
    // model has there.
    const foreign = ops.foreignParts(state, slot, db);
    if (foreign.length) {
      const hash = ops.carHashInSlot(state, slot);
      const alt = ops.carChoices(state, db).find((x) => x.player && x.available && x.hash !== hash).hash;
      const stock = ops.readDesign(ops.changeCar(ops.changeCar(state, slot, alt, db), slot, hash, db), slot);
      const v = designs.fromHex(design.visual), sv = designs.fromHex(stock.visual);
      for (const i of foreign) v.set(sv.subarray(i * 4, i * 4 + 4), i * 4);
      design.visual = designs.toHex(v);
    }
    const setups = [], tuning = [], notes = [];
    for (let k = 0; k < dyno.SETUP_COUNT; k++) {
      const now = designs.fromHex(design.setups[k]);
      const rule = k === DRAG ? (front ? 'dragFront' : 'dragRear') : k === DRIFT ? 'drift' : heavy ? 'streetHeavy' : 'street';
      const targets = k === DRAG ? ops.researchSliders(front ? 'ANY' : 'COROLLA', DRAG) : k === DRIFT ? ops.researchSliders('ANY', DRIFT)
        : heavy ? { ...template, 7: 'stock' } : template;
      // His own tuning wins: a tuned setup whose sliders match no preset was set by hand in the game, and the
      // template itself is kept byte for byte.
      const presets = [targets, template, { ...template, 7: 'stock' }, ops.researchSliders('COROLLA', k), ops.researchSliders('ANY', k)];
      const byHand = !neutral(now) && presets.every((t) => !same(ops.sliderBytes(ops.previewSliders(state, slot, k, db, t)), ops.sliderBytes(now)));
      if ((isTemplate && k === STREET_X) || byHand) {
        setups.push(design.setups[k]); tuning.push('kept');
        const s = ops.setupStats(state, slot, k, db);
        notes.push({ rule: 'kept', quarter: s.quarter, t60: s.t60 });
        continue;
      }
      const r = ops.tuneSetup(state, slot, k, db, targets);
      setups.push(designs.toHex(r.bytes)); tuning.push(rule);
      notes.push({ rule, quarter: r.after.quarter, t60: r.after.t60 });
    }
    out.push({ car: name, reason, visual: design.visual, perf: design.perf, owned: design.owned, uniques: design.uniques, setups, tuning });
    rows.push({ car: c.name, reason, drive, notes, looks: lookCount(design), foreign: foreign.length });
  }
  return { data: { schema: designs.SCHEMA, saved, cars: out }, rows };
}

function dbName(db, state, slot) {
  const hash = ops.carHashInSlot(state, slot);
  return db.cars.find((c) => c.hash === hash)?.name ?? '';
}
const lookCount = (design) => designs.visualRefs(design).filter((v) => v !== 0).length;

/** Every spelling of a name that could ride along in text: as typed, any case, UTF-16 and hex. */
export function nameLeaks(text, name) {
  if (!name) return [];
  const low = text.toLowerCase(), found = [];
  if (low.includes(name.toLowerCase())) found.push('plain text');
  const utf16 = [...name].map((ch) => `${ch}\u0000`).join('');
  if (text.includes(utf16)) found.push('UTF-16');
  const hex = designs.toHex(new TextEncoder().encode(name.toLowerCase())), hexUp = designs.toHex(new TextEncoder().encode(name.toUpperCase()));
  const hexAsIs = designs.toHex(new TextEncoder().encode(name));
  if ([hex, hexUp, hexAsIs].some((h) => low.includes(h))) found.push('hex');
  return found;
}

const MODE = ['Circuit', 'Drag', 'Drift', 'Street X', 'URL'];
function docText(data, rows) {
  const lines = [
    '# Ready-made garage',
    '',
    `Generated by \`tools/garage-refresh.mjs\` from a career saved on ${data.saved}. Do not edit: run the tool again.`,
    'Times are the dyno model\'s straight-line simulation (quarter mile, 0-60 mph). It has no handling model, so the',
    'Circuit, Drift, Street X and URL sliders rest on the published setups and the Corolla Street X, not on the dyno.',
    '',
    '| Car | Design kept | Drive, mass, hp | ' + MODE.join(' | ') + ' | Reason | Tested in game |',
    '|---|---|---|' + MODE.map(() => '---').join('|') + '|---|---|',
  ];
  for (const r of rows) {
    const drive = r.drive.rear >= 0.7 ? 'RWD' : r.drive.rear <= 0.3 ? 'FWD' : 'AWD';
    const cells = r.notes.map((n) => `${designs.TUNING_RULES[n.rule]} (q ${n.quarter.toFixed(2)} s)`);
    const tested = r.reason === 'template' ? 'Street X: yes, by the owner. Other modes: no' : r.notes.some((n) => n.rule === 'kept') ? 'kept setups: yes. Others: no' : 'no';
    lines.push(`| ${r.car} | yes, ${r.looks} visual parts | ${drive}, ${r.drive.mass.toFixed(2)} t, ${Math.round(r.drive.hp)} hp | ${cells.join(' | ')} | ${designs.CAR_REASONS[r.reason]} | ${tested} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

async function main() {
  const a = args(process.argv.slice(2));
  const pick = pickCareer(await careersFrom(a.from), a.profile);
  const state = { career: pick.career, garage: pick.garage };
  ops.validate(state);
  const db = ops.hydrateDb(JSON.parse(JSON.stringify(ops.parseGameDb(new Uint8Array(readFileSync(a.bun))))));
  const { data, rows } = buildGarage(state, db, ymd(pick.written));
  const text = designs.moduleText(data), doc = docText(data, rows);
  const bad = designs.checkGarageModuleText(text);
  if (bad.length) throw new Error(`the garage fails the allowlist: ${bad.join('; ')}`);
  for (const name of new Set([save.getName(pick.career), pick.name])) {
    for (const [what, t] of [['src/garage-data.js', text], ['the per-car table', doc]]) {
      const leaks = nameLeaks(t, name);
      if (leaks.length) throw new Error(`${what} would contain the profile name (${leaks.join(', ')}). Nothing was written.`);
    }
  }
  // The save date alone is not a change: a career saved again with the same cars gives the same garage.
  const old = existsSync(a.out) ? readFileSync(a.out, 'utf8') : '';
  const strip = (t) => t.replace(/"saved": "[^"]*"/, '');
  if (strip(old) === strip(text)) { console.log(`unchanged: ${data.cars.length} cars, career saved ${data.saved}`); return; }
  if (a.check) { console.log(`would change: ${data.cars.length} cars, career saved ${data.saved}`); process.exitCode = 3; return; }
  writeAtomic(a.out, text);
  writeAtomic(a.doc, doc);
  console.log(`written: ${data.cars.length} cars, career saved ${data.saved}`);
  for (const r of rows) console.log(`  ${r.car.padEnd(22)} ${r.reason.padEnd(9)} ${r.notes.map((n) => n.rule).join(', ')}${r.foreign ? `, ${r.foreign} leftover parts replaced by stock` : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`garage-refresh: ${err.message}`); process.exitCode = 1; });
}
