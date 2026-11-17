// Words for the panel: game part names as people read them, and the make a car name starts with.

// Shop names keep these in capitals: brand initials and part codes, not words.
const KEEP_CAPS = new Set(['OEM', 'AEM', 'APC', 'HKS', 'GTR', 'GT', 'NOS', 'RS', 'SE', 'SR', 'ST', 'TT', 'XL', 'RX', 'TRD', 'VIP', 'JDM', 'USA', 'UK', 'EU', 'II', 'III', 'IV']);
const CARBON = /\s*\bCARBON(?:\s+FIBRE|\s+FIBER)?$/i;

/**
 * A game part name in words, and whether it is the carbon fibre version: "XIMIAN DUAL CARBON FIBRE" becomes
 * { text: 'Ximian Dual', carbon: true }. A name that already has small letters (a colour, a size) stays as it is,
 * apart from the carbon ending. Codes without vowels (HKS, XL) and known initials stay in capitals.
 */
export function partWords(label) {
  const raw = String(label ?? '').trim();
  const carbon = CARBON.test(raw);
  let text = carbon ? raw.replace(CARBON, '').trim() : raw;
  if (!/[a-z]/.test(text)) {
    text = text.split(/(\s+|-)/).map((w) => {
      if (!/[A-Z]/.test(w) || KEEP_CAPS.has(w) || !/[AEIOUY]/.test(w)) return w;
      return w[0] + w.slice(1).toLowerCase();
    }).join('');
  }
  return { text: text || (carbon ? 'Carbon fibre' : raw), carbon };
}

/** The option text for a part: its words, with "carbon" after a dot for the carbon version. */
export const partLabel = (label) => {
  const p = partWords(label);
  return p.carbon && p.text !== 'Carbon fibre' ? `${p.text} · carbon` : p.text;
};

/** The make a display name starts with: "Nissan Skyline GT-R (R34)" is a Nissan. */
export const makeOf = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Other';
