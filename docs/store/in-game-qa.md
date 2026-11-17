# In-game QA checklist

Every feature below passes its automated checks on test careers: the save is rewritten, read back and validated.
What no test can show is the game itself loading the edited career and showing the change. Five features have never
been driven in the game at all: **Best car**, **Best version of every car**, **Change car** and **Unlock
everything** come first (A to D), and the **Ready-made garage** is section G.

Never run this on your real career. Use a copy, as set up in step 0.

## 0. Set up a copy career (once, about 5 minutes)

1. Open nfsu2.xyz in the Chrome profile you play in, and open its **Saves** tab. Never click **Turn on** there: it
   switches on cloud saves at once, with no prompt.
2. If you already have a copy test profile, use it and skip to step 4. A copy is never your real career.
3. Otherwise make a fresh test profile in the game: press **Play**, create a new profile named `QATEST`, finish the
   first race, then quit to the site. A fresh career has one car, so Change car (test C) is how you get more.
4. Click the extension's toolbar icon. The side panel opens and the status line reads "safe to edit".
5. In the panel's profile list, pick the copy (your copy profile or QATEST). Check that the name in the Career card is the copy's,
   not yours.
6. In the Game data card, click **Read from site cache**. It should read "Loaded". Best car, carbon, Looks, Change
   car and Unlock everything need it.

After every edit: click **Reload nfsu2.xyz** on the panel's message, press **Play**, and load the copy profile.

## A. Best car (one car) - never driven in game

| Step | What you do | What you should see |
|---|---|---|
| A1 | In Cars, open one car and click **Best car**. Wait for "saved" (about 20 seconds). | The History card gains "<car>: best car". |
| A2 | In game, open that car in the customize shop, Performance. | Every performance category at its top level, each unique upgrade installed. |
| A3 | Visual: hood, spoiler, roof scoop, mirrors, body kit. | Carbon fibre versions, Level 3 aero body kit. |
| A4 | Tuning (the setups the game keeps per race type). | A setup is filled in for each race type. A setup you had tuned yourself is unchanged. |
| A5 | Race once (any quick race). | The car drives, no crash, no reset to stock. |
| A6 | In the panel, click **Undo** on the toast or History, reload, play. | The car is back exactly as before A1. |

## B. Best version of every car - never driven in game

| Step | What you do | What you should see |
|---|---|---|
| B1 | Career card: click **Best version of every car**. A progress bar runs, about 20 seconds per car. | "saved", one History entry. |
| B2 | In game, check two or three cars as in A2 to A4. | Same as Best car, on every car. A car that had a tuned setup keeps its parts and that setup. |
| B3 | Race once in two different cars. | Both drive normally. |
| B4 | Undo, reload, play. | Every car back as it was. |

## C. Change car - never driven in game

| Step | What you do | What you should see |
|---|---|---|
| C1 | Open a car, click **Change car**, pick another model (for example a Nissan 350Z), choose **stock**. | "Slot N: <old> to <new>, stock". |
| C2 | In game, open the garage where you pick your car. | The new model in that slot, stock body, stock paint. The other cars are unchanged. |
| C3 | Drive it in a race. | It drives as that model, no crash, the right engine sound. |
| C4 | Change car again on the same slot, this time with **carried over**. | The new model keeps the performance parts, uniques and tuning setups. Body parts, vinyls, decals and neon are gone. |
| C5 | Try a European-only car (Peugeot 106 or Opel Corsa) if your copy is the US release. | The panel warns first. If the game shows a blank or wrong car, note it: that is the region warning working as described. |
| C6 | Undo both, reload, play. | The original car is back in that slot. |
| C7 | On the same slot, Change car to the **Nissan Skyline R34**, stock. Reload, play, load the garage. Then do the same with the **Nissan 240SX**, then the **Peugeot 206**. | Each time: the garage loads, the car is stock with its normal factory paint, and it drives in a race. These three cars are built the same way as the Miata and AE86 the game itself wrote, but only the game can prove them. |

## D. Unlock everything - never driven in game

This finishes the story on the profile. Only ever on the copy.

| Step | What you do | What you should see |
|---|---|---|
| D1 | Scroll to **Ends the career**, click **Unlock everything**, then **Finish the story and unlock**. | "Unlock everything (story finished)" in History. |
| D2 | In game, open the map and the career progress screen. | The story at its last stage, all events completed. |
| D3 | Open the garage and the customize shop. | Every garage slot open, every part and paint listed as available (pearlescent paint and carbon kits included). |
| D4 | Start any race, then quit back to free roam. | No crash, no progress reset. |
| D5 | **Restore original** in History, then **Undo anyway** if asked. Reload, play. | The profile back as it was before your first edit on it. |

## E. The rest (each has been checked on test saves; this confirms the game agrees)

| Feature | Panel | In game |
|---|---|---|
| Money | **Set** a value, or **$9,999,999** | The cash counter shows it. |
| Stage | **Set stage** | The career screen shows that stage. Events from later stages are not completed. |
| Next unlocks | Read the list. Use **Record the wins** if offered. | The listed locks match what the game still shows locked. After Record the wins, carbon body kits for those URL races are available. |
| Max performance | Career card **Max performance** | Every car: top level in every performance category. |
| All unique upgrades | **All unique upgrades** | Every car: each unique installed. |
| All carbon fibre | **All carbon fibre**, or a car's **All carbon** / **All plain** | Hood, spoiler, roof scoop, mirrors and body kit carbon (or plain). |
| Performance per car | A car's Performance tab, change one level | That one category at that level. |
| Looks | A car's Looks tab, change a body part or paint | That part or paint on the car. |
| Setups | A car's Setups tab, **Drag** (or another race type) | That race type's tuning set to the recommended values. |
| Undo | **Undo** on any toast | The game shows the state before that edit. |
| Restore original | History, **Restore original** | The profile as it was before the first edit. |
| Game running | Press Play, then try any edit in the panel | The panel refuses and says the game is running. Nothing is written. |
| Music after closing | Music card, play a song, close the side panel, wait 20 seconds, open it again | The song keeps playing while the panel is closed. The reopened panel shows the same song, about 20 seconds further on, and there is only one copy playing. Pause, then close: the music stops. |
| Offline notice | Read the panel before the first edit | The notice says edited careers are for offline play only, and edits stay locked until you click **I understand: offline only** (once per install). |

## F. Backup and restore

| Step | What you do | What you should see |
|---|---|---|
| F1 | Career section, Backup card: click **Download backup**. | A zip named `nfsu2-saves-<date>_<time>.zip` downloads. |
| F2 | On the site's Saves tab, import that zip with the site's own import. | The site accepts it ("Added ..." or no change for profiles it already has). The two formats are the same. |
| F3 | Make one small edit on the copy (Money). Then in the Backup card, **Restore from file**, pick the F1 zip. | A list per profile: "Replaced" for the copy, showing Money going back, "Already the same" for the rest. Nothing written yet. |
| F4 | Click **Restore**. Reload, play, load the copy. | Money is back to the value from before F3. |
| F5 | Click **Undo the restore of <file>**, reload, play. | The F3 money value is back. |
| F6 | Press Play, then try F3 again. | The panel refuses while the game is running. Nothing is written. |

## G. Ready-made garage - never driven in game

Load the game data first (the Game data card), or the card's buttons stay grey. Only the Corolla's Street X setup has
been driven. Every other car and setup comes from it and the published setups, so G4 is the real test.

| Step | What you do | What you should see |
|---|---|---|
| G1 | Ready-made garage card: on the **Toyota Supra** row, pick a slot holding a car you can spare, click **Apply**. | "Ready-made Toyota Supra into slot N: saved. It replaced the <car>." One History entry. |
| G2 | Reload, play, open the garage. | The Supra in that slot with the ready-made body kit, paint and vinyls. Every other car is unchanged. |
| G3 | Customize shop: Performance, then Tuning. | Every category at Level 3 with its unique, and a setup filled in for each race type. |
| G4 | Race the Supra once each in Circuit, Drag and Drift. | It drives, no crash, no reset to stock. Note any race type where the setup feels wrong (too loose, no grip off the line). |
| G5 | Back in the panel, **Replace my whole garage**. Read the warning, tick **I understand**, click **Replace the garage**. | Before the tick, Replace is grey. The warning lists every slot with the car lost. After it: "10 cars replaced" (or as many as the garage has), money and stage unchanged. |
| G6 | Reload, play, look at two other cars in the garage and race one. | Each holds its ready-made version and drives normally. |
| G7 | **Undo** the replace, then the G1 apply. Reload, play. | The garage is back exactly as before G1. |

## Report back

For each row: pass, or what you saw instead, plus a screenshot of the game screen if something is wrong. A crash or a
stock-reset car in A, B, C, D or G blocks publication until it is fixed.
