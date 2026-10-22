# RFQ original workbook writeback

The desktop runner still executes a validated local working copy and retains
that copy for results and Safe Recovery. It now passes the explicitly selected
source path and immutable input snapshot separately to the native engine.

After each durable result save, the adapter mirrors pending RPA result fields
to the original sheet, including RFQ Number, Buyer Receipt/RFQ status, errors
and Last Run Time. A final attempt also occurs on normal completion or safe
cancellation. Preview never writes to the original or opens Excel.

## Workbook safety

- Uses Microsoft Excel COM, already included in the application's Windows
  runtime dependencies, to preserve workbook features. Excel must be installed;
  if unavailable, SAP results remain available in the durable working copy.
- Attaches the exact open workbook, including another Excel process via the
  Running Object Table. Otherwise opens the source in a private background
  Excel instance with macros/events and external-link updates disabled.
- Never closes a user-owned workbook or changes user application settings.
  Background workbooks opened by the Hub are closed at completion only when
  still hidden and saved. Visible or unsaved workbooks remain open. Saving an
  already-open workbook also saves its current unsaved Excel changes normally.
- Before any result mutation, checks all pending source rows against the
  immutable input values/formulas, including Plant, Project, Material, Parma,
  quantities and other input columns. Changed/moved rows, changed headers,
  protection, a different workbook/date system, read-only state, and conflicting
  existing results block writeback rather than guessing another target.
- Only RPA result cells and missing RPA result headers are written. RFQ numbers
  are text, including leading zeros; result strings cannot become formulas.
  Same-group material rows receive the same captured RFQ number.
- Read-back and Excel's saved state must confirm success. A failed or ambiguous
  Excel write remains pending; only idempotent result writes can be retried.
  Save/Create SAP actions are never replayed. The source file is never replaced
  by the entire working copy.
- Hub-generated inputs, result copies and diagnostics remain inside the
  existing log/run retention policy. Office may create its normal temporary
  owner/lock file beside a workbook while it is open.

## User-visible behavior

The RFQ page shows either "RFQ results saved to original Excel" and an Open
Original Excel button, or a warning to review the safe result copy. A source
writeback warning does not falsify SAP success counts; history is Partial and
the warning/paths are persisted in diagnostic metadata. Never rerun an already
created RFQ merely to retry Excel writeback.

## Verification and distribution

- `npm run test:rfq-writeback`: mocked COM, full Hub save boundaries, cancellation,
  result preservation, row/conflict guards, and runner protocol/security tests.
- `py -3 scripts/test-rfq-writeback-excel.py --run-excel-check`: opt-in real Excel
  check using disposable synthetic workbooks, including already-open/closed
  source files, dates, input styles, leading-zero RFQ IDs and literal text.
  The invisible already-open test instance binds its exact real COM handle;
  application/ROT discovery and cross-instance identity are tested offline.
  No SAP transactions are accessed by this check.
- Existing RFQ integration, consecutive save confirmations, runtime Stop and
  recovery regressions remain applicable.

No new package is produced by this source change. A future portable build
includes the helper and checks `verified-result-columns-v1` in the bundled
engine self-test; an old EXE/ZIP does not automatically receive these changes.
