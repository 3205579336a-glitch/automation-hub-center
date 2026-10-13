# V0.2.4 end-user manual verification

Verified on **2026-10-13** against release commit **cc27068065c41de2740fcb6c3e4b88bfeabd8146** and the local packaged application. Documentation-only work: no SAP business query/write, application rebuild, ZIP rebuild, GitHub push or new software dependency installation was performed.

## Deliverables

| Item | Location | Scope |
| --- | --- | --- |
| English primary manual | `docs/USER_MANUAL.md` | Manual 1.0, PAH-UM-EN-024, 20 chapters. |
| Faithful Chinese manual | `docs/USER_MANUAL_ZH.md` | Manual 1.0, PAH-UM-ZH-024, the same business/safety rules. |
| English printable PDF | `output/pdf/Purchasing_Automation_Hub_User_Manual_V0.2.4_EN.pdf` | 54 pages, A4, clickable contents, 20 outline bookmarks. |
| Chinese printable PDF | `output/pdf/Purchasing_Automation_Hub_User_Manual_V0.2.4_ZH.pdf` | 52 pages, A4, clickable contents, 20 outline bookmarks. |
| Interface illustrations | `docs/manual-assets/` | 16 real-interface captures using fictitious training data; no placeholders. |
| Documentation build/check helpers | `scripts/build-user-manual.py`, `scripts/inspect-user-manual.py`, `scripts/capture-user-manual.mjs` | Separate developer documentation tools, not new end-user prerequisites. |

Exact `package.json` version: **0.2.4**. The user's “V0.24” wording is documented as **V0.2.4**, not silently treated as a different release. The application display/executable name remains **SAP Automation Toolbox**; the manual product title is **Purchasing Automation Hub**. Release date is 2026-10-12; manual issue date is 2026-10-13.

The printable manuals use a consistent cover, document control, revision history, automatic page-numbered contents, numbered chapters, repeated table headers, cautions, captions, embedded Latin/Chinese fonts, running headers and page numbers. Nine wide interface figures use A4 landscape sheets; text and compact illustrations use A4 portrait. Each PDF is under 2 MB.

## Functions documented

1. Automatic batch Buyer Receipt / RFQ creation from NPL: native SAP GUI, sequential RFQ groups.
2. Automatic batch Supplier Lead Time maintenance: ME12 WebGUI, Standard and Consignment, independent worker windows.
3. Automatic batch APQP Plan Close Date query: native SAP GUI, available idle sessions, no SAP business write.
4. Automatic batch Source List maintenance: ME01, C100, explicit Yes/No dual sourcing, no supplier-row deletion.

ME52N / PR modification is explicitly excluded from the normal released interface. Parallelism is documented only where implemented; raising an SLT/APQP setting is not advertised as enabling parallel RFQ/Source List.

## Error coverage

- **40 numbered troubleshooting categories**, matching in both languages.
- **27 grouped reference entries containing 78 actual technical error, outcome or recovery identifiers**. All 78 were found in current application/engine source, and checked in both PDF text outputs after normalizing layout whitespace.
- Counts include states such as `ALREADY_EXISTS`, `SIGN_IN` and recognized recovery checkpoints; they are not presented as 78 distinct failure dialogs.
- General Windows launch/security cases and external SAP multiple-logon/GuiXT messages are labeled as such, not invented Hub error IDs.
- Source List control/overlap/read-only details are described as stage/message text where the implementation has no unique identifier.
- Each numbered category gives meaning, user action, retry limits and Key User/IT escalation.

## Screenshots

| Figure | Included interface |
| --- | --- |
| 1 | Dashboard and estimated savings. |
| 2 | Four Operations cards and SLT authorization reminder. |
| 3 | Normal display/notification settings. |
| 4 | RFQ preparation and template buttons. |
| 5 | Real RFQ validation-only response for missing required PPAP date. |
| 6 | Validated RFQ sample and training supplier group. |
| 7 | Production confirmation. |
| 8 | RFQ running/progress/ETA presentation. |
| 9 | Commodity pause and correction-session/recheck controls. |
| 10 | Result controls and fictitious RFQ number. |
| 11 | SLT page, permission reminder and Standard/Consignment choice. |
| 12 | APQP page and existing-date choice. |
| 13 | Source List Material/Parma/Yes/No sample. |
| 14 | Safe Recovery training checkpoint, 7/12 groups. |
| 15 | Execution History with a training record. |
| 16 | Chinese Operations card labels. |

All business identifiers in the illustrations are invented training values. Preview validation used synthetic Excel input; running, pause, completion and recovery examples use injected training events/evidence in an isolated disposable app profile. Live execution boundaries were replaced or forbidden before use. No screenshot is evidence that a real SAP creation/update passed. No Windows authentication credentials, private certificate material, real RFQ numbers or user workbook paths are included.

## Verification checklist

- [x] Application version is 0.2.4, from `package.json` and current package presentation.
- [x] Four released operations match current Operations/UI; ME52N is not advertised.
- [x] Portable complete-folder extraction matches `docs/RELEASE_0.2.4.md` and packaging scripts; no Python/Node setup is required for end users.
- [x] Current template files, native parsing and renderer business hints were checked; RFQ required columns and blank quantity behavior match.
- [x] RFQ Cost Breakdown **No/blank clears; Yes leaves SAP unchanged**, including an unchecked box.
- [x] RFQ groups use Plant + Project + Supplier Parma, at most 50 materials, first-row shared headers and sequential execution.
- [x] Source List **No clears other Fix/MRP; Yes preserves them**; existing supplier rows/dates are retained; reuse/overlap safeguards are described.
- [x] Source List default dates/org and direct date entry match current implementation; a page left open overnight requires start-date review.
- [x] SAP write/read-only distinctions and different confirmation behavior match each module.
- [x] Manual Windows certificate selection/SAP credentials and environment/session prerequisites are correctly retained.
- [x] Stop-before-write versus protected in-flight SAP actions, partial writeback and module-specific safe boundaries are described; no rollback promise.
- [x] WAITING_FOR_USER uses only offered verified actions; unknown write outcomes are Stop/review, not blind Continue.
- [x] Commodity missing versus technical NPL read failure, separate correction sessions and verification are distinguished.
- [x] Safe Recovery is manual review after restart, not resume; resolution does not convert execution to Success.
- [x] Results, original/copy behavior, open-Excel restrictions and RFQ number locations match code.
- [x] History 25/page and Diagnostics 20/page, Clear All across filters and protected evidence match implementation.
- [x] Manual Clear All and 60-day generated-file expiry are distinguished; important working results require separate retention.
- [x] Smart ranking is advisory/local; Adaptive ETA and saved-time estimates are not safety commands or guaranteed throughput.
- [x] Manual baselines use RFQ 35 min/group; SLT/APQP 5 min/record; Source List 5 min remains an assumption.
- [x] All documented technical identifiers were found; external/general cases are labeled.
- [x] No QA selector, universal History file opener, cloud Report Issue uploader, automatic certificate approval or automatic crash resume is invented.
- [x] Both Markdown files contain 20 chapter anchors, 40 unique issue numbers and 16 sequential figure captions, with existing image files.
- [x] Both PDFs have 20 outline bookmarks, all technical identifiers and all figure captions; no empty body pages or missing-glyph markers.
- [x] Final PDFs were rendered with bundled Poppler and visually checked, including dense tables, bilingual text, screenshots and page transitions.
- [x] Documentation capture script passes targeted ESLint; builder/verification complete using bundled dependencies.

## Documentation conflicts resolved or explicitly disclosed

| Conflict | Manual treatment |
| --- | --- |
| User calls release V0.24; software says 0.2.4. | Use V0.2.4 and explain the exact version. |
| Older RFQ/local-intelligence handoff says packaging is paused or source-only. | Treat those as dated development records. Current release 0.2.4 is an actual portable package. |
| Historical “Client 949” wording. | Distinguish **[949] SAP Logon entry** from **Client 100**; ordinary RFQ page exposes Production only. |
| Older Intended Supplier/MPP Project No. terminology. | Current normal template uses **Supplier Parma / Project No.**; compatibility aliases are not instructions to rename headers. |
| Old Source List guidance implies all other Fix flags are always preserved. | State current explicit Yes/No rules and warn that No also clears expired/future other-row Fix/MRP, without deleting them. |
| History/Diagnostics UI says results are kept under automatic cleanup. | Explain actual backend difference: manual Clear All preserves workbooks; automatic 60-day generated-run expiry may delete completed managed working results/backups. This wording inconsistency remains in the app; no app logic/text was changed by this task. |
| APQP template contains additional preformatted cells/columns, including a repeated date label outside primary input. | Identify A-E as the real normal input/output mapping and E as writeback. Do not suggest extra columns are mandatory supported features. |
| History lists paths, but older workflows may imply all paths have an Open button. | Document task Open Result first and History details as paths, not a universal file opener. |
| Generic privacy copy can imply no business values in logs. | Conservatively state identifiers, quantities, SAP text and paths may appear; hidden storage is not encryption. |

## Evidence sources

Reviewed repository sources include:

- Version/distribution: `package.json`, `scripts/package-portable.ps1`, `docs/RELEASE_0.2.4.md`.
- Current pages: `src/renderer/src/pages/OperationsPage.tsx`, `CreateRfqPage.tsx`, `Me12LeadTimePage.tsx`, `ApqpPlanClosurePage.tsx`, `Me01SourceListPage.tsx`, `HistoryPage.tsx`, `SettingsPage.tsx`.
- Shared guidance/recovery: `src/renderer/src/components/automation/GuidedAutomationPage.tsx`, `SafeRecoveryPanel.tsx`, `src/renderer/src/components/common/ActionRequiredModal.tsx`, `src/shared/guided-automation.ts`.
- Data/templates: `resources/templates/`, `src/main/services/rfq-excel-service.ts`, `me12-excel-service.ts`, `me01-excel-service.ts`, `resources/rpa/rfq_runtime.py`, `rfq_engine.py`, `apqp_plan_closure.py`, `me01_source_list.py`, `me01_source_table.py`.
- History/retention/recovery: `src/main/services/execution-history-service.ts`, `generated-artifacts.ts`, `run-diagnostic-cleanup.ts`, `rfq-safe-recovery-service.ts`, `resources/rpa/hub_artifacts.py`.
- Advisory features: `src/shared/local-intelligence.ts`, `src/shared/time-savings.ts`, `src/main/services/local-intelligence-service.ts`.

## Gaps and release acceptance limits

- No company-specific Key User name, IT service-desk address, network/VPN guide or formal business approval policy was supplied. The manuals route users by role without inventing contacts.
- Company endpoint restrictions, unsigned-build approval, SAP GUI Scripting authorization, certificates and actual installed app versions vary by PC. Local code/screenshot review cannot establish approval on all user endpoints.
- This documentation task did **not** perform live SAP Production writes, real concurrent browser/session operation or live open-Excel writeback. The manuals describe the implemented behavior, not a new acceptance-test guarantee.
- A native Windows certificate chooser is not controllable through the normal page automation. Manual authorization remains required; no screenshot or claim of automatic approval is included.
- A stopped/incomplete run may have SAP commits newer than its last Excel save. No blanket retry instruction or guaranteed complete historical result is possible; verify uncertain documents in SAP.
- There is no supported normal-UI QA RFQ switch, in-app video library, automatic Report Issue export/upload or automatic Safe Recovery resume in this release. The manual does not create those features.

Before general distribution, retain the release's existing requirement for a small authorized endpoint acceptance test. Verify real document numbers/results, Source List Yes/No with retained suppliers, Excel-open writeback, actual available workers and safe-stop/restart review. This checklist documents the manual's correctness checks; it is not a substitute for business/IT acceptance.

## Maintenance

Update the Markdown source first, verify against a future release, then regenerate print copies. A typical documentation-only build uses the bundled Python runtime:

```text
python scripts/build-user-manual.py
python scripts/inspect-user-manual.py --render
```

These are developer documentation commands. End users only need the approved Hub package and the distributed PDF/manual; they do not install ReportLab, Python or Playwright.

Regenerable visual-QA files remain organized in the Git-ignored `tmp/pdfs/` folder because the host tool policy rejected recursive cleanup. They are not end-user deliverables and were not added to the application package.
