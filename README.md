# NFSU2 Save Editor for nfsu2.xyz

A Chrome side-panel extension that edits Need for Speed Underground 2 career saves stored by
[nfsu2.xyz](https://nfsu2.xyz) in your browser. It is meant for offline careers.

> **Edited careers are for offline play only.** Use an edited career only in your own offline game. Taking it online,
> into races, leaderboards or anything other players see, is cheating, and nfsu2.xyz can flag or ban the save or your
> account for it.
>
> This editor is a fan tool. It is not made by, endorsed by or connected to EA or nfsu2.xyz.
>
> It comes with no warranty. It keeps a copy of your save before every edit, but keep your own backups too.
>
> The panel shows this notice the first time it opens and writes nothing until you confirm it. A one-line reminder
> stays beside every group of write buttons.

## What it does

- **Profile picker** for every career in the site's save folder.
- **Money**: an exact amount (up to $999,999,999) or one click for $9,999,999.
- **Unlock everything (finishes the story)**: finishes the story, so parts, vinyls and pearlescent paints all unlock.
  Pearlescent stays locked until the career is complete, which is why a money-only edit never showed it. It asks
  first and names what it changes: the stage, the events marked won and the photo goals.
- **Unique upgrades fitted**: one chip per category, "on all 3 cars" or "on 1 of 3 cars", above the story locks.
- **Still locked by the story**: the parts the story keeps shut, as what to win in game, for a career you want to
  keep racing. Each story gate reads only the stage's list of won races or the current stage, so no edit opens one
  without recording races you did not win or moving the stage. On one Stage 5 career, the carbon fibre body kits
  needed 6 more Stage 5 URL race wins and the carbon trunk needed the Final stage.
- **Unlock carbon body kits (records URL race wins)**: on the stage whose URL races gate the carbon fibre body kits
  (Stage 5), records the URL races you have not won as won, and nothing else: the stage, money and every other race
  stay. The first click names the races; the game will count them as won. Untested in game.
- **Max performance**: Level 3 in all nine categories on every garage car, the way the game itself
  installs parts (a higher part replaces the lower one it conflicts with, and owned bits are set).
- **All unique upgrades**: the unique part of every category, on every car.
- **All carbon fibre / All plain**: the same carbon switch on every car at once.
- **Best version of every car**: best parts, uniques, aero, carbon and setups on every car (see Best car).
- **Cars card**, per garage car:
  - each category from Stock to Level 3, or a "Custom mix" when the save holds something else;
  - each category's unique part on or off;
  - "Max this car" and "All uniques" buttons;
  - **Change car**: swaps the model in that slot for any player car in the game data (see Change car);
  - recommended tuning for each of the game's five setups: Circuit, Drag, Drift, Street X and URL.
    The game has no separate Sprint setup.
  - carbon fibre or plain for the hood, spoiler, roof scoop, mirrors and body kit, with "All carbon" and
    "All plain" per car. All five switches always show: one that cannot switch says why, and Plain is
    always offered while any carbon flag is on.
  - **Looks**: every visual slot the game has, in ten tabs: body parts, paint, vinyls, vinyl colours,
    decals, window tint, neon and lights, trunk audio, doors and hydraulics, and gauges. Rims pick a
    style, then a size. Colours show a swatch.
- **Story progress**: move the current stage without finishing the story.
- **History and undo**: every write stores a snapshot first. Undo any step, or restore the original.
- **Music**: plays the game's 27 EA Trax songs in the panel, and checks a folder of your own songs
  against them. See below.

### Carbon fibre

The game data holds a carbon twin of every hood, spoiler, roof scoop and wing mirror: its own part,
the same level and look, marked CARBONFIBRE. A carbon toggle swaps the fitted part for its twin. Bumpers,
side skirts and wide bodies have no twins: the body kit switch sets the four carbon kit flags together
(KIT_, HOOD_, DOOR_ and TRUNK_CARBON), the same four a carbon wide kit sets when you buy it. Carbon on
needs an aftermarket bumper, skirt or wide body. Carbon off is always offered, so a car stuck with the
flags on can be cleared. Stock hoods, spoilers, scoops and mirrors have no carbon version: pick an
aftermarket part under Looks, Body parts first. Carbon reads the same game data file as the presets below.

### Looks

Looks lists every option the game data offers for the car, using the game's own part names. A change
writes through hackch's visual catalogue, so the purchase side effects apply: the rear rims follow the
front, a wide body hides the bumpers and skirts (those rows are locked), and a part that cannot carry
vinyls clears them. Each change is one history entry you can undo. Looks changes are **untested in game**.

### Recommended setups

A preset follows what the best players publish, and fills the rest from the game's own dyno model.

- **Parts:** Level 3 and every unique. On the game's dyno model, measured on 10 cars one category at a
  time, Level 3 weight, engine, turbo and ECU are the fastest on every car and every unique helps or
  changes nothing. Nitrous, suspension, brakes and tires are not in that model: Level 3 follows the players.
- **Transmission, per car:** stock, because speedrunners measured Level 2-3 at about a second slower per
  event and the dyno finds Level 3 slower or within its error on most cars. The two drag record cars, the
  240SX and RX-7, get Level 3: it cuts their dyno quarter mile from 9.60 to 8.91 s and 10.04 to 9.59 s.
  Parts are per car, not per race type, because each setup is tuned against the parts.
- **Camber kit:** it comes off wherever the setup wants the
  highest steering ratio: it lowers that ceiling (Corolla 1.14 to 1.10).
- **Sliders** (suspension, steering, brake bias, tire grip, downforce, nitrous): the Corolla uses Ewil's
  speedrun setups. Every other car uses chilas's Civic setups, the only published set for all five race
  types. Drift on the Corolla uses chilas's drift sliders, since no Corolla drift setup was published.
- **ECU and turbo:** the game's own dyno simulation (a port of hackch's dyno code), aimed at the race
  type's RPM band.
- **Circuit and URL** write the same tuning into both setups: in Career, Sprint and URL races use the
  Circuit tuning.

The panel shows the simulated 0-60, quarter mile and top speed. Presets are **untested in game**.
The dyno model also puts Level 3 transmission ahead over a quarter mile on the Corolla and Peugeot 206.
The presets follow the players' measured times instead and keep the stock transmission there. The ready-made garage
below is different: it is a finished garage played in game, with Level 3 transmission and the camber kit on every car.

### Ready-made garage

The **Ready-made garage** card holds ten finished cars: Miata, Corolla, Skyline R34, 240SX, Peugeot 206, RX-7,
Lancer Evolution VIII, Impreza WRX STi, Supra and 350Z. Each comes with its looks (body kit, paint, vinyls, rims and
every other visual part), Level 3 parts with every unique and the camber kit, and five tuned setups.

- **One car at a time** is the default. Each row picks the slot it goes in: a slot with the same model is updated,
  any other slot gets that model (as Change car does) and is named "replaced". Only that slot changes, and it is
  one Undo entry.
- **Replace my whole garage** is behind a warning. It lists every slot with the car lost, how many tuned setups it
  had and the car that replaces it, offers **Download a backup first**, and writes nothing until the box "I
  understand" is ticked and **Replace the garage** is pressed. Money and story stay as they are. A garage with fewer
  cars than ten gets that many, and the warning names the cars left out.
- It needs the game data file, like Change car. Without it, or with no car in the career, the card says what to do
  and nothing in it can be pressed. A visual part the game data does not list for that car is left as it was and
  named in the toast; everything else still applies.

The tuning starts from one setup played in game, the Corolla's Street X (Ewil's sliders with its own ECU, turbo and
gearing). Every car's Circuit, Street X and URL setups use those slider positions, its Drag setup the Corolla drag
sliders (the Civic ones on the front-drive 206), and its Drift setup chilas's drift sliders. The two heavy rear-drive
cars, the Supra and 350Z, keep the rear ride height stock in the grip setups. The dyno then sets the ECU, turbo and
gearing per race type. A setup tuned by hand in game is kept as it is. The table per car, with the rule each setup
followed, is [docs/garage-defaults.md](docs/garage-defaults.md). Only the Corolla Street X is tested in game.

What ships is derived values only: each car's game data name, part hashes, part flags, unique flags, setup bytes and
the date of the save. No profile name, money, stage or anything else from the career it came from.
`src/garage-designs.js` enforces that with an allowlist, and the generator refuses to write if the career's profile
name appears in the output in any spelling. `tools/garage-refresh.mjs` builds it from a save backup, and
`tools/garage-weekly.ps1` reruns it weekly and commits a change (the store copy changes only with a new version).

### Change car

Each car row has **Change car**. It lists the 31 player cars under their makes and real names, with a search box.
Each says if it is in this slot now, which region sells it, and what the story still asks before it unlocks it (for
example "Win Stage 5 URL race 1"). The 15 traffic vehicles are left out: the game has no garage body data for them.

The stock blocks Change car writes are built from your own GLOBALB.BUN, the way the game builds a car it sells: the
stock performance rating, the car's type hash, its stock body parts from the visual part tables and its factory
paint. No table of game data ships with the editor. A player car your game data cannot build is left out of the list
and named under it as not available. `test/donors.test.mjs` checks the built blocks against cars the game itself
wrote into saves ([docs/m2-donor-study.md](docs/m2-donor-study.md)).

Choose **Start stock** (Stock in every category, no uniques, default setups) or **Carry over what fits** (the part
levels, uniques and tuned setups stay, because every car shares the same nine categories and five setups). Looks
never carry over: the new car gets its own stock body, paint and rims, and vinyls, decals and neon are cleared,
since a part id belongs to one model. Tick **Then apply Best car** to finish with Best car in the same step.
**Preview the change** says what changes and writes nothing. **Change car** writes it as one Undo entry. Only that
slot's record changes: every other slot and the rest of the save stay byte for byte.

In game, a story-locked car loads: a Stage 5 career with its Miata swapped for a Skyline R34 (locked until Stage 5
URL race 1) showed the Skyline in Garage Car Select, slot 1. The story still treats the car as locked, so its shop
and the unlock list do not change. The stock Acura RSX and Subaru Impreza bodies carry a factory paint no shop list
sells, as real saves do; Looks shows it as "Unknown part".

### Best car

**Best car** (per car) and **Best version of every car** (One click) make a car the best version of itself:

- the preset parts above: Level 3, every unique, the per-car transmission, no camber kit;
- Level 3 body-kit aero: where no wide body is fitted, a Level 3 front bumper, rear bumper, side skirt or
  spoiler replaces a lower one. A wide body already gives full aero, so nothing changes there;
- carbon on every part that has a carbon version;
- the research setup for Circuit (also written to URL), Drag, Drift and Street X.

It never overwrites a setup you tuned. A car with any tuned setup keeps its parts, and gets only the uniques, so
your tuning still means what it meant. Paint, rims, vinyls and kits already at Level 3 stay as they are. Where carbon
would remove a vinyl layer (the game clears vinyls a carbon hood or carbon kit cannot carry), that part stays plain. The
toast lists, per car, what changed and what it kept. Every car takes about 20 seconds, up to a minute for a car
with Level 3 gearing. Untested in game.

Presets need the game data file GLOBALB.BUN. The panel reads it from the site's cache once you
have started the game: the site keeps it plain (GLOBALB.BUN) or compressed (GlobalB.lzc), and the
panel unpacks either. You can also choose your own copy. It never leaves your browser.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one holding `manifest.json`).
4. Open <https://nfsu2.xyz> in a tab. Do not press Play.
5. Click the extension's toolbar icon (pin it from the puzzle-piece menu if it is hidden).
   The side panel opens and says "Connected. N profiles, safe to edit."
6. Pick a profile, make your changes, then press **Reload nfsu2.xyz** in the panel before Play.

### Updates from a clone

`node tools/install-hooks.cjs --install-dir "<folder>"` installs git hooks that copy every commit on `main` into
`<folder>`, so load that folder instead of the clone. The installed copy reloads itself within 30 seconds of a
commit, never during a save write, and says "Updated to <hash>" once. Work you have not committed never reaches it,
and nothing in the folder that an export did not write is touched. Each export is logged in
`.git/nfsu2-install.log`.

Chrome names an unpacked extension after its folder, so a copy loaded from a new folder starts with empty storage.
To keep your undo history (each profile's original included), keep the old copy loaded and reloaded, load the new
folder, open its panel once (it says "Brought over the undo history of N profiles"), then remove the old copy.

## Rules it enforces

- It runs only on `https://nfsu2.xyz/*`, with the `storage` and `sidePanel` permissions. No remote code.
- It refuses to write while the game runs in the tab, while another nfsu2.xyz tab holds the saves,
  or when the save changed since it was read.
- Every write is read back and compared by SHA-256.

## Keep it offline

Edited careers are for offline play. Before pressing Play with an edited career:

1. On nfsu2.xyz, open the **Online** tab and untick **Free roam with others**.
   The panel shows a warning while it is on.
2. Leave **Cloud saves** off. The site can see money in cloud saves and online.

## Music

nfsu2.xyz does not ship the EA Trax songs. Its Radio (press F9 in game, then Radio and Music folder, or Settings, Music,
Your music) plays music files from your device and puts your copies of the game's songs in their place. The Music card
checks a folder before you pick it there:

- which of the 27 songs the Radio will find, and which file it will use for each;
- why a file is skipped, with the fix: the artist is missing from an untagged file (rename it "Artist - Title"), it is
  another band's recording, a karaoke or cover version, or a second copy.

The card also plays the EA Trax playlist inside the panel. Spotivibly's player streams each song's full YouTube video
in game order and shows only the video (never smaller than YouTube's 200 by 200 minimum). The panel draws the rest:
the song, a seek bar, previous, play or pause and next. The song list is the playlist: each row plays that song and
shows its folder status (in folder, rename file or missing). The panel talks to the player with Spotivibly's
postMessage API, sends only to spotivibly.com and reads only that frame's messages. It does not fill the game's Radio. **Generate in Spotivibly** opens
Spotivibly's generator in a new tab with the 27-song tracklist and the song count filled in.

Files are read on your device and never leave it. The card follows the Radio's matching rules, checked against the
site with test files (`test/live-music.cjs`):

- The Radio reads tags only from MP3 files with ID3v2.3 or v2.4 tags. Every other file (M4A, FLAC, Ogg, Opus, WAV)
  is matched by its file name and the folders below the one you pick, so "Artist - Title.m4a" or an
  "Artist/Album/01 Title.m4a" layout works and a bare "01 Title.m4a" in the picked folder does not.
- A song matches when its title matches and the game's main artist appears in the tags, the name or the folders.
- The Radio also plays songs inside .zip files. The card does not open zips and says how many it skipped.

The extension has no feature to hide edits from the site, and will not get one.

## Not included

Reputation, sponsor, magazine covers and races won are not editable, apart from the URL race wins above: they were not checked
against a real save. There are no part images: the panel names each unique part, and the game
shows them in its own shop.

## Tests

```bash
node test/jdlz.test.mjs [<GlobalB.lzc> <GLOBALB.BUN>]
node test/ops.test.mjs <GLOBALB.BUN or GlobalB.lzc> <profile dir> [more profile dirs]
node test/unlock-coverage.test.mjs <GLOBALB.BUN or GlobalB.lzc> <profile dir>
node test/url-wins.test.mjs <GLOBALB.BUN or GlobalB.lzc> <profile dir>
node test/car-swap.test.mjs <GLOBALB.BUN or GlobalB.lzc> <profile dir>
node test/music.test.mjs
node test/garage.test.mjs
node test/garage-apply.test.mjs <GLOBALB.BUN or GlobalB.lzc> <profile dir>
node test/live-garage.cjs <playwright module dir> <GLOBALB.BUN> <profile dir> <out dir>
node test/history.test.mjs
node test/live-music.cjs <playwright module dir> <out dir>
node test/live-update.cjs <playwright module dir> <profile dir> <out dir>
node test/live-install.cjs <playwright module dir> <out dir>
node test/live-safety.cjs <playwright module dir> <GLOBALB.BUN> <profile dir> <out dir>
```

`live-update.cjs` and `live-install.cjs` load the extension with `--load-extension`, which branded Chrome 137+
ignores: they default to Edge (set `BROWSER_PATH` for another Chromium browser). They prove the self-update, the
export to an install folder and the one-time history import in throwaway repos and profiles.

`unlock-coverage.test.mjs` lists everything still locked on a profile (garage slots, each car's unlock table,
every story part gate, and per car each carbon conversion: hood, spoiler, roof scoop, mirrors, body kit, trunk)
as saved, after a part-table-only unlock, and after Unlock everything, which must leave nothing locked. It also prints
the story-locked list the panel shows and what Unlock everything would change. `url-wins.test.mjs` checks the carbon
body kit shortcut changes only the URL win-list entries and the checksums, and refuses on other stages.
`car-swap.test.mjs` swaps every player car into a slot, stock and carried over, and checks the new model reads
back with its own core body parts and no other model's parts, no other slot or byte outside that slot changes, the
checksums hold, and traffic, same-car and empty-slot swaps are refused.

`npm test` runs the three suites that need no game files (jdlz, music and history). `history.test.mjs` fills a
store with a size limit and checks undo history makes room by dropping the oldest entries, never an original.

`jdlz.test.mjs` checks the decompressor on built streams; given both files, it also checks the
site's cached .lzc unpacks byte for byte to the plain file. Each profile dir holds the career file
`<NAME>` and `GARAGE.DAT`. Set `REAL_PROFILES=<NAME>` to also
check the level rule against an unedited save. `test/live.cjs` drives the real panel against
nfsu2.xyz in a throwaway headless Chrome profile and checks every action and undo byte for byte.
`live-safety.cjs` plants faults in that setup (a disk write that fails halfway, a tab switch during a long edit,
a crashed computation worker, extension storage filled to its quota)
and checks no edit is lost, nothing can be changed under a running write, and the panel never stays stuck.
`music.test.mjs` builds a test folder of tones synthesized with ffmpeg (no downloaded audio), named and tagged
the ways real libraries are, and checks the card's result. `live-music.cjs` gives that folder to the site's
Radio and to the card in a throwaway headless Chrome profile and checks they find the same songs.

## Credits and license

The save format, unlock tables, part data and dyno model come from
[hackch/NFSU2-Savegame-Editor](https://github.com/hackch/NFSU2-Savegame-Editor) by Christopher Hack,
MIT licensed. His license is in `vendor/hackch/LICENSE`. Change car builds its per-car blocks from the player's own
game data. Need for Speed Underground 2 belongs to
Electronic Arts. This project is not affiliated with EA or with nfsu2.xyz.

This project's own code is MIT licensed, in `LICENSE`. The license covers the code only. The Spotivibly name and
logo (`icons/spotivibly-96.png`) belong to Spotivibly and are not licensed: a fork that ships them, or links its
own build to spotivibly.com as this one does, needs Spotivibly's permission. The save editor works without them, only the music player needs spotivibly.com.
