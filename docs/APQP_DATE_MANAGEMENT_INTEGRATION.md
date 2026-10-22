# APQP Date Management — frontend/API integration

2026-10-20. Source changes only; no portable package was produced.

**Current policy override — 2026-10-22:** the owner requested input-only testing. The Hub now fills at most one edited APQP and leaves its detail open, without Save, Yes, Back or the next record. History and results say NOT SAVED and report zero saved successes. The full Save design below is retained for later authorized restoration, not active in this test policy. See [APQP_SD_CONFIRMATION.md](APQP_SD_CONFIRMATION.md) for the current boundary and the new remembered-project/search/supplier-sort controls.

## One operation, two workflows

Operations now has one **APQP Date Management / APQP 日期管理** card. The existing
`#/apqp-plan-closure` route remains valid for bookmarks/navigation/history.

1. **Find APQPs & Edit Dates**: enter NPL and business User ID, choose QA 321 or
   Production 949, read the four dates, edit only needed dates in a paged table,
   then click **Update** once. There is no separate user-facing preview or second
   confirmation step. Current-SAP conflict checks belong inside execution.
2. **Query Plan Closure Date**: the existing Excel template/upload/query workflow.
   Compact and legacy templates, Excel-open behavior, Keep/Refresh Existing,
   fast saved-file preview and existing multi-session querying remain unchanged.

The workflows belong together because they use the same APQP transaction and
domain, but their inputs are different. They must not be conflated into one Excel
parser: NPL + business User ID discovery is not Material + Supplier lookup.

Switching workflows keeps both pages' inputs and previews. The switch is locked
while either page is parsing/running. New date editing is directly in the UI;
the protected date-management Excel export/import from the original proposal is
**not implemented by this frontend/API stage**. The existing plan-closure Excel
function is still available in the same operation.

## Implemented request chain

Renderer → typed preload API → trusted-renderer IPC validation → main-process
`ApqpDateService` → existing `ApqpRunner` → `apqp_plan_closure.py --dates` →
`apqp_date_api.py` → existing SAP session helpers and read-only discovery layer.

| API | Behavior |
| --- | --- |
| `getApqpDateCapabilities()` | Returns the server-owned release gate and EN/ZH reason. |
| `queryApqpDates({project,userId,environment})` | One selection Execute, full paged grid read, unique APQP checks, sequential detail reads. Stores trusted originals in main; returns an opaque snapshot ID and editable date values. |
| `previewApqpDateChanges({snapshotId,edits})` | Retained for diagnostics/compatibility; no longer a user-facing workflow step. |
| `executeApqpDateChanges({snapshotId,edits,confirmed:true})` | Uses trusted main-process originals. Rejects invalid/cleared dates and disabled environment policies before dispatch. Production is owner-authorized; QA remains gated. One native request performs per-record current-date comparison, changed-only input, one Save and same-record reopen verification. |
| `cancelApqp()` | Shared Stop channel/child process for both workflows. |

Production 949 is SAP system VCE/client 100; QA 321 is CEQ/client 100. Business
User ID is the selection filter, not the signed-in SAP username. There is no
renderer-provided client, session index, worker count, executable, local path,
original snapshot, or `writesEnabled` override in the new API contracts.

## Current SAP-write boundary

**Production 949 writes were explicitly authorized by the owner on 2026-10-20.**
This is an owner-requested policy exception, **not successful live QA or
production Save acceptance**. QA remains disabled. `QA_WRITES_VALIDATED` and
`PRODUCTION_WRITES_VALIDATED` are still false; production access is controlled by
the separate native `PRODUCTION_WRITES_AUTHORIZED` flag and the main-process
production capability. A renderer payload cannot change either policy.

The UI prominently states that Update really saves to production, and asks the
user to keep SAP untouched during the run. The native primitive requires the
explicit target environment (PROD means VCE/client 100, QA means CEQ/client 100),
the original signed-in window/account, exact APQP/Material/Supplier identity,
current-date conflict checks and writable controls before the first date input.
It writes changed fields only, saves once and reopens the same business record.
It never bypasses SAP permissions, accepts unknown dialogs, clears populated
dates or retries an uncertain Save. Durable checkpoints remain mandatory.

Result JSON and `CURRENT_VALUES_VERIFIED` checkpoints retain the environment and
`writePolicy`: owner authorization is recorded separately from both incomplete
Save acceptance statuses. A successful run requires confirmed saved values;
offline tests cannot substitute for a live SAP Save/re-read result. This code
change itself performed no real SAP read, date input or Save. Start real testing
with one explicitly chosen record; do not assume a full production batch passed.

The new detail collector uses **one verified existing session** initially. For
Find, it prefers a home/APQP selection/result-list window; if only another T-code
is available, it starts ZMFM050035 once in that same window. Save current SAP work
before starting. Login, save/discard and other modal dialogs are never confirmed
automatically. Equally eligible windows are ambiguous even with MAX_WORKERS=1;
existing APQP detail work is not abandoned. No sessions/connections are created.
Keep the original result list for Update. Stop preserves completed local reads
and leaves the current detail open if stopping before return. Developer inspection
remains non-navigating unless explicitly requested; the old Excel query retains
its own approved startup/navigation behavior.

## Consistency and lifecycle

- Snapshots live in main for one hour. Internal diagnostic previews expire after
  ten minutes and are not update tokens. A successful update refreshes trusted
  originals and UI inputs; uncertain/staged write outcomes invalidate the snapshot.
- Identity columns are not editable. Missing, extra or duplicate APQP identities
  are rejected. ISO date validation rejects invalid calendar days.
- Blank desired values cannot clear populated originals. Changed SAP values are
  conflicts. Already-applied values require no Save. Unedited fields are never
  proposed for update.
- The four labels were checked against the live SAP detail page: **RTS Action &
  Closure Planned/Actual Date**, **Total PPAP Planned/Actual Date**. The selectors
  and internal G/H keys are unchanged. Chinese labels are provided in the UI.
- Local storage remembers only the last successfully queried business User ID;
  no password/certificate is stored.
- Query and preview share the old runner's process exclusion, UTF-8 protocol,
  progress, native interaction bridge and Stop. No second Python runtime was
  introduced. New imports were added to the future engine build script.
- The history reader and History-page filter now include the new operation.
  Discovery, internal preview and update attempts persist with distinct labels, status and result
  paths. Conflicts/validation issues are Partial, failed reads are Failed, and
  Stop is Cancelled. Preview is never recorded as a successful SAP update.
- Query, internal preview and update use separate adaptive timing models (`apqp-date-management`,
  `apqp-date-preview`, `apqp-date-update`), separate from the old plan-closure query. Workers/READ
  events provide actual totals/completions; only clean active timings train the
  model. UI shows remaining duration and approximate finish date/time. Each
  timing model retains at most 100 local samples, subject to normal log cleanup.
  Ranking still has just four cards; no date-update time savings are claimed.
- ETA, finish time, current Material/APQP/Supplier, step and count sit in the
  upper-right progress card. The editable result table remains full-width below
  the form/progress row, not squeezed into a narrow column. Small screens stack
  the progress card above the full-width table.
- Actionable read errors, empty results and preview conflicts/validation issues
  show an acknowledgement dialog with one OK button; detailed evidence remains
  available afterwards. Acknowledgement never accepts a SAP dialog or retries a
  SAP action. The static write-policy note is informational, not a repeated modal.
- Success, warning and error notifications use the existing sound preference.
  Audio is unlocked on the user's Find/Preview click so a long read can notify
  when it finishes. Muting/unsupported audio never blocks the workflow.
- Back to Operations is a lightweight blue arrow/link and keeps current inputs.

## Files and retention

All new generated files stay inside the existing owned run directory:

```text
%APPDATA%\sap-automation-toolbox\.local-data\logs\automation-runs\<UUID>\
  artifacts.json
  apqp-date-request.json
  apqp-dates-readings.jsonl
  apqp-dates-write-events.jsonl  # only when write checkpoints are reached
  apqp-dates-result.json
```

The request file avoids Windows environment/argument length limits. Completed
reads are appended once to JSONL, avoiding quadratic rewriting of a growing
snapshot. Write checkpoints append and fsync before each SAP input/Save, also
avoiding quadratic summary rewrites during a batch. The final/partial summary uses a unique temporary file and bounded
file-only retry for Windows share/scanner locks. This never repeats SAP actions.
The owned manifest participates in existing 60-day cleanup. No files are placed
beside an input workbook. Result JSON is also available from Execution History.

## Validation and smoke commands

```powershell
npm run test:apqp-dates
npm run test:apqp
npm run test:sap-startup
npm run lint
npm run typecheck
npm run smoke:apqp-dates
npm run smoke:apqp
```

New native tests cover identity/filter mismatches, duplicate APQPs, one query,
detail reads/return, missing dates, Stop/partial results, unknown return dialogs,
QA/PROD separation, changed-only preview, conflicts, blanks and already-applied
dates. Main tests cover strict IPC input shapes, immutable originals, opaque
preview IDs/expiry, the write gate and real child-process protocol using fake SAP.

The new desktop smoke loads the **real** renderer/preload/IPC/service/runner and
native date API. SAP objects are fake; history persistence and the timing service
are real and isolated from the user's data.
It checks two workflows/one card, single dispatch on double-click, Running status,
locked tabs, 25-record pagination, retained edits, differences, blank blocking,
server-side execute rejection, Stop, acknowledgement dialogs, real WebAudio
oscillator calls, persisted history/ETA, accepted Plant 0000, back navigation,
English/Chinese, small-screen large text and dark mode. Separate old-APQP smoke checks real template download/preview without
starting a SAP query. No smoke/automated test performs real SAP reads or writes.

### Completed checks on 2026-10-20

- Date-domain/discovery/API/write/service tests: 40 + 31 + 18 + 7 passed.
- Existing APQP regression: 13 Node + 76 Python tests passed.
- SAP startup compatibility: 23 Python + 6 Node tests passed.
- Local ranking/ETA regression: 39 tests passed, including real date-query/preview
  IPC → history-file reopen and separate learned timing models.
- History deletion/retention regression: 19 tests passed.
- New APQP Date Management desktop smoke, old APQP Excel smoke, and four-module
  task-controls smoke passed. The latter includes page reset, route persistence,
  running-state locks, stop-retry, stale events and responsive themes.
- Electron build, TypeScript and ESLint passed.

These are code/UI/protocol checks with fake SAP, **not live QA write acceptance**.

Query mismatch errors now name the failing field and its expected/actual values,
show APQP/material/SAP-result row and all three comparisons (including matches),
and preserve native details and the diagnostic file path through IPC and history.
The UI lists up to 20 mismatching records and always shows total/mismatch counts.
The user confirmed **Plant 0000 is a valid shared/cross-plant APQP record**.
The query filter remains C100, but results may contain **C100 or 0000**. Both
native and main-process validation accept this rule; the original Plant is
preserved in snapshots and checked again during preview, never rewritten to
C100. Unrelated plants (for example C999), wrong NPL/User and changed business
identity still block the read/preview. The mismatch test now uses C999.

### Read performance and live label evidence

#### Single-session latency changes (2026-10-20)

- Bind the original COM session once. Guards still read its live ID,
  System/Client/User, Busy, transaction and dialogs; a disconnected/changed object
  fails closed and is never rebound to a replacement window by index.
- Business queries bracket each loaded identity-grid viewport with state/layout
  checks, rather than two full session checks per row. Stop remains per cell;
  off-screen paging and both pre-open row fingerprints are retained.
- Reuse the reader only after a positively confirmed return to the result list.
  An uncertain open/return is not replayed. Complete date metadata is read once;
  a lightweight second date-value comparison still prevents leaving edited work.
- Where available, SAP GetObjectTree reads the four known detail fields in one
  call (same API/property protocol as Source List). Only a genuinely absent API
  selects the compatibility reader. Invalid JSON, foreign/duplicate IDs or
  missing/unreadable dates fail closed. Bulk exports are not persisted; only the
  four date values/metadata are retained. This path is enabled for read collection,
  not for the write primitive or default developer inspection.
- Ready-state polling accepts a page after one full guard, with no fixed sleep
  when already ready. Busy waits poll Busy + Stop without potentially blocking
  Info/control reads; the complete guard is mandatory once ready. Pending
  navigation may retain its original T-code briefly;
  the accepted query screen must be ZMFM050035. Modal prompts are never clicked.

A 48-record **offline fake-SAP call-count** comparison reduced session checks
from **809 to 329** (about 59%), and complete detail reads from **96 to 48**.
These counts use 10 visible grid rows; a different viewport can change the count.
Both date-value snapshots remain (384 values for 48 records), using two atomic
bulk calls per detail when supported, or cached page-local controls otherwise.
The result JSON now includes `performance` counters, `selectionAndListMs` and
`totalMs`; record progress includes `detailReadMs` / `recordElapsedMs`.
This is **not a measured 2-minute live-SAP result**. The 48-material / 120-second
target still requires timing the same authorized query on the deployed SAP GUI.
No real SAP reads, writes or navigation were performed by these regressions.

The updated desktop smoke also starts its fake SAP window at ME11 and exercises
same-window navigation plus batch-date reading through the real native protocol.
It verifies 25 opens/returns, 50 bulk reads, one reference binding, the session
check budget, result-file persistence, history, ETA, cancellation and environment
policies. The production-policy smoke uses fake VCE/100, including a Plant 0000
record, and proves one Save plus same-record re-read without claiming live QA
acceptance. Build, TypeScript, ESLint and the legacy APQP Excel smoke passed. Source
only: fully restart the development Hub; existing portable EXEs are unchanged.

Business reads project the six verified identity columns instead of reading all
104 columns for every row and both pre-open identity checks. The developer
inspection still defaults to all columns. Layout, row count, paging, identity,
popups, dates, Stop and no-replay checks remain in place. Date controls are read
as a batch bracketed by session guards, with Stop checked for each field.

A same-session, same-10-row read-only comparison on 2026-10-20 measured full
104-column inspection at **7,811 ms** and projected six-column inspection at
**3,823 ms**. This is a single **list-read** observation, not an end-to-end query
SLA; all four dates still require individual SAP detail reads. No Save or date
assignment was performed. The explicitly opened detail was checked unchanged
and returned to its original list after inspection.

Observed detail label evidence (common subscreen `ZMFM050035_N:0901`):

| Dates | Observed SAP labels | Control suffixes |
| --- | --- | --- |
| G planned/actual | RTS Closure; RTS Action & / Closure; Plan Date / Actual Date | `lbl%#AUTOTEXT142`–`144`, `151`–`152`; `ctxtGS_ITAB-G_PLNDAT` / `G_ACTDAT` |
| H planned/actual | PPAP; Total PPAP / sub-requirements; Plan Date / Actual Date | `lbl%#AUTOTEXT159`–`161`, `169`–`170`; `ctxtGS_ITAB-H_PLNDAT` / `H_ACTDAT` |

The detail probe used APQP 2000360190, Material 11037019, Supplier 45471 in
VCE/client 100. The date-read evidence is under owned run
`59cef81b-2466-4454-aee3-941f670a0af1`; surrounding label IDs/text were read
directly afterwards. This confirms display names only, not write acceptance.

### Owner-authorized live QA attempt (2026-10-20)

The owner authorized APQP **2000331113**, QA 321 / CEQ client 100, all four dates
to **2026-10-20**. The signed-in QA user was A533700. Read-only identity checks
confirmed the exact APQP before testing. Observed original values:

| Field | Before | SAP Changeable |
| --- | --- | --- |
| RTS Action & Closure Planned | 2026-08-28 | false |
| RTS Action & Closure Actual | blank | false |
| Total PPAP Planned | 2026-08-04 | false |
| Total PPAP Actual | blank | false |

The primitive stopped at `APQP_DATE_READ_ONLY`, **before the first date setter
and before Save**. The owner confirmed the same record cannot be edited manually.
This was not successful write acceptance. Both release gates remained closed at
that point. The later explicit owner request enabled the production policy only;
it did not turn either acceptance status into a pass. QA remains gated. Obtain an
editable authorized QA record or resolve SAP permissions/record state to complete
the original acceptance procedure separately.

Evidence: owned run `d77aa11e-cc59-49c7-8bfb-ecded8c51561`, file
`apqp-date-qa-acceptance.json`. The developer-only
`scripts/validate-apqp-date-qa.py` requires explicit APQP/project/User/date and
`--confirm-qa-write`; it has no production option. No actual SAP data was changed
in this attempt. The QA detail was left open for manual inspection.
