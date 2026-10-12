# Purchasing Automation Hub

Local-first Windows desktop purchasing automation. Normal users choose a task, download and fill its template, upload, review, and start. No paths, session indices, Python setup, timeouts or transaction parameters are required in normal workflows.

## Operations

| Task | Business inputs | SAP access |
|---|---|---|
| Create Buyer Receipt / RFQ | Existing RFQ template and accepted Production confirmation | Native SAP GUI; accepted RFQ v32 baseline unchanged |
| Update Info Record | Info Record / Plant template; target Plant, purchasing organization, lead time, standard/consignment type | Chrome or Edge WebGUI; concurrent independent worker windows |
| APQP | Material and supplier template; Plant and optional refresh of existing Excel dates | Native SAP GUI; read-only plan close date queries using available idle sessions |
| Update Source List | Material No., Parma, required Dual Sourcing Yes/No | Native SAP GUI; Plant C100; adds/reuses target with Fix + MRP 1; Yes retains other Fix/MRP, No clears all other Fix/MRP; never deletes rows |

Each card has Open and Info. Info shows a bilingual step guide. Only supported purchasing operations are listed; there are no placeholder actions.

### Template workflow

1. Download template: choose a save location; the app reports the actual saved filename and reveals it in Explorer.
2. Fill the input columns and save Excel. Excel may remain open.
3. Upload: the application detects the input sheet and required columns, validates, and displays business counts and a sample.
4. Review: writing tasks show one batch confirmation immediately before starting. APQP does not require a SAP-write confirmation.
5. Run: progress is shown in the app. Navigating does not discard an active task.
6. Result: Total / Successful / Skipped / Failed, Open Result, View Details and Run Another Task.

All four task pages have a top action bar with Start / Stop safely and Clear this page. Navigation keeps page data. Confirmed Clear resets only the current page's inputs, business options, preview, messages and displayed results to defaults; it never deletes Excel files, templates, history or logs, and never rolls back SAP changes. Clear is unavailable during a run or file upload/download. Result locations remain in Execution History.

ME12 writes a separate result workbook under managed logs if Windows locks the original. Source List and APQP still use Excel COM to update workbooks already open, without closing them. Backups, temporary files, error screenshots and independent result files go to `<Electron userData>/.local-data/logs/automation-runs/<UUID>/`; RFQ snapshots/results go to `logs/rfq-runs/<UUID>/`. No generated sidecars are added beside the selected workbook. User-selected template downloads are unchanged. Do not edit purchasing inputs during a running batch.

At startup and every 24 hours while idle, finished, app-owned generated run files older than 60 days are removed, including backups and independent result workbooks. Save important generated results elsewhere before expiry. Original user workbooks are never included. Running/unfinished manifests and unresolved RFQ evidence remain protected; corrupt manifests, linked/junction paths and locked files are kept for review/retry. Manual Clear All Logs still preserves business workbooks; it is not the same as the scheduled expiry policy. Old external sidecars are not guessed, moved or deleted; legacy RFQ results remain available to Safe Recovery. Settings, browser sign-in profiles and recovery ledgers are persistent app data, not disposable logs.

ME12 input needs numeric Info Record identifiers up to 10 digits and Plant headers. Source List needs Material No., Parma and required Dual Sourcing Yes/No; blank is invalid. Its page defaults to execution-day validity start, 31.12.2099 end and purchasing organization C100, editable and shown in confirmation. A target supplier/organization row covering the requested interval is reused; otherwise a verified empty row is filled with the new dates, supplier, organization, Fix and MRP 1. Yes preserves all other Fix/MRP; No clears all other Fix/MRP, including expired/future rows, without deleting records or changing their dates. Conflicting template suppliers/modes, overlapping/ambiguous target intervals, unavailable empty rows or unreadable/read-only controls stop safely. Table cells are discovered by the recorded technical field IDs, not numeric GetCell. Excel SUCCESS never bypasses SAP rechecking; matching states skip Save. Error details include stage and Excel rows, with UTF-8 traces under the managed run logs. APQP keeps A–E headers; incomplete material/supplier pairs block Start. Existing dates are kept unless Refresh is chosen.

## Pauses and safe stopping

The three guided modules share READY, VALIDATING, READY_TO_START, RUNNING, WAITING_FOR_USER, RECOVERING, COMPLETED, COMPLETED_WITH_WARNINGS, FAILED and CANCELLED states.

Certificate selection and SAP credentials remain manual. The Hub does not read certificate private keys or store passwords. It can open installed SAP Logon when no SAP GUI is available; users sign in themselves. Native operations automatically detect one signed-in environment and idle eligible windows. When multiple environments/users are open, the Hub asks users to leave one intended environment available rather than guessing.

A global Action Required dialog persists across routes. Continue performs read-only verification first; a failed check remains paused. Unknown or uncertain write outcomes offer Stop only. Source List verifies the original signed-in session, material and Plant while reading/editing rows; unknown failures show actual stage/error, Excel rows and a technical log path, then stop without Save replay. ME12 waits for all browsers to sign in before any record write; on an unverified record, workers finish their current records, save partial results, and stop scheduling new work before the pause appears.

Stop preserves saved SAP changes; it is not rollback. Closing the app during a task requests safe stopping and waits for the engine to finish. Interaction snapshots are local diagnostics, not automatic crash-resume instructions.

## Settings and diagnostics

Normal Settings: Language, Theme, Text Size, Notification Sounds and Open Result After Completion (the three guided modules). Technical settings are collapsed under Advanced / Key User Settings: company WebGUI URL/browser, worker limits, download location and diagnostics.

Sounds are generated locally, optional, lightweight and non-blocking: success, attention, error. Audio failure does not change the automation state.

Settings and structured logs are in the hidden per-user .local-data folder. Real execution history and dashboard statistics use local completed/running tasks. Raw backend messages, transaction codes and file paths are under View Details / Advanced, not primary error notices. Business identifiers may occur in diagnostics; review logs before sharing.

Normal result-open requests are limited to files issued by the current automation session. Safe Recovery also accepts a persisted run ID for a verified, app-owned result workbook after restart; it never accepts arbitrary renderer file paths.

## Estimated time saved and Safe Recovery

Dashboard shows **estimated** time saved today and over the last 30 local calendar days. It uses confirmed successful groups/records from retained execution history, not sample dashboard data. Manual estimate = successful quantity × manual baseline; savings = manual estimate minus full batch wall time (including pauses and SAP waits), floored at zero across the period. Worker count does not multiply elapsed time. Failed/cancelled/dry-run/unresolved work, skipped units and legacy diagnostic-only records without measured durations are excluded.

Manual-effort defaults now use the owner's business estimates: RFQ **35 minutes/group**, SLT **5 minutes/record**, APQP **5 minutes/record**. Source List **5 minutes/record** remains a reference assumption. Adjust and mark calibration in **Settings → Advanced / Key User Settings**. Untouched old default sets upgrade automatically; custom or calibrated values are preserved. Changing a baseline resets calibration acknowledgement. Estimates are recalculated using current baselines, not presented as measured human productivity. Deleted/expired history no longer contributes; ordinary local history is capped at 500, with running/unresolved records protected.

After restart, a global **Safe Recovery** panel identifies unfinished/uncertain RFQ runs: Project, confirmed completed groups, last confirmed checkpoint, current group details and any saved RFQ numbers. Evidence is atomically persisted in `.local-data/data/rfq-recovery/<run-id>.json`, independently of log retention. A launch handshake records the actual Python/engine PID before SAP access. No run automatically resumes, replays Create/Save, rolls back SAP changes or terminates another process.

- **Verify in SAP** opens a manual, read-only verification checklist, not an automatic SAP query. Users check the corresponding system and existing Buyer Receipt/RFQ before retrying.
- **Open Result** opens only a saved workbook directly inside that run's owned output folder after the old process is confirmed stopped. It may contain only the last successful Excel save, not every SAP commit.
- **Mark Resolved** uses one explicit **Checked in SAP — Finish Review** button confirming the task stopped and existing objects were checked. No checkboxes or mandatory written note. The backend records the confirmation text/time automatically and still blocks live engines or corrupt evidence. Execution status/counts are not converted to Success.

New RFQ runs are blocked until pending reviews are resolved. Known live old engines also block starting other automation tasks. Unknown process state requires explicit human confirmation; inaccessible/reused process IDs conservatively block review rather than killing a process. Legacy interrupted runs without checkpoint evidence show Unknown. Corrupt ledgers are preserved for Key User inspection and cannot be silently dismissed. Unresolved history and diagnostics survive Clear All and 60-day retention. This is a review workflow, not automatic crash-resume.

See [implementation and acceptance limits](docs/PRODUCTIVITY_SAFE_RECOVERY.md). Portable release 0.2.4 rebuilds the shared engine with the launch handshake; see [release verification and endpoint acceptance limits](docs/RELEASE_0.2.4.md).

## Local smart ordering and remaining-time estimates

Home shortcuts and Operations now prioritize tasks from this device's last 60 days of execution history. A page takes one ranking snapshot on entry; cards do not rearrange while it is open. New devices and unreadable history retain the original business order.

Each automation learns its own active timings from existing progress events. The remaining-time panel combines bounded historical EWMA with the current batch speed and actual worker count. A new device shows a built-in estimate marked **Learning**. Human-action and verification pauses show a waiting/checking message instead of a countdown and are excluded from learning. Cancelled/crashed runs are not clean samples; safely completed units from failed runs can still be used.

Everything stays in the existing local `execution-history.json`. At most 100 timing summaries per function are retained, without pruning normal history for ETA purposes. There are no analytics services, extra dependencies or personalization settings. Ranking/ETA errors never authorize or stop a SAP operation. See [implementation and test handoff](docs/LOCAL_INTELLIGENCE.md).

## Create RFQ validation and launch

Open **Operations → Create RFQ**: download the template, fill and save Excel, upload, review validation and Parma groups, then confirm Production VCE [949] / Client 100 once. `[949]` is the SAP Logon entry code, not the client. Existing signed-in, ready target sessions are reused; an existing mismatched or not-ready target connection stops the run instead of creating another login. No `.env`, Python path, SAP password or technical settings are required. The source workbook is not modified; a local working copy receives the supplied engine's status columns and RFQ numbers.

The supplied native SAP GUI RFQ v32 engine performs NPL → Buyer Receipt → RFQ in `ZMFM050072`. Plant + Project + Parma grouping (up to 50 materials), green Buyer Receipt verification, existing-RFQ skips, PPAP handling, recovery, number extraction and workbook saving are retained. Validation never opens SAP. Modified inputs require a new preview. Exact normalized business duplicates are automatically skipped; rows with different input values retain validation errors showing the differences. The original upload remains unchanged.

User-fixable SAP issues pause execution with a shared application modal, attention sound and taskbar flashing. Continue verifies the original SAP session and current checkpoint before resuming; failed verification stays paused. Supported boundaries are the current PROD RFQ staging screen and a manually saved-green Buyer Receipt. Unknown or uncertain RFQ creation outcomes offer Stop only. Stop while paused saves current results and cancels unfinished groups immediately. Before a new SAP action is dispatched, polling waits stop at the next cancellation check, without waiting for the 180-second hard limit or clicking a newly found button. Once a non-NPL action has been dispatched, the current group, RFQ number and Excel writeback remain protected before stopping; no next group starts. An in-flight synchronous COM call must return before cancellation can be observed. No created SAP object is rolled back. The UI acknowledges the request, explains any protected wait, and updates one live entry for repeated waits on the same control; raw diagnostics remain intact.

RFQ runtime hooks check `ZCOMCODE` on freshly matched NPL rows using project field `ZPSPID` before creating a Buyer Receipt. Empty Commodity pauses for manual maintenance; technical read failures have a separate message and never imply missing master data. An exact NPL re-query is required before resuming. Ordinary slow SAP responses show a waiting status; a hard limit pauses instead of replaying Save/Create. All four task pages show Running while active, including across navigation, with paused/checking states taking precedence. Execution history (25/page) and diagnostics (20/page) support pagination and confirmed Clear All, not individual delete buttons. Completed history and identified logs older than 60 days are cleaned at startup and daily while idle; source/result workbooks, backups and unfinished records are protected. See [runtime improvements and acceptance limits](docs/RFQ_RUNTIME_IMPROVEMENTS.md).

See [RFQ integration handoff](docs/RFQ_V32_INTEGRATION.md) for defaults, file inventory, offline tests, runtime folders and manual release checks. Production has **not** been tested by this implementation. The owner authorized portable release 0.2.4; no additional RFQ write-flow optimization was included for packaging.

## Developer setup and tests

Development requires Windows, Node/npm, Python with the existing engine dependencies, installed SAP GUI with Scripting for native acceptance tests, and Chrome/Edge for WebGUI acceptance tests. The portable 0.2.4 distribution includes its own Python runtime; company SAP/Excel/browser prerequisites still apply.

```powershell
npm install
npm run dev
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run smoke:rfq
npm run smoke:apqp
npm run test:guided
npm run test:rfq
npm run test:rfq-fields
npm run test:rfq-recovery
npm run test:rfq-material-reset
npm run test:rfq-runner
npm run test:rfq-runtime
npm run test:history-deletion
npm run test:productivity-recovery
npm run test:artifacts
npm run smoke:safe-recovery
npm run smoke:task-controls
npm run smoke:rfq-runtime
npm run smoke:rfq-stop
npm run test:apqp
npm run test:me01
```

Desktop smoke uses real local template downloads and previews, but mocks every SAP execution boundary. Regression tests use fake SAP/Excel objects and child engines; they never perform Production writes. Screenshots are under artifacts. See [guided workflow handoff](docs/GUIDED_WORKFLOWS.md) for the completion matrix and acceptance checks.

Architecture remains Electron main/preload/React with trusted renderer IPC, context isolation, sandboxed renderer and purpose-specific bridge methods. Shared guided UI is in src/renderer/src/components/automation; small native pause adapters preserve the stable SAP business engines. No cloud service, telemetry, AI recovery or auto-update is added.
