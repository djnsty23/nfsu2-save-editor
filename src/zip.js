// A small zip reader and writer, written for the save backup. Nothing is fetched and no library is used.
// The writer stores files uncompressed, as nfsu2.xyz's own Saves > Backup does. The reader takes stored and deflated
// entries (a zip re-packed by Windows or 7-Zip deflates), checks every size and CRC-32, and throws on anything damaged,
// truncated, encrypted or Zip64, so a restore never works from half a file.

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const UTF8_FLAG = 0x0800;

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(ms) {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(1980, d.getFullYear()) - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate(),
  };
}

/** files: [{ name, data: Uint8Array, mtime?: ms }]. Returns the zip as one Uint8Array, every entry stored. */
export function writeZip(files) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), { time, date } = dosTime(f.mtime ?? Date.now());
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true); lv.setUint16(4, 20, true); lv.setUint16(6, UTF8_FLAG, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true); lv.setUint32(22, f.data.length, true); lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_END, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * Unpacks one entry, reading the stream chunk by chunk and stopping as soon as the output passes the size the zip
 * declares, so a small entry that inflates to gigabytes (a zip bomb) costs no more than its declared size.
 */
async function inflateRaw(bytes, size, name) {
  if (typeof DecompressionStream !== 'function') throw new Error(`${name} is compressed and this browser cannot unpack it.`);
  const out = new Uint8Array(size);
  let at = 0, tooBig = false;
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > size) { tooBig = true; await reader.cancel().catch(() => {}); break; }
      out.set(value, at);
      at += value.length;
    }
  } catch { throw new Error(`${name} is damaged inside the zip (it does not unpack).`); }
  if (tooBig || at !== size) throw new Error(`${name} is damaged inside the zip (it unpacks to the wrong size).`);
  return out;
}

/**
 * Reads every file entry of a zip: [{ name, size, data }]. Folder entries are left out. `maxEntrySize` refuses any
 * entry that would unpack larger, before unpacking it, and `maxTotal` caps everything unpacked together. `want(name,
 * size)` picks the entries to unpack: the others come back with `data: null` and cost nothing. Entries may not share
 * or overlap their bytes. Throws a plain-English error on any damage.
 */
export async function readZip(bytes, { maxEntrySize = 8 * 1024 * 1024, maxEntries = 2000, maxTotal = 64 * 1024 * 1024, want = () => true } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw new Error('This is not a zip file (it is too short).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a zip file, or it is cut short (its table of contents is missing).');
  const count = dv.getUint16(end + 10, true), cdSize = dv.getUint32(end + 12, true), cdAt = dv.getUint32(end + 16, true);
  if (count === 0xffff || cdAt === 0xffffffff || cdSize === 0xffffffff) throw new Error('This zip uses the Zip64 format, which the editor does not read.');
  if (count > maxEntries) throw new Error(`This zip holds ${count} files, more than a save backup ever does.`);
  if (cdAt + cdSize > end) throw new Error('This zip is damaged or cut short (its table of contents points past the end).');
  const dec = new TextDecoder();
  const out = [], spans = [];
  let p = cdAt, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('This zip is damaged (its table of contents is broken).');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localAt = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen > end) throw new Error('This zip is damaged (a file name runs past its table of contents).');
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${name} is locked with a password.`);
    if (usize > maxEntrySize) throw new Error(`${name} is ${usize} bytes, far larger than any save file.`);
    if (localAt + 30 > cdAt || dv.getUint32(localAt, true) !== SIG_LOCAL) throw new Error(`${name} is damaged inside the zip.`);
    const dataAt = localAt + 30 + dv.getUint16(localAt + 26, true) + dv.getUint16(localAt + 28, true);
    if (dataAt + csize > cdAt) throw new Error(`${name} is cut short inside the zip.`);
    spans.push({ localAt, dataAt, csize, usize, method, crc, name });
  }
  // Two directory records pointing into the same bytes are how one small entry is unpacked thousands of times, so
  // this is refused before anything is unpacked.
  const byAt = [...spans].sort((a, b) => a.localAt - b.localAt);
  for (let i = 1; i < byAt.length; i++) {
    const prev = byAt[i - 1];
    if (byAt[i].localAt < prev.dataAt + prev.csize) throw new Error(`This zip is damaged: ${byAt[i].name} and ${prev.name} share the same bytes.`);
  }
  for (const { dataAt, csize, usize, method, crc, name } of spans) {
    if (!want(name, usize)) { out.push({ name, size: usize, data: null }); continue; }
    total += usize;
    if (total > maxTotal) throw new Error(`This zip unpacks to more than ${Math.round(maxTotal / 1048576)} MB of files, far more than a save backup.`);
    const raw = bytes.subarray(dataAt, dataAt + csize);
    let data;
    if (method === 0) {
      if (csize !== usize) throw new Error(`${name} is damaged inside the zip (its sizes disagree).`);
      data = raw.slice();
    } else if (method === 8) data = await inflateRaw(raw, usize, name);
    else throw new Error(`${name} is packed with a method the editor does not read (${method}).`);
    if (crc32(data) !== crc) throw new Error(`${name} is damaged inside the zip (its checksum does not match).`);
    out.push({ name, size: usize, data });
  }
  return out;
}
