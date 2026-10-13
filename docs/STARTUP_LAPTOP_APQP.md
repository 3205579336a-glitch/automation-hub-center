# Startup, small-laptop layout and APQP preview - source update

Date: 2026-10-13. **Code only; no EXE/ZIP rebuilt or GitHub push.** The distributed V0.2.4 package and its release manual remain frozen. A future distribution must rebuild both the app and shared automation engine, then repeat packaged endpoint acceptance.

## Startup diagnosis and changes

Verified startup work previously on the critical path:

- Eager `playwright-core` imports in browser/SLT modules, even when no browser task was used.
- Waiting for the cosmetic Windows `attrib +H` process.
- Awaited 60-day generated-file/history/log cleanup before window creation. Cost grows with accumulated local files; it is not needed to show the interface.
- Four task pages mounted immediately, including hidden pages not yet visited.

Changes:

- Import browser runtime only when launching a real browser task. Existing browser business/configuration behavior remains unchanged.
- Create local storage directories before use, but set their hidden attribute asynchronously with a hidden Windows helper.
- Preserve recovery/history validation and execution locks **before** enabling the UI. Do not skip Safe Recovery to improve timing.
- Attempt first retention cleanup 30 seconds after initialization, only when idle. If a task/cleanup is active, retry the initial maintenance check after 60 seconds; retain the daily idle maintenance timer and all protections.
- Mount each business page on first visit; keep it mounted thereafter so navigation does not discard data or running tasks.
- Record `application.window-ready` timings in existing local structured logs: module-to-window `startupMs`, process age, Electron-ready/storage-ready/recovery-ready/services-ready milestones and app version. No new sidecar is written next to user files.

Local isolated-profile warm-development checks showed the Dashboard at approximately **1.2-2.0 seconds**; one measured window-ready record was **609 ms** from main-module initialization and **800 ms** process age. These are not user-endpoint cold-start guarantees or a measured old/new package speedup. Windows/endpoint scanning before process execution, network/share extraction locations, disk speed and roaming-profile IO were not measured on the affected user's PC. Keep using an approved complete package from a writable local directory; do not disable protection to diagnose launch time.

## Small screens / display scaling

Screen inches alone do not define usable space. Electron uses logical pixels after Windows display scaling.

- Initial native window fits the primary display's available work area instead of unconditionally opening at 1440 x 900; minimum size reduced to 640 x 480 or the work-area size if smaller.
- Removed the 1100 x 700 minimum from HTML/root/shell, preventing content from being permanently outside small/high-DPI windows.
- Compact icon navigation with accessible full labels and tooltips; flexible header, independently scrolling content and task controls that remain accessible while scrolling.
- Dashboard, task layouts, form fields, history details and diagnostics reflow; wide data tables scroll within their own container rather than widening the whole app.
- Large text preference remains large; responsiveness does not silently shrink user-selected fonts.

Verified routes: Dashboard, Operations, RFQ, SLT, Source List, APQP, History and Settings. Verified logical window sizes: 1440 x 900, 1280 x 720, 1024 x 640, 912 x 560, 800 x 600 and 640 x 480. Additional checks cover Chinese, dark theme and large text. At very small heights, vertical scrolling is expected, not a requirement that every field/card fit simultaneously.

## Simplified Settings

Removed the Advanced / Key User panel, browser/URL/worker/download controls, manual-effort baseline fields and calibration checkbox from the normal UI. Appearance and reminders remain. Diagnostics is hidden by default under the collapsed **Support & logs / 支持与日志** section, and mounts/loads logs only on expansion. Local logging and retention are unchanged. Removed the Dashboard instruction to use that deleted panel.

Internal execution defaults remain Chrome, SLT maximum one browser and APQP maximum three available sessions for a fresh profile. Manual-time references remain RFQ 35 min/group; SLT, APQP and Source List 5 min/record (Source List is still an assumption). Saving visible preferences does **not** overwrite existing technical/custom/calibrated configuration. Neither settings removal nor responsive layout changes SAP permissions/concurrency guards.

Diagnostics/History wording now correctly warns about automatic expiry of managed working results/backups; this is a wording correction, not a change to retention policy.

## APQP parsing and refresh selection

Previously, changing “Refresh dates already in Excel” invalidated the preview and started a fresh Python/Excel preview. Native parsing read A, D and E via separate COM calls for every row, making large batches expensive.

- Before launching Python/Excel, RFQ and APQP inspect the saved workbook's first-row headers directly. Wrong templates fail without an engine launch. Matching headers are **not** full validation: native business/data validation still runs. Source List and SLT already parse locally without launching the native engine for preview; existing SLT legacy column-mapping support is unchanged.
- APQP template now has **A: Part No., B: Vendor, C: APQP plan closure date**. Removed optional Ver/Description, adjusted bilingual instructions and preserved frozen headers, text identifiers and date formatting. Users fill A/B; the Hub writes dates in C. Old five-column templates remain supported and write dates in E.
- Native parsing reads A:C (new) or A:E (legacy) in chunks of 2,000 rows through `Range.Value2`, using an explicit per-sheet column mapping. All workbook contents remain untouched during preview; writeback rechecks headers, row identity and existing dates to avoid overwriting user edits.
- Both Keep Existing and Refresh Existing counts/sample rows are computed from the same uploaded snapshot. Renderer switching uses those values immediately, without another engine/Excel call.
- Mode changes during an in-flight preview do not cancel/restart it; the response is displayed using the latest choice.
- Counts, skips, invalid rows and up-to-12 sample records change with the selected mode. A fully dated batch correctly becomes runnable when Refresh is selected.
- Re-upload, including the same filename, still creates a new snapshot. Plant change revalidates the business setting. Legacy engines without mode metadata use a compatibility revalidation path.
- Actual Start still independently previews/reads the live workbook; existing SAP/session guards, eligible-worker limits, backups, date-conflict detection, cancellation and Excel-open writeback are retained. Preview reuse is not permission to act on stale workbook data.

For a 5,000-row synthetic input, the bulk parser regression verifies **three range reads**, rather than 15,000 separate per-row input-value reads. This is a call-count improvement, not a promised SAP query duration.

## Verification

- TypeScript typecheck, ESLint and app build.
- APQP offline regression, including chunk boundaries, unreadable ranges, leading-zero identifiers, incomplete/blank rows and original item-limit semantics.
- Header-gate regression: compact/legacy templates, aliases, XML namespaces/shared strings, malformed/swapped/duplicate headers, sheet ambiguity and external targets; wrong input never launches the native preview. Wrong-header rejection for a synthetic 10,000-row file was 14–44 ms on this machine (not a universal timing guarantee).
- Real Excel validation-only APQP smoke: both preview modes, current template/downloads, unchanged source bytes, incomplete-row blocking; no SAP query/write.
- New `scripts/laptop-preview-smoke-test.mjs`: six viewports/eight routes, default preservation, hidden settings, lazy page mounting, route persistence, fast mode toggles, toggles during parsing and fully dated input. All SAP start endpoints are forbidden/mocked.
- Existing task-toolbar/reset/stop smoke and Safe Recovery desktop smoke.
- Local-intelligence/productivity/recovery/artifact/history regression suite: 77 tests passed at the initial post-change run.

Screenshots are generated under ignored `artifacts/laptop-preview/`; test files/profiles are isolated under system Temp, never the user's original workbook folder. No real SAP business operation is performed by these checks.
