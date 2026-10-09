# Purchasing Automation Hub

Local-first Windows desktop purchasing automation. Normal users choose a task, download and fill its template, upload, review, and start. No paths, session indices, Python setup, timeouts or transaction parameters are required in normal workflows.

## Operations

| Task | Business inputs | SAP access |
|---|---|---|
| Create Buyer Receipt / RFQ | Existing RFQ template and accepted Production confirmation | Native SAP GUI; accepted RFQ v32 baseline unchanged |
| Update Info Record | Info Record / Plant template; target Plant, purchasing organization, lead time, standard/consignment type | Chrome or Edge WebGUI; concurrent independent worker windows |
| APQP | Material and supplier template; Plant and optional refresh of existing Excel dates | Native SAP GUI; read-only plan close date queries using available idle sessions |
| Update Source List | Material No. and Parma template | Native SAP GUI; Plant C100; fixes the intended supplier without deleting other rows or clearing other existing Fix selections |

Each card has Open and Info. Info shows a bilingual step guide. Only supported purchasing operations are listed; there are no placeholder actions.

### Template workflow

1. Download template: choose a save location; the app reports the actual saved filename and reveals it in Explorer.
2. Fill the input columns and save Excel. Excel may remain open.
3. Upload: the application detects the input sheet and required columns, validates, and displays business counts and a sample.
4. Review: writing tasks show one batch confirmation immediately before starting. APQP does not require a SAP-write confirmation.
5. Run: progress is shown in the app. Navigating does not discard an active task.
6. Result: Total / Successful / Skipped / Failed, Open Result, View Details and Run Another Task.

ME12 writes a separate timestamped result workbook if Windows locks the original. Source List and APQP use Excel COM for workbooks already open in Excel. Backups and existing results are preserved. Do not edit purchasing inputs during a running batch.

ME12 input needs numeric Info Record identifiers up to 10 digits and Plant headers. Source List input needs Material No. and Parma; duplicate materials with conflicting suppliers are rejected. APQP keeps the template A–E headers; incomplete material/supplier pairs block Start. Existing dates are kept unless Refresh is chosen.

## Pauses and safe stopping

The three guided modules share READY, VALIDATING, READY_TO_START, RUNNING, WAITING_FOR_USER, RECOVERING, COMPLETED, COMPLETED_WITH_WARNINGS, FAILED and CANCELLED states.

Certificate selection and SAP credentials remain manual. The Hub does not read certificate private keys or store passwords. It can open installed SAP Logon when no SAP GUI is available; users sign in themselves. Native operations automatically detect one signed-in environment and idle eligible windows. When multiple environments/users are open, the Hub asks users to leave one intended environment available rather than guessing.

A global Action Required dialog persists across routes. Continue performs read-only verification first; a failed check remains paused. Unknown or uncertain write outcomes offer Stop only. Source List can recheck a manually corrected missing supplier only in the original session, material and Plant. ME12 waits for all browsers to sign in before any record write; on an unverified record, workers finish their current records, save partial results, and stop scheduling new work before the pause appears.

Stop preserves saved SAP changes; it is not rollback. Closing the app during a task requests safe stopping and waits for the engine to finish. Interaction snapshots are local diagnostics, not automatic crash-resume instructions.

## Settings and diagnostics

Normal Settings: Language, Theme, Text Size, Notification Sounds and Open Result After Completion (the three guided modules). Technical settings are collapsed under Advanced / Key User Settings: company WebGUI URL/browser, worker limits, download location and diagnostics.

Sounds are generated locally, optional, lightweight and non-blocking: success, attention, error. Audio failure does not change the automation state.

Settings and structured logs are in the hidden per-user .local-data folder. Real execution history and dashboard statistics use local completed/running tasks. Raw backend messages, transaction codes and file paths are under View Details / Advanced, not primary error notices. Business identifiers may occur in diagnostics; review logs before sharing.

All result-open requests are limited to files issued by the current automation session.

## Local smart ordering and remaining-time estimates

Home shortcuts and Operations now prioritize tasks from this device's last 60 days of execution history. A page takes one ranking snapshot on entry; cards do not rearrange while it is open. New devices and unreadable history retain the original business order.

Each automation learns its own active timings from existing progress events. The remaining-time panel combines bounded historical EWMA with the current batch speed and actual worker count. A new device shows a built-in estimate marked **Learning**. Human-action and verification pauses show a waiting/checking message instead of a countdown and are excluded from learning. Cancelled/crashed runs are not clean samples; safely completed units from failed runs can still be used.

Everything stays in the existing local `execution-history.json`. At most 100 timing summaries per function are retained, without pruning normal history for ETA purposes. There are no analytics services, extra dependencies or personalization settings. Ranking/ETA errors never authorize or stop a SAP operation. See [implementation and test handoff](docs/LOCAL_INTELLIGENCE.md).

## Create RFQ validation and launch

Open **Operations → Create RFQ**: download the template, fill and save Excel, upload, review validation and Parma groups, then confirm Production VCE [949] / Client 100 once. `[949]` is the SAP Logon entry code, not the client. Existing signed-in, ready target sessions are reused; an existing mismatched or not-ready target connection stops the run instead of creating another login. No `.env`, Python path, SAP password or technical settings are required. The source workbook is not modified; a local working copy receives the supplied engine's status columns and RFQ numbers.

The supplied native SAP GUI RFQ v32 engine performs NPL → Buyer Receipt → RFQ in `ZMFM050072`. Plant + Project + Parma grouping (up to 50 materials), green Buyer Receipt verification, existing-RFQ skips, PPAP handling, recovery, number extraction and workbook saving are retained. Validation never opens SAP. Modified inputs require a new preview. Exact normalized business duplicates are automatically skipped; rows with different input values retain validation errors showing the differences. The original upload remains unchanged.

User-fixable SAP issues pause execution with a shared application modal, attention sound and taskbar flashing. Continue verifies the original SAP session and current checkpoint before resuming; failed verification stays paused. Supported boundaries are the current PROD RFQ staging screen and a manually saved-green Buyer Receipt. Unknown or uncertain RFQ creation outcomes offer Stop only. Stop while paused saves current results and cancels unfinished groups immediately; normal running Stop completes the current group before stopping. No created SAP object is rolled back.

RFQ runtime hooks check `ZCOMCODE` on freshly matched NPL rows using project field `ZPSPID` before creating a Buyer Receipt. Empty Commodity pauses for manual maintenance; technical read failures have a separate message and never imply missing master data. An exact NPL re-query is required before resuming. Ordinary slow SAP responses show a waiting status; a hard limit pauses instead of replaying Save/Create. All four task pages show Running while active, including across navigation, with paused/checking states taking precedence. Execution history (25/page) and diagnostics (20/page) support pagination and confirmed Clear All, not individual delete buttons. Completed history and identified logs older than 60 days are cleaned at startup and daily while idle; source/result workbooks, backups and unfinished records are protected. See [runtime improvements and acceptance limits](docs/RFQ_RUNTIME_IMPROVEMENTS.md).

See [RFQ integration handoff](docs/RFQ_V32_INTEGRATION.md) for defaults, file inventory, offline tests, runtime folders and manual release checks. Production has **not** been tested by this implementation. Packaging is paused at the owner's request.

## Developer setup and tests

Development requires Windows, Node/npm, Python with the existing engine dependencies, installed SAP GUI with Scripting for native acceptance tests, and Chrome/Edge for WebGUI acceptance tests. Distribution packaging is separate; no package is generated by this UI task.

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
npm run smoke:rfq-runtime
npm run test:apqp
py -3 scripts/test-me01-source-list.py
```

Desktop smoke uses real local template downloads and previews, but mocks every SAP execution boundary. Regression tests use fake SAP/Excel objects and child engines; they never perform Production writes. Screenshots are under artifacts. See [guided workflow handoff](docs/GUIDED_WORKFLOWS.md) for the completion matrix and acceptance checks.

Architecture remains Electron main/preload/React with trusted renderer IPC, context isolation, sandboxed renderer and purpose-specific bridge methods. Shared guided UI is in src/renderer/src/components/automation; small native pause adapters preserve the stable SAP business engines. No cloud service, telemetry, AI recovery or auto-update is added.
