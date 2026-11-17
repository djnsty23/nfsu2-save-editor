// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error('sidePanel', err));

// @dev-only begin worker
// Everything down to "@dev-only end worker" serves the unpacked dev install only: tools/build-store.cjs leaves it out
// of the Chrome Web Store build, where Chrome updates the extension and the panel never messages this worker.

// ---- Self-update of the unpacked install --------------------------------------------------------
// The git hooks from tools/install-hooks.cjs rewrite build.json after every commit. An unpacked extension serves
// its files from disk, so this worker sees the new stamp, waits until no save write is running, and reloads the
// extension. Undo history is in chrome.storage.local and survives the reload. A copy without build.json (a fresh
// clone before the hooks are installed) never reloads.
const STAMP_URL = chrome.runtime.getURL('build.json');
const ALARM = 'build-check';
// A write lease older than this belongs to a panel that closed mid-write. Best version of every car takes
// about 3.5 minutes on a 10-car career, so this leaves room for a much larger garage.
const LEASE_MAX_MS = 15 * 60 * 1000;
const PANEL_URL = chrome.runtime.getURL('panel/');

// Lease and update decisions run one at a time, so a write cannot start between "no write running" and the reload.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}
let reloading = false;

async function readStamp() {
  try {
    const res = await fetch(STAMP_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const s = await res.json();
    return typeof s?.commit === 'string' && typeof s?.short === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** The stamp this instance loaded with: read once per extension load, kept in session storage across worker restarts. */
async function loadedStamp() {
  const { loadedBuild } = await chrome.storage.session.get('loadedBuild');
  if (loadedBuild !== undefined) return loadedBuild;
  const now = await readStamp();
  await chrome.storage.session.set({ loadedBuild: now });
  return now;
}

async function leases() {
  const { writeLeases = {} } = await chrome.storage.session.get('writeLeases');
  const now = Date.now();
  for (const [id, at] of Object.entries(writeLeases)) if (now - at > LEASE_MAX_MS) delete writeLeases[id];
  return writeLeases;
}

function checkForUpdate() {
  return serial(async () => {
    if (reloading) return { updating: true };
    const loaded = await loadedStamp(), disk = await readStamp();
    if (!disk || disk.commit === loaded?.commit) return { current: disk?.short ?? null };
    if (Object.keys(await leases()).length) return { waiting: disk.short };
    reloading = true;
    await chrome.storage.local.set({ updateNote: { from: loaded?.short ?? null, to: disk.short } });
    // A moment for the reply to reach the panel before the reload closes it.
    setTimeout(() => chrome.runtime.reload(), 200);
    return { updating: disk.short };
  });
}

const LEASE_ID = /^[0-9a-f-]{36}$/;
const UPDATING = (to) => `The editor is updating${to ? ` to ${to}` : ''}, so nothing was written. Open the panel again in a few seconds and click again.`;

/**
 * A write lease, under the panel's own id (a resend of a begin whose answer was lost renews the same lease). No write
 * starts while a new version waits on disk: the panel's preset worker loads its code from disk when it starts, so an
 * edit would mix two versions, and the reload it waits for would come right after. Without another write running,
 * the update applies now.
 */
function beginWrite(asked) {
  return serial(async () => {
    if (reloading) return { ok: false, updating: true, why: UPDATING('') };
    const all = await leases();
    const id = LEASE_ID.test(asked) ? asked : crypto.randomUUID();
    if (!(id in all)) {
      const loaded = await loadedStamp(), disk = await readStamp();
      if (disk && disk.commit !== loaded?.commit) {
        if (!Object.keys(all).length) {
          reloading = true;
          await chrome.storage.local.set({ updateNote: { from: loaded?.short ?? null, to: disk.short } });
          setTimeout(() => chrome.runtime.reload(), 200);
        }
        return { ok: false, updating: true, why: UPDATING(disk.short) };
      }
    }
    all[id] = Date.now();
    await chrome.storage.session.set({ writeLeases: all });
    return { ok: true, id };
  });
}

// The panel renews its lease every minute while a write runs, so a long one (the best version of every car takes
// about 20 seconds a car) never outlives the 15 minutes and lets an update reload the extension under it.
function renewWrite(id) {
  return serial(async () => {
    const all = await leases();
    if (!(id in all)) return { ok: false };
    all[id] = Date.now();
    await chrome.storage.session.set({ writeLeases: all });
    return { ok: true };
  });
}

function endWrite(id) {
  return serial(async () => {
    const all = await leases();
    delete all[id];
    await chrome.storage.session.set({ writeLeases: all });
    return { ok: true };
  });
}

// ---- Moving the install folder --------------------------------------------------------------------
// Chrome names an unpacked extension after its folder, so a copy loaded from a new folder starts with empty storage.
// build.json lists the copies allowed to read this copy's undo history (historyReaders, written in the repo by
// tools/stamp-build.cjs) and the copy this one reads from once (historyFrom, written in the install folder by
// tools/export-install.cjs). Nothing else can ask: another extension's request is refused unless its ID is listed.
const ID_RE = /^[a-p]{32}$/;
const listedIds = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && ID_RE.test(x) && x !== chrome.runtime.id) : []);
// Undo history per profile (with each profile's original) and the last music folder check.
const carried = (key) => key.startsWith('hist:') || key === 'musicScan';
const historyShaped = (v) => v && typeof v === 'object' && Array.isArray(v.entries);
// The panel checks a music check field by field when it reads one (music.readScan); this keeps a malformed one from
// being carried over at all.
const musicShaped = (v) => v && typeof v === 'object' && Array.isArray(v.found) && Array.isArray(v.rows)
  && [v.files, v.scanned, v.zips].every((x) => Number.isInteger(x) && x >= 0) && Number.isFinite(v.when);

chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (msg?.type !== 'exportHistory') return false;
  (async () => {
    if (!listedIds((await readStamp())?.historyReaders).includes(sender.id)) return reply({ ok: false });
    const all = await chrome.storage.local.get(null);
    reply({ ok: true, items: Object.fromEntries(Object.entries(all).filter(([k]) => carried(k))) });
  })().catch(() => reply({ ok: false }));
  return true;
});

/** Once per install: copies the old install's history for profiles this copy has no history of yet. */
function importHistory() {
  return serial(async () => {
    const { historyImported } = await chrome.storage.local.get('historyImported');
    if (historyImported) return { done: historyImported.from };
    for (const id of listedIds((await readStamp())?.historyFrom)) {
      // A missing or older copy has no listener, and the send rejects at once.
      const res = await chrome.runtime.sendMessage(id, { type: 'exportHistory' }).catch(() => null);
      if (!res?.ok || !res.items || typeof res.items !== 'object') continue;
      const have = await chrome.storage.local.get(null);
      const add = Object.fromEntries(Object.entries(res.items).filter(([k, v]) => carried(k) && !(k in have) && (k === 'musicScan' ? musicShaped(v) : historyShaped(v))));
      const profiles = Object.keys(add).filter((k) => k.startsWith('hist:')).length;
      await chrome.storage.local.set({ ...add, historyImported: { from: id, keys: Object.keys(add).length, at: Date.now() }, ...(profiles ? { importNote: { profiles } } : {}) });
      return { imported: profiles, from: id };
    }
    return { none: true };
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only the extension's own panel talks to the worker. The site's content script answers the panel, never this.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(PANEL_URL)) return false;
  const job = msg?.type === 'writeBegin' ? beginWrite(String(msg.id ?? ''))
    : msg?.type === 'writeEnd' ? endWrite(String(msg.id))
      : msg?.type === 'writeRenew' ? renewWrite(String(msg.id))
      : msg?.type === 'checkUpdate' ? checkForUpdate()
        : msg?.type === 'importHistory' ? importHistory() : null;
  if (!job) return false;
  job.then(reply, (err) => reply({ ok: false, why: String(err?.message || err) }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) checkForUpdate().catch((err) => console.error('update check', err)); });
// Chrome 120+ allows a 30 second period; older versions round it up to a minute.
chrome.alarms.get(ALARM).then((a) => a || chrome.alarms.create(ALARM, { periodInMinutes: 0.5 })).catch((err) => console.error('alarm', err));
loadedStamp().catch((err) => console.error('build stamp', err));
// @dev-only end worker

// After an install, an update or a reload, put the content script into every open nfsu2.xyz tab, so the panel works
// without reloading the game. Chrome injects manifest content scripts only into pages loaded after the install, and a
// copy from before a reload is cut off from the extension and answers nothing. The panel also injects on its own
// when a message finds no receiver (panel.js sendTo), which covers a copy that was disabled and enabled again.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    for (const tab of await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' })) {
      // A tab that loaded after the reload already has the new copy: a second one would answer every request twice.
      const live = await chrome.tabs.sendMessage(tab.id, { type: 'ping' }).then((r) => r?.ok === true, () => false);
      if (!live) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  } catch (err) {
    console.error('reinject', err);
  }
});
