// The Music card. It reads a folder the player picks on this device, never sends a byte anywhere, and
// shows which EA Trax songs nfsu2.xyz's Radio will find there and which files need a rename. Its song list is also
// the playlist: a row plays that song in the framed Spotivibly player (full tracks from YouTube), whose video is all
// it shows, under the panel's own controls. Generate in Spotivibly opens the generator with the tracklist filled in.
import * as music from '../src/music.js';
import { NOW, readCommand, sendCommand, stateWriter, fmt, ICON, isPlaying } from './now-playing.js';

const $ = (id) => document.getElementById(id);
const SAVED = 'musicScan';
const PICKED = 'musicSet';
// The soundtrack on screen. NFSU2 carries its own song list and folder check; any other list comes from its player.
let set = music.SOUNDTRACKS[0];
let playerTracks = null;
let lastSaved = null;
const songs = () => set.tracks ?? playerTracks ?? [];
const HEAD_BYTES = 1 << 20;

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

/** Every audio file under a picked folder, the way the Radio walks it: 8 levels deep, 2000 folders at most. */
async function walk(dir) {
  const files = [], zips = [];
  let dirs = 0;
  const visit = async (handle, prefix, depth) => {
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && music.AUDIO_RE.test(entry.name)) {
        files.push({ path: prefix + entry.name, head: async () => new Uint8Array(await (await entry.getFile()).slice(0, HEAD_BYTES).arrayBuffer()) });
      } else if (entry.kind === 'file' && music.ZIP_RE.test(entry.name)) {
        zips.push(prefix + entry.name);
      } else if (entry.kind === 'directory' && depth < music.MAX_DEPTH && ++dirs <= music.MAX_DIRS) {
        await visit(entry, `${prefix}${entry.name}/`, depth + 1);
      }
    }
  };
  await visit(dir, '', 0);
  return { name: dir.name, files, zips };
}

/** The same list from a folder input, for browsers without the folder picker. Paths drop the folder's own name. */
function fromInput(list) {
  const files = [], zips = [];
  let name = '';
  for (const f of list) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    name ||= parts.length > 1 ? parts[0] : '';
    const path = parts.length > 1 ? parts.slice(1).join('/') : f.name;
    if (music.AUDIO_RE.test(f.name)) files.push({ path, head: async () => new Uint8Array(await f.slice(0, HEAD_BYTES).arrayBuffer()) });
    else if (music.ZIP_RE.test(f.name)) zips.push(path);
  }
  return { name, files, zips };
}

async function scan(picked) {
  const btn = $('musicScan');
  btn.disabled = true;
  $('musicState').textContent = `Reading ${picked.files.length} audio files in ${picked.name || 'the folder'}…`;
  try {
    const res = await music.scanFiles(picked.files);
    const saved = {
      folder: picked.name, when: Date.now(), files: picked.files.length, scanned: res.scanned, zips: picked.zips.length,
      found: res.found, rows: res.rows.filter((r) => r.why !== 'match'),
    };
    await chrome.storage.local.set({ [SAVED]: saved });
    render(saved);
  } catch (err) {
    $('musicState').textContent = `Could not read the folder: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

const STATUS_TEXT = { found: 'In folder', rename: 'Rename file', missing: 'Missing', '': '' };

/** I11: All or Missing only. Missing only hides the songs already in the folder. */
let filter = 'all';
function paintFilter() {
  const list = $('musicList'), on = filter === 'missing';
  if (on) list.dataset.filter = 'missing'; else delete list.dataset.filter;
  $('musicAll').setAttribute('aria-pressed', String(!on));
  $('musicMissing').setAttribute('aria-pressed', String(on));
  const left = Array.from(list.children).some((li) => li.dataset.st && li.dataset.st !== 'found');
  $('musicNoneMissing').hidden = !(on && !left);
}

function render(saved) {
  lastSaved = saved;
  const list = songs(), total = music.EA_TRAX.length;
  const folder = set.folder;
  // The folder check, its result and Forget belong to NFSU2 only: the site's Radio plays no other soundtrack.
  for (const id of ['musicRadioNote', 'musicScan', 'musicState']) $(id).hidden = !folder;
  $('musicNoFolder').hidden = folder;
  // A soundtrack whose playlist does not exist yet shows that, in place of the player and its empty song list.
  const soon = !set.embed;
  $('musicSoon').hidden = !soon;
  $('music').querySelector('.mp').hidden = soon;
  $('music').querySelector('.songs-head').hidden = soon;
  if (!folder) saved = null;
  const found = saved?.found ?? list.map(() => null);
  const n = found.filter(Boolean).length;
  const status = folder ? music.songStatuses(saved) : list.map(() => '');
  $('musicState').textContent = saved
    ? `${saved.folder || 'Your folder'}: ${saved.files} audio files${saved.files > 500 ? `, ${saved.scanned} opened` : ''}. Checked ${new Date(saved.when).toLocaleString()}.`
    : 'No folder checked yet. Check one to see which songs the Radio will find.';
  $('musicState').dataset.state = saved ? (n === total ? 'ok' : n ? 'part' : 'none') : '';
  $('musicChip').hidden = !saved;
  // U11: Forget shows only when there is a folder check to forget.
  $('musicForget').hidden = !saved || !folder;
  $('musicChip').textContent = saved ? `${n} of ${total} in your folder` : '';
  $('musicZips').hidden = !saved?.zips;
  $('musicZips').textContent = saved?.zips ? `${saved.zips} zip file${saved.zips === 1 ? '' : 's'} not opened here. The Radio plays songs inside zips, so a song in a zip can count there even if it shows missing here.` : '';

  $('musicList').setAttribute('aria-label', `${set.label} EA Trax songs: pick one to play it`);
  $('musicList').replaceChildren(...list.map((song, i) => {
    const hit = found[i];
    const li = el('li', { className: 'song' });
    li.dataset.have = hit ? 'true' : 'false';
    li.dataset.st = status[i];
    li.dataset.i = String(i);
    const btn = el('button', { type: 'button', className: 'song-btn', title: hit ? `In your folder: ${hit.path}` : '' },
      el('span', { className: 'song-n', textContent: String(i + 1) }),
      el('span', { className: 'song-dot', ariaHidden: 'true' }),
      el('span', { className: 'song-t' }, el('b', { textContent: song.title }), el('span', { textContent: song.artist })),
      el('span', { className: 'song-st', textContent: STATUS_TEXT[status[i]] }),
    );
    btn.setAttribute('aria-label', `Play ${song.title} by ${song.artist}${status[i] ? `, ${STATUS_TEXT[status[i]].toLowerCase()}` : ''}`);
    li.append(btn);
    return li;
  }));
  // I11: Missing only appears once a folder check exists for the soundtrack the Radio plays.
  $('musicFilter').hidden = !(saved && folder) || soon;
  if ($('musicFilter').hidden) filter = 'all';
  paintFilter();
  player.paint();
  paintGenerate();

  const fixes = (saved?.rows ?? []).filter((r) => r.why !== 'match');
  $('musicFixes').hidden = !fixes.length;
  $('musicFixList').replaceChildren(...fixes.map((r) => el('li', {}, el('code', { textContent: r.path }), el('span', { textContent: music.explain(r) }))));
}

// ---- The player ------------------------------------------------------------------------------------
// Spotivibly's frame shows only the YouTube video. The panel draws the song, seek bar and buttons, sends commands
// with postMessage to the player's origin only, and takes state back only from that frame and that origin.

const PLAYER_ORIGIN = new URL(music.SPOTIVIBLY_EMBED).origin;
const IDLE = { index: 0, status: 'idle', started: false, time: 0, duration: 0, failed: [], unavailable: false };
// This panel's id in the shared state: the worker moves the music to the player window only for the panel that played it.
const OWNER = crypto.randomUUID();
const write = stateWriter('panel', OWNER);

const player = {
  ready: false,
  map: music.EA_TRAX.map((_, i) => i), // list index -> player track index
  state: { ...IDLE },
  seeking: false,

  send(action, extra = {}) {
    const win = $('musicPlayer').contentWindow;
    if (win) win.postMessage({ type: 'spotivibly:command', action, ...extra }, PLAYER_ORIGIN);
  },

  /** The EA song the player is on. */
  song() {
    // Before any song starts, the card shows the list's first row, which Play starts (command()).
    const k = this.state.started ? this.map.indexOf(this.state.index) : -1;
    return k >= 0 ? k : 0;
  },

  onMessage(e) {
    if (e.source !== $('musicPlayer').contentWindow || e.origin !== PLAYER_ORIGIN) return;
    const m = music.readPlayerMessage(e.data);
    if (!m) return;
    if (m.type === 'ready') {
      this.ready = true;
      if (set.tracks) this.map = music.mapTracks(m.tracks);
      else {
        // A soundtrack without its own list shows the player's songs, sorted into the game's order when it has one.
        this.map = set.order ? music.orderByGame(m.tracks, set.order) : m.tracks.map((_, i) => i);
        playerTracks = this.map.map((i) => ({ artist: m.tracks[i].artist, title: m.tracks[i].name }));
        render(lastSaved);
      }
    } else {
      this.state = m;
      if (m.started && !this.remote) {
        const k = this.song(), song = songs()[k] ?? {};
        write({ set: set.key, song: k, title: song.title ?? '', artist: song.artist ?? '', status: m.status, started: m.started, time: m.time, duration: m.duration });
      }
    }
    this.paint();
  },

  /** The player window's state while it owns the music, else null. The panel then drives the window, not its frame. */
  remote: null,
  /** The shared state as last read, whoever owns it. */
  now: null,

  /** A command from a button here: to the window while it plays, else to this panel's frame. */
  command(action, extra = {}) {
    if (this.remote) { sendCommand(action, extra); return; }
    if (action === 'load') { const at = this.map[extra.song]; if (at >= 0) this.send('load', { index: at }); return; }
    // Nothing started yet: Play starts the list's first row, which the card shows, not the player's first track.
    if (action === 'toggle' && !this.state.started && this.map[0] >= 0) { this.send('load', { index: this.map[0] }); return; }
    this.send(action, action === 'seek' ? { seconds: extra.seconds } : {});
  },

  paint() {
    const r = this.remote && this.remote.set === set.key ? this.remote : null;
    const s = r ? { ...IDLE, ...r } : this.state, k = r ? r.song : this.song(), list = songs(), song = list[k] ?? { title: 'Loading the songs…', artist: '' };
    const playing = isPlaying(s);
    const live = r ? true : this.ready && !this.remote;
    $('musicTitle').textContent = song.title;
    $('musicArtist').textContent = song.artist;
    $('musicCount').textContent = list.length ? `${k + 1} of ${list.length}` : '';
    for (const id of ['musicPrev', 'musicToggle', 'musicNext']) $(id).disabled = !live || s.unavailable;
    for (const t of [$('musicToggle'), $('miniToggle')]) {
      t.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      t.querySelector('path').setAttribute('d', playing ? ICON.pause : ICON.play);
    }
    $('miniTitle').textContent = song.title;
    $('miniArtist').textContent = song.artist;
    for (const id of ['miniPrev', 'miniToggle', 'miniNext']) $(id).disabled = !live || s.unavailable;
    this.paintMini();
    const known = s.duration > 0;
    const seek = $('musicSeek');
    seek.disabled = !live || !known;
    seek.max = String(known ? Math.floor(s.duration) : 0);
    if (!this.seeking) {
      seek.value = String(Math.floor(Math.min(s.time, s.duration)));
      $('musicTime').textContent = fmt(known ? Math.min(s.time, s.duration) : 0);
    }
    seek.setAttribute('aria-valuetext', `${$('musicTime').textContent} of ${known ? fmt(s.duration) : 'unknown'}`);
    $('musicDur').textContent = known ? fmt(s.duration) : '--:--';
    $('musicPlayerNote').textContent = this.remote
      ? (r ? 'Playing in the player window. These controls drive it, and closing that window stops the music.'
        : `The player window is playing ${music.SOUNDTRACKS.find((t) => t.key === this.remote.set)?.label ?? 'another soundtrack'}. Close it to play here.`)
      : s.unavailable
        ? 'The YouTube player could not load. Check your connection and reopen the panel.'
        : this.ready ? 'Player: Spotivibly, full tracks from YouTube.' : 'Loading the player…';
    for (const li of $('musicList').children) {
      const i = Number(li.dataset.i), on = s.started && i === k;
      const failed = !r && (s.failed.includes(this.map[i]) || this.map[i] < 0);
      li.setAttribute('aria-current', on ? 'true' : 'false');
      li.querySelector('.song-btn').disabled = !live || failed;
      const st = li.querySelector('.song-st');
      st.textContent = failed ? 'Unavailable' : on ? (playing ? 'Playing' : 'Paused') : STATUS_TEXT[li.dataset.st];
    }
  },

  /** I11: the compact player shows while a song has started and the full player is scrolled out of view. */
  playerInView: true,
  /** The player frame loads only once the Music card is near the view (or at once without IntersectionObserver). */
  armed: false,
  paintMini() {
    const mp = $('music').querySelector('.mp');
    const started = this.remote ? this.remote.set === set.key && this.remote.started : this.state.started;
    $('musicMini').hidden = this.playerInView || !started || mp.hidden || !set.embed;
  },

  /** Points the frame at the current soundtrack's player and forgets the last one's state. */
  load() {
    this.ready = false;
    this.state = { ...IDLE };
    // The frame's song stops here: if it was this panel's, nothing plays any more, and closing must open no window.
    if (this.now?.where === 'panel' && this.now.owner === OWNER) chrome.storage.session.remove(NOW).catch(() => {});
    this.map = songs().map((_, i) => i);
    $('musicPlayer').title = `${set.label} EA Trax video, played from YouTube by Spotivibly`;
    // No playlist yet: blank the frame, which also stops the other soundtrack's video. Until the Music card nears the
    // view the frame stays blank, so the third-party player is not loaded for people who never scroll to it.
    $('musicPlayer').src = this.armed ? set.embed ?? 'about:blank' : 'about:blank';
  },

  /** Ask for the ready event until the player answers: its listener exists only once the playlist has loaded. */
  hello() {
    let tries = 0;
    const src = $('musicPlayer').src;
    const id = setInterval(() => {
      if (this.ready || ++tries > 60 || $('musicPlayer').src !== src) { clearInterval(id); if (!this.ready) $('musicPlayerNote').textContent = 'The player did not answer. Reopen the panel to try again.'; return; }
      this.send('hello');
    }, 500);
    this.send('hello');
  },

  init() {
    addEventListener('message', (e) => this.onMessage(e));
    $('musicPlayer').addEventListener('load', () => { this.ready = false; if (set.embed && this.armed) this.hello(); });
    if (typeof IntersectionObserver !== 'function') this.armed = true;
    this.load();
    for (const [id, action] of [['musicToggle', 'toggle'], ['musicPrev', 'prev'], ['musicNext', 'next'], ['miniToggle', 'toggle'], ['miniPrev', 'prev'], ['miniNext', 'next']]) {
      $(id).addEventListener('click', () => this.command(action));
    }
    // Media keys and the popup: act only while this panel's own frame has the music.
    chrome.runtime.onMessage.addListener((msg, sender) => {
      const cmd = readCommand(msg, sender);
      // Only the panel that has the music acts, so a second open panel never starts a second sound.
      if (cmd && !this.remote && this.ready && this.now?.owner === OWNER) this.command(cmd.action, cmd);
      return false;
    });
    this.connect();
    chrome.storage.session.get(NOW).then((g) => this.follow(g[NOW]), () => {});
    chrome.storage.session.onChanged.addListener((ch) => { if (ch[NOW]) this.follow(ch[NOW].newValue); });
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver((entries) => {
        for (const e of entries) this.playerInView = e.isIntersecting;
        this.paintMini();
      }).observe($('music').querySelector('.mp'));
      const arm = new IntersectionObserver((entries) => {
        if (this.armed || !entries.some((e) => e.isIntersecting)) return;
        this.armed = true;
        arm.disconnect();
        this.load();
      }, { rootMargin: '600px 0px' });
      arm.observe($('music'));
    }
    const seek = $('musicSeek');
    seek.addEventListener('input', () => { this.seeking = true; $('musicTime').textContent = fmt(Number(seek.value)); });
    seek.addEventListener('change', () => { this.command('seek', { seconds: Number(seek.value) }); this.seeking = false; });
    $('musicList').addEventListener('click', (e) => {
      const li = e.target.closest('.song');
      if (!li || !(this.remote || this.ready)) return;
      this.command('load', { song: Number(li.dataset.i) });
    });
    this.paint();
  },

  /** Holds a port to the worker while the panel is open. A worker that slept drops it: connect again. */
  connect() {
    try {
      chrome.runtime.connect({ name: `panel:${OWNER}` }).onDisconnect.addListener(() => setTimeout(() => this.connect(), 100));
    } catch { /* the extension was reloaded: this panel went with it */ }
  },

  /** Follows the shared state: while the player window owns the music, this panel is its remote. */
  follow(s) {
    const was = !!this.remote;
    this.now = s ?? null;
    this.remote = s?.where === 'window' ? s : null;
    // The window took over while this frame still played: pause it, one sound at a time.
    if (this.remote && !was && isPlaying(this.state)) this.send('toggle');
    this.paint();
  },
};

async function pick() {
  if (typeof window.showDirectoryPicker === 'function') {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'nfsu2-music', mode: 'read' }); }
    catch (err) { if (err?.name === 'AbortError') return; throw err; }
    await scan(await walk(dir));
  } else {
    $('musicInput').click();
  }
}

/** Generate in Spotivibly opens the generator with the selected soundtrack's songs, once that list is known. */
function generateUrl() {
  if (set.tracks === music.EA_TRAX) return music.SPOTIVIBLY_GENERATE;
  return music.generateFor(set.game, songs());
}

function paintGenerate() {
  const n = songs().length;
  $('musicGenerate').title = n ? `Opens Spotivibly with the ${n}-song ${set.label} tracklist filled in` : `Opens Spotivibly asking for the ${set.label} EA Trax soundtrack`;
}

function paintTabs() {
  for (const b of $('musicTabs').children) {
    const on = b.dataset.set === set.key;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

/** Switches the card to a soundtrack: list, player, folder check and Generate all follow it. */
function choose(key, { focus = false } = {}) {
  const next = music.SOUNDTRACKS.find((t) => t.key === key);
  if (!next) return;
  if (next !== set) {
    set = next;
    playerTracks = null;
    player.load();
    render(lastSaved);
    chrome.storage.local.set({ [PICKED]: key }).catch(() => {});
  }
  paintTabs();
  if (focus) $('musicTabs').querySelector(`[data-set="${key}"]`)?.focus();
}

function initTabs() {
  const tabs = $('musicTabs');
  tabs.hidden = music.SOUNDTRACKS.length < 2;
  tabs.replaceChildren(...music.SOUNDTRACKS.map((t) => {
    const b = el('button', { type: 'button', id: `musicTab-${t.key}`, textContent: t.label });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'musicList');
    b.dataset.set = t.key;
    return b;
  }));
  tabs.addEventListener('click', (e) => { const b = e.target.closest('[role="tab"]'); if (b) choose(b.dataset.set); });
  tabs.addEventListener('keydown', (e) => {
    const keys = music.SOUNDTRACKS.map((t) => t.key), at = keys.indexOf(set.key);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: keys.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    choose(keys[(to + keys.length) % keys.length], { focus: true });
  });
  paintTabs();
}

function init() {
  initTabs();
  player.init();
  $('musicPlug').href = music.SPOTIVIBLY_HOME;
  $('musicGenerate').addEventListener('click', () => { const url = generateUrl(); if (url) chrome.tabs.create({ url }); });
  $('musicScan').addEventListener('click', () => pick().catch((err) => { $('musicState').textContent = `Could not open the folder: ${err.message}`; }));
  $('musicInput').addEventListener('change', async (e) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (list.length) await scan(fromInput(list));
  });
  $('musicForget').addEventListener('click', async () => { await chrome.storage.local.remove(SAVED); render(null); });
  $('musicAll').addEventListener('click', () => { filter = 'all'; paintFilter(); });
  $('musicMissing').addEventListener('click', () => { filter = 'missing'; paintFilter(); });
  chrome.storage.local.get([SAVED, PICKED]).then((r) => {
    if (r[PICKED] && r[PICKED] !== set.key) choose(r[PICKED]);
    const saved = music.readScan(r[SAVED]);
    render(saved);
    if (r[SAVED] != null && !saved) { $('musicState').textContent = 'The last folder check could not be read. Check the folder again.'; $('musicForget').hidden = false; }
  }, () => render(null));
}

init();
