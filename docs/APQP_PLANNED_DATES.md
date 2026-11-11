# APQP planned-date maintenance — 2026-10-27

The owner's new SAP recording supersedes the prior G/H planned/actual date interpretation. The runtime now reads and writes only these controls under `wnd[0]/usr/tabsTAB_ST/tabpTAB1/ssubSUB1:ZMFM050035_N:0901/`:

| Contract key | SAP control | Hub label |
| --- | --- | --- |
| fPlanDate | ctxtGS_ITAB-F_PLNDAT | RTS Confirmation Planned Date |
| gPlanDate | ctxtGS_ITAB-G_PLNDAT | RTS Action & Closure Planned Date |
| hPlanDate | ctxtGS_ITAB-H_PLNDAT | Total PPAP Planned Date |
| mPlanDate | ctxtGS_ITAB-M_PLNDAT | APQP Closure Plan Date |

M's business label was confirmed by the owner as APQP Closure Plan Date. No sample date, row number, NPL, SAP business user or APQP number from the recording is hardcoded for execution. Dates are directly assigned as `DD.MM.YYYY`, without opening a calendar. Actual dates, SD confirmation, QA confirmation, comments, At Supplier and Reject are never edited.

## Official execution

The owner authorized replacing single-record input-only testing with formal batch Save. `STAGE_ONLY=False`; 0.3.0 uses Production 949 only, with QA writes disabled. This configuration is **not** a claim that live SAP acceptance has passed. Tests use fake SAP only.

Find reads F/G/H/M dates and observes `Changeable` per field. The Hub disables and labels every field that is grey, read-only or lacks positive permission evidence. Execution still rechecks actual SAP editability for **all** changed fields before the first setter. It does not tick unrelated checkboxes to force editability. A freshly locked field skips the entire untouched record with APQP/material/supplier, field name and error reason.

Click Update once to process changed records in original SAP order. Each record uses a three-way original/current/desired comparison; untouched fields preserve newer SAP values and already-applied changes require no Save. Clearing populated dates is not authorized. Each successful update sends Save once, handles only recognized Save/PPAP-Level Yes questions, requires a positive SAP acknowledgement, reopens the same APQP and compares all four planned dates. Only reopened verified values count as saved. The next record starts only after verification. History and result JSON distinguish saved, unchanged, safely skipped and uncertain outcomes.

Safe pre-input validation/conflict/read-only/status-bar warnings/errors may be skipped after an unchanged-detail check and one verified Back. Unknown popup, identity/session change, partial input, uncertain Back or uncertain Save stops the batch. Save and Yes are never blindly replayed. Stop before Save leaves input for manual handling. Stop after Save finishes verification of that current record, then starts no next record.

## Navigation and identity

The editor pre-fills a supported Windows login as the editable APQP business owner filter. The user can change it before querying. This default does not sign in to SAP, imply SAP authorization, or start a query. A second task cannot query or save while the current automation owns the run gate.

Execution binds the original session/system/client/account. At batch start it enters ZMFM050035 once, fills the original Plant C100 / NPL / business User ID filters and obtains a fresh list, even if the operator left another T-code, a clean detail or an APQP list with unrelated filters open. This does not repeat the full per-detail date read. It locates by APQP ID, scans for duplicates and verifies material, Supplier Parma, Plant, NPL and business user plus the selected-row fingerprint before opening. It never trusts a cached row index or silently selects a different login. Subsequent records reuse the list with live target checks.

Sign-in and save/discard dialogs are not auto-confirmed. The owner must handle them; no new session, forced logoff or automatic discard is used. SAP business authorization remains authoritative, and a grey RTS Confirmation date stays grey in Hub.

## Cache compatibility

`APQP_PLANNED_FGHM_V1` is required in native results and local cached reads. Prior G/H actual-date snapshots and engines are rejected rather than mapped onto a different business field. Read from SAP once after this update. Valid cached planned dates stay explicitly historical; writes always recheck the original session, target identity, current dates and field permissions. Completed verified saves are not shown as unresolved input-only attempts. Clear keeps NPL/User ID/environment so the matching prior read remains easy to load; it does not change SAP or delete evidence.

## Verification

Offline domain/discovery, API, writer, main-process/cache contracts and desktop smoke cover exact four selectors; no actual/SD access; field permission rendering; multi-record Save/reopen; dynamic read-only skip; cross-transaction navigation; wrong identity/duplicate ID; Stop; unknown/repeated/delete questions; ambiguous setter/Save; stale schema rejection; cache/reset; bilingual small-screen layout and execution history. See the 0.3.0 release notes for portable-package checks. No live SAP write is performed by these tests.
