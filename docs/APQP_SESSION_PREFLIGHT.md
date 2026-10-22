# APQP SAP session preflight fix — updated 2026-10-16

Released in `0.2.4-hotfix.2` on 2026-10-16 with source policy `949-fast-startup-v6`. The previously delivered `0.2.4-hotfix.1` ZIP does not include this update. The shared Python engine and desktop application were rebuilt together. Packaging verifies the frozen engine's `apqpSessionPolicy` against the source before creating the ZIP.

## Scope

- Standalone discovery allows optional Description/Name failures. Hub Production selection needs a readable Logon entry label (Description or descriptive Name); a technical `con[0]` name alone cannot prove which entry is open.
- Session-state failures (Busy, popup/main-window access or Transaction) reject that window, not every healthy window in the same verified environment.
- Transaction-read failures are never converted into an idle/home state. Worker transaction guards use a strict read too.
- Connection inventory and required System/Client/User identity failures remain blocking: an unreadable identity cannot safely be assumed to belong to the selected environment.
- The Hub explicitly selects Production `VCE - One Digital Core [949]`, verifies System `VCE` and actual Client `100`, and ignores other known entries such as QA `[321]`. `[949]` is the Logon entry ID, **not** the Client number. Multiple matching connections/accounts and identity changes still block; maximum worker limits are unchanged.
- The Hub selects verified existing 949 windows **regardless of their initial T-code** (including ME11/ME01/NPL). It prefers available APQP/home windows and directly navigates each selected other-transaction window to `ZMFM050035`, at most once per window. The number selected is limited by both pending Excel rows and the configured worker limit. No sibling session is created. Before starting, save current SAP work: transaction switching can lose unsaved input, and a confirmation prompt is not guaranteed. Busy, popup-blocked or unreadable windows are not navigated.
- The verified selection is handed directly to worker preparation rather than making a second home-only selection. A fresh state/identity check still catches manual changes after startup. Non-selected windows are not navigated. Standalone read-only discovery keeps its original conservative transaction filter; it is no longer the Hub's startup gate.
- If no 949 connection exists, the Hub now opens the configured SAP Logon entry automatically, launching SAP Logon first if necessary. Scripting startup polling is cancellable and limited to 8 seconds before an actionable pause. An existing 949 connection with zero sessions, pending sign-in, busy windows, a dialog, wrong System/Client or another transaction is never reopened.
- A complete readable connection inventory is required before automatic opening. An existing signed-in VCE/100 login under another label also blocks opening, avoiding duplicate production logons. If the local SAP Logon entry has a different name, the user must verify it manually rather than the Hub guessing another destination.
- Each run attempts SAP Logon startup at most once and asynchronous `OpenConnection` at most once. Flags are set before COM calls: even an exception/timeout may have created a login. Check Again retains the same connector and never blindly repeats that call. Sign-in, certificate/security and multiple-logon dialogs remain for the user to review.
- An unsigned connection is no longer described as a successfully opened/signed-in session. Read-only discovery distinguishes an actual login page, a blocking login dialog, multiple-logon licensing, an unreadable state and an unavailable window. For a pending login/dialog the Hub validates connection identity and native window handles, restores the existing owner and modal, and requests foreground activation without clicking, typing or choosing any option. Windows foreground restrictions are retained in diagnostics; they never trigger a replacement login. The same handles are not repeatedly raised during polling.
- After asynchronous opening, readiness is polled for up to 8 seconds (cancellable), allowing normal SSO to complete without an immediate warning. Same-window navigation has bounded polling and an at-most-once request, including ambiguous COM failures: no command-box fallback, replay, Back, Save or automatic confirmation. Both the transaction and all four APQP selection fields must be verified after navigation, including on Check Again. If SAP raises a save/discard dialog, the user handles it; automation never picks an option.
- Hub-side Python defaults also select 949/VCE/100 and same-window navigation when older desktop code passes blank target fields. Each actual Hub run logs the marker `949-fast-startup-v6` with the target so deployment can be verified. A frozen packaged engine still requires rebuilding; source edits cannot patch an existing EXE. Already-running Python workers must be stopped and a new run started to load source changes.
- Ordinary saved-file previews do not start Excel/Python/SAP. The fallback native preview remains Excel-only: connection name is blank and auto-open is disabled in the runner; Python preview exits before any SAP verification.

## Performance update (2026-10-16)

- Ordinary template previews read the saved XLSX directly in the desktop process:
  no Python launch, Excel startup or SAP access. A one-file cache retains counts
  and 12 samples per mode only, keyed by path, file identity, size, mtime/ctime
  nanoseconds and selection settings. Saving/changing the file invalidates it.
- Three- and five-column templates, namespace prefixes, shared/inline strings,
  leading zeros, existing-date selection and independent maxItems limits retain
  their native semantics. Formula/error/unsupported input cells use the original
  live Excel preview instead. Saved previews are explicitly labelled in the UI.
- Execution still attaches to/opens Excel and reads its current data before any
  SAP access, including unsaved changes in the attached workbook. Invalid live
  rows abort before SAP even if an earlier saved preview passed. Excel may remain
  open; write-back conflict/identity checks remain in place.
- Headers are read in one A1:E1 Range call rather than five cell calls. Navigation
  verification binds one previously verified SAP session and checks its identity,
  Busy, modal, transaction and four selection fields. It does not re-enumerate all
  sessions on each poll. The compatibility collection now reads only the requested
  Count/item, without eagerly enumerating every sibling.
- Ready pages incur no fixed sleep; pending navigation polls every 20ms (formerly
  200ms). Existing timeout, cancellation, manual-dialog and no-replay rules remain.
  No guarantee of millisecond end-to-end SAP latency is possible: SAP/server/SSO
  and Excel startup remain external costs. Runtime notices separately log Excel
  attach/open, live validation, and SAP navigation/verification durations.
- Offline synthetic benchmark (10,000 rows, local machine under test load):
  first saved preview ~546ms; cached/mode-change ~0.7ms; native starts=0. These are
  measurements, not a promise for another PC/network drive. No live SAP action was
  used for the timing.

## Actionable pause reasons

The normal pause dialog shows the classified English/Chinese reason immediately. Technical details include the code and read-only scan evidence. Rechecking updates both the visible reason and technical evidence if the condition changes. APQP sign-in pauses no longer repeat an unhelpful generic failure banner.

| Code | Meaning / action |
| --- | --- |
| `SAP_GUI_UNAVAILABLE` | Cannot access SAP GUI Desktop; finish desktop sign-in and check Scripting access. WebGUI alone is insufficient. |
| `SAP_SESSION_SCAN_FAILED` | Cannot enumerate SAP connections; resolve GUI/Scripting access before retrying. |
| `SAP_SESSION_IDENTITY_UNREADABLE` | Cannot establish complete environment identity; resolve inaccessible/disconnected/login windows without discarding unsaved work. |
| `SAP_NOT_SIGNED_IN` | No signed-in matching SAP GUI identity exists. |
| `SAP_LOGIN_REQUIRED` | An unsigned SAP main/login window exists; the Hub attempts to show it for manual sign-in. |
| `SAP_MULTIPLE_LOGONS` | SAP is blocked by the multiple-logon licensing dialog; show the existing window and require the user to decide. Never end other logons automatically. |
| `SAP_LOGIN_DIALOG_OPEN` | A pre-login popup blocks authentication; show it without acknowledging it. |
| `SAP_LOGIN_STATE_UNREADABLE` | Sign-in state cannot be verified; do not assume there is no connection and reopen it. |
| `SAP_LOGIN_WINDOW_UNAVAILABLE` | An incomplete connection has no readable main/login window; inspect SAP Logon failure/disconnection messages manually. No automatic close/reopen. |
| `SAP_ENVIRONMENT_AMBIGUOUS` | Different signed-in System/Client/User identities are present; no automatic target guessing. |
| `SAP_SESSION_CHANGED` | A previously observed identity changed during verification; recheck the intended login. |
| `SAP_NO_IDLE_SESSION` | Conservative standalone discovery classification; other T-codes are eligible in Hub startup, which navigates each selected existing window to APQP. |
| `SAP_SESSION_BUSY` | All candidate windows are busy; wait and recheck. |
| `SAP_SESSION_DIALOG_OPEN` | All candidate windows have dialogs; the user must review/handle them in SAP. |
| `SAP_SESSION_STATE_UNREADABLE` | Login is known but no window state can be verified; inspect the existing window/Scripting access and retain details. |
| `SAP_TARGET_CONNECTION_MISSING` | Target entry absent (read-only discovery / auto-open disabled). |
| `SAP_TARGET_INVENTORY_UNREADABLE` | Cannot prove the target is absent; no extra login is opened. |
| `SAP_TARGET_AMBIGUOUS` | Multiple 949 connections exist; no automatic selection or logoff. |
| `SAP_TARGET_ALIAS_PRESENT` | Another entry already has a VCE/100 login; verify naming rather than duplicate the login. |
| `SAP_LOGON_START_FAILED` | SAP Logon executable could not be started; open it manually and recheck. |
| `SAP_TARGET_OPEN_FAILED` | Could not confirm the open request; inspect Logon messages; do not automatically replay. |
| `SAP_TARGET_OPEN_PENDING` | An open request was sent but no target is visible yet; wait/handle Logon messages and recheck. |
| `SAP_APQP_NAVIGATION_FAILED` | SAP could not confirm entering APQP; inspect dialogs/authorization and recheck. Never replay navigation blindly. |
| `SAP_APQP_NAVIGATION_PENDING` | Navigation was requested but the same window has not reached the verified APQP query page; resolve prompts/recheck. No new session or duplicate request. |

## Safety and acceptance

Discovery and diagnostics are read-only. Hub startup/rechecking may launch Logon/open the missing target once, and switch one existing verified window to APQP as explicitly requested by the user. Save existing work before starting. No automatic dialog acknowledgment, logoff, reconnect, sibling-session creation or business write was added. Asynchronous opening follows the [SAP GuiApplication API](https://help.sap.com/docs/help/b47d018c3b9b45e897faf66a6c0885a8/a020c8f8cfaf48ec9b579d5961889639.html); identity/readiness is verified separately rather than assuming the request completed. RFQ/Source List/SLT business and selection rules are unchanged. The shared pause protocol only consumes optional classified-error summary attributes; ordinary exceptions keep their existing behavior, including Stop and stale-request checks.

Offline regression covers optional-property failures, a bad Busy/Transaction/popup window alongside a healthy window, failure classifications, identity/inventory ambiguity, worker-count limits and preservation of initial/recheck evidence. Mocks cover 949 reuse with QA open, missing target/SSO, signed-out/busy/dialog windows, Client mismatch, aliases, inaccessible inventory, pending opens, COM failure after opening, cancellable startup and preview isolation. Pending-login mocks verify owner/modal display order, once-only focus, no popup input or extra connection, invalid handles, changed identities and Windows foreground restrictions. Same-window tests cover ME11/ME01/NPL navigation without CreateSession, rejected navigation, ambiguous COM responses, transaction-only/fields-missing states, save/discard dialogs, cancellation and once-only rechecks. The UI test uses synthetic IPC requests and forbids SAP/browser start endpoints; it checks English/Chinese multiple-logon reasons, updated reasons after recheck, retained details, Check Again and Stop.

Commands:

```powershell
npm run test:apqp
py -3 scripts/test-hub-user-interaction.py
node --test scripts/test-guided-automation.mjs
npm run typecheck
npm run lint
npm run build
node scripts/apqp-session-smoke-test.mjs
```

Mock tests establish the reproduced code defects, not the exact fault on a remote endpoint. A small controlled acceptance run on the affected computer is still needed after packaging; no real SAP query/write is part of these checks.
