// Backup and restore of careers in the same zip layout nfsu2.xyz's Saves tab uses, so each side reads the other's:
//   NFS Underground 2/<profile>/<profile>    the career, 54,966 bytes, starting "20CM"
//   NFS Underground 2/<profile>/GARAGE.DAT   the web version's garage for slots 6 to 10, 10,202 bytes, starting "N2GA"
// A backup holds those two files per career and nothing else, which the site's Restore reads as "profiles" and adds or
// replaces one by one. The site's own full backup also holds settings.ini, registry.txt, magazine covers and DVD
// replays: a restore here takes only the careers and their garages out of it and lists everything it leaves.
import { readZip, writeZip } from './zip.js';
import { validateWrite } from './ops.js';
import { verifyChecksums } from '../vendor/hackch/model/save-file.js';

// The smallest magazine cover the game writes is 196,644 bytes, a DVD replay 1,048,612: only a file that large is named as one.
const MEDIA_MIN = 196644;

export const ROOT_DIR = 'NFS Underground 2';
export const CAREER_SIZE = 54966;
export const GARAGE_SIZE = 10202;
const NAME_AT = 0xd225, NAME_LEN = 32;
const NAME_OK = /^[^\\/:*?"<>|\x00-\x1f]{1,31}$/;
// A name a restore may create: also no "." or "..", no leading or trailing space or dot, and no invisible or
// direction-changing characters that could disguise it in the confirm list. content.js holds the same check.
const NAME_SAFE = (s) => NAME_OK.test(s) && !/^[ .]|[ .]$/.test(s) && !/[\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/.test(s);
// The most profiles one restore writes; content.js refuses more.
export const MAX_RESTORE_PROFILES = 200;
// The game's magazine covers and DVD replays sit in folders beside the careers ("Zorblax77 Magazine 7", "Zorblax77 DVD 3").
const MEDIA = / (Magazine|DVD) \d+$/i;
const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
const startsCareer = (b) => b.length >= 4 && b[0] === 0x32 && b[1] === 0x30 && b[2] === 0x43 && b[3] === 0x4d;
const lower = (s) => s.toLowerCase();
const fmt = (n) => n.toLocaleString('en-US');

/** The profile name the game wrote inside a career. */
export function careerName(career) {
  let s = '';
  for (let i = NAME_AT; i < NAME_AT + NAME_LEN && career[i]; i++) s += String.fromCharCode(career[i]);
  return s;
}

/** nfsu2-saves-2026-11-14_153012.zip, local time, as the site names its backups. */
export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `nfsu2-saves-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.zip`;
}

/** profiles: [{ name, career, garage|null }]. Returns the zip bytes. */
export function buildBackup(profiles, mtime = Date.now()) {
  const files = [];
  for (const p of [...profiles].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!NAME_OK.test(p.name)) throw new Error(`${p.name} is not a profile name the game uses.`);
    validateWrite({ career: p.career, garage: p.garage ?? null });
    files.push({ name: `${ROOT_DIR}/${p.name}/${p.name}`, data: p.career, mtime });
    if (p.garage) files.push({ name: `${ROOT_DIR}/${p.name}/GARAGE.DAT`, data: p.garage, mtime });
  }
  if (!files.length) throw new Error('There is no career to back up.');
  return writeZip(files);
}

function checkCareer(label, career, garage) {
  if (career.length !== CAREER_SIZE) {
    const media = startsCareer(career) && career.length >= MEDIA_MIN ? ' It looks like a magazine cover or DVD replay, not a career.' : '';
    throw new Error(`${label} is ${fmt(career.length)} bytes, but a career save is ${fmt(CAREER_SIZE)} bytes.${media}`);
  }
  if (garage != null && (garage.length !== GARAGE_SIZE || garage[0] !== 0x4e || garage[1] !== 0x32 || garage[2] !== 0x47 || garage[3] !== 0x41)) {
    throw new Error(`The GARAGE.DAT beside ${label} is ${fmt(garage.length)} bytes or has the wrong signature, expected ${fmt(GARAGE_SIZE)} bytes starting N2GA.`);
  }
  try { validateWrite({ career, garage: garage ?? null }); } catch (err) { throw new Error(`${label} is not a valid career save (${err.message}).`); }
  // The game checks these too: a career whose stored checksums do not match its bytes is damaged, and is refused here
  // rather than written over a good one.
  const sums = verifyChecksums(career);
  if (!sums.blockA || !sums.blockB || !sums.header) throw new Error(`${label} is damaged: its checksums do not match its contents.`);
}

/** A path inside the zip as folder parts, or null when it is unsafe (absolute, "..", control characters). */
function parts(name) {
  const t = name.replace(/\\/g, '/');
  if (t.startsWith('/') || /^[A-Za-z]:/.test(t)) return null;
  const s = t.split('/').filter((x) => x !== '' && x !== '.');
  return !s.length || s.some((x) => x === '..' || /[\x00-\x1f]/.test(x)) ? null : s;
}

/**
 * Reads a restore file: a zip (ours or the site's) or one career file. Returns
 * { kind: 'zip'|'career', profiles: [{ profile, career, garage }], skipped: [{ path, why }] }, where garage is null
 * when the file brings none. Throws on the first problem, naming it: a restore writes all of it or nothing.
 */
export async function parseRestore(bytes, fileName = 'the file') {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error(`${fileName} is empty.`);
  if (!isZip(bytes)) {
    if (!startsCareer(bytes)) throw new Error(`${fileName} is neither a zip nor a career save.`);
    checkCareer(fileName, bytes, null);
    const profile = careerName(bytes);
    if (!NAME_SAFE(profile)) throw new Error(`The career in ${fileName} has no usable profile name inside.`);
    return { kind: 'career', profiles: [{ profile, career: bytes, garage: null }], skipped: [] };
  }
  let entries;
  // Only an entry of a career's or a garage's exact size is unpacked: everything else is listed and skipped unread.
  try { entries = await readZip(bytes, { want: (_name, size) => size === CAREER_SIZE || size === GARAGE_SIZE }); } catch (err) { throw new Error(`${fileName} could not be read: ${err.message}`); }
  const skipped = [];
  const paths = [];
  for (const e of entries) {
    const p = parts(e.name);
    if (!p) { skipped.push({ path: e.name, why: 'an unsafe path' }); continue; }
    paths.push({ p, data: e.data, size: e.size, path: e.name });
  }
  // A zip re-packed around one top folder ("backup/NFS Underground 2/...") loses that folder, as on the site.
  const top = paths.length && paths.every((x) => x.p.length > 1 && x.p[0] === paths[0].p[0]) && lower(paths[0].p[0]) !== lower(ROOT_DIR) ? paths[0].p[0] : null;
  const dirs = new Map();
  for (const x of paths) {
    let p = top ? x.p.slice(1) : x.p;
    if (lower(p[0]) === lower(ROOT_DIR)) p = p.slice(1);
    if (p.length === 1) { skipped.push({ path: x.path, why: 'site settings and files outside the profiles are not restored' }); continue; }
    if (p.length !== 2) { skipped.push({ path: x.path, why: 'not in a profile folder' }); continue; }
    const [dir, file] = p;
    if (MEDIA.test(dir)) { skipped.push({ path: x.path, why: 'a magazine cover or DVD replay, not a career' }); continue; }
    const d = dirs.get(lower(dir)) ?? { dir, career: null, garage: null, paths: [] };
    dirs.set(lower(dir), d);
    if (lower(file) === lower(dir)) {
      if (d.career) throw new Error(`${fileName} holds two careers for ${dir}.`);
      if (!x.data) throw new Error(`${dir}/${file} is ${fmt(x.size)} bytes, but a career save is ${fmt(CAREER_SIZE)} bytes.${x.size >= MEDIA_MIN ? ' It looks like a magazine cover or DVD replay, not a career.' : ''}`);
      d.career = x.data; d.paths.push(x.path);
    } else if (lower(file) === 'garage.dat') {
      if (d.garage) throw new Error(`${fileName} holds two GARAGE.DAT files for ${dir}.`);
      if (!x.data) throw new Error(`The GARAGE.DAT beside ${dir}/${dir} is ${fmt(x.size)} bytes or has the wrong signature, expected ${fmt(GARAGE_SIZE)} bytes starting N2GA.`);
      d.garage = x.data; d.paths.push(x.path);
    } else skipped.push({ path: x.path, why: 'only the career and GARAGE.DAT are restored' });
  }
  // Counted before any career is checked, so a zip of thousands costs nothing to refuse.
  const careers = [...dirs.values()].filter((d) => d.career).length;
  if (careers > MAX_RESTORE_PROFILES) throw new Error(`${fileName} holds ${careers} careers. One restore takes at most ${MAX_RESTORE_PROFILES}.`);
  const profiles = [];
  for (const d of dirs.values()) {
    if (!d.career) { for (const path of d.paths) skipped.push({ path, why: 'a GARAGE.DAT with no career beside it' }); continue; }
    const label = `${d.dir}/${d.dir}`;
    if (!NAME_SAFE(d.dir)) throw new Error(`${d.dir} is not a profile name the game uses.`);
    checkCareer(label, d.career, d.garage);
    const inside = careerName(d.career);
    if (lower(inside) !== lower(d.dir)) throw new Error(`The career in folder ${d.dir} is named ${inside || '(nothing)'} inside. Nothing was restored.`);
    profiles.push({ profile: d.dir, career: d.career, garage: d.garage });
  }
  if (!profiles.length) throw new Error(`${fileName} holds no career save.`);
  profiles.sort((a, b) => a.profile.localeCompare(b.profile));
  return { kind: 'zip', profiles, skipped };
}

/**
 * What a restore does per profile, given the names that exist now: replace the profile of the same name (in any case,
 * keeping the name on disk) or add it as a new profile.
 */
export function planRestore(parsed, existingNames) {
  const have = new Map(existingNames.map((n) => [lower(n), n]));
  return parsed.profiles.map((p) => (have.has(lower(p.profile))
    ? { ...p, profile: have.get(lower(p.profile)), action: 'replace' }
    : { ...p, action: 'add' }));
}
