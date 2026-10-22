# APQP Date Management — read-only POC

This is the phase-1 evidence report. Frontend and guarded API integration now
follow in [the integration report](APQP_DATE_MANAGEMENT_INTEGRATION.md).
Existing Plan Closure Date Query is preserved. Actual date writes and production
Save testing are still disabled; no distributable package has been produced.

## A. What the recording proves

| Purpose | Recorded SAP evidence |
| --- | --- |
| Transaction | `ZMFM050035` |
| Plant | `wnd[0]/usr/ctxtS_WERKS-LOW` |
| NPL / Project filter | `wnd[0]/usr/txtS_PCODE-LOW` |
| Business User ID filter | `wnd[0]/usr/txtS_SDMEMB-LOW` |
| Query Execute | `wnd[0]/tbar[1]/btn[8]` |
| Result ALV | `wnd[0]/usr/cntlCON1/shellcont/shell` |
| Open selected result | Set ALV `SelectedRows`, then `wnd[0]/tbar[1]/btn[8]` |
| Four date controls | See the exact suffixes below |
| Save button | `wnd[0]/tbar[0]/btn[11]` — recorded, **not called by this POC** |

The four controls have this common prefix:

```text
wnd[0]/usr/tabsTAB_ST/tabpTAB1/ssubSUB1:ZMFM050035_N:0901/ctxt
```

| Internal key | Exact suffix | Verified display label (later read-only inspection) |
| --- | --- | --- |
| `gPlanDate` | `GS_ITAB-G_PLNDAT` | RTS Action & Closure Planned Date |
| `gActualDate` | `GS_ITAB-G_ACTDAT` | RTS Action & Closure Actual Date |
| `hPlanDate` | `GS_ITAB-H_PLNDAT` | Total PPAP Planned Date |
| `hActualDate` | `GS_ITAB-H_ACTDAT` | Total PPAP Actual Date |

The original recording did not confirm the business names. A subsequent live
read-only detail inspection confirmed the surrounding RTS Closure and Total PPAP
labels; see the integration report for the exact label control IDs. Native
mapping is in `resources/rpa/apqp_dates.py`, UI translations in
`src/shared/apqp-date-types.ts`. This does not change the write gate.

The recording also shows F4/calendar navigation, but contains no date `.Text`
assignment and no verified post-save value. It does not prove direct assignment
works, that a successful Save occurred, or what G/H mean in business terms.

## B. Evidence and remaining unknowns

### Real SAP inspection on 2026-10-20

The user prepared the result list for Plant C100, NPL 775773, User ID EE00221.
The current-grid probe did **not** execute another query. It observed:

- PROD entry **949**, actual system **VCE**, actual SAP client **100**.
  Entry 949 is not SAP client 949. QA is entry 321, CEQ/client 100.
- ALV RowCount **48**, ColumnCount **104**.
- VisibleRowCount **30**, initial FirstVisibleRow **0**.
- The technical columns below and their titles were read from SAP, not guessed.

| Technical ID | Actual observed title | Role to investigate |
| --- | --- | --- |
| `APQPNO` | APQP NO. | Candidate primary business identifier |
| `MATNR` | Material | Identity/context, not assumed unique |
| `LIFNR` | Vendor | Supplier / Parma |
| `WERKS` | Plant | Plant context |
| `PSPID_1` | GPN | Project context; samples match entered NPL |
| `SD` | SD | Samples match entered business User ID |
| `BUYER` | Buyer | Distinct business role; not interchangeable with SD |
| `QA` | QA | Distinct business role |
| `BLATT` | Part ver. | Part version context |
| `APQPSTATNM` | APQP Status | Status context |
| `RFQNO` | RFQ NO. | Related RFQ, not assumed APQP identity |
| `PAPQPNO` | Parent APQP NO. | Relationship, not a replacement primary key |
| `ZRAPQPNO` | Rep. APQP NO | Relationship |
| `CAPQPNO` | Copy RFQ ref | Relationship |

None of the four recorded G/H date technical names occurs in ColumnOrder.
Other date columns such as `PPAPTDAT` and `RTSDUEDAT` must **not** be substituted
for them based on a similar-looking title.

The first nonpaged scan returned empty strings for rows 31–47. That scan is
**superseded as evidence of completeness**: a returned string is not proof an
off-screen ALV record was loaded. The helper now checks the actual viewport,
marks unvisited rows incomplete, and optionally pages before reading.

The corrected paged scan loaded **48 nonempty APQP numbers, 48 distinct values,
zero duplicates in this result**. All 48 rows had Plant C100, project 775773,
and SD EE00221. It read viewports starting at 0 and 18, then confirmed restoration
to 0. `APQPNO` is therefore a credible key candidate for this result, not yet
proof of global uniqueness or of identity on the detail page. `MATNR` also
happens to be unique in this sample; that is not a reason to use Material as the
APQP key.

One explicit first-row detail probe then successfully read all four recorded
controls: two valid planned dates and two empty actual dates. All four controls
reported `Changeable=true`, which is only an observation, **not proof of safe
direct assignment**. The row fingerprint was checked before and after selection;
detail was opened once and left open. No date setter, Save, Back or popup
confirmation was used. Identity displayed on detail still needs independent
verification before future writes.

SAP documents `GuiGridView.FirstVisibleRow` as read-write in the
[SAP GUI Scripting API](https://help.sap.com/docs/help/b47d018c3b9b45e897faf66a6c0885a8/4af24c3281fb4d6a809e53238562d3b2.html).
Paging here changes only the displayed row range, not selected rows, cell values,
filters, or SAP business data. The original viewport is restored only when the
same session/grid is still verified and Stop has not been requested.

Full raw column lists, row samples and fingerprints stay in local diagnostic
evidence, not this repository. Do not commit production exports or raw logs.

### Five POC questions

| Question | Current conclusion / release gate |
| --- | --- |
| One NPL + User Execute returns all APQPs? | One user-prepared list contains 48 reported rows. This does not prove there are no hidden filters/variants, nor that all matching business objects were returned. The helper can dispatch one query; controlled query acceptance is still required. |
| Which column is the unique APQP key? | `APQPNO` is a real observed column: 48/48 nonempty and distinct in the fully loaded result. Global uniqueness and matching identity on detail remain acceptance gates. Row number is never a business key. |
| Can all four dates be read? | **Verified for one live detail**: all four controls readable, two dates populated and two empty. Broader statuses/permissions still require sampling. READ / EMPTY / INVALID_DATE / UNREADABLE remain distinct; missing controls never become valid blanks. |
| Does direct `.Text` assignment work? | **NOT TESTED.** Only query-filter `.Text` is assigned by this POC. No date assignment API is exposed. |
| Can Save then reopen/re-read verify the same record? | **NOT TESTED.** No Save, automatic Back, or dialog acceptance is implemented. Controlled QA acceptance is required. |

The business User ID is the recorded query filter, not a requirement that the
signed-in SAP account equal EE00221. Each worker must instead stay bound to its
original actual System/Client/SAP-user/session identity.

## C. Proposed Hub architecture

Implemented now:

- `apqp_dates.py`: centralized recorded field mapping, conservative date
  normalization, fingerprinting, pure three-way comparison foundation.
- `apqp_date_discovery.py`: current-grid inspection, single query dispatch,
  explicit one-record detail read, identity/dialog/Stop guards.
- `scripts/inspect-apqp-dates.py`: developer-only adapter to exercise that layer;
  not a second end-user product or normal operation tile.
- Existing APQP `SessionRef`, session inventory, identity reading, connection
  selection, and transaction constants are reused from `apqp_plan_closure.py`.
- Evidence uses the Hub's local log root and owned artifact manifest format.

Remaining architecture at the end of phase 1 (see the integration report for
subsequent UI/API work; workbook export/import and actual writes remain pending):

1. APQP landing page with “Find APQPs & Edit Dates” and the preserved
   “Query Plan Closure Date” workflow.
2. IPC/service integration, normal run history/progress/recovery, eligible
   existing read workers and collector. Different sessions must open records by
   verified business identity, never by sharing another ALV's row indices.
3. Protected Excel identity columns + four editable date columns, hidden
   `_HubMeta` snapshot with environment, identity, export ID/time and originals.
   No passwords or credentials. Workbook protection is accidental-edit
   prevention, not a security boundary; validate metadata against trusted local
   export evidence and current SAP before writes.
4. Workbook validation and three-way preview, one clear production confirmation,
   then **one SAP write worker**. Do not parallelize writes in V1.
5. Save confirmation + same-record post-save re-read + result persistence.

The future lifecycle must record `APQP_UPDATE_STARTED`, `APQP_OPENED`,
`CURRENT_VALUES_READ`, `CURRENT_VALUES_VERIFIED`, `CHANGES_APPLIED`,
`SAVE_DISPATCHED`, `SAVE_CONFIRMED`, `VALUES_RE_READ`, `UPDATE_VERIFIED`,
`RESULT_SAVED`. A dispatched Save is not Success. Unknown popups or uncertain
write outcomes must not be blindly replayed.

Before write dispatch Stop cancels. After dispatch, finish bounded verification
and durable result persistence if possible, mark uncertainty otherwise, then
stop before the next APQP. Stop is not rollback.

The pure comparison currently covers original A / current SAP B / desired C:

- C=A: no user edit; preserve B even if SAP changed after export.
- C=B: already applied; do not save again on retry.
- C differs and B=A: propose only changed fields.
- C differs and B differs from A: conflict; no writes for that record.
- Blank C with populated A: validation error; never implicitly clear SAP.
- Missing/unreadable/invalid values: not blanks; reject the record.

All comparison results still have `writesEnabled=false`.

## D. Smallest safe POC / acceptance sequence

### Developer commands

Default: inspect the existing list, with **no navigation, row selection or scroll**.

```powershell
py -3 scripts/inspect-apqp-dates.py --mode inspect-grid --environment PROD --max-rows 3
```

Read every loaded result row with explicit view-only paging:

```powershell
py -3 scripts/inspect-apqp-dates.py --mode inspect-grid --environment PROD --max-rows 10000 --scroll-grid
```

From a known idle SAP home/clean APQP selection page only, set the three recorded
query criteria and dispatch exactly one Execute:

```powershell
py -3 scripts/inspect-apqp-dates.py --mode discover --environment PROD --project 775773 --owner EE00221 --scroll-grid
```

It refuses unrelated transactions or existing APQP detail work. It does not open
connections or sessions. Material/Vendor LOW criteria must be empty. It records
the legacy `P_C3` choice without forcing it; other filters/variants still require
manual validation before claiming full query coverage. There is no retry or
command-box fallback after an uncertain navigation/Execute dispatch.

Read one explicitly inspected result row, using the recorded selected-row flow:

```powershell
py -3 scripts/inspect-apqp-dates.py --mode inspect-grid --environment PROD --max-rows 3 --read-row 0
```

This verifies the exact observed row fingerprint before and after selection,
opens it once and leaves detail open. It does **not** edit dates, Save, Back,
accept a popup or discard data. Use `--scroll-grid` if the requested observed
row is outside the current viewport. Do not manually manipulate SAP during a
probe. If more than one matching list/detail is open, the tool stops rather than
guessing; the developer can specify a verified `--session-id`.

For an already-open matching detail page, without opening/selecting anything:

```powershell
py -3 scripts/inspect-apqp-dates.py --mode inspect-detail --environment PROD
```

Evidence is written only to:

```text
%APPDATA%\sap-automation-toolbox\.local-data\logs\automation-runs\<UUID>\
  artifacts.json
  apqp-date-evidence.json
```

The finished ownership manifest participates in the existing 60-day cleanup
when the Hub next runs its normal retention task. The helper itself does not
delete files. No files are created beside the user's input workbook. Output is
UTF-8 JSON; raw COM objects and credentials are not serialized.

### Controlled manual QA write acceptance — not automated by this POC

1. A key user supplies an authorized **QA** APQP and confirms its stable business
   identity in both list and detail. Record the four original dates and official
   field labels. Do not use a production APQP as a trial record.
2. In a reviewed QA-only scripting step, assign **one approved** changed date
   using the recorded control's `.Text`, in the SAP account's accepted format.
   No calendar or Save fallback. Read back the text, trigger normal validation,
   and inspect SAP messages. Repeat separately for each of the four fields.
3. Manually review and Save that authorized change. Record the exact success
   status/dialog and any validation/authorization errors. Never accept unknown
   Yes/No prompts just because a Save was attempted.
4. Reopen by verified APQP identity, not a remembered row number. Read all four
   fields and compare with expected values, including the unchanged fields.
5. Verify one already-applied retry requires no Save; external concurrent change
   is a conflict; blank cells cannot clear dates. Restore QA test data only under
   the key user's approved process.
6. Only after these gates pass, implement protected workbook export/import,
   preview/UI and the single-worker write engine with fake-SAP regression tests.

### Automated validation

```powershell
npm run test:apqp-dates
npm run test:apqp
npm run test:sap-startup
npm run lint
npm run typecheck
```

The new tests use fake SAP only: recorded controls; date normalization;
change-only/conflict/blank/already-applied comparison; viewport loading and
restoration; cancellation; bounded waiting; single dispatch; session identity;
separate QA/PROD configuration; unknown popups; local JSON persistence; ambiguous
sessions and grid changes. No automated test performs a real SAP write. Excel
metadata/parser and post-save tests belong to the later disabled implementation
phase, not a claim of completion of the end-to-end feature.
