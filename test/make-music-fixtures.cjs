// Builds a test music folder from synthesized tones (made here, so royalty-free) named and tagged the ways real
// libraries are, to check the Music card's prediction against nfsu2.xyz's Radio. Needs ffmpeg on PATH.
// Usage: node test/make-music-fixtures.cjs <empty output folder>
// Each fixture names the result the Radio should give; music.test.mjs and live-music.cjs read FIXTURES.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

/** [relative path, ffmpeg args for tags and codec, expected: song index matched, or a skip reason] */
const FIXTURES = [
  ['Amazon/01 - Riders On The Storm (Fredwreck Remix) [Explicit].mp3', ['-id3v2_version', '3', '-metadata', 'artist=Snoop Dogg feat. The Doors', '-metadata', 'title=Riders On The Storm (Fredwreck Remix) [Explicit]'], { song: 0, by: 'tags' }],
  ['track07.mp3', ['-id3v2_version', '4', '-metadata', 'artist=Capone', '-metadata', 'title=I Need Speed'], { song: 1, by: 'tags' }],
  ['Chingy/Jackpot/03 I Do.m4a', ['-c:a', 'aac'], { song: 2, by: 'folder' }],
  ['Xzibit - LAX.flac', ['-c:a', 'flac'], { song: 4, by: 'name' }],
  ['Lean Back.m4a', ['-c:a', 'aac', '-metadata', 'artist=Terror Squad', '-metadata', 'title=Lean Back'], { skip: 'artist', song: 5 }],
  ['Fluke - Switch-Twitch.ogg', ['-c:a', 'libvorbis'], { song: 6, by: 'name' }],
  ['Queens of the Stone Age - In My Head (Karaoke Version).mp3', ['-write_id3v2', '0'], { skip: 'cover', song: 18 }],
  ['Ram Jam - Black Betty.mp3', ['-write_id3v2', '0'], { skip: 'other-artist', song: 23 }],
  ['Ministry - No W.wav', ['-c:a', 'pcm_s16le'], { song: 17, by: 'name' }],
  ['Crashing Foreign Cars.mp3', 'id3v22', { skip: 'artist', song: 21 }],
  ['dupes/Capone - I Need Speed.mp3', ['-write_id3v2', '0'], { skip: 'duplicate', song: 1 }],
  ['Unrelated - Some Other Song.mp3', ['-write_id3v2', '0'], { none: true }],
  ['Rise Against/Siren Song of the Counter Culture/05 Give It All.flac', ['-c:a', 'flac'], { song: 14, by: 'folder' }],
  ['Unwritten Law - The Celebration Song - Remastered.opus', ['-c:a', 'libopus'], { song: 26, by: 'name' }],
  ['notes.txt', 'text', { none: true }],
  ['Skindred.zip', 'zip:Skindred - Nobody.mp3', { zip: true, song: 24 }],
];

/** A minimal ID3v2.2 tag (3-letter frames), which the Radio ignores. */
function id3v22(artist, title) {
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
    return Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from([body.length >> 16, (body.length >> 8) & 255, body.length & 255]), body]);
  };
  const frames = Buffer.concat([frame('TT2', title), frame('TP1', artist)]);
  const n = frames.length;
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([2, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]), frames]);
}

/** A stored (uncompressed) zip with one file. */
function storedZip(name, data) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const fname = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fname.length, 28);
  const localLen = local.length + fname.length + data.length;
  const centralLen = central.length + fname.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(centralLen, 12); end.writeUInt32LE(localLen, 16);
  return Buffer.concat([local, fname, data, central, fname, end]);
}

function tone(out, args, i) {
  const freq = 220 + 40 * i;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`, '-ac', '2', ...args, out]);
}

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node test/make-music-fixtures.cjs <empty output folder>');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw new Error(`${dir} is not empty.`);
  FIXTURES.forEach(([rel, how], i) => {
    const out = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (how === 'text') { fs.writeFileSync(out, 'not audio\n'); return; }
    if (how === 'id3v22') {
      const tmp = `${out}.raw.mp3`;
      tone(tmp, ['-write_id3v2', '0', '-write_xing', '0'], i);
      fs.writeFileSync(out, Buffer.concat([id3v22('Helmet', 'Crashing Foreign Cars'), fs.readFileSync(tmp)]));
      fs.unlinkSync(tmp);
      return;
    }
    if (typeof how === 'string' && how.startsWith('zip:')) {
      const tmp = `${out}.inner.mp3`;
      tone(tmp, ['-write_id3v2', '0'], i);
      fs.writeFileSync(out, storedZip(how.slice(4), fs.readFileSync(tmp)));
      fs.unlinkSync(tmp);
      return;
    }
    tone(out, how, i);
  });
  console.log(`${FIXTURES.length} fixtures in ${dir}`);
}

module.exports = { FIXTURES };
if (require.main === module) main();
