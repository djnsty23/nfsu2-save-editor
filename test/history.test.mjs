// Undo history against a store with a size limit, the way chrome.storage.local refuses a write past its quota.
// Usage: node test/history.test.mjs
import * as hist from '../src/history.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

/** An in-memory store that refuses a set once every value together passes `limit` bytes of JSON. */
function limitedStore(limit, failWith = null) {
  const data = {};
  const size = (d) => Object.values(d).reduce((n, v) => n + JSON.stringify(v).length, 0);
  return {
    data,
    sets: 0,
    get: async (k) => (k in data ? structuredClone(data[k]) : undefined),
    all: async () => structuredClone(data),
    async set(k, v) {
      this.sets++;
      if (failWith) throw new Error(failWith);
      const next = { ...data, [k]: v };
      if (size(next) > limit) throw new Error('Resource::kQuotaBytes quota exceeded'); // Chrome's own message
      data[k] = structuredClone(v);
    },
  };
}
// A career and garage the size of a real profile (55 KB and 10 KB), each edit different.
let seq = 0;
const state = () => {
  const career = new Uint8Array(55000), garage = new Uint8Array(10200);
  for (let i = 0; i < career.length; i++) career[i] = (i * 31 + seq * 7) & 255;
  garage[0] = seq & 255;
  seq++;
  return { career, garage };
};
const entrySize = JSON.stringify({ career: hist.toB64(state().career), garage: hist.toB64(state().garage) }).length;
const A = hist.historyKey('save', 'Racer'), B = hist.historyKey('save', 'Other');

// Room for the store to fill: an original plus about ten entries.
{
  const store = limitedStore(entrySize * 11.5);
  const first = state();
  let s = first, prev = null, droppedTotal = 0, failed = null;
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const next = state();
    try { const e = await hist.record(store, A, `edit ${i}`, s, next); ids.push(e.id); droppedTotal += e.dropped; } catch (err) { failed = err.message; break; }
    prev = s; s = next;
  }
  const h = await hist.load(store, A);
  check('a full store never fails an edit: 30 records in room for about 10', failed === null, failed ?? '');
  check('the original stays the very first state', h.original && h.original.career === hist.toB64(first.career));
  check('what is left is the newest entries, in order', h.entries.length > 5 && h.entries.map((e) => e.id).join() === ids.slice(-h.entries.length).join(), `${h.entries.length} kept`);
  check('every dropped entry is reported', droppedTotal === 30 - h.entries.length, `${droppedTotal} dropped`);
  const top = hist.decode(h.entries.at(-1));
  check('the newest entry decodes to the exact state before the last edit', top.career.length === prev.career.length && top.career.every((b, i) => b === prev.career[i]) && top.garage.every((b, i) => b === prev.garage[i]));
}

// One profile filled the store; another profile's first edit makes room from it, and keeps both originals.
{
  const store = limitedStore(entrySize * 12.5);
  let s = state();
  const aFirst = s;
  for (let i = 0; i < 20; i++) { const next = state(); await hist.record(store, A, `a ${i}`, s, next); s = next; }
  const aBefore = (await hist.load(store, A)).entries.length;
  const bFirst = state();
  let res = null, err = null;
  try { res = await hist.record(store, B, 'b 0', bFirst, state()); } catch (e) { err = e.message; }
  const a = await hist.load(store, A), b = await hist.load(store, B);
  check("another profile's first edit fits by dropping the full profile's oldest entries", err === null && res.dropped >= 1 && a.entries.length === aBefore - res.dropped, err ?? `${res.dropped} dropped from A`);
  check('both originals are kept', a.original?.career === hist.toB64(aFirst.career) && b.original?.career === hist.toB64(bFirst.career));
  check('the new profile has its entry', b.entries.length === 1 && b.entries[0].id === res.id);
}

// Room is never found by dropping originals.
{
  const store = limitedStore(entrySize * 1.5);
  let err = null;
  try { await hist.record(store, A, 'first', state(), state()); } catch (e) { err = e.message; }
  check('a store too small for an original and one entry refuses with a clear message', /storage is full/.test(err ?? ''), err ?? 'no error');
  check('and stores nothing half', Object.keys(store.data).length === 0);
}

// Any other storage error is not a reason to drop history.
{
  const store = limitedStore(1e9, 'disk on fire');
  let err = null;
  try { await hist.record(store, A, 'x', state(), state()); } catch (e) { err = e.message; }
  check('a storage error other than quota is passed through, after one try', err === 'disk on fire' && store.sets === 1, err ?? 'no error');
}

// With room to spare, only the per-profile cap drops entries.
{
  const store = limitedStore(1e9);
  let s = state(), last = null;
  const dropped = [];
  for (let i = 0; i < hist.MAX_ENTRIES + 3; i++) { const next = state(); last = await hist.record(store, A, `e ${i}`, s, next); dropped.push(last.dropped); s = next; }
  const h = await hist.load(store, A);
  check(`a profile keeps its last ${hist.MAX_ENTRIES} entries`, h.entries.length === hist.MAX_ENTRIES && h.entries.at(-1).id === last.id);
  check('drops are reported only past the cap', dropped.slice(0, hist.MAX_ENTRIES).every((n) => n === 0) && dropped.slice(hist.MAX_ENTRIES).every((n) => n === 1), dropped.join(''));
}

// B11: two panels record at once. Each get and set waits a moment, as chrome.storage does, so without the lock both
// read the same history and the second set wipes the first entry.
{
  const slow = () => {
    const s = limitedStore(1e9), get = s.get, set = s.set.bind(s);
    s.get = async (k) => { const v = await get(k); await new Promise((r) => setTimeout(r, 5)); return v; };
    s.set = async (k, v) => { await new Promise((r) => setTimeout(r, 5)); return set(k, v); };
    return s;
  };
  let queue = Promise.resolve();
  const lock = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const store = Object.assign(slow(), { lock });
  const s0 = state();
  await Promise.all([1, 2, 3].map((n) => hist.record(store, A, `panel ${n}`, s0, state())));
  const h = await hist.load(store, A);
  check('three panels recording at once keep all three entries', h.entries.length === 3, h.entries.map((e) => e.label).join(', '));
  const r = await hist.record(store, A, 'gone', s0, state());
  await Promise.all([hist.drop(store, A, r.id), hist.record(store, A, 'kept', s0, state())]);
  const h2 = await hist.load(store, A);
  check('a drop beside a record removes only its own entry', !h2.entries.some((e) => e.label === 'gone') && h2.entries.some((e) => e.label === 'kept') && h2.entries.length === 4);
}

// B4: a profile created again under the same name does not inherit the old career's history; progress made in game
// on the same career keeps it, and so does an Undo or a write that failed halfway.
{
  const store = limitedStore(1e9);
  const p = (events, stage) => ({ events, stage });
  const s1 = state(), s2 = state(), later = state(), fresh = state();
  await hist.record(store, A, 'money', s1, s2, { before: p(40, 3), after: p(40, 3) });
  const hashOf = async (s) => hist.stateHash(s);
  let c = await hist.claim(store, A, { hash: await hashOf(later), progress: p(52, 3) });
  check('the same career after more races in game keeps its history', c.archived === 0 && (await hist.load(store, A)).entries.length === 1);
  c = await hist.claim(store, A, { hash: await hashOf(s1), progress: p(40, 3) });
  check('the save still at the before state (a write that failed) keeps its history', c.archived === 0);
  c = await hist.claim(store, A, { hash: await hashOf(fresh), progress: p(0, 1) });
  const h = await hist.load(store, A), all = await store.all();
  const archive = Object.keys(all).find((k) => k.startsWith(`${A}~`));
  check('a new career under the same name starts a fresh history', c.archived === 2 && !h.original && h.entries.length === 0, `archived ${c.archived}`);
  check('the old history is kept under an archive key that no profile name can take', !!archive && all[archive].entries.length === 1 && /:/.test(archive.slice(A.length)));
  // An Undo that took the career back: the newest entry's after state is lower, and the disk holds it.
  const store2 = limitedStore(1e9);
  await hist.record(store2, A, 'finish story', s1, s2, { before: p(40, 3), after: p(224, 6) });
  await hist.record(store2, A, 'Undo: finish story', s2, s1, { before: p(224, 6), after: p(40, 3) });
  c = await hist.claim(store2, A, { hash: await hashOf(s1), progress: p(40, 3) });
  check('after an Undo that lowered progress, the history stays', c.archived === 0);
  // History written before progress was recorded cannot be judged, so it stays.
  const store3 = limitedStore(1e9);
  await hist.record(store3, A, 'old', s1, s2);
  c = await hist.claim(store3, A, { hash: await hashOf(fresh), progress: p(0, 1) });
  check('history without recorded progress is kept', c.archived === 0);
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exitCode = fail ? 1 : 0;
