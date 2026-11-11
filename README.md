# Purchasing Automation Hub

Local-first Windows desktop purchasing automation. Normal users choose a task, download and fill its template, upload, review, and start. No paths, session indices, Python setup, timeouts or transaction parameters are required in normal workflows.

## Version 0.3.0 — Windows portable release

- One task can run at a time. Other pages remain available for preparation, but their SAP Start actions are disabled until the current task ends. Use **Go to running task** to return. Background result dialogs do not block the page you are using.
- Refreshed bilingual dashboard, Operations, Settings and History; the sidebar collapses from its footer. The header reports live task status. The estimated savings card shows today and all retained local history.
- Workflow screens load on demand; navigation can preload the intended page. Concurrent local history reads are shared, and typing in History does not issue a new query on every key.
- APQP date management uses **SAP 949 only** and pre-fills the Windows login as an editable owner filter. It saves and verifies only four planned dates: RTS Confirmation, RTS Action & Closure, Total PPAP and APQP Closure. Grey fields are not edited. The Excel closure-date query remains read-only in SAP.
- ME12 supports independent SLT, PDT and confirmation-control updates for Standard and Consignment. MM02 adds a six-digit Sub-commodity task with its own template and result workbook.

Download the Windows ZIP from [v0.3.0 Releases](https://github.com/3205579336a-glitch/automation-hub-center/releases/tag/v0.3.0). Extract it completely into a new local folder, then open **SAP Automation Toolbox.exe**. The Python runtime is bundled; company SAP/Excel/browser prerequisites and security policy still apply. See [release notes](docs/RELEASE_0.3.0.md). Offline and packaged checks do not authorize or claim live production writes.

## End-user documentation

- [0.3.0 English user guide](docs/USER_GUIDE_0.3.0_EN.md)
- [0.3.0 中文操作指南](docs/USER_GUIDE_0.3.0_ZH.md)

The earlier [English manual](docs/USER_MANUAL.md), [中文手册](docs/USER_MANUAL_ZH.md), and printable PDFs in `output/pdf/` are archived **0.2.4** references, not current workflow instructions.

## Operations

| Task | Business inputs | SAP access |
|---|---|---|
| Create Buyer Receipt / RFQ | Existing RFQ template and accepted Production confirmation | Native SAP GUI; accepted RFQ v32 baseline unchanged |
| Update Info Record | Independent SLT, PDT and Conf. Ctrl. per Excel row. Default Plant/Org C100 and Standard + Consignment. Blank change fields keep the current SAP values. | Chrome or Edge WebGUI; both types of each IR run in the same worker |
| APQP Date Management | Project + responsible User ID for four planned dates; or the material/supplier Excel template for plan closure queries | Native SAP GUI; fixed 949; verified batch planned-date Save or read-only Excel query |
| Update Source List | Material No., Parma, required Dual Sourcing Yes/No | Native SAP GUI; Plant C100; skips an existing target Parma. For new targets, adds Fix + MRP 1; Yes retains other Fix/MRP, No clears other Fix/MRP; never deletes rows |
| Batch Update Sub-commodity | Material and exactly six digits in Sub-commodity (keep leading zeros) | Native SAP GUI MM02; verified, idle Production 949 session; updates the named characteristic under `YY_COMMODITY` and verifies by reopening |

Each card has Open and Info. Info shows a bilingual step guide. Only supported purchasing operations are listed; there are no placeholder actions.

### Template workflow

1. Download template: choose a save location; the app reports the actual saved filename and reveals it in Explorer.
2. Fill the input columns and save Excel. Excel may remain open.
3. Upload: RFQ/APQP first check the saved workbook headers without starting the native engine, then run full data validation. The application detects the input sheet and required columns and displays business counts and a sample.
4. Review: RFQ, Info Record, Source List and MM02 show a batch confirmation. In APQP date management, **Save dates** starts the write; **Query Plan Closure Date** does not write to SAP.
5. Run: progress is shown in the app. Navigating does not discard an active task.
6. Result: Total / Successful / Skipped / Failed, Open Result, View Details and Run Another Task.

All five task pages have a top action bar. Navigation keeps page data. Confirmed Clear resets that page's preparation and displayed results (APQP date management keeps the query filters); it never deletes Excel files, templates, history or logs, and never rolls back SAP changes. Clear is unavailable while that task is running or its file picker is in use. Result locations remain in Execution History.

ME12 writes a separate result workbook under managed logs if Windows locks the original. Source List and APQP still use Excel COM to update workbooks already open, without closing them. MM02 reads the saved workbook without modifying it and always writes a separate result. Backups, temporary files, error screenshots and independent result files go to `<Electron userData>/.local-data/logs/automation-runs/<UUID>/`; RFQ snapshots/results go to `logs/rfq-runs/<UUID>/`. No generated sidecars are added beside the selected workbook. User-selected template downloads are unchanged. Do not edit purchasing inputs during a running batch.

For MM02, sign in to Production 949 with SAP GUI Scripting and MM02 classification-change authorization, then leave one idle SAP Easy Access window open. No new login or session is created. Matching codes are skipped; conflicting duplicate rows or changed input after preview block the run. The engine will not write a characteristic it cannot uniquely identify, will not approve an unexpected popup, and will not repeat Save if the outcome is uncertain.

At startup and every 24 hours while idle, finished, app-owned generated run files older than 60 days are removed, including backups and independent result workbooks. Save important generated results elsewhere before expiry. Original user workbooks are never included. Running/unfinished manifests and unresolved RFQ evidence remain protected; corrupt manifests, linked/junction paths and locked files are kept for review/retry. Manual Clear All Logs still preserves business workbooks; it is not the same as the scheduled expiry policy. Old external sidecars are not guessed, moved or deleted; legacy RFQ results remain available to Safe Recovery. Settings, browser sign-in profiles and recovery ledgers are persistent app data, not disposable logs.

ME12 needs numeric Info Record identifiers up to 10 digits and the template headers. Source List requires Material No., Parma and Dual Sourcing Yes/No. The form defaults to today, 31.12.2099 and purchasing organization C100. An existing target Parma is skipped without changes, regardless of its dates, purchasing organization or Fix/MRP values. Otherwise a verified empty row receives the new dates, supplier, organization, Fix and MRP 1. Yes preserves other Fix/MRP; No clears them without deleting any rows or changing their dates. Invalid or uncertain SAP states stop safely. APQP Excel queries require complete material/supplier pairs; existing dates are kept unless Refresh is chosen.

## Pauses and safe stopping

The three guided modules share READY, VALIDATING, READY_TO_START, RUNNING, WAITING_FOR_USER, RECOVERING, COMPLETED, COMPLETED_WITH_WARNINGS, FAILED and CANCELLED states.

Certificate selection and SAP credentials remain manual. The Hub does not read certificate private keys or store passwords. It can open installed SAP Logon when no SAP GUI is available; users sign in themselves. Native operations automatically detect one signed-in environment and idle eligible windows. When multiple environments/users are open, the Hub asks users to leave one intended environment available rather than guessing.

ME12 starts automatically when all browser windows reach the editable selection screen and reuses that screen for the first IR. It checks the requested scope and fields before saving, skips a category only when SAP explicitly reports that it is not maintained, and writes each category's outcome back to Excel. An unconfirmed save is not retried.

A global Action Required dialog persists across routes. Continue performs read-only verification first; a failed check remains paused. Unknown or uncertain write outcomes offer Stop only. Source List verifies the original signed-in session, material and Plant while reading/editing rows; unknown failures show actual stage/error, Excel rows and a technical log path, then stop without Save replay. ME12 waits for all browsers to sign in before any record write; on an unverified record, workers finish their current records, save partial results, and stop scheduling new work before the pause appears.

Stop preserves saved SAP changes; it is not rollback. Closing the app during a task requests safe stopping and waits for the engine to finish. Interaction snapshots are local diagnostics, not automatic crash-resume instructions.

## Settings and diagnostics

Normal Settings: Language, Theme, Text Size, Notification Sounds and Open Result After Completion (Info Record, Excel APQP and Source List). Diagnostics are under **Support & logs**. Technical parameters/reference baselines stay internal; existing stored configuration is preserved when appearance preferences are saved.

Sounds are generated locally, optional, lightweight and non-blocking: success, attention, error. Audio failure does not change the automation state.

Settings and structured logs are in the hidden per-user .local-data folder. Real execution history and dashboard statistics use local completed/running tasks. Raw backend messages, transaction codes and file paths are under View Details / Advanced, not primary error notices. Business identifiers may occur in diagnostics; review logs before sharing.

Normal result-open requests are limited to files issued by the current automation session. Safe Recovery also accepts a persisted run ID for a verified, app-owned result workbook after restart; it never accepts arbitrary renderer file paths.

## Estimated time saved and Safe Recovery

Dashboard shows **estimated** time saved today and across all retained local history. The all-time figure has no separate date cutoff, but does not include records already removed by retention or log cleanup. Manual estimate = confirmed successful quantity × manual baseline; savings = manual estimate minus full batch wall time (including pauses and SAP waits), floored at zero across the period. Worker count does not multiply elapsed time. Failed/cancelled/dry-run/unresolved work, skipped units and legacy diagnostic-only records without measured durations are excluded.

Manual-effort defaults use the owner's business estimates: RFQ **35 minutes/group**, SLT **5 minutes/record**, APQP plan-closure Excel queries **5 minutes/record**, and APQP date updates **1 minute/verified saved field**. Source List **5 minutes/record** remains a reference assumption. These are not editable in normal Settings. Existing custom/calibrated baselines for the older operations remain preserved; the APQP date-field baseline is fixed at 60 seconds. Estimates are not measured human productivity. Deleted/expired history no longer contributes; ordinary local history is capped at 500, with running/unresolved records protected.

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

Open **Operations → Create RFQ**: download the template, fill and save Excel, upload, review validation and Parma groups, then confirm the Production target once. Existing eligible target sessions are reused. No `.env`, Python path, SAP password or technical settings are required. The Hub reports whether RFQ numbers and status were written back to the original workbook; when writeback cannot be verified, use the preserved local copy rather than repeating SAP.

The supplied native SAP GUI RFQ v32 engine performs NPL → Buyer Receipt → RFQ in `ZMFM050072`. Plant + Project + Parma grouping (up to 50 materials), green Buyer Receipt verification, existing-RFQ skips, PPAP handling, recovery, number extraction and workbook saving are retained. Validation never opens SAP. Modified inputs require a new preview. Exact normalized business duplicates are automatically skipped; rows with different input values retain validation errors showing the differences. The original upload remains unchanged.

User-fixable SAP issues pause execution with a shared application modal, attention sound and taskbar flashing. Continue verifies the original SAP session and current checkpoint before resuming; failed verification stays paused. Supported boundaries are the current PROD RFQ staging screen and a manually saved-green Buyer Receipt. Unknown or uncertain RFQ creation outcomes offer Stop only. Stop while paused saves current results and cancels unfinished groups immediately. Before a new SAP action is dispatched, polling waits stop at the next cancellation check, without waiting for the 180-second hard limit or clicking a newly found button. Once a non-NPL action has been dispatched, the current group, RFQ number and Excel writeback remain protected before stopping; no next group starts. An in-flight synchronous COM call must return before cancellation can be observed. No created SAP object is rolled back. The UI acknowledges the request, explains any protected wait, and updates one live entry for repeated waits on the same control; raw diagnostics remain intact.

RFQ runtime hooks check `ZCOMCODE` on freshly matched NPL rows using project field `ZPSPID` before creating a Buyer Receipt. Empty Commodity pauses for manual maintenance; technical read failures have a separate message and never imply missing master data. An exact NPL re-query is required before resuming. Ordinary slow SAP responses show a waiting status; a hard limit pauses instead of replaying Save/Create. All four task pages show Running while active, including across navigation, with paused/checking states taking precedence. Execution history (25/page) and diagnostics (20/page) support pagination and confirmed Clear All, not individual delete buttons. Completed history and identified logs older than 60 days are cleaned at startup and daily while idle; source/result workbooks, backups and unfinished records are protected. See [runtime improvements and acceptance limits](docs/RFQ_RUNTIME_IMPROVEMENTS.md).

See [RFQ integration handoff](docs/RFQ_V32_INTEGRATION.md) and [original workbook writeback](docs/RFQ_ORIGINAL_WORKBOOK_WRITEBACK.md) for technical detail. Production writes are not performed by release tests.

## Developer setup and tests

Development requires Windows, Node/npm, Python with the engine dependencies, installed SAP GUI with Scripting for native acceptance tests, and Chrome/Edge for WebGUI acceptance tests. The portable distribution includes its own Python runtime; company SAP/Excel/browser prerequisites still apply.

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
npm run test:apqp-dates
npm run smoke:apqp-dates
npm run test:me01
```

Desktop smoke uses real local template downloads and previews, but mocks every SAP execution boundary. Regression tests use fake SAP/Excel objects and child engines; they never perform Production writes. Screenshots are under artifacts. See [guided workflow handoff](docs/GUIDED_WORKFLOWS.md) for the completion matrix and acceptance checks.

Architecture remains Electron main/preload/React with trusted renderer IPC, context isolation, sandboxed renderer and purpose-specific bridge methods. Shared guided UI is in src/renderer/src/components/automation; small native pause adapters preserve the stable SAP business engines. No cloud service, telemetry, AI recovery or auto-update is added.
