# Third-party code, data and services

Everything the extension runs ships inside its package. It fetches no code and no data at runtime: there is no
`fetch`, XHR, `importScripts`, dynamic `import()` or `eval` in any shipped script. The tables below list every piece
that did not start in this repository, what it is used for, and under which terms it ships.

## Vendored code and data

| Item | Source | Licence | Used for |
|---|---|---|---|
| `vendor/hackch/model/*.js` (career, cars, checksum, dyno, layout, perf, save-file, slots, unlocks, visual, nfsu2-web) | [hackch/NFSU2-Savegame-Editor](https://github.com/hackch/NFSU2-Savegame-Editor), Christopher Hack | MIT, text below and in `vendor/hackch/LICENSE` | The save model: offsets, checksums, slot reads and writes, the dyno that tunes presets |
| `vendor/hackch/data/perf-parts.js` | Same | MIT | Performance part ids, levels and uniques |
| `vendor/hackch/data/traffic-cars.js` | Same | MIT | Names of traffic cars |
| `vendor/hackch/data/unlock-table.js` | Same. hackch measured the byte ranges by diffing saves written by NFSU2-ProfileCreator (2006 freeware) | MIT on hackch's file. The ranges are facts about the save format | Next unlocks and Unlock everything |

## Our own

`src/` (including the JDLZ decompressor, the zip reader and writer, car and part labels, and the EA Trax track list,
which holds song titles and artists only), `panel/`, `background.js`, `content.js`, `tools/`, `test/` and the
icons were written for this project.

## Services the panel loads

These are not shipped code. The panel shows them in iframes, and works fully with both blocked.

| Service | When | What it receives |
|---|---|---|
| The music player at `spotivibly.com` (the author's own service) | When the side panel opens | The usual request data a browser sends to any page: IP address, user agent, and that site's own cookies. The panel sends only play, pause and track commands to it |
| YouTube, inside that player | With the player | The same, to YouTube |

Opening "Generate" or the player's own link opens `spotivibly.com` in a new tab, with the track list as the prompt.

## Game files

The extension ships no game files. It reads the GLOBALB.BUN that nfsu2.xyz has already cached in the user's own
browser, or one the user picks. Need for Speed Underground 2 belongs to Electronic Arts. This project is not affiliated
with EA or with nfsu2.xyz.

## MIT licence (hackch)

```
MIT License

Copyright (c) 2025 Christopher Hack

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
