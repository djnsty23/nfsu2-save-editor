// Backup and restore files: the zip writer and reader, the site's layout both ways, and every refusal.
// Usage: node test/backup.test.mjs <profile folder> <second profile folder> [site backup zip ...]
// Each profile folder holds <name>/<name> style files: the career named after the folder, and its GARAGE.DAT.
// Site backup zips, when given, are only read: each must restore at least one career and skip its other files.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { writeZip, readZip, crc32 } from '../src/zip.js';
import * as backup from '../src/backup.js';
import { recalculateChecksums } from '../vendor/hackch/model/save-file.js';

const [dirA, dirB, ...siteZips] = process.argv.slice(2);
if (!dirB) { console.error('usage: node test/backup.test.mjs <profile folder> <second profile folder> [site zip ...]'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`); };
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
const load = (dir) => {
  const name = path.basename(dir);
  const g = path.join(dir, 'GARAGE.DAT');
  return { name, career: new Uint8Array(fs.readFileSync(path.join(dir, name))), garage: fs.existsSync(g) ? new Uint8Array(fs.readFileSync(g)) : null };
};
const refuses = async (bytes, file, re) => {
  // Strictly true or false: a message that does not match is a failure, printed so the run says why.
  try { await backup.parseRestore(bytes, file); console.log(`      ${file}: accepted`); return false; } catch (err) {
    if (re.test(err.message)) return true;
    console.log(`      ${file}: ${err.message}`);
    return false;
  }
};
const R = backup.ROOT_DIR;
const A = load(dirA), B = load(dirB);

// ---- Backup: layout, name, and a byte-for-byte round trip.
const zip = backup.buildBackup([B, A], Date.UTC(2026, 10, 14, 12, 0, 0));
const entries = await readZip(zip);
const want = [A, B].sort((x, y) => x.name.localeCompare(y.name)).flatMap((p) => [`${R}/${p.name}/${p.name}`, ...(p.garage ? [`${R}/${p.name}/GARAGE.DAT`] : [])]);
check('B1 the backup holds exactly the career and GARAGE.DAT of each profile, in the site\'s folder layout', entries.map((e) => e.name).join('|') === want.join('|'), entries.map((e) => e.name).join(' | '));
const dv = new DataView(zip.buffer);
check('B2 every entry is stored uncompressed with the UTF-8 flag, as the site writes them', entries.length > 0 && (() => {
  let p = 0;
  for (let n = 0; n < entries.length; n++) {
    if (dv.getUint32(p, true) !== 0x04034b50 || dv.getUint16(p + 8, true) !== 0 || dv.getUint16(p + 6, true) !== 0x0800) return false;
    p += 30 + dv.getUint16(p + 26, true) + dv.getUint32(p + 18, true);
  }
  return true;
})());
check('B3 the file name follows the site: nfsu2-saves-YYYY-MM-DD_HHMMSS.zip', backup.backupFileName(new Date(2026, 10, 2, 9, 5, 7)) === 'nfsu2-saves-2026-11-02_090507.zip');
const back = await backup.parseRestore(zip, 'ours.zip');
check('B4 round trip: backup then restore gives back every file byte for byte', back.profiles.length === 2
  && [A, B].every((p) => { const r = back.profiles.find((x) => x.profile === p.name); return r && same(r.career, p.career) && (p.garage ? same(r.garage, p.garage) : r.garage === null); }));
check('B5 nothing in our own backup is skipped', back.skipped.length === 0, JSON.stringify(back.skipped));

// ---- Restore of the site's layouts.
const media = new Uint8Array(1048612); media.set([0x32, 0x30, 0x43, 0x4d]);
const siteLike = writeZip([
  { name: `${R}/${A.name} DVD 3/${A.name} DVD 3`, data: media },
  { name: `${R}/${A.name} Magazine 7/${A.name} Magazine 7`, data: media },
  { name: `${R}/${A.name}/GARAGE.DAT`, data: A.garage },
  { name: `${R}/${A.name}/JOBS.DAT`, data: new Uint8Array(356) },
  { name: `${R}/${A.name}/MODPARTS.DAT`, data: new Uint8Array(80) },
  { name: `${R}/${A.name}/${A.name}`, data: A.career },
  { name: 'autosave-profiles.txt', data: new TextEncoder().encode('x') },
  { name: 'registry.txt', data: new TextEncoder().encode('x') },
  { name: 'settings.ini', data: new TextEncoder().encode('x') },
].filter((f) => f.data));
const sl = await backup.parseRestore(siteLike, 'site.zip');
check('B6 a full site backup restores its career and garage only', sl.profiles.length === 1 && same(sl.profiles[0].career, A.career) && (A.garage ? same(sl.profiles[0].garage, A.garage) : true));
check('B7 magazine and DVD folders are skipped as not careers, never read as one', sl.skipped.filter((s) => /magazine cover or DVD/.test(s.why)).length === 2, JSON.stringify(sl.skipped.map((s) => s.path)));
check('B8 settings, registry, JOBS.DAT and MODPARTS.DAT are listed as not restored', ['registry.txt', 'settings.ini', 'autosave-profiles.txt', 'JOBS.DAT', 'MODPARTS.DAT'].every((n) => sl.skipped.some((s) => s.path.endsWith(n))));
const wrapped = writeZip([{ name: `backup/${R}/${A.name}/${A.name}`, data: A.career }]);
check('B9 a zip re-packed inside one extra folder still restores', (await backup.parseRestore(wrapped, 'w.zip')).profiles[0]?.profile === A.name);
check('B10 a single career file restores under the name stored inside it', await (async () => {
  const r = await backup.parseRestore(A.career, 'renamed copy (1)');
  return r.kind === 'career' && r.profiles[0].profile === A.name && r.profiles[0].garage === null;
})());

// ---- Deflated zips (re-packed by Windows or 7-Zip) read too, CRC checked.
const deflated = (() => {
  const enc = new TextEncoder(), name = enc.encode(`${R}/${A.name}/${A.name}`), comp = zlib.deflateRawSync(A.career), crc = crc32(A.career);
  const local = Buffer.alloc(30 + name.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(A.career.length, 22); local.writeUInt16LE(name.length, 26); Buffer.from(name).copy(local, 30);
  const cen = Buffer.alloc(46 + name.length); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(A.career.length, 24); cen.writeUInt16LE(name.length, 28); Buffer.from(name).copy(cen, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cen.length, 12); end.writeUInt32LE(local.length + comp.length, 16);
  return new Uint8Array(Buffer.concat([local, comp, cen, end]));
})();
check('B11 a deflated zip restores byte for byte', same((await backup.parseRestore(deflated, 'd.zip')).profiles[0]?.career, A.career));

// ---- Refusals: each writes nothing because parseRestore throws before any plan exists.
const flipped = zip.slice(); flipped[200] ^= 0xff;
check('B12 a corrupt zip (one byte flipped inside a career) is refused', await refuses(flipped, 'c.zip', /checksum does not match|damaged/));
check('B13 a truncated zip is refused', await refuses(zip.slice(0, Math.floor(zip.length / 2)), 't.zip', /cut short|not a zip/));
check('B14 a zip cut one byte short of its end is refused', await refuses(zip.slice(0, zip.length - 1), 't1.zip', /cut short|not a zip|damaged/));
check('B15 random bytes are refused', await refuses(new Uint8Array(5000).fill(7), 'r.bin', /neither a zip nor a career/));
const short = writeZip([{ name: `${R}/${A.name}/${A.name}`, data: A.career.slice(0, 54000) }]);
check('B16 a career of the wrong size inside a zip is refused, naming 54,966', await refuses(short, 's.zip', /54,000 bytes, but a career save is 54,966/));
check('B17 a career file of the wrong size on its own is refused', await refuses(A.career.slice(0, 54965), 'one', /54,965 bytes/));
check('B18 a magazine file picked on its own is refused as not a career', await refuses(media, `${A.name} Magazine 7`, /magazine cover or DVD replay/));
const badSum = A.career.slice(); badSum[0x5000] ^= 0xff;
check('B19 a career whose checksum fails is refused', await refuses(writeZip([{ name: `${R}/${A.name}/${A.name}`, data: badSum }]), 'k.zip', /checksums do not match/));
check('B20 a GARAGE.DAT of the wrong size is refused with its career', await refuses(writeZip([{ name: `${R}/${A.name}/${A.name}`, data: A.career }, { name: `${R}/${A.name}/GARAGE.DAT`, data: new Uint8Array(100) }]), 'g.zip', /GARAGE\.DAT .* wrong signature/));
check('B21 a career in a folder of another name is refused', await refuses(writeZip([{ name: `${R}/OTHER/OTHER`, data: A.career }]), 'n.zip', /named .* inside/));
check('B22 a zip with no career is refused', await refuses(writeZip([{ name: 'settings.ini', data: new Uint8Array(3) }]), 'e.zip', /holds no career/));
check('B23 one bad career refuses the whole zip, good ones included', await refuses(writeZip([{ name: `${R}/${A.name}/${A.name}`, data: A.career }, { name: `${R}/${B.name}/${B.name}`, data: B.career.slice(0, 100) }]), 'm.zip', /100 bytes/));
check('B24 an unsafe path is skipped, never used', (await backup.parseRestore(writeZip([{ name: `../${A.name}/${A.name}`, data: A.career }, { name: `${R}/${A.name}/${A.name}`, data: A.career }]), 'u.zip')).skipped.some((s) => s.why === 'an unsafe path'));
const badHead = A.career.slice(); badHead[0x100] ^= 0xff;
check('B27 a career with one changed byte that the shape checks miss is refused by its checksums', await refuses(writeZip([{ name: `${R}/${A.name}/${A.name}`, data: badHead }]), 'h.zip', /checksums do not match/));
const plusOne = new Uint8Array(A.career.length + 1); plusOne.set(A.career);
check('B28 a career one byte too long is not called a magazine cover', await refuses(writeZip([{ name: `${R}/${A.name}/${A.name}`, data: plusOne }]), 'p.zip', /^(?!.*magazine).*54,967 bytes/s));

// ---- Hostile zips (S3 review). A raw writer that can lie about sizes and point two records at one entry.
// entries: [{ name, packed, usize, crc, method }]; central: indexes of entries to list (repeats allowed).
const rawZip = (entries, central = entries.map((_, i) => i)) => {
  const locals = [], at = [];
  let off = 0;
  for (const e of entries) {
    const nb = Buffer.from(e.name), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(e.method, 8);
    h.writeUInt32LE(e.crc, 14); h.writeUInt32LE(e.packed.length, 18); h.writeUInt32LE(e.usize, 22); h.writeUInt16LE(nb.length, 26);
    at.push(off); locals.push(h, nb, e.packed); off += 30 + nb.length + e.packed.length;
  }
  const cds = [];
  for (const i of central) {
    const e = entries[i], nb = Buffer.from(e.name), c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.method, 10);
    c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.packed.length, 20); c.writeUInt32LE(e.usize, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(at[i], 42);
    cds.push(c, nb);
  }
  const cd = Buffer.concat(cds), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
};
const deflate = (data) => new Uint8Array(zlib.deflateRawSync(Buffer.from(data)));
const careerEntry = { name: `${R}/${A.name}/${A.name}`, packed: deflate(A.career), usize: A.career.length, crc: crc32(A.career), method: 8 };
check('B29 the raw writer makes a zip the reader accepts (so the hostile cases below fail for their own reason)', (await backup.parseRestore(rawZip([careerEntry]), 'raw.zip')).profiles.length === 1);
// A career-sized entry that really inflates to 200 MB of zeros: stopped at its declared size, not unpacked whole.
const bombData = deflate(new Uint8Array(200 * 1024 * 1024));
const heapBefore = process.memoryUsage().arrayBuffers;
const bombOk = await refuses(rawZip([{ ...careerEntry, packed: bombData }]), 'bomb.zip', /unpacks to the wrong size/);
const heapGrew = process.memoryUsage().arrayBuffers - heapBefore;
check('B30 a zip bomb entry (career-sized, inflating to 200 MB) is refused without unpacking it whole', bombOk && heapGrew < 64 * 1024 * 1024, `${bombData.length} packed bytes, buffers grew ${Math.round(heapGrew / 1048576)} MB`);
check('B31 two records pointing at the same bytes are refused before anything is unpacked', await refuses(rawZip([careerEntry], [0, 0]), 'twice.zip', /share the same bytes/));
let capMsg = '';
try { await readZip(writeZip([{ name: 'a', data: A.career }, { name: 'b', data: B.career }]), { maxTotal: 100000 }); } catch (err) { capMsg = err.message; }
check('B32 everything unpacked together is capped', /unpacks to more than/.test(capMsg), capMsg);
// A DVD replay whose packed bytes are garbage: never unpacked, so the restore of the career beside it still works.
const junk = { name: `${R}/${A.name} DVD 3/${A.name} DVD 3`, packed: new Uint8Array(4000).fill(0xff), usize: 1048612, crc: 0, method: 8 };
const withJunk = await backup.parseRestore(rawZip([junk, careerEntry]), 'junk.zip').catch((err) => ({ err: err.message }));
check('B33 an entry that is not career or garage sized is listed and skipped unread', withJunk.profiles?.length === 1 && withJunk.skipped.some((s) => /DVD 3/.test(s.path)), withJunk.err ?? JSON.stringify(withJunk.skipped));
const renamed = (name) => {
  const c = A.career.slice(); c.fill(0, 0xd225, 0xd225 + 32);
  for (let i = 0; i < name.length; i++) c[0xd225 + i] = name.charCodeAt(i);
  return recalculateChecksums(c);
};
// A career stores its name one byte per character, so only C1 controls reach it from there; a folder name in a zip is
// UTF-8 and can carry a direction mark.
for (const [label, name] of [['".."', '..'], ['a trailing dot', 'ABC.'], ['a leading space', ' ABC'], ['a C1 control', 'AB\x85C']]) {
  // The sums are rewritten after the rename, so this refusal is the name's, not the checksums'.
  check(`B34 a career file whose inside name has ${label} is refused`, await refuses(renamed(name), 'lone', /no usable profile name/));
}
const rlo = 'AB‮C';
check('B34 a zip folder whose name has a direction mark is refused', await refuses(writeZip([{ name: `${R}/${rlo}/${rlo}`, data: renamed(rlo) }]), 'rlo.zip', /not a profile name the game uses/));
const many = Array.from({ length: backup.MAX_RESTORE_PROFILES + 1 }, (_, i) => `P${i}`);
const manyZip = writeZip(many.map((n) => ({ name: `${R}/${n}/${n}`, data: renamed(n) })));
check(`B35 a restore of ${many.length} careers is refused, naming the ${backup.MAX_RESTORE_PROFILES} cap`, await refuses(manyZip, 'many.zip', /at most 200/));

// ---- Plan: replace by name in any case, add otherwise.
const plan = backup.planRestore(back, [A.name.toUpperCase() === A.name ? A.name.toLowerCase() : A.name.toUpperCase()]);
check('B25 the plan replaces a profile of the same name in any case, keeping the name on disk, and adds the rest', plan.find((p) => p.action === 'replace')?.profile.toLowerCase() === A.name.toLowerCase()
  && plan.find((p) => p.action === 'replace')?.profile !== A.name && plan.filter((p) => p.action === 'add').length === 1);

// ---- Real site backups, read only.
for (const z of siteZips) {
  const r = await backup.parseRestore(new Uint8Array(fs.readFileSync(z)), path.basename(z));
  check(`B26 site backup ${path.basename(z)} restores ${r.profiles.length} career(s), skips ${r.skipped.length} other file(s)`, r.profiles.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
