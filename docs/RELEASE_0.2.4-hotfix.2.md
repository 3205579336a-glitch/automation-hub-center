# SAP Automation Toolbox 0.2.4-hotfix.2 — 2026-10-16

Portable ZIP: `release/SAP-Automation-Toolbox-0.2.4-hotfix.2-portable-20261016-140427.zip`

- 162,571,479 bytes (~155 MiB), 297 entries.
- SHA-256: `5e97aab6cdb87025923a40366fafa85e3fa54aa365ffacdb3ac79a52da7f48fe`
- Native engine policies: `949-fast-startup-v6`, `verified-startup-v1`; RFQ engine v32.
- Python, pywin32, openpyxl, Playwright runtime and their required libraries are bundled.
  End users do not install Python/Node. Existing company SAP GUI, Excel, Chrome,
  network and SAP permissions remain prerequisites.

## Included

RFQ/Source List connection verification and sign-in rechecks, actionable COM
diagnostics, APQP switching selected existing windows from other T-codes, APQP
fast saved-file previews/cache with live validation before SAP, target-only
20ms pending-navigation checks, and SLT post-SSO startup handling. No security
dialogs, certificates, save/discard choices or other logons are auto-confirmed.

## Acceptance

Rebuilt the native runtime and desktop executable. Native self-test and frozen
RFQ validate-only mode pass without development Python/Node on PATH. Packaged UI
checks cover four templates, four operations, persisted 3-worker settings, missing
input guards, bilingual sign-in pauses/rechecks/Stop, and laptop-size layouts.
Synthetic new/legacy APQP previews are read-only and use the fast saved-file path.
ZIP CRC, path safety, private-payload checks and extracted binary/template hashes
pass. Affected-user real SAP acceptance remains necessary; no SAP business
transaction, creation or save was executed during release QA.

One auxiliary automated launch reported Chromium GPU/network child-process
initialization error 18. The standard packaged launch, isolated functional QA,
subsequent bilingual-modal launch and actual ZIP-extracted launch passed. The
precise transient cause was not established; this does not prove compatibility
with every endpoint security/GPU configuration. Retain startup logs if an end
user encounters a no-window launch; do not bypass corporate security controls.

Exit the old application, extract the WHOLE ZIP to a new local folder and launch
`SAP Automation Toolbox.exe`. Do not copy only the EXE. Previous release ZIPs are
retained; per-user settings/logs are not deleted by this packaging operation.
