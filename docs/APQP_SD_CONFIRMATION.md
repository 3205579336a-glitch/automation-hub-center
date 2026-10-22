# APQP actual dates: SD confirmation and optional comments

## Scope

**Temporary owner-requested test policy (2026-10-22):** `STAGE_ONLY=True` and the main-process capability `stageOnly=true`. The current Hub fills at most the first edited APQP, does not press Save or Yes, does not go Back, and does not open the next record. Its result is **STAGED / NOT SAVED**, with zero saved successes. This is real edit-buffer input, not a read-only simulation. The owner inspects SAP and manually saves/discards, returns to the list, then re-queries. The old execution snapshot is invalidated and UI input/clear/workflow switching are locked until a successful new query. Query rejects an already-open APQP detail instead of abandoning it.

The following complete Save flow remains in source for later authorized restoration and offline regression only. It is not active in the current Hub test policy. A native query advertises input-only support; main refuses to start testing with an old engine that cannot confirm that support.

This extends the existing APQP date-management flow; it does not replace query, identity/conflict checks, environment policy, or saved-value verification.

For each APQP, changing `gActualDate` (RTS Action & Closure) or `hActualDate` (Total PPAP) now performs:

1. Verify the same APQP/material/supplier, current dates, and exact SD controls.
2. Select the corresponding SD conf if it is not already selected.
3. Verify write access, enter only edited dates, and verify entered values.
4. Optionally replace the corresponding SD Comment. Blank/omitted input preserves its current SAP value, rather than clearing it. Comments accompany an edited matching actual date; comment-only maintenance is not added.
5. Send Save once. Accept one recognizable Save Yes/No question using a fresh direct `wnd[1]/usr/btnBUTTON_1.Press()`.
6. Require a positive SAP save message, reopen the same APQP, and verify dates **and** the affected SD confirmation/comment values.

Planned-date-only changes do not alter any SD flag/comment. QA confirmation, At supplier, Reject, and other business controls are never changed. No date, material row index, or sample comment from the recording is hardcoded into production input.

## Controls and evidence

The owner's 2026-10-22 recording confirms the RTS IDs under:

`wnd[0]/usr/tabsTAB_ST/tabpTAB1/ssubSUB1:ZMFM050035_N:0901/`

- `chkGS_ITAB-G_SDCONF`
- `ctxtGS_ITAB-G_ACTDAT`
- `txtGS_ITAB-G_SDCOMMENT`

Total PPAP uses the corresponding exact `H_SDCONF` / `H_SDCOMMENT` group alongside the existing `H_ACTDAT` date. The H confirmation/comment names follow the G/H technical naming pattern, not a separate supplied H recording. Both controls must exist and expose readable selected/text values on the verified detail before any input; a missing or incompatible layout fails closed. This is not a claim of live H-control acceptance.

The Yes handler is scoped to the Save just dispatched. It verifies the original SAP identity/transaction and exact Yes/No controls. It recognizes save wording and the owner-approved **“Is the PPAP Level correctly selected?”** question. For the custom `STEP` dialog, a bounded public control-tree fallback reads the body if standard message IDs are absent; `STEP` alone is never sufficient. One Yes is allowed per recognized question kind. Delete/discard/logoff and unknown/repeated questions remain blocked. Ambiguous Save/Yes outcomes are never replayed. Since current test mode never clicks Save, this handler is not triggered by the current test operation (including an existing popup from a previous failed run).

## Faster target location

Update/test location scans only the APQP number column across the current list to detect missing/duplicate IDs, then reads six identity fields for the target row. It does not reuse an old row index. The row is fingerprint-checked before selection and before opening, and the detail APQP/material/supplier identity and current dates are still verified before input. The writer no longer loads the dates redundantly while opening the detail; it reads them once at its checked input boundary. A 48-row offline case reads 54 cells for location (48 numbers + 6 target values), versus the previous 288-cell full identity scan. This is a call-count improvement, not a claim of live SAP/network latency.

## Frontend and safety evidence

The date table retains its original columns. Editing an actual date reveals its optional SD Comment directly beneath that date, without adding wider columns or cluttering untouched rows. Blank preserves the SAP comment. The strict renderer/main/native contract accepts only `g` and `h` single-line strings (up to 255 characters); SAP text readback rejects truncation before Save.

Write checkpoints include `SD_CONFIRM_INPUT_DISPATCHED`, `SD_COMMENT_INPUT_DISPATCHED`, and `SAVE_CONFIRMATION_DISPATCHED`. Checkbox/comment staging marks the write outcome as potentially changed for error/Stop handling, just like date input. Logs stay in the existing managed run-log directory and use its retention policy.

The existing QA/production authorization flags are unchanged. Offline tests use fake SAP and simulated QA acceptance only; no live write acceptance or packaging is implied by this source-code change.

## Project history and table controls (2026-10-22)

The editable NPL project dropdown starts with `775773` on a fresh profile. Submitting Find remembers the project locally; the ten most recent distinct, valid project numbers are retained under `apqp-recent-projects`, with the latest one restored on a new app load. Clearing the current page does not delete recent projects. Invalid stored values, unavailable storage and quota errors do not prevent using the form.

Search matches Material, Supplier Parma or APQP number across the whole result set, not just the current page. Supplier sorting has original SAP order, numeric ascending and numeric descending options, with stable order for equivalent zero-padded supplier numbers. Search/order changes reset the page and never issue another SAP query. Edits and optional comments remain keyed by APQP; filtering does not discard hidden edits or change native execution order. Hidden edited records are explicitly called out. The one-record/no-Save test policy above is unchanged.
