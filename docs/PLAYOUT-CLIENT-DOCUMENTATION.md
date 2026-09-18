# PlayoutTranscode — client integration guide for PlayOut

**Audience:** whoever is changing the PlayOut (Tauri/Vue) client.
**Service version:** 1.0.0, PR #1 (`remediation/tier-2-and-3`) @ `be843ad`,
2026-09-18.
**Status of this document:** complete and current. It supersedes
`docs/audit-2026-09-15/PLAYOUT-CLIENT-CHANGES.md`, which was written
incrementally as each remediation step landed and is now only useful as history.

---

## 0. Read this first

A security and reliability remediation landed on the whole of PlayoutTranscode.
None of it was done in the PlayOut repository. This document tells you exactly
what to change and what happens if you do not.

> **Update, 2026-09-18 — a second change set has landed.** It was speed and
> UI/UX work on PlayoutTranscode, and almost none of it reaches you. Two items
> do, and both are new in this document:
>
> - **§8.7 — a newly ingested asset is now unrated (`NONE`), not `K`.** A
>   behaviour change, not a wire change; nothing you parse moves. It does make
>   one existing PlayOut bug matter a great deal more, and that bug loses
>   operator data today: **§7.2.1**.
> - **§4.1 — `GET /api/assets` now carries an `ETag`.** Entirely optional.
>
> Items 1–6 in the table below are unchanged and still outstanding.

**The short version.** There are **two mandatory one-line changes**, both in
`src-tauri/src/ingestor_api.rs`. Everything else is optional, informational, or
a mapping table. The document is long because it explains *why*, not because
there is a lot of work.

Two facts that bound the scope, both verified against your source:

- PlayOut calls **twelve** endpoints. They are listed in §1. Anything not on
  that list is not your problem, however much of this document discusses it.
- Of the eight endpoints that now require a confirmation header, PlayOut calls
  **one** (`purge`).

### The whole change set, ranked

| # | Change | Effort | If you skip it |
|---|---|---|---|
| 1 | `X-Confirm-Destructive: yes` on purge | 1 line | Purge returns 428 and does nothing |
| 2 | `X-Api-Token` on every call | 1 line + a settings field | Everything except health returns 401 — **only** if an operator sets a token |
| 3 | Page `GET /api/assets` | ~20 lines | Library silently truncates at 1000 assets |
| 4 | Map four new `error_category` values | A match arm | A skipped duplicate is shown as a red failure |
| 5 | Handle the `skipped` and `resync` SSE events | ~6 lines | Stale job list after a dropped connection |
| 6 | Handle 503 from regenerate-sidecar | error branch | A confusing error message |
| 7 | Send the **whole** rating string, not just the age token (§7.2.1) | ~3 lines, 3 call sites | Content type and the advisory timeline are silently lost on every save — **already happening** |
| 8 | Show "unrated" in the library (§8.7) | UI | Nobody can see which new ingests still need classifying |
| 9 | Patch one asset after a mutation instead of refetching the library (§4.1) | ~10 lines | ~1 MB re-downloaded per trim/rating/rename |

Changes 1 and 2 are the mandatory ones. Change 3 becomes mandatory the day a
station's library passes 1000 assets. **Change 7 is a data-loss bug and is the
most urgent thing in this table** — it predates both change sets, but §8.7 turns
it from rare into routine.

---

## 1. The endpoints PlayOut actually calls

From `src-tauri/src/ingestor_api.rs`:

| Endpoint | Method | Changed? |
|---|---|---|
| `/api/health` | GET | No. Still cheap, still exempt from auth |
| `/api/assets` | GET | **Yes — now paginated (§4)**; optional `ETag` (§4.1) |
| `/api/assets/{uuid}` | GET | No; optional `ETag` (§4.1) |
| `/api/assets/batch` | POST | No |
| `/api/assets/{uuid}/rating` | PUT | Bounded at 4 KiB (§7.2) |
| `/api/assets/{uuid}/tp` | PUT | Grammar-checked (§7.1) |
| `/api/assets/{uuid}/trim` | PUT | No |
| `/api/assets/{uuid}/subclip` | POST | No |
| `/api/assets/{uuid}/rename` | PUT | No |
| `/api/assets/{uuid}/move` | PUT | No |
| `/api/assets/{uuid}/purge` | DELETE | **Yes — needs a header (§2)** |
| `/api/folders/colors` | PUT | Allow-listed (§7.3) |

PlayOut does **not** call `/api/service/*`, `/api/jobs/*`, `/api/config`,
`/api/events`, `/api/db/*`, or any folder trash/restore/purge route. Those are
the web UI's. If you later add any of them, §8 is where their contracts are
written down.

---

## 2. Mandatory: the confirmation header on purge

**One line.** In `purge_ingestor_asset`:

```rust
let response_res = client
    .delete(&url)
    .header("X-Confirm-Destructive", "yes")   // <-- add this
    .send()
    .await;
```

### Why

Destructive routes now require `X-Confirm-Destructive: yes` and otherwise return
`428 Precondition Required` with `{"error":"confirmation_required"}`. The value
is matched case-insensitively with surrounding whitespace ignored; any other
value (including `no`) does not arm the operation.

The reason is not that anyone distrusts PlayOut. It is that an unauthenticated
`DELETE /api/assets/{uuid}/purge` was reachable from a malicious web page via a
simple form post, and a header that a cross-origin form cannot set is what
closes that. PlayOut already prompts the operator natively before a purge, so
the second factor costs you nothing.

### The full list of gated routes, for reference

`DELETE /api/assets/{uuid}/purge` (**yours**), `DELETE /api/folders/purge`,
`DELETE /api/recycle-bin/purge`, `POST /api/recycle-bin/auto-purge`,
`POST /api/folders/trash`, `POST /api/jobs/retry-failed`, `PUT /api/config`,
`POST /api/service/stop`. Both the `/api/...` and `/api/v2/...` forms are gated.

Reads and reversible operations — restore, rename, move, trim, subclip, rating,
tp — are **not** gated. Only purge affects you.

### Also worth knowing

Every destructive request is written to `<data_dir>\logs\audit.log.<date>` with
the method, path, **caller address** and resulting status:

```json
{"timestamp":"2026-09-16T18:21:41.252824Z","level":"WARN",
 "fields":{"message":"destructive operation","op":"DELETE",
 "path":"/api/recycle-bin/purge","remote_addr":"127.0.0.1:58051","status":200},
 "target":"audit"}
```

"Who emptied the recycle bin?" now has an answer, and if several clients share
one service the address in that line is PlayOut's.

---

## 3. Mandatory: the API token

**One line on the shared client, plus a settings field.**

```rust
fn build_client() -> Result<reqwest::Client, String> { ... }   // unchanged

// At each call site, or better: a helper that every request goes through.
req = req.header("X-Api-Token", &token);
// `req.bearer_auth(&token)` is accepted too. Pick one.
```

Add `settings.ingestorApiToken: String` (default empty) to the settings model
and a field for it in the ingest settings UI. **Treat it as a secret:** mask it,
and never write it to the diagnostics log — note that several of your error
paths currently log the response body verbatim, which is fine because no error
body carries the token, but do not start logging request headers.

### When it matters

`server.api_token` in `config.toml` is empty by default, and while it is empty
the service behaves exactly as it does today. An operator generates one with:

```
PlayoutTranscode gen-token
```

The moment they do, every `/api/**` call without the token returns
`401 {"error":"unauthorized"}`.

They are *forced* to set one if they move the service off loopback:
`bind_address` other than `127.0.0.1` is **refused at startup** unless a token
is configured. That rule exists because the pre-remediation default bound
`0.0.0.0` with no authentication of any kind, which exposed purge and config
writes to the whole LAN.

### Exempt from the token

| Endpoint | Why |
|---|---|
| `GET /api/health` | Your 5 s liveness poll must work before configuration |
| `GET /api/v2/health` | same |

Static files (the bundled web UI) are also exempt. Sending the token to health
is harmless.

**Check order:** authentication runs before confirmation. A purge with the
confirmation header but no valid token returns 401, not 428, and does not
execute.

---

## 4. `GET /api/assets` is now paginated

This is the change most likely to bite silently.

### What changed

```
GET /api/assets?limit=1000&offset=0&fields=full
```

| | Before | Now |
|---|---|---|
| Rows returned | all of them | `limit`, default **1000**, max **5000** |
| `keyframe_offsets` | full array on every row | `[]` unless `?fields=full` |
| Total count | — | `X-Total-Count` response header |
| Applied paging | — | `X-Limit`, `X-Offset` response headers |

The body is still a bare JSON array and every field is still present, so
`serde_json::from_str::<Vec<AssetResponse>>(&body)` keeps working unchanged.
That is precisely the danger: **your current code will parse a 1000-row response
happily and show the operator a library missing everything after it.**

### Why

The listing fetched every live row and serialised all of it, including
`keyframe_offsets` — 400 offsets for a half-hour programme at a 4 s GOP, tens of
kilobytes per row. A library of a few thousand produced a response larger than
PlayOut's own 16 MiB cap, so the client failed to load the library it was
pointed at, and the failure looked like a network error rather than a size one.

### What to do

Page in `list_ingestor_assets`. Sketch:

```rust
const PAGE: usize = 1000;
let mut all: Vec<AssetResponse> = Vec::new();
let mut offset = 0usize;

loop {
    let url = format!("{}/api/assets?limit={}&offset={}", base_url, PAGE, offset);
    let response = client.get(&url).send().await.map_err(...)?;

    // A pre-T2-7 service sends no X-Total-Count and no limit: the first
    // response is already the whole library.
    let has_paging = response.headers().contains_key("X-Total-Count");

    let body = response.text().await.map_err(...)?;
    let batch: Vec<AssetResponse> = serde_json::from_str(&body).map_err(...)?;
    let n = batch.len();
    all.extend(batch);

    if !has_paging || n < PAGE { break; }
    offset += n;
}
```

Two details worth keeping:

- **Bound the loop.** A server that keeps reporting a total it never delivers
  should not spin forever. Cap it at, say, 100 iterations.
- **Do not send `?fields=full` on the listing.** That reinstates the response
  size this change exists to remove. Keyframe offsets belong on the per-asset
  hydration path, which already has them (below).

### What did *not* change

`GET /api/assets/{uuid}` and `POST /api/assets/batch` still return the **full**
`keyframe_offsets` array. That is deliberate: those are the calls PlayOut's
per-asset hydration uses to trim against keyframe boundaries, and breaking them
would break trimming. If your client currently reads `keyframe_offsets` off the
list response, move that read to the resolve response — it is the correct place
for it regardless of this change.

Ordering is by `uuid` and is stable across requests, so a concurrent ingest
cannot shuffle a row you have already seen onto the next page.

Out-of-range and unparseable values clamp rather than erroring: `?limit=0`
becomes 1, `?limit=999999` becomes 5000, `?limit=abc` becomes the default. A
request always returns data.

### 4.1 Optional: `ETag` and `If-None-Match`

`GET /api/assets` and `GET /api/assets/{uuid}` now send a weak `ETag` and
`Cache-Control: no-cache`. **Nothing is required of a client.** Ignore the
header and you get the same 200 and the same body as before.

If you do use it: keep the last `ETag` per request URL, send it back as
`If-None-Match`, and on `304 Not Modified` reuse the page you already have. The
304 carries no body but does carry `X-Total-Count`, `X-Limit` and `X-Offset`,
so paging still works from a cached page.

The validator is derived from the response body itself, so it changes exactly
when the bytes change -- a rating, trim, rename, move, trash or a finished
ingest all produce a new one. A different `limit`/`offset`/`status`/`fields`
combination is a different resource with its own validator; do not share one
across URLs.

This is worth wiring up where PlayOut force-refetches the whole library after
every single-asset mutation (`MediaLibrary.vue`, after trim/rating/rename/move).
Better still, patch that one asset from `GET /api/assets/{uuid}` and leave the
library listing alone.

---

## 5. Job records and `error_category`

PlayOut does not currently read `/api/jobs`, so this section is only relevant if
you surface ingest status. Skip to §6 if you do not.

### 5.1 A retry reuses the job id

`POST /api/jobs/{id}/retry` used to mark the old record re-queued and then
create a **brand-new** job for the same file. The old record stayed `Pending`
forever, so every retry permanently added a phantom pending job to the list and
to `/api/stats`.

The retry now reuses the same record: the `id` you retried is the `id` that
runs, and `created_at` is preserved. Two consequences:

- If anything keys off "a retry produces a new job id", it now sees the same id
  transition `Pending → Processing → …` again.
- **Pending counts will drop on upgrade** for any installation that has been
  retrying. That is phantom work disappearing, not lost work.

### 5.2 The `error_category` values to map

Four of these are new. Map them to operator-facing wording:

| `error_category` | Meaning | Suggested wording |
|---|---|---|
| `source_missing_on_recovery` | Job was pending across a restart; source file is gone | "Source file no longer available" |
| `fingerprint_failure` | Source could not be read | "Could not read the source file" |
| `path_outside_watch_folder` | Input resolved outside the watch folder | "File is not in the watch folder" |
| `db_insert_failed` | Registry entry could not be created; nothing was transcoded | "Could not register the file — check the service log" |
| `db_mark_ready_failed` | Encoded successfully, registry would not record it; **the mezzanine is in `<target>\quarantine\`** | "Transcode finished but could not be saved — see quarantine" |
| `sidecar_write_failed` | Encoded successfully, sidecar could not be written; also quarantined | as above |
| `io_disk_full` | Not enough free space | "Not enough disk space" |
| `probe_failure` | ffprobe could not read the stream layout | "Could not probe the file" |
| `audio_measurement_failure` | The loudness pass did not complete | "Audio measurement failed" |
| `profile_disabled` | The profile this file maps to is turned off | "Profile disabled in configuration" |
| `validation_failure` | The encode finished but failed output QC | "Failed quality checks" |
| `transcode_failure` | FFmpeg exited with an error | "Encode failed" |
| `publish_failure` | The encoded file could not be moved into the target folder | "Could not publish the encoded file" |
| `retryable_error` | Transient; the job will be attempted again | "Retrying" |
| `cancelled` | An operator cancelled the job; nothing was published | "Cancelled" |
| `duplicate_skipped` | **Legacy — see 5.3.** No longer produced | — |

The web UI renders this same table from `web-ui/src/lib/errorCategories.ts`.
If a category is added on the server, update both in the same commit; an
unknown token falls back to being shown raw in both places.

The three `db_*` / `sidecar_*` categories mean an encoded file exists in
`<target>\quarantine\` that nothing references. An operator needs to know that,
because the work was done and only the bookkeeping failed.

> **If you have ever seen `path_outside_watch_folder` for a file that was
> plainly inside the watch folder, that was a bug and it is fixed.** The
> containment check compared the input path against the watch root, and a file
> deleted between the watcher offering it and the worker picking it up could not
> be resolved to the same spelling — so it was reported as a path-traversal
> attempt rather than a missing source. It only misfired where the environment's
> spelling of a directory differs from its canonical one (8.3 short names,
> junctions, mapped drives), which is why it survived so long. Those cases now
> correctly report `fingerprint_failure`. If you special-cased or suppressed
> `path_outside_watch_folder`, you can stop.

### 5.3 A duplicate is no longer reported as a failure

An earlier step reported a skipped duplicate as `state: "Failed"` with
`error_category: "duplicate_skipped"`, because the job phase machine had no
non-error terminal state reachable from a queued job. **That is fixed.** There
is now a `Skipped` phase:

```json
{ "state": "Completed", "phase": "skipped",
  "uuid": "<the asset that already holds this content>",
  "error": "Skipped: an identical asset is already ingested" }
```

`state` is `Completed`, so a client reading only `state` sees a job that
finished — the v1 wire contract is unchanged. `phase` is `"skipped"` if you want
to distinguish it, and `uuid` points at the existing asset so you can link
straight to it.

If you already special-cased `duplicate_skipped` on the strength of the earlier
document: you can remove it, or leave it, but `phase == "skipped"` is the right
check now.

### 5.4 Startup can move a Pending job to Failed

A job left `Pending` whose source file no longer exists is now failed at startup
with `source_missing_on_recovery`. Previously those sat `Pending` forever.

---

## 6. SSE events

Only relevant if PlayOut subscribes to `/api/events`. It currently does not.

Two new event types. **An unknown SSE event must be a no-op** in any client — if
yours is not, fix that first, because more will be added.

### `resync`

```
event: resync
data: {"dropped": 37}
```

Emitted when your subscriber fell behind and the server dropped messages for it
— a throttled background tab, a laptop that slept. Previously those events were
lost silently and the client went on displaying a stale job list forever with no
way to know.

**Handle it by refetching, not by ignoring it.** Applying further deltas to a
baseline you know is wrong is worse than a full refresh.

### `connected`

```
event: connected
data: {"server_time":"2026-09-18T09:14:02.881Z","version":"1.0.0"}
```

Now guaranteed to be the **first** event on every stream. Use it to
(re)synchronise after the connection is established; `server_time` distinguishes
a fresh connection from a replayed one.

### `skipped`

New terminal event for a confirmed duplicate (§5.3), carrying the uuid of the
asset that already holds the content. Treat it like `completed`.

### Unchanged

`progress` still arrives at the same 250 ms throttle with the same fields.
`completed` and `failed` are unchanged. What changed internally is only how
often the *database* is written, which you never see; `GET /api/jobs` still
serves the live in-memory record.

---

## 7. Input validation you may already be hitting

### 7.1 `tp` — answered, no action needed

Earlier documents asked what values `tp` takes. **We read your code and the
answer is in `src/stores/mediaLibrary.ts`:**

```ts
tp: tp ? 'TP' : 'None'
```

uppercased to `"TP"` / `"NONE"` by `update_ingestor_tp`. So it is a two-value
enumeration, maximum 4 characters, ASCII only.

The server currently enforces:

```
^[A-Za-z0-9 _\-|:\[\]{}",.]{0,512}$
```

Both your values pass comfortably. Nothing to do.

> If you ever want `tp` to carry Greek or free text, **tell us before you ship
> it** — the current grammar rejects non-ASCII and the call would fail with
> `422 {"error":"invalid tp"}`. We would rather tighten this to a strict
> `TP|NONE` allow-list, which is safer still; say so if that is acceptable.

### 7.2 `rating` is bounded

`PUT /api/assets/{uuid}/rating` caps the whole value at 4 KiB and rejects
control characters. The broadcast-metadata tail after the first `|` is still
free text, **except** that a tail beginning with `[` or `{` must be valid JSON.
PlayOut already sends JSON there, so this should be a no-op.

### 7.2.1 PlayOut is not actually sending that tail — and is losing data

**This is a bug in PlayOut, it is live today, and it loses operator work.** We
found it while checking what §8.7 would affect. It is not caused by anything on
the server side; the server stores faithfully whatever it is given.

> **On the line numbers below.** They come from the copy of PlayOut we hold for
> reference, which is **older than your tree** — it still builds a `reqwest`
> client per call and has no pagination in `list_ingestor_assets`, both of which
> we understand you have since fixed. Grep for the symbol names rather than
> trusting the line numbers, and confirm the bug is still present before
> changing anything. If it is already fixed on your side, tell us and we will
> strike this section.

The rating column holds four `|`-separated fields:

```
age | TP or NONE | CONTENT TYPE | [advisory timeline JSON]
16|NONE|MOVIE|[{"start":0,"end":120000,"text":"ΠΕΡΙΕΧΕΙ ΣΚΗΝΕΣ ΒΙΑΣ"}]
```

`serializeBroadcastRating` builds exactly that string, and
`parseBroadcastRating` reads it back. But **no call site ever sends it.** All
three rating writers build the full string and then hand the Tauri command only
the bare age token:

| Call site | Sends |
|---|---|
| `src/stores/mediaLibrary.ts:582` (`updateAssetMetadata`) | `rating: age` |
| `src/stores/rundown.ts:1587` (`updateItemMetadata`) | `rating: age` |
| `src/components/MediaInspector.vue:79` (`pushRatingToIngestor`) | `rating: rating.toUpperCase()` |

`mediaLibrary.ts` is the clearest case. It computes

```ts
const serialized = serializeBroadcastRating({ ageRating: age, tpFlag: tp, contentType: content, timeline });
```

then sends `rating: age` to the server (line 582) and writes `serialized` into
the **local** store (line 601). So the two disagree immediately: locally the
asset is `16|NONE|MOVIE|[…]`, on the server it is `16`. The next
`fetchAssets({ force: true })` — which runs after *every* mutation — overwrites
local state with the server's value, and the content type and the advisory
timeline are gone.

The TP flag survives, but only by accident: it is pushed separately through
`update_ingestor_tp` to its own column. Content type and timeline exist
**only** in the rating tail, so they have nowhere else to survive.

**The fix, in all three places:** send the serialised string.

```ts
await invoke('update_ingestor_rating', {
    uuid,
    rating: serializeBroadcastRating({ ageRating: age, tpFlag: tp, contentType: content, timeline }),
    apiBaseUrlOverride: null,
});
```

`MediaInspector.pushRatingToIngestor` needs the same treatment: read the current
metadata with `parseBroadcastRating(asset.rating)`, replace the age, re-serialise.
Changing an age rating must not clear a compliance banner.

Two things to check while you are in there:

- **`update_ingestor_rating` uppercases the whole value** (`ingestor_api.rs:314`,
  `rating.to_ascii_uppercase()`). That is harmless for `16|NONE|MOVIE|[]` but it
  will uppercase the JSON tail too — including Greek advisory text, which
  `to_ascii_uppercase` leaves alone, but also any lowercase JSON keys you add
  later. Uppercase the age token only.
- **The server accepts all of this.** The whole value is capped at 4 KiB, control
  characters are rejected, and a tail starting with `[` or `{` must be valid
  JSON — which `JSON.stringify` guarantees. Nothing here needs a server change.

### 7.3 `folder_color` is an allow-list

`PUT /api/folders/colors` accepts `#rrggbb` or one of: `default`, `red`,
`orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`, `grey`, `gray`.
Anything else is 422. This closed a CSS-injection path in the DB viewer.

### 7.4 Ids are validated server-side

Every `{uuid}`/`{id}` path segment, and every element of the
`POST /api/assets/batch` body, must be a canonical hyphenated UUID. Anything
else returns `422 {"error":"invalid asset id"}`. This is the server-side
guarantee behind your client-side validation.

### 7.5 `folder_path` is validated and `LIKE`-escaped

`/%` returns 422 instead of matching the entire library.

### 7.6 Media roots cannot be system or profile directories

Not a PlayOut concern today — you do not call `PUT /api/config` — but if you
ever add an ingest-settings screen that writes the watch or target folder, know
that `C:\`, `C:\Users`, `C:\Users\<name>`, `C:\Windows`, `C:\Program Files`,
`%ProgramData%` and the service's own data directory are all refused with 422.
A folder *inside* a profile (`C:\Users\op\Media\Ingest`) is fine — that is
where most people keep media.

The reason is blunt: `clean_source_after_success` deletes sources after a
successful encode, so a watch folder pointed at a profile container was a
remote-driven mass-deletion primitive (F-03).

---

## 8. Behaviour changes that are not new endpoints

### 8.1 `restore` with an invalid folder is now 422

`POST /api/assets/{uuid}/restore` with an invalid `target_folder` returns **422**
instead of silently restoring the asset to `/`. If you relied on the silent
fallback, handle the 422 — but sending a valid folder path is the correct fix.

### 8.2 Purging a non-ready asset retains the file

Purging an asset whose status is not `ready` deletes the registry row but
**keeps the file on disk**, with a warning in the result. For a `processing` or
`error` row the stored path is still the *source* file in the watch folder, and
deleting it was a real data-loss path. If you showed "media removed" based on
the row disappearing, read `media_removed` from the response instead.

### 8.3 Error bodies no longer contain paths

No response body carries a filesystem path or an OS error string. Sidecar
failures return `mezzanine_missing` / `probe_unavailable` /
`sidecar_write_failed`, config-save failures return `config_save_failed`, and
the SPA 404 is a bare message. Details go to the service log only.

This matters to you because several of your error paths embed the response body
into a user-visible string. Those strings are now short codes rather than
sentences — map them if you surface them.

### 8.4 `regenerate-sidecar` can return 503

`POST /api/assets/{uuid}/regenerate-sidecar` now **re-probes the mezzanine**
rather than reconstructing the sidecar from the registry row. The old code
hard-coded `1920x1080`, `h264`, `aac`, `48000 Hz`, stereo, progressive for every
asset it rebuilt — correct for a 1080p25 stereo mezzanine, confidently wrong for
a legacy SD asset, a 720p promo or a 5.1 feature, and indistinguishable from a
real sidecar downstream.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true,"uuid":"…"}` | Rebuilt from a fresh probe |
| 404 | `{"error":"mezzanine_missing"}` | The media file is gone |
| **503** | `{"error":"probe_unavailable"}` | **New.** ffprobe is unavailable or could not read the file |
| 500 | `{"error":"sidecar_write_failed"}` | Could not write the file |

On 503 **nothing was written.** Say "could not read the media file — check that
FFmpeg is installed on the ingest host" and offer a retry. The service
deliberately refuses to write a plausible-but-wrong sidecar; a missing sidecar
is recoverable, a wrong one is not.

### 8.5 Two distinct programmes are no longer deduplicated

Dedup used to key on a sampled hash: file size plus the first, middle and last
64 KiB. Two distinct programmes cut from the same master — same size, same
leader, same tail — collide under that, and the second was silently dropped. In
a broadcast library, promos and versioned cuts are produced exactly that way.

A duplicate now requires a **full SHA-256 match** as well. If a station has been
quietly losing versioned cuts, they will start ingesting correctly. Nothing to
do on your side; expect asset counts to go *up* slightly on some libraries.

### 8.6 Re-ingest no longer destroys subclips

A subclip carries its **parent's** fingerprint, and re-ingesting a programme
used to run `DELETE FROM media_assets WHERE fingerprint = ?` — destroying every
subclip cut from it, with their ratings, virtual folders and compliance
metadata. None of that is recoverable from the source file.

Subclips are now never touched by a re-ingest, and a `ready` parent whose
mezzanine has vanished is demoted to `error` rather than deleted, so its
metadata survives. Nothing to do on your side.

### 8.7 A newly ingested asset is unrated, not `K`

**What changed.** Ingest used to write `rating: "K"` on every newly transcoded
file, because the database column defaulted to `'K'` and the insert did not name
it. Ingest has no way to know a programme's NCRTV suitability mark, so it was
asserting one it had no basis for: every file arrived in PlayOut already
claiming it was suitable for all audiences, and somebody had to notice and
correct it. Ingest now writes `NONE`.

**Nothing you parse moves.**

- `NONE` was already in the server's accepted set for this field, alongside
  `K`, `8`, `12`, `16`, `18`, an optional `+`, and the empty string.
  `PUT /api/assets/{uuid}/rating` accepts and rejects exactly what it did before.
- `mapApiRatingToCompliance` lowercases and tests membership in
  `['k','8','12','16','18']`, so `"NONE"` already falls through to `'none'` —
  the value PlayOut uses for "unrated".
- `applyComplianceForItem` plays no badge for `'none'`, so an unrated item has
  no on-screen mark. That is the correct output for a file nobody has
  classified.

**Existing rows are untouched.** Everything already ingested keeps the rating it
has, including the `K` it was given automatically. Expect a mixed library for a
long time. Subclips still inherit their parent's rating.

**What this asks of PlayOut.**

1. **Fix §7.2.1 first.** Operators are about to set ratings far more often than
   before, because files no longer arrive pre-rated. Every one of those saves
   currently discards the content type and the advisory timeline.

2. **Make "unrated" visible, not merely absent.** A `'none'` asset renders as
   nothing almost everywhere in the UI. While the default was `K`, "no badge"
   effectively never occurred; it is now the normal state of every fresh ingest.
   An explicit "Unrated" chip in `MediaLibrary`, and a filter for it, turns
   "nobody has classified this yet" into something an operator can see and work
   through — rather than something they discover at transmission.

3. **Consider a pre-transmission check.** `ageRating === 'none'` is now a
   meaningful signal: *nobody has classified this item*, as distinct from
   *somebody decided it is K*. That distinction did not previously exist. If
   anything in PlayOut gates or warns before air, this is worth surfacing there.

**No migration is needed or wanted.** If you want a particular import to carry
`K`, set it explicitly through `PUT /api/assets/{uuid}/rating`; the server has
no opinion about which mark is correct, only that ingest should not invent one.

---

## 9. Deployment: what changed under the operator's feet

No client code, but this is what support calls will be about.

### 9.1 It is a real Windows service now

The documented production deployment did not work. The installer registered
`PlayoutTranscode run`, which is a console program: the Service Control Manager
waited for a status report that never arrived and failed the start with **error
1053** after 30 seconds. The only way to keep ingest running was to leave
someone logged in with a console window open, and a logoff killed it.

The installer now registers a real SCM entry point (`service-run`) running as
`NT AUTHORITY\LocalService`, with auto-restart on crash. A stop drains in-flight
HTTP requests, stops the watcher, kills any running FFmpeg child, flushes the
job persister and closes the database before reporting `STOPPED`.

**For PlayOut:** the ingest service is now expected to be up whether or not
anyone is logged in. If your status light was red after a server reboot until
someone logged in and started the app, that should stop happening.

> Verified end to end on a real host via `scripts\verify-service.ps1`: the SCM
> reports `RUNNING`, `/api/health` answers 200 under the SCM, `sc stop` reaches
> `STOPPED`, no process survives, and `LocalService` writes its registry.

### 9.2 Everything mutable moved to a data directory

`LocalService` cannot write under `Program Files`, so `config.toml`,
`media_assets.db`, `logs\`, `backups\` and any downloaded FFmpeg moved to a
**data directory**, resolved at startup as:

| Order | Source | Result |
|---|---|---|
| 1 | `--data-dir <PATH>` | that path |
| 2 | `PLAYOUT_TRANSCODE_DATA` | that path |
| 3 | exe under a `Program Files` tree | `%ProgramData%\PlayoutTranscode` |
| 4 | anything else | next to the exe (portable/dev builds, unchanged) |

> **Upgrade note for operators:** on an installed build, a `config.toml`
> previously edited next to the executable is **no longer read**. It must be
> moved to `%ProgramData%\PlayoutTranscode\config.toml`. Nothing migrates it
> automatically — silently moving an operator's file is worse than a loud
> default — so this belongs in the release notes.

`GET /api/diagnostics` gained `system.data_dir`. If you have a diagnostics
panel, showing it saves a support round-trip.

### 9.3 One instance per data directory

The service takes an advisory lock, `playout-transcode.lock`, in its data
directory and refuses to start if a live process holds it:

```
another PlayoutTranscode instance (pid 1234) is already using this data
directory; its lock is C:\ProgramData\PlayoutTranscode\playout-transcode.lock.
Stop that instance, or start this one with a different --data-dir.
```

Two processes on one data directory meant two watchers on one folder and two
writers on one registry, and the symptom was a stream of unexplained ingest
failures with no obvious cause. The way operators reached it was starting the
portable build while the Windows service was already running — which, now that
the service actually works, is *easier* to do by accident.

Two installs with **separate** data directories are unaffected. A lock left by a
crash is taken over by the next start, with a warning; nobody has to delete a
file by hand.

### 9.4 There are real logs now

A headless install used to discard every log line. Four sinks:

| Sink | Format | Contents |
|---|---|---|
| stdout | pretty | everything at `logging.level` (interactive runs only) |
| `<data_dir>\logs\transcode.log.<date>` | JSON, daily rotation | everything at `logging.level` |
| `<data_dir>\logs\audit.log.<date>` | JSON, daily rotation | destructive operations only |
| the web UI log panel | plain text | `WARN`, `ERROR` and every audit record |

`logging.retain_days` (default 14) prunes at startup. Panics are captured with
their location and backtrace, so a worker thread dying no longer leaves an empty
log.

**Consequence for you:** the web UI log panel now shows service-wide
`WARN`/`ERROR`, not just a handful of hand-written lines. An operator looking at
it will see failures PlayOut reported as generic errors, which may change what
they report to you.

### 9.5 The registry is backed up

`VACUUM INTO <data_dir>\backups\media_assets-<date>.db` runs daily, keeping 7.
It is the playout source of truth — every uuid, virtual folder, rating, trim
window and compliance flag an operator has ever set, none of it reconstructible
from the media files.

`POST /api/db/backup` takes one on demand (token required, no confirmation
header). `GET /api/db/overview` lists them.

### 9.6 A green status light does not prove ingest is running

Worth knowing because it is a support call PlayOut fields, not the service.

`/api/health` answers 200 as soon as the HTTP server is up. That is deliberate —
it is how PlayOut's status light works before anything is configured — but it
means a **green light only says the service is reachable**, not that the
processing loop is running. The two are separate, and
`GET /api/service/status` is what distinguishes them:

```json
{ "running": true, "state": "running", "generation": 1, "restart_required": false }
```

This mattered because of a bug now fixed: a `config.toml` missing an optional
section (`[server]` or `[encoding]`) failed validation, and the auto-start path
only runs when validation succeeds — and reported the failure to the web UI's
log panel rather than the service log. So the service started, answered health,
showed green, and silently ingested nothing, with nothing in the log to explain
it. Any partial config file could trigger it, and the README documents which
sections are optional, so partial files are normal.

**If you surface ingest status at all, read `state` from
`/api/service/status`, not just `/api/health`.** An operator reporting "it says
it is running but nothing is being transcoded" is answered instantly by that
field, and not at all by the health endpoint.

### 9.7 Disk preflight is sized from the job

The preflight was a flat 500 MB for every job. A two-hour feature at 15 Mbit/s
needs about 16.5 GB; it passed the check, encoded for an hour, and died on
`No space left on device`. It is now sized from duration x bitrate, so that
failure happens in the first second with a message saying what it needed.

---

## 10. Config knobs an operator may ask you about

Three that were previously inert and now work. All optional, all in
`config.toml` under `[validation_policy]`:

| Key | Default | Effect |
|---|---|---|
| `enforce_closed_gop` | `true` | `false` downgrades the finding to a warning |
| `enforce_faststart` | `true` | same |
| `enforce_48k_audio` | `true` | same |
| `max_duration_delta_ms` | `80` | Mezzanine/source drift beyond this fails the asset |
| `strict_ready_blocking` | `false` | `true` makes any warning block `mezzanine_ok` |

Each `enforce_*` chooses the **severity** of its check, not whether it runs — the
finding is always recorded in the sidecar, so "was this file actually faststart?"
always has an answer. Before this remediation all five were accepted, stored,
rendered in the UI and read by nothing.

`max_duration_delta_ms` had no check behind it at all. A mezzanine a second
short of its source is the failure an as-run log catches at transmission and
nothing caught before it.

The README's configuration section is now generated from the real schema and
has a test that fails the build if it drifts. An operator who mistypes a key
gets `WARN Unknown config key 'ingestion.max_concurrancy' -- it is ignored` at
startup instead of silence.

---

## 11. Suggested order of work

1. **Purge header** (§2). One line, unblocks the operation entirely.
2. **API token** (§3). One line plus a masked settings field. Do it before any
   operator turns a token on, not after.
3. **Pagination** (§4). The only change with real design in it. Do it before a
   station's library passes 1000 assets.
4. **`error_category` mapping** (§5.2) and the `skipped` phase (§5.3), if you
   surface ingest status.
5. **SSE `resync`** (§6), if you subscribe to events.
6. **503 from regenerate-sidecar** (§8.4) and the shorter error bodies (§8.3).

Items 1–3 are worth doing in one pass through `ingestor_api.rs`; they all live
in the same file and 1 and 2 are single lines.

Added by the 2026-09-18 change set, in priority order:

0. **Send the whole rating string** (§7.2.1). This is losing operator data right
   now, and it is three call sites. It belongs *above* everything else in this
   list, including the mandatory items, because those merely fail loudly.
7. **Show "unrated" in the library** (§8.7), once §7.2.1 is fixed — otherwise
   you are making a workflow visible that still corrupts data when used.
8. **Patch one asset after a mutation** instead of `fetchAssets({ force: true })`
   (§4.1), and optionally send `If-None-Match`. Pure optimisation; do it last.

## 12. Questions back to you

1. **`tp` as a strict allow-list.** We can tighten the grammar to exactly
   `TP|NONE`, which is stricter and safer. It would 422 anything else. Is that
   acceptable, or do you want the freedom the current grammar allows?
2. **A dedicated phase for skipped duplicates.** §5.3 maps `Skipped` onto the v1
   `Completed` state to preserve the wire contract. If you would rather have a
   distinct `state`, say so and we will widen it — it is a breaking change, so
   it needs to be a decision rather than a default.
3. **Was the rating tail ever meant to reach us?** §7.2.1 shows PlayOut builds
   the four-field string and then sends only the age token. We have assumed the
   tail is meant to be persisted and the omission is a bug. If instead the
   content type and timeline are deliberately local-only state, tell us — we
   would then document the rating field as age-only and you can stop
   round-tripping the rest.
4. **Does PlayOut want the job stream at all?** Several of the improvements
   above (SSE `resync`, `error_category`, the retry semantics) only pay off if
   PlayOut surfaces ingest progress. If it never will, we can stop documenting
   them for you.
