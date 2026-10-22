# SAP startup compatibility fix — 2026-10-16 (source only)

## Reported failure

The supplied colleague logs identify app `0.2.4`, RFQ engine v32. The workbook
passed validation (18 materials, two groups), but execution failed before NPL.
No RFQ creation or SAP save was reported.

RFQ's old `_collect_sessions` suppressed connection/session/Info COM exceptions.
Its inventory recheck could therefore see an existing 949 connection but no
usable session, then report a generic pending-login error. Newly opened
connections could wait 180 seconds and fail without a resumable login check.
The original COM failure is absent from those logs; a colleague-specific server
permission/configuration cause cannot be established from them alone.

## Changes

- `sap_gui_connection.py` provides startup-only verification for RFQ and Source
  List. Children/Connections and Children/Sessions aliases are supported. COM
  evidence and explicit server-disabled scripting status are retained.
- Verify the configured Logon entry, System, Client, User, Busy, main window,
  modal state and transaction. Prefer an idle SAP home window if available.
  A verified existing non-home window can be reused without creating a session;
  the operation's existing navigation remains responsible for entering its T-code.
- A missing target may be opened asynchronously **once per run**, including when
  OpenConnection throws after a possibly successful request. Recheck never opens
  a second connection. Pending/manual-login windows are restored where Windows
  permits it; no certificates, credentials, license choices or business dialogs
  are accepted automatically.
- RFQ now pauses at SIGN_IN with an actionable bilingual reason. Recheck only
  resolves startup, updates the displayed reason, and retains the same connector.
  No group/create/save action is replayed. Stop is checked between startup polls;
  an individual blocked SAP COM call still depends on SAP/Windows returning.
- Source List uses the same verified 949 startup instead of swallowing identity
  failures or requiring the user to close all other environments.
- APQP retains its existing verified same-window navigation to ZMFM050035 and
  worker/session logic. A compatibility collection view adds alias access and
  server-disabled scripting diagnostics without wrapping business session APIs.
- SLT uses browser automation, not SAP GUI COM. Before workers can edit records,
  a positive authenticated SAP command-field check allows one navigation from
  SAP home to ME12 following SSO. Same origin alone is insufficient. A failed or
  ambiguous navigation is not replayed; all browser workers must be ready.

Production: entry `VCE - One Digital Core [949]`, System `VCE`, Client `100`.
QA RFQ: entry `CEQ - One Digital Core - QA [321]`, System `CEQ`, Client `100`.
949 and 321 are Logon entry identifiers, **not client numbers**.

## Validation

All SAP, Excel automation and browser operations in the regression tests are
mocked. No production writes or live sign-in were performed.

```text
npm run test:sap-startup
npm run test:rfq
npm run test:rfq-runtime
npm run test:rfq-recovery
npm run test:apqp
npm run test:me01
npm run test:guided
npm run typecheck
npm run lint
npm run build
node scripts/apqp-session-smoke-test.mjs
```

The RFQ baseline AST test still protects the supplied v32 business definitions.
Only the authorized startup-selection method delegates to the new connector;
Hub startup/pause hooks are restored when each run ends.

The separate, older `rfq-runtime-smoke-test.mjs` currently stops at its initial
expired-history fixture assertion, before reaching runtime UI checks. It is not
counted as a passing test for this change. The targeted session UI smoke covers
APQP/RFQ/ME01 English/Chinese startup reasons, rechecks and Stop with business
starts explicitly forbidden.

## Deployment / colleague verification

Initially source-only; now included in `0.2.4-hotfix.2` (2026-10-16), with both the
native engine and desktop application rebuilt. Older ZIPs/EXEs are unchanged. Retest on the affected
colleague PC: an existing signed-in target window; SAP Logon only; all SAP closed;
SSO/manual login; another open transaction; and multiple workers where supported.

If `SAP_SCRIPTING_DISABLED`, error 624 or access-denied remains, IT/SAP support
must verify approved Scripting access for that user/backend. The application
does not change SAP security policies or bypass permissions.

SAP reference: https://help.sap.com/docs/sap_gui_for_windows/b47d018c3b9b45e897faf66a6c0885a8/8093f712d0ed4092a463b7edee5792cb.html
