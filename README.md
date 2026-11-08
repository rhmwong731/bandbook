# BandBook

A SongBook Pro style chart reader for bands: ChordPro charts with freehand annotations, stored in a shared Google Drive folder. Runs as an offline-capable web app (PWA) today, and is structured so it can be wrapped for iOS and Android next.

## Run it

```bash
cd songbook
npm start          # or: python3 -m http.server 8080
npm test           # ChordPro parser / transposer tests
```

Open http://localhost:8080. It works fully offline and locally without Google; a demo song is loaded on first run.

## New in this version

- **Metronome + count-in**: tempo comes from the chart (`{tempo:}`), your own tempo per song overrides it (personal, synced with your annotations). Tap tempo, 1 or 2 bar count-in, "count-in only", optional auto-scroll after the count-in.
- **Stage view**: big, distraction-free; set prev/next, scroll, zoom, metronome, diagrams and dark page on one floating bar. Esc exits.
- **Chord diagrams** (guitar, ukulele) with **-/+ to choose a voicing**; the choice is remembered per chord and instrument. Diagrams follow your transpose.
- **Nashville / Roman numerals** display (needs a `{key:}`).
- **Set length**: per-song `{duration: m:ss}`, set total, time left while playing, and an optional gap between songs.
- **PDF / image songs**: import charts you already have, annotate them like any other song. They sync to the band folder.
- **Audio per song**: a link (Spotify/YouTube open in a new tab, direct .mp3 links play in the app with speed and loop) or a file attached on this device.
- **Backup / restore** (Settings): one JSON with songs, PDFs, annotations, sets and preferences. Merge (newer wins) or replace.
- **Ready for offline** badge (sidebar): checks the app is cached, songs and PDFs are on the device, nothing is waiting to sync and storage is protected. Tap it for a checklist and a "Protect storage" button.
- Song info dialog (More > Song info) edits title, artist, key, capo, tempo, time, length and audio. For chord charts these are written into the ChordPro directives.

## Features (v0.1)

- **Charts**: ChordPro format (`[Am]` inline chords, `{title:}`, `{key:}`, `{capo:}`, `{tempo:}`, `{comment:}`, verse/chorus/bridge/tab sections).
- **Import**: `.cho`, `.crd`, `.pro`, `.txt`. Plain "chords above lyrics" text is auto-converted. The editor also has a Convert button.
- **Folders**: Originals, Medleys and Covers are created for you; add, rename, delete and collapse your own. Move a song with More > Move to folder. New songs and imports land in the folder of the song you have open. In Drive, each folder is a sub-folder of the band folder, so the whole band sees the same structure, and moving or renaming a folder on one device carries to the others on next Sync.
- **Set lists**: a Sets tab next to Songs. Build a set (Add songs picker, move up/down, remove), then Start set to play it with previous / next buttons and Left / Right arrow keys. "Add to set" in a song's More menu adds it from wherever you are. Sets upload to the band folder as small `.setlist.json` files, so everyone sees the same running order. Each person's transpose and annotations still apply to their own copy.
- **Drag and drop**: grab the dotted handle on a song to drop it onto a folder header (moves it there) or between two songs (reorders within the folder). In a set list, drag a song up or down to change its place. Uses pointer events, so it works with mouse, finger and Apple Pencil, and the list still scrolls normally when you touch anywhere except the handle. Folder moves sync to Drive; the manual order inside a folder is personal to your device, while the running order of a set list is shared.
- **Per-person transpose**, stored with your own annotations (a guitarist and a singer can view the same chart in different keys).
- **Annotations**: pen (pressure-sensitive), highlighter, stroke eraser, typed notes, undo/redo, 5 colours, 3 widths. "Stylus only" mode lets fingers scroll while only Apple Pencil / stylus draws (palm rejection).
- **Auto-scroll**, zoom, print / save as PDF (annotations included).
- **Google Drive sync**, see below.

## How sharing works

| What | Where it lives | Who sees it |
|---|---|---|
| Song charts (`.cho` text files) | One shared Drive folder, with a sub-folder per song folder | Everyone with access to the folder |
| Your annotations + your transpose | Your own hidden app-data area in *your* Drive (`ink-<songId>.json`) | Only you, synced across your devices |
| Set lists (`.setlist.json`) | The band folder (items point at songs by Drive id) | Everyone with access to the folder |
| Personal copy | Local to your device(s) | Only you |

- Edit a chart that's in the band folder and it uploads on next Sync. If someone else changed the same chart meanwhile, **your version is kept as "Title (my edits)"** instead of being overwritten.
- "Make personal copy" detaches a chart so your edits never go back to the band.
- "Download my copy with annotations" exports a `.bandbook.json` bundle you can import elsewhere.
- Annotations are last-write-wins (they are only yours).

## Google setup (about 10 minutes)

1. https://console.cloud.google.com → create a project → **Enable APIs** → *Google Drive API*.
2. **OAuth consent screen** → External → add each bandmate's Google email under **Test users**. Add scopes `.../auth/drive` and `.../auth/drive.appdata`.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Under *Authorized JavaScript origins* add `http://localhost:8080` and, later, wherever you host the app (GitHub Pages, Netlify, etc.).
4. In BandBook: **Settings** → paste the client ID → **Connect Google** → **Create band folder** (or paste an existing folder link) → **Save**.
5. In Drive, share that folder with your bandmates as **Editor**. Each bandmate opens the app, pastes the same client ID and folder link, and hits Sync.

**Scope caveat.** `drive` is a Google "restricted" scope. In *Testing* mode it works for up to 100 named test users, which is plenty for a band. Opening it to the public requires Google's verification process. If you ever want to avoid that, the alternative is the narrower `drive.file` scope plus the Google Picker, where each member explicitly opens the shared folder. That is a contained change in `js/drive.js`.

## Code map

```
index.html, styles.css      UI shell
js/chordpro.js              parse, transpose, chords-over-lyrics conversion, DOM render (tested)
js/ink.js                   canvas annotation layer (pointer events, pressure, undo)
js/diagram.js               chord voicing generator + SVG diagrams (tested)
js/metronome.js             WebAudio look-ahead metronome, tap tempo (tested)
js/docview.js               PDF (pdf.js, lazy) and image pages in the annotation space
js/backup.js                backup / restore (tested)
js/offline.js               the "ready for offline" assessment (tested)
vendor/                     pdf.js 3.11.174 (Apache-2.0), loaded only when a PDF is opened
js/store.js                 IndexedDB (songs, ink, setlists, files) + settings
js/drive.js                 Google Identity Services token flow + Drive REST calls
js/sync.js                  two-way sync, conflict handling, personal annotation sync
js/app.js                   UI wiring
sw.js, manifest.webmanifest offline + installable
```

Annotations are stored as strokes in a fixed 800px-wide page coordinate system, so they stay aligned when you zoom or resize the window.

## Known limits (deliberate for v0.1)

- PDF/image songs: their info (tempo, length, audio) is stored on each device, not in the Drive file. Attached audio files stay on the device. PDF and image text isn't transposable.
- Voicings are generated by an algorithm (best shape first, then up the neck). They are sensible but not hand-curated, so tell me which chords look wrong.
- Scroll-after-count-in uses the existing auto-scroll speed.

- Ink is anchored to the page layout. Editing lyrics or transposing can shift lines by a few pixels, so finish the chart text before heavy annotating.
- No page-turn pedal / tap zones, metronome, or audio yet. A set only shows songs that are in the band folder on other people's devices, so upload songs before sharing a set.
- Sync is manual (button). Deleting a chart locally does not delete it from Drive.
- Google sign-in uses a popup; a token lasts about an hour, then the next Sync re-authorizes silently or with one tap.

## Porting to iOS / Android

Plan: wrap this same code with **Capacitor** (`npm i @capacitor/core @capacitor/cli`, `npx cap add ios android`). Apple Pencil and stylus input already go through Pointer Events, which work in WKWebView and Android WebView.

Things that need native work during the port:
1. **Google sign-in**: the popup flow doesn't work in a webview. Swap `signIn()` in `js/drive.js` for a native Google auth plugin (or an OAuth PKCE flow via the system browser) with iOS/Android client IDs. Everything else in the Drive layer is plain REST and unchanged.
2. **Files**: `download()` / import use browser APIs; Capacitor Filesystem + Share replace them.
3. **Ink**: if web ink latency feels off on iPad, the ink layer is isolated behind `InkLayer` and can be replaced with native PencilKit later without touching the data format (strokes are plain JSON).
