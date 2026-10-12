# Productivity estimates and RFQ restart review

## Scope

Source-only integration into the existing Electron/React Hub. Existing RFQ v32 SAP selectors and business functions are retained. No package or GitHub push is part of this change. Restart review does not issue any SAP commands.

## Time-saved accounting

`src/shared/time-savings.ts` calculates two local-calendar periods from `execution-history.json`: today and the last 30 days. Confirmed Success/Partial records with a positive successful quantity and a finite recorded duration qualify, unless dry-run or pending Safe Recovery. RFQ quantity is successful groups; other operations use successful records. Skips do not earn savings. Whole-run elapsed time is deducted once, including human waits and failed/skipped-row overhead. Negative contributions offset positive ones before flooring the period at zero. Future, duplicate, incomplete and diagnostic-migration records are excluded.

The owner's manual-effort estimates are RFQ 2100 seconds/group, SLT 300 seconds/record and APQP 300 seconds/record; Source List 300 seconds/record remains a reference assumption. These are not automatic empirical measurements. Key Users can edit seconds/unit and acknowledge calibration in Advanced Settings. Schema 9 upgrades only the unchanged, uncalibrated old default set; customised/calibrated values are kept. Historical estimates use the current baseline. Retention and history deletion reduce the available evidence; this is a local retained-history estimate, not a permanent business KPI. Ordinary history is capped at 500, with unresolved/running records protected beyond that cap.

## Recovery evidence and lifecycle

1. Native runner copies/validates input, then atomically creates a per-run ledger before engine launch.
2. Engine emits `ENGINE_READY` with its actual PID (not the `py.exe` launcher PID) and waits for a run-ID/PID-specific Hub marker. The marker is released only after durable PID storage. A missing marker times out before SAP access. Preview/standalone behavior is unchanged.
3. Project/group metadata and verified boundaries are synchronously persisted using a unique temporary file, flush and rename. Buyer Receipt/RFQ checkpoints come from existing engine wrapper events after successful Excel saving; they are evidence of the last confirmed boundary, not proof of the current SAP screen or absence of later writes.
4. Group ordinals never count as completions. Only recognised completed-group statuses are deduplicated into completed keys; failed/cancelled/unknown groups remain uncertain.
5. Clean exit + RUN_COMPLETED + no uncertain started groups closes the ledger. Failure, cancellation, missing terminal evidence or interrupted shutdown remains review-required. A failed durable boundary write requests the engine's normal safe stop and requires review even if subsequent storage succeeds; it never kills the process or replays SAP actions. Live current-Hub runs do not show restart notices.
6. On restart, retained Running RFQ history becomes Interrupted, not Failed/Success. Legacy Running/Interrupted entries lacking a ledger are imported as Unknown. Ledger-only runs remain visible even if history storage previously failed.

`src/main/services/rfq-safe-recovery-service.ts` is independent of cleanup and has no SAP or process-termination API. Ledgers are stored at `<Electron userData>/.local-data/data/rfq-recovery/<UUID>.json`. New working results go to `.local-data/logs/rfq-runs/<UUID>/output/`; the previous LocalAppData runs root is accepted only for existing saved results. Persisted result opening is restricted to direct, regular `.xlsx`/`.xlsm` files in the owned output directory; symbolic links/junction escapes and arbitrary paths are rejected.

## Human review safeguards

The panel appears above every route. Verify opens a short display-mode checklist, not a SAP connection or automated verification. Open Result is disabled until the old engine is confirmed stopped. Resolution has one explicit button confirming both a stopped task and SAP review. Mandatory checkboxes/text entry were removed; the backend generates an audit note and stores its timestamp, while rechecking identity, liveness, corruption and active-task guards. An API caller may still supply an optional specific note.

Resolution stores a durable timestamp/note, does not change successful/failed counts, and does not make an Interrupted/Failed run successful. Another RFQ is blocked while any unresolved record exists. Known live old engines also prevent other automation starts. A single-instance Hub lock reduces conflicting ownership. Unknown process state is not treated as proof that SAP writes never occurred. PID reuse/access failures can conservatively block; the Hub never kills a possibly unrelated process. Corrupt ledgers are preserved for Key User repair, not overwritten with an empty/success record. Unresolved evidence is protected from retention, normal history-cap pruning and Clear All.

## Automated acceptance

Run:

```powershell
npm run typecheck
npm run lint
npm run test:productivity-recovery
npm run test:artifacts
npm run test:history-deletion
npm run test:rfq
npm run test:rfq-runtime
npm run test:rfq-recovery
npm run test:rfq-runner
npm run smoke:safe-recovery
```

Node/Python tests cover full-wall-time accounting, periods/exclusions, 7/12 restart evidence, saved-Buyer checkpoints, actual-process launch handshake, corruption/process safeguards and automatically recorded review notes. Generated-file tests cover all four task adapters, unchanged originals, Excel-lock fallback, legacy results, exact 60-day expiry, protected unfinished evidence, linked roots and lock retry. Electron acceptance uses isolated temporary user-data/LocalAppData and mocks all SAP-start boundaries. It covers result opening, baseline edits, cleanup, bilingual dark/large UI, one-click review without forms, restart persistence and a test-owned live Node process guard. No SAP/Production transactions are performed by these tests. Screenshots are generated in ignored `artifacts/`.

## Generated-file retention

Each new run has an `artifacts.json` ownership/completion manifest. Generated backups, screenshots, CSV diagnostics, temporary files and standalone outputs expire 60 days after completion. Both managed roots are scanned at startup and daily while idle, independently of history caps or Clear All. Unfinished manifests and pending RFQ run IDs are protected. A full tree is validated before deletion; links, corrupt/missing completion metadata and external original workbooks are never deleted. Locked-file failure retains the manifest for a later retry. Users should export important results before expiry. Clear All preserves workbooks; automatic expiry deliberately includes managed generated workbooks. Old external sidecars and manifests absent from earlier versions are conservatively preserved rather than guessed. Persistent settings, browser profiles and recovery ledgers are outside disposable runs.

The legacy, currently unlisted PR/ME52N adapter also routes backups/snapshots/CSV into a supplied managed run; its default durable checkpoint is keyed by input path under a non-disposable checkpoint subdirectory, preserving cross-run skip identity. On first use of the new default location, the known legacy checkpoint beside the input is read and saved to the managed location without moving or deleting the original. Corrupt legacy evidence blocks execution rather than silently repeating completed PRs. It is not activated as a new Operations card. Persistent checkpoints are recovery state, not disposable logs.

## Release limits

Actual SAP crash/disconnection behavior has not been validated against Production. Before distribution, rebuild the shared Python/PyInstaller automation engine so it contains `--hub-ready-file` support; do not combine this source change with an older prebuilt engine. Test on QA with approved test data, interrupt the Hub around known boundaries, verify persisted evidence and manually compare Buyer Receipt/RFQ/Excel before any rerun. Abrupt storage/power failure can still leave writes unconfirmed; that is precisely why this feature requires human SAP verification rather than automatic resume.
