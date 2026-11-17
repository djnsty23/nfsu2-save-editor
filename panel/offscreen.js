// The offscreen player: background.js opens this page when the side panel closes with a song playing. It plays that
// song from the second the panel left it, and reports where it is, so the next panel can take it back.
import { SOUNDTRACKS, SPOTIVIBLY_EMBED, readPlayerMessage } from '../src/music.js';

const ORIGIN = new URL(SPOTIVIBLY_EMBED).origin;
const q = new URLSearchParams(location.search);
const set = SOUNDTRACKS.find((s) => s.key === q.get('key') && s.embed);
const index = Number(q.get('index'));
const from = Number(q.get('time'));
const frame = document.getElementById('player');
const send = (action, extra = {}) => frame.contentWindow?.postMessage({ type: 'spotivibly:command', action, ...extra }, ORIGIN);

if (set && Number.isInteger(index) && index >= 0) {
  let ready = false;
  let seeked = !(from >= 1);
  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== ORIGIN) return;
    const m = readPlayerMessage(e.data);
    if (!m) return;
    if (m.type === 'ready') {
      if (!ready) { ready = true; send('load', { index }); }
      return;
    }
    // Seek once the song plays and its length is known, never past its end.
    if (!seeked && m.index === index && m.status === 'playing' && m.duration > 0) {
      seeked = true;
      if (from < m.duration - 2) send('seek', { seconds: Math.floor(from) });
    }
    chrome.runtime.sendMessage({ type: 'musicOff', key: set.key, index: m.index, time: m.time, status: m.status }).catch(() => {});
  });
  frame.src = set.embed;
  let tries = 0;
  const hello = setInterval(() => { if (ready || ++tries > 60) clearInterval(hello); else send('hello'); }, 500);
}
