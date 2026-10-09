# Local Smart Task Ranking + Adaptive ETA

Source-only handoff, 2026-10-08. No EXE/ZIP packaging, GitHub push, real SAP query or real SAP write was performed for this change.

## Smallest architecture change

The existing `ExecutionHistoryService` remains the only history store. Optional `performance` metadata is appended to existing execution entries; there is no competing performance database. A main-process advisory observer consumes existing progress and guidance boundaries, exposes a trusted read-only snapshot and broadcasts ETA updates. Pure arithmetic models have no Node, Electron, network or SAP dependencies. React consumes the advisory snapshots; engines cannot receive commands from ranking or ETA.

All four engine implementations, RFQ runtime/recovery adapters, selectors, grouping, environment guards, number extraction and Excel writeback remain unchanged. The guidance service only gains a guarded observer callback; its owned request/verification/stop logic is unchanged. Existing edits to bilingual task wording from the previous request are preserved.

## Smart Task Ranking

- Last 60 days only; older executions cannot dominate forever.
- Frequency sums `exp(-age / 30 days)` and normalizes against the busiest task.
- Recency uses the latest `exp(-age / 14 days)`.
- Successful recent usage adds a small bonus with 14-day decay; Partial with successful units also qualifies.
- Internal weights: frequency 50%, recency 35%, success 15%. Failures/cancellations count as usage, without negative score penalties. No Settings are added.
- Ignore unknown operations, malformed dates, future dates and duplicate execution IDs.
- Stable ties and cold-start order: RFQ → Info Record → APQP → Source List.
- Home shortcuts and the Operations main grid are ranked; cards are not duplicated within Operations. A subtle “Common tasks first / 常用任务优先” note and “Frequently used / 经常使用” badge explain the behavior without scores.
- One snapshot per page mount. During the initial read the grid waits briefly; after 1.5 seconds it freezes default ordering and ignores a late response. Navigation away and back permits a fresh ordering. No subscription shuffles an open grid.
- Missing/corrupt/unavailable history falls back to default ordering. Local usage never leaves the device.

## Adaptive ETA

### Independent models and safe timing signals

| Function | Work unit | Existing boundaries observed | Initial startup / unit fallback |
|---|---|---|---|
| RFQ | RFQ groups, not material rows | RUN_STARTED; GROUP_STARTED; BUYER_RECEIPT_STARTED; GROUP_PROGRESS; RFQ_STARTED; GROUP_COMPLETED/GROUP_FAILED; structured WAIT/RECOVERING/INTERACTION_RESOLVED | 15 s / 60 s per group |
| Info Record | Finished records | First processing event; success/skipped/failed record events; save events; existing guidance requests | 20 s / 15 s per record |
| Source List | Finished materials | First processing event; success/skipped/failed record events; existing guidance requests | 12 s / 6 s per material |
| APQP | Finished query items | Actual workers ready; record result events; existing guidance requests | 15 s / 7 s per item |

Group-start and row-start events never count as completed work. Progress percentages use completion events only; ETA does not manufacture progress. Terminal run results remain authoritative for final result counts.

Timings use a main-process monotonic clock, independent of renderer navigation and notification success. Each run stores aggregate active time, excluded pause time, startup time, completed/learned units, average clean unit duration, observed concurrency and a small fixed set of stage aggregates. RFQ stages are startup, NPL, Buyer Receipt, RFQ and result-write intervals at existing boundaries; row-oriented workflows expose coarser records/save intervals. There are no high-resolution traces or sensitive material/supplier values in the added metadata.

### Model and recalculation

- Per automation, process at most the last 100 eligible samples in completion order.
- EWMA alpha is 0.30. Before EWMA, observations are bounded to one-quarter/four-times a robust median (use the built-in baseline until three samples exist).
- Blend device history smoothly with fallback using `1 - exp(-historicalRuns / 4)`. One/two samples retain strong fallback influence; three/five increasingly use the local model. UI displays Learning below three samples, otherwise the number of prior local runs.
- Concurrent record/query timings are wall-clock throughput, normalized using actual observed worker count, then adjusted for the current run's workers. RFQ and Source List remain single-session models.
- On meaningful completion events, blend current clean-unit EWMA with history using `1 - exp(-completedCleanUnits / 3)`. Faster or slower SAP today influences the remaining estimate.
- Re-evaluate after progress/interaction events and every two seconds, without writing history on each tick. Timers exist only while a run is active. An overdue current unit can increase the estimate; pending work never shows a false zero.
- Until an engine reports a trustworthy total, the UI can show the preview-based built-in estimate marked Learning. Once the total is known, the observer uses the local model. Legacy history with wall-clock duration only is used for ranking, **not** timing, because its manual waiting is unknown.

### Pauses, failures and retention

- Known `WAITING_FOR_USER` and `RECOVERING` intervals are excluded from active and stage/unit timings. The ETA shows “Waiting for your action / 等待你处理” or verification text, without counting down. Successful verification resumes active timing and recalculates.
- These exclusions rely on existing structured engine-owned pause events; no UI-idle/CPU heuristic guesses whether an unreported delay was human or SAP latency.
- Cancelled runs never emit a clean performance sample. Crashes/startup-only runs with no meaningful completed units yield no sample. Failed unit intervals and fully skipped RFQ groups do not enter clean timing averages. Failed/crashed runs may retain earlier reliable completed-unit timings, never their whole wall-clock duration as a clean sample.
- Validate numeric envelopes, unit types, concurrency and stage totals; corrupt performance metadata is ignored. A single extreme freeze is bounded before model learning. Very large invalid timing envelopes are not learned.
- Only optional timing metadata is removed beyond 100 entries per automation. Existing ordinary history retention remains unchanged (500 entries); normal execution records are not deleted specifically for ETA.
- Existing local-data storage owns both features. There was no dedicated local-data reset UI to extend, so no new destructive reset/settings section was added. A future existing-store reset naturally resets both features.
- History write errors are best-effort diagnostics, not fatal automation errors; failed writes no longer poison the queue. Malformed original history files are preserved rather than overwritten by new runs. Unique temporary filenames avoid competing first-launch migration writes. ETA/ranking failures fall back independently and never release a pause, save in SAP, retry, change a selector or stop an engine.

## UX examples

A new user sees the normal business order, an “All automations” note, and a softly labeled Learning estimate. A returning user with frequent Source List activity sees Source List near the top of both Home shortcuts and Operations, with an explanatory local-history badge. The order remains fixed for that page session.

Illustrative RFQ calculation: 10 groups, no prior timing samples, startup 15 seconds → approximately 10 min 15 sec. If the first group completes in 20 active seconds, current-run correction can reduce remaining time to approximately 7 min 18 sec; after three equally fast groups, approximately 4 min 4 sec. Waiting for user action replaces the estimate entirely; resuming excludes that wait. These are arithmetic examples, not measured Production performance. Desktop screenshots use explicit UI-only mock estimates to verify rendering.

## Changed files

Feature implementation:

- `src/shared/local-intelligence.ts` — ranking/model arithmetic, schemas and true completed-unit classification.
- `src/shared/execution-history-types.ts` — optional performance field.
- `src/shared/ipc-channels.ts` — read-only snapshot and ETA event channels.
- `src/main/services/local-intelligence-service.ts` — bounded run observer, monotonic active clock and pause exclusion.
- `src/main/services/execution-history-service.ts` — optional timing retention and recoverable best-effort writes.
- `src/main/services/guided-automation-service.ts` — guarded interaction observer.
- `src/main/index.ts` — service wiring and ETA broadcasts.
- `src/main/ipc/history-handlers.ts` — trusted snapshot endpoint.
- `src/main/ipc/rfq-handlers.ts`, `me12-handlers.ts`, `me01-handlers.ts`, `apqp-handlers.ts` — advisory hooks around existing run callbacks/results.
- `src/preload/index.ts`, `src/preload/types.ts` — typed read-only snapshot and event bridge.
- `src/renderer/src/hooks/use-task-ranking.ts` — session-stable ordering with timeout fallback.
- `src/renderer/src/hooks/use-adaptive-eta.ts` — validated ETA subscription and failure fallback.
- `src/renderer/src/components/automation/AdaptiveEta.tsx` — bilingual remaining-time/learning/pause UI.
- `src/renderer/src/components/automation/GuidedAutomationPage.tsx` and `GuidedAutomation.module.css` — row/query ETA and completion-based progress.
- `src/renderer/src/pages/CreateRfqPage.tsx` — group ETA and true group-completion progress.
- `src/renderer/src/pages/OperationsPage.tsx`, `OperationsPage.module.css` — ranked grid and subtle local explanation.
- `src/renderer/src/pages/DashboardPage.tsx` — ranked Home task shortcuts.
- `scripts/test-local-intelligence.mjs` — arithmetic, timing, storage and four real IPC-adapter offline tests.
- `scripts/intelligence-smoke-test.mjs` — isolated desktop ranking/ETA test with all SAP boundaries mocked.
- `package.json` — test/intelligence-smoke scripts only; no dependencies added.
- `README.md`, `docs/LOCAL_INTELLIGENCE.md` — user and technical handoff.

Also retained from the preceding task-wording change (not engine modifications):

- `src/renderer/src/i18n/operation-copy.ts`, `translations.ts`.
- `src/renderer/src/pages/operation-name.ts`.
- `src/renderer/src/types/navigation.ts`.
- `scripts/smoke-test.mjs`, `rfq-smoke-test.mjs`, `apqp-smoke-test.mjs` (selector and bilingual layout checks).

## Verification

No test opens a real SAP connection. Engine/regression tests mock SAP/children; desktop tests use isolated temporary profiles, real template download/validation where applicable, and mock every confirmed SAP execution boundary.

- `npm run typecheck` — passed.
- `npm run lint` — passed after serial execution; no build-time temporary-file race.
- `npm run build` — passed (source compilation only, not packaging).
- `npm run test:intelligence` — 34 leaf cases, 38 Node tests including four parents; all passed. Covers cold start, frequency, recency, age decay, failure usage, corrupt histories, ETA fallback/history/current speed, pause exclusion, cancellation, bounded outliers, separate models, concurrency, retention and four actual IPC handlers observing mocked engines.
- `npm run test:guided` — 11 leaf/12 Node tests and 11 Python tests; all passed.
- RFQ integration 24, Qty/Cost Breakdown 12, recovery 13, material reset 9, runner 9 leaf/10 Node tests — all passed.
- APQP offline regression 13 and Source List offline regression 3 — passed.
- Intelligence desktop smoke — passed: new/returning Home and Operations, stable visible ordering, corrupt/late history fallback, true RFQ progress, learning/local ETA, WAIT/RECOVERING/resume, corrupt ETA not blocking execution, and Chinese dark/large display.
- Original guided and RFQ desktop smoke — passed. APQP desktop smoke — passed on isolated rerun after transient screenshot/control waits timed out in two prior runs. Offline APQP regression and validation remained successful; no real SAP query was attempted.

Screenshots are ignored test artifacts under `artifacts/`, not Production evidence: `intelligence-cold-start.png`, `intelligence-personalized.png`, `intelligence-rfq-eta.png`, `intelligence-rfq-paused.png`; Chinese dark/large variants are captured in the final smoke. Production timing accuracy still needs real user history and a QA-environment acceptance run.
