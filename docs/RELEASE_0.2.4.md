# Portable release 0.2.4 — 2026-10-12

Artifact: `release/SAP-Automation-Toolbox-0.2.4-portable-20261012-162341.zip`

- Windows x64, unsigned, complete-folder ZIP. No installer or Python/pip setup required.
- Size: 162,448,073 bytes (154.9 MiB); 296 archive entries.
- SHA-256: `E556794B1BD134F425200C7E633EFB08BE39E740AB79A600197FA5EC808A05CB`
- Contains the Electron application, shared Python runtime/automation engine, four templates and bilingual portable instructions.
- Four user-facing tasks: Buyer Receipt/RFQ, standard/consignment SLT, APQP, Source List. Legacy ME52N remains isolated in the shared engine but is not exposed in the UI/preload.
- Frozen current business behavior. No new RFQ batching of TriggerModified/Enter or removal of verification waits was introduced for this release.

## Completed local checks

- Typecheck, lint and production frontend/main/preload build passed.
- RFQ integration, runtime, quantities/Cost Breakdown, recovery, material reset and runner regressions passed.
- ME01 input/table/preview, APQP, shared guidance, intelligence, generated-artifact retention and history cleanup regressions passed.
- Productivity/Safe Recovery ledger and RFQ launch handshake tests passed.
- Desktop smoke passed for real template downloads/previews, four top task toolbars, bilingual reset, Running status, dark/large layout, Safe Recovery, safe-stop presentation, pagination/cleanup and adaptive ETA. Execution boundaries were mocked.
- Newly compiled native engine passed dependency self-test, including with Python omitted from PATH.
- Newly compiled native RFQ engine validated a synthetic workbook: two valid materials, one duplicate, correct quantities and Cost Breakdown Yes/No; validation-only mode never connects to SAP.
- Packaged and independently ZIP-extracted EXEs both passed startup, release version, four template downloads, Source List required Yes/No, four task pages, persisted three-worker settings and no-input run guards.
- ZIP CRC verification passed. Extracted engine and four templates matched source artifacts by SHA-256. No `.env`, `.local-data` or browser-profile payload was included.

## Acceptance limits

These checks did not perform SAP business writes, actual browser/session concurrency, live open-Excel writeback, native Source List date entry, client-certificate selection or RFQ creation. Mock tests and local packaged startup are not a substitute for SAP/IT acceptance on a user endpoint.

Users must retain the entire extracted folder and run from a writable local directory. Existing company SAP GUI/Scripting, Excel, Chrome/Edge, network/VPN, sign-in and business permissions remain prerequisites. The unsigned build does not bypass Windows warnings or corporate endpoint policies.

Before general release, run a small controlled test on one intended endpoint. Verify RFQ numbers/results, Source List Yes/No behavior and retained old rows, open-Excel writeback, intended session/worker count, and safe stop/restart review. Never retry an uncertain SAP write without checking existing objects.
