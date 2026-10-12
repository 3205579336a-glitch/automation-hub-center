# Guided purchasing workflows — code-only handoff

## Scope

RFQ v32 is the accepted frozen baseline. Its SAP business engine, template, grouping, quantities, cost-breakdown rule and recovery checkpoints are unchanged by this UI simplification. RFQ only shares notification preferences, the global interaction UI, and the cross-module execution lock.

ME52N / PR modification is removed from the normal application: cards, routes, preload methods, sidebar/title keys, counters and normal history are removed/filtered. Existing historical data is NOT deleted. Isolated legacy backend files/types remain for developer recovery, but no ME52N handler is registered at startup.

The operation catalog now contains four released functions. No APQP operation is advertised beyond the implemented plan close date query.

## Completion matrix

✅ implemented; “Existing” means the accepted RFQ implementation is preserved.

| Capability | RFQ | Info Record | APQP | Source List |
|---|---|---|---|---|
| Guided template user flow | Existing | ✅ | ✅ | ✅ |
| Technical configuration hidden | Existing | ✅ | ✅ | ✅ |
| Automatic validation | Existing | ✅ | ✅ | ✅ |
| Business preview | Existing | ✅ | ✅ | ✅ |
| Confirmation before SAP writes | Existing | ✅ | N/A — read-only SAP | ✅ |
| SUCCESS sound | ✅ | ✅ | ✅ | ✅ |
| ATTENTION sound | ✅ | ✅ | ✅ | ✅ |
| ERROR sound | ✅ | ✅ | ✅ | ✅ |
| WAITING_FOR_USER / verified continuation | Existing | ✅ | ✅ | ✅ |
| Shared result component | Existing result page retained | ✅ | ✅ | ✅ |
| View Details | Existing | ✅ | ✅ | ✅ |

All sounds can be disabled globally. Completion with skips/warnings uses an attention notification. Audio failure never changes the automation state.

## UI and business inputs

Shared UI lives in `src/renderer/src/components/automation`:

- `GuidedAutomationPage`: upload → auto validation → business sample → start → result.
- `AutomationPageLayout`: download, upload, validation, preview, confirmation, progress, result, details components.
- `GuidedAutomation.module.css`: responsive light/dark, inherited text-size preferences.
- `ActionRequiredModal` / `UserInputModal`: global real pause modal; text, date, dropdown, yes/no and checkbox fields.

Info Record exposes only Plant, purchasing organization, target lead time (whole days), and standard/consignment type. The input template contains Info Record and Plant. Supplier/material counts are not fabricated from this template, which does not provide those identifiers. Headers/sheet are detected; retries, checkpoint frequency, record padding and execution mode stay internal.

APQP exposes Plant and the genuine business choice of refreshing existing Excel dates. It uses eligible idle SAP GUI sessions in one signed-in environment; the Advanced session limit defaults to three. It does not create extra sessions automatically, avoiding interruptions to existing SAP work. Native SAP/Excel business query logic remains unchanged.

Source List requires Material No., Parma and explicit Dual Sourcing Yes/No. Blank choices and same-material conflicting suppliers/modes block execution. The page exposes editable defaults: execution-day start, 31.12.2099 end, purchasing organization C100; Plant stays C100. The native adapter discovers controls by the recorded EORD-VDATU, BDATU, LIFNR, EKORG, RM06W-FESKZ and EORD-AUTET field IDs (never numeric GetCell). A unique supplier/organization row covering the requested interval is reused; otherwise a verified empty row is populated with the dates, supplier, organization, Fix and MRP 1. Yes preserves other rows unchanged; No clears ALL other Fix and MRP, including expired/future rows, while retaining all row data/dates. Ambiguous/overlapping target intervals, unavailable empty rows, missing/unreadable or read-only controls stop safely. All affected rows are checked before the first write and fully read back before Save. Save requires success-type status and no open modal; unknown responses are never replayed. Stop before the first write changes nothing; after writing starts, the current material finishes verification/Save. Excel SUCCESS always rechecks SAP; matching states skip Save. UTF-8 error traces include stage, material, Parma, mode and rows under managed run logs; pause details include the actual error/rows/path.

Source List startup reads an open Excel workbook with rectangular `Range.Value2` calls (bounded blocks), not one COM call per input cell or formatted blank row. Closed workbooks still use openpyxl, loaded only when needed. Backup, required Yes/No validation and original Excel row numbers are preserved. New-row dates are written directly as `DD.MM.YYYY` (default local execution date, or the user's explicit custom date); no F4/calendar is opened. Read-only date controls fail preflight before edits, and date readback remains mandatory before Save. The managed `me01-performance.jsonl` now includes a startup entry separating import, workbook preparation, SAP connection and ME01 navigation time; this does not include Electron IPC or Python process launch overhead and is not a guaranteed cold-start SLA.

Normal Settings contains language, theme, text size, sound, and auto-open result for the three guided modules. Company technical settings and diagnostics are collapsed under Advanced / Key User Settings. History preserves raw messages under details and uses business labels in normal lists.

## Engine adapters and safety

- `GuidedAutomationService` owns active run IDs, request IDs, allowlisted responses, persisted local interaction snapshots and issued result paths. It rejects stale/duplicate/invalid responses and cross-module simultaneous runs. Request values are checked against the engine-owned field schema.
- `NativeInteractionBridge` carries the protocol to native child stdin, never through renderer filesystem access.
- `hub_user_interaction.py` is the small native pause adapter. Only the current run/request can resume. Continue invokes read-only verification; Stop wins even during verification. Unknown outcomes have no Continue.
- Info Record opens all configured worker browsers and verifies every window is signed in before starting any record update. A failed record stops new scheduling. In-flight records finish and partial Excel results save before the stop-only pause is published. Cancellation does not close a browser in the middle of Save.
- Source List detects an idle signed-in session without guessing between environments or hijacking another transaction. Every table page/write revalidates the original material/Plant; the signed-in identity is preserved in Hub mode. Empty-row insertion follows the recorded SAP controls. Unknown row errors persist actual details/Excel results and pause Stop-only before the next material; no blind retry or automatic Save replay.
- APQP login is verified before querying. In Hub mode, uncertain query/worker errors stop scheduling; current read-only queries drain and Excel/logs flush before a Stop-only pause. Known no-result/no-date responses remain ordinary skips.
- Closing the application requests cancellation and waits for the active engine to finish. Stop does not roll back saved SAP objects.

Snapshots in `.local-data/data/interactions/<runId>/checkpoint.json` are diagnostic snapshots, NOT permission to auto-resume after a crash. The terminal run outcome remains in execution history/results. Open Result only opens paths issued during the current app session.

## Excel compatibility

ME01 performance: supported SAP GUI clients read a complete table in one public `GetObjectTree` call (available since 7.70 PL3), with live named control lookups only for edited fields. Checkbox reads use Magic DispID 32011 (`Checked`), not the unrelated `Selected` export; missing/invalid values never default to unchecked. Every current row/field is still read, planned rows preserve all existing data except Fix/MRP, and Save confirmation is unchanged. The proven empty-entry geometry may be reused only within that material, never as cached record values. Older clients without the API use the safe legacy reader. A read-only comparison on the actual table measured 3.02s legacy vs 0.17s bulk with every field identical; this is not a claim about full Save/network latency. Each managed run logs `me01-performance.jsonl` with navigation/maintenance/Save/Excel durations, confirmed Save state, before/planned rows, total per-record elapsed time and an advisory 20s target. Exceeding 20s never kills an in-flight SAP write or replays Save. The log uses the same 60-day artifact retention; no input-directory files are added. `scripts/inspect-me01-source-table.py --material <number> --benchmark` measures the two readers on the current page without editing or scrolling.

ME01 table reading uses actual contiguous field controls and overlapping pages, not an unconditional jump to the scrollbar maximum. Some ME01 layouts report 49 rows with only 25 addressable entry rows: moving down one position exposes 24 matching controls and a verified empty tail. When the empty-area page instead echoes the original prefix (including the original first supplier), the reader accepts only the exact padding shape, a completely matching prefix and a fully empty dropped tail; it then restores position zero and rechecks EVERY original field/blank before returning row locators. A partial echo, changed row, missing control or changed restored page stops before business writes. Normal multi-page records are still fully scanned. Visible rows are edited on their current page; every field is revalidated. `scripts/inspect-me01-source-table.py --material <number> --plant C100` inspects the unique already-open table read-only, without navigation, scrolling, edits, Save or extra output files. Its developer-only `--read-check` runs the actual snapshot algorithm with operator-controlled scrollbar moves (acknowledged on stdin), never SDK property writes, field changes or Save. This verified the one-existing-supplier case on the actual SAP table; offline No/Yes/add/repeat/failure regressions also cover it. A live successful Save is still a separate acceptance check.

Upload requires a saved Excel workbook; users should not modify purchasing input while a run is active. Native Source List/APQP retain Excel COM support for an already-open workbook. ME12 falls back to a separate timestamped result when Windows locks the original. Backups are preserved.

ME12 now accepts both default and prefixed SpreadsheetML, including the bundled `x:` template, and preserves a valid namespace during result writeback. It auto-selects the one sheet with required Info Record/Plant headers and rejects nonnumeric/overlength Info Records. Source List and APQP prefer their standard input sheets, or detect one matching input sheet if renamed; ambiguous workbooks are rejected rather than silently reading an instruction tab.

## Verification

Code-only checks:

```powershell
npm run typecheck
npm run lint
npm run build
npm run test:guided
npm run test:apqp
py -3 scripts/test-me01-source-list.py
npm run test:rfq
npm run test:rfq-fields
npm run test:rfq-recovery
npm run test:rfq-material-reset
npm run test:rfq-runner
npm run smoke
npm run smoke:rfq
npm run smoke:apqp
```

Desktop smoke exercises real template save dialogs (mocked user choice), real offline Excel preview, ME52N absence, the simplified three flows, business confirmation, APQP without SAP-write confirmation, global pauses across routes, failed recheck, Stop-only unknowns, all five field types, common result presentation, all three sound events and mute, collapsed Advanced settings, and dark/large layout. Every SAP run boundary is replaced with a mock before confirming execution. RFQ regression also tests optional audio failure.

New offline adapter tests cover stale/duplicate responses, failed verification, Stop during recovery, field-schema validation, file-open allowlisting, native supplier/session verification, prefixed template read/write and multi-window login/cancellation boundaries. Existing native/RFQ regression tests are retained.

No Production SAP writes, engine packaging, installer generation, signing, cloud services, telemetry or auto-update were performed.

## Manual acceptance still needed

In an authorized test environment, verify certificate selection and SAP login, native Scripting availability, Info Record WebGUI labels (standard and consignment), one intended Source List supplier, APQP using 1–3 eligible idle sessions, stopping after a saved record, and Excel open during writeback. Offline passes do not prove company SAP theme, authorization or GuiXT behavior on every endpoint.
