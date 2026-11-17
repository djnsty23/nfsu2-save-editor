// The Music card: which of the game's EA Trax songs a folder of the player's own files holds, predicted
// with the rules nfsu2.xyz's Radio uses to match them, so the player knows before picking the folder there.
// Everything here runs on files the player chose on this device. Nothing is downloaded or uploaded.
//
// The Radio's rules, read from the site's own script on 2026-11-12 and checked against it with test files:
// - audio files: .mp3 .ogg .oga .opus .wav .flac .m4a .aac .webm .weba .mp4 (and inside .zip files);
// - tags: only ID3v2.3 and ID3v2.4 (TIT2 title, TPE1 artist) in the first 1 MiB; every other file uses its name,
//   "Artist - Title.ext" or just "Title.ext", with a leading track number dropped;
// - a song matches when a cleaned title equals the song's title AND the song's main artist appears as whole
//   words in the tag artist or anywhere in the file's path below the chosen folder;
// - covers, karaoke, instrumentals and tributes never match; the first file in folder order wins;
// - with more than 500 files, only files whose path mentions a song title or artist are opened for tags.

/** The 27 EA Trax songs, in the game's order. */
export const EA_TRAX = Object.freeze([
  ['Snoop Dogg feat. The Doors', 'Riders on the Storm (Fredwreck Remix)'],
  ['Capone', 'I Need Speed'],
  ['Chingy', 'I Do'],
  ['Sly Boogy', "That'z My Name"],
  ['Xzibit', 'LAX'],
  ['Terror Squad', 'Lean Back'],
  ['Fluke', 'Switch/Twitch'],
  ['Christopher Lawrence', 'Rush Hour'],
  ['Felix Da Housecat', 'Rocket Ride (Soulwax Remix)'],
  ['Sin', 'Hard EBM'],
  ['FREELAND', 'Mind Killer (Jagz Kooner Remix)'],
  ['Paul Van Dyk', 'Nothing But You (Cirrus Remix)'],
  ['Sonic Animation', 'E-Ville'],
  ['Killing Joke', 'The Death & Resurrection Show'],
  ['Rise Against', 'Give it All'],
  ['Killradio', 'Scavenger'],
  ['The Bronx', 'Notice of Eviction'],
  ['Ministry', 'No W'],
  ['Queens of the Stone Age', 'In My Head'],
  ['Mudvayne', 'Determined'],
  ['Septembre', 'I Am Weightless'],
  ['Helmet', 'Crashing Foreign Cars'],
  ['Cirrus', 'Back on a Mission'],
  ['SpiderBait', 'Black Betty'],
  ['Skindred', 'Nobody'],
  ['Snapcase', 'Skeptic'],
  ['Unwritten Law', 'The Celebration Song'],
].map(([artist, title]) => Object.freeze({ artist, title })));

export const AUDIO_RE = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm|weba|mp4)$/i;
export const ZIP_RE = /\.zip$/i;
export const MAX_DEPTH = 8;
export const MAX_DIRS = 2000;
const MANY_FILES = 500;
const TAG_BYTES = 1 << 20;

// ---- text cleaning -------------------------------------------------------------------------------

/** Lower case, accents and apostrophes gone, "&" read as "and", every other symbol a single space. */
export function clean(s) {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’‘`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const BRACKETS = /\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/g;
const FEAT = /\s(?:feat\.?|ft\.?|featuring)\s.*$/i;
const VERSION_SUFFIX = /\s[-–—]\s.*\b(?:remix|mix|version|edit|remaster|remastered|explicit|clean|radio|single|album|original|extended|bonus|mono|stereo|redux)\b.*$/i;
const REDUX = /\s+redux\s*$/i;
const NOT_THE_SONG = /\b(?:karaoke|instrumental|acapella|a cappella|tribute|cover|originally performed|made famous|in the style of|8 bit|lullaby)\b/;
const stripVersion = (s) => s.replace(FEAT, '').replace(VERSION_SUFFIX, '').replace(REDUX, '');
const titleKey = (s) => clean(stripVersion(s.replace(BRACKETS, ' ')));
const titleKeyKeepBrackets = (s) => clean(stripVersion(s));
const squash = (s) => s.replace(/ /g, '');
/** The first named artist: "Snoop Dogg feat. The Doors" is "snoop dogg"; a leading "the" is dropped. */
const mainArtist = (s) => clean(s.split(/\s(?:feat\.?|ft\.?|featuring|vs\.?|x|with|and|&)\s|,|;|\//i)[0]).replace(/^the /, '');
const hasWords = (hay, words) => !!words && ` ${hay} `.includes(` ${words} `);
const SONG_KEYS = EA_TRAX.map((s) => ({ title: titleKey(s.title), joined: squash(titleKey(s.title)), artist: mainArtist(s.artist) }));

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
const dropTrackNo = (s) => s.replace(/^\s*(?:\d{1,2}[-.])?\d{1,3}(?:\s*[-._)]\s*|\s+|_+)(?=\S)/, '');
const afterLastDash = (s) => s.split(/\s[-–—]\s/).pop();

/** What the file's name says when it has no tags the Radio reads: "Artist - Title", or the whole name as title. */
export function tagsFromName(name) {
  const stem = name.replace(/\.[^.]+$/, '');
  const at = stem.indexOf(' - ');
  return at > 0 ? { artist: stem.slice(0, at).trim(), title: stem.slice(at + 3).trim() } : { artist: '', title: stem };
}

// ---- tags ----------------------------------------------------------------------------------------

const syncsafe = (b, at) => ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
function frameText(b) {
  const enc = b[0] === 1 ? (b[1] === 0xff && b[2] === 0xfe ? 'utf-16le' : 'utf-16be') : (['latin1', '', 'utf-16be', 'utf-8'][b[0]] || 'latin1');
  return new TextDecoder(enc).decode(b.subarray(1)).replace(/\0[\s\S]*$/, '').replace(/^﻿+/, '').trim();
}

/**
 * The tags the Radio reads from a file's first bytes, plus which tag kind the file carries, so the card can say
 * when a file has tags the Radio ignores (MP4, FLAC, Ogg, ID3v2.2).
 * @param {Uint8Array} head the first bytes of the file (1 MiB is what the Radio reads)
 * @param {string} name the file name
 */
export function readTags(head, name) {
  const tags = { ...tagsFromName(name), kind: 'none', fromTags: false };
  const ascii = (at, n) => String.fromCharCode(...head.subarray(at, at + n));
  if (head.length >= 10 && ascii(0, 3) === 'ID3') {
    const version = head[3];
    tags.kind = `id3v2.${version}`;
    if (version < 3) return tags;
    const end = Math.min(10 + syncsafe(head, 6), head.length);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    for (let at = 10; at + 10 <= end;) {
      const id = ascii(at, 4);
      const size = version === 4 ? syncsafe(head, at + 4) : view.getUint32(at + 4);
      if (!size || at + 10 + size > end) break;
      const text = frameText(head.subarray(at + 10, at + 10 + size));
      if (id === 'TIT2' && text) { tags.title = text; tags.fromTags = true; }
      if (id === 'TPE1' && text) { tags.artist = text; tags.fromTags = true; }
      at += 10 + size;
    }
    return tags;
  }
  if (head.length >= 4 && ascii(0, 4) === 'fLaC') tags.kind = 'flac';
  else if (head.length >= 4 && ascii(0, 4) === 'OggS') tags.kind = 'ogg';
  else if (head.length >= 8 && ascii(4, 4) === 'ftyp') tags.kind = 'mp4';
  else if (head.length >= 4 && ascii(0, 4) === 'RIFF') tags.kind = 'wav';
  return tags;
}

// ---- matching ------------------------------------------------------------------------------------

/**
 * Which song a file is, by the Radio's rules: { song: index or -1, near: index or -1, why }.
 * "near" is a song whose title matched but whose artist did not, so the card can suggest a rename.
 * @param {{artist: string, title: string}} tags @param {string} path relative to the chosen folder
 */
export function matchFile(tags, path) {
  const fileTitle = dropTrackNo(baseName(path).replace(/_/g, ' '));
  const keys = new Set([tags.title, afterLastDash(tags.title), fileTitle, afterLastDash(fileTitle)]
    .flatMap((t) => [squash(titleKey(t)), squash(titleKeyKeepBrackets(t))]).filter(Boolean));
  const titleHit = SONG_KEYS.findIndex((k) => keys.has(k.joined));
  if (NOT_THE_SONG.test(clean(`${tags.title} ${path}`))) {
    return { song: -1, near: titleHit, why: 'cover' };
  }
  const where = `${clean(tags.artist)} ${clean(path)}`;
  const song = SONG_KEYS.findIndex((k) => keys.has(k.joined) && hasWords(where, k.artist));
  if (song >= 0) return { song, near: -1, why: 'match' };
  if (titleHit < 0) return { song: -1, near: -1, why: 'other' };
  // A named artist that is not the game's one is another recording (Ram Jam's "Black Betty"), not a naming slip.
  return { song: -1, near: titleHit, why: clean(tags.artist) ? 'other-artist' : 'artist' };
}

/** Whether a path names any song title or artist: with more than 500 files, only these are opened for tags. */
export function mentionsSong(path) {
  const p = clean(path);
  return SONG_KEYS.some((k) => hasWords(p, k.title) || hasWords(p, k.joined) || hasWords(p, k.artist));
}

/** The Radio's folder order: files in the chosen folder first, then each subfolder in natural name order. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const dirOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
export function radioOrder(a, b) {
  const da = dirOf(a), db = dirOf(b);
  if (da === db) return collator.compare(a, b);
  if (!da) return -1;
  if (!db) return 1;
  return collator.compare(da, db);
}

/**
 * Predict the Radio's result for a folder.
 * @param {{path: string, head: () => Promise<Uint8Array>}[]} files audio files, paths relative to the chosen folder
 * @returns {Promise<{found: (null|{path: string, fromTags: boolean})[], rows: object[], scanned: number}>}
 */
export async function scanFiles(files, { stop = () => false } = {}) {
  const sorted = [...files].sort((a, b) => radioOrder(a.path, b.path));
  const everyFile = sorted.length <= MANY_FILES;
  const found = EA_TRAX.map(() => null);
  const rows = [];
  let scanned = 0;
  for (const f of sorted) {
    if (stop()) break;
    if (!everyFile && !mentionsSong(f.path)) continue;
    let tags;
    try { tags = readTags(await f.head(), f.path.slice(f.path.lastIndexOf('/') + 1)); }
    catch { tags = { artist: '', title: '', kind: 'unreadable', fromTags: false }; }
    scanned++;
    const m = matchFile(tags, f.path);
    if (m.song >= 0) {
      if (!found[m.song]) { found[m.song] = { path: f.path, fromTags: tags.fromTags }; rows.push({ path: f.path, song: m.song, why: 'match', kind: tags.kind }); }
      else rows.push({ path: f.path, song: m.song, why: 'duplicate', kind: tags.kind });
    } else if (m.near >= 0) {
      rows.push({ path: f.path, song: m.near, why: m.why, kind: tags.kind, artist: tags.artist, rename: renameFor(m.near, f.path) });
    }
  }
  // A near miss for a song that another file already supplies needs no fixing.
  return { found, rows: rows.filter((r) => r.why === 'match' || r.why === 'duplicate' || !found[r.song]), scanned };
}

/** A file name the Radio matches by name alone: "Artist - Title.ext", with characters Windows refuses removed. */
export function renameFor(song, path) {
  const ext = (/\.[^.]+$/.exec(path) || [''])[0];
  const { artist, title } = EA_TRAX[song];
  return `${artist} - ${title}${ext}`.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ');
}

/** Why a file did not count, in words for the card. */
export function explain(row) {
  const song = EA_TRAX[row.song];
  switch (row.why) {
    case 'match': return `${song.artist}, ${song.title}`;
    case 'duplicate': return `Also ${song.title}; the Radio plays the first one only.`;
    case 'cover': return `Looks like a cover, karaoke or instrumental of ${song.title}, which the Radio skips.`;
    case 'artist': {
      const tagNote = row.kind === 'mp4' || row.kind === 'flac' || row.kind === 'ogg' || row.kind === 'id3v2.2'
        ? ' The Radio does not read this file\'s tags, only MP3 ID3v2.3 or v2.4.' : '';
      return `Title matches ${song.title}, but "${mainArtistLabel(song)}" is not in its tags, name or folder.${tagNote} Rename it "${row.rename}" or put it in a folder named after the artist.`;
    }
    case 'other-artist':
      return `This is ${row.artist}'s ${song.title}. The game uses the ${mainArtistLabel(song)} recording, so the Radio skips it. If it is that recording, correct the artist in its tags or name.`;
    default: return '';
  }
}
const mainArtistLabel = (song) => song.artist.split(/\s(?:feat\.?|ft\.?|featuring)\s/i)[0];

// ---- Spotivibly ----------------------------------------------------------------------------------

/**
 * The Spotivibly player for all 27 songs, in game order. It plays each song's YouTube video, so the 2 songs
 * missing from Spotify play too and no account is needed. The panel frames it: the player's frame-ancestors
 * CSP allows chrome-extension: pages. view=video shows only the video box (YouTube needs at least 200x200 of it
 * visible); the panel draws the controls and drives the player with Spotivibly's postMessage API.
 */
export const SPOTIVIBLY_EMBED = 'https://spotivibly.com/embed/329288aa-15be-4c6c-a98c-64f50000ae67?platform=youtube&view=video';

const norm = (s) => String(s).toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * For each EA Trax song, the index of the same song in the player's track list, by title and main artist, or -1.
 * The playlist is in game order, so a song whose name the player spells differently falls back to its own index
 * when that track is not already taken.
 */
export function mapTracks(tracks) {
  const taken = new Set();
  const out = EA_TRAX.map((song) => {
    const title = norm(song.title), artist = norm(mainArtistLabel(song));
    const i = tracks.findIndex((t, k) => !taken.has(k) && norm(t.name).startsWith(title) && norm(t.artist).includes(artist));
    if (i >= 0) taken.add(i);
    return i;
  });
  return out.map((i, k) => (i >= 0 ? i : k < tracks.length && !taken.has(k) ? (taken.add(k), k) : -1));
}

/** Each song's folder status from a saved scan: 'found', 'rename' (a file needs a new name or tags), 'missing', or '' before any scan. */
export function songStatuses(saved) {
  if (!saved) return EA_TRAX.map(() => '');
  const near = new Set((saved.rows ?? []).filter((r) => r.song >= 0 && r.why !== 'match' && r.why !== 'duplicate').map((r) => r.song));
  return EA_TRAX.map((_, i) => (saved.found?.[i] ? 'found' : near.has(i) ? 'rename' : 'missing'));
}

/**
 * A saved folder check as read back from storage, checked field by field, or null. It may come from an older install
 * (the import carries it over) or an older version, so nothing in it is trusted: a bad one would blank the card.
 */
export function readScan(v) {
  if (!v || typeof v !== 'object') return null;
  const int = (x) => Number.isInteger(x) && x >= 0;
  const text = (x) => typeof x === 'string';
  const song = (x) => Number.isInteger(x) && x >= 0 && x < EA_TRAX.length;
  const opt = (x) => x === undefined || text(x);
  if (!Array.isArray(v.found) || v.found.length !== EA_TRAX.length || !v.found.every((f) => f === null || (f && typeof f === 'object' && text(f.path)))) return null;
  if (!Array.isArray(v.rows) || !v.rows.every((r) => r && typeof r === 'object' && text(r.path) && song(r.song) && text(r.why) && opt(r.kind) && opt(r.artist) && opt(r.rename))) return null;
  if (![v.files, v.scanned, v.zips].every(int) || typeof v.when !== 'number' || !Number.isFinite(v.when) || !(v.folder == null || text(v.folder))) return null;
  return v;
}

/** A spotivibly:state or spotivibly:ready message from the player, checked field by field, or null. */
export function readPlayerMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const int = (v) => Number.isInteger(v) && v >= 0;
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (data.type === 'spotivibly:ready' && Array.isArray(data.tracks)
    && data.tracks.every((t) => t && typeof t.name === 'string' && typeof t.artist === 'string')) {
    return { type: 'ready', tracks: data.tracks.map((t) => ({ name: t.name, artist: t.artist })) };
  }
  if (data.type === 'spotivibly:state' && int(data.index) && int(data.total) && num(data.time) && num(data.duration)
    && ['idle', 'playing', 'paused', 'buffering'].includes(data.status) && Array.isArray(data.failed) && data.failed.every(int)) {
    return {
      type: 'state', index: data.index, total: data.total, status: data.status, started: data.started === true,
      time: data.time, duration: data.duration, failed: data.failed, unavailable: data.unavailable === true,
    };
  }
  return null;
}

/** The tracklist as a Spotivibly prompt: every song in game order, "Artist - Title", one per line. */
export const EA_TRAX_PROMPT = [
  `Need for Speed Underground 2 EA Trax soundtrack, all ${EA_TRAX.length} songs in game order:`,
  ...EA_TRAX.map((s, i) => `${i + 1}. ${s.artist} - ${s.title}`),
].join('\n');

/**
 * Spotivibly's generator, prefilled with the tracklist and the song count. /generate reads ?prompt= and
 * ?count= once, then strips them from the address bar. The URL carries the tracklist only.
 */
// new URL() gives the form a browser tab reports (it also escapes the apostrophe in "That'z").
export const SPOTIVIBLY_GENERATE = new URL(`https://spotivibly.com/generate?prompt=${encodeURIComponent(EA_TRAX_PROMPT)}&count=${EA_TRAX.length}`).href;

/**
 * The same generator link for any tracklist of { artist, title }, under a soundtrack's name. With no list yet it asks
 * for the soundtrack by name and leaves the count to Spotivibly.
 */
export function generateFor(game, tracks) {
  if (!tracks.length) return new URL(`https://spotivibly.com/generate?prompt=${encodeURIComponent(`${game} EA Trax soundtrack, every song in game order`)}`).href;
  const prompt = [`${game} EA Trax soundtrack, all ${tracks.length} songs in game order:`, ...tracks.map((s, i) => `${i + 1}. ${s.artist} - ${s.title}`)].join('\n');
  return new URL(`https://spotivibly.com/generate?prompt=${encodeURIComponent(prompt)}&count=${tracks.length}`).href;
}

/**
 * Spotivibly's "Need for Speed Underground: EA Trax" playlist id. Its song list comes from the player itself, so the
 * panel never carries a typed copy of it. It holds 22 of the game's 26 songs: the other 4 have no official upload on
 * Spotify or YouTube. Emptied, the NFSU1 tab says the playlist is coming soon.
 */
export const NFSU1_PLAYLIST = '589e7521-5a19-4464-a634-408d755d2603';

/**
 * The soundtracks the card can show. Only NFSU2 has a folder check: nfsu2.xyz's Radio matches files against NFSU2's
 * 27 songs and no others, so an NFSU1 song in the folder is never played there.
 */
export const SOUNDTRACKS = Object.freeze([
  { key: 'u2', label: 'NFSU2', game: 'Need for Speed Underground 2', embed: SPOTIVIBLY_EMBED, tracks: EA_TRAX, folder: true },
  { key: 'u1', label: 'NFSU1', game: 'Need for Speed Underground', embed: NFSU1_PLAYLIST ? `https://spotivibly.com/embed/${NFSU1_PLAYLIST}?platform=youtube&view=video` : null, tracks: null, folder: false },
].map(Object.freeze));

/** Spotivibly's home page, for the card's plug. utm_* reaches Spotivibly's own Google Analytics tag, nothing else. */
export const SPOTIVIBLY_HOME = 'https://spotivibly.com/?utm_source=nfsu2-save-editor&utm_medium=extension&utm_campaign=music-card';
