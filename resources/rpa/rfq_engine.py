from __future__ import annotations

"""
SAP GUI RPA v14: NPL -> Buyer Receipt -> RFQ

Based on the SAP GUI Scripting recording supplied by the user.

Main design:
1. Read Excel by header name.
2. Group rows for batch/multi-selection.
3. Query ZMFM050072 by Plant + MPP Project No.
4. Match Excel Material against the actual NPL grid (not fixed row numbers).
5. Select one or many matched NPL rows and create Buyer Receipt.
6. Re-map Material in the Buyer Receipt grid, fill row-level data, save, and verify.
7. Without leaving the transaction, select the successful rows and create RFQ.
8. Re-map Material in each following grid, fill vendors/quantities/cost breakdown.
9. Fill RFQ due date and vendor e-mails, confirm creation, and extract RFQ number.
10. Validate PPAP Target Date only after entering the Buyer Receipt screen.
    When it is blank or earlier than today, use a valid Excel PPAP Date if supplied; otherwise mark
    the row as INPUT_REQUIRED_PPAP_DATE and continue with the next Excel row.
11. Default to ROW mode: one Excel material per SAP run unit. Existing-RFQ and
    PPAP-date messages are acknowledged with Continue and the next row starts.
12. Reuse ZMFM050072 between rows: return to its selection screen with Back
    instead of restarting the transaction for every material.
13. Optional BATCH mode remains available for multi-selection.
14. Write status/error details back to Excel after every group.

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

# Electron reads the frozen engine through pipes. Force UTF-8 so Chinese status
# messages and symbols never fail on Windows machines using a GBK console codepage.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import openpyxl
from openpyxl import Workbook

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    # .env support is optional. Environment variables and defaults still work.
    pass


# =============================================================================
# 1. Configuration
# =============================================================================

EXCEL_PATH = Path(
    os.getenv(
        "EXCEL_PATH",
        r"C:\Users\A533700\Downloads\Buyer_Receipt_RFQ_Input.xlsx",
    )
)
SHEET_NAME = os.getenv("SHEET_NAME", "RPA_Input").strip()
DATA_START_ROW = max(2, int(os.getenv("DATA_START_ROW", "2")))

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

# Recorded control IDs
TCODE_NPL = "ZMFM050072"
ID_COMMAND = "wnd[0]/tbar[0]/okcd"
ID_PLANT = "wnd[0]/usr/ctxtS_WERKS-LOW"
ID_MATERIAL = "wnd[0]/usr/ctxtS_MATNR-LOW"
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


def parse_date(value: Any, field_name: str, required: bool = False) -> str:
    """Return YYYY-MM-DD for SAP text fields."""
    if value is None or safe_text(value) == "":
        if required:
            raise ValueError(f"{field_name}不能为空")
        return ""

    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()

    text = safe_text(value)
    formats = [
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y%m%d",
        "%d.%m.%Y",
        "%m/%d/%Y",
        "%d/%m/%Y",
    ]
    for fmt in formats:
        try:
            return dt.datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue

    raise ValueError(f"{field_name}日期格式无法识别：{text!r}")


def yyyymmdd(date_text: str) -> str:
    if not date_text:
        return ""
    return dt.datetime.strptime(date_text, "%Y-%m-%d").strftime("%Y%m%d")


def parse_date_value(value: Any) -> Optional[dt.date]:
    """Best-effort parser for Excel/SAP date values."""
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value

    text = safe_text(value)
    if not text:
        return None

    formats = [
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y%m%d",
        "%d.%m.%Y",
        "%d/%m/%Y",
        "%m/%d/%Y",
    ]
    for fmt in formats:
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


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

        self.workbook = openpyxl.load_workbook(path)
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
            "quotation_due_date",
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
            f"{title}: 命中{score}/5"
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
        required = ["plant", "project", "material", "quotation_due_date", "vendor1"]
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
                "请至少提供 Plant、Project No.、Material No.、"
                "Quotation Due Date、Intended Supplier。"
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

                rfq_comment = safe_text(self.value(row, "rfq_comment"))
                if len(rfq_comment) > 200:
                    raise ValueError("RFQ Comment超过200字符")

                attach_file = parse_bool(self.value(row, "attach_file"), default=False)
                if attach_file:
                    raise ValueError(
                        "当前录制代码没有附件上传路径，Attach File只能填写No/False"
                    )

                task = MaterialTask(
                    excel_row=row,
                    material=material,
                    plant=normalize_identifier(self.value(row, "plant")).upper(),
                    project=normalize_identifier(self.value(row, "project")),
                    ppap_date=parse_date(
                        self.value(row, "ppap_date"),
                        "PPAP Target Date",
                        required=False,
                    ),
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
                    quotation_due_date=parse_date(
                        self.value(row, "quotation_due_date"),
                        "Quotation Due Date",
                        required=True,
                    ),
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
                    raise ValueError("Project No.不能为空")
                if not task.vendors[0]:
                    raise ValueError("Intended Supplier不能为空")
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


def automatic_group_signature(task: MaterialTask) -> tuple[Any, ...]:
    return (
        task.plant,
        task.project,
        task.quotation_due_date,
        tuple(task.vendors),
        tuple(task.cost_breakdown),
        tuple(tuple(v) for v in task.emails),
        task.allow_without_preferred,
        task.attach_file,
        task.rfq_comment,
    )


def validate_group_consistency(tasks: list[MaterialTask], key: str) -> None:
    if not tasks:
        return

    first_signature = automatic_group_signature(tasks[0])
    for task in tasks[1:]:
        if automatic_group_signature(task) != first_signature:
            raise ValueError(
                f"Batch Group={key!r}中存在不同的Plant/Project/Vendor/Email/"
                "Due Date/选项。一个RFQ Group的Header级信息必须一致。"
            )


def build_groups(tasks: list[MaterialTask]) -> list[TaskGroup]:
    """Build processing units according to PROCESS_MODE.

    ROW (default): every Excel row becomes an independent SAP unit. This is
    deliberately conservative: when row 1 already has an RFQ, the RPA clicks
    Continue, completes that unit as ALREADY_EXISTS, and then starts row 2.

    BATCH: preserve the original grouping/multi-selection behavior.
    """
    if PROCESS_MODE == "ROW":
        groups: list[TaskGroup] = []
        for position, task in enumerate(tasks, start=1):
            prefix = task.batch_group or "ROW"
            key = f"{prefix}-E{task.excel_row}-M{task.material}"
            groups.append(TaskGroup(key=key, tasks=[task]))
        return groups

    explicit: dict[str, list[MaterialTask]] = defaultdict(list)
    automatic: dict[tuple[Any, ...], list[MaterialTask]] = defaultdict(list)

    for task in tasks:
        if task.batch_group:
            explicit[task.batch_group].append(task)
        else:
            automatic[automatic_group_signature(task)].append(task)

    groups: list[TaskGroup] = []

    for key, group_tasks in explicit.items():
        validate_group_consistency(group_tasks, key)
        for part_number, part in enumerate(
            chunked(group_tasks, MAX_MATERIALS_PER_GROUP),
            start=1,
        ):
            suffix = f"-P{part_number}" if len(group_tasks) > MAX_MATERIALS_PER_GROUP else ""
            groups.append(TaskGroup(key=f"{key}{suffix}", tasks=list(part)))

    for auto_index, group_tasks in enumerate(automatic.values(), start=1):
        for part_number, part in enumerate(
            chunked(group_tasks, MAX_MATERIALS_PER_GROUP),
            start=1,
        ):
            groups.append(
                TaskGroup(
                    key=f"AUTO-{auto_index:03d}-P{part_number}",
                    tasks=list(part),
                )
            )

    return groups


# =============================================================================
# 7. SAP GUI helpers
# =============================================================================


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
        self._active_npl_query: Optional[tuple[str, str]] = None

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

        target_matches = [
            (session, meta)
            for session, meta in candidates
            if meta.get("target_verified")
        ]

        # When System/Client are configured, apply them as an extra filter.
        if EXPECTED_SAP_SYSTEM or EXPECTED_SAP_CLIENT or EXPECTED_SAP_USER:
            filtered: list[tuple[Any, dict[str, Any]]] = []
            for session, meta in target_matches:
                if EXPECTED_SAP_SYSTEM and meta["system"] != EXPECTED_SAP_SYSTEM:
                    continue
                if EXPECTED_SAP_CLIENT and meta["client"] != EXPECTED_SAP_CLIENT:
                    continue
                if EXPECTED_SAP_USER and meta["user"] != EXPECTED_SAP_USER:
                    continue
                filtered.append((session, meta))
            target_matches = filtered

        if target_matches:
            if len(target_matches) > 1:
                print(
                    f"⚠️ 找到{len(target_matches)}个目标环境会话，"
                    "将使用列表中的第一个"
                )
            print("✅ 复用已打开的目标SAP会话")
            return target_matches[0]

        # No target session exists: open the exact SAP Logon entry.
        self._open_target_connection(application)
        time.sleep(1)
        candidates = self._collect_sessions(application)
        self._print_sessions(candidates)
        target_matches = [
            (session, meta)
            for session, meta in candidates
            if meta.get("target_verified")
        ]

        if EXPECTED_SAP_SYSTEM or EXPECTED_SAP_CLIENT or EXPECTED_SAP_USER:
            target_matches = [
                (session, meta)
                for session, meta in target_matches
                if (not EXPECTED_SAP_SYSTEM or meta["system"] == EXPECTED_SAP_SYSTEM)
                and (not EXPECTED_SAP_CLIENT or meta["client"] == EXPECTED_SAP_CLIENT)
                and (not EXPECTED_SAP_USER or meta["user"] == EXPECTED_SAP_USER)
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

    def _execute_npl_query(self, group: TaskGroup):
        self.set_text(ID_PLANT, group.plant)
        self.set_text(ID_MATERIAL, "")
        self.set_text(ID_PROJECT, group.project)
        self.press(ID_EXECUTE)
        grid = self.wait_grid_columns(
            ID_GRID_CUSTOMER1,
            [COL_MATERIAL],
            timeout=SAP_LONG_WAIT_SEC,
        )
        self._active_npl_query = (group.plant, group.project)
        return grid

    def prepare_npl_grid_for_group(self, group: TaskGroup):
        """Prepare the NPL result grid with a one-Back fast path.

        Consecutive rows with the same Plant + MPP Project do NOT return all the
        way to the initial Plant/Project screen. From the completed Buyer Receipt
        flow, press Back once and reuse the already-filtered NPL result list.
        """
        query_key = (group.plant, group.project)

        # Already on a usable result list (for example after an Existing-RFQ
        # Continue): do not press Back at all.
        if REUSE_SAME_PROJECT_NPL_RESULTS and self._active_npl_query == query_key:
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

        same_query = self._active_npl_query == query_key
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
            f"| {self._active_npl_query} -> {query_key}"
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
        """Select SAP ALV rows with pywin32-safe fallbacks.

        Some SAP GUI patch levels throw COM error 618 (Bad index type for
        collection access) when a multi-row SelectedRows value is assigned.
        ROW mode avoids that path. BATCH mode still tries the recorded syntax
        and returns a clear SAP_SELECTION error rather than an opaque com_error.
        """
        normalized_rows = sorted({int(row) for row in rows})
        if not normalized_rows:
            raise SapRpaError("SAP_SELECTION", "没有可选择的SAP行")

        row_spec = ",".join(str(row) for row in normalized_rows)

        for clear_name in ("ClearSelection", "clearSelection"):
            try:
                getattr(grid, clear_name)()
                break
            except Exception:
                continue

        # Put focus on a real data cell first. A few GUI builds reject a
        # SelectedRows write while the column header / row -1 owns focus.
        try:
            grid.SetCurrentCell(normalized_rows[0], COL_MATERIAL)
        except Exception:
            try:
                grid.setCurrentCell(normalized_rows[0], COL_MATERIAL)
            except Exception:
                try:
                    grid.CurrentCellRow = normalized_rows[0]
                    grid.CurrentCellColumn = COL_MATERIAL
                except Exception:
                    pass

        errors: list[str] = []
        for attr_name in ("selectedRows", "SelectedRows"):
            try:
                setattr(grid, attr_name, row_spec)
                time.sleep(0.15)
                return
            except Exception as exc:
                errors.append(f"{attr_name}: {exc}")

        mode_hint = (
            "请把.env设置为 PROCESS_MODE=ROW；ROW模式会逐行处理并自动跳过已有RFQ。"
            if len(normalized_rows) > 1
            else "SAP当前Grid拒绝行选择，请确认该行仍显示在NPL结果中。"
        )
        raise SapRpaError(
            "SAP_SELECTION",
            f"无法选择SAP行 {row_spec}。{mode_hint} 原始错误："
            + " | ".join(errors),
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
        """Wait for Buyer Receipt Save question and confirm with direct Press only.

        The working command is the same as the third method observed in QA:
        session.findById("wnd[1]/usr/btnBUTTON_1").press

        If SAP does not consume the first event, reacquire the button and repeat
        the exact same direct Press after a short delay.
        """
        deadline = time.time() + BUYER_SAVE_CONFIRM_TIMEOUT_SEC
        last_popup_text = ""

        while time.time() < deadline:
            if self._buyer_save_confirmation_is_open():
                break
            if self.exists("wnd[1]"):
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
            popup_text = sap.popup_message_text("wnd[1]") or sap.window_text("wnd[1]")
            raise SapRpaError(
                "BUYER_RECEIPT_SAVE_POPUP",
                "Buyer Receipt确认保存后出现Message Display："
                + (popup_text[:2500] or "<无法读取弹窗>"),
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

        sap.modify_cell(grid, row, COL_RFQ_QTY_PROTOTYPE, task.rfq_qty_p)
        sap.modify_cell(grid, row, COL_RFQ_QTY_SERIAL, task.rfq_qty_s)

        if sap.column_exists(grid, COL_AFM_REQUEST):
            sap.modify_checkbox(grid, row, COL_AFM_REQUEST, task.afm_request)

        for vendor_index, vendor in enumerate(task.vendors, start=1):
            vendor_column = f"LIFNR{vendor_index}"
            cb_column = f"LIFNR{vendor_index}_CB"

            if vendor and sap.column_exists(grid, vendor_column):
                sap.modify_cell(grid, row, vendor_column, vendor)

            if sap.column_exists(grid, cb_column):
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


def handle_preferred_supplier_warning(sap: SapSession, allow: bool) -> None:
    if not sap.exists("wnd[1]"):
        return

    text = sap.window_text("wnd[1]").casefold()
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
        # The recording shows a generic BUTTON_1 after opening detailed RFQ.
        sap.handle_simple_confirmation(yes=True)


def fill_optional_control_text(sap: SapSession, control_id: str, value: str) -> bool:
    if not value:
        return True
    control = sap.find(control_id, required=False)
    if control is None:
        return False
    control.Text = value
    return True


def fill_detailed_rfq_header(sap: SapSession, group: TaskGroup) -> None:
    # The supplied recording does not contain the RFQ Comment popup controls.
    # Never silently ignore a requested comment.
    if group.rfq_comment:
        raise SapRpaError(
            "RFQ_COMMENT_UNSUPPORTED",
            "Excel填写了RFQ Comment，但录制脚本未包含RFQ Comment控件。"
            "请先将RFQ Comment留空，或补录该按钮和弹窗。",
        )

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

    sap.set_text(ID_RFQ_DUE_DATE, group.quotation_due_date)
    sap.send_vkey(0)
    sap.raise_on_status_error("RFQ_HEADER")


def process_final_rfq_popups(sap: SapSession, group: TaskGroup) -> None:
    deadline = time.time() + SAP_LONG_WAIT_SEC
    handled = 0

    while time.time() < deadline and handled < 10:
        if not sap.exists("wnd[1]"):
            # Give the next popup a short chance to appear.
            time.sleep(0.5)
            if not sap.exists("wnd[1]"):
                return

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
            # Generic order matching the recording:
            # standard Continue -> BUTTON_1 -> BUTTON_1 -> BUTTON_2 -> standard Continue
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
        if PROCESS_MODE == "ROW" and len(tasks) == 1 and not matched_materials:
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

        # PROCESS_MODE=ROW makes the active material unambiguous. This fallback
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


def create_buyer_receipt_skipping_existing_rfq(
    sap: SapSession,
    excel: ExcelStore,
    group: TaskGroup,
    npl_grid,
    matched_tasks: Sequence[MaterialTask],
) -> tuple[Optional[Any], list[MaterialTask], list[MaterialTask], list[MaterialTask]]:
    """Create Buyer Receipt and skip non-fatal Existing-RFQ/PPAP rows."""
    active_tasks = list(matched_tasks)
    skipped_existing: list[MaterialTask] = []
    skipped_ppap: list[MaterialTask] = []
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
                    return None, [], skipped_existing, skipped_ppap
                if not active_tasks:
                    print("   ℹ️ 当前处理单元物料已有RFQ，继续Excel下一行")
                    return None, [], skipped_existing, skipped_ppap

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
                    return None, [], skipped_existing, skipped_ppap
                if not active_tasks:
                    print("   ℹ️ 当前处理单元需要新的PPAP Date，继续Excel下一行")
                    return None, [], skipped_existing, skipped_ppap

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

            # A different Message Display means NPL data needs manual input.
            message = popup_text or sap.popup_message_text("wnd[1]") or "Create Buyer Receipt出现Message Display"
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
        return buyer_grid, active_tasks, skipped_existing, skipped_ppap

    return None, [], skipped_existing, skipped_ppap

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
) -> tuple[str, str]:
    # -------------------------------------------------------------------------
    # Step 3: Immediately create RFQ from Buyer Receipt (do not exit transaction).
    # -------------------------------------------------------------------------
    rfq_grid, terminal_success = open_rfq_creation_from_buyer_receipt(
        sap,
        buyer_grid,
        successful_buyer_tasks,
    )

    # QA 321 terminal condition: bottom-left status bar says
    # "Data copied Successfully and email sent". The grid can be empty because
    # the business action is already finished, so do not wait for LIFNR1_CB.
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

    sap.select_rows(rfq_grid, [int(task.rfq_row) for task in rfq_tasks if task.rfq_row is not None])
    sap.press(ID_OPEN_DETAILED_RFQ)
    handle_preferred_supplier_warning(sap, group.allow_without_preferred)

    fill_detailed_rfq_header(sap, group)
    sap.press(ID_CREATE_RFQ_FINAL)
    process_final_rfq_popups(sap, group)
    sap.wait_not_busy(SAP_LONG_WAIT_SEC)
    time.sleep(1)
    sap.raise_on_status_error("RFQ_FINAL_SAVE")

    rfq_number = extract_rfq_number(sap)
    if not rfq_number:
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
            "RFQ创建流程完成，但未提取到RFQ Number；请先人工核查，避免重复创建",
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

    sap.dismiss_message_display()
    if skipped_existing or skipped_ppap or blocked_ppap:
        notes: list[str] = []
        if skipped_existing:
            notes.append(
                "Existing RFQ=" + ", ".join(task.material for task in skipped_existing)
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
        if is_existing_rfq_message(stale_popup) or is_ppap_past_message(stale_popup):
            popup_kind = "Existing RFQ" if is_existing_rfq_message(stale_popup) else "PPAP Date"
            print(f"   🧹 检测到上次遗留的{popup_kind} Message Display，先点击Continue")
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
    buyer_grid, create_tasks, skipped_existing, skipped_ppap = create_buyer_receipt_skipping_existing_rfq(
        sap,
        excel,
        group,
        npl_grid,
        matched_tasks,
    )

    if not create_tasks or buyer_grid is None:
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

    successful_buyer_tasks, icon_debug, buyer_grid = save_buyer_receipt(sap, buyer_grid, buyer_tasks)
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
            "Project No.",
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
            "Project No.": group.project,
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
        "Plant | Project No. | Material No. | Intended Supplier | "
        "Supplier Email | Quotation Due Date | PPAP Date | Technology"
    )
    print("PPAP Date和Technology为可选字段。")


def main() -> None:
    print("=" * 80)
    print("SAP NPL -> Buyer Receipt -> RFQ RPA v15 (Same-Project One-Back Reuse + QA Status Success)")
    print("=" * 80)
    print(f"Excel: {EXCEL_PATH}")
    print(f"Sheet: {SHEET_NAME or '<active>'}")
    print(f"DRY_RUN: {DRY_RUN}")
    print(f"TEST_GROUP_LIMIT: {TEST_GROUP_LIMIT or 'ALL'}")
    print(f"MAX_MATERIALS_PER_GROUP: {MAX_MATERIALS_PER_GROUP}")
    print(f"PROCESS_MODE: {PROCESS_MODE} ({'逐行安全模式' if PROCESS_MODE == 'ROW' else '批量多选模式'})")
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
        "Same-project NPL fast reuse: "
        f"Enabled={REUSE_SAME_PROJECT_NPL_RESULTS} | "
        f"MaxBack={SAME_PROJECT_MAX_BACK_STEPS} | "
        f"ResultWait={SAME_PROJECT_RESULT_WAIT_SEC:.1f}s"
    )
    print(
        "Existing RFQ handling: "
        f"Skip={SKIP_EXISTING_RFQ_ROWS} | "
        f"ContinueRemaining={CONTINUE_AFTER_EXISTING_RFQ}"
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
        print(f"最终处理单元数: {len(groups)}")

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


if __name__ == "__main__":
    main()
