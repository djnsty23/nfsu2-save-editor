// Runs the ready-made garage allowlist on one copy of src/garage-data.js, such as the one in the store build.
// Usage: node test/check-garage-file.mjs <garage-data.js>      Exit 0 when it may ship, 1 with the problems otherwise.
import { readFileSync } from 'node:fs';
import { checkGarageModuleText } from '../src/garage-designs.js';

const bad = checkGarageModuleText(readFileSync(process.argv[2], 'utf8'));
for (const b of bad) console.log(b);
process.exitCode = bad.length ? 1 : 0;
