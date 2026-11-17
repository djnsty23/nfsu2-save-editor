# M2 study: building Change car's donor blocks from the player's own GLOBALB.BUN

Status: built. `src/donors.js` implements this map and `test/donors.test.mjs` is its acceptance test. Probe scripts were
read-only and ran against the player's own GLOBALB.BUN. No EA file was downloaded and nothing from the BUN is committed.

## What a donor is

Change car writes three blocks into the slot. Offsets are relative to the slot start (save offset 0x5870 for slot 1):

| Block | Slot range | Contents |
|---|---|---|
| 1 | +0x000 to +0x093 (148 bytes) | 6 header words, then visual slots 0 to 30 |
| 2 | +0x0E0 to +0x11F (64 bytes) | visual slots 50 to 65 |
| 3 | +0x2B0 to +0x2BF (16 bytes) | visual slots 166 to 169 |

Every word except the first six is a visual part hash. That makes 1,843 words across the 31 player cars.

## Where each word comes from

| Words | Source in GLOBALB.BUN | Old table agrees |
|---|---|---|
| +0x00, a float | the car's record in chunk 0x34A31, which holds one record per player car in car-list order. Entry 0 (stock parts) is a float at record +4. It is a performance rating: later 16-byte entries rise as parts are added. | 18/31 exactly. 3000GT and 240SX are 1 ULP higher. Evo VIII is 308.21 against the BUN's 309.39. |
| +0x04, +0x08, +0x0C, +0x10 | constants 1, 4, 1, 0, the same in all 49 table entries | 31/31 |
| +0x14 | the car type hash, from the BUN car list | 31/31 |
| visual slots 0-30, 50-62, 64-65, 166-169 | the visual catalog (hackch's parser over chunks 0x34603-0x3460C): the first level-0 part in the car's own group | 1,697 of 1,767 words, counting the paint below |
| visual slot 63 (base paint) | chunk 0x34600 (car type info): the word 0x77C bytes after the car's type hash | 23/31. The other 8 are not in the BUN at all: Impreza and RSX hold a hash that is no part, and 3000GT a paint that exists nowhere in the file. |

Where M2 and the old table differ, the old table is the one that is wrong.

- Decal slots 52-62 for the Miata, Impreza, Focus and Mustang: the table holds another car's decal set. The Focus and Mustang sets are swapped. The game-bought Miata in a real save holds its own set, which is what M2 builds.
- ColVol slot 169: the same fault for the Sentra, Focus, Mustang, Golf and TT.

## Check against what the game wrote: the 5 measurable cars

"Stock identity" here means the header words plus every visual word the player has not changed. Played words are skipped:

- a part above level 0;
- paint, vinyl and dial colours (63-65, 163-166);
- small or large decal rectangles;
- slots the game derives from a played part: hood underside from the hood, the widebody doors and decals from the widebody, the rear wheel from the front wheel.

| Car | Save | Stock-identity words equal |
|---|---|---|
| Mazda Miata | a site backup of 2026-11-12 13:06, bought in game | 40/40 |
| Toyota AE86 | same backup | 38/38 |
| Nissan Skyline R34 | 2026-11-12 20:22 backup, both profiles | 33/33 |
| Peugeot 206 | same | 33/33 |
| Nissan 240SX | same | 32/33 and 30/31: header +0x00 is 0x4343EC41 in the save, 0x4343EC40 from the BUN (1 ULP) |

## Decisions

1. **The rating float is tested within 1 ULP.** The saves and the old table carry 0x4343EC41 for the 240SX, while the BUN stores 0x4343EC40. Evo VIII is off by 1.18 in the table. The game computes this word rather than copying it, and recomputes it as soon as parts change, so it is parts-derived rather than identity. M2 writes the BUN's stock value. The test accepts header +0x00 within 1 ULP of the game's value, and every other word must be exact. Finding the game's formula is not worth it, because the first part change overwrites the word anyway.
2. **The R34, 240SX and 206 are consistent but not proven.** They first appear in a second profile, which carries $9,999,999 in money. Those three may have been written by a tool using the same donor table. If so, their match only shows M2 equals the table, not the game. The Miata and AE86 are bought in game and match on every word: they are the proof. The other three are checked by hand in the game (the in-game QA checklist has the row). There is no headless car-lot purchase.

Because M2 fixes the old table's faults (decal sets, ColVol 169, the 8 phantom paints), both builds switch to M2 once it passes, and the old table leaves the repo.

## What was built

- `src/donors.js` builds the three blocks per car. The rating comes from the 0x34A31 record, which `parseGameDb` now
  stores per car (game data version 4, so a cached version 3 is read again). The base paint is the word at +0x73C of
  the car's 0x34600 record, which is the same word as "0x77C after the type hash" for all 46 cars.
- A player car is one whose 0x34A31 record rates it above 0. All 31 build; the 15 traffic vehicles, rated 0, do not.
  A player car that cannot be built is left out of Change car's list and named under it as not available. There is no
  fallback to the old table.
- Both builds use M2. `vendor/hackch/data/car-donors.js` is deleted, and the store build still refuses any shipped file
  in the old table's shape.

## The acceptance test

`node test/donors.test.mjs <GLOBALB.BUN> <site backups...>`, 40 checks on the six Downloads backups of 2026-11-12 and 13:

- D1, D2: all 31 player cars build, no traffic vehicle does, and every donor has the three blocks at the right offsets.
- D3: every slot holding a car in every backup, 33 slots across the five cars: every stock-identity word equals the
  built donor, header +0x00 within 1 ULP (Decision 1). Heavily tuned slots keep 26 to 40 stock words, so the floor is 20.
- D4: all five cars are measured. D6: the never-repainted R34, 240SX and 206 carry the built base paint.
- D5: a wrong byte in the body word, a wrong type hash and a rating 2 ULP off each turn the comparison red; 1 ULP passes.

Plants in `src/donors.js` itself, each in a scratch copy: header constant +0x08 changed (36 failures), paint read
4 bytes late (D6 fails), rating read from the second entry (D1 fails). Dropping the own-group rule (first level-0 part
of any group) changes nothing on this BUN, 0 of 5,270 car-slots differ, so that rule is kept as the documented source
but is not exercised by this data.
