# RFQ: consecutive Buyer Receipt save confirmations

## Problem

After saving a group, SAP can ask Yes/No/Cancel separately for several materials.
Successive questions reuse the same `wnd[1]`, title (`Buyer Receipt : Create`),
and `BUTTON_1` / `BUTTON_2` IDs. The old three-click retry loop incorrectly
treated these as one stuck window and stopped after the third Yes.

## Behavior

- Save is issued once. Each recognized Buyer Receipt save question is accepted
  with a fresh `FindById("wnd[1]/usr/btnBUTTON_1").Press()`.
- Successful confirmations are counted, not limited by the legacy three-retry
  setting. A short polling interval replaces the previous per-click retry delay.
- The original session/system/client/user must remain unchanged and SAP must
  not be Busy. A second modal, unreadable state, unknown question, or ambiguous
  Press error is not automatically confirmed/replayed.
- Exact Yes/No button labels are checked in addition to the existing save
  dialog recognition. No complete control-tree traversal occurs before Press.
- A brief popup-free settling interval catches asynchronous next questions.
  A 300-second overall queue deadline and 500-confirmation cap protect against
  a genuinely stuck dialog; these are internal safety limits, not user settings.
- Message Display retains its existing business-error recovery stage, whether
  it appears before the first Yes or after several confirmations.
- Closing confirmations does not prove success: the existing material remapping
  and green Buyer Receipt status verification still run before RFQ creation.
  Existing deferred Stop behavior after a dispatched Save is unchanged.

## Verification

`npm run test:rfq` includes offline queue tests for 1/4/10/50/100 identical
questions, delayed questions, Busy transitions, business errors, unknown dialogs,
uncertain COM failures, session changes, timeout/count bounds and a real
`save_buyer_receipt` boundary with mocked SAP: one Save, all Yes confirmations,
then green-status verification for every material.

Also run `npm run test:rfq-runtime` and `npm run test:rfq-recovery` for protected
Stop and recovery behavior. These tests do not execute real SAP transactions.
Live SAP acceptance is still required. This source change does not alter the
previously distributed EXE/ZIP; a new native build/package is needed for users.
