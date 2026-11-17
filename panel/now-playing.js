// What is playing, shared by the panel, the player window and the toolbar popup.
//
// One page owns the sound at a time: the panel while it is open, else the player window the worker opens when the
// panel closes mid-song (YouTube allows no hidden player, so the video stays visible there). The owner writes its
// state to chrome.storage.session under NOW. Every other page reads it from there and sends commands as runtime
// messages, which only the owner acts on. Session storage is closed to content scripts, and every page checks that a
// command comes from this extension's own pages or worker, never from nfsu2.xyz.

export const NOW = 'nowPlaying';
export const CMD = 'music:cmd';
export const ACTIONS = ['toggle', 'prev', 'next', 'seek', 'load'];

const OWN = [chrome.runtime.getURL('panel/'), chrome.runtime.getURL('background.js')];

/** A music command from this extension's own pages or worker, or null. */
export function readCommand(msg, sender) {
  if (sender?.id !== chrome.runtime.id || !OWN.some((u) => sender.url?.startsWith(u))) return null;
  if (msg?.type !== CMD || !ACTIONS.includes(msg.action)) return null;
  const out = { action: msg.action };
  if (msg.action === 'seek') { const s = Number(msg.seconds); if (!Number.isFinite(s) || s < 0) return null; out.seconds = s; }
  if (msg.action === 'load') { const k = Number(msg.song); if (!Number.isInteger(k) || k < 0) return null; out.song = k; }
  return out;
}

/** Sends a command to whichever page owns the sound. Nobody listening is not an error. */
export function sendCommand(action, extra = {}) {
  return chrome.runtime.sendMessage({ type: CMD, action, ...extra }).catch(() => {});
}

export const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const ICON = { play: 'M7 4v16l13-8z', pause: 'M6 4h4v16H6zM14 4h4v16h-4z' };
export const isPlaying = (s) => s?.status === 'playing' || s?.status === 'buffering';

/**
 * Writes the owner's state. Song changes, play or pause and seeks go out at once, the clock about once a second, so a
 * handover to the window resumes within a second of where the panel stopped.
 */
export function stateWriter(where, owner) {
  let last = null, at = 0;
  return (s) => {
    const now = Date.now();
    const changed = !last || last.song !== s.song || last.status !== s.status || last.set !== s.set || last.started !== s.started
      || Math.abs(s.time - last.time - (now - at) / 1000) > 2; // a seek
    if (!changed && now - at < 1000) return;
    last = s;
    at = now;
    chrome.storage.session.set({ [NOW]: { ...s, where, owner, at: now } }).catch(() => {});
  };
}
