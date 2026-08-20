# E2E Test Infra: PlayOut & PlayoutTranscode

## Test Philosophy
- Opaque-box, requirement-driven end-to-end and integration testing across `PlayOut` (frontend) and `PlayoutTranscode` (backend).
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Interaction + Real-World Workload Testing (Tiers 1-4).

## Feature Inventory & Test Matrix
| # | Feature | Requirement | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---------|-------------|:------:|:------:|:------:|:------:|
| 1 | Manual Take Above Active Line | R1 | ✓ | ✓ | ✓ | ✓ |
| 2 | CasparCG Background Queue Clear | R1 | ✓ | - | ✓ | ✓ |
| 3 | Rundown Store Take Index Sync | R1 | ✓ | ✓ | - | ✓ |
| 4 | Virtualized Playlist Navigation | R2 | ✓ | ✓ | - | ✓ |
| 5 | O(1) Playlist Selection | R2 | ✓ | ✓ | - | ✓ |
| 6 | RAF Key-Repeat Throttling | R2 | - | ✓ | - | ✓ |
| 7 | Scoped Keyboard Navigation Listener | R2 | - | ✓ | ✓ | - |
| 8 | Video Seek Throttling | R3 | - | ✓ | ✓ | - |
| 9 | Timecode Format Throttling | R3 | ✓ | ✓ | - | - |
| 10 | Optimized Timecode Formatter | R3 | ✓ | - | - | - |
| 11 | Window Mouse Listener Cleanup | R3 | - | ✓ | - | - |
| 12 | Playlist Asset Trim Synchronization | R4 | ✓ | - | ✓ | ✓ |
| 13 | Subclip Invariant Preservation | R4 | ✓ | ✓ | - | ✓ |
| 14 | Subclip Creation Auto-Insertion | R4 | ✓ | - | ✓ | ✓ |
| 15 | Playlist Run-Time Warning Banner | R4 | ✓ | - | ✓ | ✓ |
| 16 | Structural Fingerprint Trim Check | R4 | ✓ | ✓ | - | - |
| 17 | Backend Contract Boundary Compliance | R4 | ✓ | - | - | ✓ |
| 18 | Memoized Playlist ETA Calculation | R5 | ✓ | - | ✓ | - |
| 19 | Atomic Rundown Deserialization | R5 | ✓ | - | ✓ | - |
| 20 | Full System Verification | R5 | - | - | - | ✓ |

## Test Architecture & Execution Commands
- **Frontend Test Runner**: `vitest` (v4.1.10) in `d:\PlayOut`
  - Command: `npx vitest run` (or `npm test`)
- **Frontend Static Verification**:
  - Typecheck: `npm run type-check` (`vue-tsc --build`)
  - Production Bundle: `npm run build` (`vite build`)
- **Backend Test Runner**: Cargo in `d:\PlayoutTranscode`
  - Unit & Integration: `cargo test`
  - Contract Boundary Suite: `cargo test --test contract_boundary`

## Test File Organization
- `d:\PlayOut\src\stores\__tests__\manualTake.test.ts` (R1 Manual Take & Index Tracking)
- `d:\PlayOut\src\components\__tests__\RundownNavigation.test.ts` (R2 Arrow Navigation & Virtualization)
- `d:\PlayOut\src\utils\__tests__\frameMath.test.ts` (R3 Trimmer Frame Math & Timecode Formatting)
- `d:\PlayOut\src\components\__tests__\TrimPanel.test.ts` (R3 Trimmer UI & Drag Listener Cleanup)
- `d:\PlayOut\src\stores\__tests__\trimSync.test.ts` (R4 Subclip Trim & Duration Sync)
- `d:\PlayOut\src\stores\__tests__\rundownPerformance.test.ts` (R5 Performance & ETA Memoization)
- `d:\PlayOut\src\__tests__\e2eWorkloads.test.ts` (Tier 4 Real-World E2E Workload Scenarios)
- `d:\PlayoutTranscode\tests\contract_boundary.rs` (Backend Upstream Asset Contract Boundary)

## Coverage Thresholds
- Tier 1: ≥ 5 test cases per feature area (happy-path & core calculations)
- Tier 2: Boundary value and edge case coverage for all UI, store, and trim parameters
- Tier 3: Pairwise interaction coverage for multi-feature workflows (trim update + warnings + manual take)
- Tier 4: 5 comprehensive application-level E2E scenarios + full system verification
