# Source List: existing supplier skips and open Excel writeback

## Business rules

The Hub runs ME01 for the template material and Plant C100. It compares Supplier Parma as a normalized identifier (for example, `000006587` and `6587` match).

- If the target Parma is already present, mark the Excel row `SKIPPED` with `SOURCE_EXISTS`, return to the ME01 selection, and continue with the next material. Do not change any supplier row, date, Fix flag or MRP value. Do not press Save. An existing target is not an error, even when its validity, purchasing organization or flags differ from the requested new-row settings.
- If the target Parma is absent, retain the existing add-row behavior: create the target with Fix selected and MRP `1`. Dual Sourcing `Yes` leaves other rows unchanged; `No` clears only their Fix/MRP flags. Never delete supplier records or change their dates.
- An unreadable or uncertain SAP state still pauses safely. No automatic Save replay, blind row selection, save/discard confirmation, or deletion is introduced.

The engine explicitly selects this skip-existing policy. The lower-level table adapter still supports its previous reconciliation mode for callers that do not select the policy.

## Excel can stay open

The engine attaches to the exact workbook through Excel COM. It checks both the active Excel application and the Running Object Table, so another Excel instance is supported without opening or closing a workbook. A writable exact match is preferred to a read-only one.

Before SAP starts, an input backup is created in the run's managed log directory. Excel COM `SaveCopyAs` captures an already-open workbook, including its current unsaved contents. A closed workbook uses the file-based path. If a user opens it during the run, result saving attempts to attach to Excel before touching the source file.

Only output columns are written. Input identities and column positions are checked before each COM writeback. Transient Excel RPC-busy failures have a bounded retry; SAP actions are not retried by this mechanism.

If the original cannot be saved (read-only/protected/locked workbook, disconnected Excel, or changed input rows/columns), preserve all completed row results in `<original-name>_ME01_results.xlsx` (or `.xlsm`) in the same managed run-log directory. Show the reason and actual result path directly in a popup. Do not close Excel, overwrite changed inputs, or repeat SAP work to repair a local writeback failure. If even the managed output cannot be saved, stop and show the error.

These backups/results use the existing managed artifact retention policy (60 days), not the user's input directory. Export a copy elsewhere if longer retention is required.

## Error presentation

For Source List only, blocking SAP errors, file-validation failures, run failures and result-copy warnings show their actual reason directly in a modal. Source List pause and result panels do not require expanding View Details to see the error. Other operation dialogs retain their existing behavior.

## Verification

Regression fixtures cover skip-and-continue counts, leading zeros, expired/duplicate targets, later SAP table pages, unchanged existing flags and dates, both missing-target Dual Sourcing modes, multi-instance Excel attachment, bounded busy retry, open-workbook writeback, mid-run opening, changed input/header protection, read-only/locked save fallback, and preservation of earlier completed results. Electron UI tests mock all SAP boundaries and check direct error/warning popups and non-blocking existing-source skips.

No live SAP data is modified by these tests. This change updates source code only; an already-distributed EXE does not include it until repackaged.
