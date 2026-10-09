# RFQ v32 integration handoff — updated 2026-10-03

## Delivery status

Source integration completed. **Packaging is paused at the owner's explicit request. No new application EXE/ZIP is being delivered.** The shared-engine build/self-test was exercised earlier in development, before that request and before the final adapter edits; it is not a final release artifact. A future release must rebuild the engine and run packaged smoke tests against the final source.

**No real SAP Production operation was executed.** All RFQ execution tests replace SAP with mocks; Excel validation-only tests do not initialize a SAP session. The generic WebGUI smoke test uses localhost, not a SAP endpoint.

## User flow and architecture

Operations → Create RFQ → Download template → Fill/save Excel → Upload → automatic validation → grouped preview → one Production confirmation → progress → RFQ numbers and Open Result File.

React → typed preload/contextBridge → trusted Electron IPC → main-process runner → shared Python runtime → supplied native SAP GUI engine.

The renderer has no Node/filesystem/process/COM access. Main validates IPC, owns file copies and child processes, and accepts structured `HUB_EVENT:` JSON only. Normal console output remains in local diagnostic logs. Result opening is allowlisted to paths returned by this app session. Navigation does not discard RFQ progress/results.

## Supplied logic and minimal adapter

`resources/rpa/rfq_engine.py` is the supplied v32 implementation. Its SAP selectors and overall business flow were not rewritten. Following the owner's corrected Qty/Cost Breakdown and required-field requests, three functions intentionally changed (`prepare_prod_direct_rfq_rows`, `fill_rfq_grid_rows`, `fill_buyer_receipt_rows`): No/blank clears the configured supplier's checkbox; Yes preserves its current SAP state (including an unchecked state). Empty supplier slots are not touched. Optional prototype quantity is not written when blank. A regression digest checks the other 68 business function/class definitions against the supplied implementation (excluding startup/main and ExcelStore, version-label normalization only).

Intentional integration edits: optional startup/runtime configuration; a wrapper around the original main; removal of a machine-specific Excel default; `Intended Supplier` header alias; preservation of VBA when loading `.xlsm`; consistent v32 release identification. Historical algorithm-version comments in the source are not separate engine versions.

`rfq_runtime.py` adds validation-only operation and observes existing function boundaries. Status events are published **after successful workbook saves**. It handles Windows UTF-8 output, Path JSON conversion, persisted result paths, action-required notices, partial-group counts and graceful stopping. It does not replace SAP execution steps or invent unknown-state recovery.

## Exact input deduplication and manual checkpoints

`rfq_interaction.py` compares all normalized business inputs in `MaterialTask`, excluding only the Excel/SAP execution row indexes. This covers Plant, Project, Material, all five supplier/email/Cost Breakdown slots, dates, Technology, all three quantities, AFM, allow-without-preferred, attachment, RFQ comment and batch group. Equivalent decimal quantities compare without rounding; blank prototype quantity remains different from zero. The first equivalent row is retained. Later copies receive `DUPLICATE_SKIPPED` / `INPUT_DEDUPLICATION` / `Duplicate of Excel row N` in the run working copy only. Preview shows input, ready-unique and duplicate counts. Differing values for the same material/group remain invalid and expose their differences. Copies of rows already marked successful are excluded from new execution.

The desktop runner supplies a run-local control directory. Python blocks in `WAITING_FOR_USER` after saving the checkpoint; it issues no SAP writes while waiting. The shared `AutomationInteractionManager` and `ActionRequiredModal` render a native HTML modal outside route containers, with the existing notification/sound manager and best-effort Electron `flashFrame`. Escape cannot dismiss the modal. Main validates the current Run ID, request ID and allowed action, then writes an atomic response file. Old/double responses are rejected. The request can be queried again after renderer reload. Notification/sound failures cannot release the Python wait.

Continue enters `RECOVERING` and reads the same session/system/client/user, Busy flag, open dialogs, SAP status, screen, material mapping and relevant Plant/supplier fields. Supported resume boundaries:

- PROD RFQ staging after Create RFQ-from-Buyer-Receipt: verify unique material rows, matching Plant/available Project/supplier slots, checkbox types and editability for requested No values; resume at checkbox updates without re-pressing the creation button.
- Buyer Receipt save/precondition: user manually corrects and saves the current Buyer Receipt; verify green status, unique material mapping, Plant/Project/supplier slots and supplied quantities; continue RFQ without re-creating or saving the Buyer Receipt again.

Existing successful automatic PPAP/master-data/lock/popup recovery remains in the supplied flow. Only identified master-data errors at known pre-RFQ boundaries offer Continue. Arbitrary errors, post-final-save failures and uncertain RFQ number extraction offer Stop only. Failed verification creates a fresh prompt and stays paused. SAP duplicate rows are never deleted, merged or chosen by the first match. This change does not automatically resolve duplicate records already present in SAP.

Paused Stop saves `CANCELLED` for unfinished rows/groups, retains completed RFQ statuses/numbers and preserves `CREATED_NUMBER_NOT_FOUND` where the creation outcome is uncertain. CSV/local logs and result workbook are flushed before exit. Normal running Stop still finishes the current group. The checkpoint is stored in `temp/interaction/checkpoint.json`; `logs/run.json` records the terminal state. Closing the app requests cancellation through the same stop marker. Process/app restart is not automatic SAP resume: it still requires reviewing saved results.

Preserved behaviors:

- Plant + Project + Supplier Parma grouping, maximum 50 materials per RFQ, including 50+1 splitting.
- Exact single-material NPL lookup and multi-material Windows clipboard selection.
- Buyer Receipt save confirmation and green-status requirement; already-saved green Buyer Receipt resume.
- Existing RFQ skips; Excel PPAP fallback and input-required rows; known Buyer Receipt master-data recovery.
- Direct PROD RFQ flow, normalized date writes, popup handling, terminal success/number extraction and Back ×4.
- Same RFQ number written to every successful material row; existing workbook status columns, CSV logs, Excel lock fallback and COM synchronization retained.

Group header fields continue using the source engine's first-row policy. Conflicting email/date/optional header values generate a preview warning rather than changing grouping. RFQ remains sequential within the supplied SAP session; this integration does not add concurrent RFQ writers or change other operations' concurrency settings.

## Internal defaults (no normal-user `.env`)

The complete supplied baseline is in `resources/rpa/rfq_defaults.py`.

| Area | Internal behavior |
| --- | --- |
| SAP | PROD; VCE [949] / Client 100; `VCE - One Digital Core [949]`; [949] is the Logon entry code, not the SAP client; currently signed-in user; no stored credentials |
| Guards | Environment guard and auto-select enabled; unverified environment forbidden; production write enabled only after Hub confirmation |
| Excel | Path supplied by UI; `RPA_Input` or detected compatible sheet; row 2; aliases resolve email/date columns; backup/lock fallback/COM sync enabled |
| Grouping | `GROUP_RFQ_BY_PARMA=true`, `MAX_MATERIALS_PER_GROUP=50`, no group-count limit |
| NPL | Exact and multi-material query enabled; strict transaction reuse retained |
| Buyer Receipt | Save confirmation, green status and resume all enabled |
| PPAP/recovery | Validation and Excel fallback enabled; existing-RFQ and known master-data recovery preserved |
| RFQ | Direct PROD continuation; calendar picker disabled; supplied popup timing/retries; `created successfully` detection; Back ×4 |
| Timing | Supplied SAP login, wait, polling and Excel save retry values remain internal |

Hub mode clears every known engine environment option before applying the baseline, so stale Windows environment variables and a developer `.env` cannot redirect it. Validation always disables production writes. The original SAP system/client/connection checks still run before SAP writes. Manual standalone development can use an optional `.env`; no `.env` alone does not authorize a standalone Production write. The ordinary UI exposes no QA switch or technical fields; QA remains a developer-only runtime path.

Duplicate-login protection: RFQ reuses a signed-in, non-busy target session without a modal dialog. If the target connection already exists but its identity does not match, sign-in is incomplete, or all matching sessions are busy/blocked, it stops with a diagnostic instead of opening another connection. A target connection with no readable sessions is also protected; an unreadable connection inventory fails closed. Only an absent target connection permits one automatic open. This never selects the multiple-logon option that ends existing logins. The authorized change is limited to `SapSession._get_or_open_target_session`; RFQ transaction/business methods remain baseline-protected.

## Workbook and local data

The template columns A–H are Plant (C100), Project No., Material No., Supplier Parma, Supplier Email, Quotation Due Date, PPAP Date, Technology. I–L expose **12 MR Qty**, **RFQ Qty Prototype**, **RFQ Qty Serial**, **Cost Breakdown**. G/H/I/K are required in addition to the existing A–F inputs. Upload and pre-run validation reject missing required columns or blank required cells. I/J/K have no defaults in the template or Hub runtime; explicit zero is preserved. Optional J is not written to either SAP grid when blank. The standalone developer baseline remains separate. The old Intended Supplier header remains accepted as an alias. Cost Breakdown offers No/Yes, default No. No/blank **forces the configured supplier checkbox unchecked**; Yes leaves SAP untouched, even when already unchecked. Upload details show all four values per material. Header explanations and Instructions describe the requirements. Dates should use `YYYY-MM-DD`; supported Excel date cells/text formats are normalized by the supplied engine.

The former production readiness probe wrote `LIFNR1_CB` before processing. It now checks cell type and editability without writing, using the documented [SAP GuiGridView read APIs](https://help.sap.com/docs/help/b47d018c3b9b45e897faf66a6c0885a8/4af24c3281fb4d6a809e53238562d3b2.html). Wrong/read-only screens still stop rather than falling back to blind clicks. Real installed SAP GUI compatibility still requires manual acceptance.

Each validation/run uses `%LOCALAPPDATA%\SAP Automation Toolbox\runs\<run-id>\` with `input`, `output`, `logs`, `temp`. Input snapshots are immutable; only an output working copy is executed. Its SHA-256 must match the preview before SAP can start. Save Excel before uploading: unsaved in-memory edits are not read. The original may stay open. Results are deliberately in a **separate local workbook**, not silently written into the original upload.

The packaged shared runtime is copied into a versioned local `engine-cache` before RFQ starts; it is not executed from a corporate shared drive. The app still uses one packaged Python runtime for RFQ/ME01/ME52N/APQP. A final package will include Python/pywin32/openpyxl/dotenv and existing engine dependencies; end users will not install Python or Node themselves.

`logs` contains UTF-8 `engine.log`, the source engine's CSV copy, and `run.json` (app/engine version, Run ID, timestamp, stage, error and result). The existing execution-history service records group totals and partial outcomes. The diagnostics button opens this local folder for manual sharing. There is no new upload/reporting service. Logs can include purchasing identifiers, SAP user identity, file paths and SAP messages; review before sharing. Passwords and certificates are not requested or collected. Preview/run retention is currently manual; there is no automatic deletion policy.

During ordinary execution, Stop requests a marker and waits for the current group to finish/save; closing the app during a run uses the same mechanism. This can take as long as SAP waits/retries. While paused for manual correction, Stop instead saves the current checkpoint, marks unfinished work cancelled and exits without starting another group. Do not force-kill SAP/Electron midway through a save. In-app notifications use the common manager; sounds are best-effort local Web Audio and cannot fail the operation.

## Verification

### Material criteria isolation (2026-10-03)

Each new NPL query now opens the Material multiple-selection dialog, deletes
all prior selection criteria with its Delete All control, and replaces them
with only the current group. Multi-material clipboard import no longer appends
to retained select-options. Single-material and project queries also clear the
previous multi-selection before setting the visible input. This resets query
filters only; it does not delete or modify previously created SAP objects.

Before any new Buyer Receipt creation, an exact NPL query result is checked for
materials outside the current group. Unexpected materials stop execution at
`NPL_MATERIAL_SCOPE`; missing/failed reset controls stop before query execution.
Neither case blindly selects/deletes unrelated rows. Existing exact row matching
and fresh grid selection remain in place. Recovery on the current saved-green
Buyer Receipt remains unchanged and does not clear that recovery screen.

`npm run test:rfq-material-reset` covers 9 offline scenarios, including the user's
54955 → 43888 → 47986 groups, multi/single transitions, stale ranges/exclusions,
clear-before-upload order, no-op/missing controls, wrong popup, failure to close,
unexpected SAP results and replacement of previously selected grid rows. All
SAP and clipboard interactions are simulated; live SAP GUI acceptance is still
required. The baseline AST guard excludes only the two authorized query methods
and their new helper; the remaining original SAP methods remain protected.

The following checks passed locally on 2026-09-30. The general smoke initially exposed a hidden RFQ-text locator collision and a 45-second browser-start timeout; its locator was tightened and its wait extended to 90 seconds, then the complete suite passed. No browser/SAP business logic was bypassed to make it pass.

- `npm run typecheck`
- `npm run lint`
- `npm run build` (compiled app assets only, not an EXE/ZIP release)
- `npm run test:rfq`: 24 offline tests, including baseline AST comparison, no-SAP validation, aliases/dates/invalid data, grouping, environment guards, non-green Buyer Receipt rejection, PPAP notice, partial-group counts, RFQ number writeback, lock fallback, UTF-8 and cancellation.
- `npm run test:rfq-runner`: 6 runner scenarios (Node reports 7 including parent): local copies, unchanged source, terminal counts, UTF-8, fingerprint rejection, confirmation guard, silent/nonzero exit and concurrency/cancellation.
- Updated 2026-10-03: runner suite now covers 9 scenarios (Node reports 10 including parent), including stale/double interaction responses, rechecks, Continue/Stop, unknown-state blocking and notification failure.
- `npm run test:rfq-fields`: 12 offline cases for template fields/defaults/native table headers, required input/header validation, blank optional J without SAP writes, quantity preview and material-row writes, zero values, No/blank/False clearing pre-checked boxes, mixed suppliers/rows, Yes preserving checked/unchecked/read-only states without writes, wrong-screen rejection and the ordinary RFQ path. No SAP sessions are opened.
- Existing Python regression suites: APQP 13; ME52N 5; ME01 3.
- `node scripts/rfq-smoke-test.mjs`: real template download and Python validation; production refusal, confirmation modal, mocked execution/results, artifact allowlist, navigation retention and dark/large-font layout.
- Updated 2026-10-03: `npm run test:rfq-recovery` adds 13 offline cases for normalized/all-field exact duplicates, differing inputs, completed-row copies, both resume boundaries, failed/successful checks, same-session guards, wrong screen/supplier/quantity, preserved created RFQs, cancelled future groups and no duplicate SAP action. RFQ smoke additionally checks duplicate counts, global modal outside RFQ page, Escape blocking, failed checks, Continue/Stop, unsafe-state buttons, denied audio and dark/large layout. All SAP actions in these tests are mocks.
- `node scripts/apqp-smoke-test.mjs`: existing download/preview/authorization regression; no SAP query.
- `node scripts/smoke-test.mjs`: app routes, templates, settings, browser-error path, local history and dashboard regression.

## Release gates / remaining risks

1. **Manual SAP acceptance remains required.** Validate exact Logon entry/system/client, GUI Scripting permissions, SSO/login, native controls/popups, clipboard selection, single- and multi-material RFQs, 50+1 splitting, PPAP/green-state/recovery, extracted RFQ numbers and final Excel rows. Mocks cannot prove compatibility with every user's SAP GUI installation.
2. **Final packaging remains deferred.** Rebuild from final source, repeat packaged offline RFQ validation/smokes, then test extraction/startup on a representative end-user PC. Do not distribute an earlier build as this update.
3. SAP GUI and authorized access remain prerequisites. Company endpoint protection/network-drive restrictions may still require IT help; bundling Python cannot remove those policies.
4. Final result paths may switch to a fallback when locked. Use Open Result File and review every skipped/failed row before retrying; there is no force-resume for unknown SAP states.
5. This release adds no cloud service, telemetry, auto-updater, parallel RFQ session pool or credential storage.

## Complete changed/added file inventory

Engine:

- `resources/rpa/rfq_engine.py`
- `resources/rpa/rfq_defaults.py` (new)
- `resources/rpa/rfq_runtime.py` (new)
- `resources/rpa/rfq_interaction.py` (new)
- `resources/rpa/automation_engine_launcher.py`

Main/preload/shared:

- `src/main/automation/rfq-native-runner.ts`
- `src/main/services/rfq-excel-service.ts`
- `src/main/ipc/rfq-handlers.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/preload/types.ts`
- `src/shared/ipc-channels.ts`
- `src/shared/rfq-batch-types.ts`
- `src/shared/automation-interaction.ts` (new)

UI/template:

- `src/renderer/src/pages/CreateRfqPage.tsx`
- `src/renderer/src/pages/CreateRfqPage.module.css` (unused old RFQ styles removed)
- `src/renderer/src/pages/OperationsPage.tsx`
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/common/ActionRequiredModal.tsx` (new)
- `src/renderer/src/components/common/ActionRequiredModal.module.css` (new)
- `src/renderer/src/components/common/AutomationInteractionManager.tsx` (new)
- `src/renderer/src/hooks/use-notifications.ts`
- `src/renderer/src/hooks/notification-sound.ts` (new)
- `resources/templates/Create_RFQ_Template.xlsx`

Tests/build/documentation:

- `scripts/test-rfq-integration.py` (new)
- `scripts/test-rfq-runner.mjs` (new)
- `scripts/test-rfq-qty-cost-breakdown.py` (new)
- `scripts/test-rfq-recovery.py` (new)
- `scripts/test-rfq-material-reset.py` (new)
- `scripts/fixtures/rfq-mock-engine.mjs` (new, test-only; no SAP imports)
- `scripts/rfq-smoke-fixture.py` (new)
- `scripts/rfq-smoke-test.mjs`
- `scripts/smoke-test.mjs`
- `scripts/build-automation-engine.ps1`
- `scripts/package-portable.ps1`
- `package.json`
- `.gitignore`
- `README.md`
- `docs/RFQ_V32_INTEGRATION.md` (new)

Ignored `.artifact-work`/`artifacts` files are local template inspection and screenshot evidence, not shipped application code.
