# APQP actual dates: SD confirmation and optional comments

> Historical flow, superseded on 2026-10-27. Current maintenance uses only the recorded F/G/H/M **planned** dates, enables verified batch Save and never touches actual dates, SD conf or SD Comment. See [current planned-date workflow](APQP_PLANNED_DATES.md). The input-only policies below describe the earlier implementation, not the current application.

## Scope

**Temporary owner-requested test policy (2026-10-22, reaffirmed 2026-10-26):** `STAGE_ONLY=True` and the main-process capability `stageOnly=true`. The current Hub fills at most one APQP successfully. Safe, unchanged pre-input failures may be skipped to try the next edited record; after the first successful input it stops in that detail, never presses Save or Yes, never goes Back, and never opens another record. Its result is **STAGED / NOT SAVED**, with zero saved successes. This is real edit-buffer input, not a read-only simulation. The owner inspects SAP and manually saves/discards and returns to the list. The execution snapshot is invalidated after input. UI date input/workflow switching remain locked while pending; **Clear is now allowed**, with an explicit warning that it resets the Hub only, not SAP. Query rejects an already-open APQP detail instead of abandoning it.

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

## Reuse prior reads / clear pending input (2026-10-26)

`Load previous result (fast)` reuses a completed read's existing manifest-owned request/result JSON in the managed run-log directory. It creates no duplicate cache files, calls no SAP/native engine, generates no execution success or ETA sample, and survives an app restart. The history/manifest must be finished, not older than 60 days, and match NPL, business User ID and environment. Partial/cancelled reads, foreign/linked paths, corrupt files, wrong record identities and missing native input-only support are not executable shortcuts. Normal history deletion and managed 60-day artifact cleanup remove cached availability.

Restored results are visibly labelled **historical cache / not refreshed**, retaining the original read timestamp. Where available, the last input attempt is labelled **save unconfirmed**, not saved. A new main-owned token is issued; the old invalidated one is never revived. The existing live original-session check, full APQP-number duplicate check, selected-row fingerprint, detail identity, current-date conflict checks, permission checks and no-Save native policy all still apply to test input.

After manual SAP handling, `SAP handled — reuse previous result` resets the previously attempted row to historical read values and preserves other drafts from the same source read. It does not infer whether the user saved/discarded in SAP. `Read all from SAP again` remains available for fresh values, additions and deletions. Clearing only clears the Hub's current form/table; history, evidence and SAP are untouched, and the outstanding-input warning remains. Uncertain input errors lock execution but preserve untouched local drafts until the user handles SAP and reloads.

Leaving an unsaved detail merely to start the next APQP is **not enabled** while the owner requests one-record/no-Save testing. No production write policy or Save/Yes behavior was changed by this cache/reset work. The initial full read still opens each detail; this optimization avoids repeated full reads, not the first read's SAP server latency.

## Skip safe problems before input (2026-10-26)

Edited records are attempted in original SAP order until one is successfully filled. Invalid date clearing / mismatched optional comments can be rejected without opening the record. A current-date conflict, a read-only date or SD control, or a verified detail's SAP status-bar warning/error can be skipped only if **no date, checkbox or comment setter was dispatched**. Before returning, the engine rechecks the exact detail identity, all four dates and the relevant SD values against its fresh pre-input baseline. It sends Back once through the existing owned-unchanged-detail path and must verify the result list before trying the next record. It never selects Save/discard in a dialog.

The allowlist is `APQP_DATE_CONFLICT`, `APQP_DATE_VALIDATION_FAILED`, `APQP_DATE_READ_ONLY`, `APQP_SD_READ_ONLY`, `APQP_RECORD_WARNING`, `APQP_RECORD_ERROR`. Unknown dialogs, unreadable controls, identity/session changes, uncertain Back, Stop, or **any** possible partial input stop the operation. A warning after input is not a skip: it leaves the detail for manual review. The first successfully filled record still ends the test, with zero Save/Yes calls.

Each skipped record retains APQP, Material, Supplier Parma, bilingual reason/error code and whether it was never opened or returned unchanged. Durable `SKIP_RETURN_DISPATCHED` / `RECORD_SKIPPED_BEFORE_INPUT` checkpoints use existing run logs. The UI gives one end-of-test warning confirmation and a reason table; execution history includes failed/skipped issue counts, and staged tests remain Partial / not saved / excluded from time-saved metrics. All-skipped tests leave no pending input and do not lock another attempt. Offline tests exercise partial checkbox input, warning-after-input, concurrent changes, unknown popups and unsafe return in addition to successful skip-then-stage behavior. These checks do not constitute live SAP acceptance.
