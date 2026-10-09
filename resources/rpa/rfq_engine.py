from __future__ import annotations

"""
SAP GUI RPA v32: NPL -> Buyer Receipt -> RFQ (Auto Date Normalize + Parma Group)

Based on the SAP GUI Scripting recording supplied by the user.

Main design:
1. Read Excel by header name.
2. Automatically group rows by Parma + compatible RFQ header fields.
3. Query ZMFM050072 by Plant + MPP Project No. + exact Material set (single or multi-select).
4. Match Excel Material against the actual NPL grid (not fixed row numbers).
5. Select one or many matched NPL rows and create Buyer Receipt.
6. Re-map Material in the Buyer Receipt grid, fill row-level data, save, and verify.
7. Without leaving the transaction, select the successful rows and create RFQ.
8. Re-map Material in each following grid, fill vendors/quantities/cost breakdown.
9. Fill RFQ due date and vendor e-mails, confirm creation, and extract RFQ number.
10. Validate PPAP Target Date only after entering the Buyer Receipt screen.
    When it is blank or earlier than today, use a valid Excel PPAP Date if supplied; otherwise mark
    the row as INPUT_REQUIRED_PPAP_DATE and continue with the next Excel row.
11. Default to PARMA grouping: compatible rows with the same Supplier Parma are created in one RFQ.
12. For a multi-material Parma group, use SAP Material multiple-selection + clipboard upload so SAP filters the exact material set server-side.
13. Existing-RFQ / PPAP / known master-data errors remain non-fatal and are written back to Excel.
14. Write the same created RFQ Number back to every successful material row in the group.

This script uses native SAP GUI Scripting (pywin32), not Playwright/WebGUI.
It can launch SAP Logon automatically and open the configured QA/Production entry.
SAP GUI Scripting must be enabled; complete interactive login if SSO does not finish it.
"""

import csv
import datetime as dt
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import traceback
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

import openpyxl
from openpyxl import Workbook
from openpyxl.utils.datetime import from_excel as openpyxl_from_excel

from rfq_runtime import initialize, run_hub

SCRIPT_DIR = Path(__file__).resolve().parent
ENV_PATH = SCRIPT_DIR / ".env"
HUB_ARGS = initialize(ENV_PATH)


# =============================================================================
# 1. Configuration
# =============================================================================

EXCEL_PATH = Path(
    os.getenv(
        "EXCEL_PATH",
        "",
    )
)
SHEET_NAME = os.getenv("SHEET_NAME", "RPA_Input").strip()
DATA_START_ROW = max(2, int(os.getenv("DATA_START_ROW", "2")))

# Production RFQ header inputs are read from fixed Excel columns:
# E = Supplier Email, F = RFQ / Quotation Due Date.
# openpyxl uses 1-based column indexes: E=5, F=6.
SUPPLIER_EMAIL_EXCEL_COL = max(1, int(os.getenv("SUPPLIER_EMAIL_EXCEL_COL", "5")))
RFQ_DUE_DATE_EXCEL_COL = max(1, int(os.getenv("RFQ_DUE_DATE_EXCEL_COL", "6")))

SAP_CONNECTION_INDEX = max(0, int(os.getenv("SAP_CONNECTION_INDEX", "0")))
SAP_SESSION_INDEX = max(0, int(os.getenv("SAP_SESSION_INDEX", "0")))

# SAP Logon auto-launch and deterministic connection selection.
# QA is the safe default. Use PROD only when explicitly requested.
SAP_AUTO_LAUNCH = os.getenv(
    "SAP_AUTO_LAUNCH",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
SAP_TARGET_ENV = os.getenv("SAP_TARGET_ENV", "QA").strip().upper() or "QA"
SAP_QA_CONNECTION_NAME = os.getenv(
    "SAP_QA_CONNECTION_NAME",
    "CEQ - One Digital Core - QA [321]",
).strip()
SAP_PROD_CONNECTION_NAME = os.getenv(
    "SAP_PROD_CONNECTION_NAME",
    "VCE - One Digital Core [949]",
).strip()
SAP_LOGON_EXE = os.getenv("SAP_LOGON_EXE", "").strip()
SAP_LOGON_START_TIMEOUT_SEC = max(5.0, float(os.getenv("SAP_LOGON_START_TIMEOUT_SEC", "45")))
SAP_LOGIN_TIMEOUT_SEC = max(30.0, float(os.getenv("SAP_LOGIN_TIMEOUT_SEC", "180")))
ALLOW_PRODUCTION_WRITE = os.getenv(
    "ALLOW_PRODUCTION_WRITE",
    "false",
).strip().lower() in {"1", "true", "yes", "y", "on"}

SAP_TARGET_ALIASES = {
    "QA": "QA",
    "TEST": "QA",
    "QAS": "QA",
    "321": "QA",
    "PROD": "PROD",
    "PRD": "PROD",
    "PRODUCTION": "PROD",
    "949": "PROD",
}
if SAP_TARGET_ENV not in SAP_TARGET_ALIASES:
    raise ValueError(
        "SAP_TARGET_ENV只能填写QA/TEST/321或PROD/PRD/949，"
        f"当前值={SAP_TARGET_ENV!r}"
    )
SAP_TARGET_ENV = SAP_TARGET_ALIASES[SAP_TARGET_ENV]

# Production flow differs from QA after Buyer Receipt save. In PROD the current
# CUSTOMER1 grid already exposes LIFNRx_CB and can go directly to btn[19]
# (Detailed RFQ), matching the user's production recording. QA keeps the old
# btn[2] -> CUSTOMER2 -> btn[9] intermediate path.
PROD_DIRECT_RFQ_AFTER_BUYER_RECEIPT = os.getenv(
    "PROD_DIRECT_RFQ_AFTER_BUYER_RECEIPT",
    "true" if SAP_TARGET_ENV == "PROD" else "false",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# In PROD, set the due date text as DD.MM.YYYY and also use the calendar popup
# when available, matching the recorded date-selection flow.
PROD_USE_RFQ_CALENDAR_PICKER = os.getenv(
    "PROD_USE_RFQ_CALENDAR_PICKER",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
SAP_TARGET_CONNECTION_NAME = (
    SAP_PROD_CONNECTION_NAME if SAP_TARGET_ENV == "PROD" else SAP_QA_CONNECTION_NAME
)
SAP_TARGET_CONNECTION_CODE = "949" if SAP_TARGET_ENV == "PROD" else "321"

# SAP environment protection. When EXPECTED_SAP_SYSTEM / EXPECTED_SAP_CLIENT
# are provided, the script scans all open SAP GUI sessions and connects to
# the matching environment instead of trusting a volatile connection index.
SAP_ENVIRONMENT_GUARD = os.getenv(
    "SAP_ENVIRONMENT_GUARD",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
SAP_AUTO_SELECT_BY_SYSTEM = os.getenv(
    "SAP_AUTO_SELECT_BY_SYSTEM",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
EXPECTED_SAP_SYSTEM = os.getenv("EXPECTED_SAP_SYSTEM", "").strip().upper()
EXPECTED_SAP_CLIENT = os.getenv("EXPECTED_SAP_CLIENT", "").strip()
EXPECTED_SAP_USER = os.getenv("EXPECTED_SAP_USER", "").strip().upper()
ALLOW_UNVERIFIED_SAP_ENVIRONMENT = os.getenv(
    "ALLOW_UNVERIFIED_SAP_ENVIRONMENT",
    "false",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# Excel lock handling. If the source workbook is open in Excel and openpyxl
# cannot overwrite it, the RPA immediately switches to a timestamped result
# workbook. It also tries to mirror status columns into the already-open Excel
# workbook through COM and sync the result back when the source becomes free.
EXCEL_LOCK_FALLBACK_ENABLED = os.getenv(
    "EXCEL_LOCK_FALLBACK_ENABLED",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
SYNC_STATUS_TO_OPEN_EXCEL = os.getenv(
    "SYNC_STATUS_TO_OPEN_EXCEL",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
SYNC_RESULT_BACK_ON_CLOSE = os.getenv(
    "SYNC_RESULT_BACK_ON_CLOSE",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
EXCEL_SAVE_RETRIES = max(1, int(os.getenv("EXCEL_SAVE_RETRIES", "3")))
EXCEL_SAVE_RETRY_SEC = max(0.2, float(os.getenv("EXCEL_SAVE_RETRY_SEC", "2")))

DRY_RUN = os.getenv("DRY_RUN", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "y",
    "on",
}
TEST_GROUP_LIMIT = max(0, int(os.getenv("TEST_GROUP_LIMIT", "1")))
MAX_MATERIALS_PER_GROUP = max(1, int(os.getenv("MAX_MATERIALS_PER_GROUP", "50")))

# v30 default behavior: rows with the same Parma are grouped into one RFQ,
# as long as the RFQ header-level fields are compatible.
GROUP_RFQ_BY_PARMA = os.getenv(
    "GROUP_RFQ_BY_PARMA",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# For grouped RFQs, do NOT load the whole Project result and scan it.
# Use SAP's Material multiple-selection popup and upload the exact material list
# from the Windows clipboard, matching the user's SAP GUI recording.
NPL_MULTI_MATERIAL_QUERY = os.getenv(
    "NPL_MULTI_MATERIAL_QUERY",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}


# ROW is the safest mode and is now the default:
# - one Excel row/material per SAP unit;
# - an existing-RFQ popup is acknowledged and the next Excel row starts;
# - avoids SAP GUI multi-row SelectedRows COM incompatibilities.
# BATCH keeps the original grouped/multi-selection behavior.
PROCESS_MODE_RAW = os.getenv("PROCESS_MODE", "ROW").strip().upper() or "ROW"
PROCESS_MODE_ALIASES = {
    "ROW": "ROW",
    "ROWS": "ROW",
    "SEQUENTIAL": "ROW",
    "ONE_BY_ONE": "ROW",
    "BATCH": "BATCH",
    "GROUP": "BATCH",
    "MULTI": "BATCH",
}
if PROCESS_MODE_RAW not in PROCESS_MODE_ALIASES:
    raise ValueError(
        "PROCESS_MODE只能填写ROW/SEQUENTIAL或BATCH/MULTI，"
        f"当前值={PROCESS_MODE_RAW!r}"
    )
PROCESS_MODE = PROCESS_MODE_ALIASES[PROCESS_MODE_RAW]

# PPAP Target Date guard. The RPA does NOT inspect or modify the external NPL
# result date. It waits until Create Buyer Receipt opens the Buyer Receipt grid,
# then checks PPAPTDAT on that screen. A valid Excel PPAP Date is written only to
# the Buyer Receipt row; otherwise the material is marked for user input.
PPAP_DATE_CHECK_ENABLED = os.getenv(
    "PPAP_DATE_CHECK_ENABLED",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
AUTO_APPLY_EXCEL_PPAP_TO_BUYER_RECEIPT = os.getenv(
    "AUTO_APPLY_EXCEL_PPAP_TO_BUYER_RECEIPT",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
CONTINUE_AFTER_PPAP_DATE_ERROR = os.getenv(
    "CONTINUE_AFTER_PPAP_DATE_ERROR",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}


# Buyer Receipt post-save recoverable master-data error handling.
# Example from PROD:
# "Sub commodity code needs to be created in Material Master."
# Required recovery sequence from the SAP recording:
# Continue -> Back -> Back -> next Excel row.
CONTINUE_AFTER_BUYER_RECEIPT_MASTER_DATA_ERROR = os.getenv(
    "CONTINUE_AFTER_BUYER_RECEIPT_MASTER_DATA_ERROR",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
BUYER_RECEIPT_ERROR_BACK_STEPS = max(
    1,
    int(os.getenv("BUYER_RECEIPT_ERROR_BACK_STEPS", "2")),
)
PPAP_MIN_DAYS_AHEAD = max(0, int(os.getenv("PPAP_MIN_DAYS_AHEAD", "0")))

# Reuse ZMFM050072 between Excel rows.
# The transaction is opened only once. Later rows return to the Plant / MPP
# Project selection screen using SAP Back inside the SAME transaction.
REUSE_NPL_TRANSACTION = os.getenv(
    "REUSE_NPL_TRANSACTION",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# Strict mode prevents the RPA from silently leaving to SAP Easy Access and
# starting /nZMFM050072 again. If the Project selection screen cannot be
# recovered inside ZMFM050072, stop with a clear error instead of restarting.
NPL_STRICT_REUSE = os.getenv(
    "NPL_STRICT_REUSE",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
NPL_MAX_BACK_STEPS = max(1, int(os.getenv("NPL_MAX_BACK_STEPS", "6")))
NPL_BACK_SCREEN_WAIT_SEC = max(
    1.0,
    float(os.getenv("NPL_BACK_SCREEN_WAIT_SEC", "8")),
)
NPL_BACK_POLL_SEC = max(0.1, float(os.getenv("NPL_BACK_POLL_SEC", "0.25")))

# Fast path for consecutive rows that use the same Plant + MPP Project.
# After RFQ terminal success, one Back normally returns to the already-filtered
# NPL result list. Reuse that list directly instead of pressing Back again to
# the Plant/Project selection screen and re-executing the same query.
REUSE_SAME_PROJECT_NPL_RESULTS = os.getenv(
    "REUSE_SAME_PROJECT_NPL_RESULTS",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# Fast/stable NPL lookup for ROW mode:
# query SAP server-side with Plant + Project + exact Material instead of loading
# the whole GPN/Project result and scanning the ALV grid.
NPL_EXACT_MATERIAL_QUERY = os.getenv(
    "NPL_EXACT_MATERIAL_QUERY",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
SAME_PROJECT_MAX_BACK_STEPS = max(1, int(os.getenv("SAME_PROJECT_MAX_BACK_STEPS", "1")))
SAME_PROJECT_RESULT_WAIT_SEC = max(
    1.0,
    float(os.getenv("SAME_PROJECT_RESULT_WAIT_SEC", str(NPL_BACK_SCREEN_WAIT_SEC))),
)

NPL_FALLBACK_RESTART = os.getenv(
    "NPL_FALLBACK_RESTART",
    "false",
).strip().lower() in {"1", "true", "yes", "y", "on"}

SKIP_SUCCESS_ROWS = os.getenv("SKIP_SUCCESS_ROWS", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "y",
    "on",
}
# When SAP reports "An RFQ is already created", mark only that material as
# ALREADY_EXISTS, click Continue, remove it from the current selection, and
# continue with the remaining materials / following Excel groups.
SKIP_EXISTING_RFQ_ROWS = os.getenv(
    "SKIP_EXISTING_RFQ_ROWS",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
CONTINUE_AFTER_EXISTING_RFQ = os.getenv(
    "CONTINUE_AFTER_EXISTING_RFQ",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
CREATE_EXCEL_BACKUP = os.getenv("CREATE_EXCEL_BACKUP", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "y",
    "on",
}

DEFAULT_12MR_QTY = os.getenv("DEFAULT_12MR_QTY", "1").strip() or "1"
DEFAULT_RFQ_QTY_PROTOTYPE = (
    os.getenv("DEFAULT_RFQ_QTY_PROTOTYPE", "1").strip() or "1"
)
DEFAULT_RFQ_QTY_SERIAL = os.getenv("DEFAULT_RFQ_QTY_SERIAL", "1").strip() or "1"

REQUIRE_GREEN_BUYER_RECEIPT = os.getenv(
    "REQUIRE_GREEN_BUYER_RECEIPT",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# Buyer Receipt Save confirmation handling. SAP can create wnd[1] slightly
# after the Save toolbar press returns, so never test for the popup only once.
REQUIRE_BUYER_SAVE_CONFIRMATION = os.getenv(
    "REQUIRE_BUYER_SAVE_CONFIRMATION",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
BUYER_SAVE_CONFIRM_TIMEOUT_SEC = max(
    1.0,
    float(os.getenv("BUYER_SAVE_CONFIRM_TIMEOUT_SEC", "20")),
)
BUYER_SAVE_POPUP_CLOSE_TIMEOUT_SEC = max(
    1.0,
    float(os.getenv("BUYER_SAVE_POPUP_CLOSE_TIMEOUT_SEC", "15")),
)
BUYER_SAVE_CLICK_RETRIES = max(1, int(os.getenv("BUYER_SAVE_CLICK_RETRIES", "3")))
BUYER_SAVE_CLICK_RETRY_SEC = max(0.2, float(os.getenv("BUYER_SAVE_CLICK_RETRY_SEC", "1")))
BUYER_GREEN_STATUS_TIMEOUT_SEC = max(
    1.0,
    float(os.getenv("BUYER_GREEN_STATUS_TIMEOUT_SEC", "30")),
)
BUYER_GREEN_STATUS_POLL_SEC = max(
    0.1,
    float(os.getenv("BUYER_GREEN_STATUS_POLL_SEC", "0.5")),
)
# SAP icon technical values vary by GUI patch/theme. In the user's QA system,
# the visibly green Buyer Receipt status icon is returned as @5B@. Keep this
# configurable so future SAP patches can add another token without code edits.
BUYER_GREEN_ICON_TOKENS = {
    token.strip().upper()
    for token in os.getenv(
        "BUYER_GREEN_ICON_TOKENS",
        "@5B@,@08@,@0V@,GREEN,SUCCESS,OK",
    ).split(",")
    if token.strip()
}
# When a previous run stopped after saving Buyer Receipt but before Create RFQ,
# resume from the currently open green Buyer Receipt screen instead of going
# back to NPL and risking another Buyer Receipt attempt.
RESUME_SAVED_BUYER_RECEIPT = os.getenv(
    "RESUME_SAVED_BUYER_RECEIPT",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# In QA 321, the RFQ flow is complete when SAP returns the success status
# "Data copied Successfully and email sent". In that case the RFQ creation
# grid can disappear/empty out, so waiting for MATNR/LIFNR1_CB would time out
# even though the business action is already finished. Keep the shortcut
# restricted to configured environments (QA by default).
RFQ_STATUS_SUCCESS_ENABLED = os.getenv(
    "RFQ_STATUS_SUCCESS_ENABLED",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}
RFQ_STATUS_SUCCESS_ENVIRONMENTS = {
    token.strip().upper()
    for token in os.getenv("RFQ_STATUS_SUCCESS_ENVIRONMENTS", "QA").split(",")
    if token.strip()
}
RFQ_STATUS_SUCCESS_MESSAGES = [
    token.strip()
    for token in os.getenv(
        "RFQ_STATUS_SUCCESS_MESSAGES",
        "Data copied Successfully and email sent",
    ).split("||")
    if token.strip()
]
RFQ_POST_INTERMEDIATE_WAIT_SEC = max(
    1.0,
    float(os.getenv("RFQ_POST_INTERMEDIATE_WAIT_SEC", "15")),
)

SAP_WAIT_SEC = max(1.0, float(os.getenv("SAP_WAIT_SEC", "30")))
SAP_LONG_WAIT_SEC = max(SAP_WAIT_SEC, float(os.getenv("SAP_LONG_WAIT_SEC", "60")))
SAP_POLL_SEC = max(0.1, float(os.getenv("SAP_POLL_SEC", "0.3")))
SAP_STEP_PAUSE_SEC = max(0.0, float(os.getenv("SAP_STEP_PAUSE_SEC", "0.4")))

# PROD final RFQ confirmation sequence from the user's recording:
# BUTTON_1 -> BUTTON_1 -> BUTTON_2 -> Continue
# i.e. YES -> YES -> NO -> CONTINUE.
PROD_RFQ_POPUP_SEQUENCE = [
    token.strip().upper()
    for token in os.getenv(
        "PROD_RFQ_POPUP_SEQUENCE",
        "YES,YES,NO,CONTINUE",
    ).split(",")
    if token.strip()
]
PROD_RFQ_POPUP_STEP_TIMEOUT_SEC = max(
    2.0,
    float(os.getenv("PROD_RFQ_POPUP_STEP_TIMEOUT_SEC", "12")),
)
PROD_RFQ_POPUP_POST_CLICK_SEC = max(
    0.3,
    float(os.getenv("PROD_RFQ_POPUP_POST_CLICK_SEC", "1.2")),
)
PROD_RFQ_POPUP_CLICK_RETRIES = max(
    1,
    int(os.getenv("PROD_RFQ_POPUP_CLICK_RETRIES", "3")),
)


PROD_RFQ_NEXT_POPUP_WAIT_SEC = max(
    2.0,
    float(os.getenv("PROD_RFQ_NEXT_POPUP_WAIT_SEC", "12")),
)


RFQ_SUCCESS_BACK_STEPS = max(
    1,
    int(os.getenv("RFQ_SUCCESS_BACK_STEPS", "4")),
)

# Recorded control IDs
TCODE_NPL = "ZMFM050072"
ID_COMMAND = "wnd[0]/tbar[0]/okcd"
ID_PLANT = "wnd[0]/usr/ctxtS_WERKS-LOW"
ID_MATERIAL = "wnd[0]/usr/ctxtS_MATNR-LOW"
ID_MATERIAL_MULTI = "wnd[0]/usr/btn%_S_MATNR_%_APP_%-VALU_PUSH"
ID_PROJECT = "wnd[0]/usr/ctxtS_ZPSPID-LOW"
ID_EXECUTE = "wnd[0]/tbar[1]/btn[8]"

ID_GRID_CUSTOMER1 = "wnd[0]/usr/cntlCUSTOMER1/shellcont/shell"
ID_GRID_CUSTOMER2 = "wnd[0]/usr/cntlCUSTOMER2/shellcont/shell"

ID_CREATE_BUYER_RECEIPT = "wnd[0]/tbar[1]/btn[13]"
ID_SAVE = "wnd[0]/tbar[0]/btn[11]"
ID_CREATE_RFQ_FROM_BR = "wnd[0]/tbar[1]/btn[2]"
ID_CREATE_RFQ_FROM_INTERMEDIATE = "wnd[0]/tbar[1]/btn[9]"
ID_OPEN_DETAILED_RFQ = "wnd[0]/tbar[1]/btn[19]"
ID_CREATE_RFQ_FINAL = "wnd[0]/tbar[1]/btn[13]"
ID_RFQ_DUE_DATE = "wnd[0]/usr/ctxtGS_0110-RFQDUEDAT"

# Grid columns from the recording
COL_MATERIAL = "MATNR"
COL_PLANT_NPL = "WERKS"
COL_PROJECT_NPL = "MPPPSPID"
COL_PPAP_DATE = "PPAPTDAT"
COL_TECH_USER = "TECHMAN"
COL_12MR_QTY = "Z12MRQTY"
COL_RFQ_QTY_PROTOTYPE = "RFQQTY_P"
COL_RFQ_QTY_SERIAL = "RFQQTY_S"
COL_AFM_REQUEST = "AFMRID"
COL_STATUS_ICON = "ICON"

# Status columns added to source Excel
STATUS_HEADERS = [
    "RPA Batch Key",
    "Buyer Receipt Status",
    "RFQ Status",
    "RFQ Number",
    "Error Stage",
    "Error Message",
    "NPL SAP Row",
    "Buyer Receipt SAP Row",
    "RFQ SAP Row",
    "Last Run Time",
]

STOP_REQUESTED = False


# =============================================================================
# 2. Excel header aliases
# =============================================================================

HEADER_ALIASES: dict[str, list[str]] = {
    "batch_group": ["Batch Group", "Group", "RFQ Group", "Batch"],
    "plant": ["Plant", "Target Plant"],
    "project": [
        "MPP Project No.",
        "MPP Project No",
        "MPP Project",
        "Project No.",
        "Project No",
        "Project",
    ],
    "material": ["Material", "Material No.", "Material No", "Part Number"],
    "ppap_date": [
        "PPAP Target Date",
        "PPAP Date",
        "PPAP Target",
    ],
    "tech_user": [
        "Technology User",
        "Technology user",
        "Technology Manager",
        "Tech User",
        "Technology",
    ],
    "qty_12mr": ["12 MR Qty", "12MR Qty", "12 MR Quantity", "Z12MRQTY"],
    "rfq_qty_p": [
        "RFQ Qty Prototype",
        "RFQ Prototype Qty",
        "Prototype Qty",
        "RFQQTY_P",
    ],
    "rfq_qty_s": [
        "RFQ Qty Serial",
        "RFQ Serial Qty",
        "Serial Qty",
        "RFQQTY_S",
    ],
    "afm_request": ["AFM Request", "AFM", "AFMRID"],
    "quotation_due_date": [
        "Quotation Due Date",
        "RFQ Due Date",
        "Due Date",
    ],
    "allow_without_preferred": [
        "Allow Without Preferred Supplier",
        "Allow RFQ Without Preferred Supplier",
        "Allow No Preferred Supplier",
    ],
    "attach_file": ["Attach File", "Attachment", "Attach Files"],
    "rfq_comment": ["RFQ Comment", "Comment"],
}

for vendor_index in range(1, 6):
    HEADER_ALIASES[f"vendor{vendor_index}"] = [
        f"Vendor{vendor_index}",
        f"Vendor {vendor_index}",
        f"Supplier{vendor_index}",
        f"Supplier {vendor_index}",
    ]
    if vendor_index == 1:
        HEADER_ALIASES[f"vendor{vendor_index}"].extend([
            "Intended Supplier",
            "Supplier Parma",
            "Supplier Parma No.",
            "Supplier Parma No",
            "Parma",
        ])
    HEADER_ALIASES[f"vendor{vendor_index}_cb"] = [
        f"Vendor{vendor_index} Cost Breakdown",
        f"Vendor {vendor_index} Cost Breakdown",
        f"Vendor{vendor_index} CB",
        f"Vendor {vendor_index} CB",
    ]
    if vendor_index == 1:
        HEADER_ALIASES[f"vendor{vendor_index}_cb"].extend([
            "Cost Breakdown",
            "Supplier Cost Breakdown",
        ])
    for email_index in range(1, 4):
        HEADER_ALIASES[f"vendor{vendor_index}_email{email_index}"] = [
            f"Vendor{vendor_index} Email{email_index}",
            f"Vendor {vendor_index} Email {email_index}",
            f"Supplier{vendor_index} Email{email_index}",
            f"Supplier {vendor_index} Email {email_index}",
        ]
        if vendor_index == 1 and email_index == 1:
            HEADER_ALIASES[f"vendor{vendor_index}_email{email_index}"].extend([
                "Supplier Email",
                "Supplier Email1",
                "Supplier Email 1",
            ])


# =============================================================================
# 3. Data models
# =============================================================================


@dataclass
class MaterialTask:
    excel_row: int
    material: str
    plant: str
    project: str
    ppap_date: str
    tech_user: str
    qty_12mr: str
    rfq_qty_p: str
    rfq_qty_s: str
    afm_request: bool
    vendors: list[str]
    cost_breakdown: list[bool]
    quotation_due_date: str
    emails: list[list[str]]
    allow_without_preferred: bool
    attach_file: bool
    rfq_comment: str
    batch_group: str

    npl_row: Optional[int] = None
    buyer_receipt_row: Optional[int] = None
    rfq_row: Optional[int] = None


@dataclass
class TaskGroup:
    key: str
    tasks: list[MaterialTask] = field(default_factory=list)

    @property
    def plant(self) -> str:
        return self.tasks[0].plant

    @property
    def project(self) -> str:
        return self.tasks[0].project

    @property
    def quotation_due_date(self) -> str:
        return self.tasks[0].quotation_due_date

    @property
    def vendors(self) -> list[str]:
        return self.tasks[0].vendors

    @property
    def cost_breakdown(self) -> list[bool]:
        return self.tasks[0].cost_breakdown

    @property
    def emails(self) -> list[list[str]]:
        return self.tasks[0].emails

    @property
    def allow_without_preferred(self) -> bool:
        return self.tasks[0].allow_without_preferred

    @property
    def attach_file(self) -> bool:
        return self.tasks[0].attach_file

    @property
    def rfq_comment(self) -> str:
        return self.tasks[0].rfq_comment


# =============================================================================
# 4. Generic helpers
# =============================================================================


def now_text() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def safe_text(value: Any) -> str:
    """Convert ordinary values to text without invoking unsafe COM default calls.

    Some SAP GUI COM collections implement ``__str__`` by dispatching a default
    member. Calling ``str(collection)`` can therefore raise sapfewse error 618:
    "Bad index type for collection access". For COM objects we return an empty
    string instead of allowing popup parsing to crash the whole RPA.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value.replace("\xa0", " ").strip()
    if isinstance(value, (int, float, bool, dt.date, dt.datetime, Path)):
        try:
            return str(value).replace("\xa0", " ").strip()
        except Exception:
            return ""
    try:
        return str(value).replace("\xa0", " ").strip()
    except Exception:
        return ""

def normalize_identifier(value: Any) -> str:
    text = safe_text(value)
    if not text:
        return ""

    if re.fullmatch(r"\d+\.0", text):
        text = text[:-2]

    if re.fullmatch(r"\d+", text):
        text = text.lstrip("0") or "0"

    return text


def normalize_material(value: Any) -> str:
    return normalize_identifier(value).upper()


def normalize_header(value: Any) -> str:
    return re.sub(r"\s+", " ", safe_text(value)).casefold()


def parse_bool(value: Any, default: bool = False) -> bool:
    text = safe_text(value).casefold()
    if not text:
        return default
    if text in {"1", "true", "yes", "y", "on", "x", "checked"}:
        return True
    if text in {"0", "false", "no", "n", "off", "unchecked"}:
        return False
    raise ValueError(f"无法识别布尔值：{value!r}")


def format_quantity(value: Any, default: str) -> str:
    text = safe_text(value)
    if not text:
        return default
    if re.fullmatch(r"-?\d+\.0", text):
        return text[:-2]
    return text


def normalize_excel_date_value(value: Any) -> Optional[dt.date]:
    """Best-effort Excel/user date normalizer.

    Accepted examples include:
      2026-12-15
      2026/12/15
      2026.12.15
      2026 12 15
      2026年12月15日
      20261215
      15.12.2026
      15/12/2026
      12/15/2026
      2026-12-15 00:00:00
      native Excel datetime/date values
      Excel serial date numbers

    Internally everything is normalized to a Python date, then the RPA uses
    YYYY-MM-DD for its own data model and DD.MM.YYYY when writing to SAP.
    """
    if value is None:
        return None

    if isinstance(value, dt.datetime):
        return value.date()

    if isinstance(value, dt.date):
        return value

    # Excel numeric serial date, e.g. 46371.
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            converted = openpyxl_from_excel(value)
            if isinstance(converted, dt.datetime):
                return converted.date()
            if isinstance(converted, dt.date):
                return converted
        except Exception:
            pass

    text = safe_text(value)
    if not text:
        return None

    # Strip a common time suffix first.
    text = re.sub(
        r"\s+(?:[0-2]?\d):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$",
        "",
        text,
    ).strip()

    # Chinese date text.
    chinese_match = re.fullmatch(
        r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?",
        text,
    )
    if chinese_match:
        year, month, day = map(int, chinese_match.groups())
        try:
            return dt.date(year, month, day)
        except ValueError:
            return None

    # Year-first variants. This directly fixes values such as 2026.12.15.
    year_first = re.fullmatch(
        r"(\d{4})\s*[-./\s]\s*(\d{1,2})\s*[-./\s]\s*(\d{1,2})",
        text,
    )
    if year_first:
        year, month, day = map(int, year_first.groups())
        try:
            return dt.date(year, month, day)
        except ValueError:
            return None

    # Compact YYYYMMDD.
    compact = re.fullmatch(r"(\d{4})(\d{2})(\d{2})", text)
    if compact:
        year, month, day = map(int, compact.groups())
        try:
            return dt.date(year, month, day)
        except ValueError:
            return None

    # Day-first dot format commonly displayed by SAP.
    day_first_dot = re.fullmatch(
        r"(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})",
        text,
    )
    if day_first_dot:
        day, month, year = map(int, day_first_dot.groups())
        try:
            return dt.date(year, month, day)
        except ValueError:
            return None

    # Slash variants: preserve the old parser's compatibility.
    formats = [
        "%m/%d/%Y",
        "%d/%m/%Y",
    ]
    for fmt in formats:
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            continue

    # ISO timestamps such as 2026-12-15T00:00:00.
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except Exception:
        return None


def parse_date(value: Any, field_name: str, required: bool = False) -> str:
    """Normalize user/Excel date input to YYYY-MM-DD."""
    if value is None or safe_text(value) == "":
        if required:
            raise ValueError(f"{field_name}不能为空")
        return ""

    parsed = normalize_excel_date_value(value)
    if parsed is None:
        raise ValueError(
            f"{field_name}日期格式无法识别：{safe_text(value)!r}。"
            "支持例如 2026-12-15 / 2026.12.15 / 15.12.2026 / Excel日期单元格"
        )

    return parsed.isoformat()


def yyyymmdd(date_text: str) -> str:
    if not date_text:
        return ""
    return dt.datetime.strptime(date_text, "%Y-%m-%d").strftime("%Y%m%d")


def parse_date_value(value: Any) -> Optional[dt.date]:
    """Best-effort parser shared by Excel input and SAP date validation."""
    return normalize_excel_date_value(value)


def sap_display_date(value: dt.date) -> str:
    """Date format displayed/accepted by the user's SAP GUI locale."""
    return value.strftime("%d.%m.%Y")


def valid_email(value: str) -> bool:
    if not value:
        return True
    return bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value))


def chunked(values: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for start in range(0, len(values), size):
        yield values[start : start + size]


def signal_handler(signum, frame) -> None:  # noqa: ARG001
    global STOP_REQUESTED
    STOP_REQUESTED = True
    print("\n⛔ 收到停止指令：当前Group完成后停止，不再领取新Group。")


signal.signal(signal.SIGINT, signal_handler)


# =============================================================================
# 5. Excel reader/writer
# =============================================================================


class ExcelStore:
    def __init__(self, path: Path, sheet_name: str) -> None:
        if not path.exists():
            raise FileNotFoundError(f"Excel不存在：{path}")

        self.source_path = path
        # Keep self.path for compatibility with the rest of the code. It is the
        # active save target and may switch to a result copy when the source is
        # locked by Excel.
        self.path = path
        self.sheet_name = sheet_name
        self.backup_path: Optional[Path] = None
        self.fallback_path: Optional[Path] = None
        self.used_lock_fallback = False
        self.dirty_rows: set[int] = set()
        self.status_headers_changed = False
        self._last_com_sync_ok = False

        if CREATE_EXCEL_BACKUP:
            self.backup_path = path.with_name(
                f"{path.stem}_RPA_Backup_{dt.datetime.now():%Y%m%d_%H%M%S}{path.suffix}"
            )
            shutil.copy2(path, self.backup_path)

        self.workbook = openpyxl.load_workbook(path, keep_vba=path.suffix.lower() == ".xlsm")
        self.worksheet = self._select_input_worksheet(sheet_name)
        print(
            f"📄 实际读取Sheet: {self.worksheet.title} | "
            f"可用Sheet: {', '.join(self.workbook.sheetnames)}"
        )

        self.header_to_column: dict[str, int] = {}
        self.logical_columns: dict[str, Optional[int]] = {}
        self.status_columns: dict[str, int] = {}
        self._read_headers()
        self._resolve_aliases()
        self._ensure_status_headers()
        self.save()

    @property
    def output_path(self) -> Path:
        return self.path

    def _select_input_worksheet(self, requested_name: str):
        """
        Select the configured input sheet safely.

        If the configured sheet is absent, automatically identify the sheet
        whose first row contains all required input headers. Never silently
        use an unrelated active sheet.
        """
        if requested_name and requested_name in self.workbook.sheetnames:
            return self.workbook[requested_name]

        required_logical_names = [
            "plant",
            "project",
            "material",
            "vendor1",
        ]

        candidates: list[tuple[int, str, Any, list[str]]] = []

        for worksheet in self.workbook.worksheets:
            normalized_headers = {
                normalize_header(worksheet.cell(1, column).value)
                for column in range(1, worksheet.max_column + 1)
                if normalize_header(worksheet.cell(1, column).value)
            }

            found: list[str] = []
            for logical_name in required_logical_names:
                aliases = HEADER_ALIASES[logical_name]
                if any(normalize_header(alias) in normalized_headers for alias in aliases):
                    found.append(logical_name)

            candidates.append(
                (len(found), worksheet.title, worksheet, sorted(normalized_headers))
            )

            if len(found) == len(required_logical_names):
                if requested_name:
                    print(
                        f"⚠️ 配置的Sheet '{requested_name}' 不存在；"
                        f"已自动识别输入Sheet '{worksheet.title}'"
                    )
                return worksheet

        candidate_summary = "; ".join(
            f"{title}: 命中{score}/4"
            for score, title, _, _ in sorted(candidates, reverse=True)
        )
        available = ", ".join(self.workbook.sheetnames)

        raise ValueError(
            "无法找到包含必要表头的Excel输入Sheet。"
            f"配置SHEET_NAME='{requested_name or '<空>'}'；"
            f"现有Sheet=[{available}]；检测结果：{candidate_summary}。"
            "请把.env设置为 SHEET_NAME=RPA_Input，并确认表头位于第1行。"
        )

    def _read_headers(self) -> None:
        self.header_to_column = {}
        for column in range(1, self.worksheet.max_column + 1):
            header = normalize_header(self.worksheet.cell(1, column).value)
            if header:
                self.header_to_column[header] = column

    def _resolve_aliases(self) -> None:
        self.logical_columns = {}
        for logical_name, aliases in HEADER_ALIASES.items():
            column = None
            for alias in aliases:
                column = self.header_to_column.get(normalize_header(alias))
                if column is not None:
                    break
            self.logical_columns[logical_name] = column

    def _ensure_status_headers(self) -> None:
        next_column = self.worksheet.max_column + 1
        for header in STATUS_HEADERS:
            existing = self.header_to_column.get(normalize_header(header))
            if existing is None:
                self.worksheet.cell(1, next_column).value = header
                self.header_to_column[normalize_header(header)] = next_column
                existing = next_column
                next_column += 1
                self.status_headers_changed = True
            self.status_columns[header] = existing

    def value(self, row: int, logical_name: str) -> Any:
        column = self.logical_columns.get(logical_name)
        if not column:
            return None
        return self.worksheet.cell(row, column).value

    def write_status(
        self,
        rows: Iterable[int],
        *,
        batch_key: Optional[str] = None,
        buyer_status: Optional[str] = None,
        rfq_status: Optional[str] = None,
        rfq_number: Optional[str] = None,
        error_stage: Optional[str] = None,
        error_message: Optional[str] = None,
        npl_row: Optional[int] = None,
        buyer_row: Optional[int] = None,
        rfq_row: Optional[int] = None,
    ) -> None:
        updates = {
            "RPA Batch Key": batch_key,
            "Buyer Receipt Status": buyer_status,
            "RFQ Status": rfq_status,
            "RFQ Number": rfq_number,
            "Error Stage": error_stage,
            "Error Message": error_message,
            "NPL SAP Row": npl_row,
            "Buyer Receipt SAP Row": buyer_row,
            "RFQ SAP Row": rfq_row,
            "Last Run Time": now_text(),
        }

        normalized_rows = sorted(set(rows))
        for row in normalized_rows:
            self.dirty_rows.add(row)
            for header, value in updates.items():
                if value is not None:
                    self.worksheet.cell(row, self.status_columns[header]).value = value

    def current_rfq_status(self, row: int) -> str:
        return safe_text(
            self.worksheet.cell(row, self.status_columns["RFQ Status"]).value
        ).upper()

    def _make_fallback_path(self) -> Path:
        if self.fallback_path is None:
            self.fallback_path = self.source_path.with_name(
                f"{self.source_path.stem}_RPA_Result_"
                f"{dt.datetime.now():%Y%m%d_%H%M%S}{self.source_path.suffix}"
            )
        return self.fallback_path

    def _find_open_excel_workbook(self):
        """Return (excel_app, workbook) when the source file is already open."""
        try:
            import win32com.client  # type: ignore

            excel_app = win32com.client.GetActiveObject("Excel.Application")
        except Exception:
            return None, None

        wanted = os.path.normcase(os.path.abspath(str(self.source_path)))
        try:
            count = int(excel_app.Workbooks.Count)
        except Exception:
            return None, None

        for index in range(1, count + 1):
            try:
                workbook = excel_app.Workbooks.Item(index)
                full_name = os.path.normcase(os.path.abspath(str(workbook.FullName)))
                if full_name == wanted:
                    return excel_app, workbook
            except Exception:
                continue
        return excel_app, None

    def _sync_status_to_open_excel(self) -> bool:
        """
        Mirror only RPA status headers and dirty rows into an already-open
        source workbook. This avoids overwriting the .xlsx file with openpyxl
        while Excel owns a write lock.
        """
        if not SYNC_STATUS_TO_OPEN_EXCEL:
            return False

        _, workbook = self._find_open_excel_workbook()
        if workbook is None:
            return False

        try:
            worksheet = workbook.Worksheets(self.worksheet.title)

            # Always ensure status headers in the live workbook. We only touch
            # the RPA-owned status columns, never user input columns.
            for header, column in self.status_columns.items():
                worksheet.Cells(1, column).Value = header

            for row in sorted(self.dirty_rows):
                for header, column in self.status_columns.items():
                    value = self.worksheet.cell(row, column).value
                    worksheet.Cells(row, column).Value = value

            workbook.Save()
            self._last_com_sync_ok = True
            self.status_headers_changed = False
            self.dirty_rows.clear()
            print("🔄 已通过Excel COM把RPA状态同步到当前打开的源Excel")
            return True
        except Exception as exc:
            self._last_com_sync_ok = False
            print(f"⚠️ Excel COM同步失败，结果仍保存在RPA Result文件：{exc}")
            return False

    def save(self) -> None:
        """
        Save without crashing on an Excel file lock.

        Normal case: save directly to the source workbook.
        Locked case: switch once to a timestamped RPA Result workbook, keep
        saving there, and optionally mirror status columns through Excel COM.
        """
        last_error: Optional[Exception] = None

        for attempt in range(1, EXCEL_SAVE_RETRIES + 1):
            try:
                self.workbook.save(self.path)
                if self.path == self.source_path:
                    self.dirty_rows.clear()
                    self.status_headers_changed = False
                elif self.used_lock_fallback:
                    self._sync_status_to_open_excel()
                return
            except Exception as exc:  # pragma: no cover - Windows file locks
                last_error = exc

                is_source_target = self.path == self.source_path
                is_permission_error = isinstance(exc, PermissionError) or (
                    isinstance(exc, OSError) and getattr(exc, "errno", None) in {13, 32}
                )

                if (
                    is_source_target
                    and is_permission_error
                    and EXCEL_LOCK_FALLBACK_ENABLED
                ):
                    fallback = self._make_fallback_path()
                    self.path = fallback
                    self.used_lock_fallback = True
                    print(
                        "🔐 检测到源Excel被占用，已自动切换到无冲突结果文件："
                        f"{fallback}"
                    )
                    # Save immediately to the fallback. If this fails, the next
                    # loop iteration will retry the fallback target.
                    continue

                if attempt < EXCEL_SAVE_RETRIES:
                    print(
                        f"⚠️ Excel保存失败，{EXCEL_SAVE_RETRY_SEC:.1f}秒后重试 "
                        f"({attempt}/{EXCEL_SAVE_RETRIES})：{exc}"
                    )
                    time.sleep(EXCEL_SAVE_RETRY_SEC)

        raise RuntimeError(
            f"Excel连续{EXCEL_SAVE_RETRIES}次保存失败：{last_error}; "
            f"当前保存目标={self.path}"
        )

    def _try_sync_result_back_to_source(self) -> bool:
        if not self.used_lock_fallback or self.fallback_path is None:
            return True

        # First try the open workbook route. This is the safest path when the
        # user intentionally keeps the workbook open.
        if self._sync_status_to_open_excel():
            return True

        if not SYNC_RESULT_BACK_ON_CLOSE:
            return False

        try:
            shutil.copy2(self.fallback_path, self.source_path)
            print(f"✅ 源Excel已解除占用，结果已同步回：{self.source_path}")
            return True
        except Exception as exc:
            print(
                "⚠️ 源Excel仍被占用，无法覆盖原文件。"
                f"完整结果安全保存在：{self.fallback_path} | {exc}"
            )
            return False

    def close(self) -> None:
        try:
            # Ensure the latest in-memory status is durable before syncing.
            self.save()
            self._try_sync_result_back_to_source()
        finally:
            self.workbook.close()

    def load_tasks(self) -> list[MaterialTask]:
        required = ["plant", "project", "material", "vendor1"]
        missing = [name for name in required if not self.logical_columns.get(name)]
        if missing:
            readable = ", ".join(missing)
            detected_headers = [
                safe_text(self.worksheet.cell(1, column).value)
                for column in range(1, self.worksheet.max_column + 1)
                if safe_text(self.worksheet.cell(1, column).value)
            ]
            raise ValueError(
                "Excel缺少必要表头："
                f"{readable}。实际读取Sheet='{self.worksheet.title}'；"
                f"第1行检测到的表头={detected_headers}。"
                "请至少提供 Plant、MPP Project No.、Material No.、"
                "Quotation Due Date、Supplier Parma。"
            )

        tasks: list[MaterialTask] = []

        for row in range(DATA_START_ROW, self.worksheet.max_row + 1):
            material = normalize_material(self.value(row, "material"))
            if not material:
                continue

            current_status = self.current_rfq_status(row)
            should_skip_status = (
                (SKIP_SUCCESS_ROWS and current_status == "SUCCESS")
                or (SKIP_EXISTING_RFQ_ROWS and current_status == "ALREADY_EXISTS")
            )
            if should_skip_status:
                print(
                    f"⏭️ Excel行{row} Material={material} "
                    f"RFQ Status={current_status}，跳过"
                )
                continue

            try:
                vendors = [
                    normalize_identifier(self.value(row, f"vendor{i}"))
                    for i in range(1, 6)
                ]
                cost_breakdown = [
                    parse_bool(self.value(row, f"vendor{i}_cb"), default=False)
                    for i in range(1, 6)
                ]
                emails: list[list[str]] = []
                for vendor_index in range(1, 6):
                    vendor_emails = [
                        safe_text(
                            self.value(
                                row,
                                f"vendor{vendor_index}_email{email_index}",
                            )
                        )
                        for email_index in range(1, 4)
                    ]
                    for email in vendor_emails:
                        if email and not valid_email(email):
                            raise ValueError(f"Email格式错误：{email}")
                    emails.append(vendor_emails)

                # Production mapping: Supplier Email is Excel E.
                supplier_email_from_e = safe_text(
                    self.worksheet.cell(row, SUPPLIER_EMAIL_EXCEL_COL).value
                )
                if supplier_email_from_e:
                    if not valid_email(supplier_email_from_e):
                        raise ValueError(
                            f"F列Supplier Email格式错误：{supplier_email_from_e}"
                        )
                    emails[0][0] = supplier_email_from_e

                rfq_comment = safe_text(self.value(row, "rfq_comment"))
                if len(rfq_comment) > 200:
                    raise ValueError("RFQ Comment超过200字符")

                attach_file = parse_bool(self.value(row, "attach_file"), default=False)
                if attach_file:
                    raise ValueError(
                        "当前录制代码没有附件上传路径，Attach File只能填写No/False"
                    )

                raw_ppap_date = self.value(row, "ppap_date")
                raw_rfq_due_date = self.worksheet.cell(
                    row,
                    RFQ_DUE_DATE_EXCEL_COL,
                ).value

                normalized_ppap_date = parse_date(
                    raw_ppap_date,
                    "PPAP Target Date",
                    required=False,
                )
                normalized_rfq_due_date = parse_date(
                    raw_rfq_due_date,
                    "Quotation Due Date (Excel F列)",
                    required=True,
                )

                if raw_ppap_date not in (None, ""):
                    raw_ppap_text = safe_text(raw_ppap_date)
                    if raw_ppap_text and raw_ppap_text != normalized_ppap_date:
                        print(
                            f"📅 Excel行{row} PPAP Date自动转换："
                            f"{raw_ppap_text} -> {normalized_ppap_date}"
                        )

                raw_due_text = safe_text(raw_rfq_due_date)
                if raw_due_text and raw_due_text != normalized_rfq_due_date:
                    print(
                        f"📅 Excel行{row} RFQ Due Date自动转换："
                        f"{raw_due_text} -> {normalized_rfq_due_date}"
                    )

                task = MaterialTask(
                    excel_row=row,
                    material=material,
                    plant=normalize_identifier(self.value(row, "plant")).upper(),
                    project=normalize_identifier(self.value(row, "project")),
                    ppap_date=normalized_ppap_date,
                    tech_user=safe_text(self.value(row, "tech_user")),
                    qty_12mr=format_quantity(
                        self.value(row, "qty_12mr"),
                        DEFAULT_12MR_QTY,
                    ),
                    rfq_qty_p=format_quantity(
                        self.value(row, "rfq_qty_p"),
                        DEFAULT_RFQ_QTY_PROTOTYPE,
                    ),
                    rfq_qty_s=format_quantity(
                        self.value(row, "rfq_qty_s"),
                        DEFAULT_RFQ_QTY_SERIAL,
                    ),
                    afm_request=parse_bool(
                        self.value(row, "afm_request"),
                        default=False,
                    ),
                    vendors=vendors,
                    cost_breakdown=cost_breakdown,
                    quotation_due_date=normalized_rfq_due_date,
                    emails=emails,
                    allow_without_preferred=parse_bool(
                        self.value(row, "allow_without_preferred"),
                        default=False,
                    ),
                    attach_file=attach_file,
                    rfq_comment=rfq_comment,
                    batch_group=safe_text(self.value(row, "batch_group")),
                )

                if not task.plant:
                    raise ValueError("Plant不能为空")
                if not task.project:
                    raise ValueError("MPP Project No.不能为空")
                if not task.vendors[0]:
                    raise ValueError("Supplier Parma不能为空")
                if not task.emails[0][0]:
                    raise ValueError("Supplier Email不能为空")

                tasks.append(task)

            except Exception as exc:
                self.write_status(
                    [row],
                    buyer_status="NOT_STARTED",
                    rfq_status="VALIDATION_ERROR",
                    error_stage="EXCEL_VALIDATION",
                    error_message=str(exc),
                )
                print(f"❌ Excel行{row} Material={material} 数据校验失败：{exc}")

        self.save()
        return tasks


# =============================================================================
# 6. Grouping logic
# =============================================================================


def parma_group_key(task: MaterialTask) -> tuple[str, str, str]:
    """True RFQ grouping key for v32.

    One RFQ group = same Plant + same Project + same Supplier Parma.
    Email / Due Date / other header values no longer split the group.
    """
    return (
        task.plant,
        task.project,
        task.vendors[0],
    )


def _group_shared_value_warnings(tasks: list[MaterialTask], key: str) -> None:
    if len(tasks) <= 1:
        return

    comparisons = {
        "Quotation Due Date": [task.quotation_due_date for task in tasks],
        "Supplier Email": [task.emails[0][0] for task in tasks],
        "Allow Without Preferred Supplier": [
            str(task.allow_without_preferred) for task in tasks
        ],
        "Attach File": [str(task.attach_file) for task in tasks],
        "RFQ Comment": [task.rfq_comment for task in tasks],
    }

    for field_name, values in comparisons.items():
        unique = list(dict.fromkeys(values))
        if len(unique) > 1:
            print(
                f"   ⚠️ Group={key} 内 {field_name} 不一致：{unique}；"
                f"本RFQ统一使用Excel首行值={values[0]!r}"
            )


def validate_group_consistency(tasks: list[MaterialTask], key: str) -> None:
    if not tasks:
        return

    expected = parma_group_key(tasks[0])
    for task in tasks[1:]:
        if parma_group_key(task) != expected:
            raise ValueError(
                f"RFQ Group={key!r}内部Plant/Project/Parma不一致，"
                "不能创建在同一个RFQ。"
            )

    _group_shared_value_warnings(tasks, key)


def build_groups(tasks: list[MaterialTask]) -> list[TaskGroup]:
    """Build actual Parma RFQ groups.

    GROUP_RFQ_BY_PARMA=true:
      same Plant + same Project + same Supplier Parma -> ONE RFQ group.
    """
    if GROUP_RFQ_BY_PARMA:
        buckets: dict[tuple[str, str, str], list[MaterialTask]] = defaultdict(list)
        order: list[tuple[str, str, str]] = []

        for task in tasks:
            key = parma_group_key(task)
            if key not in buckets:
                order.append(key)
            buckets[key].append(task)

        groups: list[TaskGroup] = []

        for group_index, bucket_key in enumerate(order, start=1):
            group_tasks = buckets[bucket_key]
            plant, project, parma = bucket_key

            validate_group_consistency(
                group_tasks,
                f"PARMA-{parma}-{plant}-PRJ{project}",
            )

            for part_number, part in enumerate(
                chunked(group_tasks, MAX_MATERIALS_PER_GROUP),
                start=1,
            ):
                suffix = (
                    f"-P{part_number}"
                    if len(group_tasks) > MAX_MATERIALS_PER_GROUP
                    else ""
                )
                group_key = (
                    f"PARMA-{parma}"
                    f"-{plant}"
                    f"-PRJ{project}"
                    f"-G{group_index:03d}"
                    f"{suffix}"
                )
                groups.append(TaskGroup(key=group_key, tasks=list(part)))

        return groups

    # Legacy modes only when Parma grouping is disabled.
    if PROCESS_MODE == "ROW":
        return [
            TaskGroup(
                key=f"{task.batch_group or 'ROW'}-E{task.excel_row}-M{task.material}",
                tasks=[task],
            )
            for task in tasks
        ]

    automatic: dict[tuple[str, str, str], list[MaterialTask]] = defaultdict(list)
    for task in tasks:
        automatic[parma_group_key(task)].append(task)

    groups: list[TaskGroup] = []
    for auto_index, group_tasks in enumerate(automatic.values(), start=1):
        validate_group_consistency(
            group_tasks,
            f"AUTO-PARMA-{group_tasks[0].vendors[0]}-{auto_index:03d}",
        )
        for part_number, part in enumerate(
            chunked(group_tasks, MAX_MATERIALS_PER_GROUP),
            start=1,
        ):
            groups.append(
                TaskGroup(
                    key=(
                        f"AUTO-PARMA-{group_tasks[0].vendors[0]}"
                        f"-{auto_index:03d}-P{part_number}"
                    ),
                    tasks=list(part),
                )
            )
    return groups


# =============================================================================
# 7. SAP GUI helpers
# =============================================================================



def set_windows_clipboard_text(text_value: str) -> None:
    """Put Unicode text on the Windows clipboard with short lock retries."""
    try:
        import win32clipboard  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "GROUP RFQ需要Windows剪贴板支持，请确认pywin32已安装：pip install pywin32"
        ) from exc

    last_error: Optional[Exception] = None
    for _ in range(10):
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardText(
                    str(text_value),
                    win32clipboard.CF_UNICODETEXT,
                )
            finally:
                win32clipboard.CloseClipboard()
            return
        except Exception as exc:
            last_error = exc
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass
            time.sleep(0.15)

    raise RuntimeError(f"无法写入Windows剪贴板：{last_error}")


class SapRpaError(RuntimeError):
    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message


class SapSession:
    def __init__(self) -> None:
        try:
            import win32com.client  # type: ignore
        except ImportError as exc:  # pragma: no cover - Windows only
            raise RuntimeError(
                "缺少pywin32。请运行：pip install pywin32"
            ) from exc

        self._win32_client = win32com.client
        application = self._get_or_start_scripting_application()
        self.session, selected_meta = self._get_or_open_target_session(application)

        self.system_name = selected_meta.get("system", "")
        self.client = selected_meta.get("client", "")
        self.user = selected_meta.get("user", "")
        self.connection_index = selected_meta.get("connection_index", -1)
        self.session_index = selected_meta.get("session_index", -1)
        self.connection_description = selected_meta.get("connection_description", "")
        self.connection_target_verified = bool(selected_meta.get("target_verified", False))
        try:
            current_tcode = safe_text(self.session.Info.Transaction).upper()
        except Exception:
            current_tcode = ""
        # When the RPA attaches to an already-open ZMFM050072 result/Buyer
        # Receipt/RFQ screen, recover inside that transaction instead of issuing
        # /nZMFM050072 again.
        self._npl_transaction_started = current_tcode == TCODE_NPL
        # Tracks the Plant + MPP Project currently loaded in the NPL result list.
        # This is populated after this RPA executes the NPL query. It lets later
        # rows with the same query reuse the result list after exactly one Back.
        self._active_npl_query: Optional[tuple[str, str, str]] = None

        print(
            "🔐 已连接SAP环境 | "
            f"Target={SAP_TARGET_ENV}/{SAP_TARGET_CONNECTION_CODE} | "
            f"Entry={self.connection_description or '<unknown>'} | "
            f"System={self.system_name or '<unknown>'} | "
            f"Client={self.client or '<unknown>'} | "
            f"User={self.user or '<unknown>'} | "
            f"Connection={self.connection_index} | Session={self.session_index}"
        )

        self._validate_environment()
        self.session.FindById("wnd[0]").Maximize()

    @staticmethod
    def _candidate_saplogon_paths() -> list[Path]:
        paths: list[Path] = []
        if SAP_LOGON_EXE:
            paths.append(Path(os.path.expandvars(SAP_LOGON_EXE)).expanduser())

        which_path = shutil.which("saplogon.exe") or shutil.which("saplogon")
        if which_path:
            paths.append(Path(which_path))

        for env_name in ("ProgramFiles(x86)", "ProgramFiles", "SAPGUI_HOME"):
            base = os.getenv(env_name, "").strip()
            if not base:
                continue
            base_path = Path(base)
            if env_name == "SAPGUI_HOME":
                paths.append(base_path / "saplogon.exe")
            else:
                paths.append(base_path / "SAP" / "FrontEnd" / "SAPgui" / "saplogon.exe")

        # De-duplicate while preserving order.
        unique: list[Path] = []
        seen: set[str] = set()
        for path in paths:
            key = str(path).casefold()
            if key not in seen:
                unique.append(path)
                seen.add(key)
        return unique

    def _launch_sap_logon(self) -> None:
        candidates = self._candidate_saplogon_paths()
        for path in candidates:
            if not path.exists():
                continue
            print(f"🚀 正在启动SAP Logon：{path}")
            try:
                subprocess.Popen([str(path)], close_fds=True)
                return
            except Exception as exc:
                print(f"⚠️ 启动SAP Logon失败：{path} | {exc}")

        shown = "; ".join(str(path) for path in candidates) or "<none>"
        raise RuntimeError(
            "未找到或无法启动saplogon.exe。请在.env填写SAP_LOGON_EXE。"
            f"已检查：{shown}"
        )

    def _get_or_start_scripting_application(self):
        deadline = time.time() + SAP_LOGON_START_TIMEOUT_SEC
        launched = False
        last_error: Optional[Exception] = None

        while time.time() < deadline:
            try:
                sap_gui_auto = self._win32_client.GetObject("SAPGUI")
                return sap_gui_auto.GetScriptingEngine
            except Exception as exc:
                last_error = exc
                if not launched:
                    if not SAP_AUTO_LAUNCH:
                        raise RuntimeError(
                            "SAP GUI尚未打开，且SAP_AUTO_LAUNCH=false。"
                        ) from exc
                    self._launch_sap_logon()
                    launched = True
                time.sleep(1)

        raise RuntimeError(
            "SAP Logon已启动，但未能取得SAP GUI Scripting Engine。"
            "请确认客户端和服务器均启用SAP GUI Scripting。"
            f"最后错误：{last_error}"
        )

    @staticmethod
    def _read_com_text(obj: Any, *names: str) -> str:
        for name in names:
            try:
                value = safe_text(getattr(obj, name))
                if value:
                    return value
            except Exception:
                continue
        return ""

    @classmethod
    def _connection_description(cls, connection: Any) -> str:
        return cls._read_com_text(connection, "Description", "Name", "SystemName")

    @staticmethod
    def _description_matches_target(description: str) -> bool:
        actual = re.sub(r"\s+", " ", safe_text(description)).casefold()
        target = re.sub(r"\s+", " ", SAP_TARGET_CONNECTION_NAME).casefold()
        if target and actual == target:
            return True
        if target and target in actual:
            return True
        # The connection code in square brackets is the stable selector shown
        # in SAP Logon (QA=321, Production=949).
        return bool(re.search(rf"\[{re.escape(SAP_TARGET_CONNECTION_CODE)}\]", actual))

    @classmethod
    def _session_meta(
        cls,
        session: Any,
        connection_index: int,
        session_index: int,
        connection_description: str,
    ) -> dict[str, Any]:
        info = getattr(session, "Info", None)

        def read(name: str) -> str:
            try:
                return safe_text(getattr(info, name))
            except Exception:
                return ""

        return {
            "system": read("SystemName").upper(),
            "client": read("Client"),
            "user": read("User").upper(),
            "transaction": read("Transaction"),
            "connection_index": connection_index,
            "session_index": session_index,
            "connection_description": connection_description,
            "target_verified": cls._description_matches_target(connection_description),
        }

    def _collect_sessions(self, application) -> list[tuple[Any, dict[str, Any]]]:
        candidates: list[tuple[Any, dict[str, Any]]] = []
        try:
            connection_count = int(application.Children.Count)
        except Exception:
            return candidates

        for connection_index in range(connection_count):
            try:
                connection = application.Children(connection_index)
                description = self._connection_description(connection)
                session_count = int(connection.Children.Count)
            except Exception:
                continue

            for session_index in range(session_count):
                try:
                    session = connection.Children(session_index)
                    meta = self._session_meta(
                        session,
                        connection_index,
                        session_index,
                        description,
                    )
                    candidates.append((session, meta))
                except Exception:
                    continue
        return candidates

    @staticmethod
    def _print_sessions(candidates: list[tuple[Any, dict[str, Any]]]) -> None:
        if not candidates:
            print("📋 当前没有已登录的SAP会话")
            return
        print("📋 当前打开的SAP会话：")
        for _, meta in candidates:
            print(
                "   "
                f"[{meta['connection_index']}/{meta['session_index']}] "
                f"Entry={meta['connection_description'] or '<unknown>'} | "
                f"System={meta['system'] or '<unknown>'} | "
                f"Client={meta['client'] or '<unknown>'} | "
                f"User={meta['user'] or '<unknown>'} | "
                f"T-code={meta['transaction'] or '<none>'}"
            )

    def _open_target_connection(self, application):
        print(
            f"🚪 正在从SAP Logon打开：{SAP_TARGET_CONNECTION_NAME} "
            f"(环境={SAP_TARGET_ENV}, 编号={SAP_TARGET_CONNECTION_CODE})"
        )
        try:
            # OpenConnection uses the exact entry description from SAP Logon.
            connection = application.OpenConnection(SAP_TARGET_CONNECTION_NAME, True)
        except Exception as exc:
            raise RuntimeError(
                "无法从SAP Logon打开目标连接。请确认连接名称与SAP Logon中完全一致："
                f"{SAP_TARGET_CONNECTION_NAME!r}。原始错误：{exc}"
            ) from exc

        print(
            "⏳ SAP连接已打开；如出现登录/SSO窗口，请完成登录。"
            f"最长等待{SAP_LOGIN_TIMEOUT_SEC:.0f}秒。"
        )
        deadline = time.time() + SAP_LOGIN_TIMEOUT_SEC
        while time.time() < deadline:
            try:
                session_count = int(connection.Children.Count)
            except Exception:
                session_count = 0

            if session_count > 0:
                try:
                    session = connection.Children(0)
                    # A session object can exist before SSO/login completes.
                    # Wait until the main window is available and not busy.
                    session.FindById("wnd[0]")
                    if not bool(getattr(session, "Busy", False)):
                        return connection
                except Exception:
                    pass
            time.sleep(1)

        raise RuntimeError(
            "目标SAP连接已打开，但登录未在限定时间内完成。"
            "请完成登录后重新运行，或增大SAP_LOGIN_TIMEOUT_SEC。"
        )

    def _get_or_open_target_session(self, application):
        candidates = self._collect_sessions(application)
        self._print_sessions(candidates)

        def matches_identity(meta):
            return (
                meta.get("target_verified") and meta.get("user")
                and (not EXPECTED_SAP_SYSTEM or meta["system"] == EXPECTED_SAP_SYSTEM)
                and (not EXPECTED_SAP_CLIENT or meta["client"] == EXPECTED_SAP_CLIENT)
                and (not EXPECTED_SAP_USER or meta["user"] == EXPECTED_SAP_USER)
            )

        def ready(session):
            try:
                return not bool(session.Busy) and session.FindById("wnd[1]", False) is None
            except Exception:
                return False

        target_matches = [
            (session, meta)
            for session, meta in candidates
            if matches_identity(meta) and ready(session)
        ]

        if target_matches:
            if len(target_matches) > 1:
                print(
                    f"⚠️ 找到{len(target_matches)}个目标环境会话，"
                    "将使用列表中的第一个"
                )
            print("✅ 复用已打开的目标SAP会话")
            return target_matches[0]

        # Never mistake a mismatched/busy/login-pending target for an absent
        # connection. Opening it again can terminate the user's existing login.
        existing_targets = [meta for _, meta in candidates
                            if meta.get("target_verified") or (
                                EXPECTED_SAP_SYSTEM and meta.get("system") == EXPECTED_SAP_SYSTEM)]
        if existing_targets:
            actual = "; ".join(
                f"Entry={meta.get('connection_description') or '<unknown>'}, "
                f"System={meta.get('system') or '<unknown>'}, "
                f"Client={meta.get('client') or '<unknown>'}, "
                f"User={meta.get('user') or '<not signed in>'}"
                for meta in existing_targets
            )
            raise RuntimeError(
                "目标SAP连接已存在，但没有符合校验且空闲的已登录会话。"
                "为避免重复登录，未打开新连接。请完成已有登录、处理弹窗，"
                "并核对系统/Client/用户配置后重试；不要结束其他登录。"
                f"期望 System={EXPECTED_SAP_SYSTEM or '<optional>'}, "
                f"Client={EXPECTED_SAP_CLIENT or '<optional>'}。实际：{actual}"
            )

        # _collect_sessions deliberately tolerates COM errors. Recheck the
        # connection inventory before opening, including entries with no session.
        try:
            connection_count = int(application.Children.Count)
            for index in range(connection_count):
                connection = application.Children(index)
                description = self._connection_description(connection)
                if not description:
                    raise RuntimeError("SAP连接名称无法读取")
                if self._description_matches_target(description):
                    raise RuntimeError(
                        f"目标SAP连接 {description!r} 已存在，但会话尚未就绪。"
                        "请在已有窗口完成登录；为避免重复登录，未打开新连接。"
                    )
        except Exception as exc:
            raise RuntimeError(
                "无法确认目标SAP连接不存在，已停止以避免重复登录。" + str(exc)
            ) from exc

        # Only an absent target connection may be opened, once.
        self._open_target_connection(application)
        time.sleep(1)
        candidates = self._collect_sessions(application)
        self._print_sessions(candidates)
        target_matches = [
            (session, meta)
            for session, meta in candidates
            if matches_identity(meta) and ready(session)
        ]

        if not target_matches:
            raise RuntimeError(
                "SAP连接已打开，但没有识别到目标环境会话："
                f"{SAP_TARGET_CONNECTION_NAME!r}。"
                "请检查SAP Logon连接名称和登录状态。"
            )
        return target_matches[0]

    def _validate_environment(self) -> None:
        if not self.connection_target_verified:
            raise RuntimeError(
                "当前SAP会话不属于目标连接，RPA已停止："
                f"Target={SAP_TARGET_CONNECTION_NAME!r}, "
                f"Actual={self.connection_description!r}"
            )

        mismatches: list[str] = []
        if EXPECTED_SAP_SYSTEM and self.system_name != EXPECTED_SAP_SYSTEM:
            mismatches.append(
                f"System实际={self.system_name or '<unknown>'}, "
                f"期望={EXPECTED_SAP_SYSTEM}"
            )
        if EXPECTED_SAP_CLIENT and self.client != EXPECTED_SAP_CLIENT:
            mismatches.append(
                f"Client实际={self.client or '<unknown>'}, "
                f"期望={EXPECTED_SAP_CLIENT}"
            )
        if EXPECTED_SAP_USER and self.user != EXPECTED_SAP_USER:
            mismatches.append(
                f"User实际={self.user or '<unknown>'}, "
                f"期望={EXPECTED_SAP_USER}"
            )
        if mismatches:
            raise RuntimeError(
                "SAP环境校验失败，RPA已停止：" + "; ".join(mismatches)
            )

        if not DRY_RUN and SAP_TARGET_ENV == "PROD" and not ALLOW_PRODUCTION_WRITE:
            raise RuntimeError(
                "当前目标为生产环境[949]，但ALLOW_PRODUCTION_WRITE=false。"
                "如确需生产创建，请同时明确设置DRY_RUN=false和"
                "ALLOW_PRODUCTION_WRITE=true。"
            )

        # Exact SAP Logon entry/code is accepted as the primary environment
        # guard. Expected System/Client remain available as an additional guard.
        if SAP_ENVIRONMENT_GUARD and not DRY_RUN:
            print(
                "✅ SAP环境硬校验通过，允许执行创建操作 | "
                f"Target={SAP_TARGET_ENV}/{SAP_TARGET_CONNECTION_CODE}"
            )
        elif DRY_RUN:
            print("🧪 DRY_RUN模式：仅查询和匹配，不执行Buyer Receipt/RFQ创建")

    def find(self, control_id: str, required: bool = True):
        try:
            return self.session.FindById(control_id)
        except Exception:
            if required:
                raise SapRpaError("SAP_CONTROL", f"找不到SAP控件：{control_id}")
            return None

    def exists(self, control_id: str) -> bool:
        return self.find(control_id, required=False) is not None

    def wait_exists(self, control_id: str, timeout: float = SAP_WAIT_SEC):
        deadline = time.time() + timeout
        last_error: Optional[Exception] = None
        while time.time() < deadline:
            try:
                control = self.session.FindById(control_id)
                return control
            except Exception as exc:
                last_error = exc
            time.sleep(SAP_POLL_SEC)
        raise SapRpaError(
            "SAP_TIMEOUT",
            f"等待SAP控件超时：{control_id}; last={last_error}",
        )

    def wait_not_busy(self, timeout: float = SAP_WAIT_SEC) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if not bool(self.session.Busy):
                    return
            except Exception:
                return
            time.sleep(SAP_POLL_SEC)
        raise SapRpaError("SAP_TIMEOUT", "SAP会话长时间Busy")

    def set_text(self, control_id: str, value: str) -> None:
        control = self.wait_exists(control_id)
        control.Text = str(value)

    def press(self, control_id: str) -> None:
        self.wait_exists(control_id).Press()
        self.wait_not_busy()
        if SAP_STEP_PAUSE_SEC:
            time.sleep(SAP_STEP_PAUSE_SEC)

    def send_vkey(self, key: int, window_id: str = "wnd[0]") -> None:
        self.wait_exists(window_id).SendVKey(key)
        self.wait_not_busy()
        if SAP_STEP_PAUSE_SEC:
            time.sleep(SAP_STEP_PAUSE_SEC)

    def start_transaction(self, tcode: str) -> None:
        self.set_text(ID_COMMAND, f"/n{tcode}")
        self.send_vkey(0)

    def current_transaction(self) -> str:
        try:
            return safe_text(self.session.Info.Transaction).upper()
        except Exception:
            return ""

    def is_npl_selection_screen(self) -> bool:
        return (
            self.exists(ID_PLANT)
            and self.exists(ID_PROJECT)
            and self.exists(ID_EXECUTE)
        )

    def wait_for_npl_selection_screen(self, timeout: float) -> bool:
        """Wait for the Plant/Project screen without pressing another Back."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.exists("wnd[1]"):
                # The user's recording confirms Continue is wnd[1]/tbar[0]/btn[0].
                # Close a message display, then keep waiting for the underlying
                # ZMFM050072 screen to finish rendering.
                if not self.dismiss_message_display():
                    return False

            if self.is_npl_selection_screen():
                self._npl_transaction_started = True
                return True

            current_tcode = self.current_transaction()
            if current_tcode and current_tcode != TCODE_NPL:
                return False

            try:
                if bool(self.session.Busy):
                    time.sleep(NPL_BACK_POLL_SEC)
                    continue
            except Exception:
                pass

            time.sleep(NPL_BACK_POLL_SEC)
        return self.is_npl_selection_screen()

    def press_back_inside_npl_once(
        self,
        step: int,
        *,
        max_steps: Optional[int] = None,
        target_label: str = "Project选择界面",
    ) -> None:
        """Press exactly one Back and wait before considering another Back."""
        current_tcode = self.current_transaction()
        if current_tcode and current_tcode != TCODE_NPL:
            raise SapRpaError(
                "NPL_REUSE",
                "当前已不在ZMFM050072，严格复用模式不会自动重新运行事务码。"
                f"当前T-code={current_tcode}",
            )

        display_max = max_steps if max_steps is not None else NPL_MAX_BACK_STEPS
        print(
            f"   ↩️ ZMFM050072内部Back {step}/{display_max}；"
            f"等待{target_label}完整加载"
        )
        button = self.find("wnd[0]/tbar[0]/btn[3]", required=False)
        if button is not None:
            try:
                button.Press()
                self.wait_not_busy(SAP_LONG_WAIT_SEC)
            except Exception as exc:
                raise SapRpaError("NPL_REUSE", f"点击SAP Back失败：{exc}") from exc
        else:
            self.send_vkey(3)

    def _npl_result_grid_contains_tasks(
        self,
        tasks: Sequence[MaterialTask],
    ) -> Optional[Any]:
        """Return the current NPL result grid when it contains every target material.

        This deliberately does not require the Plant/Project selection controls. For
        same-project rows, the desired fast path is to stay on the already-filtered
        NPL result list after a single Back.
        """
        if self.current_transaction() != TCODE_NPL:
            return None
        if self.is_npl_selection_screen():
            return None

        try:
            title = safe_text(self.find("wnd[0]").Text).casefold()
        except Exception:
            title = ""
        # Never mistake the Buyer Receipt/RFQ screens for the NPL result list.
        if "buyer receipt" in title or "rfq" in title:
            return None

        grid = self.find(ID_GRID_CUSTOMER1, required=False)
        if grid is None or not self.column_exists(grid, COL_MATERIAL):
            return None

        expected = {task.material for task in tasks}
        if not expected:
            return None
        found: set[str] = set()
        for row in range(self.row_count(grid)):
            material = normalize_material(self.get_cell(grid, row, COL_MATERIAL))
            if material in expected:
                found.add(material)
        if expected.issubset(found):
            return grid
        return None

    def wait_for_same_project_npl_result(
        self,
        tasks: Sequence[MaterialTask],
        timeout: float,
    ) -> Optional[Any]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.exists("wnd[1]"):
                if not self.dismiss_message_display():
                    return None

            grid = self._npl_result_grid_contains_tasks(tasks)
            if grid is not None:
                return grid

            # One Back may land directly on the selection screen on some SAP
            # variants. Let the caller re-execute the same query rather than
            # sending an unnecessary second Back.
            if self.is_npl_selection_screen():
                return None

            current_tcode = self.current_transaction()
            if current_tcode and current_tcode != TCODE_NPL:
                return None

            try:
                if bool(self.session.Busy):
                    time.sleep(NPL_BACK_POLL_SEC)
                    continue
            except Exception:
                pass
            time.sleep(NPL_BACK_POLL_SEC)
        return self._npl_result_grid_contains_tasks(tasks)

    def set_material_multiple_selection(
        self,
        materials: Sequence[str],
    ) -> None:
        """Replace, never append to, the SAP Material multiple-selection list.

        This follows the user's recorded PROD sequence:
          Material multiple-selection
          -> Delete all selections (btn[16])
          -> Upload from Clipboard (btn[24])
          -> Enter/accept (btn[0])
          -> Transfer/confirm (btn[8])

        Only functional controls are retained. Recorded UI-only operations such
        as caretPosition, selectColumn, firstVisibleColumn and setFocus are not
        reproduced.
        """
        material_list = [normalize_material(m) for m in materials if normalize_material(m)]
        material_list = list(dict.fromkeys(material_list))
        if not material_list:
            raise SapRpaError(
                "NPL_MULTI_MATERIAL",
                "Parma Group没有可上传的Material",
            )
        self._replace_material_multiple_selection(material_list)

    def _replace_material_multiple_selection(self, materials: Sequence[str]) -> None:
        """Reset only query criteria, including hidden ranges/exclusions.

        An empty list clears previous multi-selection before a single-material
        or project query. No Buyer Receipt/RFQ or source data is deleted.
        """
        material_list = list(materials)

        if material_list:
            set_windows_clipboard_text("\r\n".join(material_list))

        print(
            "   🧹 清空上一组Material全部选择条件"
            + (f"，仅导入当前组{len(material_list)}颗料" if material_list
               else "（包括隐藏的多重选择/区间）")
        )

        self.press(ID_MATERIAL_MULTI)

        if not self.exists("wnd[1]") or not all(
            self.exists(control_id) for control_id in
            ("wnd[1]/tbar[0]/btn[24]", "wnd[1]/tbar[0]/btn[8]")
        ):
            raise SapRpaError(
                "NPL_MULTI_MATERIAL",
                "无法确认Material Multiple Selection弹窗；未清理旧条件，已停止",
            )

        # Emptying S_MATNR-LOW only removes the first visible criterion.
        # Clipboard upload can otherwise append to SAP's retained select-options.
        if not self.press_first_existing(["wnd[1]/tbar[0]/btn[16]"]):
            raise SapRpaError(
                "NPL_MATERIAL_RESET",
                "Material Multiple Selection无法清空全部旧条件 (btn[16])；禁止继续创建Buyer Receipt",
            )

        # Exact recorded control: Upload from Clipboard.
        if material_list and not self.press_first_existing(["wnd[1]/tbar[0]/btn[24]"]):
            raise SapRpaError(
                "NPL_MULTI_MATERIAL",
                "Material Multiple Selection无法执行Upload from Clipboard (btn[24])",
            )

        # Keep the two functional confirmation actions from the recording, but
        # only press them while the popup still exists.
        if material_list and self.exists("wnd[1]") and self.exists("wnd[1]/tbar[0]/btn[0]"):
            self.press("wnd[1]/tbar[0]/btn[0]")

        if self.exists("wnd[1]") and self.exists("wnd[1]/tbar[0]/btn[8]"):
            self.press("wnd[1]/tbar[0]/btn[8]")

        # Some SAP GUI patch levels close after btn[0], others after btn[8].
        deadline = time.time() + SAP_WAIT_SEC
        while time.time() < deadline:
            if not self.exists("wnd[1]"):
                print(
                    "   ✅ Material Multiple Selection已确认："
                    + (", ".join(material_list) or "<旧物料已清空>")
                )
                return
            time.sleep(SAP_POLL_SEC)

        raise SapRpaError(
            "NPL_MULTI_MATERIAL",
            "Material Multiple Selection确认后弹窗未关闭",
        )

    def _execute_npl_query(self, group: TaskGroup):
        # Invalidate old context before reset; a failed reset must never reuse it.
        self._active_npl_query = None
        self.set_text(ID_PLANT, group.plant)
        self.set_text(ID_MATERIAL, "")

        materials = [task.material for task in group.tasks]
        single_exact = (
            NPL_EXACT_MATERIAL_QUERY
            and len(materials) == 1
        )
        multi_exact = (
            NPL_MULTI_MATERIAL_QUERY
            and len(materials) > 1
        )

        if multi_exact:
            self.set_material_multiple_selection(materials)
        else:
            # Multi -> single transitions also retain hidden select-options.
            self._replace_material_multiple_selection([])
            self.set_text(ID_MATERIAL, "")
            high_id = "wnd[0]/usr/ctxtS_MATNR-HIGH"
            if self.exists(high_id):
                self.set_text(high_id, "")
            if single_exact:
                self.set_text(ID_MATERIAL, materials[0])

        self.set_text(ID_PROJECT, group.project)

        if single_exact:
            print(
                f"   🔎 NPL单料精确查询：Plant={group.plant} | "
                f"Project={group.project} | Material={materials[0]}"
            )
            query_signature = materials[0]
        elif multi_exact:
            print(
                f"   🔎 NPL Parma Group精确查询：Plant={group.plant} | "
                f"Project={group.project} | Parma={group.vendors[0]} | "
                f"Materials={len(materials)}"
            )
            query_signature = "MULTI:" + ",".join(materials)
        else:
            print(
                f"   🔎 NPL项目查询：Plant={group.plant} | "
                f"Project={group.project} | Material=<blank>"
            )
            query_signature = ""

        self.press(ID_EXECUTE)
        grid = self.wait_grid_columns(
            ID_GRID_CUSTOMER1,
            [COL_MATERIAL],
            timeout=SAP_LONG_WAIT_SEC,
        )
        if single_exact or multi_exact:
            expected = {normalize_material(material) for material in materials}
            actual = {normalize_material(self.get_cell(grid, row, COL_MATERIAL))
                      for row in range(self.row_count(grid))}
            unexpected = sorted(actual - expected - {""})
            if unexpected:
                raise SapRpaError(
                    "NPL_MATERIAL_SCOPE",
                    "NPL结果混入非当前Group物料：" + ", ".join(unexpected)
                    + "；未创建Buyer Receipt，请检查SAP物料筛选条件",
                )
        self._active_npl_query = (
            group.plant,
            group.project,
            query_signature,
        )
        return grid

    def prepare_npl_grid_for_group(self, group: TaskGroup):
        """Prepare an exact NPL result grid for one Material or one Parma Group.

        v30 does not scan a whole Project result for grouped RFQs. For every
        group it returns to the ZMFM050072 selection screen and lets SAP filter
        the exact Material set server-side.
        """
        use_exact_server_filter = (
            (len(group.tasks) == 1 and NPL_EXACT_MATERIAL_QUERY)
            or (len(group.tasks) > 1 and NPL_MULTI_MATERIAL_QUERY)
        )

        if use_exact_server_filter:
            if not self._npl_transaction_started or self._active_npl_query is None:
                self.prepare_npl_selection_screen()
            elif not self.is_npl_selection_screen():
                print(
                    "   ♻️ 精确Material Group模式：返回ZMFM050072选择界面，"
                    "不扫描/复用旧Project结果Grid"
                )
                self.recover_npl_selection_screen()

            if len(group.tasks) == 1:
                print(
                    f"   ⚡ SAP后端精确搜索 Material={group.tasks[0].material}"
                )
            else:
                print(
                    f"   ⚡ Parma={group.vendors[0]} Group："
                    f"SAP后端精确搜索 {len(group.tasks)}颗Material"
                )
            return self._execute_npl_query(group)

        query_key = (group.plant, group.project)

        # Already on a usable result list (for example after an Existing-RFQ
        # Continue): do not press Back at all.
        if REUSE_SAME_PROJECT_NPL_RESULTS and self._active_npl_query[:2] == query_key:
            current_grid = self._npl_result_grid_contains_tasks(group.tasks)
            if current_grid is not None:
                print(
                    "   ⚡ 同Plant/Project：直接复用当前NPL结果列表，Back次数=0"
                )
                return current_grid

        # First row or a session whose query context is unknown: use the normal
        # selection-screen path once, then remember the query.
        if not self._npl_transaction_started or self._active_npl_query is None:
            self.prepare_npl_selection_screen()
            return self._execute_npl_query(group)

        same_query = self._active_npl_query[:2] == query_key
        if REUSE_SAME_PROJECT_NPL_RESULTS and same_query:
            if self.exists("wnd[1]"):
                if not self.dismiss_message_display():
                    raise SapRpaError(
                        "NPL_REUSE",
                        "同Project复用前存在SAP弹窗且无法关闭",
                    )

            # If a previous action already returned to the selection screen,
            # simply execute the same query. Never send another Back.
            if self.is_npl_selection_screen():
                print(
                    "   ⚡ 同Plant/Project：当前已在选择界面，直接Execute，不再Back"
                )
                return self._execute_npl_query(group)

            print(
                "   ♻️ 同Plant/Project：仅Back一次到已筛选的NPL结果列表，"
                "不退回初始搜索界面"
            )
            for step in range(1, SAME_PROJECT_MAX_BACK_STEPS + 1):
                self.press_back_inside_npl_once(
                    step,
                    max_steps=SAME_PROJECT_MAX_BACK_STEPS,
                    target_label="同Project NPL结果列表",
                )
                grid = self.wait_for_same_project_npl_result(
                    group.tasks,
                    SAME_PROJECT_RESULT_WAIT_SEC,
                )
                if grid is not None:
                    print(
                        f"   ✅ 已回到同Project NPL结果列表（Back次数={step}），"
                        "直接处理下一物料"
                    )
                    return grid
                if self.is_npl_selection_screen():
                    print(
                        f"   ℹ️ Back {step}次后已到Plant/Project选择界面；"
                        "直接Execute同一Project，不再继续Back"
                    )
                    return self._execute_npl_query(group)

            raise SapRpaError(
                "NPL_REUSE",
                "同Plant/Project快速复用失败：按配置最多只允许"
                f"{SAME_PROJECT_MAX_BACK_STEPS}次Back；为避免退过头，不会再按第二次Back。",
            )

        # Plant/Project changed: only then return to the selection screen and
        # execute a new query.
        print(
            "   🔄 Plant/Project发生变化：返回选择界面并执行新的NPL查询 "
            f"| {self._active_npl_query[:2]} -> {query_key}"
        )
        self.prepare_npl_selection_screen()
        return self._execute_npl_query(group)

    def recover_npl_selection_screen(self) -> None:
        """
        Return to the Plant / MPP Project selection screen while staying inside
        ZMFM050072. Unlike v9, this method waits after every single Back so it
        cannot overshoot the selection screen and fall out to SAP Easy Access.
        """
        if self.is_npl_selection_screen():
            self._npl_transaction_started = True
            return

        if self.exists("wnd[1]"):
            if not self.dismiss_message_display():
                raise SapRpaError(
                    "NPL_REUSE",
                    "存在SAP弹窗且无法点击Continue，不能安全返回Project选择界面",
                )

        current_tcode = self.current_transaction()
        if current_tcode and current_tcode != TCODE_NPL:
            raise SapRpaError(
                "NPL_REUSE",
                "当前SAP会话已经离开ZMFM050072。严格复用模式不会执行/nZMFM050072。"
                f"当前T-code={current_tcode}",
            )

        print("   ♻️ 保持在ZMFM050072内，返回Plant / MPP Project选择界面")
        for step in range(1, NPL_MAX_BACK_STEPS + 1):
            if self.wait_for_npl_selection_screen(timeout=0.5):
                print(f"   ✅ 已停留在ZMFM050072 Project选择界面（Back次数={step - 1}）")
                return

            self.press_back_inside_npl_once(step)

            # Critical fix: wait long enough after ONE Back. v9 waited only about
            # 0.4 second and could send another Back before the selection screen
            # appeared, which caused it to overshoot to SAP Easy Access.
            if self.wait_for_npl_selection_screen(NPL_BACK_SCREEN_WAIT_SEC):
                print(f"   ✅ 已停留在ZMFM050072 Project选择界面（Back次数={step}）")
                return

            current_tcode = self.current_transaction()
            if current_tcode and current_tcode != TCODE_NPL:
                raise SapRpaError(
                    "NPL_REUSE",
                    "Back后已离开ZMFM050072；为避免慢速重启，程序已停止。"
                    f"当前T-code={current_tcode}",
                )

        raise SapRpaError(
            "NPL_REUSE",
            f"在ZMFM050072内执行{NPL_MAX_BACK_STEPS}次Back后仍未找到"
            "Plant / MPP Project选择界面。程序不会重新运行事务码。",
        )

    def prepare_npl_selection_screen(self) -> None:
        """Open ZMFM050072 once; all later rows strictly reuse it."""
        if self.is_npl_selection_screen():
            self._npl_transaction_started = True
            return

        current_tcode = self.current_transaction()

        # The first material is allowed to enter the transaction once. If SAP is
        # already somewhere inside ZMFM050072, recover from there without /n.
        if not self._npl_transaction_started:
            if current_tcode == TCODE_NPL:
                self._npl_transaction_started = True
                self.recover_npl_selection_screen()
                return

            self.start_transaction(TCODE_NPL)
            self.wait_exists(ID_PLANT, timeout=SAP_LONG_WAIT_SEC)
            self._npl_transaction_started = True
            print("   🚪 首个处理单元：已进入ZMFM050072选择界面")
            return

        if not REUSE_NPL_TRANSACTION:
            self.start_transaction(TCODE_NPL)
            self.wait_exists(ID_PLANT, timeout=SAP_LONG_WAIT_SEC)
            print("   🚪 REUSE_NPL_TRANSACTION=false：重新进入ZMFM050072")
            return

        try:
            self.recover_npl_selection_screen()
            return
        except SapRpaError:
            if NPL_STRICT_REUSE or not NPL_FALLBACK_RESTART:
                raise

        # Non-strict legacy fallback only. The supplied v10 .env disables this.
        print("   ⚠️ 非严格模式：无法恢复选择界面，重新进入ZMFM050072")
        self.start_transaction(TCODE_NPL)
        self.wait_exists(ID_PLANT, timeout=SAP_LONG_WAIT_SEC)
        self._npl_transaction_started = True

    def status_bar(self) -> tuple[str, str]:
        bar = self.find("wnd[0]/sbar", required=False)
        if bar is None:
            return "", ""
        try:
            message_type = safe_text(bar.MessageType).upper()
        except Exception:
            message_type = ""
        try:
            text = safe_text(bar.Text)
        except Exception:
            text = ""
        return message_type, text

    def raise_on_status_error(self, stage: str) -> None:
        message_type, text = self.status_bar()
        if message_type in {"E", "A"}:
            raise SapRpaError(stage, text or "SAP状态栏返回错误")

    def grid(self, control_id: str, timeout: float = SAP_WAIT_SEC):
        grid = self.wait_exists(control_id, timeout=timeout)
        self.wait_not_busy()
        return grid

    @staticmethod
    def row_count(grid) -> int:
        try:
            return int(grid.RowCount)
        except Exception:
            return 0

    @staticmethod
    def get_cell(grid, row: int, column: str) -> str:
        try:
            return safe_text(grid.GetCellValue(row, column))
        except Exception:
            return ""

    @staticmethod
    def column_exists(grid, column: str) -> bool:
        """Check a grid column without stringifying SAP COM collections."""
        column_upper = safe_text(column).upper()
        if not column_upper:
            return False

        try:
            order = grid.ColumnOrder
        except Exception:
            order = None

        # Only stringify plain Python values. Never call str() on a COM
        # ColumnOrder collection because that can invoke its default member.
        if isinstance(order, str):
            if column_upper in order.upper():
                return True
        elif isinstance(order, (list, tuple)):
            for item in order:
                if safe_text(item).upper() == column_upper:
                    return True

        # The most reliable check on SAP Grid controls is a direct cell read.
        if SapSession.row_count(grid) > 0:
            try:
                grid.GetCellValue(0, column)
                return True
            except Exception:
                return False
        return False

    def wait_grid_columns(
        self,
        control_id: str,
        columns: Sequence[str],
        timeout: float = SAP_LONG_WAIT_SEC,
    ):
        deadline = time.time() + timeout
        while time.time() < deadline:
            grid = self.find(control_id, required=False)
            if grid is not None and all(self.column_exists(grid, c) for c in columns):
                return grid
            if self.exists("wnd[1]"):
                popup_text = self.window_text("wnd[1]")
                if popup_text:
                    raise SapRpaError("SAP_POPUP", popup_text)
            time.sleep(SAP_POLL_SEC)
        message_type, status_text = self.status_bar()
        raise SapRpaError(
            "SAP_TIMEOUT",
            f"等待Grid列超时：{control_id}, columns={list(columns)}, "
            f"status={message_type}:{status_text}",
        )

    @staticmethod
    def select_rows(grid, rows: Sequence[int]) -> None:
        """Select rows robustly; use native SelectAll for a true exact group."""
        normalized_rows = sorted({int(row) for row in rows})
        if not normalized_rows:
            raise SapRpaError("SAP_SELECTION", "没有可选择的SAP行")

        row_count = SapSession.row_count(grid)
        all_rows = list(range(row_count))

        if (
            len(normalized_rows) > 1
            and row_count == len(normalized_rows)
            and normalized_rows == all_rows
        ):
            for method_name in ("SelectAll", "selectAll"):
                try:
                    getattr(grid, method_name)()
                    print(
                        f"   ✅ SAP Grid使用SelectAll选择整个Group："
                        f"{len(normalized_rows)}行"
                    )
                    return
                except Exception:
                    continue

        row_spec = ",".join(str(row) for row in normalized_rows)

        for clear_name in ("ClearSelection", "clearSelection"):
            try:
                getattr(grid, clear_name)()
                break
            except Exception:
                continue

        errors = []
        for attr_name in ("selectedRows", "SelectedRows"):
            try:
                setattr(grid, attr_name, row_spec)
                return
            except Exception as exc:
                errors.append(f"{attr_name}: {exc}")

        raise SapRpaError(
            "SAP_SELECTION",
            f"无法选择SAP行 {row_spec}。原始错误：" + " | ".join(errors),
        )


    @staticmethod
    def modify_cell(grid, row: int, column: str, value: Any) -> None:
        grid.ModifyCell(row, column, str(value))
        try:
            grid.CurrentCellColumn = column
        except Exception:
            pass
        try:
            grid.TriggerModified()
        except Exception:
            pass

    @staticmethod
    def modify_checkbox(grid, row: int, column: str, value: bool) -> None:
        grid.ModifyCheckBox(row, column, bool(value))
        try:
            grid.CurrentCellColumn = column
        except Exception:
            pass
        try:
            grid.TriggerModified()
        except Exception:
            pass

    def map_material_rows(
        self,
        grid,
        expected_tasks: Sequence[MaterialTask],
        *,
        plant_column: Optional[str] = None,
        project_column: Optional[str] = None,
    ) -> tuple[dict[str, list[int]], dict[int, dict[str, str]]]:
        expected_materials = {task.material for task in expected_tasks}
        mapping: dict[str, list[int]] = defaultdict(list)
        debug_rows: dict[int, dict[str, str]] = {}

        for row in range(self.row_count(grid)):
            material = normalize_material(self.get_cell(grid, row, COL_MATERIAL))
            if not material:
                continue

            plant = (
                normalize_identifier(self.get_cell(grid, row, plant_column)).upper()
                if plant_column
                else ""
            )
            project = (
                normalize_identifier(self.get_cell(grid, row, project_column))
                if project_column
                else ""
            )

            if material in expected_materials:
                mapping[material].append(row)
                debug_rows[row] = {
                    "material": material,
                    "plant": plant,
                    "project": project,
                }

        return mapping, debug_rows

    def _window_controls(self, window_id: str = "wnd[1]") -> list[Any]:
        window = self.find(window_id, required=False)
        if window is None:
            return []

        controls: list[Any] = []

        def walk(control, depth: int = 0) -> None:
            if depth > 8 or len(controls) > 1000:
                return
            controls.append(control)
            try:
                count = int(control.Children.Count)
            except Exception:
                return
            for index in range(min(count, 200)):
                try:
                    walk(control.Children(index), depth + 1)
                except Exception:
                    continue

        walk(window)
        return controls

    def window_text(self, window_id: str = "wnd[1]") -> str:
        texts: list[str] = []
        for control in self._window_controls(window_id):
            for attr in ("Text", "Tooltip", "DefaultTooltip", "Name"):
                try:
                    value = safe_text(getattr(control, attr))
                    if value:
                        texts.append(value)
                except Exception:
                    pass
        return " | ".join(dict.fromkeys(texts))

    @staticmethod
    def _grid_column_keys(grid) -> list[str]:
        """Best-effort extraction of SAP Grid technical column names.

        This implementation deliberately never calls ``str(ColumnOrder)``.
        SAP GUI 8/patch-level dependent COM collections can throw sapfewse 618
        when their default member is invoked with the wrong index type.
        """
        output: list[str] = []

        try:
            order = grid.ColumnOrder
        except Exception:
            order = None

        if isinstance(order, str):
            output.extend(re.findall(r"[A-Za-z0-9_]+", order))
        elif isinstance(order, (list, tuple)):
            for value in order:
                key = safe_text(value)
                if key:
                    output.append(key)
        elif order is not None:
            # Try safe COM collection accessors with both zero- and one-based
            # indexes. Every call is isolated; failures are ignored.
            try:
                count = int(order.Count)
            except Exception:
                count = 0

            for index in range(count):
                candidates = (index, index + 1)
                value = ""
                for candidate_index in candidates:
                    for accessor_name in ("Item", "ElementAt"):
                        try:
                            accessor = getattr(order, accessor_name)
                            candidate = safe_text(accessor(candidate_index))
                            if candidate:
                                value = candidate
                                break
                        except Exception:
                            continue
                    if value:
                        break
                    try:
                        candidate = safe_text(order(candidate_index))
                        if candidate:
                            value = candidate
                            break
                    except Exception:
                        pass
                if value:
                    output.append(value)

        # Message Display grids vary by SAP patch. Probe likely technical names
        # directly through GetCellValue rather than relying on ColumnOrder.
        common_candidates = [
            "STATUS", "ICON", "MSGTY", "TYPE",
            "ROW", "ROWNO", "ROW_NO", "ROWNUM", "ROWNUMBER", "LINE",
            "VALUE", "VAL", "FIELDVALUE", "FIELD_VALUE", "FLDVAL",
            "COLUMN", "COLUMNNAME", "COLUMN_NAME", "COLNAME", "FIELD", "FIELDNAME",
            "MESSAGE", "MSGTEXT", "MESSAGE_TEXT", "MSGTX", "MSGTXT", "TEXT", "MSG",
            "ID", "NUMBER",
        ]
        if SapSession.row_count(grid) > 0:
            for candidate in common_candidates:
                try:
                    grid.GetCellValue(0, candidate)
                    output.append(candidate)
                except Exception:
                    continue

        normalized: list[str] = []
        seen: set[str] = set()
        for value in output:
            key = safe_text(value)
            if not key:
                continue
            upper = key.upper()
            if upper in seen:
                continue
            seen.add(upper)
            normalized.append(key)
        return normalized

    def popup_grid_rows(self, window_id: str = "wnd[1]") -> list[dict[str, str]]:
        """Read popup grid rows without letting COM metadata errors escape."""
        rows: list[dict[str, str]] = []

        try:
            controls = self._window_controls(window_id)
        except Exception:
            controls = []

        for control in controls:
            try:
                row_count = int(control.RowCount)
            except Exception:
                continue
            if row_count <= 0:
                continue

            try:
                columns = self._grid_column_keys(control)
            except Exception:
                columns = []

            # Even when ColumnOrder cannot be enumerated, probe the known
            # Message Display fields directly.
            if not columns:
                columns = [
                    "STATUS", "ICON", "ROWNO", "ROW_NO", "ROWNUM",
                    "VALUE", "FIELDVALUE", "COLUMN", "COLUMNNAME", "COLNAME",
                    "MESSAGE", "MSGTEXT", "MSGTX", "MSGTXT", "TEXT",
                ]

            for row_index in range(row_count):
                values: dict[str, str] = {}
                for column in columns:
                    try:
                        value = safe_text(control.GetCellValue(row_index, column))
                    except Exception:
                        continue
                    if value:
                        values[safe_text(column) or str(column)] = value
                if values:
                    values["__ROW_INDEX__"] = str(row_index)
                    rows.append(values)

        return rows

    def popup_message_text(self, window_id: str = "wnd[1]") -> str:
        """Return popup text best-effort; never raise a COM parsing exception."""
        parts: list[str] = []
        try:
            text = self.window_text(window_id)
            if text:
                parts.append(text)
        except Exception:
            pass

        try:
            popup_rows = self.popup_grid_rows(window_id)
        except Exception:
            popup_rows = []

        for row in popup_rows:
            row_text = " | ".join(
                value for key, value in row.items() if key != "__ROW_INDEX__" and value
            )
            if row_text:
                parts.append(row_text)

        # Window title is often available even when the ALV message grid cannot
        # be introspected.
        try:
            title = safe_text(self.find(window_id, required=False).Text)
            if title:
                parts.append(title)
        except Exception:
            pass

        return " | ".join(dict.fromkeys(part for part in parts if part))

    def press_first_existing(self, control_ids: Sequence[str]) -> Optional[str]:
        for control_id in control_ids:
            control = self.find(control_id, required=False)
            if control is None:
                continue
            try:
                control.Press()
                self.wait_not_busy()
                if SAP_STEP_PAUSE_SEC:
                    time.sleep(SAP_STEP_PAUSE_SEC)
                return control_id
            except Exception:
                continue
        return None

    def handle_simple_confirmation(self, yes: bool = True) -> bool:
        if not self.exists("wnd[1]"):
            return False

        candidates = (
            [
                "wnd[1]/usr/btnBUTTON_1",
                "wnd[1]/tbar[0]/btn[0]",
                "wnd[1]/usr/btnSPOP-OPTION1",
            ]
            if yes
            else [
                "wnd[1]/usr/btnBUTTON_2",
                "wnd[1]/tbar[0]/btn[12]",
                "wnd[1]/usr/btnSPOP-OPTION2",
            ]
        )
        return self.press_first_existing(candidates) is not None

    def _buyer_save_confirmation_is_open(self) -> bool:
        """Return True only while the Save Yes/No question is still open."""
        if not self.exists("wnd[1]"):
            return False

        has_yes = self.exists("wnd[1]/usr/btnBUTTON_1")
        has_no = self.exists("wnd[1]/usr/btnBUTTON_2")
        if not (has_yes and has_no):
            return False

        # Do not traverse the whole popup control tree before clicking. In this
        # SAP GUI patch, that can refresh/invalidate a cached button COM object.
        try:
            title = safe_text(self.find("wnd[1]").Text).casefold()
        except Exception:
            title = ""

        # The button pair is the primary signal. Title/text checks merely avoid
        # confusing an unrelated Yes/No popup with the Buyer Receipt Save dialog.
        if "save" in title or "buyer receipt" in title:
            return True

        try:
            question = self.find("wnd[1]/usr/lbl[1,2]", required=False)
            question_text = safe_text(getattr(question, "Text", "")).casefold() if question else ""
        except Exception:
            question_text = ""
        return "save" in question_text or "do you want to save" in question_text

    def _direct_press_buyer_save_yes(self) -> str:
        """Press Save->Yes exactly like the user's working VBS/third method.

        Always re-fetch the button and call Press() directly. Do not use
        SetFocus/SendVKey here because the user's QA GUI proved the fresh
        direct Press() path is the reliable one.
        """
        yes_id = "wnd[1]/usr/btnBUTTON_1"
        self.session.FindById(yes_id).Press()
        return f"{yes_id}.Press()"

    def wait_and_confirm_buyer_receipt_save(self) -> bool:
        """Wait for Buyer Receipt Save outcome.

        PROD has two valid branches after pressing Save:
        1) normal Save Yes/No confirmation -> click BUTTON_1 (Yes);
        2) business Message Display appears immediately, with Continue but no
           Save Yes/No question. In that case do NOT wait for timeout. Surface
           BUYER_RECEIPT_SAVE_POPUP immediately so process_group can write the
           business error to Excel and run Continue -> Back -> Back recovery.
        """
        deadline = time.time() + BUYER_SAVE_CONFIRM_TIMEOUT_SEC
        last_popup_text = ""

        while time.time() < deadline:
            # Normal path: explicit Save Yes/No question.
            if self._buyer_save_confirmation_is_open():
                break

            if self.exists("wnd[1]"):
                has_continue = self.exists("wnd[1]/tbar[0]/btn[0]")
                has_yes = self.exists("wnd[1]/usr/btnBUTTON_1")
                has_no = self.exists("wnd[1]/usr/btnBUTTON_2")

                # Critical PROD fix: some Buyer Receipt validation errors bypass
                # the Save confirmation completely and open Message Display
                # immediately. The previous version kept waiting 20 seconds for
                # Yes/No and finally raised BUYER_RECEIPT_SAVE_CONFIRM.
                if has_continue and not (has_yes and has_no):
                    popup_message = extract_buyer_receipt_popup_business_message(self)
                    print(
                        "   ⚠️ Save后直接出现Message Display，"
                        "跳过Yes/No等待并进入业务错误恢复："
                        + safe_text(popup_message)[:500]
                    )
                    raise SapRpaError(
                        "BUYER_RECEIPT_SAVE_POPUP",
                        popup_message,
                    )

                try:
                    last_popup_text = self.window_text("wnd[1]")
                except Exception:
                    last_popup_text = ""

            time.sleep(SAP_POLL_SEC)
        else:
            if not REQUIRE_BUYER_SAVE_CONFIRMATION:
                print("   ⚠️ 未检测到Buyer Receipt保存确认窗口；配置允许继续")
                return False
            raise SapRpaError(
                "BUYER_RECEIPT_SAVE_CONFIRM",
                "点击Save后未在限定时间内识别到Buyer Receipt保存确认窗口。"
                f"最后弹窗内容：{last_popup_text[:1000] or '<无>'}",
            )

        last_method = ""
        for attempt in range(1, BUYER_SAVE_CLICK_RETRIES + 1):
            if not self._buyer_save_confirmation_is_open():
                print(
                    "   ✅ Buyer Receipt保存确认窗口已关闭 "
                    f"| 点击方式={last_method or '<已自动关闭>'}"
                )
                return True

            try:
                last_method = self._direct_press_buyer_save_yes()
            except Exception as exc:
                if attempt >= BUYER_SAVE_CLICK_RETRIES:
                    raise SapRpaError(
                        "BUYER_RECEIPT_SAVE_CONFIRM",
                        f"无法点击Buyer Receipt保存确认Yes：{exc}",
                    ) from exc
                time.sleep(BUYER_SAVE_CLICK_RETRY_SEC)
                continue

            print(
                f"   🖱️ Buyer Receipt保存确认：点击Yes "
                f"({attempt}/{BUYER_SAVE_CLICK_RETRIES}) | 方式={last_method}"
            )

            close_deadline = time.time() + max(1.0, BUYER_SAVE_CLICK_RETRY_SEC)
            while time.time() < close_deadline:
                if not self._buyer_save_confirmation_is_open():
                    print(
                        "   ✅ 已点击Buyer Receipt保存确认：Yes "
                        f"| 方式={last_method}"
                    )
                    return True
                time.sleep(SAP_POLL_SEC)

            time.sleep(BUYER_SAVE_CLICK_RETRY_SEC)

        try:
            last_popup_text = self.window_text("wnd[1]")
        except Exception:
            last_popup_text = ""
        raise SapRpaError(
            "BUYER_RECEIPT_SAVE_CONFIRM",
            "已按直接Press方式重试保存确认，但Save窗口仍未关闭。"
            f"最后弹窗内容：{last_popup_text[:1000] or '<无法读取>'}",
        )

    def wait_popup_closed(self, timeout: float = SAP_WAIT_SEC) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.exists("wnd[1]"):
                return True
            time.sleep(SAP_POLL_SEC)
        return not self.exists("wnd[1]")

    def dismiss_message_display(self) -> bool:
        """Click the exact Continue control from the user's VBS recording."""
        candidates = [
            # Exact control recorded by the user:
            # session.findById("wnd[1]/tbar[0]/btn[0]").press
            "wnd[1]/tbar[0]/btn[0]",
            "wnd[1]/usr/btnBUTTON_1",
            "wnd[1]/usr/btnSPOP-OPTION1",
            "wnd[0]/tbar[0]/btn[0]",
        ]
        pressed = self.press_first_existing(candidates)

        if not pressed and self.exists("wnd[1]"):
            try:
                self.find("wnd[1]").SendVKey(0)
                self.wait_not_busy()
                pressed = "wnd[1]/SendVKey(0)"
            except Exception:
                pressed = None

        if not pressed:
            return False

        closed = self.wait_popup_closed(timeout=15)
        if closed:
            print(f"   ✅ 已点击Continue并关闭Message Display | 控件={pressed}")
            return True

        # Some SAP message windows briefly remain addressable after closing.
        time.sleep(0.8)
        closed = not self.exists("wnd[1]")
        if closed:
            print(f"   ✅ 已点击Continue并关闭Message Display | 控件={pressed}")
        return closed

    def collect_all_visible_text(self) -> str:
        output = [self.window_text("wnd[0]"), self.window_text("wnd[1]")]
        message_type, status = self.status_bar()
        output.append(f"{message_type} {status}")
        return " | ".join(x for x in output if x)


# =============================================================================
# 8. Core RPA workflow
# =============================================================================


def match_exact_npl_rows(
    sap: SapSession,
    grid,
    group: TaskGroup,
) -> tuple[list[MaterialTask], list[MaterialTask]]:
    mapping, debug = sap.map_material_rows(
        grid,
        group.tasks,
        plant_column=COL_PLANT_NPL,
        project_column=COL_PROJECT_NPL,
    )

    matched: list[MaterialTask] = []
    failed: list[MaterialTask] = []

    for task in group.tasks:
        candidate_rows = []
        for row in mapping.get(task.material, []):
            row_info = debug.get(row, {})
            row_plant = row_info.get("plant", "")
            row_project = row_info.get("project", "")

            plant_ok = not row_plant or row_plant == task.plant
            project_ok = not row_project or row_project == task.project
            if plant_ok and project_ok:
                candidate_rows.append(row)

        if len(candidate_rows) == 1:
            task.npl_row = candidate_rows[0]
            matched.append(task)
            print(
                f"   ✅ Material={task.material} NPL唯一匹配 "
                f"| SAP行={task.npl_row} | Plant={task.plant} | Project={task.project}"
            )
        elif not candidate_rows:
            failed.append(task)
            print(
                f"   ❌ Material={task.material} 未在NPL中找到Plant+Project完全匹配行"
            )
        else:
            failed.append(task)
            print(
                f"   ❌ Material={task.material} NPL匹配到多行：{candidate_rows}"
            )

    return matched, failed


def ppap_required_message(task: MaterialTask, current_value: str) -> str:
    today = dt.date.today()
    minimum = today + dt.timedelta(days=PPAP_MIN_DAYS_AHEAD)
    shown = current_value or "<空>"
    return (
        f"物料 {task.material} 当前PPAP Target Date={shown}，"
        f"早于允许日期 {minimum.isoformat()}。"
        "请在Excel的PPAP Date列填写今天或未来日期后重新运行。"
    )


def mark_ppap_input_required(
    excel: ExcelStore,
    group: TaskGroup,
    tasks: Sequence[MaterialTask],
    current_values: dict[str, str],
    popup_text: str = "",
) -> None:
    for task in tasks:
        user_message = ppap_required_message(task, current_values.get(task.material, ""))
        print(f"   📅 {user_message}")
        excel.write_status(
            [task.excel_row],
            batch_key=group.key,
            buyer_status="INPUT_REQUIRED_PPAP_DATE",
            rfq_status="NOT_STARTED",
            error_stage="PPAP_DATE_VALIDATION",
            error_message=(
                f"{user_message} SAP消息：{popup_text[:2500]}"
                if popup_text
                else user_message
            ),
        )
    excel.save()


def validate_and_apply_buyer_receipt_ppap_dates(
    sap: SapSession,
    excel: ExcelStore,
    group: TaskGroup,
    buyer_grid,
    tasks: Sequence[MaterialTask],
) -> tuple[list[MaterialTask], list[MaterialTask]]:
    """Validate PPAPTDAT only after the Buyer Receipt screen has opened.

    This function intentionally does not read or change PPAP dates in the NPL
    result grid. It maps Material in the Buyer Receipt grid, reads that row's
    PPAP Target Date, and updates only that Buyer Receipt row when Excel supplies
    a valid replacement date.
    """
    if not PPAP_DATE_CHECK_ENABLED:
        return list(tasks), []

    if not sap.column_exists(buyer_grid, COL_PPAP_DATE):
        print(
            "   ⚠️ Buyer Receipt页面未识别到PPAP Target Date列；"
            "跳过预检，后续仍由SAP保存校验兜底"
        )
        return list(tasks), []

    mapping, _ = sap.map_material_rows(buyer_grid, tasks)
    minimum = dt.date.today() + dt.timedelta(days=PPAP_MIN_DAYS_AHEAD)
    ready: list[MaterialTask] = []
    blocked: list[MaterialTask] = []
    current_values: dict[str, str] = {}

    for task in tasks:
        rows = mapping.get(task.material, [])
        if len(rows) != 1:
            # Leave row-mapping errors to the normal Buyer Receipt mapping stage.
            ready.append(task)
            continue

        row = rows[0]
        task.buyer_receipt_row = row
        current_raw = sap.get_cell(buyer_grid, row, COL_PPAP_DATE)
        current_values[task.material] = current_raw
        current_date = parse_date_value(current_raw)

        if current_date is not None and current_date >= minimum:
            print(
                f"   ✅ Buyer Receipt Material={task.material} "
                f"PPAP Target Date={current_raw} 有效"
            )
            ready.append(task)
            continue

        excel_date = parse_date_value(task.ppap_date)
        if excel_date is None or excel_date < minimum:
            blocked.append(task)
            continue

        if not AUTO_APPLY_EXCEL_PPAP_TO_BUYER_RECEIPT:
            blocked.append(task)
            continue

        new_value = sap_display_date(excel_date)
        try:
            sap.modify_cell(buyer_grid, row, COL_PPAP_DATE, new_value)
            try:
                buyer_grid.PressEnter()
            except Exception:
                sap.send_vkey(0)
            sap.wait_not_busy()
            time.sleep(max(0.3, SAP_STEP_PAUSE_SEC))

            # Best-effort verification from the Buyer Receipt grid itself.
            verified_raw = sap.get_cell(buyer_grid, row, COL_PPAP_DATE)
            verified_date = parse_date_value(verified_raw)
            if verified_date is not None and verified_date < minimum:
                raise SapRpaError(
                    "PPAP_DATE_WRITE",
                    f"Buyer Receipt PPAP写入后仍为过期日期：{verified_raw}",
                )

            task.ppap_date = excel_date.isoformat()
            current_values[task.material] = verified_raw or new_value
            print(
                f"   ✍️ Buyer Receipt Material={task.material} "
                f"PPAP Target Date已从{current_raw or '<空>'}更新为"
                f"{verified_raw or new_value}（取自Excel）"
            )
            ready.append(task)
        except Exception as exc:
            current_values[task.material] = (
                f"{current_raw or '<空>'}; Excel={excel_date.isoformat()}; "
                f"Buyer Receipt写入失败={exc}"
            )
            blocked.append(task)

    if blocked:
        mark_ppap_input_required(excel, group, blocked, current_values)

    return ready, blocked

def fill_buyer_receipt_rows(
    sap: SapSession,
    grid,
    tasks: Sequence[MaterialTask],
) -> list[MaterialTask]:
    mapping, _ = sap.map_material_rows(grid, tasks)
    valid: list[MaterialTask] = []

    for task in tasks:
        rows = mapping.get(task.material, [])
        if len(rows) != 1:
            print(
                f"   ❌ Buyer Receipt页面Material={task.material} "
                f"行映射异常：{rows}"
            )
            continue

        row = rows[0]
        task.buyer_receipt_row = row

        # PPAP Target Date is validated/updated separately on the Buyer Receipt
        # screen. Do not overwrite a valid SAP date merely because Excel has a value.

        if task.tech_user and sap.column_exists(grid, COL_TECH_USER):
            sap.modify_cell(grid, row, COL_TECH_USER, task.tech_user)

        sap.modify_cell(grid, row, COL_12MR_QTY, task.qty_12mr)
        if task.rfq_qty_p:
            sap.modify_cell(grid, row, COL_RFQ_QTY_PROTOTYPE, task.rfq_qty_p)
        sap.modify_cell(grid, row, COL_RFQ_QTY_SERIAL, task.rfq_qty_s)

        for vendor_index, vendor in enumerate(task.vendors, start=1):
            if not vendor:
                continue
            column = f"LIFNR{vendor_index}"
            if sap.column_exists(grid, column):
                sap.modify_cell(grid, row, column, vendor)

        try:
            grid.PressEnter()
        except Exception:
            pass

        valid.append(task)
        print(
            f"   ✍️ Buyer Receipt SAP行={row} Material={task.material} "
            f"| 12MR={task.qty_12mr} | P={task.rfq_qty_p} | S={task.rfq_qty_s} "
            f"| Vendor1={task.vendors[0]}"
        )

    return valid


def green_status_debug(sap: SapSession, grid, row: int) -> tuple[bool, str]:
    icon = sap.get_cell(grid, row, COL_STATUS_ICON)
    icon_upper = icon.upper().strip()

    # Exact technical icon tokens. The user's QA 321 system returns @5B@ for
    # the green square shown on the Buyer Receipt screen.
    exact_icon_tokens = {token for token in BUYER_GREEN_ICON_TOKENS if token.startswith("@")}
    if icon_upper and icon_upper in exact_icon_tokens:
        return True, f"icon={icon}; matched_token={icon_upper}"

    # Text-based fallbacks for SAP variants that expose a description instead
    # of a technical @xx@ token.
    text_tokens = {token for token in BUYER_GREEN_ICON_TOKENS if not token.startswith("@")}
    if icon_upper and any(token in icon_upper for token in text_tokens):
        return True, f"icon={icon}; matched_text"

    # Some grid implementations expose the cell color. Color 0 is not useful
    # in the user's patch, so the technical icon token remains the primary test.
    try:
        color = safe_text(grid.GetCellColor(row, COL_STATUS_ICON)).upper()
        if color in {"5", "6", "GREEN", "POSITIVE"}:
            return True, f"icon={icon}; color={color}"
        return False, f"icon={icon or '<空>'}; color={color or '<空>'}"
    except Exception:
        pass

    return False, f"icon={icon or '<空>'}"



def extract_buyer_receipt_popup_business_message(sap: SapSession) -> str:
    """Extract the useful business error text from the Message Display popup."""
    preferred_columns = {
        "MESSAGE",
        "MSGTEXT",
        "MESSAGE_TEXT",
        "MSGTX",
        "MSGTXT",
        "TEXT",
    }

    try:
        rows = sap.popup_grid_rows("wnd[1]")
    except Exception:
        rows = []

    # First choice: a recognized message-text column.
    for row in rows:
        for key, value in row.items():
            if key == "__ROW_INDEX__":
                continue
            if safe_text(key).upper() in preferred_columns and safe_text(value):
                return safe_text(value)

    # Second choice: any cell that clearly looks like the observed business error.
    for row in rows:
        for key, value in row.items():
            if key == "__ROW_INDEX__":
                continue
            candidate = safe_text(value)
            lower = candidate.casefold()
            if "sub commodity" in lower and "material master" in lower:
                return candidate

    # Third choice: probe the known Message Display grid directly. The exact
    # technical column name can vary by SAP GUI patch, so try a broad but safe
    # set of likely message-text fields.
    direct_grid = sap.find(
        "wnd[1]/usr/cntlCUSTOMER_200/shellcont/shell",
        required=False,
    )
    if direct_grid is not None:
        candidate_columns = [
            "MESSAGE", "MSGTEXT", "MESSAGE_TEXT", "MSGTX", "MSGTXT",
            "TEXT", "MSG", "MESSAGE1", "MESSAGETEXT",
        ]
        try:
            row_count = sap.row_count(direct_grid)
        except Exception:
            row_count = 0

        for row_index in range(row_count):
            for column in candidate_columns:
                try:
                    candidate = safe_text(
                        direct_grid.GetCellValue(row_index, column)
                    )
                except Exception:
                    continue
                if candidate:
                    return candidate

    # Fallback to the full popup text.
    return (
        sap.popup_message_text("wnd[1]")
        or sap.window_text("wnd[1]")
        or "<无法读取Message Display内容>"
    )


def is_recoverable_buyer_receipt_master_data_error(message: str) -> bool:
    """Recognize the specific non-fatal master-data error from PROD."""
    normalized = re.sub(r"\s+", " ", safe_text(message)).strip().casefold()
    return (
        "sub commodity" in normalized
        and "material master" in normalized
        and (
            "needs to be created" in normalized
            or "need to be created" in normalized
            or "created in material master" in normalized
        )
    )


def recover_after_buyer_receipt_master_data_error(
    sap: SapSession,
    *,
    back_steps: int = 2,
) -> None:
    """Recorded recovery: Continue, then Back twice, then prepare next row."""
    print(
        "   🧹 Buyer Receipt主数据错误恢复："
        f"Continue -> Back x{back_steps}"
    )

    # Exact Continue control from the user's recording:
    # wnd[1]/tbar[0]/btn[0]
    if sap.exists("wnd[1]"):
        if not sap.dismiss_message_display():
            raise SapRpaError(
                "BUYER_RECEIPT_ERROR_RECOVERY",
                "Buyer Receipt错误Message Display无法点击Continue",
            )

    for step in range(1, back_steps + 1):
        sap.press_back_inside_npl_once(
            step,
            max_steps=back_steps,
            target_label="下一笔Material准备界面",
        )
        time.sleep(max(0.5, SAP_STEP_PAUSE_SEC))

    # After the recorded two Backs we expect the ZMFM050072 selection screen.
    if not sap.wait_for_npl_selection_screen(NPL_BACK_SCREEN_WAIT_SEC):
        raise SapRpaError(
            "BUYER_RECEIPT_ERROR_RECOVERY",
            f"已执行Continue + Back x{back_steps}，"
            "但未回到ZMFM050072 Plant/Project选择界面；为避免错页操作已停止。",
        )

    # Clear previous exact-material query state so the next Excel row executes
    # a fresh Plant + Project + Material server-side search.
    sap._active_npl_query = None
    sap._npl_transaction_started = True
    print(
        "   ✅ 已回到ZMFM050072选择界面；"
        "下一Excel行将重新执行精确Material查询"
    )


def save_buyer_receipt(
    sap: SapSession,
    grid,
    tasks: Sequence[MaterialTask],
) -> tuple[list[MaterialTask], dict[str, str], Any]:
    rows = [task.buyer_receipt_row for task in tasks if task.buyer_receipt_row is not None]
    sap.select_rows(grid, [int(row) for row in rows])

    print("   💾 点击Buyer Receipt Save，等待确认窗口")
    sap.press(ID_SAVE)
    sap.wait_and_confirm_buyer_receipt_save()
    sap.wait_not_busy(SAP_LONG_WAIT_SEC)

    # A Message Display can appear immediately after the save-confirmation Yes.
    # Handle it before trying to re-acquire/validate the green Buyer Receipt grid.
    if sap.exists("wnd[1]"):
        popup_message = extract_buyer_receipt_popup_business_message(sap)
        raise SapRpaError(
            "BUYER_RECEIPT_SAVE_POPUP",
            popup_message,
        )

    sap.raise_on_status_error("BUYER_RECEIPT_SAVE")

    # Re-acquire the Buyer Receipt grid after Save. Some SAP GUI patch levels
    # refresh the shell object after the confirmation is accepted.
    current_grid = sap.wait_grid_columns(
        ID_GRID_CUSTOMER1,
        [COL_MATERIAL, COL_12MR_QTY, COL_RFQ_QTY_PROTOTYPE],
        timeout=SAP_LONG_WAIT_SEC,
    )

    deadline = time.time() + BUYER_GREEN_STATUS_TIMEOUT_SEC
    latest_success: list[MaterialTask] = []
    latest_debug: dict[str, str] = {}

    while True:
        latest_success = []
        latest_debug = {}

        # Re-map Material after every post-save refresh. SAP may rebuild or
        # reorder the grid shell after saving, so do not trust the old row index.
        post_save_mapping, _ = sap.map_material_rows(current_grid, tasks)
        for task in tasks:
            mapped_rows = post_save_mapping.get(task.material, [])
            if len(mapped_rows) == 1:
                task.buyer_receipt_row = mapped_rows[0]

        for task in tasks:
            if task.buyer_receipt_row is None:
                latest_debug[task.material] = "保存后无法重新定位Material行"
                continue
            is_green, debug = green_status_debug(
                sap,
                current_grid,
                task.buyer_receipt_row,
            )
            latest_debug[task.material] = debug
            if is_green or not REQUIRE_GREEN_BUYER_RECEIPT:
                latest_success.append(task)

        if len(latest_success) == len(
            [task for task in tasks if task.buyer_receipt_row is not None]
        ):
            print(
                "   ✅ Buyer Receipt保存完成，状态校验通过："
                + ", ".join(task.material for task in latest_success)
            )
            return latest_success, latest_debug, current_grid

        # A post-save Message Display is an actual business error, not a green
        # status delay. Surface it immediately instead of silently polling.
        if sap.exists("wnd[1]"):
            popup_text = extract_buyer_receipt_popup_business_message(sap)
            raise SapRpaError(
                "BUYER_RECEIPT_SAVE_POPUP",
                popup_text,
            )

        if time.time() >= deadline:
            break

        time.sleep(BUYER_GREEN_STATUS_POLL_SEC)
        # Re-acquire on every poll in case the grid shell was refreshed again.
        refreshed = sap.find(ID_GRID_CUSTOMER1, required=False)
        if refreshed is not None:
            current_grid = refreshed

    for task in tasks:
        if task.buyer_receipt_row is None:
            continue
        if task not in latest_success:
            print(
                f"   ⚠️ Material={task.material} Buyer Receipt状态在"
                f"{BUYER_GREEN_STATUS_TIMEOUT_SEC:.0f}秒内未识别为绿色："
                f"{latest_debug.get(task.material, '状态未识别')}"
            )

    return latest_success, latest_debug, current_grid


def rfq_terminal_success_message(sap: SapSession) -> str:
    """Return terminal RFQ success status text when configured for this env."""
    if not RFQ_STATUS_SUCCESS_ENABLED:
        return ""
    if SAP_TARGET_ENV not in RFQ_STATUS_SUCCESS_ENVIRONMENTS:
        return ""

    message_type, status_text = sap.status_bar()
    if message_type != "S" or not status_text:
        return ""

    normalized = re.sub(r"\s+", " ", status_text).strip().casefold()
    for expected in RFQ_STATUS_SUCCESS_MESSAGES:
        expected_normalized = re.sub(r"\s+", " ", expected).strip().casefold()
        if expected_normalized and expected_normalized in normalized:
            return status_text
    return ""


def wait_rfq_grid_or_terminal_success(
    sap: SapSession,
) -> tuple[Optional[Any], str]:
    """Wait for either the editable RFQ grid or QA's terminal success status."""
    deadline = time.time() + RFQ_POST_INTERMEDIATE_WAIT_SEC
    last_status = ""

    while time.time() < deadline:
        terminal = rfq_terminal_success_message(sap)
        if terminal:
            return None, terminal

        message_type, status_text = sap.status_bar()
        if status_text:
            last_status = f"{message_type}:{status_text}"

        grid = sap.find(ID_GRID_CUSTOMER1, required=False)
        if grid is not None:
            try:
                if sap.column_exists(grid, COL_MATERIAL) and sap.column_exists(grid, "LIFNR1_CB"):
                    return grid, ""
            except Exception:
                pass

        if sap.exists("wnd[1]"):
            sap.handle_simple_confirmation(yes=True)

        time.sleep(SAP_POLL_SEC)

    terminal = rfq_terminal_success_message(sap)
    if terminal:
        return None, terminal

    raise SapRpaError(
        "SAP_TIMEOUT",
        "等待RFQ Creation Grid或终态成功消息超时。"
        f"最后状态={last_status or '<空>'}; "
        f"期望成功消息={RFQ_STATUS_SUCCESS_MESSAGES}",
    )


def open_rfq_creation_from_buyer_receipt(
    sap: SapSession,
    buyer_grid,
    tasks: Sequence[MaterialTask],
):
    rows = [task.buyer_receipt_row for task in tasks if task.buyer_receipt_row is not None]
    sap.select_rows(buyer_grid, [int(row) for row in rows])
    sap.press(ID_CREATE_RFQ_FROM_BR)

    # Intermediate grid in the recording (CUSTOMER2)
    intermediate = sap.wait_grid_columns(
        ID_GRID_CUSTOMER2,
        [COL_MATERIAL],
        timeout=SAP_LONG_WAIT_SEC,
    )
    mapping, _ = sap.map_material_rows(intermediate, tasks)

    intermediate_rows: list[int] = []
    for task in tasks:
        rows_for_material = mapping.get(task.material, [])
        if len(rows_for_material) != 1:
            raise SapRpaError(
                "RFQ_INTERMEDIATE_MATCH",
                f"Intermediate页面Material={task.material}行映射异常：{rows_for_material}",
            )
        intermediate_rows.append(rows_for_material[0])

    sap.select_rows(intermediate, intermediate_rows)
    sap.press(ID_CREATE_RFQ_FROM_INTERMEDIATE)

    # Recorded warning/confirmation immediately after btn[9]. In QA the flow
    # may finish here and only return the success status in the status bar.
    if sap.exists("wnd[1]"):
        sap.handle_simple_confirmation(yes=True)

    return wait_rfq_grid_or_terminal_success(sap)



HUB_STAGING_RECOVERY = None  # Set only by the desktop adapter; standalone is unchanged.


def prepare_prod_direct_rfq_rows(
    sap: SapSession,
    buyer_grid,
    tasks: Sequence[MaterialTask],
) -> tuple[Any, list[MaterialTask]]:
    """PROD flow after Buyer Receipt save.

    Correct PROD sequence:
      saved Buyer Receipt CUSTOMER1
      -> select saved Buyer Receipt row(s)
      -> btn[2] Create RFQ
      -> wait for RFQ staging CUSTOMER1 containing LIFNRx_CB
      -> set Cost Breakdown checkbox(es)
      -> return staging grid; caller will open Detailed RFQ from that screen.

    v18 incorrectly pressed btn[19] while still on the saved Buyer Receipt screen.
    In PROD that toolbar position is the attachment/upload function, which is why
    the automation opened attachment instead of RFQ.
    """
    message_type, status_text = sap.status_bar()
    print(
        "   🏭 PROD RFQ path: saved Buyer Receipt "
        "-> btn[2] Create RFQ -> RFQ staging CUSTOMER1 -> btn[19]"
    )
    print(f"   ℹ️ Buyer Receipt post-save status={message_type}:{status_text or '<blank>'}")

    # Step A: select the successfully-saved Buyer Receipt rows and press the real
    # "Create RFQ from Buyer Receipt" button first.
    br_rows = [
        int(task.buyer_receipt_row)
        for task in tasks
        if task.buyer_receipt_row is not None
    ]
    if not br_rows:
        raise SapRpaError(
            "PROD_CREATE_RFQ_FROM_BR",
            "Buyer Receipt已保存，但没有可用于Create RFQ的Buyer Receipt行号",
        )

    sap.select_rows(buyer_grid, br_rows)
    print(f"   ▶ Buyer Receipt选择行={br_rows}，点击 Create RFQ btn[2]")
    sap.press(ID_CREATE_RFQ_FROM_BR)
    sap.wait_not_busy(SAP_LONG_WAIT_SEC)

    # Do not blindly press a popup here. A business-error popup must be surfaced.
    if sap.exists("wnd[1]"):
        popup = sap.popup_message_text("wnd[1]") or sap.window_text("wnd[1]")
        raise SapRpaError(
            "PROD_CREATE_RFQ_FROM_BR_POPUP",
            "点击Buyer Receipt Create RFQ(btn[2])后出现弹窗："
            + (popup[:2500] or "<无法读取弹窗内容>"),
        )

    # Step B: wait until the RFQ staging CUSTOMER1 is actually ready.
    # MATNR alone is not enough because the saved Buyer Receipt screen also has MATNR.
    # Read-only readiness checks: never write a checkbox just to probe the screen.
    # SAP GuiGridView GetCellType/GetCellChangeable do not alter the checkbox.
    deadline = time.time() + SAP_LONG_WAIT_SEC
    last_error = ""
    staging_grid = None
    staging_mapping = None

    while time.time() < deadline:
        candidate = sap.find(ID_GRID_CUSTOMER1, required=False)
        if candidate is None:
            time.sleep(SAP_POLL_SEC)
            continue

        try:
            if not sap.column_exists(candidate, COL_MATERIAL):
                time.sleep(SAP_POLL_SEC)
                continue

            mapping, _ = sap.map_material_rows(candidate, tasks)

            # All tasks must map uniquely before we touch the staging grid.
            mapped_rows: dict[str, int] = {}
            mapping_ok = True
            for task in tasks:
                rows = mapping.get(task.material, [])
                if len(rows) != 1:
                    last_error = (f"Material={task.material}: expected one SAP row, found {len(rows)}; "
                                  f"SAP rows={[row + 1 for row in rows]}")
                    mapping_ok = False
                    break
                mapped_rows[task.material] = rows[0]

            if not mapping_ok:
                if HUB_STAGING_RECOVERY is not None and any(len(mapping.get(t.material, [])) > 1 for t in tasks):
                    break  # A deterministic duplicate is not a loading delay.
                time.sleep(SAP_POLL_SEC)
                continue

            # Confirm the staging checkbox is available without changing its state.
            first_task = tasks[0]
            first_row = mapped_rows[first_task.material]
            if safe_text(candidate.GetCellType(first_row, "LIFNR1_CB")).casefold() != "checkbox":
                last_error = "LIFNR1_CB is not a checkbox on the current screen"
                time.sleep(SAP_POLL_SEC)
                continue
            if not first_task.cost_breakdown[0] and not candidate.GetCellChangeable(first_row, "LIFNR1_CB"):
                last_error = "LIFNR1_CB is not changeable on the current screen"
                time.sleep(SAP_POLL_SEC)
                continue

            staging_grid = candidate
            staging_mapping = mapping
            print(
                "   ✅ 已进入PROD RFQ staging Grid："
                f"LIFNR1_CB复选框可用 | Material={first_task.material} | SAP行={first_row}"
            )
            break

        except Exception as exc:
            last_error = str(exc)
            time.sleep(SAP_POLL_SEC)

    if staging_grid is None or staging_mapping is None:
        message_type, status_text = sap.status_bar()
        issue = ("RFQ页面校验未通过；尚未修改Cost Breakdown。"
                 f"{last_error or 'RFQ grid is missing or not ready'}; status={message_type}:{status_text}")
        if HUB_STAGING_RECOVERY is None:
            raise SapRpaError("PROD_RFQ_STAGING_TIMEOUT", issue)
        # Resume inside Step B. Do not repeat Step A / Create RFQ from BR.
        staging_grid, staging_mapping = HUB_STAGING_RECOVERY(sap, tasks, issue)

    # Step C: now apply all Cost Breakdown checkboxes on the RFQ staging grid.
    valid: list[MaterialTask] = []

    for task in tasks:
        rows = staging_mapping.get(task.material, [])
        if len(rows) != 1:
            print(
                f"   ❌ PROD RFQ staging Material={task.material} "
                f"行映射异常：{rows}"
            )
            continue

        row = rows[0]
        task.rfq_row = row

        for vendor_index in range(1, 6):
            cb_column = f"LIFNR{vendor_index}_CB"
            requested_value = bool(task.cost_breakdown[vendor_index - 1])

            # No/blank explicitly clears the configured supplier's checkbox.
            # Yes preserves SAP's current state; never write True here.
            if requested_value or not task.vendors[vendor_index - 1]:
                continue

            try:
                staging_grid.ModifyCheckBox(row, cb_column, requested_value)
                try:
                    staging_grid.TriggerModified()
                except Exception:
                    pass

                print(f"      ☑ {cb_column}={requested_value} | OK")

            except Exception as exc:
                raise SapRpaError(
                    "PROD_COST_BREAKDOWN",
                    f"RFQ staging已打开，但无法修改 "
                    f"Material={task.material} {cb_column}={requested_value}: {exc}",
                ) from exc

        valid.append(task)
        print(
            f"   ✅ PROD RFQ staging准备完成 | SAP行={row} "
            f"Material={task.material} | CB={task.cost_breakdown}"
        )

    return staging_grid, valid



def press_prod_open_detailed_rfq(sap: SapSession) -> None:
    """Press Detailed/Create RFQ only from the RFQ staging screen.

    btn[19] is valid in the user's PROD RFQ staging recording, but the same numeric
    toolbar position can represent Attachment on the Buyer Receipt screen.
    Therefore log/guard the button meaning and, if needed, scan the toolbar for an
    RFQ-labelled button instead of blindly pressing an attachment button.
    """
    toolbar = sap.find("wnd[0]/tbar[1]", required=False)
    preferred = sap.find(ID_OPEN_DETAILED_RFQ, required=False)

    def button_meta(button) -> str:
        if button is None:
            return ""
        parts = []
        for attr in ("Text", "Tooltip", "QuickInfo", "Name"):
            try:
                value = safe_text(getattr(button, attr, ""))
                if value:
                    parts.append(value)
            except Exception:
                pass
        return " | ".join(parts)

    preferred_meta = button_meta(preferred)
    print(
        "   🔎 PROD btn[19] metadata: "
        + (preferred_meta or "<无Text/Tooltip>")
    )

    bad_tokens = ("attach", "attachment", "upload")
    if preferred is not None:
        lower = preferred_meta.casefold()
        if not any(token in lower for token in bad_tokens):
            try:
                preferred.Press()
                sap.wait_not_busy(SAP_LONG_WAIT_SEC)
                print("   ✅ 已点击RFQ staging btn[19]")
                return
            except Exception as exc:
                print(f"   ⚠️ btn[19]点击失败，尝试按按钮文字动态查找RFQ：{exc}")

    # Dynamic fallback: scan application toolbar buttons for something labelled RFQ.
    matches = []
    if toolbar is not None:
        try:
            children = toolbar.Children
            for index in range(children.Count):
                try:
                    button = children(index)
                except Exception:
                    try:
                        button = children.Item(index)
                    except Exception:
                        continue

                meta = button_meta(button)
                lower = meta.casefold()
                if "rfq" in lower and not any(token in lower for token in bad_tokens):
                    matches.append((button, meta))
        except Exception:
            pass

    if len(matches) == 1:
        button, meta = matches[0]
        print(f"   ✅ 动态找到RFQ按钮：{meta}")
        button.Press()
        sap.wait_not_busy(SAP_LONG_WAIT_SEC)
        return

    if preferred is not None and any(
        token in preferred_meta.casefold() for token in bad_tokens
    ):
        raise SapRpaError(
            "PROD_RFQ_BUTTON_GUARD",
            "当前btn[19]仍然是附件/上传按钮，说明尚未处于RFQ staging页面；"
            f"btn[19]={preferred_meta!r}。程序拒绝继续点击。",
        )

    raise SapRpaError(
        "PROD_RFQ_BUTTON",
        "无法唯一定位Detailed/Create RFQ按钮。"
        f"btn[19]={preferred_meta!r}; RFQ候选数={len(matches)}",
    )


def fill_rfq_grid_rows(
    sap: SapSession,
    grid,
    tasks: Sequence[MaterialTask],
) -> list[MaterialTask]:
    mapping, _ = sap.map_material_rows(grid, tasks)
    valid: list[MaterialTask] = []

    for task in tasks:
        rows = mapping.get(task.material, [])
        if len(rows) != 1:
            print(f"   ❌ RFQ Grid Material={task.material} 行映射异常：{rows}")
            continue

        row = rows[0]
        task.rfq_row = row

        if task.rfq_qty_p:
            sap.modify_cell(grid, row, COL_RFQ_QTY_PROTOTYPE, task.rfq_qty_p)
        sap.modify_cell(grid, row, COL_RFQ_QTY_SERIAL, task.rfq_qty_s)

        if sap.column_exists(grid, COL_AFM_REQUEST):
            sap.modify_checkbox(grid, row, COL_AFM_REQUEST, task.afm_request)

        for vendor_index, vendor in enumerate(task.vendors, start=1):
            vendor_column = f"LIFNR{vendor_index}"
            cb_column = f"LIFNR{vendor_index}_CB"

            if vendor and sap.column_exists(grid, vendor_column):
                sap.modify_cell(grid, row, vendor_column, vendor)

            # Only No/blank authorizes clearing a configured supplier's box.
            # Yes leaves SAP unchanged, including an already-unchecked box.
            if vendor and not task.cost_breakdown[vendor_index - 1] and sap.column_exists(grid, cb_column):
                sap.modify_checkbox(
                    grid,
                    row,
                    cb_column,
                    task.cost_breakdown[vendor_index - 1],
                )

        valid.append(task)
        print(
            f"   ✍️ RFQ Grid SAP行={row} Material={task.material} "
            f"| AFM={task.afm_request} | Vendors={','.join(v for v in task.vendors if v)}"
        )

    return valid



def _popup_action_candidates(action: str) -> list[str]:
    action = action.upper()
    if action == "YES":
        # Exact PROD recording: wnd[1]/usr/btnBUTTON_1
        return [
            "wnd[1]/usr/btnBUTTON_1",
            "wnd[1]/usr/btnSPOP-OPTION1",
        ]
    if action == "NO":
        # Attachment popup may expose either No or toolbar Cancel.
        return [
            "wnd[1]/usr/btnBUTTON_2",
            "wnd[1]/usr/btnSPOP-OPTION2",
            "wnd[1]/tbar[0]/btn[12]",
        ]
    if action == "CONTINUE":
        # Exact PROD recording: wnd[1]/tbar[0]/btn[0]
        return [
            "wnd[1]/tbar[0]/btn[0]",
        ]
    raise ValueError(f"Unsupported popup action: {action}")


def press_prod_popup_action(
    sap: SapSession,
    action: str,
    *,
    step_name: str,
) -> None:
    """Wait for the requested modal action, press a fresh COM object, then pause.

    The previous code classified a Yes/No SAPLSPO1 window as a generic "Warning"
    and pressed toolbar Continue instead of BUTTON_1. That left the same modal
    open and caused the handler to loop repeatedly.

    This helper follows the exact PROD recording and reacquires the button on
    every attempt. It also deliberately waits after each successful press so SAP
    has time to replace wnd[1] with the next confirmation.
    """
    action = action.upper()
    candidates = _popup_action_candidates(action)
    deadline = time.time() + PROD_RFQ_POPUP_STEP_TIMEOUT_SEC
    last_error = ""

    while time.time() < deadline:
        if not sap.exists("wnd[1]"):
            time.sleep(SAP_POLL_SEC)
            continue

        # Log only lightweight modal metadata; do not depend on HTML question text.
        try:
            title = safe_text(sap.find("wnd[1]", required=False).Text)
        except Exception:
            title = ""

        available = [
            control_id
            for control_id in candidates
            if sap.exists(control_id)
        ]

        if not available:
            time.sleep(SAP_POLL_SEC)
            continue

        for attempt in range(1, PROD_RFQ_POPUP_CLICK_RETRIES + 1):
            # Re-acquire the button every attempt; modal transitions invalidate
            # cached SAP GUI COM objects surprisingly often.
            pressed = None
            for control_id in candidates:
                control = sap.find(control_id, required=False)
                if control is None:
                    continue
                try:
                    control.Press()
                    pressed = control_id
                    break
                except Exception as exc:
                    last_error = f"{control_id}: {exc}"

            if pressed:
                print(
                    f"   ✅ {step_name}: {action} "
                    f"| Popup={title or '<no title>'} "
                    f"| Control={pressed} | Attempt={attempt}"
                )
                sap.wait_not_busy(SAP_LONG_WAIT_SEC)
                # Critical: allow the old modal to close and the next one to be
                # created before the next state-machine step.
                time.sleep(PROD_RFQ_POPUP_POST_CLICK_SEC)
                return

            time.sleep(0.5)

    popup_text = ""
    try:
        popup_text = sap.window_text("wnd[1]") if sap.exists("wnd[1]") else ""
    except Exception:
        pass
    raise SapRpaError(
        "RFQ_POPUP",
        f"{step_name} 未能执行 {action}；"
        f"候选控件={candidates}; last={last_error}; "
        f"popup={popup_text[:1000]}",
    )



def extract_created_rfq_from_text(text: str) -> tuple[str, str]:
    """Extract RFQ number from PROD final success text.

    Supports examples such as:
      RFQ No 1000101082 is created successfully
      RFQ: 1000101082 has created successfully
      RFQ 1000101082 created successfully
    """
    normalized = re.sub(r"\s+", " ", safe_text(text)).strip()
    if not normalized:
        return "", ""

    patterns = [
        r"\bRFQ\s*(?:No\.?|Number)?\s*[:#]?\s*(\d{7,12})\s+"
        r"(?:is\s+|has\s+|has\s+been\s+)?created\s+successfully\b",
        r"\bRFQ\s*(?:No\.?|Number)?\s*[:#]?\s*(\d{7,12})\b",
    ]

    for pattern in patterns:
        match = re.search(pattern, normalized, re.I)
        if match:
            return normalize_identifier(match.group(1)), normalized

    if "created successfully" in normalized.casefold():
        return "", normalized

    return "", ""


def capture_rfq_success_from_message_display(sap: SapSession) -> tuple[str, str]:
    candidates: list[str] = []

    try:
        value = sap.popup_message_text("wnd[1]")
        if value:
            candidates.append(value)
    except Exception:
        pass

    try:
        value = sap.window_text("wnd[1]")
        if value:
            candidates.append(value)
    except Exception:
        pass

    direct_grid = sap.find(
        "wnd[1]/usr/cntlCUSTOMER_200/shellcont/shell",
        required=False,
    )
    if direct_grid is not None:
        try:
            rows = sap.row_count(direct_grid)
        except Exception:
            rows = 0

        probable_columns = [
            "MESSAGE", "MSGTEXT", "MESSAGE_TEXT", "MSGTX", "MSGTXT",
            "TEXT", "MSG", "VALUE", "FIELDVALUE",
        ]
        try:
            discovered = sap._grid_column_keys(direct_grid)
        except Exception:
            discovered = []

        for row in range(rows):
            values: list[str] = []
            for column in [*discovered, *probable_columns]:
                try:
                    value = safe_text(direct_grid.GetCellValue(row, column))
                except Exception:
                    continue
                if value and value not in values:
                    values.append(value)
            if values:
                candidates.append(" | ".join(values))

    for candidate in candidates:
        number, success_text = extract_created_rfq_from_text(candidate)
        if number or success_text:
            return number, success_text

    return "", ""


def return_to_npl_start_after_rfq(
    sap: SapSession,
    *,
    max_back_steps: int,
) -> int:
    """After a successful RFQ, press Back exactly N times.

    v27 follows the user's confirmed PROD navigation:
      write RFQ Number to Excel -> Back x4 -> next material

    There is no fixed sleep between Back presses and no early-stop shortcut.
    """
    print(
        f"   ↩️ RFQ结果已写入Excel，立即Back {max_back_steps}次"
    )

    for step in range(1, max_back_steps + 1):
        print(f"   ↩️ RFQ成功后Back {step}/{max_back_steps}")
        button = sap.find("wnd[0]/tbar[0]/btn[3]", required=False)
        if button is not None:
            try:
                button.Press()
                sap.wait_not_busy(SAP_LONG_WAIT_SEC)
            except Exception as exc:
                raise SapRpaError(
                    "POST_RFQ_RECOVERY",
                    f"RFQ成功后Back {step}/{max_back_steps}失败：{exc}",
                ) from exc
        else:
            sap.send_vkey(3)

    # Reset query state. The next ROW-mode material performs a fresh exact search.
    sap._active_npl_query = None
    sap._npl_transaction_started = sap.current_transaction() == TCODE_NPL

    print(
        f"   ✅ RFQ成功后已完成Back x{max_back_steps}；"
        "下一Excel行重新执行精确Material查询"
    )
    return max_back_steps



def wait_for_next_prod_rfq_popup_or_success(
    sap: SapSession,
    *,
    timeout: float,
) -> tuple[str, str]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if sap.exists("wnd[1]"):
            return "POPUP", ""
        terminal = rfq_terminal_success_message(sap)
        if terminal:
            return "SUCCESS", terminal
        try:
            if bool(sap.session.Busy):
                time.sleep(SAP_POLL_SEC)
                continue
        except Exception:
            pass
        time.sleep(SAP_POLL_SEC)

    if sap.exists("wnd[1]"):
        return "POPUP", ""
    terminal = rfq_terminal_success_message(sap)
    if terminal:
        return "SUCCESS", terminal
    return "TIMEOUT", ""


def process_prod_final_rfq_popups(
    sap: SapSession,
    group: TaskGroup,
) -> tuple[str, str]:
    """Robust PROD RFQ popup state machine, including delayed attachment popup."""
    if group.attach_file:
        raise SapRpaError(
            "RFQ_ATTACHMENT_UNSUPPORTED",
            "当前Excel要求Attach File=true，但自动附件上传尚未实现。",
        )

    print(
        "   🧭 PROD最终弹窗动态处理："
        "Warning=YES | RFQ Create=YES | Attach File=NO/Cancel | "
        "Message Display=抓RFQ No后Continue"
    )

    handled = 0
    captured_rfq_number = ""
    captured_success_message = ""

    while handled < 10:
        if not sap.exists("wnd[1]"):
            state, terminal = wait_for_next_prod_rfq_popup_or_success(
                sap,
                timeout=PROD_RFQ_NEXT_POPUP_WAIT_SEC,
            )
            if state == "SUCCESS":
                number, message = extract_created_rfq_from_text(terminal)
                if number:
                    captured_rfq_number = captured_rfq_number or number
                if message:
                    captured_success_message = captured_success_message or message
                print(f"   ✅ 已检测到RFQ终态成功：{terminal}")
                return captured_rfq_number, captured_success_message

            if state == "TIMEOUT":
                if captured_rfq_number or captured_success_message:
                    return captured_rfq_number, captured_success_message
                raise SapRpaError(
                    "RFQ_POPUP_WAIT",
                    "上一RFQ确认已点击，但在"
                    f"{PROD_RFQ_NEXT_POPUP_WAIT_SEC:.0f}秒内既未出现下一弹窗，"
                    "也未检测到RFQ成功状态。请检查SAP当前页面。",
                )

        try:
            popup = sap.find("wnd[1]", required=False)
            title = safe_text(getattr(popup, "Text", ""))
        except Exception:
            title = ""

        try:
            popup_text = sap.window_text("wnd[1]")
        except Exception:
            popup_text = ""

        combined = f"{title} | {popup_text}".casefold()

        has_yes = sap.exists("wnd[1]/usr/btnBUTTON_1") or sap.exists(
            "wnd[1]/usr/btnSPOP-OPTION1"
        )
        has_no = (
            sap.exists("wnd[1]/usr/btnBUTTON_2")
            or sap.exists("wnd[1]/usr/btnSPOP-OPTION2")
            or sap.exists("wnd[1]/tbar[0]/btn[12]")
        )
        has_continue = sap.exists("wnd[1]/tbar[0]/btn[0]")

        print(
            "   🪟 PROD RFQ弹窗识别："
            f"Title={title or '<blank>'} | "
            f"Yes={has_yes} No/Cancel={has_no} Continue={has_continue}"
        )

        if "attach file" in combined or "attachment" in combined:
            press_prod_popup_action(
                sap, "NO", step_name="附件确认（不上传附件 / Cancel）"
            )

        elif "rfq create" in combined or "create rfq" in combined:
            press_prod_popup_action(
                sap, "YES", step_name="RFQ Create确认"
            )

        elif ("warning" in combined or "preferred supplier" in combined) and has_yes:
            press_prod_popup_action(
                sap, "YES", step_name="RFQ Warning/Preferred Supplier确认"
            )

        elif has_continue and not has_yes and not has_no:
            number, success_message = capture_rfq_success_from_message_display(sap)
            if number:
                captured_rfq_number = number
                print(f"   🎯 最终Message Display已提取RFQ Number：{number}")
            if success_message:
                captured_success_message = success_message
                print(
                    "   ✅ 最终Message Display成功消息："
                    f"{success_message[:500]}"
                )

            press_prod_popup_action(
                sap, "CONTINUE", step_name="RFQ Message Display Continue"
            )

            if captured_rfq_number or captured_success_message:
                return captured_rfq_number, captured_success_message

        elif has_yes and has_no:
            raise SapRpaError(
                "RFQ_POPUP_UNKNOWN",
                "发现未知Yes/No弹窗，程序拒绝猜测按钮。"
                f"Title={title!r}; Popup={popup_text[:1500]}",
            )

        elif has_continue:
            number, success_message = capture_rfq_success_from_message_display(sap)
            if number:
                captured_rfq_number = number
            if success_message:
                captured_success_message = success_message
            press_prod_popup_action(
                sap, "CONTINUE", step_name="RFQ Continue"
            )
            if captured_rfq_number or captured_success_message:
                return captured_rfq_number, captured_success_message

        else:
            raise SapRpaError(
                "RFQ_POPUP_UNKNOWN",
                "无法识别PROD RFQ弹窗控件。"
                f"Title={title!r}; Popup={popup_text[:1500]}",
            )

        handled += 1

    raise SapRpaError(
        "RFQ_POPUP_LOOP",
        "PROD RFQ弹窗处理超过10次，已停止以避免重复点击。",
    )


def handle_preferred_supplier_warning(sap: SapSession, allow: bool) -> None:
    if not sap.exists("wnd[1]"):
        return

    text = sap.window_text("wnd[1]").casefold()

    # In PROD the HTML question text is not reliably exposed through SAP GUI
    # scripting, while the exact recording clearly presses BUTTON_1 after btn[19].
    # Use the recorded Yes control rather than classifying on inaccessible text.
    if SAP_TARGET_ENV == "PROD":
        press_prod_popup_action(
            sap,
            "YES",
            step_name="进入Detailed RFQ后的确认",
        )
        return

    if "preferred supplier" in text:
        if allow:
            if not sap.handle_simple_confirmation(yes=True):
                raise SapRpaError(
                    "PREFERRED_SUPPLIER_WARNING",
                    "允许无Preferred Supplier，但未能点击Yes",
                )
        else:
            sap.handle_simple_confirmation(yes=False)
            raise SapRpaError(
                "PREFERRED_SUPPLIER_WARNING",
                "RFQ没有Preferred Supplier，Excel未允许继续",
            )
    else:
        sap.handle_simple_confirmation(yes=True)


def fill_optional_control_text(sap: SapSession, control_id: str, value: str) -> bool:
    if not value:
        return True
    control = sap.find(control_id, required=False)
    if control is None:
        return False
    control.Text = value
    return True


def _set_calendar_property(calendar, names: Sequence[str], value: str) -> bool:
    for name in names:
        try:
            setattr(calendar, name, value)
            return True
        except Exception:
            continue
    return False


def set_rfq_due_date_from_excel(sap: SapSession, date_iso: str) -> None:
    """Write Excel quotation due date directly into the SAP field.

    No F4 calendar popup is used in v27. Excel dates are normalized to the
    SAP display format DD.MM.YYYY, e.g. 25.09.2026, and written directly.
    """
    date_value = parse_date_value(date_iso)
    if date_value is None:
        raise SapRpaError(
            "RFQ_DUE_DATE",
            f"无法解析Excel F列RFQ日期：{date_iso!r}",
        )

    display_text = sap_display_date(date_value)  # DD.MM.YYYY
    due_control = sap.find(ID_RFQ_DUE_DATE, required=True)
    due_control.Text = display_text

    try:
        due_control.SetFocus()
    except Exception:
        pass

    # Let SAP validate the typed value without opening the calendar.
    sap.send_vkey(0)
    sap.raise_on_status_error("RFQ_DUE_DATE")

    print(
        f"   📅 RFQ Due Date <- Excel F直接写入SAP: {display_text}"
    )


def fill_detailed_rfq_header(sap: SapSession, group: TaskGroup) -> None:
    # The supplied recording does not contain the RFQ Comment popup controls.
    # Never silently ignore a requested comment.
    if group.rfq_comment:
        raise SapRpaError(
            "RFQ_COMMENT_UNSUPPORTED",
            "Excel填写了RFQ Comment，但录制脚本未包含RFQ Comment控件。"
            "请先将RFQ Comment留空，或补录该按钮和弹窗。",
        )

    # Fixed mapping: primary Supplier Email comes from Excel E.
    # load_tasks() has already overridden group.emails[0][0] with column E.
    for vendor_index in range(1, 6):
        for email_index in range(1, 4):
            email = group.emails[vendor_index - 1][email_index - 1]
            if not email:
                continue
            control_id = (
                f"wnd[0]/usr/ctxtGS_0110-EMAIL{vendor_index}_{email_index}"
            )
            if not fill_optional_control_text(sap, control_id, email):
                raise SapRpaError(
                    "RFQ_EMAIL",
                    f"找不到Email字段：Vendor{vendor_index} Email{email_index} "
                    f"({control_id})",
                )
            if vendor_index == 1 and email_index == 1:
                print(f"   ✉️ Supplier Email <- Excel E: {email}")

    set_rfq_due_date_from_excel(sap, group.quotation_due_date)
    sap.raise_on_status_error("RFQ_HEADER")


def process_final_rfq_popups(
    sap: SapSession,
    group: TaskGroup,
) -> tuple[str, str]:
    if SAP_TARGET_ENV == "PROD":
        return process_prod_final_rfq_popups(sap, group)

    # QA / legacy generic handler
    deadline = time.time() + SAP_LONG_WAIT_SEC
    handled = 0

    while time.time() < deadline and handled < 10:
        if not sap.exists("wnd[1]"):
            time.sleep(0.5)
            if not sap.exists("wnd[1]"):
                return "", ""

        text = sap.window_text("wnd[1]")
        lower = text.casefold()
        print(f"   🪟 RFQ弹窗：{text[:300]}")

        if "preferred supplier" in lower:
            if group.allow_without_preferred:
                if not sap.handle_simple_confirmation(yes=True):
                    raise SapRpaError("RFQ_POPUP", "Preferred Supplier弹窗无法点击Yes")
            else:
                sap.handle_simple_confirmation(yes=False)
                raise SapRpaError(
                    "PREFERRED_SUPPLIER_WARNING",
                    "RFQ没有Preferred Supplier，未获准继续",
                )

        elif "attach" in lower and "file" in lower:
            if group.attach_file:
                raise SapRpaError(
                    "RFQ_ATTACHMENT_UNSUPPORTED",
                    "当前录制没有附件上传步骤，不能自动选择Yes",
                )
            if not sap.press_first_existing(
                [
                    "wnd[1]/usr/btnBUTTON_2",
                    "wnd[1]/usr/btnSPOP-OPTION2",
                ]
            ):
                raise SapRpaError("RFQ_POPUP", "附件弹窗无法点击No")

        elif "create rfq" in lower or "do you want to create" in lower:
            if not sap.handle_simple_confirmation(yes=True):
                raise SapRpaError("RFQ_POPUP", "Create RFQ确认弹窗无法点击Yes")

        elif "warning" in lower:
            if not sap.press_first_existing(
                [
                    "wnd[1]/tbar[0]/btn[0]",
                    "wnd[1]/usr/btnBUTTON_1",
                ]
            ):
                raise SapRpaError("RFQ_POPUP", f"Warning弹窗无法继续：{text}")

        else:
            pressed = sap.press_first_existing(
                [
                    "wnd[1]/tbar[0]/btn[0]",
                    "wnd[1]/usr/btnBUTTON_1",
                    "wnd[1]/usr/btnBUTTON_2",
                ]
            )
            if not pressed:
                raise SapRpaError("RFQ_POPUP", f"无法处理未知弹窗：{text}")

        handled += 1
        sap.wait_not_busy(SAP_LONG_WAIT_SEC)
        time.sleep(0.5)

    return "", ""


def extract_rfq_number(sap: SapSession) -> str:
    candidates: list[str] = []

    # 1. Status bar and all visible control text.
    candidates.append(sap.collect_all_visible_text())

    # 2. Known grids / RFQNO column.
    for grid_id in (ID_GRID_CUSTOMER1, ID_GRID_CUSTOMER2):
        grid = sap.find(grid_id, required=False)
        if grid is None or not sap.column_exists(grid, "RFQNO"):
            continue
        for row in range(sap.row_count(grid)):
            value = normalize_identifier(sap.get_cell(grid, row, "RFQNO"))
            if re.fullmatch(r"\d{7,12}", value):
                return value

    text = " | ".join(candidates)
    patterns = [
        r"RFQ\s*(?:No\.?|Number)?\s*[:#]?\s*(\d{7,12})",
        r"RFQ\s+creation\s+completed\s*\(?\s*(\d{7,12})",
        r"Save\s+RFQ\s+No\.?\s*(\d{7,12})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return normalize_identifier(match.group(1))

    return ""


def is_existing_rfq_message(text: str) -> bool:
    """Recognize the NPL message shown when the material already has an RFQ."""
    normalized = re.sub(r"\s+", " ", safe_text(text)).casefold()
    if "rfq" not in normalized or "already" not in normalized:
        return False
    return any(token in normalized for token in ("created", "exist", "available"))


def is_ppap_past_message(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", safe_text(text)).casefold()
    return (
        "ppap" in normalized
        and "date" in normalized
        and "past" in normalized
        and ("can not" in normalized or "cannot" in normalized or "not be" in normalized)
    )


def identify_popup_material_tasks(
    sap: SapSession,
    tasks: Sequence[MaterialTask],
    message_matcher,
) -> tuple[list[MaterialTask], str]:
    """Map popup rows to Excel tasks without relying on COM ColumnOrder."""
    popup_rows = sap.popup_grid_rows("wnd[1]")
    popup_text = sap.popup_message_text("wnd[1]")
    task_by_material = {task.material: task for task in tasks}
    matched_materials: set[str] = set()
    message_seen = message_matcher(popup_text)

    for popup_row in popup_rows:
        row_values = [
            safe_text(value)
            for key, value in popup_row.items()
            if key != "__ROW_INDEX__"
        ]
        row_text = " | ".join(value for value in row_values if value)
        row_matches = message_matcher(row_text)
        message_seen = message_seen or row_matches
        if not row_matches:
            continue
        for value in row_values:
            normalized = normalize_material(value)
            if normalized in task_by_material:
                matched_materials.add(normalized)
        for material in task_by_material:
            if re.search(rf"(?<!\d){re.escape(material)}(?!\d)", row_text):
                matched_materials.add(material)

    if message_seen:
        for material in task_by_material:
            if re.search(rf"(?<!\d){re.escape(material)}(?!\d)", popup_text):
                matched_materials.add(material)
        if len(tasks) == 1 and not matched_materials:
            matched_materials.add(tasks[0].material)

    return [task for task in tasks if task.material in matched_materials], popup_text


def identify_ppap_past_tasks(
    sap: SapSession,
    tasks: Sequence[MaterialTask],
) -> tuple[list[MaterialTask], str]:
    return identify_popup_material_tasks(sap, tasks, is_ppap_past_message)


def identify_existing_rfq_tasks(
    sap: SapSession,
    tasks: Sequence[MaterialTask],
) -> tuple[list[MaterialTask], str]:
    """Map an Existing-RFQ Message Display back to Excel tasks safely."""
    try:
        popup_rows = sap.popup_grid_rows("wnd[1]")
    except Exception:
        popup_rows = []

    # Build text from the already-read rows so we do not traverse the same COM
    # collection twice.
    parts: list[str] = []
    try:
        visible = sap.window_text("wnd[1]")
        if visible:
            parts.append(visible)
    except Exception:
        pass
    for popup_row in popup_rows:
        row_text = " | ".join(
            safe_text(value)
            for key, value in popup_row.items()
            if key != "__ROW_INDEX__" and safe_text(value)
        )
        if row_text:
            parts.append(row_text)
    popup_text = " | ".join(dict.fromkeys(parts))

    task_by_material = {task.material: task for task in tasks}
    matched_materials: set[str] = set()
    existing_message_seen = is_existing_rfq_message(popup_text)

    for popup_row in popup_rows:
        row_values = [
            safe_text(value)
            for key, value in popup_row.items()
            if key != "__ROW_INDEX__"
        ]
        row_text = " | ".join(value for value in row_values if value)
        row_is_existing = is_existing_rfq_message(row_text)
        existing_message_seen = existing_message_seen or row_is_existing
        if not row_is_existing:
            continue

        for value in row_values:
            normalized = normalize_material(value)
            if normalized in task_by_material:
                matched_materials.add(normalized)
        for material in task_by_material:
            if re.search(rf"(?<!\d){re.escape(material)}(?!\d)", row_text):
                matched_materials.add(material)

    if existing_message_seen:
        for material in task_by_material:
            if re.search(rf"(?<!\d){re.escape(material)}(?!\d)", popup_text):
                matched_materials.add(material)

        # A single-task popup makes the active material unambiguous. This fallback
        # is used only after the popup text itself has been recognized as the
        # Existing-RFQ message; it will not misclassify PPAP/Technology errors.
        if len(tasks) == 1 and not matched_materials:
            matched_materials.add(tasks[0].material)

    matched = [task for task in tasks if task.material in matched_materials]
    return matched, popup_text

def mark_existing_rfq_tasks(
    excel: ExcelStore,
    group: TaskGroup,
    tasks: Sequence[MaterialTask],
    popup_text: str,
) -> None:
    for task in tasks:
        user_message = f"物料 {task.material} 已经有RFQ，无需再次运行"
        print(f"   ⏭️ {user_message}")
        excel.write_status(
            [task.excel_row],
            batch_key=group.key,
            buyer_status="SKIPPED_EXISTING_RFQ",
            rfq_status="ALREADY_EXISTS",
            error_stage="EXISTING_RFQ",
            error_message=(
                f"{user_message}。SAP消息：{popup_text[:2500]}"
                if popup_text
                else user_message
            ),
        )
    excel.save()


def rematch_remaining_npl_tasks(
    sap: SapSession,
    npl_grid,
    group: TaskGroup,
    tasks: Sequence[MaterialTask],
) -> list[MaterialTask]:
    """Refresh SAP row indexes after returning from Message Display."""
    temporary_group = TaskGroup(key=group.key, tasks=list(tasks))
    matched, failed = match_exact_npl_rows(sap, npl_grid, temporary_group)
    if failed:
        failed_materials = ", ".join(task.material for task in failed)
        raise SapRpaError(
            "NPL_REMATCH",
            f"点击Continue后无法重新定位剩余物料：{failed_materials}",
        )
    return matched



def is_buyer_receipt_prerequisite_error(message: str) -> bool:
    normalized = re.sub(r"\s+", " ", safe_text(message)).strip().casefold()
    return (
        "vendor company view does not exist" in normalized
        or "company view does not exist" in normalized
    )


def identify_buyer_receipt_prerequisite_tasks(
    sap: SapSession,
    tasks: Sequence[MaterialTask],
) -> tuple[list[MaterialTask], str]:
    return identify_popup_material_tasks(
        sap,
        tasks,
        is_buyer_receipt_prerequisite_error,
    )


def mark_buyer_receipt_prerequisite_tasks(
    excel: ExcelStore,
    group: TaskGroup,
    tasks: Sequence[MaterialTask],
    popup_text: str,
) -> None:
    clean = re.sub(r"\s+", " ", safe_text(popup_text)).strip()
    for task in tasks:
        print(
            f"   ⏭️ Material={task.material} Vendor Company View缺失，"
            "记录后跳过并继续下一行"
        )
        excel.write_status(
            [task.excel_row],
            batch_key=group.key,
            buyer_status="PREREQUISITE_MASTER_DATA_ERROR",
            rfq_status="NOT_STARTED",
            error_stage="BUYER_RECEIPT_PREREQUISITE",
            error_message=clean[:3000],
        )
    excel.save()


def create_buyer_receipt_skipping_existing_rfq(
    sap: SapSession,
    excel: ExcelStore,
    group: TaskGroup,
    npl_grid,
    matched_tasks: Sequence[MaterialTask],
) -> tuple[
    Optional[Any],
    list[MaterialTask],
    list[MaterialTask],
    list[MaterialTask],
    list[MaterialTask],
]:
    """Create Buyer Receipt and skip known non-fatal business-data errors."""
    active_tasks = list(matched_tasks)
    skipped_existing: list[MaterialTask] = []
    skipped_ppap: list[MaterialTask] = []
    skipped_prerequisite: list[MaterialTask] = []
    attempts = 0

    while active_tasks:
        attempts += 1
        if attempts > len(matched_tasks) + 3:
            raise SapRpaError(
                "CREATE_BUYER_RECEIPT",
                "处理Existing RFQ提示时重试次数异常，已停止以避免循环",
            )

        sap.select_rows(
            npl_grid,
            [int(task.npl_row) for task in active_tasks if task.npl_row is not None],
        )
        try:
            before_title = safe_text(sap.find("wnd[0]").Text)
        except Exception:
            before_title = ""

        sap.press(ID_CREATE_BUYER_RECEIPT)

        transition_deadline = time.time() + min(10.0, SAP_WAIT_SEC)
        while time.time() < transition_deadline:
            if sap.exists("wnd[1]"):
                break
            try:
                current_title = safe_text(sap.find("wnd[0]").Text)
            except Exception:
                current_title = ""
            if (
                "buyer receipt" in current_title.casefold()
                or (before_title and current_title and current_title != before_title)
            ):
                break
            time.sleep(SAP_POLL_SEC)

        if sap.exists("wnd[1]"):
            existing_tasks, popup_text = identify_existing_rfq_tasks(sap, active_tasks)

            if existing_tasks and SKIP_EXISTING_RFQ_ROWS:
                mark_existing_rfq_tasks(excel, group, existing_tasks, popup_text)
                skipped_existing.extend(existing_tasks)

                if not sap.dismiss_message_display():
                    raise SapRpaError(
                        "EXISTING_RFQ_CONTINUE",
                        "识别到Existing RFQ，但无法点击Message Display中的Continue",
                    )

                existing_materials = {task.material for task in existing_tasks}
                active_tasks = [
                    task for task in active_tasks if task.material not in existing_materials
                ]

                if not CONTINUE_AFTER_EXISTING_RFQ:
                    return None, [], skipped_existing, skipped_ppap, skipped_prerequisite
                if not active_tasks:
                    print("   ℹ️ 当前处理单元物料已有RFQ，继续Excel下一行")
                    return None, [], skipped_existing, skipped_ppap, skipped_prerequisite

                npl_grid = sap.wait_grid_columns(
                    ID_GRID_CUSTOMER1,
                    [COL_MATERIAL],
                    timeout=SAP_LONG_WAIT_SEC,
                )
                active_tasks = rematch_remaining_npl_tasks(
                    sap,
                    npl_grid,
                    group,
                    active_tasks,
                )
                print(
                    "   ▶ 已点击Continue；重新选择剩余物料："
                    + ", ".join(task.material for task in active_tasks)
                )
                continue

            ppap_tasks, ppap_popup_text = identify_ppap_past_tasks(sap, active_tasks)
            if ppap_tasks:
                # Fallback only: SAP raised the PPAP error before the Buyer Receipt
                # grid could be inspected. Do not read or modify the external NPL row.
                current_values = {
                    task.material: "<Create Buyer Receipt弹窗提示日期过期>"
                    for task in ppap_tasks
                }
                mark_ppap_input_required(
                    excel,
                    group,
                    ppap_tasks,
                    current_values,
                    ppap_popup_text,
                )
                skipped_ppap.extend(ppap_tasks)

                if not sap.dismiss_message_display():
                    raise SapRpaError(
                        "PPAP_DATE_CONTINUE",
                        "识别到PPAP Target Date过期，但无法点击Message Display中的Continue",
                    )
                print("   ✅ 已点击Continue；PPAP日期过期物料已跳过")

                ppap_materials = {task.material for task in ppap_tasks}
                active_tasks = [
                    task for task in active_tasks if task.material not in ppap_materials
                ]
                if not CONTINUE_AFTER_PPAP_DATE_ERROR:
                    return None, [], skipped_existing, skipped_ppap, skipped_prerequisite
                if not active_tasks:
                    print("   ℹ️ 当前处理单元需要新的PPAP Date，继续Excel下一行")
                    return None, [], skipped_existing, skipped_ppap, skipped_prerequisite

                npl_grid = sap.wait_grid_columns(
                    ID_GRID_CUSTOMER1,
                    [COL_MATERIAL],
                    timeout=SAP_LONG_WAIT_SEC,
                )
                active_tasks = rematch_remaining_npl_tasks(
                    sap,
                    npl_grid,
                    group,
                    active_tasks,
                )
                continue

            prereq_tasks, prereq_popup_text = identify_buyer_receipt_prerequisite_tasks(
                sap,
                active_tasks,
            )
            if prereq_tasks:
                mark_buyer_receipt_prerequisite_tasks(
                    excel,
                    group,
                    prereq_tasks,
                    prereq_popup_text,
                )
                skipped_prerequisite.extend(prereq_tasks)

                if not sap.dismiss_message_display():
                    raise SapRpaError(
                        "BUYER_RECEIPT_PREREQUISITE_CONTINUE",
                        "识别到Vendor Company View缺失，但无法点击Continue",
                    )

                prereq_materials = {task.material for task in prereq_tasks}
                active_tasks = [
                    task for task in active_tasks
                    if task.material not in prereq_materials
                ]

                if not active_tasks:
                    print(
                        "   ✅ 已点击Continue；当前Material已跳过，"
                        "继续Excel下一行"
                    )
                    return (
                        None,
                        [],
                        skipped_existing,
                        skipped_ppap,
                        skipped_prerequisite,
                    )

                sap.recover_npl_selection_screen()
                temp_group = TaskGroup(key=group.key, tasks=list(active_tasks))
                npl_grid = sap._execute_npl_query(temp_group)
                active_tasks = rematch_remaining_npl_tasks(
                    sap,
                    npl_grid,
                    group,
                    active_tasks,
                )
                continue

            # Unknown Message Display: stop safely instead of guessing.
            message = (
                popup_text
                or sap.popup_message_text("wnd[1]")
                or "Create Buyer Receipt出现Message Display"
            )
            sap.dismiss_message_display()
            for task in active_tasks:
                excel.write_status(
                    [task.excel_row],
                    buyer_status="NPL_MANDATORY_DATA_MISSING",
                    rfq_status="NOT_STARTED",
                    error_stage="CREATE_BUYER_RECEIPT",
                    error_message=message[:3000],
                )
            excel.save()
            raise SapRpaError("CREATE_BUYER_RECEIPT", message)

        buyer_grid = sap.wait_grid_columns(
            ID_GRID_CUSTOMER1,
            [COL_MATERIAL, COL_12MR_QTY, COL_RFQ_QTY_PROTOTYPE],
            timeout=SAP_LONG_WAIT_SEC,
        )
        return buyer_grid, active_tasks, skipped_existing, skipped_ppap, skipped_prerequisite

    return None, [], skipped_existing, skipped_ppap, skipped_prerequisite

def try_resume_saved_buyer_receipt(
    sap: SapSession,
    group: TaskGroup,
) -> Optional[tuple[Any, list[MaterialTask], dict[str, str]]]:
    """Resume a saved green Buyer Receipt left open by a prior stopped run."""
    if not RESUME_SAVED_BUYER_RECEIPT or DRY_RUN:
        return None

    try:
        title = safe_text(sap.find("wnd[0]").Text)
    except Exception:
        title = ""
    if "buyer receipt" not in title.casefold():
        return None

    grid = sap.find(ID_GRID_CUSTOMER1, required=False)
    if grid is None:
        return None
    required_columns = [COL_MATERIAL, COL_RFQ_QTY_PROTOTYPE, COL_RFQ_QTY_SERIAL]
    if not all(sap.column_exists(grid, column) for column in required_columns):
        return None

    mapping, _ = sap.map_material_rows(grid, group.tasks)
    debug_by_material: dict[str, str] = {}
    resumed_tasks: list[MaterialTask] = []

    for task in group.tasks:
        rows = mapping.get(task.material, [])
        if len(rows) != 1:
            return None
        task.buyer_receipt_row = rows[0]
        is_green, debug = green_status_debug(sap, grid, rows[0])
        debug_by_material[task.material] = debug
        if not is_green:
            return None
        resumed_tasks.append(task)

    print(
        "   ♻️ 检测到当前已打开且保存为绿色的Buyer Receipt，"
        "直接继续Create RFQ："
        + ", ".join(task.material for task in resumed_tasks)
    )
    return grid, resumed_tasks, debug_by_material



def complete_rfq_from_buyer_receipt(
    sap: SapSession,
    excel: ExcelStore,
    group: TaskGroup,
    buyer_grid,
    successful_buyer_tasks: Sequence[MaterialTask],
    skipped_existing: Sequence[MaterialTask] = (),
    skipped_ppap: Sequence[MaterialTask] = (),
    blocked_ppap: Sequence[MaterialTask] = (),
    skipped_prerequisite: Sequence[MaterialTask] = (),
) -> tuple[str, str]:
    # -------------------------------------------------------------------------
    # Step 3: Continue RFQ immediately after Buyer Receipt save.
    # PROD recording: CUSTOMER1 -> LIFNRx_CB -> select row -> btn[19].
    # QA legacy path: btn[2] -> CUSTOMER2 -> btn[9] -> RFQ grid.
    # -------------------------------------------------------------------------
    if SAP_TARGET_ENV == "PROD" and PROD_DIRECT_RFQ_AFTER_BUYER_RECEIPT:
        rfq_grid, rfq_tasks = prepare_prod_direct_rfq_rows(
            sap,
            buyer_grid,
            successful_buyer_tasks,
        )
        terminal_success = ""
    else:
        rfq_grid, terminal_success = open_rfq_creation_from_buyer_receipt(
            sap,
            buyer_grid,
            successful_buyer_tasks,
        )

        # QA 321 terminal condition: bottom-left status bar says
        # "Data copied Successfully and email sent".
        if terminal_success:
            for task in successful_buyer_tasks:
                excel.write_status(
                    [task.excel_row],
                    rfq_status="SUCCESS",
                    rfq_number="",
                    error_stage="",
                    error_message="",
                )
            excel.save()
            print(
                "   🎉 RFQ流程已完成（SAP状态栏终态成功）："
                f"{terminal_success}"
            )
            return "SUCCESS", ""

        if rfq_grid is None:
            raise SapRpaError(
                "RFQ_GRID_MATCH",
                "未取得RFQ Grid，且没有检测到终态成功消息",
            )

        rfq_tasks = fill_rfq_grid_rows(sap, rfq_grid, successful_buyer_tasks)
    rfq_task_materials = {task.material for task in rfq_tasks}

    for task in successful_buyer_tasks:
        if task.material not in rfq_task_materials:
            excel.write_status(
                [task.excel_row],
                rfq_status="RFQ_ROW_MATCH_ERROR",
                error_stage="RFQ_GRID_MATCH",
                error_message="RFQ Creation Grid无法唯一匹配Material",
            )

    if not rfq_tasks:
        excel.save()
        raise SapRpaError("RFQ_GRID_MATCH", "RFQ Creation Grid无有效Material")

    for task in rfq_tasks:
        excel.write_status(
            [task.excel_row],
            rfq_row=task.rfq_row,
            rfq_status="READY_TO_CREATE",
        )
    excel.save()

    sap.select_rows(
        rfq_grid,
        [int(task.rfq_row) for task in rfq_tasks if task.rfq_row is not None],
    )
    if SAP_TARGET_ENV == "PROD" and PROD_DIRECT_RFQ_AFTER_BUYER_RECEIPT:
        press_prod_open_detailed_rfq(sap)
    else:
        sap.press(ID_OPEN_DETAILED_RFQ)
    handle_preferred_supplier_warning(sap, group.allow_without_preferred)

    fill_detailed_rfq_header(sap, group)
    sap.press(ID_CREATE_RFQ_FINAL)
    popup_rfq_number, popup_success_message = process_final_rfq_popups(sap, group)
    sap.raise_on_status_error("RFQ_FINAL_SAVE")

    rfq_number = popup_rfq_number or extract_rfq_number(sap)
    if not rfq_number and popup_success_message:
        rfq_number, _ = extract_created_rfq_from_text(popup_success_message)

    if not rfq_number:
        # PROD may finish with the configured terminal success status instead of
        # leaving an RFQ number visible on the current screen.
        terminal_success = (
            popup_success_message
            or rfq_terminal_success_message(sap)
        )
        if terminal_success:
            for task in rfq_tasks:
                excel.write_status(
                    [task.excel_row],
                    rfq_status="SUCCESS",
                    rfq_number="",
                    error_stage="",
                    error_message="",
                )
            excel.save()
            print(
                "   🎉 RFQ流程终态成功（未显示RFQ Number）："
                f"{terminal_success}"
            )
            if SAP_TARGET_ENV == "PROD":
                return_to_npl_start_after_rfq(
                    sap,
                    max_back_steps=RFQ_SUCCESS_BACK_STEPS,
                )
            return "SUCCESS", ""

        visible_text = sap.collect_all_visible_text()
        for task in rfq_tasks:
            excel.write_status(
                [task.excel_row],
                rfq_status="CREATED_NUMBER_NOT_FOUND",
                error_stage="RFQ_NUMBER",
                error_message=(
                    "系统可能已创建RFQ，但RPA未能提取RFQ Number。"
                    f"页面信息：{visible_text[:2500]}"
                ),
            )
        excel.save()
        raise SapRpaError(
            "RFQ_NUMBER",
            "RFQ创建流程完成，但未提取到RFQ Number，且未检测到配置的终态成功消息；"
            "请先人工核查，避免重复创建",
        )

    for task in rfq_tasks:
        excel.write_status(
            [task.excel_row],
            rfq_status="SUCCESS",
            rfq_number=rfq_number,
            error_stage="",
            error_message="",
        )
    excel.save()
    print(
        f"   📝 RFQ Number已写入Excel最后状态列：{rfq_number}"
    )

    if SAP_TARGET_ENV == "PROD":
        return_to_npl_start_after_rfq(
            sap,
            max_back_steps=RFQ_SUCCESS_BACK_STEPS,
        )

    if skipped_existing or skipped_ppap or blocked_ppap or skipped_prerequisite:
        notes: list[str] = []
        if skipped_existing:
            notes.append(
                "Existing RFQ=" + ", ".join(task.material for task in skipped_existing)
            )
        if skipped_prerequisite:
            notes.append(
                "Vendor Company View缺失="
                + ", ".join(task.material for task in skipped_prerequisite)
            )
        ppap_skips = list({task.material: task for task in [*skipped_ppap, *blocked_ppap]}.values())
        if ppap_skips:
            notes.append(
                "PPAP Date待补充=" + ", ".join(task.material for task in ppap_skips)
            )
        print(
            f"   🎉 Group={group.key} RFQ创建成功：{rfq_number} | "
            + " | ".join(notes)
        )
        return "SUCCESS_WITH_SKIPS", rfq_number

    print(f"   🎉 Group={group.key} RFQ创建成功：{rfq_number}")
    return "SUCCESS", rfq_number



def process_group(
    sap: SapSession,
    excel: ExcelStore,
    group: TaskGroup,
) -> tuple[str, str]:
    # Recover cleanly when a previous run stopped with Message Display open.
    # The exact Continue control comes from the user's VBS recording.
    if sap.exists("wnd[1]"):
        stale_popup = sap.popup_message_text("wnd[1]")
        if (
            is_existing_rfq_message(stale_popup)
            or is_ppap_past_message(stale_popup)
            or is_buyer_receipt_prerequisite_error(stale_popup)
        ):
            if is_existing_rfq_message(stale_popup):
                popup_kind = "Existing RFQ"
            elif is_ppap_past_message(stale_popup):
                popup_kind = "PPAP Date"
            else:
                popup_kind = "Vendor Company View缺失"

            print(
                f"   🧹 检测到上次遗留的{popup_kind} Message Display，"
                "先点击Continue"
            )
            if not sap.dismiss_message_display():
                raise SapRpaError(
                    "STALE_POPUP",
                    f"检测到遗留{popup_kind}弹窗，但无法点击Continue",
                )
        else:
            raise SapRpaError(
                "STALE_POPUP",
                "SAP当前存在未处理的模态弹窗，请先人工确认。弹窗内容："
                + (stale_popup[:1000] or "<无法读取弹窗文本>"),
            )

    all_rows = [task.excel_row for task in group.tasks]
    excel.write_status(
        all_rows,
        batch_key=group.key,
        buyer_status="RUNNING",
        rfq_status="RUNNING",
        error_stage="",
        error_message="",
    )
    excel.save()

    print("\n" + "=" * 80)
    print(
        f"▶ Group={group.key} | Plant={group.plant} | Project={group.project} "
        f"| Materials={len(group.tasks)}"
    )
    print("   " + ", ".join(task.material for task in group.tasks))

    resumed = try_resume_saved_buyer_receipt(sap, group)
    if resumed is not None:
        buyer_grid, successful_buyer_tasks, resume_debug = resumed
        for task in successful_buyer_tasks:
            excel.write_status(
                [task.excel_row],
                buyer_row=task.buyer_receipt_row,
                buyer_status="SUCCESS",
                rfq_status="READY_TO_CREATE",
                error_stage="",
                error_message=(
                    "已从当前绿色Buyer Receipt页面恢复；"
                    + resume_debug.get(task.material, "")
                ),
            )
        excel.save()
        return complete_rfq_from_buyer_receipt(
            sap, excel, group, buyer_grid, successful_buyer_tasks
        )

    # -------------------------------------------------------------------------
    # Step 1: Query NPL and exact-match materials.
    # -------------------------------------------------------------------------
    npl_grid = sap.prepare_npl_grid_for_group(group)

    matched_tasks, npl_failed = match_exact_npl_rows(sap, npl_grid, group)

    for task in npl_failed:
        excel.write_status(
            [task.excel_row],
            batch_key=group.key,
            buyer_status="NPL_MATCH_ERROR",
            rfq_status="NOT_STARTED",
            error_stage="NPL_MATCH",
            error_message="NPL中未找到唯一的Plant+Project+Material匹配行",
        )

    if not matched_tasks:
        excel.save()
        raise SapRpaError("NPL_MATCH", "本Group没有任何Material通过NPL精确匹配")

    for task in matched_tasks:
        excel.write_status(
            [task.excel_row],
            npl_row=task.npl_row,
            buyer_status="NPL_MATCHED",
        )
    excel.save()

    # PPAP is intentionally NOT inspected or modified in the NPL result grid.
    # It will be checked only after Create Buyer Receipt opens its own grid.
    blocked_ppap: list[MaterialTask] = []

    if DRY_RUN:
        for task in matched_tasks:
            excel.write_status(
                [task.excel_row],
                buyer_status="DRY_RUN_NPL_MATCHED",
                rfq_status="DRY_RUN_NOT_CREATED",
            )
        excel.save()
        print("   🧪 DRY_RUN=true：NPL匹配完成，未创建Buyer Receipt/RFQ")
        return "DRY_RUN", ""

    # -------------------------------------------------------------------------
    # Step 2: Multi-select NPL rows and create Buyer Receipt.
    # Existing RFQ is a non-fatal skip: mark that material, click Continue,
    # then keep processing the remaining materials and following Excel groups.
    # -------------------------------------------------------------------------
    (
        buyer_grid,
        create_tasks,
        skipped_existing,
        skipped_ppap,
        skipped_prerequisite,
    ) = create_buyer_receipt_skipping_existing_rfq(
        sap,
        excel,
        group,
        npl_grid,
        matched_tasks,
    )

    if not create_tasks or buyer_grid is None:
        if skipped_prerequisite:
            return "SKIPPED_BUYER_RECEIPT_PREREQUISITE", ""
        if skipped_ppap:
            return "INPUT_REQUIRED_PPAP_DATE", ""
        return "SKIPPED_EXISTING_RFQ", ""

    matched_tasks = create_tasks

    # Check PPAP Target Date on the Buyer Receipt screen—not in the NPL result.
    matched_tasks, blocked_ppap = validate_and_apply_buyer_receipt_ppap_dates(
        sap,
        excel,
        group,
        buyer_grid,
        matched_tasks,
    )
    skipped_ppap.extend(blocked_ppap)
    if not matched_tasks:
        print("   ℹ️ Buyer Receipt中的PPAP Date需要更新，继续Excel下一行")
        return "INPUT_REQUIRED_PPAP_DATE", ""

    buyer_tasks = fill_buyer_receipt_rows(sap, buyer_grid, matched_tasks)
    buyer_task_materials = {task.material for task in buyer_tasks}
    for task in matched_tasks:
        if task.material not in buyer_task_materials:
            excel.write_status(
                [task.excel_row],
                buyer_status="BUYER_RECEIPT_ROW_MATCH_ERROR",
                rfq_status="NOT_STARTED",
                error_stage="BUYER_RECEIPT_MATCH",
                error_message="Buyer Receipt页面无法唯一匹配Material",
            )

    if not buyer_tasks:
        excel.save()
        raise SapRpaError("BUYER_RECEIPT_MATCH", "Buyer Receipt页面无有效Material")

    for task in buyer_tasks:
        excel.write_status(
            [task.excel_row],
            buyer_row=task.buyer_receipt_row,
            buyer_status="READY_TO_SAVE",
        )
    excel.save()

    try:
        successful_buyer_tasks, icon_debug, buyer_grid = save_buyer_receipt(
            sap,
            buyer_grid,
            buyer_tasks,
        )
    except SapRpaError as exc:
        if (
            exc.stage == "BUYER_RECEIPT_SAVE_POPUP"
            and CONTINUE_AFTER_BUYER_RECEIPT_MASTER_DATA_ERROR
            and is_recoverable_buyer_receipt_master_data_error(exc.message)
        ):
            clean_message = safe_text(exc.message)
            print(
                "   ⚠️ Buyer Receipt无法保存，识别到可跳过的主数据错误："
                + clean_message
            )

            # Write the error to Excel before navigating away.
            for task in buyer_tasks:
                excel.write_status(
                    [task.excel_row],
                    batch_key=group.key,
                    buyer_status="MASTER_DATA_ERROR",
                    rfq_status="NOT_STARTED",
                    error_stage="BUYER_RECEIPT_MASTER_DATA",
                    error_message=clean_message[:3000],
                )
            excel.save()

            # Exact recorded recovery: Continue -> Back -> Back.
            recover_after_buyer_receipt_master_data_error(
                sap,
                back_steps=BUYER_RECEIPT_ERROR_BACK_STEPS,
            )

            print(
                "   ⏭️ 当前Material已记录主数据错误，"
                "继续处理Excel下一行"
            )
            return "SKIPPED_BUYER_RECEIPT_MASTER_DATA", ""

        raise

    successful_materials = {task.material for task in successful_buyer_tasks}

    for task in buyer_tasks:
        if task.material in successful_materials:
            excel.write_status(
                [task.excel_row],
                buyer_status="SUCCESS",
                error_stage="",
                error_message="",
            )
        else:
            excel.write_status(
                [task.excel_row],
                buyer_status="STATUS_NOT_GREEN",
                rfq_status="NOT_STARTED",
                error_stage="BUYER_RECEIPT_SAVE",
                error_message=icon_debug.get(task.material, "状态未识别"),
            )
    excel.save()

    if not successful_buyer_tasks:
        raise SapRpaError(
            "BUYER_RECEIPT_SAVE",
            "没有任何Buyer Receipt行通过绿色状态校验",
        )

    return complete_rfq_from_buyer_receipt(
        sap,
        excel,
        group,
        buyer_grid,
        successful_buyer_tasks,
        skipped_existing,
        skipped_ppap,
        blocked_ppap,
        skipped_prerequisite,
    )


# =============================================================================
# 9. CSV logging
# =============================================================================


def create_csv_log(path: Path):
    log_path = path.with_name(
        f"{path.stem}_BuyerReceipt_RFQ_RPA_{dt.datetime.now():%Y%m%d_%H%M%S}.csv"
    )
    handle = open(log_path, "w", newline="", encoding="utf-8-sig")
    writer = csv.DictWriter(
        handle,
        fieldnames=[
            "Timestamp",
            "Batch Key",
            "Plant",
            "MPP Project No.",
            "Materials",
            "Excel Rows",
            "Status",
            "RFQ Number",
            "Error Stage",
            "Error Message",
        ],
    )
    writer.writeheader()
    handle.flush()
    return handle, writer, log_path


def append_group_log(
    handle,
    writer,
    group: TaskGroup,
    *,
    status: str,
    rfq_number: str = "",
    error_stage: str = "",
    error_message: str = "",
) -> None:
    writer.writerow(
        {
            "Timestamp": now_text(),
            "Batch Key": group.key,
            "Plant": group.plant,
            "MPP Project No.": group.project,
            "Materials": ";".join(task.material for task in group.tasks),
            "Excel Rows": ";".join(str(task.excel_row) for task in group.tasks),
            "Status": status,
            "RFQ Number": rfq_number,
            "Error Stage": error_stage,
            "Error Message": error_message,
        }
    )
    handle.flush()


# =============================================================================
# 10. Main
# =============================================================================


def print_expected_headers() -> None:
    print("\nExcel建议表头：")
    print(
        "Batch Group | Plant | MPP Project No. | Material No. | Supplier Parma | "
        "12 MR Qty | RFQ Qty Prototype | RFQ Qty Serial | Technology | PPAP Date | "
        "Supplier Email(E列) | Quotation Due Date(F列) | AFM Request | Cost Breakdown | "
        "Allow Without Preferred Supplier | Attach File | RFQ Comment"
    )
    print("Vendor2~Vendor5及其Cost Breakdown/Email列为可选。")


def standalone_main() -> None:
    print("=" * 80)
    print("SAP NPL -> Buyer Receipt -> RFQ RPA v32 (Auto Date Normalize + Parma Group)")
    print("=" * 80)
    print(f"ENV file: {ENV_PATH}")
    print(f"ENV exists: {ENV_PATH.exists()}")
    print(f"Excel: {EXCEL_PATH}")
    print(f"Sheet: {SHEET_NAME or '<active>'}")
    print(f"DRY_RUN: {DRY_RUN}")
    print(f"TEST_GROUP_LIMIT: {TEST_GROUP_LIMIT or 'ALL'}")
    print(f"MAX_MATERIALS_PER_GROUP: {MAX_MATERIALS_PER_GROUP}")
    print(
        "RFQ grouping: "
        f"GroupByParma={GROUP_RFQ_BY_PARMA} | "
        f"Key=Plant+Project+Parma | "
        f"PROCESS_MODE={PROCESS_MODE} (ignored when GroupByParma=True) | "
        f"MaxMaterialsPerRFQ={MAX_MATERIALS_PER_GROUP}"
    )
    print(
        "Excel date normalization: "
        "AUTO | PPAP Date + RFQ Due Date | "
        "supports YYYY-MM-DD / YYYY.MM.DD / DD.MM.YYYY / Excel date cells"
    )
    print(
        "PROD RFQ continuation: "
        f"DirectAfterBR={PROD_DIRECT_RFQ_AFTER_BUYER_RECEIPT} | "
        f"DueDateExcelCol={RFQ_DUE_DATE_EXCEL_COL}(F=6) | "
        f"SupplierEmailExcelCol={SUPPLIER_EMAIL_EXCEL_COL}(E=5) | "
        f"CalendarPicker=DISABLED(direct-write)"
    )
    print(
        "PROD RFQ popup mode: DynamicTitleAware | "
        f"StepTimeout={PROD_RFQ_POPUP_STEP_TIMEOUT_SEC:.1f}s | "
        f"NextPopupWait={PROD_RFQ_NEXT_POPUP_WAIT_SEC:.1f}s | "
        f"PostClickWait={PROD_RFQ_POPUP_POST_CLICK_SEC:.1f}s | "
        f"Retries={PROD_RFQ_POPUP_CLICK_RETRIES}"
    )
    print(
        "PROD RFQ success recovery: "
        f"CaptureFinalPopupRFQ=True | "
        f"WriteExcelBeforeBack=True | "
        f"ImmediateBackSteps={RFQ_SUCCESS_BACK_STEPS}"
    )
    print(f"Require green Buyer Receipt status: {REQUIRE_GREEN_BUYER_RECEIPT}")
    print(
        "Buyer Receipt save guard: "
        f"RequireConfirm={REQUIRE_BUYER_SAVE_CONFIRMATION} | "
        f"Method=FreshDirectPressOnly | "
        f"ConfirmWait={BUYER_SAVE_CONFIRM_TIMEOUT_SEC:.1f}s | "
        f"ClickRetries={BUYER_SAVE_CLICK_RETRIES} | "
        f"ClickRetryWait={BUYER_SAVE_CLICK_RETRY_SEC:.1f}s | "
        f"PopupCloseWait={BUYER_SAVE_POPUP_CLOSE_TIMEOUT_SEC:.1f}s | "
        f"GreenWait={BUYER_GREEN_STATUS_TIMEOUT_SEC:.1f}s | "
        f"GreenTokens={','.join(sorted(BUYER_GREEN_ICON_TOKENS))} | "
        f"ResumeSavedBR={RESUME_SAVED_BUYER_RECEIPT}"
    )
    print(
        "RFQ terminal success: "
        f"Enabled={RFQ_STATUS_SUCCESS_ENABLED} | "
        f"Envs={sorted(RFQ_STATUS_SUCCESS_ENVIRONMENTS)} | "
        f"Messages={RFQ_STATUS_SUCCESS_MESSAGES} | "
        f"Wait={RFQ_POST_INTERMEDIATE_WAIT_SEC:.1f}s"
    )
    print(
        "PPAP date guard: "
        f"Check={PPAP_DATE_CHECK_ENABLED} | "
        f"ApplyExcelToBuyerReceipt={AUTO_APPLY_EXCEL_PPAP_TO_BUYER_RECEIPT} | "
        f"MinDaysAhead={PPAP_MIN_DAYS_AHEAD} | "
        f"ContinueNext={CONTINUE_AFTER_PPAP_DATE_ERROR}"
    )
    print(
        "NPL transaction reuse: "
        f"Reuse={REUSE_NPL_TRANSACTION} | "
        f"Strict={NPL_STRICT_REUSE} | "
        f"BackSteps={NPL_MAX_BACK_STEPS} | "
        f"WaitEachBack={NPL_BACK_SCREEN_WAIT_SEC:.1f}s | "
        f"FallbackRestart={NPL_FALLBACK_RESTART}"
    )
    print(
        "NPL lookup mode: "
        f"SingleExact={NPL_EXACT_MATERIAL_QUERY} | "
        f"MultiMaterialClipboard={NPL_MULTI_MATERIAL_QUERY}"
    )
    print(
        "Same-project NPL fast reuse: "
        f"Enabled={REUSE_SAME_PROJECT_NPL_RESULTS} | "
        f"Effective={'IGNORED while exact single/multi Material filter is enabled' if (NPL_EXACT_MATERIAL_QUERY or NPL_MULTI_MATERIAL_QUERY) else 'ACTIVE'}"
    )
    print(
        "Existing RFQ handling: "
        f"Skip={SKIP_EXISTING_RFQ_ROWS} | "
        f"ContinueRemaining={CONTINUE_AFTER_EXISTING_RFQ}"
    )
    print(
        "Buyer Receipt master-data recovery: "
        f"Enabled={CONTINUE_AFTER_BUYER_RECEIPT_MASTER_DATA_ERROR} | "
        f"Sequence=Continue->Backx{BUYER_RECEIPT_ERROR_BACK_STEPS}"
    )
    print(
        "Buyer Receipt Save popup mode: "
        "NormalYesNo OR ImmediateMessageDisplay"
    )
    print(
        "SAP auto launch/target: "
        f"AutoLaunch={SAP_AUTO_LAUNCH} | "
        f"Environment={SAP_TARGET_ENV} | "
        f"Connection={SAP_TARGET_CONNECTION_NAME}"
    )
    print(
        "SAP environment guard: "
        f"{SAP_ENVIRONMENT_GUARD} | "
        f"Expected System={EXPECTED_SAP_SYSTEM or '<optional>'} | "
        f"Client={EXPECTED_SAP_CLIENT or '<optional>'} | "
        f"ProductionWriteAllowed={ALLOW_PRODUCTION_WRITE}"
    )
    print(
        "Excel lock fallback: "
        f"{EXCEL_LOCK_FALLBACK_ENABLED} | "
        f"COM sync={SYNC_STATUS_TO_OPEN_EXCEL}"
    )

    excel: Optional[ExcelStore] = None
    log_handle = None

    try:
        excel = ExcelStore(EXCEL_PATH, SHEET_NAME)
        if excel.backup_path:
            print(f"Excel备份: {excel.backup_path}")
        print(f"Excel当前结果保存目标: {excel.output_path}")

        tasks = excel.load_tasks()
        groups = build_groups(tasks)

        if TEST_GROUP_LIMIT > 0:
            groups = groups[:TEST_GROUP_LIMIT]

        print(f"有效Material行: {len(tasks)}")
        print(f"最终RFQ Group数: {len(groups)}")
        print("📦 v32分组规则：同Plant + 同Project + 同Parma = 同一个RFQ")
        for idx, grp in enumerate(groups, start=1):
            print(
                f"   Group {idx}: Parma={grp.vendors[0]} | "
                f"Plant={grp.plant} | Project={grp.project} | "
                f"Materials={len(grp.tasks)}"
            )
            print(
                "      ExcelRows="
                + ",".join(str(t.excel_row) for t in grp.tasks)
                + " | Materials="
                + ",".join(t.material for t in grp.tasks)
            )

        if not groups:
            print("没有需要处理的Group。")
            return

        log_handle, log_writer, log_path = create_csv_log(EXCEL_PATH)
        print(f"CSV日志: {log_path}")

        sap = SapSession()

        summary: dict[str, int] = defaultdict(int)

        for position, group in enumerate(groups, start=1):
            if STOP_REQUESTED:
                print("⛔ 停止领取新Group。")
                break

            print(f"\n📦 Group进度 {position}/{len(groups)}")

            try:
                status, rfq_number = process_group(sap, excel, group)
                summary[status] += 1
                append_group_log(
                    log_handle,
                    log_writer,
                    group,
                    status=status,
                    rfq_number=rfq_number,
                )

            except SapRpaError as exc:
                summary["ERROR"] += 1
                print(f"❌ Group={group.key} 失败 | Stage={exc.stage} | {exc.message}")

                unresolved_rows = [
                    task.excel_row
                    for task in group.tasks
                    if excel.current_rfq_status(task.excel_row) not in {
                        "SUCCESS",
                        "ALREADY_EXISTS",
                        "VALIDATION_ERROR",
                        "NPL_MATCH_ERROR",
                    }
                ]
                excel.write_status(
                    unresolved_rows,
                    batch_key=group.key,
                    rfq_status="ERROR",
                    error_stage=exc.stage,
                    error_message=exc.message[:3000],
                )
                excel.save()

                append_group_log(
                    log_handle,
                    log_writer,
                    group,
                    status="ERROR",
                    error_stage=exc.stage,
                    error_message=exc.message,
                )

                # Safety: if Buyer Receipt was already saved successfully but RFQ
                # continuation failed, do not automatically start the next Excel row.
                # Otherwise same-project "one Back" can run from the wrong screen and
                # risks confusing the recovery state / creating duplicates.
                buyer_saved = any(
                    safe_text(
                        excel.worksheet.cell(
                            task.excel_row,
                            excel.status_columns["Buyer Receipt Status"],
                        ).value
                    ).upper() == "SUCCESS"
                    for task in group.tasks
                )
                if buyer_saved:
                    print(
                        "⛔ 当前Group的Buyer Receipt已经保存成功，但RFQ尚未完成。"
                        "为避免下一行从错误SAP页面继续，已停止后续Group。"
                    )
                    print(
                        "   修复后直接重新运行即可；如果SAP仍停留在绿色Buyer Receipt页面，"
                        "RESUME_SAVED_BUYER_RECEIPT=true 会优先从该页面继续RFQ。"
                    )
                    break

            except Exception as exc:
                summary["ERROR"] += 1
                message = f"Unexpected error: {type(exc).__name__}: {exc}"
                print(f"💥 Group={group.key} 未预期异常：{message}")
                traceback.print_exc()
                unresolved_rows = [
                    task.excel_row
                    for task in group.tasks
                    if excel.current_rfq_status(task.excel_row) not in {
                        "SUCCESS",
                        "ALREADY_EXISTS",
                        "VALIDATION_ERROR",
                        "NPL_MATCH_ERROR",
                    }
                ]
                excel.write_status(
                    unresolved_rows,
                    batch_key=group.key,
                    rfq_status="ERROR",
                    error_stage="UNEXPECTED",
                    error_message=message[:3000],
                )
                excel.save()
                append_group_log(
                    log_handle,
                    log_writer,
                    group,
                    status="ERROR",
                    error_stage="UNEXPECTED",
                    error_message=message,
                )

                buyer_saved = any(
                    safe_text(
                        excel.worksheet.cell(
                            task.excel_row,
                            excel.status_columns["Buyer Receipt Status"],
                        ).value
                    ).upper() == "SUCCESS"
                    for task in group.tasks
                )
                if buyer_saved:
                    print(
                        "⛔ Buyer Receipt已保存成功但后续出现未预期错误；"
                        "为避免下一行从错误SAP页面继续，停止后续Group。"
                    )
                    break

        print("\n" + "=" * 80)
        print("运行结束")
        print("=" * 80)
        for key in sorted(summary):
            print(f"{key}: {summary[key]}")
        if excel is not None:
            print(f"Excel结果文件: {excel.output_path}")
            if excel.used_lock_fallback:
                print(
                    "ℹ️ 本次检测到源Excel锁。完整结果已持续保存到上述Result文件；"
                    "程序也会尝试同步到打开的源Excel。"
                )

    except FileNotFoundError as exc:
        print(f"❌ {exc}")
        print_expected_headers()
        raise SystemExit(2) from exc

    except ValueError as exc:
        print(f"❌ 配置/Excel错误：{exc}")
        print_expected_headers()
        raise SystemExit(2) from exc

    finally:
        if excel is not None:
            try:
                excel.save()
                excel.close()
            except Exception as exc:
                print(f"⚠️ 关闭Excel时出错：{exc}")
        if log_handle is not None:
            log_handle.close()


def main():
    if HUB_ARGS.hub:
        return run_hub(sys.modules[__name__], HUB_ARGS)
    standalone_main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
