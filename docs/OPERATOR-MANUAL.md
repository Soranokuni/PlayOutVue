# Aether — Operator Manual

This manual is for on-air operators. It covers the screen, building a rundown, going on air, graphics,
and what to do when something goes wrong. Setup and configuration are in the
[administrator manual](ADMIN-MANUAL.md).

> **Golden rules**
> 1. **Enter and Space never put anything on air.** Use **PLAY**, a row's play button, or *Play from here*.
> 2. **Lock the rundown** while on air (bottom bar, **LOCKED**). It blocks accidental edits, deletes and takes.
> 3. A red or amber chip on the bottom bar is telling you something. Hover it, then read section 8.

---

## 1. The screen

| Area | What it is |
|---|---|
| **Banners** (top) | Appear only when something needs attention: halted advance, engine recovery, media-root mismatch, storage fault. |
| **Media Library** (left) | Every asset from PlayoutTranscode, in virtual folders. Drag the divider to resize; double-click it to reset. **Ctrl+B** folds it into a narrow rail. |
| **Rundown** (centre) | Playlists as tabs. The on-air tab is marked **ON AIR**. |
| **Master Control Bar** (bottom) | Connection, PLAY/STOP, CUT TO LIVE, timecode, NEXT UP, lock, ingest light, media health, settings. |

On a narrow window the bar's utilities fold into a **⋯ More controls** menu, which also has
*Quick guide* and *About Aether*. The **?** button opens the Quick guide.

### Master Control Bar, left to right

1. **Connection chip** — CasparCG state. Click it for the engine menu (Connect / Start / Relaunch / Engine settings…).
2. **MONITOR badge** — shown on a second, read-only Aether instance. On-air controls are disabled there.
3. **PLAY / STOP** — PLAY starts the active playlist from the selected row (or the top). While playing it becomes **STOP**.
4. **CUT TO LIVE** — two-click armed cut to the live input (section 5).
5. **TAKE HELD** strip — appears only when a take failed (section 8).
6. **Timecode** and **NEXT UP** — the next playable item and its duration. **ADVANCE < 10s** warns of the coming change.
7. **LOCKED / UNLOCKED** — rundown lock.
8. **INGEST light** — PlayoutTranscode: green online, amber pulsing = token rejected, red offline.
9. **Media health chip** — the most urgent media problem; hover for all of them, click to open the relevant settings.
10. **Settings**, and the **▶** brand button for system information.

---

## 2. The Media Library

- **Search assets…** searches every folder. **Unrated** shows only assets nobody has classified.
- **Sort**: Name, Duration or Date added; click the active key again to reverse.
- Folders are virtual: moving an asset between folders never moves the file on disk.
  Right-click a folder to give it a colour. **New folder** creates one in the current folder.
- The header shows free disk space (amber below 15 %, red below 5 %).
- A coloured dot on an asset means it is **not** ready:

| Dot | Meaning |
|---|---|
| Red | Ingest error — cannot be played |
| Grey | File missing or no path |
| Blue, pulsing | Still processing / being probed |
| Amber | QC warnings (hover for details) |
| none | Ready |

If PlayoutTranscode is offline, files found in the local media folder appear under **/Unmanaged**.

### Deleting media

Deleting an asset moves it to the **Recycle Bin** (bottom of the folder tree). Open the bin to **Restore** an
item to its folder or **Purge** it for good. Purging is permanent and asks for confirmation. Assets used in a
rundown are protected.

### Trimming and sub-clips

Right-click an asset → **Trim** (scissors icon) opens the **TRIMMER**.

| Key | Action |
|---|---|
| Space | Play / pause |
| J / K / L | Shuttle back / stop / forward (press again for ×4) |
| I or [ | Set IN |
| O or ] | Set OUT |
| ← / → | 1 frame (also , and .) |
| Shift+← / Shift+→ | 10 frames |
| PageUp / PageDown | 25 frames |
| Home / End | Start / end |
| P / Shift+P | Play the selection / play to OUT |
| M | Mute |
| Esc | Close |

- **Save Trim Points** changes the asset's IN/OUT for everyone.
- **Save virtual sub-clip** keeps the asset intact and creates a named sub-clip, added to the end of the active rundown.
- The OUT point must be after the IN point. The waveform and meter help find audio edges.

### Inspector

**Ctrl+I** opens the Inspector for the selected asset or row: QC advisories, media specification,
PlayoutTranscode details, and the compliance panel.

---

## 3. Building a rundown

### Playlists

- **+** creates a new playlist tab. Double-click a tab to rename it.
- **⋮** on the rundown header: *Rename*, *Duplicate*, *Clear all items…*.
- **Delete playlist** (trash icon) is a two-click action: click, then click again within 4 s. A playlist with
  items asks once more, and you can **Undo** for 10 seconds. The on-air playlist and the last playlist cannot be deleted.
- **Ctrl+S** saves a playlist to a `.plx` file, **Ctrl+O** loads one into the active tab,
  **Ctrl+Shift+O** appends one. You cannot load over the on-air playlist while it plays.

Playlists are saved automatically and restored at the next start. On restore, every row is checked against
the library and disk; anything that has gone is marked missing (grey) but kept.

### Adding items

- Drag assets from the library (a cyan marker shows where they land), or double-click an asset.
- **F8** appends the library selection to the end; **Shift+F8** inserts it after the selected row.
- **Live block** (rundown header) adds a planned live segment with a source name and planned duration.
  A live block runs until you take the next item.
- **Hard start** (offline playlists only, on the schedule strip) inserts a planning line at a time of day.
  It changes the planned **At** times only; nothing fires automatically at that time.
- On an offline playlist the **Starts** fields set the planned start day and time for the **At** column.

### Editing

| Key | Action (rundown) |
|---|---|
| ↑ / ↓, PageUp / PageDown, Home / End | Move the selection |
| Shift+↑ / Shift+↓, Ctrl/Shift+click | Extend / multi-select |
| Ctrl+↑ / Ctrl+↓ | Move selected rows up / down (or drag the ⋮⋮ handle) |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / cut / paste after the selection |
| Ctrl+D | Duplicate |
| Delete / Backspace | Remove selected rows (asks first; the on-air row is protected) |
| Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) | Undo / redo |
| Ctrl+K | Command palette — every command by name |
| Esc | Close the top menu or dialog, or clear the selection |

### Reading a row

| Column | Meaning |
|---|---|
| Status dot | Red pulsing = on air · cyan = next · red = error · grey = missing · blue = processing · amber = warnings or unsaved trim · green = ready |
| Flags | Age rating (K/8/12/16/18), TP, content warnings |
| Trim | FULL, `in→out`, LIVE, GAP or HARD START |
| Duration | Trimmed length; counts down on the on-air row, urgent in the last 10 s |
| At | PLAYED, ON AIR, or the planned time |

A **will fail at HH:MM** badge is the look-ahead pre-flight warning that a coming row will not play (missing
file, failed QC, …). Click it and choose **Skip this row** or **Hold before this row**, or fix the media.

### Compliance and classification

Right-click a row (or an asset) to set:

- **Σήματα καταλληλότητας** — age rating K/8/12/16/18 *with* explanation, *badge only*, or *none*.
- **Προειδοποιήσεις περιεχομένου** — Βία, Σεξ, Χρήση Ουσιών, Ακατάλληλη Φρασεολογία, or clear them.
- **Προβολή προϊόντος (TP)** — product placement on/off.
- **Content type** — Movie, Series, Documentary, News, Kids, Spot, Promo, Jingle, Telemarketing.

These are shown on air automatically when the row is taken (section 4).

---

## 4. Going on air

1. Select the first row (or none, to start from the top).
2. Press **PLAY** (or a row's ▶ button, or right-click → *Play from here*).
3. Lock the rundown.

From then on Aether advances automatically and gaplessly: the next clip is preloaded in CasparCG and cut to at
the end of the current one. There is no separate TAKE/NEXT button. To jump, use a row's ▶ (unlock first).

- If you press PLAY on a different tab while another playlist is on air, the old one stops first.
- **STOP** stops playout.
- Rows with an error are skipped automatically. If three advances fail in a row, automatic advance halts and a
  red banner asks for intervention — the channel is left as it is.

### Graphics on air

On every take Aether applies the row's rating, warnings and TP to the advisory graphic (layer 32): the station
logo stays up, the rating and warnings show for 30 s by default. When nothing is playing, the logo-only station ID is shown.

- **Ticker** (rundown header) opens the news crawl drawer. Type the text and press **START CRAWL**.
  Edits while **CRAWL ON AIR** update the crawl live. Press again to take it off.
- The Inspector's compliance panel can trigger, push or clear the advisory overlay by hand.

---

## 5. Live input

**CUT TO LIVE** is armed by the first click (the button reads **CONFIRM CUT (ARMED)** and a ring empties over
3 s). A second click inside 3 s cuts to the live source. While live, the button reads
**LIVE ON AIR (RETURN TO RUNDOWN)**; click it to return. If no live source is configured you will see
*Live Cut Failed* — ask an engineer to set up the DeckLink input.

---

## 6. Status lights at a glance

### Connection chip

| Shows | Meaning | Do |
|---|---|---|
| Connected / Connected · fork (green) | Engine connected (· fork = PlayOut fork engine) | — |
| Starting… (blue) | Engine booting | Wait |
| Stopped / Offline (amber) | Engine not running or not answering | Click → Start / Connect |
| Crashed (red) | Engine died | Usually relaunches by itself; else click → Relaunch |
| Crash loop (red) | Engine crashed > 3 times in 60 s; auto-relaunch paused | Call engineering; click → Relaunch & Reset |
| Not found (red) | Engine path not configured | Call engineering |
| Monitor | This is a read-only second instance | Use the primary instance |

### Media health chip

| Label | Meaning |
|---|---|
| Media root (green) | Media folder verified |
| Media root (weak) / Fallback untested / Fallback not local / Fillers broken (amber) | Degraded — tell engineering |
| Wrong media root / Media root missing / No fallback / Fallback broken (red) | Takes may fail — tell engineering now |
| Library offline (amber) | PlayoutTranscode not answering; playout continues with known media |
| On fillers / On fallback (blue) | The engine is holding air on fillers or the fallback slate |

---

## 7. Fallback and fillers (PlayOut fork engine only)

If the queue runs dry or a clip fails, the engine plays the **fallback** (a slate) or the **filler** folder by
itself — the screen never goes black. The rundown header shows **FINISHED · ON FILLERS** when the rundown has
ended on fillers. Take any row to leave the fillers. On the stock engine, the end of the rundown simply stops.

---

## 8. When something goes wrong

| You see | What happened | What to do |
|---|---|---|
| **TAKE HELD: file** with Retry / Skip / Live | A take you started failed; air is unchanged | **Retry**, **Skip** to the next row, or go **Live** |
| Red banner *Automatic advance halted after 3 consecutive errors* | Three rows failed in a row | Fix or skip the rows, then take the next good row |
| *OFF AIR — engine lost.* | CasparCG crashed | Wait: it relaunches and resumes the clip where it was. If it says *Engine back, playout held*, take a row |
| **PlayOut restarted** dialog | Aether itself crashed or hung and restarted | Choose **Resume**, **Join schedule** or **Stay off air**. If you do nothing, the default runs after the countdown; move the mouse to stop it |
| *CasparCG media path differs* banner | The engine plays from the wrong folder | Stop playback, then **Fix** (restarts CasparCG) — or call engineering |
| Storage banner *Changes are NOT being persisted* | The rundown cannot be saved automatically | **Ctrl+S** to save the playlist to a file now |
| Row with a grey dot | Media missing | Replace it or remove the row before it comes up |
| INGEST light amber | Token rejected | Call engineering (Settings › Media & ingest › API token) |

Small error cards (toasts) at the corner repeat with a ×N counter; close them when read.

---

## 9. Personal settings

**Settings › Appearance**: theme (Broadcast Midnight, Graphite, Engineering Dark, Ember, Studio Light, Paper)
and density (Standard 36 px, Comfortable 40 px, Large 48 px rows). Leave the other sections to engineering.
**Settings › Advanced › Enable debug tools** should stay off on air.
