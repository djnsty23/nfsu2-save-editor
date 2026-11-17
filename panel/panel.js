import * as ops from '../src/ops.js';
import * as hist from '../src/history.js';
import { buildBackup, backupFileName, parseRestore, planRestore } from '../src/backup.js';
import { partWords, partLabel, makeOf } from '../src/labels.js';
import { CAR_REASONS } from '../src/garage-designs.js';
import { CAR_NAMES } from '../src/car-names.js';
import readyGarage from '../src/garage-data.js';
const $ = (id) => document.getElementById(id);
const store = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  all: () => chrome.storage.local.get(null),
  // Side panels in two windows share this storage: history writes take turns (src/history.js).
  lock: (fn) => navigator.locks.request('nfsu2-ext-history', fn),
};
// renderGen, histGen and connGen count renders and connects: an await that returns after a newer one started drops
// its result, so the panel never shows one profile's cars while another is selected. `rendered` is the profile the
// cars on screen were read from.
const ui = { ack: false, urlPlan: null, tabId: null, saveDir: 'save', profile: null, gate: null, db: null, dbJson: null, busy: false, reconnect: false, openCars: new Set(), state: null, rendered: null, looksTab: new Map(), openSwap: new Set(), carTab: new Map(), partsPending: new Map(), openParts: new Set(), autoCar: null, renderGen: 0, histGen: 0, connGen: 0 };
const WRITE_BUTTONS = ['setMoney', 'maxMoney', 'unlockAll', 'maxPerf', 'uniques', 'carbonAll', 'bestGarage', 'setStage', 'restoreOriginal', 'undoConfirmYes', 'garageReplace'];
const NEEDS_DB = ['unlockAll', 'carbonAll', 'bestGarage', 'garageReplace'];

// ---- talking to the nfsu2.xyz tab --------------------------------------------------------------

// Chrome's error when a tab has no live copy of this extension's content script: a tab opened before this copy was
// installed or enabled, or one whose copy was cut off by a reload. The message never reached the page.
const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/;
const RELOAD_TAB = 'The editor cannot reach the nfsu2.xyz tab. Reload that tab, then click Refresh. Nothing was written.';

// @dev-only begin worker-call
// The last time the panel restarted the extension because the worker never answered, and why.
const HEAL_KEY = 'workerHeal';
const HEAL_GAP_MS = 2 * 60 * 1000;

/**
 * The worker took no message after every retry. An unpacked install runs the worker it loaded until the extension
 * reloads, while the panel loads fresh from disk each time it opens. So a worker from an older copy (one with no
 * message listener, like the first commit's) or one that failed to start never answers again by itself, and every
 * write is refused (seen on a real install, 2026-11-14). Nothing reached the page, so restarting the extension is
 * safe: it loads the worker from disk. At most once per two minutes, so a worker that still cannot answer after a
 * restart is not restarted in a loop. Returns the message to show.
 */
async function workerLost() {
  let running = null;
  try { running = (await chrome.runtime.getContexts({ contextTypes: ['BACKGROUND'] })).length > 0; } catch { /* left unknown */ }
  const cause = running === true ? 'it was running without a message channel, an older copy of the editor'
    : running === false ? 'it was not running' : 'its state could not be read';
  return (await restartEditor(cause, true)).msg;
}

/**
 * Reloads the extension so Chrome reads the worker and manifest from disk again, at most once per two minutes.
 * Undo history is in chrome.storage.local under the same extension id and survives. `clicked`: a write was refused.
 * Returns the message to show, and whether the restart is on its way.
 */
async function restartEditor(cause, clicked) {
  const last = await store.get(HEAL_KEY).catch(() => null);
  if (last?.at && Date.now() - last.at < HEAL_GAP_MS) {
    return { restarting: false, msg: `This copy of the editor is out of date and restarting it did not help${clicked ? ', so nothing was read or written' : ''}. Open chrome://extensions, click the reload arrow on the NFSU2 Save Editor card, then open the panel again.` };
  }
  await chrome.storage.local.set({ [HEAL_KEY]: { at: Date.now(), cause, clicked, shown: false } });
  // A moment to read the message before the reload closes the panel.
  setTimeout(() => chrome.runtime.reload(), Number(document.body.dataset.healDelayMs) || 2500);
  return { restarting: true, msg: clicked
    ? `The editor's background did not answer (${cause}), so nothing was read or written. Updating the editor: reopen this panel in a few seconds and click again.`
    : `Updating the editor (${cause}): reopen this panel in a few seconds.` };
}

/**
 * When the panel opens: is the running copy older than the files on disk? The panel is always read from disk, but
 * the manifest (permissions, content script) and the worker are the ones loaded when the extension last loaded.
 * An install loaded at its first commit has neither the permissions nor a worker that answers (seen on a real
 * install, 2026-11-14). Returns the cause, or null when the running copy is current.
 */
async function staleCopy() {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const shape = (m) => JSON.stringify(canon([m.version, m.permissions ?? [], m.host_permissions ?? [], m.content_scripts ?? [], m.background ?? {}]));
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (shape(disk) !== shape(chrome.runtime.getManifest())) return 'the running copy is older than the one on disk';
  } catch { /* unreadable manifest: left to the worker check */ }
  // A type the worker ignores: any listener answers (with nothing), a worker without one never does.
  try { await toWorker({ type: 'ping' }); } catch (err) {
    if (NO_RECEIVER.test(String(err?.message || err))) return 'its background was an older copy with no message channel';
  }
  return null;
}

/**
 * One message to this extension's background worker, sent again (up to 3 times, about 4 s in all) while it has no
 * receiver: Chrome may be starting, stopping or swapping the worker. Nothing reached it, so a resend cannot run twice.
 */
async function toWorker(msg) {
  const waits = [300, 1000, 2500];
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (!NO_RECEIVER.test(String(err?.message || err)) || i >= waits.length) throw err;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}
// @dev-only end worker-call

/** Puts this copy's content script into a site tab. content.js lets only the newest copy in a tab answer. */
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); return true; } catch { return false; }
}

/**
 * One message to a site tab. When no content script received it, injects one and sends once more: the first send
 * never arrived, so a retried write cannot run twice. A second miss marks the tab lost and blocks writes.
 */
async function sendTo(tabId, msg) {
  // undefined: no content script received the message. null: a copy got it and let it go unanswered (a stale copy
  // ignores what it does not own). content.js answers every request it handles, errors included.
  const once = async () => {
    try {
      const r = await chrome.tabs.sendMessage(tabId, msg);
      return r === undefined ? null : r;
    } catch (err) {
      if (!NO_RECEIVER.test(String(err?.message || err))) throw err;
      return undefined;
    }
  };
  const first = await once();
  if (first) return first;
  // A write a copy received but did not answer may still have landed. Sending it again would be refused (the save
  // changed) and that refusal would delete the Undo entry of a write that happened, so the outcome stays unknown.
  if (first === null && msg.type === 'write') throw new Error('The page took the write but sent no answer, so the save may have changed.');
  if (await inject(tabId)) {
    const second = await once();
    if (second) return second;
  }
  if (tabId === ui.tabId) {
    ui.gate = { ok: false, why: 'tab lost' };
    setConn('Reload the nfsu2.xyz tab, then click Refresh.', 'bad');
  }
  const lost = new Error(RELOAD_TAB);
  lost.notDelivered = true;
  throw lost;
}

/** The active tab if it is nfsu2.xyz, otherwise the first nfsu2.xyz tab in the window (the one whose content script answers). */
async function findSiteTab() {
  const ping = async (id) => {
    try { return (await chrome.tabs.sendMessage(id, { type: 'ping' }))?.ok === true; } catch { return false; }
  };
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && await ping(active.id)) return active.id;
  for (const tab of await chrome.tabs.query({ lastFocusedWindow: true })) if (await ping(tab.id)) return tab.id;
  // No tab answers: a site tab opened before this copy was installed has no content script yet.
  for (const tab of await chrome.tabs.query({ lastFocusedWindow: true, url: 'https://nfsu2.xyz/*' })) {
    if (await inject(tab.id) && await ping(tab.id)) return tab.id;
  }
  return null;
}

async function send(msg) {
  if (ui.tabId == null) throw new Error('No tab.');
  const res = await sendTo(ui.tabId, { saveDir: ui.saveDir, ...msg });
  if (!res) throw new Error('No answer from the page.');
  return res;
}

/** Reads a profile: the selected one, or the one an edit started on (`at`), so a later change of selection cannot redirect it. */
async function readProfile(at = { saveDir: ui.saveDir, profile: ui.profile }) {
  const res = await send({ type: 'read', saveDir: at.saveDir, profile: at.profile });
  if (!res.ok) throw new Error(res.why);
  const state = { career: hist.fromB64(res.career), garage: hist.fromB64(res.garage) };
  ops.validate(state);
  return { state, careerSha: await hist.sha256(state.career), garageSha: state.garage ? await hist.sha256(state.garage) : null };
}

// ---- rendering ---------------------------------------------------------------------------------

function setConn(text, state) { const c = $('conn'); c.textContent = text; c.dataset.state = state; }

let toastTimer = 0;
/**
 * The one message line at the bottom. `undo` is a history entry id: a success shows Undo beside it (I9), which puts
 * that edit back. `progress` ({ done, total }) draws a bar under the text while a long job runs.
 */
function toast(text, { kind = 'ok', reload = false, undo: undoId = null, progress = null } = {}) {
  $('toastText').textContent = text;
  $('toast').dataset.kind = kind;
  $('toast').setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  $('reload').hidden = !reload;
  $('toastUndo').hidden = !undoId;
  $('toastUndo').dataset.id = undoId ?? '';
  const bar = $('toastProg');
  bar.hidden = !progress;
  if (progress) {
    const p = Math.round((100 * progress.done) / Math.max(1, progress.total));
    bar.setAttribute('aria-valuenow', String(p));
    bar.setAttribute('aria-valuetext', `${progress.done} of ${progress.total}`);
    bar.style.setProperty('--p', `${p}%`);
  }
  $('toast').hidden = false;
  // A failure stays until dismissed. Anything else goes after 4 s (8 s when it offers Reload), held while the pointer
  // or focus is on it and while an edit runs, since progress lines are toasts too. data-toast-ms shortens it in tests.
  clearTimeout(toastTimer);
  if (kind === 'bad') return;
  const ms = (Number(document.body.dataset.toastMs) || 4000) * (reload ? 2 : 1);
  const tick = () => {
    if (ui.busy || $('toast').matches(':hover, :focus-within')) { toastTimer = setTimeout(tick, ms); return; }
    $('toast').hidden = true;
  };
  toastTimer = setTimeout(tick, ms);
}

function setBusy(on) {
  ui.busy = on;
  // Nothing writes until the offline-only notice is confirmed (ui.ack).
  const blocked = on || !ui.ack || !ui.gate?.ok || !ui.profile;
  for (const id of WRITE_BUTTONS) $(id).disabled = blocked || (NEEDS_DB.includes(id) && !ui.db);
  $('unlockConfirmYes').disabled = blocked || !ui.db;
  if ($('unlockAll').disabled) hideUnlockConfirm();
  $('urlWins').disabled = $('urlWinsYes').disabled = blocked || !ui.db || !ui.urlPlan?.applies;
  if ($('urlWins').disabled) hideUrlWinsConfirm();
  for (const b of document.querySelectorAll('#history button, #cars [data-write]')) b.disabled = blocked || 'locked' in b.dataset;
  // Ready-made cars are built from the game data, and Replace needs the box ticked as well.
  for (const b of document.querySelectorAll('#garageList button, #garageList select')) b.disabled = blocked || !ui.db || !ui.garageSlots?.length;
  $('garageReplace').disabled ||= !ui.garageSlots?.length;
  $('garageReplaceYes').disabled = blocked || !ui.db || !$('garageAgree').checked;
  if ($('garageReplace').disabled) hideGarageConfirm();
  // Switching profile, reconnecting or reloading game data mid-write would change what the write is about.
  for (const id of ['profile', 'refresh', 'dbFromSite', 'dbFile']) $(id).disabled = on;
  $('toastUndo').disabled = blocked;
  // A restore needs no selected profile (it can fill an empty browser), only the notice and a safe gate.
  $('restoreFile').disabled = $('restoreYes').disabled = $('undoRestore').disabled = on || !ui.ack || !ui.gate?.ok;
  $('backupAll').disabled = on || !ui.profile;
  // The last toast's Reload button would reload the game tab under the write.
  if (on) $('reload').hidden = true;
}

/** A confirmation's list of changes (I7): one row per field, from and to. A null "from" is a line about the whole item. */
function fillDiff(list, rows) {
  list.replaceChildren(...rows.map(([k, from, to]) => {
    const li = document.createElement('li');
    if (from == null) li.append(el('span', { className: 'k head', textContent: k }), el('span', { className: 'whole', textContent: String(to) }));
    else li.append(el('span', { className: 'k', textContent: k }), el('s', { textContent: String(from) }), el('span', { textContent: '→', ariaHidden: 'true' }), el('b', { textContent: String(to) }));
    return li;
  }));
}

const fmt = (n) => n.toLocaleString('en-US');

/**
 * The story gates still shut, as what to win in game. Every gate reads the stage's won races or the stage itself,
 * so the only edit that opens them is finishing the story: this list is how to earn them instead.
 */
function renderStoryLocks() {
  const box = $('storyLocks');
  // The shortcut row is moved back home before the list is redrawn, so replaceChildren never drops it.
  $('urlWinsHome').append($('urlWinsBox'));
  let locks = [];
  try { locks = ui.db && ui.state ? ops.storyLocks(ui.state, ui.db) : []; } catch { locks = []; }
  box.hidden = !locks.length;
  $('unlocksEmpty').hidden = !!locks.length;
  $('unlocksEmpty').textContent = !ui.db
    ? 'Load the game data (the last card) to see what the story still locks and how to earn it.'
    : 'Nothing is locked by the story: every part can be bought.';
  if (!locks.length) return;
  const gates = locks.reduce((n, l) => n + l.gates, 0);
  $('storyLocksTitle').textContent = `${gates} part ${gates === 1 ? 'level' : 'levels'} still locked by the story, closest first. Win these in game to keep the career.`;
  // I3: one row per thing to win, closest first, naming the part it opens. The carbon body kit row carries its shortcut.
  $('storyLocksList').replaceChildren(...locks.map((l) => {
    const what = l.named.length ? l.named.join(' and ') : `${l.gates} part ${l.gates === 1 ? 'level' : 'levels'}`;
    const li = el('li', {}, el('div', { className: 'check-row' },
      el('span', { className: 'check-t' }, el('b', { textContent: what[0].toUpperCase() + what.slice(1) }), el('small', { textContent: `${l.need}${l.named.length ? ` · ${l.gates} part ${l.gates === 1 ? 'level' : 'levels'}` : ''}` }))));
    li.dataset.need = l.need;
    if (l.named.includes('carbon fibre body kits')) li.dataset.kit = '';
    return li;
  }));
  paintLocksMore();
}

/** I3: the closest few show; the rest open with Show all. The carbon body kit row always shows, with its shortcut. */
const LOCKS_SHOWN = 5;
function paintLocksMore() {
  const rows = [...$('storyLocksList').children], more = $('storyLocksMore');
  const extra = rows.filter((li, i) => i >= LOCKS_SHOWN && !('kit' in li.dataset));
  for (const li of rows) li.hidden = !ui.locksAll && extra.includes(li);
  more.hidden = !extra.length;
  more.textContent = ui.locksAll ? `Show the closest ${LOCKS_SHOWN}` : `Show all ${rows.length}`;
  more.setAttribute('aria-expanded', String(!!ui.locksAll));
}

/**
 * The carbon body kit shortcut: records the URL races its gate still counts as won, and nothing else. Shown once the
 * game data and a profile are loaded; disabled, with the reason, wherever it would not open the kits.
 */
function renderUrlWins() {
  let plan = null;
  try { plan = ui.db && ui.state ? ops.urlWinsPlan(ui.state, ui.db) : null; } catch (err) { plan = { applies: false, reason: `Could not read the career: ${err.message}` }; }
  ui.urlPlan = plan;
  const box = $('urlWinsBox');
  box.hidden = !plan;
  if (!plan) return;
  const n = plan.applies ? plan.races.length : Math.max(0, (plan.required ?? 0) - (plan.have ?? 0));
  // I3: on the Next unlocks row of the carbon body kits, the shortcut takes that row's place, so the kits are listed once.
  const row = $('storyLocksList').querySelector('li[data-kit]');
  if (row) { row.replaceChildren(box); }
  box.querySelector('.check-t b').textContent = row ? 'Carbon fibre body kits' : 'Carbon body kits';
  $('urlWinsLabel').textContent = plan.applies ? `Record ${n} ${n === 1 ? 'win' : 'wins'}` : 'Record wins';
  $('urlWins').setAttribute('aria-label', plan.applies
    ? `Unlock carbon body kits: records ${n} ${plan.stage} URL race ${n === 1 ? 'win' : 'wins'}`
    : 'Unlock carbon body kits by recording URL race wins');
  $('urlWinsNote').textContent = plan.applies
    ? `${row?.dataset.need ?? `Win ${n} more ${plan.stage} URL races`}, or record them here: the stage, money and every other race stay. It asks first.`
    : plan.reason;
  setBusy(ui.busy);
}

function hideUrlWinsConfirm() {
  $('urlWinsConfirm').hidden = true;
  $('urlWins').setAttribute('aria-expanded', 'false');
}

function askUrlWinsConfirm() {
  const plan = ui.urlPlan;
  if (!plan?.applies) return;
  $('urlWinsConfirmText').textContent = `This records ${plan.races.length} ${plan.stage} URL races you have not won as won: ${plan.races.join(', ')}. `
    + 'The game will count them as won, so the carbon fibre body kits open. '
    + 'The stage, your money and every other race stay as they are. Untested in game. Undo takes it back.';
  fillDiff($('urlWinsDiff'), [
    [`${plan.stage} URL races won`, `${plan.have} of ${plan.required}`, `${plan.have + plan.races.length} of ${plan.required}`],
    ['Story locks', plan.gatesBefore, plan.gatesAfter],
    ['Carbon fibre body kits', 'Locked', 'Open'],
  ]);
  $('urlWinsConfirm').hidden = false;
  $('urlWins').setAttribute('aria-expanded', 'true');
  $('urlWinsYes').focus();
}

function hideUnlockConfirm() {
  $('unlockConfirm').hidden = true;
  $('unlockAll').setAttribute('aria-expanded', 'false');
}

/** First click on Unlock everything: say what it changes in the career, and wait for a second, explicit click. */
function askUnlockConfirm() {
  let c;
  try { c = ops.finishStoryChanges(ui.state, ui.db); } catch (err) { toast(`Could not read the career: ${err.message}`, { kind: 'bad' }); return; }
  $('unlockConfirmText').textContent = c.finished
    ? 'The story is already finished. This opens any locked garage slot and fills every car\'s part table.'
    : `This finishes the story: the stage goes from ${c.stage} to Career finished, all ${c.totalEvents} events are marked won (now ${c.events}) `
      + `and all ${c.totalPhotos} photo goals done (now ${c.photos}). It also opens every garage slot and part, ${c.gates} story-locked part levels included. `
      + 'You cannot race the rest of the career for progress afterwards. Undo brings the career back.';
  fillDiff($('unlockDiff'), c.finished ? [] : [
    ['Stage', c.stage, 'Career finished'],
    ['Events won', `${c.events} of ${c.totalEvents}`, `${c.totalEvents} of ${c.totalEvents}`],
    ['Photo goals', `${c.photos} of ${c.totalPhotos}`, `${c.totalPhotos} of ${c.totalPhotos}`],
    ['Story-locked part levels', c.gates, 0],
  ]);
  $('unlockConfirm').hidden = false;
  $('unlockAll').setAttribute('aria-expanded', 'true');
  $('unlockConfirmYes').focus();
}

async function renderProfile() {
  const gen = ++ui.renderGen;
  const facts = $('facts');
  // Money keeps its row and its edit controls (I4): the other facts are drawn around it.
  facts.replaceChildren($('moneyDt'), $('moneyDd'));
  $('uniqueList').replaceChildren();
  $('uniqueBox').hidden = true;
  $('stageBox').hidden = true;
  $('carsChip').hidden = true;
  $('cars').replaceChildren();
  hideUnlockConfirm();
  hideUrlWinsConfirm();
  $('urlWinsHome').append($('urlWinsBox'));
  $('storyLocks').hidden = true;
  $('urlWinsBox').hidden = true;
  ui.urlPlan = null;
  ui.state = null;
  ui.rendered = null;
  if (!ui.profile) return;
  const at = { saveDir: ui.saveDir, profile: ui.profile };
  let s, state;
  try { state = (await readProfile(at)).state; s = ops.summary(state, ui.db); }
  catch (err) { if (gen === ui.renderGen) toast(`Could not read ${at.profile}: ${err.message}`, { kind: 'bad' }); return; }
  // A newer render (Refresh, a tab switch, another profile) started while this one read: its result wins.
  if (gen !== ui.renderGen) return;
  ui.state = state;
  ui.rendered = at;
  renderStoryLocks();
  renderUrlWins();
  const fact = (k, v) => [el('dt', { textContent: k }), el('dd', { textContent: v })];
  facts.prepend(...fact('Name', s.name));
  facts.append(...fact('Cars', `${s.cars.length} of ${s.slotCount} slots${s.lockedSlots ? `, ${s.lockedSlots} slots locked` : ''}${s.garage ? '' : ' (no garage file, slots 6-10 not edited)'}`));
  $('moneyRead').textContent = `$${fmt(s.money)}`;
  $('money').value = String(s.money);
  $('stage').value = String(Math.min(s.stage, 6));
  // I17b: the story as a bar. Without the game data the stage alone is known, so the bar waits for it.
  const stageLabel = ops.STAGES.find((x) => x.value === s.stage)?.label ?? String(s.stage);
  if (s.report) {
    const pct = Math.round(s.report.percent);
    $('stageBox').hidden = false;
    $('stageName').textContent = stageLabel;
    $('stageCount').textContent = `${s.report.events} of ${s.report.totalEvents} events · ${pct}%`;
    $('stageBar').setAttribute('aria-valuenow', String(pct));
    $('stageBar').setAttribute('aria-valuetext', `${stageLabel}, ${s.report.events} of ${s.report.totalEvents} events`);
    $('stageBar').style.setProperty('--p', `${pct}%`);
  } else {
    facts.append(...fact('Stage', stageLabel));
  }
  // I2: how many cars are maxed, beside the Cars heading. Maxed: Level 3 everywhere, with the transmission at
  // Level 3 or at the level research picks for that car.
  if (s.cars.length) {
    $('carsChip').hidden = false;
    $('carsChip').textContent = `${s.cars.filter((c) => c.maxed).length} of ${s.cars.length} maxed`;
  }
  // I14: how many cars have each unique fitted, as one line; the chips sit behind it.
  $('uniqueBox').hidden = !s.cars.length;
  const carWord = s.cars.length === 1 ? 'car' : 'cars';
  let full = 0;
  for (const [i, u] of ops.UNIQUE_PARTS.entries()) {
    const have = s.cars.filter((c) => c.uniques[i]).length;
    const li = document.createElement('li');
    li.textContent = have === s.cars.length ? `${u.label}: on all ${have} ${carWord}` : `${u.label}: on ${have} of ${s.cars.length} ${carWord}`;
    li.dataset.full = String(s.cars.length > 0 && have === s.cars.length);
    if (li.dataset.full === 'true') full++;
    $('uniqueList').append(li);
  }
  const all = full === ops.UNIQUE_PARTS.length;
  $('uniqueBox').dataset.full = String(all);
  $('uniqueTitle').textContent = all ? `Uniques: all ${ops.UNIQUE_PARTS.length} on every car` : `Uniques: ${full} of ${ops.UNIQUE_PARTS.length} on every car`;
  renderCars(s.cars);
  renderGarage(s.cars);
  pickAutoCar(s.cars).catch((e) => console.warn('auto car', e));
}

// ---- Ready-made garage ------------------------------------------------------------------------
// Ten finished cars ship with the editor (src/garage-data.js). One car goes into one slot the player picks, and only
// that slot changes. Replacing the whole garage is the danger path: it names every car lost, offers a backup and
// waits for a ticked box and a second click (ops.replaceGarage refuses without that confirm).

const readyName = (d) => CAR_NAMES[d.car]?.name ?? d.car;

/** The slot a ready-made car goes in by default: one holding the same model, else the first car of the garage. */
function defaultSlot(design, cars) {
  const same = cars.find((c) => c.internal === design.car || c.name === readyName(design));
  return (same ?? cars[0])?.index;
}

function renderGarage(cars) {
  ui.garageSlots = cars.map((c) => ({ index: c.index, name: c.name }));
  const n = readyGarage.cars.length;
  $('garageNote').textContent = !cars.length
    ? 'This career has no car yet. Buy one in the game, then come back: a ready-made car replaces a car you own.'
    : !ui.db
      ? 'Load the game data below first: ready-made cars are built from GLOBALB.BUN.'
      : `${n} finished cars, each with its looks, Level 3 parts and five tuned setups (untested in game except the Corolla Street X). Pick a car and the slot it goes in: only that slot changes, and Undo brings it back.`;
  $('garageList').replaceChildren(...readyGarage.cars.map((d, i) => {
    const sel = el('select', { ariaLabel: `Slot for the ${readyName(d)}` });
    for (const c of cars) {
      const same = c.name === readyName(d);
      sel.append(new Option(`Slot ${c.index + 1}: ${c.name}${same ? ' (updated)' : ' (replaced)'}`, String(c.index)));
    }
    const pick = defaultSlot(d, cars);
    if (pick != null) sel.value = String(pick);
    const btn = el('button', { className: 'btn', type: 'button' }, el('span', { textContent: 'Apply' }));
    btn.dataset.ready = String(i);
    btn.addEventListener('click', () => applyReady(i, Number(sel.value)));
    return el('li', {},
      el('div', { className: 'ready-t' }, el('b', { textContent: readyName(d) }), el('small', { textContent: CAR_REASONS[d.reason] })),
      el('div', { className: 'ready-pick' }, sel, btn));
  }));
  setBusy(ui.busy);
}

const skippedNote = (reports) => {
  const parts = reports.filter((r) => r.skipped.length).map((r) => ` The ${r.car} kept its own ${r.skipped.join(', ')}: this game data has no such part for it.`);
  return parts.length ? ` Partly applied.${parts.join('')}` : '';
};

/** One ready-made car into one slot. Refused when the slot holds another car than the panel showed. */
function applyReady(i, slot) {
  const d = readyGarage.cars[i], drawn = ui.garageSlots?.find((c) => c.index === slot);
  if (!drawn) { toast('Pick a slot with a car in it. Nothing was written.', { kind: 'bad' }); return; }
  edit(`Ready-made ${readyName(d)} into slot ${slot + 1}`, (s) => {
    const now = ops.carNameInSlot(s, slot, ui.db);
    if (now !== drawn.name) throw new Error(`Slot ${slot + 1} now holds ${now ?? 'no car'}, not the ${drawn.name} the panel showed. Nothing was written. The panel has been refreshed.`);
    const r = ops.applyDesign(s, slot, d, ui.db);
    const was = r.report.replaced ? ` It replaced the ${r.report.replaced}.` : '';
    return { state: r.state, note: `${was}${skippedNote([r.report])}`.trim() };
  });
}

function hideGarageConfirm() {
  $('garageConfirm').hidden = true;
  $('garageAgree').checked = false;
  $('garageReplace').setAttribute('aria-expanded', 'false');
}

/** First click on Replace my whole garage: name every car lost and what replaces it, then wait for the box and a click. */
function askGarageConfirm() {
  let plan;
  try { plan = ops.replacePlan(ui.state, readyGarage, ui.db); } catch (err) { toast(`Could not read the career: ${err.message}`, { kind: 'bad' }); return; }
  const tuned = plan.placed.reduce((a, p) => a + p.tuned, 0);
  $('garageConfirmText').textContent = `This replaces all ${plan.placed.length} cars in this garage, with their looks, parts and tuning`
    + (tuned ? `, ${tuned} tuned setups among them` : '') + '. Money and story stay as they are. Undo brings the garage back, and a backup keeps a copy outside the browser.';
  fillDiff($('garageDiff'), plan.placed.map((p) => [`Slot ${p.slot + 1}`, p.tuned ? `${p.from} (${p.tuned} tuned)` : p.from, p.to]));
  $('garageUnplaced').hidden = !plan.unplaced.length;
  $('garageUnplaced').textContent = plan.unplaced.length ? `Not placed, the garage has no more cars: ${plan.unplaced.join(', ')}. Apply them one at a time over a car you can spare.` : '';
  $('garageAgree').checked = false;
  $('garageConfirm').hidden = false;
  $('garageReplace').setAttribute('aria-expanded', 'true');
  setBusy(ui.busy);
  $('garageAgree').focus();
}

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

/**
 * An edit of one car as the panel drew it. Car buttons hold a slot number, so the edit is refused when the profile
 * or the car in that slot changed since the panel drew it: a car sold or swapped in game, or another profile.
 */
function carEdit(car, label, change) {
  const drawn = ui.rendered;
  return edit(label, (s, at) => {
    if (!drawn || drawn.profile !== at.profile || drawn.saveDir !== at.saveDir) {
      throw new Error(`The panel was showing ${drawn?.profile ?? 'another profile'}, not ${at.profile}. Nothing was written. The panel has been refreshed.`);
    }
    const now = ops.slotCarHash(s, car.index);
    if (now == null) throw new Error(`Slot ${car.slot} is empty now, so the ${car.name} is no longer there. Nothing was written. The panel has been refreshed.`);
    if (now !== car.hash) throw new Error(`Slot ${car.slot} now holds the ${ops.carNameInSlot(s, car.index, ui.db)}, not the ${car.name}. Nothing was written. The panel has been refreshed.`);
    return change(s);
  });
}

function writeButton(label, onClick, title) {
  const b = el('button', { type: 'button', className: 'btn', title: title ?? '' }, el('span', { textContent: label }));
  b.dataset.write = '';
  b.addEventListener('click', onClick);
  return b;
}

/** Best: what Best car writes, as ops.summary reads it (a group kept plain for its vinyls still counts). */
const isBest = (car) => car.best === true;

/** I2: one line of badges per car row: Best or Maxed or its level, uniques, and tuned setups. */
function carPills(car) {
  const uniques = car.uniques.filter(Boolean).length;
  const custom = car.tiers.filter((t) => t == null).length;
  const levels = [...new Set(car.tiers.filter((t) => t != null))];
  const tuned = car.tuned.filter(Boolean).length;
  const pill = (text, ok, title = '') => el('span', { className: `pill${ok ? ' ok' : ''}`, textContent: text, title });
  const level = isBest(car) ? pill('Best', true, `Maxed, every unique and carbon wherever it has a carbon version${car.carbonKept.length ? `, except ${car.carbonKept.join(', ').toLowerCase()} (kept plain for your vinyls)` : ''}`)
    : car.maxed ? pill('Maxed', true, 'Level 3 everywhere, with the transmission research picks for this car')
      : custom || levels.length !== 1 ? pill('Custom mix', false) : pill(ops.TIERS[levels[0]].label, false);
  return [level, pill(`${uniques}/9 uniques`, uniques === 9), pill(`${tuned}/5 setups`, tuned === 5, 'Setups you tuned, of the five the game keeps per car')];
}

/**
 * I12: in two columns a car opens beside the career, as option A's 1400 px mock showed: the car edited last, else the
 * first. Narrow again, it closes, so 400 px is unchanged, until the user opens or closes it themselves.
 * The pick is made once per profile; #cars[data-auto-car] says it is made (the tests wait for it).
 */
const WIDE = matchMedia('(min-width: 1000px)');
async function pickAutoCar(cars) {
  const key = ui.profile && cars.length ? hist.historyKey(ui.saveDir, ui.profile) : null;
  if (!key) return;
  if (ui.autoCar?.key !== key) {
    ui.autoCar = { key, index: null, touched: false };
    delete $('cars').dataset.autoCar;
    const h = await hist.load(store, key);
    if (ui.autoCar?.key !== key) return;
    const edited = [...h.entries].reverse().map((e) => cars.find((c) => e.label.startsWith(`${c.name}: `))).find(Boolean);
    ui.autoCar.index = (edited ?? cars[0]).index;
    // A car the user opened while the history loaded wins.
    if (ui.openCars.size) ui.autoCar.touched = true;
  }
  applyAutoCar();
  if (ui.autoCar.index != null) $('cars').dataset.autoCar = String(ui.autoCar.index);
}
function applyAutoCar() {
  const a = ui.autoCar;
  if (!a || a.index == null || a.touched) return;
  const det = $('cars').querySelector(`details.car[data-index="${a.index}"]`);
  if (det) det.open = WIDE.matches;
}

const CAR_TABS = [['perf', 'Performance'], ['carbon', 'Carbon'], ['looks', 'Looks'], ['setups', 'Setups']];

const signed = (x, digits) => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(digits)}`;
const delta = (x, digits) => (Math.abs(x) < 0.5 * 10 ** -digits ? 'same' : signed(x, digits));

/** "1st gear, 2nd gear, ... 6th gear" reads as "gears 1st to 6th"; other names stay as they are, lower case. */
function controlNames(names) {
  const gears = names.filter((n) => /^\d+(st|nd|rd|th) gear$/.test(n));
  const rest = names.filter((n) => !gears.includes(n)).map((n) => (n.startsWith('ECU') ? n : n[0].toLowerCase() + n.slice(1)));
  const g = gears.length > 1 ? [`gears ${gears[0].split(' ')[0]} to ${gears.at(-1).split(' ')[0]}`] : gears.map((n) => n.toLowerCase());
  return [...g, ...rest].join(', ');
}

/** The parts changes waiting for Apply on one car, dropped when the profile or the car in the slot changed. */
function pendingParts(car, create = false) {
  const p = ui.partsPending.get(car.index);
  if (p && p.profile === ui.profile && p.hash === car.hash) return p.changes;
  ui.partsPending.delete(car.index);
  if (!create) return new Map();
  const changes = new Map();
  ui.partsPending.set(car.index, { profile: ui.profile, hash: car.hash, changes });
  return changes;
}

/**
 * Per-part installs (layout A): a Parts button on each category row opens that category's parts grouped by level,
 * each with what fitting or removing it changes on the dyno at a neutral setup and which setup sliders it locks or
 * narrows. Ticks wait in one list per car until Apply, which writes them as one edit (one Undo).
 */
function partsEditor(car) {
  let saved = [];
  try { saved = ops.carParts(ui.state, car.index); } catch { saved = []; }
  // A change that the save now holds (Apply landed) is no longer pending.
  const pend = pendingParts(car);
  for (const g of saved) for (const p of g.parts) if (pend.get(p.index) === p.on) pend.delete(p.index);
  const boxes = [];
  // Read the pending list each time: the first tick on a car creates it after this editor was built.
  const fitted = (p) => { const now = pendingParts(car); return now.has(p.index) ? now.get(p.index) : p.on; };
  const byIndex = new Map(saved.flatMap((g) => g.parts.map((p) => [p.index, p])));
  const dynoAt = (changes) => { try { return ui.db ? ops.partsDyno(ui.state, car.index, ui.db, changes) : null; } catch { return null; } };

  const count = el('span', { className: 'parts-count' });
  const strip = el('p', { className: 'parts-dyno' });
  const discard = el('button', { type: 'button', className: 'btn ghost' }, el('span', { textContent: 'Discard' }));
  const apply = writeButton('Apply', () => {
    const changes = Object.fromEntries(pendingParts(car));
    const n = Object.keys(changes).length;
    if (!n) return;
    carEdit(car, `${car.name}: ${n} part${n === 1 ? '' : 's'} ${n === 1 ? (Object.values(changes)[0] ? 'fitted' : 'removed') : 'changed'}`, (s) => ops.setCarParts(s, car.index, changes));
  });
  apply.classList.add('primary');
  const bar = el('div', { className: 'parts-bar', role: 'status' }, strip, el('div', { className: 'parts-actions' }, count, discard, apply));

  const refresh = () => {
    const changes = pendingParts(car);
    bar.hidden = !changes.size;
    count.textContent = `${changes.size} change${changes.size === 1 ? '' : 's'} not applied`;
    strip.textContent = '';
    if (changes.size) {
      const now = dynoAt({}), next = dynoAt(Object.fromEntries(changes));
      strip.textContent = now && next
        ? `With these changes: ${next.hp.toFixed(1)} hp (${delta(next.hp - now.hp, 1)}), quarter mile ${next.quarter.toFixed(3)} s (${delta(next.quarter - now.quarter, 3)}), 0-60 ${next.t60.toFixed(2)} s (${delta(next.t60 - now.t60, 2)}). Neutral setup, dyno model, untested in game.`
        : 'Load the game data (the last card) to see what these changes do on the dyno.';
    }
    for (const b of boxes) if (!b.box.hidden) b.update();
  };
  discard.addEventListener('click', () => {
    ui.partsPending.delete(car.index);
    for (const b of boxes) b.reset();
    refresh();
  });

  const row = (gi, g) => {
    const group = saved[gi];
    if (!group) return [el('span')];
    const key = `${car.index}:${g.code}`, id = `parts-${car.index}-${g.code}`;
    const open = ui.openParts.has(key);
    const btn = el('button', { type: 'button', className: 'btn parts-btn' }, el('span', { textContent: 'Parts' }));
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-controls', id);
    btn.setAttribute('aria-label', `${g.label} parts`);
    const box = el('div', { className: 'parts', id, hidden: !open });
    const lines = [];
    if (!ui.db) box.append(el('p', { className: 'note', textContent: 'Load the game data (the last card) to see what each part changes on the dyno.' }));
    for (const level of [1, 2, 3]) {
      const list = group.parts.filter((p) => p.level === level);
      if (!list.length) continue;
      const fs = el('fieldset', { className: 'parts-level' }, el('legend', { textContent: `Level ${level} package` }));
      for (const p of list) {
        const cid = `part-${car.index}-${p.index}`;
        const chk = el('input', { type: 'checkbox', id: cid, checked: fitted(p) });
        chk.dataset.write = '';
        chk.dataset.part = String(p.index);
        const effect = el('span', { className: 'part-effect' });
        chk.addEventListener('change', () => {
          const changes = pendingParts(car, true);
          if (chk.checked === p.on) changes.delete(p.index); else changes.set(p.index, chk.checked);
          if (!changes.size) ui.partsPending.delete(car.index);
          refresh();
        });
        const owned = !p.on && p.owned ? [el('small', { className: 'tag', textContent: 'owned' })] : [];
        fs.append(el('div', { className: 'part' }, el('label', { htmlFor: cid }, chk, el('span', { textContent: p.label }), ...owned), effect));
        lines.push({ p, chk, effect });
      }
      box.append(fs);
    }
    const update = () => {
      const changes = Object.fromEntries(pendingParts(car));
      const base = dynoAt(changes);
      for (const { p, effect } of lines) {
        const on = fitted(p);
        const by = on ? p.higher.find((j) => byIndex.has(j) && fitted(byIndex.get(j))) : undefined;
        const bits = [];
        if (by != null) bits.push(`Replaced by ${byIndex.get(by).label}`);
        if (base) {
          // A ticked change describes itself (what Apply will do), any other part what ticking it would do.
          const pending = p.index in changes, act = pending ? on : !on;
          const from = pending ? dynoAt({ ...changes, [p.index]: !act }) : base;
          const to = pending ? base : dynoAt({ ...changes, [p.index]: act });
          const c = from && to ? ops.controlChanges(from.controls, to.controls) : { locks: [], narrows: [], widens: [], opens: [] };
          const what = [];
          if (from && to && Math.abs(to.hp - from.hp) >= 0.05) what.push(`${signed(to.hp - from.hp, 1)} hp`);
          if (from && to && Math.abs(to.quarter - from.quarter) >= 0.0005) what.push(`quarter mile ${signed(to.quarter - from.quarter, 3)} s`);
          if (c.locks.length) what.push(`locks ${controlNames(c.locks)}`);
          if (c.narrows.length) what.push(`narrows ${controlNames(c.narrows)}`);
          if (c.widens.length) what.push(`widens ${controlNames(c.widens)}`);
          if (c.opens.length) what.push(`unlocks ${controlNames(c.opens)}`);
          bits.push(`${act ? 'Fitting it' : 'Removing it'}: ${what.length ? what.join(', ') : 'no change on the dyno'}`);
        }
        effect.textContent = bits.join('. ');
      }
    };
    const reset = () => { for (const { p, chk } of lines) chk.checked = p.on; };
    boxes.push({ box, update, reset });
    btn.addEventListener('click', () => {
      const show = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(show));
      box.hidden = !show;
      if (show) { ui.openParts.add(key); update(); } else ui.openParts.delete(key);
    });
    if (open) update();
    return [btn, box];
  };
  refresh();
  return { row, bar };
}

/**
 * One collapsible block per car (I5): Best car first, then Change car, then one tab of controls at a time:
 * Performance, Carbon, Looks and Setups. The tab is remembered per car across re-renders.
 */
function renderCars(cars) {
  const box = $('cars');
  if (!cars.length) { box.append(el('p', { className: 'note', textContent: 'No cars in this garage yet.' })); return; }
  for (const car of cars) {
    const det = el('details', { className: 'car', open: ui.openCars.has(car.index) });
    det.dataset.slot = String(car.slot);
    det.dataset.index = String(car.index);
    det.addEventListener('toggle', () => { det.open ? ui.openCars.add(car.index) : ui.openCars.delete(car.index); });
    det.append(el('summary', {},
      el('span', { className: 'car-name', textContent: car.name, title: `Slot ${car.slot}` }),
      el('span', { className: 'car-meta' }, ...carPills(car))));
    // Opening or closing the car the panel opened by itself hands it to the user: the width stops moving it.
    det.querySelector('summary').addEventListener('click', () => { if (ui.autoCar?.index === car.index) ui.autoCar.touched = true; });

    const best = writeButton('Best car', () => carEdit(car, `${car.name}: best car`, (s) => runWorker({ kind: 'best', slot: car.index }, s)), BEST_TITLE);
    best.classList.add('primary');
    const swap = swapBlock(car);
    const change = el('button', { type: 'button', className: 'btn swap-toggle', title: 'Put another of the game\'s cars in this slot. It shows what changes and asks first.' },
      el('span', { textContent: 'Change car' }));
    change.setAttribute('aria-expanded', String(!swap.hidden));
    change.addEventListener('click', () => {
      swap.hidden = !swap.hidden;
      change.setAttribute('aria-expanded', String(!swap.hidden));
      if (swap.hidden) { ui.openSwap.delete(car.index); return; }
      ui.openSwap.add(car.index);
      swap.fill();
      // I15: the list opens ready to type in.
      swap.querySelector('input[type="search"]')?.focus();
    });
    // Every carbon part on this car back to plain in one write and one Undo entry, the same edit as All plain in the
    // Carbon tab. Shown with the game data; off when nothing on the car is carbon.
    const carbonOff = writeButton('Carbon off', () => carEdit(car, `${car.name}: carbon off`, (s) => ops.setCarbon(s, car.index, false, ui.db)),
      'Every carbon part on this car back to its plain version, in one write. Undo puts it back.');
    carbonOff.classList.add('carbon-off');
    if (!car.carbon?.includes('carbon')) {
      carbonOff.dataset.locked = '';
      carbonOff.title = car.carbon ? 'Nothing on this car is carbon.' : 'Needs the game data (the last card): carbon parts are read from GLOBALB.BUN.';
    }
    det.append(el('div', { className: 'car-top' }, best, carbonOff, change), swap);

    const tabs = el('div', { className: 'ctabs', role: 'tablist', ariaLabel: `${car.name} controls` });
    const panels = new Map();
    const show = (key, focus = false) => {
      ui.carTab.set(car.index, key);
      for (const b of tabs.children) {
        const on = b.dataset.tab === key;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      }
      for (const [k, p] of panels) p.hidden = k !== key;
      panels.get(key).fill?.();
      setBusy(ui.busy);
    };
    for (const [key, label] of CAR_TABS) {
      const b = el('button', { type: 'button', role: 'tab', id: `ctab-${car.index}-${key}`, textContent: label });
      b.dataset.tab = key;
      b.setAttribute('aria-controls', `cpanel-${car.index}-${key}`);
      b.addEventListener('click', () => show(key));
      b.addEventListener('keydown', (e) => {
        const i = CAR_TABS.findIndex(([k]) => k === key);
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        show(CAR_TABS[(i + step + CAR_TABS.length) % CAR_TABS.length][0], true);
      });
      tabs.append(b);
      const p = el('div', { className: 'cpanel', role: 'tabpanel', id: `cpanel-${car.index}-${key}` });
      p.setAttribute('aria-labelledby', b.id);
      p.dataset.tab = key;
      panels.set(key, p);
    }

    // Performance: a level, a unique toggle and a Parts list per category, then the two whole-car shortcuts.
    const rows = el('div', { className: 'perf-rows' });
    const partsUi = partsEditor(car);
    for (const [i, g] of ops.PERF_GROUPS.entries()) {
      const selId = `tier-${car.index}-${g.code}`, chkId = `uniq-${car.index}-${g.code}`;
      const sel = el('select', { id: selId });
      sel.dataset.write = '';
      if (car.tiers[i] == null) sel.append(el('option', { value: '', textContent: 'Custom mix', disabled: true, selected: true }));
      for (const t of ops.TIERS) sel.append(el('option', { value: String(t.value), textContent: t.label, selected: car.tiers[i] === t.value }));
      sel.addEventListener('change', () => {
        const v = Number(sel.value);
        carEdit(car, `${car.name}: ${g.label} ${ops.TIERS[v].label}`, (s) => ops.setCarPerformance(s, car.index, { tiers: { [g.code]: v } }));
      });
      const chk = el('input', { type: 'checkbox', id: chkId, checked: car.uniques[i] });
      chk.dataset.write = '';
      chk.addEventListener('change', () => {
        carEdit(car, `${car.name}: ${g.label} unique ${chk.checked ? 'on' : 'off'}`, (s) => ops.setCarPerformance(s, car.index, { uniques: { [g.code]: chk.checked } }));
      });
      rows.append(
        el('label', { htmlFor: selId, className: 'perf-label', textContent: g.code === 'SU' && car.tiers[i] >= 2 && !car.camber ? `${g.label}, no camber kit` : g.label }), sel,
        el('label', { htmlFor: chkId, className: 'uniq' }, chk, el('span', { textContent: 'Unique' })),
        ...partsUi.row(i, g));
    }
    panels.get('perf').append(rows, partsUi.bar, el('div', { className: 'grid' },
      writeButton('Max this car', () => carEdit(car, `${car.name}: Level 3 and every unique`, (s) => ops.maxCar(s, car.index))),
      writeButton('All uniques', () => carEdit(car, `${car.name}: every unique`, (s) => ops.applyUniques(s, car.index)))));

    panels.get('carbon').append(...carbonBlock(car));

    // Looks: built only when its tab opens, since a car has about 9,000 choices.
    const looks = panels.get('looks');
    looks.classList.add('looks');
    looks.fill = () => { if (!looks.childElementCount) renderLooks(looks, car); };

    const presets = el('div', { className: 'presets' });
    for (const p of ops.SETUPS) {
      const b = writeButton(p.label, () => carEdit(car, `${car.name}: recommended ${p.label} setup`, (s) => runWorker({ kind: 'preset', slot: car.index, setup: p.value }, s)),
        `Level 3 parts and every unique, the transmission picked for this car (Level 3 on the 240SX and RX-7, stock elsewhere), ${p.label} sliders from top players' setups, and ECU and turbo from the dyno${p.value === 0 || p.value === 4 ? '. Fills Circuit and URL' : ''}`);
      if (car.tuned[p.value]) { b.classList.add('tuned'); b.append(el('small', { className: 'tag', textContent: 'tuned' })); b.title += '. This car already has this setup tuned.'; }
      presets.append(b);
    }
    panels.get('setups').append(el('p', { className: 'preset-title', textContent: 'Recommended setup for a race type' }), presets,
      el('details', { className: 'why' }, el('summary', { textContent: 'Why these?' }), el('p', {
        textContent: ui.db
          ? `${ops.PRESET_SOURCE} The game keeps five setups per car and has none for Sprint. A button marked "tuned" is a setup this car already has.`
          : 'Recommended setups need the game data (the last card): they are computed from the car physics in GLOBALB.BUN.',
      })));

    det.append(tabs, ...panels.values());
    const want = ui.carTab.get(car.index);
    show(CAR_TABS.some(([k]) => k === want) ? want : 'perf');
    $('cars').append(det);
  }
  setBusy(ui.busy);
}

// What a story-locked car did in game, from the headless check in test/README.md.
const LOCKED_CAR_NOTE = 'In game a story-locked car loaded and showed in its garage slot (tested with the Skyline on a Stage 5 career), but the story itself still treats it as locked.';

/**
 * Change car: every car in the game data, searchable, player cars first. A choice shows what the swap changes and
 * waits for a second, explicit click. The swap, and Best car after it when ticked, is one edit, so one Undo entry.
 * Built only when opened.
 */
function swapBlock(car) {
  const box = el('div', { className: 'swap' });
  box.hidden = !ui.openSwap.has(car.index);
  box.fill = () => { if (!box.childElementCount) renderSwap(box, car); };
  if (!box.hidden) box.fill();
  return box;
}

function renderSwap(box, car) {
  const note = (text) => el('p', { className: 'note', textContent: text });
  if (!ui.db) return box.append(note('Needs the game data (the last card): the car list is read from GLOBALB.BUN.'));
  let choices, current;
  try { choices = ops.carChoices(ui.state, ui.db); current = ops.carHashInSlot(ui.state, car.index); }
  catch (err) { return box.append(note(`Could not read the car list: ${err.message}`)); }
  const id = `swap-${car.index}`;
  const search = el('input', { type: 'search', id: `${id}-find`, placeholder: 'Make or model', autocomplete: 'off' });
  const list = el('div', { className: 'swap-list' });
  const rows = [];
  // I15: player cars only (traffic vehicles have no garage body data, so they could never be picked), under their make.
  // A player car whose stock blocks this game data cannot build is left out and named in a note under the list.
  const byName = (a, b) => a.name.localeCompare(b.name);
  const makes = new Map();
  const unbuildable = choices.filter((x) => x.player && !x.available).sort(byName);
  for (const c of choices.filter((x) => x.player && x.available).sort(byName)) {
    const m = makeOf(c.name);
    makes.set(m, [...(makes.get(m) ?? []), c]);
  }
  const groups = [...makes].sort(([a], [b]) => a.localeCompare(b)).map(([title, items]) => ({ title, items }));
  for (const g of groups) {
    const set = el('fieldset', { className: 'swap-group' }, el('legend', { textContent: g.title }));
    for (const c of g.items) {
      const rid = `${id}-${c.internal}`;
      const here = c.hash === current;
      const r = el('input', { type: 'radio', name: id, id: rid, value: String(c.hash), disabled: here });
      const tags = [here && 'in this slot now', c.locked && `story locked: ${c.locked}`, c.region].filter(Boolean);
      const row = el('label', { htmlFor: rid, className: 'swap-row' }, r, el('span', { className: 'swap-name', textContent: c.name }));
      if (tags.length) row.append(el('span', { className: 'swap-tag', textContent: tags.join(' · ') }));
      row.dataset.find = `${c.name} ${c.internal}`.toLowerCase();
      if (c.locked) row.dataset.lock = '';
      r.addEventListener('change', hideConfirm);
      rows.push(row);
      set.append(row);
    }
    list.append(set);
  }
  if (unbuildable.length) list.append(Object.assign(note(`Not available: ${unbuildable.map((c) => c.name).join(', ')}. This game data does not describe their stock parts.`), { className: 'note swap-unavailable' }));
  const none = note('No car matches that.');
  none.hidden = true;
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const row of rows) row.hidden = !!q && !row.dataset.find.includes(q);
    for (const set of list.children) set.hidden = [...set.querySelectorAll('.swap-row')].every((row) => row.hidden);
    none.hidden = rows.some((row) => !row.hidden);
  });
  const option = (value, label, checked) => {
    const oid = `${id}-${value}`;
    const r = el('input', { type: 'radio', name: `${id}-mode`, id: oid, value, checked });
    r.addEventListener('change', hideConfirm);
    return el('label', { htmlFor: oid, className: 'swap-opt' }, r, el('span', { textContent: label }));
  };
  const mode = el('fieldset', { className: 'swap-mode' }, el('legend', { textContent: 'What the new car gets' }),
    option('stock', 'Start stock: stock parts, no uniques, stock tuning sliders', true),
    option('keep', 'Carry over what fits: this car\'s part levels, uniques and five tuning setups', false));
  const bestId = `${id}-best`;
  const best = el('input', { type: 'checkbox', id: bestId, disabled: !ui.dbJson });
  best.addEventListener('change', hideConfirm);
  const bestRow = el('label', { htmlFor: bestId, className: 'swap-opt' }, best,
    el('span', { textContent: 'Then apply Best car: research parts, every unique, carbon and the research setups (up to a minute)' }));
  const preview = writeButton('Preview the change', showConfirm);
  const text = el('p');
  const yes = writeButton('Change car', apply);
  yes.classList.add('primary');
  const no = el('button', { type: 'button', className: 'btn' }, el('span', { textContent: 'Cancel' }));
  no.addEventListener('click', () => { hideConfirm(); preview.focus(); });
  const confirm = el('div', { className: 'confirm', role: 'group' }, text, el('div', { className: 'row' }, yes, no));
  confirm.hidden = true;
  text.id = `${id}-text`;
  confirm.setAttribute('aria-labelledby', text.id);
  preview.setAttribute('aria-controls', `${id}-confirm`);
  confirm.id = `${id}-confirm`;
  box.append(
    el('label', { htmlFor: search.id, className: 'swap-label', textContent: `New car for slot ${car.slot}` }), search,
    list, none, mode, bestRow, el('div', { className: 'row' }, preview), confirm);

  function picked() {
    const r = list.querySelector('input:checked');
    return r ? choices.find((c) => String(c.hash) === r.value) : null;
  }
  function hideConfirm() { confirm.hidden = true; preview.setAttribute('aria-expanded', 'false'); }
  function showConfirm() {
    const c = picked();
    if (!c) { toast('Pick a car first.', { kind: 'bad' }); return; }
    const keep = mode.querySelector('input:checked')?.value === 'keep';
    text.textContent = `Slot ${car.slot}: the ${car.name} becomes the ${c.name}. `
      + `The new car arrives with its own stock body: the body parts, paint, vinyls, decals and neon of the ${car.name} do not carry over. `
      + (keep ? 'Its part levels, uniques and five tuning setups carry over. ' : 'It starts stock: stock parts, no uniques, stock tuning sliders. ')
      + (best.checked ? 'Then Best car runs on it, which takes up to a minute. ' : '')
      + (c.locked ? `The story has not unlocked the ${c.name} yet (${c.locked}). ${LOCKED_CAR_NOTE} ` : '')
      + (c.region ? `The ${c.name} is sold in the ${c.region.replace(/ only$/, '')}; another release may not show it. ` : '')
      + 'Every other slot, your money and the career stay as they are. Undo in History takes it back.';
    confirm.hidden = false;
    preview.setAttribute('aria-expanded', 'true');
    yes.focus();
  }
  function apply() {
    const c = picked();
    if (!c) return;
    const keep = mode.querySelector('input:checked')?.value === 'keep';
    const withBest = best.checked;
    ui.openSwap.delete(car.index);
    carEdit(car, `Slot ${car.slot}: ${car.name} to ${c.name}${keep ? ', carried over' : ', stock'}${withBest ? ', best car' : ''}`, async (s) => {
      const swapped = ops.changeCar(s, car.index, c.hash, ui.db, { keep });
      return withBest ? runWorker({ kind: 'best', slot: car.index }, swapped) : swapped;
    });
  }
}

/**
 * Every visual slot of one car (body parts, rims, paint, vinyls, decals, tint, neon, trunk audio, doors,
 * hydraulics, NOS purge, gauges), one group at a time, in the Looks tab.
 */
function renderLooks(body, car) {
  const note = (text) => el('p', { className: 'note', textContent: text });
  if (!ui.db) return body.append(note('Needs the game data (the last card): parts and colours are read from GLOBALB.BUN.'));
  let groups;
  try { groups = ops.visualEditor(ui.state, car.index, ui.db); } catch (err) { return body.append(note(err.message)); }
  const tabs = el('div', { className: 'looks-tabs', role: 'group', ariaLabel: 'Part group' });
  const rows = el('div', { className: 'looks-rows' });
  const show = (code) => {
    ui.looksTab.set(car.index, code);
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.code === code));
    const g = groups.find((x) => x.code === code);
    rows.replaceChildren(...g.slots.flatMap((s) => lookRow(car, s)));
    for (const sel of rows.querySelectorAll('select')) if (!('locked' in sel.dataset)) sel.title = sel.selectedOptions[0]?.textContent ?? '';
    setBusy(ui.busy);
  };
  for (const g of groups) {
    const b = el('button', { type: 'button', textContent: g.label });
    b.dataset.code = g.code;
    b.addEventListener('click', () => show(g.code));
    tabs.append(b);
  }
  body.append(tabs, rows, el('details', { className: 'why' }, el('summary', { textContent: 'Why did another part change?' }),
    el('p', { textContent: 'Each change saves at once, with the game\'s own side effects: rear rims follow the front, a wide body hides the bumpers and skirts, and parts that cannot carry vinyls clear them.' })));
  show(groups.some((g) => g.code === ui.looksTab.get(car.index)) ? ui.looksTab.get(car.index) : groups[0].code);
}

/** One slot: its label, a select of every choice (rims: style and size), and a colour chip where the part has a colour. */
function lookRow(car, s) {
  const id = `look-${car.index}-${s.id}`;
  const current = s.options.find((o) => o.hash === s.value);
  const write = (hash) => {
    const o = s.options.find((x) => x.hash === hash);
    carEdit(car, `${car.name}: ${s.label.toLowerCase()} ${o ? partLabel(o.label) : 'changed'}`, (st) => ops.setVisual(st, car.index, s.id, hash, ui.db));
  };
  const lock = (sel) => {
    sel.dataset.write = '';
    if (s.hidden) { sel.dataset.locked = ''; sel.title = 'Hidden by the fitted parts, for example a wide body kit'; }
    return sel;
  };
  const label = el('label', { htmlFor: id, className: 'look-label', textContent: s.hidden ? `${s.label} (hidden)` : s.label });
  if (s.wheel) {
    const styles = [...new Set(s.options.map((o) => o.group ?? o.label))];
    const style = lock(el('select', { id }));
    const size = lock(el('select', { ariaLabel: `${s.label} size` }));
    const curStyle = current?.group ?? current?.label;
    for (const name of styles) style.append(el('option', { value: name, textContent: partLabel(name), selected: name === curStyle }));
    const sizes = (name) => s.options.filter((o) => (o.group ?? o.label) === name);
    const fillSizes = (name, pick) => {
      size.replaceChildren(...sizes(name).map((o) => el('option', { value: String(o.hash), textContent: o.size ?? 'One size', selected: o.hash === pick })));
    };
    fillSizes(curStyle, s.value);
    style.addEventListener('change', () => {
      const list = sizes(style.value);
      const same = list.find((o) => o.size && o.size === current?.size) ?? list[0];
      write(same.hash);
    });
    size.addEventListener('change', () => write(Number(size.value)));
    return [label, el('div', { className: 'look-pick' }, style, size)];
  }
  const sel = lock(el('select', { id }));
  let parent = sel, lastGroup = null;
  for (const o of s.options) {
    if (o.group && o.group !== lastGroup) { parent = el('optgroup', { label: o.group }); sel.append(parent); lastGroup = o.group; }
    else if (!o.group && lastGroup) { parent = sel; lastGroup = null; }
    // I16: names in words, the carbon version marked as such.
    const opt = el('option', { value: String(o.hash), textContent: partLabel(o.label), selected: o.hash === s.value });
    if (o.color) opt.style.boxShadow = `inset 14px 0 0 ${o.color}`;
    parent.append(opt);
  }
  sel.addEventListener('change', () => write(Number(sel.value)));
  const pick = el('div', { className: 'look-pick' }, sel);
  if (s.options.some((o) => o.color)) {
    const chip = el('span', { className: 'chip-colour', title: current?.color ?? 'No colour' });
    chip.style.background = current?.color ?? 'transparent';
    pick.prepend(chip);
  }
  if (current && partWords(current.label).carbon) pick.append(el('span', { className: 'ctag', textContent: 'carbon' }));
  return [label, pick];
}

/**
 * A Carbon / Plain switch for every part group, always shown. A group whose fitted part has no carbon version
 * keeps its switch, disabled, with the reason beside it, and points to Looks to fit a part that has one.
 */
function carbonBlock(car) {
  if (!car.carbon) return [el('p', { className: 'note', textContent: 'Needs the game data (the last card): carbon parts are read from GLOBALB.BUN.' })];
  const groups = ops.CARBON_GROUPS.map((g, i) => ({ ...g, state: car.carbon[i] }));
  const rows = el('div', { className: 'carbon-rows' });
  for (const g of groups) {
    const seg = el('div', { className: 'seg', role: 'group' });
    seg.setAttribute('aria-label', `${g.label} material`);
    for (const [on, text] of [[true, 'Carbon'], [false, 'Plain']]) {
      const b = el('button', { type: 'button', textContent: text });
      b.dataset.write = '';
      if (!g.state) b.dataset.locked = '';
      b.setAttribute('aria-pressed', String(g.state != null && (g.state === 'carbon') === on));
      b.addEventListener('click', () => {
        if (!g.state || (g.state === 'carbon') === on) return;
        carEdit(car, `${car.name}: ${g.label.toLowerCase()} ${on ? 'carbon' : 'plain'}`, (s) => ops.setCarbon(s, car.index, on, ui.db, [g.code]));
      });
      seg.append(b);
    }
    const why = g.state ? '' : g.code === 'kit' ? 'needs an aftermarket bumper, skirt or wide body' : `the fitted ${g.label.toLowerCase()} has no carbon version`;
    rows.append(el('span', { className: 'perf-label' }, el('span', { textContent: g.label }),
      ...(why ? [el('span', { className: 'carbon-why', textContent: why })] : [])), seg);
  }
  const out = [rows, el('div', { className: 'grid' },
    writeButton('All carbon', () => carEdit(car, `${car.name}: all carbon`, (s) => ops.setCarbon(s, car.index, true, ui.db))),
    writeButton('All plain', () => carEdit(car, `${car.name}: all plain`, (s) => ops.setCarbon(s, car.index, false, ui.db))))];
  // I6: the reasons sit behind Why?
  const why = el('details', { className: 'why' }, el('summary', { textContent: 'Why?' }));
  if (groups.some((g) => !g.state)) why.append(el('p', { textContent: 'Stock parts have no carbon version. Fit an aftermarket part in the Looks tab, Body parts (the ones marked carbon), and its switch turns on.' }));
  why.append(el('p', { textContent: 'Body kit switches the carbon bumpers, skirts and wide body, with the carbon flags a carbon wide kit sets, all together. The game clears vinyls a carbon kit cannot carry.' }));
  out.push(why);
  return out;
}

const BEST_TITLE = 'Level 3 parts and every unique with no camber kit, the transmission picked per car (Level 3 on the 240SX and RX-7, stock elsewhere), Level 3 body-kit aero, carbon on every part that has a carbon version, and the research setup for Circuit (and URL), Drag, Drift and Street X. Setups you tuned stay, and a car with a tuned setup keeps its parts. Paint, rims and vinyls stay.';

let worker = null, workerSeq = 0;
const secs = (x) => `${x.toFixed(2)}s`;

/** One sentence per car for the best-car toast. */
function bestNote(reports) {
  const lines = reports.map((r) => {
    const written = r.setups.filter((s) => !s.kept), kept = r.setups.filter((s) => s.kept);
    const shown = written.find((s) => s.setup === 0) ?? written[0];
    const parts = r.partsKept ? 'parts kept (it has a tuned setup), uniques on' : `Level 3, every unique, ${r.transmission === 3 ? 'Level 3' : 'stock'} transmission`;
    const kit = r.aero.length ? `, ${r.aero.map((x) => `${x.label.toLowerCase()} ${x.part}`).join(', ')}` : '';
    const sets = (written.length ? `setups ${written.map((s) => s.label + (s.urlToo ? ' and URL' : '')).join(', ')}` : 'no setups written')
      + (kept.length ? `, kept your ${kept.map((s) => s.label).join(', ')}` : '');
    const sim = shown ? `. ${shown.label} simulated: quarter mile ${secs(shown.before.quarter)} to ${secs(shown.after.quarter)}` : '';
    const kept2 = r.carbonKept ?? [];
    const carbon = kept2.length ? `carbon on except ${kept2.join(', ').toLowerCase()} (carbon there would remove your vinyls)` : 'carbon on';
    return `${r.car}: ${parts}${kit}, ${carbon}, ${sets}${sim}.`;
  });
  return `${lines.join(' ')} Sliders from ${[...new Set(reports.map((r) => r.source))].join(' and ')}. Untested in game.`;
}

/**
 * Runs a preset or best-car search in a Web Worker (several seconds per setup);
 * resolves with the new state and a note on what changed.
 */
// One job answers within about a minute, and Best version of every car reports after each car, so this much
// silence means the worker is gone.
const WORKER_QUIET_MS = 3 * 60 * 1000;
function runWorker(job, state) {
  if (!ui.dbJson) throw new Error('Load the game data first: presets are computed from the car physics in GLOBALB.BUN.');
  worker ??= new Worker(new URL('../src/preset-worker.js', import.meta.url), { type: 'module' });
  const id = ++workerSeq;
  toast(job.kind === 'preset' ? "Computing the setup from the game's dyno model. This takes about ten seconds."
    : job.kind === 'best' ? "Building the best version of this car: four setups on the game's dyno model. This takes up to a minute."
      : 'Building the best version of every car. This takes about 20 seconds a car.');
  const w = worker;
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onCrash);
      w.removeEventListener('messageerror', onCrash);
    };
    // A worker that crashed (failed to load, ran out of memory, threw outside a job) or went silent never answers:
    // drop it, so the next job starts a fresh one, and fail this job instead of leaving the panel busy.
    const crash = (why) => {
      done();
      w.terminate();
      if (worker === w) worker = null;
      reject(new Error(`The setup computation stopped (${why}). Nothing was written. Try again; if it happens again, load the game data again.`));
    };
    const onCrash = (e) => { e.preventDefault?.(); crash(e.message || (e.type === 'messageerror' ? 'its answer could not be read' : 'the worker crashed')); };
    const quiet = () => { clearTimeout(timer); timer = setTimeout(() => crash(`no answer for ${WORKER_QUIET_MS / 60000} minutes`), WORKER_QUIET_MS); };
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      if (e.data.progress) {
        quiet();
        const p = e.data.progress;
        // I9: car N of M, with a bar.
        toast(`Building the best version of every car: car ${p.done + 1} of ${p.total}. About 20 seconds a car.`, { progress: { done: p.done, total: p.total } });
        return;
      }
      done();
      if (!e.data.ok) return reject(new Error(e.data.why));
      const next = { career: e.data.career, garage: e.data.garage };
      if (job.kind !== 'preset') return resolve({ state: next, note: bestNote(e.data.reports) });
      const { before: x, after: y } = e.data;
      const kept = e.data.partsKept ? ' Parts kept as they are, as another setup on this car is tuned; only the uniques were added.' : '';
      const note = `Sliders from ${e.data.source}.${kept} Simulated: 0-60 ${secs(x.t60)} to ${secs(y.t60)}, quarter mile ${secs(x.quarter)} to ${secs(y.quarter)}, top speed ${x.top.toFixed(0)} to ${y.top.toFixed(0)} mph. Untested in game.`;
      resolve({ state: next, note });
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onCrash);
    w.addEventListener('messageerror', onCrash);
    quiet();
    w.postMessage({ id, ...job, career: state.career, garage: state.garage, db: ui.dbJson });
  });
}

async function renderHistory() {
  const gen = ++ui.histGen;
  const list = $('history');
  list.replaceChildren();
  $('restoreOriginal').hidden = true;
  hideUndoConfirm();
  if (!ui.profile) return;
  const key = hist.historyKey(ui.saveDir, ui.profile);
  // A profile created again under an old name must not inherit the old career's history (hist.claim).
  if (ui.state && ui.rendered?.profile === ui.profile && ui.rendered?.saveDir === ui.saveDir) {
    const c = await hist.claim(store, key, { hash: await hist.stateHash(ui.state), progress: ops.careerProgress(ui.state.career) });
    if (gen !== ui.histGen) return;
    if (c.archived) toast(archivedNote(ui.profile, c.archived));
  }
  const h = await hist.load(store, key);
  if (gen !== ui.histGen) return;
  $('restoreOriginal').hidden = !h.original;
  if (!h.entries.length) {
    const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No edits yet.'; list.append(li); return;
  }
  for (const e of [...h.entries].reverse()) {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = e.label;
    const time = document.createElement('time'); time.dateTime = e.at; time.textContent = new Date(e.at).toLocaleString();
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn ghost';
    btn.innerHTML = '<span>Undo</span>';
    btn.title = 'Put the files back exactly as they were before this edit';
    btn.addEventListener('click', () => undo(e.id));
    li.append(name, btn, time);
    list.append(li);
  }
  setBusy(ui.busy);
}

/** I13: once loaded, game data is one status line; Change opens the two ways to load it again. */
function renderDb() {
  const loaded = !!ui.db;
  $('dbCard').classList.toggle('loaded', loaded);
  $('dbChange').hidden = !loaded;
  $('dbLoad').hidden = loaded;
  $('dbChange').setAttribute('aria-expanded', 'false');
  if (loaded) {
    $('dbState').textContent = `Game data: Loaded (${ui.db.events.size} events, ${ui.db.cars.length} cars), kept in this browser only.`;
    $('unlockNote').textContent = 'Opens every garage slot and part, and finishes the story: stage, events and photo goals. It asks first. To keep racing the career, use Next unlocks instead.';
  } else {
    $('dbState').textContent = 'Game data: not loaded. Best car, carbon, Looks, Change car and Unlock everything read the car and story data in GLOBALB.BUN. Read it from the site cache, or choose the file.';
    $('unlockNote').textContent = 'Needs the game data (the last card): carbon fibre conversions and pearlescent paint are locked by story progress, not by the part table.';
  }
}

/** I12: the section tabs at 400 px jump to a card and mark the one in view. */
function initJump() {
  const nav = $('jump');
  const buttons = [...nav.querySelectorAll('button')];
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const t = $(b.dataset.to);
      if (!t) return;
      t.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      mark(b.dataset.to);
    });
  }
  function mark(id) { for (const b of buttons) b.setAttribute('aria-current', String(b.dataset.to === id)); }
  let queued = false;
  const follow = () => {
    queued = false;
    const line = nav.getBoundingClientRect().bottom + 8;
    let cur = null;
    for (const b of buttons) {
      const t = $(b.dataset.to);
      if (!t || b.hidden || !t.offsetParent) continue;
      if (t.getBoundingClientRect().top <= line) cur = b.dataset.to;
    }
    // At the very bottom the last visible section is the one being read, even when it is too short to reach the line.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) cur = buttons.filter((b) => !b.hidden).at(-1)?.dataset.to ?? cur;
    mark(cur ?? buttons.find((b) => !b.hidden)?.dataset.to);
  };
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(follow); } }, { passive: true });
  ui.followJump = follow;
}

/** A tab for a card that is hidden (no career, read only) is hidden too. */
function syncJump() {
  for (const b of $('jump').querySelectorAll('button')) {
    const t = $(b.dataset.to);
    b.hidden = !t || t.hidden || getComputedStyle(t).display === 'none';
  }
  ui.followJump?.();
}

// ---- actions -----------------------------------------------------------------------------------

const archivedNote = (profile, n) => `This ${profile} is a new career with an old name: the history of the earlier ${profile} (${n} ${n === 1 ? 'entry' : 'entries'}) was set aside, so Undo cannot write it over this one.`;

/** Removes the history entry of a write that did not happen. Returns '' or a sentence for the toast when that failed. */
async function dropEntry(key, id) {
  try { await hist.drop(store, key, id); return ''; } catch (err) { return ` Its history entry could not be removed (${err?.message || err}), so History lists an edit that was not written.`; }
}

async function edit(label, change) {
  if (ui.busy) return;
  if (!ui.ack) { showAck(); return; }
  setBusy(true);
  // Everything this edit reads and writes is fixed here, whatever the panel shows by the time the write runs.
  const at = { saveDir: ui.saveDir, profile: ui.profile };
  const key = hist.historyKey(at.saveDir, at.profile);
  let recorded = null;
  // @dev-only begin lease-vars
  let lease = null, renew = null;
  // @dev-only end lease-vars
  try {
    // @dev-only begin write-lease
    // The worker will not reload the extension for an update while this lease is held. It lapses after 15 minutes
    // unless renewed, so it is renewed every minute (data-lease-renew-ms in tests) until the edit ends.
    // The panel names the lease, so a writeBegin sent again after a lost answer holds one lease, not two.
    try { lease = await toWorker({ type: 'writeBegin', id: crypto.randomUUID() }); } catch (err) {
      if (!NO_RECEIVER.test(String(err?.message || err))) throw err;
      toast(await workerLost(), { kind: 'bad' });
      return;
    }
    if (!lease?.ok) { toast(lease?.why || 'The editor could not start the write. Nothing was written. Try again.', { kind: 'bad' }); return; }
    const every = Number(document.body.dataset.leaseRenewMs) || 60000;
    renew = setInterval(() => { toWorker({ type: 'writeRenew', id: lease.id }).catch(() => {}); }, every);
    // @dev-only end write-lease
    const cur = await readProfile(at);
    const out = await change(cur.state, at);
    const next = out.state ?? out;
    let note = out.note ? ` ${out.note}` : '';
    // Nothing reaches the save that does not pass the same checks a read does, Undo snapshots included.
    try { ops.validateWrite(next); } catch (err) { toast(`${label}: the files to write are damaged (${err.message}). Nothing was written.`, { kind: 'bad' }); return; }
    const same = (a, b) => (a == null && b == null) || (a && b && a.length === b.length && a.every((x, i) => x === b[i]));
    if (same(next.career, cur.state.career) && same(next.garage, cur.state.garage)) {
      toast(`${label}: already done, nothing to write.`);
      return;
    }
    const claimed = await hist.claim(store, key, { hash: await hist.stateHash(cur.state), progress: ops.careerProgress(cur.state.career) });
    if (claimed.archived) note += ` ${archivedNote(at.profile, claimed.archived)}`;
    recorded = await hist.record(store, key, label, cur.state, next, { before: ops.careerProgress(cur.state.career), after: ops.careerProgress(next.career) });
    // Both files are checked against what was read: the career, and GARAGE.DAT (null: there must be none).
    const res = await send({
      type: 'write', saveDir: at.saveDir, profile: at.profile, expectCareerSha: cur.careerSha, expectGarageSha: cur.garageSha,
      career: hist.toB64(next.career), garage: next.garage ? hist.toB64(next.garage) : null,
    });
    if (!res.ok) {
      // Only a refused or rolled-back write left the files as they were. After any other failure the entry stays,
      // so Undo can put back whatever half of the edit landed.
      let lost = '';
      if (res.refused || res.rolledBack) { lost = await dropEntry(key, recorded.id); recorded = null; }
      toast(res.why + lost, { kind: 'bad' });
      return;
    }
    const wantCareer = await hist.sha256(next.career), wantGarage = next.garage ? await hist.sha256(next.garage) : null;
    if (res.careerSha !== wantCareer || res.garageSha !== wantGarage) {
      toast('The write did not read back as expected. Use Undo on the newest history entry.', { kind: 'bad' });
      return;
    }
    const n = recorded.dropped;
    const room = n ? ` To make room, the ${n === 1 ? 'oldest undo entry was' : `${n} oldest undo entries were`} dropped; every profile's original is kept.` : '';
    // I8 and I9: every saved edit offers its own Undo beside Reload. An undo does not offer to undo itself: History does.
    toast(`${label}: saved.${note}${room} Reload nfsu2.xyz before you press Play, so the game loads the change.`, { reload: true, undo: /^(Undo: |Restore original$)/.test(label) ? null : recorded.id });
  } catch (err) {
    // No answer from the page (it closed, reloaded or crashed mid-write): the files may have changed. Drop the entry
    // only when a fresh read shows they are exactly as before; otherwise keep it for Undo.
    let kept = false, lost = '';
    if (recorded && err?.notDelivered) {
      // No content script received the write, so the files are exactly as read.
      lost = await dropEntry(key, recorded.id);
    } else if (recorded) {
      const untouched = await readProfile(at).then(async (r) => await hist.stateHash(r.state) === recorded.beforeHash, () => false);
      if (untouched) lost = await dropEntry(key, recorded.id);
      else kept = true;
    }
    toast((kept ? `${err.message} The save may have changed: Undo on the newest history entry puts it back as it was.` : err.message) + lost, { kind: 'bad' });
  } finally {
    // @dev-only begin write-lease-end
    clearInterval(renew);
    if (lease?.ok) await toWorker({ type: 'writeEnd', id: lease.id }).catch(() => {});
    // @dev-only end write-lease-end
    setBusy(false);
    // A tab switch or Refresh during the write waited until now. A failure here comes after the write was settled,
    // so it is shown beside the write's own message rather than lost.
    try {
      if (ui.reconnect) { ui.reconnect = false; await connect(); } else { await renderProfile(); await renderHistory(); }
    } catch (err) {
      const before = $('toast').hidden ? '' : `${$('toastText').textContent} `;
      toast(`${before}The panel could not redraw after the edit (${err?.message || err}). Click Refresh.`, { kind: 'bad' });
    }
    document.body.dataset.edits = String(Number(document.body.dataset.edits || 0) + 1);
  }
}

// ---- backup and restore ----------------------------------------------------------------------------

// The last restore of each save folder, so "Undo the last restore" can put every profile it touched back at once:
// { at, file, items: [{ profile, mode: 'add' | 'replace', afterHash, entryId }] }.
const restoreKey = (saveDir) => `restore:last:${saveDir}`;
const MAX_RESTORE_BYTES = 256 * 1024 * 1024;
const nameList = (names) => (names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', '));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The career profiles on disk now, by asking the page, not from what the panel last drew. */
async function profileNames() {
  const st = await send({ type: 'status' });
  if (!st?.ok) throw new Error(st?.why || 'The page did not answer.');
  ui.gate = st.gate;
  return st.profiles.map((p) => p.name);
}

/** B1: one zip of every career and its GARAGE.DAT, in nfsu2.xyz's own backup layout. Reading only, so no notice needed. */
async function downloadBackup() {
  if (ui.busy) return;
  setBusy(true);
  try {
    const names = await profileNames();
    if (!names.length) { toast('This browser has no career on nfsu2.xyz to back up yet.', { kind: 'bad' }); return; }
    const profiles = [];
    for (const name of names) profiles.push({ name, ...(await readProfile({ saveDir: ui.saveDir, profile: name })).state });
    const zip = buildBackup(profiles);
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const a = el('a', { href: url, download: backupFileName() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    document.body.dataset.backups = String(Number(document.body.dataset.backups || 0) + 1);
    toast(`Backup saved as ${a.download} in your downloads: ${plural(names.length, 'career')} (${nameList(names)}).`);
  } catch (err) {
    toast(`The backup failed (${err?.message || err}). Nothing was changed.`, { kind: 'bad' });
  } finally {
    setBusy(false);
    if (ui.reconnect) { ui.reconnect = false; await connect().catch(() => {}); }
  }
}

function hideRestoreConfirm() {
  $('restoreConfirm').hidden = true;
  ui.pendingRestore = null;
}

/** B2: reads the picked file, checks every career in it, and asks first with what changes per profile. Writes nothing. */
async function pickRestore(file) {
  hideRestoreConfirm();
  if (ui.busy || !file) return;
  if (!ui.ack) { showAck(); return; }
  setBusy(true);
  try {
    if (file.size > MAX_RESTORE_BYTES) throw new Error(`${file.name} is too large to be an NFSU2 backup. Nothing was written.`);
    const parsed = await parseRestore(new Uint8Array(await file.arrayBuffer()), file.name);
    const names = await profileNames();
    if (!ui.gate?.ok) throw new Error(`${ui.gate?.why || 'Writing is not safe right now.'} Nothing was written.`);
    const plan = planRestore(parsed, names);
    const steps = [], rows = [];
    for (const p of plan) {
      if (p.action === 'add') {
        const state = { career: p.career, garage: p.garage };
        steps.push({ profile: p.profile, mode: 'add', state });
        const s = ops.summary(state, ui.db), pr = ops.careerProgress(state.career);
        rows.push([p.profile, null, `Added as a new profile: $${fmt(s.money)}, ${pr.events} events won.`]);
        continue;
      }
      const cur = await readProfile({ saveDir: ui.saveDir, profile: p.profile });
      // A single career file carries no GARAGE.DAT, so the profile keeps its own. A zip restores the profile exactly
      // as backed up, so a backup without one leaves the profile without one, as the game does after an Undo.
      const state = { career: p.career, garage: parsed.kind === 'career' ? cur.state.garage : p.garage };
      steps.push({ profile: p.profile, mode: 'replace', cur, state });
      if (await hist.stateHash(state) === await hist.stateHash(cur.state)) { rows.push([p.profile, null, 'Already the same as the backup.']); continue; }
      const ch = undoChanges(cur.state, state).rows;
      rows.push([p.profile, null, ch.length ? 'Replaced. Its save now is kept in History first:' : 'Replaced (same money, stage and cars). Its save now is kept in History first.']);
      for (const [k, from, to] of ch) rows.push([k, from, to]);
      if (cur.state.garage && !state.garage) rows.push(['GARAGE.DAT', 'present', 'removed, none in the backup']);
    }
    const adds = steps.filter((s) => s.mode === 'add').length, reps = steps.length - adds;
    const what = [adds ? `adds ${plural(adds, 'profile')}` : '', reps ? `replaces ${plural(reps, 'profile')}` : ''].filter(Boolean).join(' and ');
    $('restoreConfirmText').textContent = `Restoring ${file.name} ${what}. ${reps ? 'Each replaced profile is kept in its History first, and "Undo the last restore" puts every profile back at once.' : '"Undo the last restore" removes the added profiles again.'}`;
    fillDiff($('restoreDiff'), rows);
    const sk = parsed.skipped;
    $('restoreSkipped').hidden = !sk.length;
    $('restoreSkipped').textContent = sk.length ? `Left out: ${sk.slice(0, 4).map((x) => `${x.path} (${x.why})`).join('; ')}${sk.length > 4 ? `; and ${sk.length - 4} more` : ''}.` : '';
    ui.pendingRestore = { file: file.name, steps };
    $('restoreConfirm').hidden = false;
    $('restoreYes').focus();
  } catch (err) {
    toast(`${file.name} cannot be restored: ${err?.message || err}${/Nothing was written/.test(String(err?.message)) ? '' : ' Nothing was written.'}`, { kind: 'bad' });
  } finally {
    setBusy(false);
    if (ui.reconnect) { ui.reconnect = false; await connect().catch(() => {}); }
  }
}

/**
 * Writes several profiles as one change through content.js "restore": all or nothing. Every replaced profile gets a
 * history entry first (its state before), dropped again when the page refused or rolled back. Returns the recorded
 * entries by profile, or null when nothing was written (the toast says why).
 */
async function writeGroup(label, steps) {
  const saveDir = ui.saveDir;
  const recorded = new Map();
  // @dev-only begin group-lease-vars
  let lease = null, renew = null;
  // @dev-only end group-lease-vars
  setBusy(true);
  try {
    // @dev-only begin group-lease
    try { lease = await toWorker({ type: 'writeBegin', id: crypto.randomUUID() }); } catch (err) {
      if (!NO_RECEIVER.test(String(err?.message || err))) throw err;
      toast(await workerLost(), { kind: 'bad' });
      return null;
    }
    if (!lease?.ok) { toast(lease?.why || 'The editor could not start the write. Nothing was written. Try again.', { kind: 'bad' }); return null; }
    const every = Number(document.body.dataset.leaseRenewMs) || 60000;
    renew = setInterval(() => { toWorker({ type: 'writeRenew', id: lease.id }).catch(() => {}); }, every);
    // @dev-only end group-lease
    for (const s of steps) {
      if (!s.state) continue;
      try { ops.validateWrite(s.state); } catch (err) { toast(`${label}: the files for ${s.profile} are damaged (${err.message}). Nothing was written.`, { kind: 'bad' }); return null; }
    }
    for (const s of steps) {
      if (s.mode !== 'replace') continue;
      const key = hist.historyKey(saveDir, s.profile);
      await hist.claim(store, key, { hash: await hist.stateHash(s.cur.state), progress: ops.careerProgress(s.cur.state.career) });
      const r = await hist.record(store, key, label, s.cur.state, s.state, { before: ops.careerProgress(s.cur.state.career), after: ops.careerProgress(s.state.career) });
      recorded.set(s.profile, { key, id: r.id, beforeHash: r.beforeHash });
    }
    const res = await send({
      type: 'restore', saveDir,
      items: steps.map((s) => ({
        profile: s.profile, mode: s.mode,
        career: s.state ? hist.toB64(s.state.career) : null, garage: s.state?.garage ? hist.toB64(s.state.garage) : null,
        ...(s.cur ? { expectCareerSha: s.cur.careerSha, expectGarageSha: s.cur.garageSha } : {}),
      })),
    });
    if (!res.ok) {
      let lost = '';
      if (res.refused || res.rolledBack) { for (const r of recorded.values()) lost += await dropEntry(r.key, r.id); recorded.clear(); }
      toast(res.why + lost, { kind: 'bad' });
      return null;
    }
    for (const s of steps) {
      const r = res.results?.find((x) => x.profile === s.profile);
      const fine = s.mode === 'remove' ? r?.removed === true
        : r && r.careerSha === await hist.sha256(s.state.career) && r.garageSha === (s.state.garage ? await hist.sha256(s.state.garage) : null);
      if (!fine) { toast(`${label}: ${s.profile} did not read back as expected. Check its History.`, { kind: 'bad' }); return null; }
    }
    return recorded;
  } catch (err) {
    // No answer from the page: drop each entry only when a fresh read shows that profile exactly as before.
    let kept = false, lost = '';
    for (const [profile, r] of recorded) {
      const untouched = err?.notDelivered || await readProfile({ saveDir, profile }).then(async (x) => await hist.stateHash(x.state) === r.beforeHash, () => false);
      if (untouched) lost += await dropEntry(r.key, r.id);
      else kept = true;
    }
    toast(`${err?.message || err}${kept ? ' Some profiles may have changed: each one\'s History can put it back.' : ''}${lost}`, { kind: 'bad' });
    return null;
  } finally {
    // @dev-only begin group-lease-end
    clearInterval(renew);
    if (lease?.ok) await toWorker({ type: 'writeEnd', id: lease.id }).catch(() => {});
    // @dev-only end group-lease-end
    setBusy(false);
    ui.reconnect = false;
    // Profiles were added or removed: list them again.
    try { await connect(); } catch (err) { toast(`The panel could not redraw (${err?.message || err}). Click Refresh.`, { kind: 'bad' }); }
    document.body.dataset.restores = String(Number(document.body.dataset.restores || 0) + 1);
  }
}

/** The confirmed restore. The page checks every profile against what was read before the first byte is written. */
async function runRestore() {
  const p = ui.pendingRestore;
  hideRestoreConfirm();
  if (!p || ui.busy) return;
  if (!ui.ack) { showAck(); return; }
  const label = `Restore from ${p.file}`;
  const recorded = await writeGroup(label, p.steps);
  if (!recorded) return;
  const items = [];
  for (const s of p.steps) items.push({ profile: s.profile, mode: s.mode, afterHash: await hist.stateHash(s.state), entryId: recorded.get(s.profile)?.id ?? null });
  let note = '';
  try { await store.set(restoreKey(ui.saveDir), { at: Date.now(), file: p.file, items }); } catch (err) {
    note = ` It could not be kept for "Undo the last restore" (${err?.message || err}): each replaced profile's History can still put it back.`;
  }
  await renderRestoreUndo();
  toast(`${label}: ${plural(p.steps.length, 'profile')} restored.${note} Reload nfsu2.xyz before you press Play, so the game loads them.`, { reload: true, undo: note ? null : 'restore' });
}

/** Puts every profile of the last restore back: replaced ones from their History, added ones removed. */
async function undoRestore() {
  if (ui.busy) return;
  if (!ui.ack) { showAck(); return; }
  const g = await store.get(restoreKey(ui.saveDir));
  if (!g) { await renderRestoreUndo(); toast('There is no restore to undo.'); return; }
  const steps = [], changed = [];
  for (const it of g.items) {
    const cur = await readProfile({ saveDir: ui.saveDir, profile: it.profile }).catch(() => null);
    if (!cur || await hist.stateHash(cur.state) !== it.afterHash) { changed.push(it.profile); continue; }
    if (it.mode === 'add') { steps.push({ profile: it.profile, mode: 'remove', cur }); continue; }
    const e = it.entryId ? await hist.entry(store, hist.historyKey(ui.saveDir, it.profile), it.entryId) : null;
    if (!e) { changed.push(it.profile); continue; }
    steps.push({ profile: it.profile, mode: 'replace', cur, state: hist.decode(e) });
  }
  if (changed.length) {
    toast(`${nameList(changed)} changed since the restore (played, edited or its history entry gone), so undoing the whole restore would lose that. Nothing was written. Each profile's History can still put it back on its own.`, { kind: 'bad' });
    return;
  }
  const label = `Undo: Restore from ${g.file}`;
  if (!await writeGroup(label, steps)) return;
  await chrome.storage.local.remove(restoreKey(ui.saveDir)).catch(() => {});
  await renderRestoreUndo();
  const gone = steps.filter((s) => s.mode === 'remove').map((s) => s.profile);
  toast(`${label}: done.${gone.length ? ` Removed ${nameList(gone)}.` : ''} Reload nfsu2.xyz before you press Play.`, { reload: true });
}

async function renderRestoreUndo() {
  let g = null;
  try { g = await store.get(restoreKey(ui.saveDir)); } catch { g = null; }
  $('undoRestore').hidden = !g;
  if (g) $('undoRestore').querySelector('span').textContent = `Undo the restore of ${g.file}`;
}

function hideUndoConfirm() {
  $('undoConfirm').hidden = true;
  ui.pendingUndo = null;
}

const listLabels = (entries) => {
  const names = entries.map((x) => `"${x.label}"`);
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
};

/** What going from the save on disk to a snapshot changes, in a sentence: money, stage, events won and cars. */
function undoChanges(cur, snap) {
  const a = ops.summary(cur, ui.db), b = ops.summary(snap, ui.db);
  const pa = ops.careerProgress(cur.career), pb = ops.careerProgress(snap.career);
  const stage = (v) => ops.STAGES.find((x) => x.value === v)?.label ?? String(v);
  const out = [], rows = [];
  if (a.money !== b.money) { out.push(`money $${fmt(a.money)} to $${fmt(b.money)}`); rows.push(['Money', `$${fmt(a.money)}`, `$${fmt(b.money)}`]); }
  if (pa.stage !== pb.stage) { out.push(`stage ${stage(pa.stage)} to ${stage(pb.stage)}`); rows.push(['Stage', stage(pa.stage), stage(pb.stage)]); }
  if (pa.events !== pb.events) { out.push(`events won ${pa.events} to ${pb.events}`); rows.push(['Events won', pa.events, pb.events]); }
  const gone = a.cars.filter((c) => !b.cars.some((d) => d.slot === c.slot && d.hash === c.hash)).map((c) => c.name);
  if (gone.length) out.push(`${gone.join(', ')} ${gone.length === 1 ? 'goes' : 'go'}`);
  else if (a.cars.length !== b.cars.length) out.push(`cars ${a.cars.length} to ${b.cars.length}`);
  if (gone.length || a.cars.length !== b.cars.length) rows.push(['Cars', a.cars.length, b.cars.length]);
  for (const name of gone) rows.push([name, 'in the garage', 'gone']);
  return { text: out.length ? ` It changes ${out.join(', ')}.` : '', rows };
}

/**
 * Undo of one entry, or Restore original. When the save on disk is not the state the entry's write left (a later edit,
 * or progress made in game), it asks first and names what goes back. The write then checks the save is still the one
 * that was confirmed.
 */
async function undo(id) {
  if (ui.busy) return;
  hideUndoConfirm();
  const at = { saveDir: ui.saveDir, profile: ui.profile };
  const key = hist.historyKey(at.saveDir, at.profile);
  try {
    const h = await hist.load(store, key);
    const e = id === 'original' ? (h.original ? { label: 'Original', ...h.original } : null) : h.entries.find((x) => x.id === id);
    if (!e) return toast('That history entry is gone.', { kind: 'bad' });
    const snap = hist.decode(e);
    try { ops.validateWrite(snap); } catch (err) { return toast(`That history entry is damaged (${err.message}), so it cannot be put back. Nothing was written.`, { kind: 'bad' }); }
    const cur = await readProfile(at);
    const curHash = await hist.stateHash(cur.state);
    const label = id === 'original' ? 'Restore original' : `Undo: ${e.label}`;
    const run = () => edit(label, async (s) => {
      if (await hist.stateHash(s) !== curHash) throw new Error('The save changed since you confirmed. Nothing was written. Click Undo again to see what it would change now.');
      return snap;
    });
    const newest = h.entries.at(-1);
    if (id !== 'original' && curHash === e.afterHash) return run();
    if (curHash === (await hist.stateHash(snap))) return run();
    const later = id === 'original' ? h.entries : h.entries.slice(h.entries.indexOf(e) + 1);
    const outside = curHash !== (newest ? newest.afterHash : h.original?.hash);
    const when = new Date(e.at).toLocaleString();
    let text = id === 'original'
      ? `Restore original puts back the save as it was before your first edit (${when}).`
      : `Undo of "${e.label}" puts back the save as it was before that edit (${when}).`;
    if (later.length) text += ` That also reverts ${later.length === 1 ? 'the later edit' : `${later.length} later edits`}: ${listLabels(later)}.`;
    if (outside) text += ' It also reverts what you did in game since the last edit: races, buys and money.';
    let rows = [];
    try { const c = undoChanges(cur.state, snap); text += c.text; rows = c.rows; } catch { /* the summary is a courtesy */ }
    fillDiff($('undoDiff'), rows);
    if (!snap.garage && cur.state.garage) text += ' GARAGE.DAT is deleted, as the game had made none then, so cars in slots 6 to 10 go.';
    text += ' The save you have now gets its own Undo entry.';
    $('undoConfirmText').textContent = text;
    ui.pendingUndo = run;
    $('undoConfirm').hidden = false;
    setBusy(ui.busy);
    $('undoConfirmYes').focus();
  } catch (err) {
    toast(err?.message || String(err), { kind: 'bad' });
  }
}

async function loadDbFromBytes(bytes, where) {
  try {
    const json = ops.parseGameDb(bytes); // plain GLOBALB.BUN or the site's JDLZ GlobalB.lzc
    await store.set('gameDb', json);
    ui.dbJson = json;
    ui.db = ops.hydrateDb(json);
    toast(`Game data loaded from ${where}.`);
  } catch (err) {
    toast(`That is not a usable GLOBALB.BUN: ${err.message}`, { kind: 'bad' });
  }
  renderDb();
  await renderProfile();
}

async function dbFromSite(quiet) {
  try {
    const res = await send({ type: 'gameData' });
    if (!res.ok || !res.found) { if (!quiet) toast(res.why || 'Game data not found in the site cache.', { kind: 'bad' }); return; }
    await loadDbFromBytes(hist.fromB64(res.b64), 'the site cache');
  } catch (err) { if (!quiet) toast(err.message, { kind: 'bad' }); }
}

// ---- wiring ------------------------------------------------------------------------------------

/** U7: with no career, or read only, the panel says why and what to do instead of showing disabled controls. */
function showGuide(mode, why = '') {
  document.body.dataset.mode = mode;
  const g = mode === 'noprofile'
    ? ['Start a career', 'This browser has no NFSU2 career on nfsu2.xyz yet. Press Play there, create a profile in the game and let it save, then quit to the menu and click Check again.']
    : mode === 'readonly'
      ? ['Read only', `${why} Your career is shown below, and editing comes back once this is fixed.`]
      : null;
  $('guide').hidden = !g;
  if (g) { $('guideTitle').textContent = g[0]; $('guideText').textContent = g[1]; }
  syncJump();
}

async function connect() {
  // Mid-write, the tab, save folder and profile stay as the write found them: reconnect once it ends (edit()).
  if (ui.busy) { ui.reconnect = true; return; }
  const gen = ++ui.connGen;
  const tabId = await findSiteTab();
  if (gen !== ui.connGen) return;
  ui.tabId = tabId;
  let st = null;
  try { st = await send({ type: 'status' }); } catch { st = null; }
  // A newer connect (a tab event, Retry) started while this one waited: it decides what the panel shows.
  if (gen !== ui.connGen) return;
  if (!st) {
    showGuide('off');
    ui.tabId = null;
    ui.gate = null;
    ui.profile = null;
    ui.renderGen++;
    ui.histGen++;
    $('app').hidden = true;
    // I10: say what to do, with the button that does it.
    $('offline').hidden = false;
    $('retry').hidden = false;
    setConn('Not connected. Open nfsu2.xyz in this window, then click Retry. If it is already open, reload that tab once.', 'bad');
    setBusy(false);
    return;
  }
  $('retry').hidden = true;
  $('offline').hidden = true;
  $('app').hidden = false;
  ui.saveDir = st.saveDir; ui.gate = st.gate;
  const sel = $('profile'), keep = ui.profile;
  sel.replaceChildren(...st.profiles.map((p) => new Option(p.name, p.name)));
  ui.profile = st.profiles.some((p) => p.name === keep) ? keep : st.profiles[0]?.name ?? null;
  if (ui.profile) sel.value = ui.profile;
  if (!st.profiles.length) setConn('Connected, but this browser has no career profiles on nfsu2.xyz yet.', 'warn');
  else if (!st.gate.ok) setConn(`Read only: ${st.gate.why}`, 'warn');
  else setConn(`Connected. ${st.profiles.length} profile${st.profiles.length === 1 ? '' : 's'}, safe to edit.`, 'ok');
  $('roamNote').hidden = st.roam !== true;
  showGuide(!st.profiles.length ? 'noprofile' : st.gate.ok ? 'edit' : 'readonly', st.gate.why);
  setBusy(false);
  await renderRestoreUndo();
  await renderProfile();
  await renderHistory();
}

// @dev-only begin update-note
/** Once after the extension updated itself to a new commit, or brought over an old install's history (background.js). */
async function showUpdateNote() {
  const [note, imported] = [await store.get('updateNote'), await store.get('importNote')];
  const parts = [];
  if (note?.to) parts.push(`Updated to ${note.to}${note.from ? ` (was ${note.from})` : ''}.`);
  if (imported?.profiles) parts.push(`Brought over the undo history of ${imported.profiles} profile${imported.profiles === 1 ? '' : 's'} from the old install, originals included.`);
  // workerLost() restarted the extension: say why, once. The entry stays, so its time still limits restarts.
  const heal = await store.get(HEAL_KEY);
  if (heal?.at && !heal.shown) {
    parts.push(`The editor reloaded itself to its current version (${heal.cause}).${heal.clicked ? ' Nothing was written: click again.' : ''}`);
    await store.set(HEAL_KEY, { ...heal, shown: true });
  }
  if (!parts.length) return;
  await chrome.storage.local.remove(['updateNote', 'importNote']);
  if (!$('toast').hidden) parts.push($('toastText').textContent);
  toast(parts.join(' '));
}
// @dev-only end update-note

// ---- first run: offline-only notice ---------------------------------------------------------------

const ACK_KEY = 'offlineAck';
const ACK_VERSION = 1;

/** Shows the notice as a modal. Escape does not dismiss it: only the button does. */
function showAck() {
  const d = $('ack');
  if (!d.open) d.showModal();
  $('ackYes').focus();
}

/** Reads the stored confirmation. A storage failure counts as not confirmed, so writes stay blocked. */
async function loadAck() {
  try { ui.ack = (await store.get(ACK_KEY))?.version === ACK_VERSION; } catch { ui.ack = false; }
  if (!ui.ack) showAck();
  setBusy(ui.busy);
}

async function confirmAck() {
  const btn = $('ackYes');
  btn.disabled = true;
  try {
    await store.set(ACK_KEY, { version: ACK_VERSION, at: Date.now() });
    ui.ack = true;
    $('ack').close();
    setBusy(ui.busy);
  } catch (err) {
    toast(`The editor could not save your answer (${err?.message || err}), so editing stays off. Try again.`, { kind: 'bad' });
  } finally {
    btn.disabled = false;
  }
}

function init() {
  $('ackYes').addEventListener('click', confirmAck);
  $('ack').addEventListener('cancel', (e) => e.preventDefault());
  $('stage').replaceChildren(...ops.STAGES.map((s) => new Option(s.label, String(s.value))));
  $('refresh').addEventListener('click', connect);
  $('guideRefresh').addEventListener('click', connect);
  $('undoConfirmYes').addEventListener('click', () => { const run = ui.pendingUndo; hideUndoConfirm(); if (run) run(); });
  $('undoConfirmNo').addEventListener('click', hideUndoConfirm);
  $('profile').addEventListener('change', async (e) => { ui.profile = e.target.value; await renderProfile(); await renderHistory(); });
  $('setMoney').addEventListener('click', () => {
    const v = Number($('money').value);
    if (!Number.isInteger(v) || v < 0 || v > ops.FIELD_MAX_MONEY) return toast(`Enter a whole number from 0 to ${fmt(ops.FIELD_MAX_MONEY)}. Higher amounts can wrap negative when you win prize money.`, { kind: 'bad' });
    edit(`Money set to $${fmt(v)}`, (s) => ops.setMoney(s, v));
  });
  $('maxMoney').addEventListener('click', () => edit(`Money set to $${fmt(ops.MAX_BUTTON_MONEY)}`, (s) => ops.setMoney(s, ops.MAX_BUTTON_MONEY)));
  $('unlockAll').addEventListener('click', askUnlockConfirm);
  $('garageReplace').addEventListener('click', askGarageConfirm);
  $('garageReplaceNo').addEventListener('click', () => { hideGarageConfirm(); $('garageReplace').focus(); });
  $('garageAgree').addEventListener('change', () => setBusy(ui.busy));
  $('garageBackup').addEventListener('click', downloadBackup);
  $('garageReplaceYes').addEventListener('click', () => {
    const confirmed = $('garageAgree').checked;
    hideGarageConfirm();
    edit('Ready-made garage: every car replaced', (s) => {
      const r = ops.replaceGarage(s, readyGarage, ui.db, { confirmed });
      const left = r.unplaced.length ? ` Not placed: ${r.unplaced.join(', ')}.` : '';
      return { state: r.state, note: `${r.reports.length} cars replaced.${left}${skippedNote(r.reports)}` };
    });
  });
  $('unlockConfirmNo').addEventListener('click', () => { hideUnlockConfirm(); $('unlockAll').focus(); });
  $('unlockConfirmYes').addEventListener('click', () => { hideUnlockConfirm(); edit('Unlock everything (story finished)', (s) => ops.unlockAll(s, ui.db)); });
  $('urlWins').addEventListener('click', askUrlWinsConfirm);
  $('urlWinsNo').addEventListener('click', () => { hideUrlWinsConfirm(); $('urlWins').focus(); });
  $('urlWinsYes').addEventListener('click', () => {
    const n = ui.urlPlan?.races.length ?? 0, stage = ui.urlPlan?.stage ?? '';
    hideUrlWinsConfirm();
    // The write re-plans on the bytes it reads, so a save changed since the preview gets the races it now needs.
    edit(`Carbon body kits: ${n} ${stage} URL race wins recorded`, (s) => ops.recordUrlWins(s, ui.db));
  });
  $('maxPerf').addEventListener('click', () => edit('Max performance on every car', (s) => ops.maxPerformance(s)));
  $('uniques').addEventListener('click', () => edit('All unique upgrades on every car', (s) => ops.applyUniques(s)));
  $('carbonAll').addEventListener('click', () => edit('Carbon fibre on every car', (s) => ops.setCarbon(s, null, true, ui.db)));
  $('bestGarage').addEventListener('click', () => edit('Best version of every car', (s) => runWorker({ kind: 'garage' }, s)));
  $('setStage').addEventListener('click', () => {
    const v = Number($('stage').value);
    edit(`Stage set to ${ops.STAGES.find((s) => s.value === v).label}`, (s) => ops.setStage(s, v));
  });
  $('restoreOriginal').addEventListener('click', () => undo('original'));
  $('dbFromSite').addEventListener('click', () => dbFromSite(false));
  $('dbFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) await loadDbFromBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    e.target.value = '';
  });
  $('backupAll').addEventListener('click', downloadBackup);
  $('restoreFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    await pickRestore(f);
  });
  $('restoreYes').addEventListener('click', runRestore);
  $('restoreNo').addEventListener('click', hideRestoreConfirm);
  $('undoRestore').addEventListener('click', undoRestore);
  $('dismiss').addEventListener('click', () => { clearTimeout(toastTimer); $('toast').hidden = true; });
  $('toastUndo').addEventListener('click', () => {
    const id = $('toastUndo').dataset.id;
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    if (id === 'restore') undoRestore();
    else if (id) undo(id);
  });
  $('openSite').addEventListener('click', async () => { await chrome.tabs.create({ url: 'https://nfsu2.xyz/' }); });
  $('dbChange').addEventListener('click', () => {
    const open = $('dbLoad').hidden;
    $('dbLoad').hidden = !open;
    $('dbChange').setAttribute('aria-expanded', String(open));
  });
  initJump();
  WIDE.addEventListener('change', applyAutoCar);
  $('storyLocksMore').addEventListener('click', () => { ui.locksAll = !ui.locksAll; paintLocksMore(); });
  $('reload').addEventListener('click', async () => {
    if (ui.tabId != null) await chrome.tabs.reload(ui.tabId);
    $('toast').hidden = true;
    setTimeout(connect, 2500);
  });
  $('retry').addEventListener('click', connect);
  chrome.tabs.onActivated.addListener(() => connect());
  // The site tab reloaded, navigated or closed: what the panel shows (profiles, cars, the gate) may be stale. While it
  // loads, writes stay off; once loaded, connect reads everything again.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== ui.tabId || !info.status) return;
    if (info.status === 'loading') { ui.gate = { ok: false, why: 'the nfsu2.xyz tab is reloading' }; setConn('nfsu2.xyz is reloading…', 'warn'); setBusy(ui.busy); }
    else if (info.status === 'complete') connect();
  });
  chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === ui.tabId) connect(); });
  // content.js reports when the site starts or stops the game (Play, quit), so the status follows the gate.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id === chrome.runtime.id && sender.tab?.id === ui.tabId && msg?.type === 'phase') connect();
  });
  (async () => {
    // @dev-only begin stale-check
    // An install still running an older copy's manifest or worker reloads itself once, before anything is read.
    const stale = await staleCopy();
    if (stale) {
      const r = await restartEditor(stale, false);
      toast(r.msg, { kind: 'bad' });
      if (r.restarting) { setConn('Updating the editor…', 'warn'); return; }
    }
    // @dev-only end stale-check
    // @dev-only begin history-import
    // Before the first history render: a new install folder brings over the old install's undo history once.
    await toWorker({ type: 'importHistory' }).catch(() => null);
    // @dev-only end history-import
    await loadAck();
    const saved = await store.get('gameDb');
    ui.db = ops.hydrateDb(saved);
    ui.dbJson = ui.db ? saved : null;
    renderDb();
    await connect();
    if (!ui.db && ui.tabId != null) { await dbFromSite(true); }
    // @dev-only begin update-check
    await showUpdateNote();
    // A commit that landed while the worker slept applies now, unless a write is running.
    toWorker({ type: 'checkUpdate' }).catch(() => {});
    // @dev-only end update-check
  })();
}

init();
