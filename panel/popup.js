// The toolbar popup, shown while the player window is open: the song, its progress, Prev, Play or Pause, Next, a
// button that brings the player window forward and one that opens the editor panel.
import { NOW, sendCommand, fmt, ICON, isPlaying } from './now-playing.js';

const $ = (id) => document.getElementById(id);
let windowId = null;

function paint(s) {
  const on = !!s?.started;
  $('popPlaying').hidden = !on;
  $('popIdle').hidden = on;
  if (!on) return;
  const known = s.duration > 0, t = known ? Math.min(s.time, s.duration) : 0;
  $('popTitle').textContent = s.title ?? '';
  $('popArtist').textContent = s.artist ?? '';
  $('popTime').textContent = fmt(t);
  $('popDur').textContent = known ? fmt(s.duration) : '--:--';
  const pct = known ? Math.round((t / s.duration) * 100) : 0;
  $('popBar').style.width = `${pct}%`;
  $('popBar').parentElement.setAttribute('aria-valuenow', String(pct));
  const playing = isPlaying(s);
  $('popToggle').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('popToggle').querySelector('path').setAttribute('d', playing ? ICON.pause : ICON.play);
}

$('popPrev').addEventListener('click', () => sendCommand('prev'));
$('popToggle').addEventListener('click', () => sendCommand('toggle'));
$('popNext').addEventListener('click', () => sendCommand('next'));
// sidePanel.open needs the click's user gesture, so the window id is fetched beforehand and the call is not awaited first.
chrome.windows.getCurrent().then((w) => { windowId = w.id; }).catch(() => {});
$('popEditor').addEventListener('click', () => {
  if (windowId == null) return;
  chrome.sidePanel.open({ windowId }).then(() => window.close(), () => {});
});
$('popShow').addEventListener('click', async () => {
  const { musicWindow } = await chrome.storage.session.get('musicWindow');
  if (musicWindow) await chrome.windows.update(musicWindow, { focused: true }).catch(() => {});
  window.close();
});

chrome.storage.session.get([NOW, 'musicWindow']).then((g) => { $('popShow').hidden = !g.musicWindow; paint(g[NOW]); }, () => paint(null));
chrome.storage.session.onChanged.addListener((ch) => {
  if (ch[NOW]) paint(ch[NOW].newValue);
  if (ch.musicWindow) $('popShow').hidden = !ch.musicWindow.newValue;
});
