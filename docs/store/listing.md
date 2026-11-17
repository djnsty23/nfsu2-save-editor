# Chrome Web Store listing (draft, public listing)

Draft only: nothing here has been uploaded. Field names follow the developer dashboard's Store listing and Privacy
tabs. Build the upload with `npm run build:store`, which writes `dist/store` and `dist/nfsu2-save-editor-<version>.zip`.
Visibility: **Public**. The contact is the policy page, https://gist.github.com/djnsty23/ec2a7dd6acb702f11e46699589866b12, where users leave a comment.

## Store listing tab

**Name** (manifest `name`, 45 characters max): NFSU2 Save Editor for nfsu2.xyz

**Summary** (the manifest `description` as it ships, 132 characters max):
Edit your nfsu2.xyz career saves offline: money, unlock all, performance, unique parts, story stage, with undo.

**Category:** Lifestyle, Games

**Language:** English

**Description:**

> NFSU2 Save Editor edits the Need for Speed Underground 2 career saves that nfsu2.xyz keeps in your browser.
>
> Offline play only. An edited career is for your own offline game. Taking it online, into races, leaderboards or
> anything other players see, is cheating, and nfsu2.xyz can flag or ban the save or your account for it. The panel
> asks you to confirm this before it allows any edit, and a reminder stays beside every group of edit buttons.
>
> This is an unofficial fan tool. It is not made by, endorsed by or connected to Electronic Arts or nfsu2.xyz. It comes
> with no warranty, so keep your own backups.
>
> Open nfsu2.xyz, click the toolbar icon, and the side panel shows your career: name, money, story stage, cars and
> what each car still has locked. Every edit is checked before it is written, waits while the game is running, and
> goes into a history you can undo one step at a time or roll all the way back to your original save.
>
> What it edits:
> - Money and story stage
> - Next unlocks: the story locks still in your way, and the URL race wins that open carbon body kits
> - Per car: performance levels and unique upgrades, carbon fibre parts, body parts and paint, and the five tuning
>   setups the game keeps per car
> - Best car, and Best version of every car: research parts, every unique, Level 3 aero, carbon and a research setup
>   for each race type, keeping any setup you tuned yourself
> - Unlock everything: every garage slot and part, and the whole story finished (it asks first)
> - Ready-made garage: ten finished cars with their looks, Level 3 parts and five tuned setups each. Apply one car to
>   one slot you pick, or replace the whole garage after a warning that lists every car you would lose and offers a
>   backup first
>
> Backup and restore: one button saves every career and its garage as a zip in the same layout as nfsu2.xyz's own
> Saves backup, so either side can restore the other's. A restore shows what it will add or replace and asks first,
> keeps a copy of every profile it replaces, and one Undo puts them all back.
>
> Music: a built-in player plays the game's EA Trax soundtrack (NFSU2, and NFSU1 where available) from public
> YouTube uploads through Spotivibly, and a button opens Spotivibly with the tracklist filled in to make your own
> playlist. If the player is blocked, everything else keeps working.
>
> Your saves never leave your browser. The editor reads and writes them on nfsu2.xyz itself, and its undo history
> stays in the extension's own storage on your computer. There are no accounts, no analytics and no ads.
>
> Some edits read the game's car and story data (GLOBALB.BUN). The panel reads it from the site's cache, or from a
> copy you choose. It never downloads game files from anywhere else.
>
> Open source: the full source is at https://github.com/djnsty23/nfsu2-save-editor (MIT licence), so you can read
> exactly what it does to your saves.
>
> Support: report a problem or ask a question in a comment at https://gist.github.com/djnsty23/ec2a7dd6acb702f11e46699589866b12. Say which button you pressed and what the panel showed.

**Screenshots** (1280x800, from the store build in a headless browser with a test career):
1. `screenshots/1-career.png`: the panel beside nfsu2.xyz, Career and Next unlocks.
2. `screenshots/2-car.png`: one car open on Looks.
3. `screenshots/3-history.png`: an edit saved, with Undo and the history list.
4. `screenshots/4-music.png`: the EA Trax player.
5. `screenshots/5-garage.png`: Replace my whole garage, with every car lost, the backup button and the unticked box.

**Additional fields:**
- Official URL: leave empty (no site of our own is verified for this item).
- Homepage URL: optional. If you set one, use a page you control.
- Support URL: https://gist.github.com/djnsty23/ec2a7dd6acb702f11e46699589866b12

**Small promo tile:** `promo-tile.png` (440x280 PNG).

## Privacy practices tab

**Single purpose:**
Edit, back up and restore the Need for Speed Underground 2 career saves stored by nfsu2.xyz in the user's browser,
with undo.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Keeps the undo history (a copy of each save before every edit, plus each profile's original), the game data the user loaded, the offline-only confirmation and the last music folder check, on the user's computer only. |
| `unlimitedStorage` | The undo history keeps each profile's original save (about 87 KB) for Restore original, and a restore keeps a copy of every profile it replaces. Without it the 10 MB default fills over time and every edit is refused. The data never leaves the computer. |
| `sidePanel` | The editor is a side panel that sits beside the nfsu2.xyz game tab. |
| `offscreen` | Keeps the song the user is playing in the music card going after the side panel closes. Chrome ends the panel's page on close, so the extension opens one hidden page (reason: audio playback) with the same Spotivibly player, only when a song is playing at that moment, and closes it when the panel opens again. It reads and sends no user data. |
| `scripting` | Puts the editor's content script back into nfsu2.xyz tabs that were already open when the extension was installed, updated or re-enabled, so the user does not have to reload the game. Only ever targets nfsu2.xyz tabs, with the extension's own `content.js`. |
| Host `https://nfsu2.xyz/*` | The saves live in nfsu2.xyz's browser storage, so the content script must run on that site to read and write them. No other site is accessed. |

The backup is saved through a normal download link made in the panel, so the extension does not ask for the
`downloads` permission. Restore reads only the file the user picks.

**Remote code:** No, I am not using remote code. All JavaScript ships in the package. The music player is a
cross-origin iframe (spotivibly.com, which embeds YouTube). It runs in its own origin and receives only play, pause, seek and
track commands by postMessage. The same player runs in the offscreen page while a song plays on after the panel closes.

**Data usage** (what the dashboard asks the developer to disclose as collected):
none of the listed categories. The extension reads save files on nfsu2.xyz and keeps undo copies in
`chrome.storage.local`. Nothing is sent to the developer or to any server the developer runs.

Certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://gist.github.com/djnsty23/ec2a7dd6acb702f11e46699589866b12
