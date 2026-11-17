// Tooltips: every control explains itself after 1.3 s of hover, or at once on keyboard focus.
//
// A tip comes from the element's own title (set by the panel for tips that depend on the car or the state), else from
// TIPS below by selector. Titles move to data-tip so the browser's own tooltip never shows next to this one, and the
// text stays readable to screen readers as aria-description. A MutationObserver applies both to controls the panel
// builds later and to titles it changes. Iframes keep their title: it names the frame, it is not a tip.

export const DELAY = 1300;

/** Selector, tip. The first match wins, and an element's own title beats all of them. */
export const TIPS = [
  // Header, first run, jump bar
  ['#openSite', 'Opens nfsu2.xyz in a tab. The editor reads and writes the careers saved there.'],
  ['#retry', 'Looks for the nfsu2.xyz tab again.'],
  ['#ackYes', 'Confirms you will play edited careers offline only. Shown once.'],
  ['.jump [data-to="careerCard"]', 'Scroll to money, stage and the whole-garage buttons.'],
  ['.jump [data-to="carsCard"]', 'Scroll to your cars: parts, carbon, looks and setups per car.'],
  ['.jump [data-to="music"]', 'Scroll to the EA Trax player and the music folder check.'],
  ['.jump [data-to="historyCard"]', 'Scroll to the list of edits, each with its own Undo.'],
  ['#guideRefresh', 'Reads the site again after you changed something there or in the game.'],

  // Career
  ['#profile', 'The career to edit. Every card below works on this one.'],
  ['#refresh', 'Reads this career from nfsu2.xyz again, for example after playing.'],
  ['#money', 'Type the money you want, from 0 to 999,999,999, then press Set.'],
  ['#setMoney', 'Writes the amount typed beside it. Undo puts the old amount back.'],
  ['#stage', 'The story stage to move to.'],
  ['#maxPerf', 'Level 3 performance parts on every car. Keeps your tuned setups.'],
  ['#uniques', 'Turns on every unique upgrade on every car.'],
  ['#uniqueBox > summary', 'Which unique upgrades each car has. Click to see the list.'],
  ['#careerCard details.why > summary', 'Why an edited career must stay offline.'],

  // Next unlocks
  ['#urlWins', 'Records the URL wins that unlock the carbon body kits. Shows what changes first.'],
  ['#urlWinsYes', 'Writes the wins listed above. Undo takes them back.'],
  ['#urlWinsNo', 'Closes this without writing anything.'],
  ['#storyLocksMore', 'Shows or hides the rest of the list.'],

  // History
  ['#restoreOriginal', 'Puts the career back as it was before the first edit made here.'],
  ['#undoConfirmYes', 'Goes ahead with the undo described above.'],
  ['#undoConfirmNo', 'Keeps the career as it is.'],

  // Backup
  ['#backupAll', 'Downloads one zip with every career and its GARAGE.DAT. nfsu2.xyz\'s own Saves backup can restore it too.'],
  ['#restoreLabel', 'Pick a backup zip. It shows what would change and asks before writing.'],
  ['#restoreYes', 'Writes the careers listed above from the backup.'],
  ['#restoreNo', 'Closes this without writing anything.'],
  ['#undoRestore', 'Puts back the careers as they were before the last restore.'],

  // Ends the career
  ['#unlockAll', 'Finishes the story and unlocks every car, part and track. Shows what changes and asks first.'],
  ['#unlockConfirmYes', 'Finishes the story now. Undo in History brings the career back.'],
  ['#unlockConfirmNo', 'Closes this without writing anything.'],

  // Game data
  ['#dbChange', 'Load a different copy of the game data.'],
  ['#dbFromSite', 'Uses the game data nfsu2.xyz already downloaded to this browser. Nothing leaves your computer.'],
  ['#dbCard label.file', 'Pick GLOBALB.BUN from your game folder, or GlobalB.lzc. Read here only, never uploaded.'],

  // Cars
  ['#cars .car > summary', 'Open or close this car.'],
  ['#cars .ctabs [data-tab="perf"]', 'Performance level, uniques and single parts per category.'],
  ['#cars .ctabs [data-tab="carbon"]', 'Carbon or plain, per part group.'],
  ['#cars .ctabs [data-tab="looks"]', 'Body parts, rims, paint, vinyls, decals and the rest.'],
  ['#cars .ctabs [data-tab="setups"]', 'Recommended tuning for each race type.'],
  ['#cars .perf-rows select', 'The performance package for this category. Level 3 is the best.'],
  ['#cars .perf-rows label.uniq', 'The unique upgrade for this category, on or off.'],
  ['#cars .parts-btn', 'Fit or remove single parts in this category and see what each does on the dyno.'],
  ['#cars .parts-level label', 'Tick to fit this part, untick to remove it. Apply writes all your changes at once.'],
  ['#cars .parts-actions .btn.ghost', 'Forget the part changes you have not applied.'],
  ['#cars .parts-actions .btn.primary', 'Writes the part changes in one edit. Undo puts them back.'],
  ['#cars .cpanel[data-tab="perf"] .grid .btn:first-child', 'Level 3 in every category and every unique on this car.'],
  ['#cars .cpanel[data-tab="perf"] .grid .btn:last-child', 'Every unique upgrade on this car, parts unchanged.'],
  ['#cars .seg button', 'Carbon or plain for this part group. Disabled when the fitted part has no carbon version.'],
  ['#cars .cpanel[data-tab="carbon"] .grid .btn:first-child', 'Every part group on this car to carbon where a carbon version exists.'],
  ['#cars .cpanel[data-tab="carbon"] .grid .btn:last-child', 'Every carbon part on this car back to plain.'],
  ['#cars .looks-tabs button', 'Show this group of parts.'],
  ['#cars .looks-rows select', 'Pick the part. It saves at once and Undo puts the old one back.'],
  ['#cars details.why > summary', 'Why it works this way.'],
  ['#cars .swap input[type="search"]', 'Type part of a make or model to filter the list.'],
  ['#cars .swap-row', 'The car to put in this slot.'],
  ['#cars .swap-opt', 'Choose what the new car starts with.'],
  ['#cars .swap .confirm .btn:not(.primary)', 'Closes this without writing anything.'],

  // Ready-made garage
  ['#garageList select', 'The slot this ready-made car goes in. Only that slot changes.'],
  ['#garageList .btn', 'Puts this finished car in the chosen slot. Undo brings the old car back.'],
  ['#garageReplace', 'Replaces every car with the ready-made ones. Shows each car you would lose and asks twice.'],
  ['#garageBackup', 'Downloads a backup zip before you replace anything.'],
  ['#garageCard label.agree', 'Tick to confirm, then Replace the garage turns on.'],
  ['#garageReplaceYes', 'Replaces the garage as listed above. Undo in History puts it back.'],
  ['#garageReplaceNo', 'Closes this without writing anything.'],

  // Music
  ['#musicTabs button', 'Switch soundtrack.'],
  ['#musicSeek', 'Drag to jump within the song.'],
  ['#musicPrev', 'Previous song.'],
  ['#musicToggle', 'Play or pause. The music keeps going while you edit.'],
  ['#musicNext', 'Next song.'],
  ['#musicList .song-btn', 'Play this song.'],
  ['#musicAll', 'Show every song of the soundtrack.'],
  ['#musicMissing', 'Show only the songs your music folder does not have.'],
  ['#musicScan', 'Pick your music folder to see which soundtrack songs you already have. Read here only.'],
  ['#musicForget', 'Forget the music folder check.'],
  ['#musicPlug', 'Opens spotivibly.com in a new tab.'],
  ['#miniToggle', 'Play or pause.'],
  ['#miniPrev', 'Previous song.'],
  ['#miniNext', 'Next song.'],

  // Player window and toolbar popup
  ['#winPrev, #popPrev', 'Previous song.'],
  ['#winToggle, #popToggle', 'Play or pause.'],
  ['#winNext, #popNext', 'Next song.'],
  ['#popShow', 'Brings the player window to the front.'],
  ['#popEditor', 'Opens the save editor in the side panel.'],

  // Toast
  ['#toastUndo', 'Undoes the edit just made.'],
  ['#reload', 'Reloads the nfsu2.xyz tab so the site shows the edited career.'],
  ['#dismiss', 'Hides this message.'],
];

// armed: the element whose tip is counting down or showing. shownFor: the one showing.
// by: 'pointer' or 'focus', what armed it. lastX, lastY: where the pointer last really moved.
let tip, timer = 0, armed = null, by = null, shownFor = null, pending = false, lastX = -1, lastY = -1;

function migrate(n) {
  if (n.tagName === 'IFRAME' || 'notip' in n.dataset) return;
  const t = n.getAttribute('title');
  if (t == null) return;
  n.removeAttribute('title');
  if (t) { n.dataset.tip = t; n.setAttribute('aria-description', t); }
  else delete n.dataset.tip;
  if (shownFor === n) t ? place(n) : hide();
}

function apply(root = document) {
  pending = false;
  for (const n of root.querySelectorAll('[title]')) migrate(n);
  for (const [sel, text] of TIPS) {
    for (const n of root.querySelectorAll(sel)) {
      if (n.dataset.tip || 'notip' in n.dataset) continue;
      n.dataset.tip = text;
      if (!n.hasAttribute('aria-description')) n.setAttribute('aria-description', text);
    }
  }
}

/** The element whose tip a pointer or focus on n should show: the nearest one with a tip. */
const owner = (n) => n?.closest?.('[data-tip]') ?? null;

function place(n) {
  tip.textContent = n.dataset.tip;
  tip.hidden = false;
  shownFor = n;
  const by = (n.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (!by.includes('tip')) n.setAttribute('aria-describedby', [...by, 'tip'].join(' '));
  const r = n.getBoundingClientRect(), t = tip.getBoundingClientRect(), gap = 6, pad = 8;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let top = r.top - t.height - gap;
  if (top < pad) top = Math.min(r.bottom + gap, vh - t.height - pad);
  const left = Math.max(pad, Math.min(r.left + r.width / 2 - t.width / 2, vw - t.width - pad));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function hide() {
  clearTimeout(timer);
  timer = 0;
  if (shownFor) {
    const rest = (shownFor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((x) => x && x !== 'tip');
    rest.length ? shownFor.setAttribute('aria-describedby', rest.join(' ')) : shownFor.removeAttribute('aria-describedby');
  }
  shownFor = null;
  armed = null;
  by = null;
  if (tip) tip.hidden = true;
}

function later(n, source) {
  clearTimeout(timer);
  armed = n;
  by = source;
  timer = setTimeout(() => { if (n.isConnected && n.dataset.tip) place(n); }, DELAY);
}

function init() {
  tip = document.createElement('div');
  tip.id = 'tip';
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  apply();

  new MutationObserver((records) => {
    for (const r of records) if (r.type === 'attributes' && r.target.nodeType === 1) migrate(r.target);
    if (!pending) { pending = true; queueMicrotask(() => apply()); }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  // Moving the pointer arms the tip of what it is over, so a tip cancelled by a scroll or a click starts again on the
  // next move. Disabled controls get pointer events in Chrome, so their tips (why they are off) show too.
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    // Chrome sends a move without movement after a scroll: only a real move counts, so a focus tip survives it.
    if (e.clientX === lastX && e.clientY === lastY) return;
    lastX = e.clientX;
    lastY = e.clientY;
    const n = owner(e.target);
    if (n === armed) return;
    hide();
    if (n) later(n, 'pointer');
  });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) hide(); });
  document.addEventListener('pointerdown', hide, true);
  // A scroll moves the control away from the pointer, so a pointer tip ends. A focus tip follows its control.
  document.addEventListener('scroll', () => {
    if (by !== 'focus') return hide();
    if (shownFor) place(shownFor);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  document.addEventListener('focusin', (e) => {
    const n = owner(e.target);
    hide();
    if (n && e.target.matches(':focus-visible')) later(n, 'focus');
  });
  document.addEventListener('focusout', hide);
}

if (typeof document !== 'undefined' && document.body) init();
