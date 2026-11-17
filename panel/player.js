// The small player window. The worker opens it when the editor panel closes mid-song, with the soundtrack, song and
// time to resume from in session storage. It plays the same Spotivibly frame as the panel, at the 200 px minimum
// YouTube asks of an embedded player, and takes commands from the panel, the toolbar popup and the media keys.
import * as music from '../src/music.js';
import { NOW, readCommand, stateWriter, fmt, ICON, isPlaying } from './now-playing.js';

const $ = (id) => document.getElementById(id);
const ORIGIN = new URL(music.SPOTIVIBLY_EMBED).origin;
const write = stateWriter('window', 'window');

let set = null, map = [], tracks = [], ready = false, resume = null;
let state = { index: 0, status: 'idle', started: false, time: 0, duration: 0, failed: [], unavailable: false };

const send = (action, extra = {}) => $('winPlayer').contentWindow?.postMessage({ type: 'spotivibly:command', action, ...extra }, ORIGIN);
const song = () => { const k = map.indexOf(state.index); return k >= 0 ? k : 0; };

function paint() {
  const k = song(), t = tracks[k] ?? { title: ready ? '' : 'Loading the songs…', artist: '' };
  const playing = isPlaying(state);
  $('winTitle').textContent = t.title;
  $('winArtist').textContent = t.artist;
  $('winTime').textContent = state.duration > 0 ? `${fmt(Math.min(state.time, state.duration))} / ${fmt(state.duration)}` : fmt(0);
  for (const id of ['winPrev', 'winToggle', 'winNext']) $(id).disabled = !ready || state.unavailable;
  $('winToggle').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('winToggle').querySelector('path').setAttribute('d', playing ? ICON.pause : ICON.play);
  document.title = t.title ? `${t.title} · EA Trax player` : 'EA Trax player';
  if (state.unavailable) $('winNote').textContent = 'The YouTube player could not load. Close this window and play from the editor.';
  if (ready) write({ set: set.key, song: k, title: t.title, artist: t.artist, status: state.status, started: state.started, time: state.time, duration: state.duration });
}

function act(cmd) {
  if (!ready) return;
  if (cmd.action === 'load') { const at = map[cmd.song]; if (at >= 0) send('load', { index: at }); return; }
  send(cmd.action, cmd.action === 'seek' ? { seconds: cmd.seconds } : {});
}

addEventListener('message', (e) => {
  if (e.source !== $('winPlayer').contentWindow || e.origin !== ORIGIN) return;
  const m = music.readPlayerMessage(e.data);
  if (!m) return;
  if (m.type === 'ready') {
    if (ready) return;
    ready = true;
    if (set.tracks) { map = music.mapTracks(m.tracks); tracks = set.tracks; }
    else { tracks = m.tracks.map((t) => ({ artist: t.artist, title: t.name })); map = tracks.map((_, i) => i); }
    const at = map[resume.song];
    send('load', { index: at >= 0 ? at : 0 });
  } else {
    state = m;
    // Seek once, when the resumed song has started and knows its length.
    if (resume?.time > 1 && m.started && m.duration > resume.time && m.index === map[resume.song]) { send('seek', { seconds: Math.floor(resume.time) }); resume.time = 0; }
  }
  paint();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const cmd = readCommand(msg, sender);
  if (cmd) act(cmd);
  return false;
});

$('winPrev').addEventListener('click', () => act({ action: 'prev' }));
$('winToggle').addEventListener('click', () => act({ action: 'toggle' }));
$('winNext').addEventListener('click', () => act({ action: 'next' }));

async function start() {
  const got = await chrome.storage.session.get('musicHandoff');
  const h = got.musicHandoff ?? {};
  set = music.SOUNDTRACKS.find((t) => t.key === h.set && t.embed) ?? music.SOUNDTRACKS[0];
  resume = { song: Number.isInteger(h.song) && h.song >= 0 ? h.song : 0, time: Number(h.time) || 0 };
  $('winPlayer').title = `${set.label} EA Trax video, played from YouTube by Spotivibly`;
  $('winPlayer').addEventListener('load', () => {
    // The player listens only once its playlist loads: ask for the ready event until it answers.
    let tries = 0;
    const id = setInterval(() => {
      if (ready || ++tries > 60) { clearInterval(id); if (!ready) $('winNote').textContent = 'The player did not answer. Close this window and play from the editor.'; return; }
      send('hello');
    }, 500);
    send('hello');
  }, { once: true });
  $('winPlayer').src = set.embed;
  paint();
}

start().catch((err) => { $('winNote').textContent = `Could not start the player: ${err.message}`; });
// Stop the clock from claiming this window plays after it is gone. The worker also clears it when the window closes.
addEventListener('pagehide', () => { chrome.storage.session.get(NOW).then((g) => { if (g[NOW]?.where === 'window') chrome.storage.session.remove(NOW); }).catch(() => {}); });
