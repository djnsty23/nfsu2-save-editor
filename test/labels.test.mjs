// Part names in words (I16) and makes for the Change car list (I15).
// Usage: node test/labels.test.mjs
import { partWords, partLabel, makeOf } from '../src/labels.js';
import { CAR_NAMES } from '../src/car-names.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('I16 a carbon part reads as words with a carbon tag', eq(partWords('XIMIAN DUAL CARBON FIBRE'), { text: 'Ximian Dual', carbon: true }), JSON.stringify(partWords('XIMIAN DUAL CARBON FIBRE')));
check('I16 the option text puts carbon after a dot', partLabel('XIMIAN DUAL CARBON FIBRE') === 'Ximian Dual · carbon', partLabel('XIMIAN DUAL CARBON FIBRE'));
check('I16 a plain part has no tag', partLabel('XIMIAN DUAL') === 'Ximian Dual' && partWords('STOCK').carbon === false, partLabel('XIMIAN DUAL'));
check('I16 codes without vowels and known initials stay in capitals', partLabel('HKS KIT 02') === 'HKS Kit 02' && partLabel('OEM HOOD') === 'OEM Hood', `${partLabel('HKS KIT 02')} | ${partLabel('OEM HOOD')}`);
check('I16 a name with small letters stays as it is', partLabel('Gloss (level 1) 12') === 'Gloss (level 1) 12' && partLabel('Not set') === 'Not set');
check('I16 hyphenated words are cased on both sides', partLabel('TWIN-TURBO SCOOP') === 'Twin-Turbo Scoop', partLabel('TWIN-TURBO SCOOP'));
check('I16 a part named only CARBON FIBRE keeps a name', partLabel('CARBON FIBRE') === 'Carbon fibre', partLabel('CARBON FIBRE'));
check('I16 the carbon ending is found only at the end', partWords('CARBON STYLE HOOD').carbon === false && partWords('CARBON STYLE HOOD').text === 'Carbon Style Hood');

const players = Object.values(CAR_NAMES).slice(0, 31).map((c) => c.name);
const makes = [...new Set(players.map(makeOf))];
check('I15 every player car has a make from its first word', players.every((n) => makeOf(n) && n.startsWith(makeOf(n))) && makes.includes('Nissan') && makes.includes('Mazda'), makes.join(','));
check('I15 an empty name falls back to Other', makeOf('') === 'Other');

console.log(`\n${pass}/${pass + fail} pass`);
process.exitCode = fail ? 1 : 0;
