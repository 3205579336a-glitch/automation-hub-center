# Purchasing Automation Hub 0.3.0

Release date: 2026-11-11. Windows x64 portable ZIP; extract completely and run `SAP Automation Toolbox.exe`. The native automation runtime is included. Company SAP GUI, Excel, browser, network access and business permissions are still required where applicable.

## Changes from 0.2.5

- Five supported operations: RFQ, Info Records, APQP, Source List, and the new MM02 Sub-commodity workflow.
- ME12 template supports independent SLT, PDT and confirmation-control updates for Standard and Consignment. Browser start waits for the editable ME12 screen; uncertain saves are not replayed.
- APQP pre-fills a valid Windows login as the editable business owner. Production 949 planned-date saves are verified per record; Excel plan-closure querying remains read-only in SAP.
- Collapsible sidebar, consistent dark/light UI, clearer live status, and dashboard savings for today and all retained history. Historical log cleanup and the 500-record cap still apply.
- One-task limit is enforced in the desktop UI before starting a second workflow. A blocked attempt does not launch IPC, reset a draft, or leave the page in a loading state. Background result dialogs no longer block an unrelated page.
- Lighter initial renderer load via lazy task pages and navigation preloading, shared overlapping history reads, debounced history search, and no RFQ process/workbook probes when only protected run IDs are needed.

## Verification and rollout

- The portable build verifies the packaged native engine manifest against the exact Python source digest and package version. Its smoke test launches the packaged EXE in a fresh profile and checks the version, templates, APQP owner prefill and task safeguards.
- Offline regression and desktop smoke use fixtures or fake SAP/Excel. The release does not claim production SAP acceptance or guaranteed latency. Verify with a small authorized batch for each relevant operation in the company environment.
- Use a new extract directory when upgrading; do not mix DLLs or resources with old releases. Preserve per-user local data and follow company security policy.

Current guides: [English](USER_GUIDE_0.3.0_EN.md) · [中文](USER_GUIDE_0.3.0_ZH.md).
