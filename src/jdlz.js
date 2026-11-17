// EA JDLZ decompression, used by nfsu2.xyz for its cached GLOBAL_GlobalB.lzc.
// Header: "JDLZ", 0x02, 0x10, 2 bytes unused, u32 LE decompressed size, u32 LE compressed size.
// Two flag streams: the first picks literal or copy, the second picks the copy encoding.

/** The real GLOBALB.BUN is a few MB. A header claiming more is not the game's file, so it is refused before allocating. */
export const MAX_JDLZ_OUT = 64 * 1024 * 1024;

/** @param {Uint8Array} input @returns {Uint8Array} */
export function decompressJdlz(input) {
  if (!isJdlz(input)) throw new Error('not a JDLZ stream');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const size = view.getUint32(8, true);
  if (size > MAX_JDLZ_OUT) throw new Error(`JDLZ header claims ${size} bytes, more than the ${MAX_JDLZ_OUT} a game file can be`);
  const out = new Uint8Array(size);
  let inPos = 16, outPos = 0, flags1 = 1, flags2 = 1;
  while (inPos < input.length && outPos < out.length) {
    if (flags1 === 1) flags1 = input[inPos++] | 0x100;
    if (flags2 === 1) flags2 = input[inPos++] | 0x100;
    if (flags1 & 1) {
      let back, length;
      if (flags2 & 1) {
        length = (input[inPos + 1] | ((input[inPos] & 0xf0) << 4)) + 3;
        back = (input[inPos] & 0x0f) + 1;
      } else {
        back = (input[inPos + 1] | ((input[inPos] & 0xe0) << 3)) + 17;
        length = (input[inPos] & 0x1f) + 3;
      }
      inPos += 2;
      if (back > outPos) throw new Error(`JDLZ back reference ${back} before start at ${outPos}`);
      const end = Math.min(outPos + length, out.length);
      for (; outPos < end; outPos++) out[outPos] = out[outPos - back];
      flags2 >>>= 1;
    } else {
      out[outPos++] = input[inPos++];
    }
    flags1 >>>= 1;
  }
  if (outPos !== out.length) throw new Error(`JDLZ stream ended at ${outPos} of ${out.length} bytes`);
  return out;
}

/** @param {Uint8Array} b */
export function isJdlz(b) {
  return b.length >= 16 && b[0] === 0x4a && b[1] === 0x44 && b[2] === 0x4c && b[3] === 0x5a && b[4] === 0x02 && b[5] === 0x10;
}
