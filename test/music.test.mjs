// The Music card's prediction on the synthesized fixture folder, plus the matching rules on their own.
// Usage: node test/music.test.mjs   (builds the fixtures in a temp folder; needs ffmpeg)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as music from '../src/music.js';

const require = createRequire(import.meta.url);
const { FIXTURES } = require('./make-music-fixtures.cjs');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`); };

// ---- rules on their own -------------------------------------------------------------------------
const m = (artist, title, p) => music.matchFile({ artist, title }, p).song;
check('tags match with feat. and [Explicit]', m('Snoop Dogg feat. The Doors', 'Riders on the Storm [Explicit]', 'x.mp3') === 0);
check('track number dropped from the name', m('', '07 I Need Speed', 'Capone/07 I Need Speed.m4a') === 1);
check('"No W" needs the artist', m('', 'No W', 'No W.mp3') === -1 && m('', 'No W', 'Ministry/No W.mp3') === 17);
check('"&" reads as "and"', m('Killing Joke', 'The Death and Resurrection Show', 'a.mp3') === 13);
check('apostrophe ignored', m('Sly Boogy', 'Thatz My Name', 'a.mp3') === 3);
check('leading "The" on the artist ignored', m('Bronx', 'Notice of Eviction', 'a.mp3') === 16);
check('karaoke refused', m('Xzibit', 'LAX (Karaoke Version)', 'a.mp3') === -1);
check('another band\'s recording is not offered a rename', music.matchFile({ artist: 'Ram Jam', title: 'Black Betty' }, 'a.mp3').why === 'other-artist');
check('artist must be whole words', m('', 'Nobody', 'Skindredx - Nobody.mp3') === -1);
check('remaster suffix ignored', m('', 'The Celebration Song - 2023 Remaster', 'Unwritten Law/x.mp3') === 26);
check('27 songs', music.EA_TRAX.length === 27);
check('the generator prompt lists all 27 songs in game order, one per line', (() => { const l = music.EA_TRAX_PROMPT.split('\n').slice(1); return l.length === 27 && music.EA_TRAX.every((s, k) => l[k] === `${k + 1}. ${s.artist} - ${s.title}`); })());
check('Generate in Spotivibly prefills /generate with that prompt and count 27, nothing else', (() => { const u = new URL(music.SPOTIVIBLY_GENERATE); return u.origin + u.pathname === 'https://spotivibly.com/generate' && [...u.searchParams.keys()].join() === 'prompt,count' && u.searchParams.get('prompt') === music.EA_TRAX_PROMPT && u.searchParams.get('count') === '27'; })());
check('the prompt fits the 4000-character limit of Spotivibly prompts', music.EA_TRAX_PROMPT.length < 4000, String(music.EA_TRAX_PROMPT.length));
check('no per-song store or Spotivibly links are exported', !('storeLinks' in music) && !('spotiviblyLink' in music));
check('the player link opens one Spotivibly playlist, YouTube only, video box only', /^https:\/\/spotivibly\.com\/embed\/[0-9a-f-]{36}\?platform=youtube&view=video$/.test(music.SPOTIVIBLY_EMBED));

// ---- soundtracks and the plug -------------------------------------------------------------------
check('generateFor builds the same link the NFSU2 card uses', music.generateFor('Need for Speed Underground 2', music.EA_TRAX) === music.SPOTIVIBLY_GENERATE);
check('NFSU2 comes first, with its own list, its player and the folder check', (() => { const [u2] = music.SOUNDTRACKS; return u2.key === 'u2' && u2.tracks === music.EA_TRAX && u2.embed === music.SPOTIVIBLY_EMBED && u2.folder === true; })());
check('every other soundtrack takes its list from its own Spotivibly player, or has none yet, and has no folder check', music.SOUNDTRACKS.slice(1).every((t) => t.tracks === null && t.folder === false
  && (t.embed === null || (/^https:\/\/spotivibly\.com\/embed\/[0-9a-f-]{36}\?platform=youtube&view=video$/.test(t.embed) && t.embed !== music.SPOTIVIBLY_EMBED))));
check('the NFSU1 tab is always there, with a player exactly when its playlist id is set', (() => {
  const u1 = music.SOUNDTRACKS.find((t) => t.key === 'u1');
  if (!u1 || music.SOUNDTRACKS.length !== 2) return false;
  return music.NFSU1_PLAYLIST ? /^[0-9a-f-]{36}$/.test(music.NFSU1_PLAYLIST) && u1.embed.includes(music.NFSU1_PLAYLIST) : u1.embed === null;
})());
check('NFSU1_PLAYLIST is Spotivibly\'s "Need for Speed Underground: EA Trax" playlist, framed as its video player', music.NFSU1_PLAYLIST === '589e7521-5a19-4464-a634-408d755d2603'
  && music.SOUNDTRACKS.find((t) => t.key === 'u1').embed === 'https://spotivibly.com/embed/589e7521-5a19-4464-a634-408d755d2603?platform=youtube&view=video', music.NFSU1_PLAYLIST);
check('Generate without a song list asks Spotivibly for the soundtrack by name, with no count', (() => {
  const u = new URL(music.generateFor('Need for Speed Underground', []));
  return u.origin + u.pathname === 'https://spotivibly.com/generate' && u.searchParams.get('prompt') === 'Need for Speed Underground EA Trax soundtrack, every song in game order' && !u.searchParams.has('count');
})());
check('Generate with a song list numbers it and sends the count', (() => {
  const u = new URL(music.generateFor('X', [{ artist: 'A', title: 'B' }, { artist: 'C', title: 'D' }]));
  return u.searchParams.get('count') === '2' && u.searchParams.get('prompt') === 'X EA Trax soundtrack, all 2 songs in game order:\n1. A - B\n2. C - D';
})());
check('the plug link is Spotivibly\'s home page with utm tags only', (() => { const u = new URL(music.SPOTIVIBLY_HOME); return u.origin + u.pathname === 'https://spotivibly.com/' && [...u.searchParams.keys()].join() === 'utm_source,utm_medium,utm_campaign'; })());

// ---- the player bridge --------------------------------------------------------------------------
{
  const inOrder = music.EA_TRAX.map((s) => ({ name: s.title, artist: s.artist }));
  check('tracks in game order map one to one', music.mapTracks(inOrder).every((v, i) => v === i));
  const shuffled = [...inOrder].reverse();
  check('tracks in another order map by title and main artist', music.mapTracks(shuffled).every((v, i) => v === 26 - i), music.mapTracks(shuffled).join());
  const spelled = inOrder.map((t, i) => (i === 3 ? { name: "That's My Name", artist: 'Sly Boogy' } : i === 0 ? { name: 'Riders On The Storm - Fredwreck Remix', artist: 'Snoop Dogg, The Doors' } : t));
  const m = music.mapTracks(spelled);
  check('a song spelled differently falls back to its own slot', m[3] === 3 && m[0] === 0, m.join());
  const short = inOrder.slice(0, 25);
  const ms = music.mapTracks(short);
  check('songs past a shorter list map to -1', ms[25] === -1 && ms[26] === -1 && ms[24] === 24, ms.join());

  // The NFSU1 playlist as Spotivibly served it on 2026-11-18, in its own order, spellings kept (one artist by surname).
  const u1 = [["Who's Who", 'Dilated Peoples'], ['TO HELL WE RIDE', 'lostprophets'], ['Swallow', 'Blindside'], ['Out of Control', 'Rancid'],
    ['Kimosabe', 'BT'], ['Fortress Europe', 'Asian Dub Foundation'], ['Broken Promises', 'Element Eighty'], ['Doomsday', 'Overseer'],
    ['Glitterball', 'FC Kahuna'], ['Snapshot', 'Fluke'], ['And the Hero Will Drown', 'Story Of The Year'], ['Action Radius', 'Junkie XL'],
    ['Invisible', 'Hotwire'], ['Get Low', 'Lil Jon & The East Side Boyz, Ying Yang Twins'], ['Supermoves', 'Overseer'], ['Quarter', 'Fuel'],
    ['The Wonders Of You', 'Hunter'], ["24's", 'T.I.'], ['Two-Lane Blacktop', 'Rob Zombie'], ['The Only', 'Static-X'],
    ['Born Too Slow', 'The Crystal Method'], ['Sucked In', 'Jerk']].map(([name, artist]) => ({ name, artist }));
  const o = music.orderByGame(u1, music.NFSU1_ORDER);
  const names = o.map((i) => u1[i].name);
  const want = ['Get Low', "Who's Who", "24's", 'Doomsday', 'Born Too Slow', 'Out of Control', 'Two-Lane Blacktop', 'Kimosabe', 'The Only',
    'Broken Promises', 'Fortress Europe', 'Invisible', 'And the Hero Will Drown', 'The Wonders Of You', 'Action Radius', 'Quarter',
    'Sucked In', 'Snapshot', 'TO HELL WE RIDE', 'Supermoves', 'Glitterball', 'Swallow'];
  check('NFSU1 tracks sort into the game order, Get Low first, every track kept once', names.join('|') === want.join('|') && new Set(o).size === u1.length, names.join(' | '));
  check('NFSU1 order holds the 26 songs', music.NFSU1_ORDER.length === 26 && music.NFSU1_ORDER[0].title === 'Get Low');
  const extra = music.orderByGame([{ name: 'Unknown Song', artist: 'Nobody' }, { name: 'Get Low', artist: 'Lil Jon' }], music.NFSU1_ORDER);
  check('a track no song takes goes after the matched ones', extra.join() === '1,0', extra.join());
  check('the NFSU1 tab carries the order, NFSU2 does not', music.SOUNDTRACKS.find((s) => s.key === 'u1').order === music.NFSU1_ORDER && !music.SOUNDTRACKS.find((s) => s.key === 'u2').order);

  const none = music.songStatuses(null);
  check('before any scan every status is empty', none.length === 27 && none.every((s) => s === ''));
  const found = music.EA_TRAX.map((_, i) => (i === 0 || i === 4 ? { path: 'x.mp3' } : null));
  const st = music.songStatuses({ found, rows: [{ song: 6, why: 'artist', path: 'Switch.mp3' }, { song: 0, why: 'duplicate', path: 'y.mp3' }, { song: -1, why: 'other', path: 'z.mp3' }] });
  check('statuses: found, a file to rename, and missing', st[0] === 'found' && st[4] === 'found' && st[6] === 'rename' && st[1] === 'missing' && st.filter((s) => s === 'missing').length === 24, st.join());

  const good = { type: 'spotivibly:state', version: 1, index: 2, total: 27, status: 'playing', started: true, time: 12.4, duration: 300, failed: [5], unavailable: false };
  check('a well-formed state message is read', JSON.stringify(music.readPlayerMessage(good)) === JSON.stringify({ type: 'state', index: 2, total: 27, status: 'playing', started: true, time: 12.4, duration: 300, failed: [5], unavailable: false }));
  check('a ready message keeps only names and artists', JSON.stringify(music.readPlayerMessage({ type: 'spotivibly:ready', tracks: [{ name: 'a', artist: 'b', x: '<img>' }] })) === JSON.stringify({ type: 'ready', tracks: [{ name: 'a', artist: 'b' }] }));
  const bad = [null, 'x', {}, { ...good, type: 'other' }, { ...good, index: -1 }, { ...good, index: 1.5 }, { ...good, status: 'weird' }, { ...good, time: Number.NaN },
    { ...good, duration: '300' }, { ...good, failed: ['1'] }, { ...good, failed: null }, { type: 'spotivibly:ready', tracks: [{ name: 1, artist: 'b' }] }, { type: 'spotivibly:ready' }];
  check('malformed player messages are dropped', bad.every((b) => music.readPlayerMessage(b) === null), bad.filter((b) => music.readPlayerMessage(b) !== null).map((b) => JSON.stringify(b)).join(' | '));
}
check('rename keeps the extension and drops Windows-illegal characters', music.renameFor(6, 'a/b.flac') === 'Fluke - Switch Twitch.flac');
check('folder order: root files first', ['b/a.mp3', 'z.mp3', 'a/z.mp3'].sort(music.radioOrder).join() === 'z.mp3,a/z.mp3,b/a.mp3');

// ---- ID3 parsing --------------------------------------------------------------------------------
const v23 = (frames) => {
  const body = Buffer.concat(frames.map(([id, text]) => {
    const t = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const h = Buffer.alloc(10); h.write(id, 0, 'latin1'); h.writeUInt32BE(t.length, 4);
    return Buffer.concat([h, t]);
  }));
  const n = body.length;
  return new Uint8Array(Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]), body]));
};
const t = music.readTags(v23([['TPE1', 'Capone'], ['TIT2', 'I Need Speed']]), 'zz.mp3');
check('ID3v2.3 artist and title read', t.artist === 'Capone' && t.title === 'I Need Speed' && t.fromTags);
check('no tags: name split on " - "', JSON.stringify(music.tagsFromName('A - B - C.mp3')) === '{"artist":"A","title":"B - C"}');

// ---- the fixture folder ----------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-music-'));
execFileSync(process.execPath, [new URL('./make-music-fixtures.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), dir], { stdio: 'inherit' });
const files = [];
const walk = (abs, rel) => {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const a = path.join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(a, r);
    else if (music.AUDIO_RE.test(e.name)) files.push({ path: r, head: async () => new Uint8Array(fs.readFileSync(a).subarray(0, 1 << 20)) });
  }
};
walk(dir, '');
const res = await music.scanFiles(files);
for (const [rel, , want] of FIXTURES) {
  if (want.song === undefined || want.zip) continue;
  if (want.by) {
    const hit = res.found[want.song];
    check(`${rel} found by ${want.by}`, hit?.path === rel && hit.fromTags === (want.by === 'tags'), JSON.stringify(hit));
  } else {
    const row = res.rows.find((r) => r.path === rel);
    check(`${rel} skipped: ${want.skip}`, row?.why === want.skip, JSON.stringify(row));
  }
}
const expectFound = FIXTURES.filter(([, , w]) => w.by).map(([, , w]) => w.song).sort((a, b) => a - b);
const gotFound = res.found.flatMap((f, i) => (f ? [i] : []));
check(`found exactly songs ${expectFound.join(',')}`, gotFound.join() === expectFound.join(), gotFound.join());
check('the ID3v2.2 file is explained as unread tags', music.explain(res.rows.find((r) => r.path === 'Crashing Foreign Cars.mp3') ?? { song: 0, why: '' }).includes('does not read this file\'s tags'));
check('nothing reported for the unrelated song', !res.rows.some((r) => r.path.startsWith('Unrelated')));
fs.rmSync(dir, { recursive: true, force: true });

// B13: a saved folder check is read back field by field. A real scan's result passes; damaged ones (as an import from
// an older install could bring) are refused instead of blanking the card.
{
  const found = music.EA_TRAX.map(() => null);
  found[0] = { path: 'Music/a.mp3', fromTags: true };
  const good = { folder: 'Music', when: 1700000000000, files: 3, scanned: 3, zips: 0, found, rows: [{ path: 'Music/b.mp3', song: 1, why: 'artist', kind: 'mp3', artist: 'x', rename: 'y.mp3' }] };
  check('B13 a well-formed folder check is read', music.readScan(good) === good);
  const bad = [
    null, 'x', { ...good, found: [] }, { ...good, found: 'x' }, { ...good, found: found.map((f, i) => (i === 2 ? { path: 5 } : f)) },
    { ...good, rows: 5 }, { ...good, rows: [{ path: 'a', song: 999, why: 'artist' }] }, { ...good, rows: [{ path: 'a', song: 1 }] },
    { ...good, files: -1 }, { ...good, scanned: 1.5 }, { ...good, when: 'yesterday' }, { ...good, folder: 7 },
  ];
  check('B13 damaged folder checks are refused', bad.every((b) => music.readScan(b) === null), bad.filter((b) => music.readScan(b) !== null).map((b) => JSON.stringify(b).slice(0, 60)).join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
