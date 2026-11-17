// Undo history: a snapshot of the profile's files before every write, kept in extension storage.
// `store` is { get(key) -> Promise<value|undefined>, set(key, value) -> Promise, all?() -> Promise<{key: value}>,
// lock?(fn) -> Promise }. lock runs fn alone: two side panels in two windows share one storage, so every
// read-modify-write of a history runs inside it and neither panel's entry is lost.
// Extension storage holds 10 MB and one entry is about 90 KB, so a full store drops the oldest entries to make room.

export const MAX_ENTRIES = 25;
const isQuota = (err) => /quota/i.test(String(err?.message ?? err));
const locked = (store, fn) => (store.lock ? store.lock(fn) : fn());

export function toB64(bytes) {
  if (!bytes) return null;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(text) {
  if (text == null) return null;
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes ?? new Uint8Array(0)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One hash for a profile's state, so a write can be checked against what was meant. */
export async function stateHash(state) {
  return `${await sha256(state.career)}:${state.garage ? await sha256(state.garage) : 'none'}`;
}

export const historyKey = (saveDir, profile) => `hist:${saveDir}/${profile}`;

function encode(state) { return { career: toB64(state.career), garage: toB64(state.garage) }; }
export function decode(snap) { return { career: fromB64(snap.career), garage: fromB64(snap.garage) }; }

export async function load(store, key) {
  return (await store.get(key)) ?? { original: null, entries: [] };
}

/**
 * Records the state before an edit. The first record of a profile also becomes its original.
 * `progress` is { before, after }, each { events, stage } (claim reads it), or left out.
 * Each profile keeps its last MAX_ENTRIES entries. When storage is full, the oldest entries of any profile are
 * dropped until the new one fits; no original is ever dropped. Returns the new entry with `dropped`, the number of
 * old entries that went. Throws only when the store is full of originals and newer entries alone.
 */
export function record(store, key, label, before, after, progress = {}) {
  return locked(store, () => recordNow(store, key, label, before, after, progress));
}

async function recordNow(store, key, label, before, after, progress) {
  const h = await load(store, key);
  const at = new Date().toISOString();
  if (!h.original) h.original = { at, hash: await stateHash(before), ...(progress.before ? { progress: progress.before } : {}), ...encode(before) };
  const added = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label, at,
    beforeHash: await stateHash(before), afterHash: await stateHash(after),
    ...(progress.before && progress.after ? { beforeProgress: progress.before, afterProgress: progress.after } : {}), ...encode(before) };
  h.entries.push(added);
  let dropped = 0;
  if (h.entries.length > MAX_ENTRIES) dropped += h.entries.splice(0, h.entries.length - MAX_ENTRIES).length;
  for (;;) {
    try {
      await store.set(key, h);
      return { ...added, dropped };
    } catch (err) {
      if (!isQuota(err) || !await dropOldest(store, key, h, added.id)) {
        if (isQuota(err)) throw new Error('Extension storage is full of saved originals, so this edit cannot be recorded for Undo. Nothing was written.');
        throw err;
      }
      dropped++;
    }
  }
}

/** Drops the oldest entry of any profile, never an original and never `keep`. `h` is key's history, not yet stored. */
async function dropOldest(store, key, h, keep) {
  const all = { ...(store.all ? await store.all() : {}), [key]: h };
  let oldest = null;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('hist:') || !Array.isArray(v?.entries)) continue;
    for (const e of v.entries) if (e.id !== keep && (!oldest || e.at < oldest.e.at)) oldest = { k, v, e };
  }
  if (!oldest) return false;
  oldest.v.entries = oldest.v.entries.filter((e) => e !== oldest.e);
  if (oldest.k !== key) await store.set(oldest.k, oldest.v); // smaller than before, so it fits
  return true;
}

export async function entry(store, key, id) {
  const h = await load(store, key);
  if (id === 'original') return h.original ? { label: 'Original', ...h.original } : null;
  return h.entries.find((e) => e.id === id) ?? null;
}

/** Removes an entry whose write was refused, so history only lists writes that happened. */
export function drop(store, key, id) {
  return locked(store, async () => {
    const h = await load(store, key);
    const gone = h.entries.find((e) => e.id === id);
    h.entries = h.entries.filter((e) => e.id !== id);
    // A refused first write also takes back the original it created.
    if (gone && !h.entries.length && h.original?.at === gone.at) h.original = null;
    await store.set(key, h);
  });
}

/**
 * Whether a profile's history belongs to the career now on disk. A profile deleted in game and created again under the
 * same name starts over, so its story progress is behind every point the history saw on disk. In game, progress only
 * goes up; after the newest write the disk holds its before or its after state (a write that failed halfway keeps its
 * entry), so the career is new when it is behind both. Then the history moves to an archive key, out of sight and out
 * of Undo, and the profile starts a fresh one. `current` is { hash, progress: { events, stage } }. Returns
 * { archived: entries moved, original included } or { archived: 0 }. History from before progress was recorded is kept.
 */
export function claim(store, key, current) {
  return locked(store, async () => {
    const h = await load(store, key);
    const last = h.entries.at(-1);
    const seen = last ? (last.beforeProgress && last.afterProgress ? [last.beforeProgress, last.afterProgress] : null)
      : h.original?.progress ? [h.original.progress] : null;
    if (!seen || !current?.progress) return { archived: 0 };
    if (current.hash === (last ? last.afterHash : h.original.hash)) return { archived: 0 };
    const behind = (p) => current.progress.events < p.events || current.progress.stage < p.stage;
    if (!seen.every(behind)) return { archived: 0 };
    await store.set(`${key}~${h.original?.at ?? new Date().toISOString()}`, h);
    await store.set(key, { original: null, entries: [] });
    return { archived: h.entries.length + (h.original ? 1 : 0) };
  });
}
