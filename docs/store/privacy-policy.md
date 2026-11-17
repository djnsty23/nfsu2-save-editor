# Privacy policy: NFSU2 Save Editor for nfsu2.xyz

Last updated: 17 November 2026

NFSU2 Save Editor is a Chrome extension that edits the Need for Speed Underground 2 career saves that nfsu2.xyz keeps
in your browser. It is an unofficial fan tool, not affiliated with Electronic Arts or nfsu2.xyz. Edited careers are
for offline play only.

## What the extension handles

- **Your save files.** The editor reads and writes your career saves on nfsu2.xyz, in the site's own browser storage.
  They are never uploaded or sent anywhere.
- **Undo history.** Before every edit the editor keeps a copy of the save, and the first copy of each profile is
  kept as its original. These copies stay in the extension's storage on your computer (`chrome.storage.local`).
  When a profile is deleted in the game and created again under the same name, its old history is set aside, still
  locally, and stays until you uninstall.
- **Game data.** If you load the game's car and story data (GLOBALB.BUN), from the site's cache or from a file you
  choose, the editor keeps the parsed result in the same local storage.
- **Offline-only confirmation.** When you confirm the first-run notice, the editor stores that you confirmed it and
  when, in the same local storage.
- **Backup and restore.** A backup is a zip the panel builds from your saves and hands to your browser as a normal
  download. A restore reads only the file you pick. Neither sends anything anywhere.
- **Music folder check.** If you use "Check a music folder", the editor reads the file names in the folder you pick
  and keeps the result locally: the folder's name and the file paths inside it. It reads names only, never uploads
  them, and keeps no access to the folder.

## What leaves your browser

The extension has no servers, accounts, analytics, advertising or tracking. It sends none of the data above to the
developer or to anyone else.

The music card shows a player from Spotivibly (spotivibly.com) in an iframe, and that player plays YouTube videos.
When you scroll the side panel to the music card, your browser loads that player from Spotivibly and YouTube, as it
would on their own websites, even if you never press play. Their privacy policies cover what they receive, such as your
IP address and their cookies. If a song is playing when you close the side panel, the extension opens a small window
with the same player so the song plays on. Close that window, or pause before closing the panel, to stop the music.
The editor sends the player only play, pause, seek and track commands. It shares no save data and no personal data with it. These two
are the only outside services the extension contacts. If you block spotivibly.com or YouTube, the editor works the
same and the music card offers the Generate link instead of the player.

"Generate in Spotivibly" opens spotivibly.com in a new tab with the game's tracklist in the address. The Spotivibly
link at the bottom of the music card opens spotivibly.com with a `utm_source` tag naming this extension, which tells
Spotivibly the visit came from the extension. Neither link carries anything about you or your saves.

## Removing your data

Uninstalling the extension deletes its undo history and stored game data. Your saves stay on nfsu2.xyz as they were
after your last edit. Use the panel's Restore original before uninstalling if you want your saves back as they were
before your first edit.

## Changes and contact

Changes to this policy are published at this address with a new date. Questions: leave a comment on this page.
