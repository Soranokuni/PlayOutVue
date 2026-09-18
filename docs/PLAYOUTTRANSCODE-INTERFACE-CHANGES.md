# PlayOut ↔ PlayoutTranscode: what the 2026-09-15 audit changed on the client side

Audience: whoever audits **PlayoutTranscode** (the Ingestor, default `http://127.0.0.1:4353`).
Scope: only the parts of PlayOut that talk to PlayoutTranscode, and only what changed in PRs #1–#3 (Tier 0–2 remediation, `main` @ `a75c094`).
Nothing in the wire format changed. PlayOut is now a *stricter client*; the server's own defences are still needed because PlayOut is not the only possible caller.

---

## 1. Where the traffic comes from (unchanged, but now verified)

- **All** Ingestor HTTP calls are made by the Rust backend (`src-tauri/src/ingestor_api.rs`) with `reqwest`. The Vue frontend never calls the Ingestor directly (the `safeFetch` helper in `src/utils/api.ts` has no callers; the WebView CSP `connect-src` only matters for the studio bridge and media server).
- Endpoints PlayOut uses (V1 unless noted):

  | Method / path | Purpose |
  |---|---|
  | `GET /api/v2/health` → fallback `GET /api/health` | connection check; **heartbeat every 5 s uses `/api/health` only** |
  | `GET /api/v2/assets` → fallback `GET /api/assets` | library listing |
  | `GET /api/v2/assets/{uuid}` → fallback `GET /api/assets/{uuid}` | single asset resolve (also used by rundown hydration and the fixed "Re-Probe Ingestor" button) |
  | `POST /api/assets/batch` (JSON array of uuids) | bulk resolve |
  | `POST /api/assets/{uuid}/trim` · `/rating` · `/tp` · `/move` · `/rename` · `/subclip` · `/trash` · `/restore` · `/purge` | asset mutations |
  | `POST /api/folders/trash` · `/restore` · `/purge` · `GET/POST /api/folders/colors` | folder operations (body carries `folder_path`) |
  | `GET /api/recycle-bin`, `POST /api/recycle-bin/purge`, `POST /api/recycle-bin/auto-purge` | recycle bin |

- **Authentication:** as of 2026-09-18 PlayOut sends `X-Api-Token` on every call when the operator has configured a token (see §5). Before that, no credential was sent.

---

## 2. Client-side changes that affect the server contract

### 2.1 Asset ids are validated before they reach a URL (T2-6)
- Every `{uuid}` path segment is checked against canonical RFC 4122 form (`8-4-4-4-12` hex) **before** the request is built; anything else is rejected client-side with an error. Case is preserved.
- `POST /api/assets/batch` validates every element of the array the same way.
- Consequence for your audit: PlayOut can no longer produce path-traversal ids like `../folders/purge`. **Do not rely on that** — any other client (curl, an old PlayOut build) still can. Server-side id validation is still required.

### 2.2 `api_base_url_override` is now restricted (T2-6)
- Every Tauri command accepts an optional base-URL override from the WebView. It is now honoured **only** when its host is loopback (`127.0.0.1`, `localhost`, `::1`) or equals the host of the operator-configured base URL. Anything else is ignored with a warning and the configured URL is used.
- The configured URL itself (`settings.ingestorApiBaseUrl`) is validated on hydrate to `^https?://\S+$`; garbage falls back to `http://127.0.0.1:4353`.
- Consequence: a compromised WebView can no longer point PlayOut's purge/rename calls at an arbitrary host. It can still call the *real* Ingestor with any valid uuid.

### 2.3 Response bodies are capped at 16 MiB
- `Content-Length` above the cap, or a streamed body exceeding it, is an error on the PlayOut side. If PlayoutTranscode's `GET /api/assets` / `/api/v2/assets` listing can legitimately exceed 16 MiB (very large libraries with full QC reports), PlayOut will start failing to list. Consider pagination on the server, or tell us and we raise the cap.

### 2.4 One shared HTTP client, per-request timeouts
- Previously a new `reqwest::Client` (new connector, new pool) per command. Now one process-wide client with a **5 s** default timeout; `POST /api/assets/batch` uses **10 s**. Connections are pooled and reused, so the server will see keep-alive connections from PlayOut instead of one connection per request.
- Heartbeat: `GET /api/health` every 5 s with the 5 s timeout, forever, from app start.

### 2.5 What did **not** change
- Request/response JSON shapes (`AssetResponse`, `V2AssetDto`, QC report, loudness). The V2 → V1 fallback logic is unchanged: a V2 parse failure silently falls back to V1 (AUDIT-PLAN Tier 3 item; still open).
- `folder_path` / `virtual_folder` / display names sent in JSON bodies are now checked client-side with the same rules as the server (§5.2). Server-side path validation for folder operations remains the server's job.
- The `contract_boundary` test in PlayoutTranscode was **not** run for these PRs because no asset/trim/metadata schema was touched. Run it after your PlayoutTranscode changes.

---

## 3. Things on the PlayoutTranscode side worth checking (from what PlayOut assumes)

1. **Id validation on every `{uuid}` route and on the batch body** — PlayOut now guarantees canonical uuids, but the server must not depend on the client.
2. **`folder_path` handling** in `/api/folders/*` — PlayOut sends whatever the library tree holds; treat it as untrusted.
3. **Bind address / CORS / auth** — PlayOut only needs loopback. If the server binds `0.0.0.0` or answers CORS `*`, that is a server-side exposure PlayOut cannot mitigate.
4. **Response size** — see §2.3.
5. **Health endpoint cost** — it is hit every 5 s by every PlayOut instance (primary and monitor). Keep it cheap and side-effect free.
6. **Error bodies** — PlayOut logs the raw error body into its diagnostics log (`HTTP <code> for '<url>': <body>`). Avoid leaking internal paths or stack traces in error responses.
7. **Purge / auto-purge** are reachable from PlayOut without any confirmation on the server; PlayOut prompts the operator with a native dialog, but the endpoint itself has no second factor.

---

## 4. Relevant source in PlayOut

- `src-tauri/src/ingestor_api.rs` — all calls, `validate_uuid`, `resolve_base_url`, `read_body_capped`, `build_client`.
- `src-tauri/src/runtime_settings.rs` — `get_ingestor_api_base_url`.
- `src/stores/settings.ts` — `sanitizeSettingsState` (URL validation on hydrate).
- Tests: `ingestor_api::tests::{validate_uuid_accepts_only_canonical_uuids, base_url_override_is_restricted_to_loopback_or_configured_host, url_host_parsing}`, `src/lib/__tests__/v2IngestorAdapter.test.ts`.

---

## 5. 2026-09-18 follow-up: PlayOut implements the PlayoutTranscode 1.0.0 contract

`docs/PLAYOUT-CLIENT-DOCUMENTATION.md` (service 1.0.0 @ `be843ad`) described the
remediated server. This is what PlayOut changed in response, verified against
the PlayoutTranscode source rather than the guide alone. Two corrections to the
guide's assumptions surfaced while doing so and are recorded here.

### 5.1 Corrections to the guide

- **PlayOut calls five gated routes, not one.** `is_destructive` gates
  `DELETE /assets/{uuid}/purge`, `DELETE /folders/purge`,
  `DELETE /recycle-bin/purge`, `POST /recycle-bin/auto-purge` and
  `POST /folders/trash`. PlayOut calls all five (`purge_ingestor_asset`,
  `purge_ingestor_folder`, `purge_ingestor_recycle_bin`,
  `auto_purge_ingestor_recycle_bin`, `trash_ingestor_folder`). All five now send
  `X-Confirm-Destructive: yes`; reversible routes never do.
- **`GET /api/v2/assets` is the same paginated handler as `GET /api/assets`.**
  Paging is therefore applied on both generations of the listing route.
- **The V2 routes serve the V1 row shape.** PlayOut's `V2AssetDto` parsed that
  shape successfully (every field is defaulted) and then dropped
  `total_frames`, `gop_frames` and `keyframe_safe_start_ms` on the way to
  `AssetResponse`. The DTO now carries those fields and the mapping passes them
  through, so the inspector's GOP/frame counts survive whichever route answers.

### 5.2 Client changes (all in `src-tauri/src/ingestor_api.rs` unless noted)

| Change | Where | Notes |
|---|---|---|
| `X-Api-Token` on every call | `IngestorClient::request` | Token from `RuntimeSettings.ingestor_api_token` (`settings.ingestorApiToken` in the UI). Empty token = header omitted. Also sent on the heartbeat (harmless; health is exempt). |
| `X-Confirm-Destructive: yes` | `IngestorClient::destructive` | The five routes in §5.1. |
| Paged listing | `list_all_pages` / `needs_next_page` | `?limit=1000&offset=N`, walks `X-Total-Count`, honours `X-Limit`, stops on a short or empty page, hard cap 100 pages. No `X-Total-Count` (pre-T2-7 service) = single shot. Never sends `?fields=full`. |
| Auth-rejected indicator | `AUTH_REJECTED`, `HeartbeatEvent.auth_rejected` | Set on any 401 from a non-exempt route, cleared by the next 2xx. The status light turns amber ("reachable but rejecting the API token") because `/api/health` alone cannot show this. |
| Error-code mapping | `http_error` / `describe_error_code` | 401 / 428 / 404 / 422 / 503 / 5xx and the short codes from §8.3 (`probe_unavailable`, `mezzanine_missing`, `confirmation_required`, `invalid folder_path`, ...) become operator wording. The URL stays in the message for the diagnostics log. |
| Purge outcome | `PurgeOutcome`, `parse_purge_outcome` | The three purge commands return the server's `StructuredPurgeResult`. `src/lib/ingestorFeedback.ts` turns `media_removed == false`, `skipped_referenced_files` and `cleanup_failures` into a warning dialog instead of implying the media is gone. |
| Client-side mirrors of server validation | `is_valid_virtual_folder`, `is_valid_folder_color`, `validate_display_name` | Same rules as the server (`/A/B` form, `#rrggbb` or named colour, trimmed 1..255-byte display names) so the operator sees a precise message rather than a bare 422. Applied to move, trash/restore/purge folder, restore target, rename, subclip, folder colour. |
| Capped bodies everywhere | `move_ingestor_asset`, `rename_ingestor_asset` | Were the last two call sites reading an uncapped body. |
| Token never logged | `runtime_settings.rs` | `RuntimeSettings` has a hand-written `Debug` that redacts the token; no request headers are logged anywhere. |

### 5.3 Settings

- `settings.ingestorApiToken` (frontend, persisted, validated on hydrate to a
  single printable-ASCII header value of at most 256 bytes) →
  `RuntimeSettings.ingestor_api_token` (Rust, `runtime_config.json`).
- UI: Settings → PlayoutTranscode Ingestor API → *API Token*, masked with a
  Show/Hide toggle.

### 5.4 Still open / not done on purpose

- PlayOut still does not subscribe to `/api/events` or read `/api/jobs`, so the
  `resync` / `skipped` SSE events and `error_category` mapping (guide §5–§6)
  have no consumer here.
- `GET /api/service/status` (guide §9.6) is not polled; the status light means
  "reachable" (green), "reachable but unauthenticated" (amber) or "unreachable"
  (red), not "ingest loop running".
- Answers to the guide's §12: (1) a strict `TP|NONE` allow-list for `tp` is
  acceptable — PlayOut only ever sends those two values; (2) keep `Skipped`
  mapped onto `state: "Completed"`; (3) PlayOut does not need the job stream today.
