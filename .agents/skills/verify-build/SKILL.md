---
name: verify-build
description: Dual-stack compilation, type-check, and test verification across the Vue 3 frontend and Tauri Rust backend. Run before declaring any task complete, opening PRs, or staging git commits.
---

# Dual-Stack Verification & Build Harness (`verify-build`)

This skill defines the mandatory, zero-tolerance verification pipeline for PlayOutVue. Every step must exit with status code 0 before any task is marked complete or staged for commit.

---

## Execution Prerequisites

Ensure your environment satisfies the following before running verification:
- **Node.js**: `^20.19.0 || >=22.12.0` (matching `package.json`).
- **Rust toolchain**: `stable` (matching `rust-version = "1.77.2"` or higher in `src-tauri/Cargo.toml`).
- **MSVC Build Tools**: Windows C++ Build Tools installed for native `windows-sys` and Tauri target compilation.
- **Working Directory**: Root of `PlayOut` repository (`d:\PlayOut`).

---

## Sequential Execution Checklist (Run in Order)

Execute the verification steps in the following order to catch failures as early and cheaply as possible:

### Step 1: Frontend Unit & Integration Tests (Vitest)
Fast feedback on stores, composables, UI components, keyboard routing, and timecode arithmetic:
```bash
npm test -- --run
```
- **Expectation**: All test suites pass (207+ tests across 29+ test files, ~5s execution).
- **Scope**: Covers DOM keyboard routing, SortableJS reorder helpers, timecode math, compliance ratings, and playback coordinator logic.

### Step 2: TypeScript Type Invariant Check (`vue-tsc`)
Verifies strict type safety across all Vue SFCs, Pinia stores, composables, and Tauri IPC interfaces:
```bash
npm run type-check
```
- **Expectation**: Clean run with 0 errors.
- **Scope**: Enforces prop types, store state models, and contract types without emitting JS files.

### Step 3: Production Web Bundle Build (Vite)
Verifies that client assets, CSS custom properties, dynamic imports, and templates build cleanly for production:
```bash
npm run build
```
- **Expectation**: Clean output in `dist/` with no bundle compilation errors.
- **Notice**: Check for accidental broken dynamic imports or cyclic references.

### Step 4: Backend Cargo Compilation Check (Rust / Tauri)
Fast compilation and type verification of the Tauri backend:
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```
- **Expectation**: Exits with code 0 with 0 errors.
- **Scope**: Validates `app_lib`, `amcp.rs`, `caspar.rs`, `ingestor_api.rs`, and Windows-specific API bindings.

### Step 5: Backend Rust Unit & Integration Tests (Cargo)
Validates backend AMCP parsing, Caspar timing gates, OSC throttling, and process lifecycle:
```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
- **Expectation**: All unit tests (62+) and integration tests (such as `fake_amcp_transport`) pass.

### Step 6: Cross-Repo Contract Boundary Check (Conditional)
**MANDATORY** whenever touching media ingestion, trim boundaries, FPS rational structures, sidecars, or Caspar registration contracts:
```bash
cargo test --manifest-path ../PlayoutTranscode/Cargo.toml --test contract_boundary
```
- **Expectation**: All 10 boundary tests pass cleanly, ensuring asset hydration compatibility between PlayOutVue and PlayoutTranscode.

---

## One-Shot PowerShell Execution Snippet

For rapid continuous integration checks in Windows PowerShell / pwsh:

```powershell
npm test -- --run; if ($LASTEXITCODE -eq 0) { npm run type-check }; if ($LASTEXITCODE -eq 0) { npm run build }; if ($LASTEXITCODE -eq 0) { cargo check --manifest-path src-tauri/Cargo.toml }; if ($LASTEXITCODE -eq 0) { cargo test --manifest-path src-tauri/Cargo.toml }
```

---

## Structured Failure Triage Matrix

| Failure Mode / Symptom | Root Cause | Immediate Diagnostic & Fix Action |
|---|---|---|
| `TypeError: Cannot read properties of undefined (reading 'invoke')` | Test component mounted without mocking Tauri's IPC `invoke` API. | In the test setup, stub Tauri IPC: `vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))`. |
| Missing required props warning in console during Vitest | Component test did not provide mandatory props (e.g. `timerLabel`, `etaHint`, `dayLabel`). | Supply mock default props or mount with shallow mounting if testing isolated wrapper behavior. |
| `vue-tsc` fails on Pinia store state or actions | Mismatched return types or implicit `any` in store getters/actions. | Check `src/stores/*.ts` for strict typing. Ensure all actions explicitly type payload parameters. |
| `[INEFFECTIVE_DYNAMIC_IMPORT]` warning during `npm run build` | Module is dynamically imported in one file but statically imported in another. | Check callers of the dynamically imported module and standardize on static or dynamic imports across callers. |
| `error: linking with link.exe failed` / locked executable | A running instance of `playout_app.exe` or background Tauri task has locked the binary in `src-tauri/target/`. | Terminate running debug sessions or background tasks before recompiling: `Stop-Process -Name playout_app -ErrorAction SilentlyContinue`. |
| AMCP command struct mismatch in `cargo check` | AMCP command builder modified without updating all response parsers. | Inspect `src-tauri/src/amcp.rs` and verify enum exhaustiveness and response pattern matches. |
| Contract boundary test failure in `PlayoutTranscode` | Changed field names or trim semantics between PlayoutTranscode and PlayOutVue. | Ensure `current_path`, `fps_num`/`fps_den`, `trim_in_ms`, and `trim_out_ms` conform strictly to the hydrated playout contract. |

---

## Completion & Stop Gate Protocol

1. **Zero-Tolerance Rule**: Never mark a task as complete, commit code, or propose a PR if any step in this harness fails.
2. **Artifact Cleanliness**: Ensure no test outputs, temporary dumps, or log files are left behind in `dist/`, `target/`, or working trees.
3. **Reporting Format**: When reporting completion to the user, include:
   - Summary of test counts (`207+ passed`).
   - Confirmation of `type-check` and `build` exit code 0.
   - Rust test status (`63+ passed`).
   - Cross-repo status (if applicable).
