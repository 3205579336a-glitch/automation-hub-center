# -*- coding: utf-8 -*-
r"""
ZMFM050035 - APQP Plan Closure Date 批量查询并回写 Excel (DateSafe v3)

Excel:
    C:\Users\A533700\Downloads\New Microsoft Excel Worksheet.xlsx
Sheet:
    Sheet1

列定义：
    A = Part No. / Material
    B = Vendor
    C = APQP plan closure date（回写）
    兼容旧五列模板：A=Material，B=Ver，C=Description，D=Vendor，E=日期。
    每个工作表先校验表头，按对应的列映射读取和回写，不修改旧模板的可选列。

SAP查询逻辑：
    T-code = ZMFM050035
    P_C3 = True
    Plant = C100
    Vendor = Excel供应商列（新模板B / 旧模板D）
    Material = Excel A列
    Execute
    结果Grid选择第0行
    Execute
    读取字段：GS_ITAB-M_PLNDAT
    回写Excel日期列（新模板C / 旧模板E）

多SAP支持：
    - 自动发现已经登录的 SAP GUI Session。
    - 每个Session一个Worker，同时处理不同Excel行。
    - 默认最多3个Worker；如果只打开1个SAP Session，则自动单Worker。
    - 为安全起见，如果同时检测到多个不同SAP System，而 TARGET_SYSTEM 为空，程序会停止，
      要求你在配置区指定 TARGET_SYSTEM，避免QA/Prod混跑。

依赖：
    pip install pywin32

注意：
    1. SAP GUI Scripting 必须启用。
    2. 建议先 MAX_WORKERS=1、TEST_LIMIT=5 做测试。
    3. 默认不会覆盖Excel已有日期；需要重查时把 OVERWRITE_EXISTING_DATE=True。
"""

from __future__ import annotations

import csv
import json
import sys
import datetime as dt
import os
import queue
import re
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pythoncom
import win32com.client
import win32con
import win32gui

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hub_user_interaction import HubStopped, HubUserInteraction


# ============================================================================
# 1. 配置区
# ============================================================================

EXCEL_PATH = os.getenv("EXCEL_PATH", "")
SHEET_NAME = os.getenv("SHEET_NAME", "").strip()

DATA_START_ROW = 2
# Legacy defaults for standalone helper callers; main always passes validated per-sheet columns.
MATERIAL_COL = 1       # A
VENDOR_COL = 4         # legacy D
OUTPUT_DATE_COL = 5    # legacy E

TCODE = "ZMFM050035"
APQP_SESSION_POLICY = "949-fast-startup-v6"
PLANT = os.getenv("PLANT", "C100").strip().upper()

# SAP环境过滤。
# 如果只打开一个SAP系统，可以保持空字符串。
# 如果同时开了QA和Prod，请务必填系统名，例如 "VCE" / "CEQ"（以你SAP Info为准）。
HUB_TARGET_DEFAULTS = bool(os.environ.get("HUB_RUN_ID"))
TARGET_SYSTEM = (os.getenv("TARGET_SYSTEM", "").strip() or ("VCE" if HUB_TARGET_DEFAULTS else "")).upper()
TARGET_CLIENT = os.getenv("TARGET_CLIENT", "").strip() or ("100" if HUB_TARGET_DEFAULTS else "")
TARGET_CONNECTION_CONTAINS = ""
# The runner supplies these explicitly; Hub defaults also cover a still-running
# desktop main process with older blank fields. Preview exits before SAP access.
# Standalone callers retain their explicit System/Client discovery policy.
TARGET_CONNECTION_NAME = os.getenv("APQP_TARGET_CONNECTION_NAME", "").strip() or ("VCE - One Digital Core [949]" if HUB_TARGET_DEFAULTS else "")
AUTO_OPEN_TARGET = os.getenv("APQP_AUTO_OPEN_TARGET", str(HUB_TARGET_DEFAULTS)).lower() == "true"
AUTO_NAVIGATE_TARGET = os.getenv("APQP_AUTO_NAVIGATE_TARGET", str(HUB_TARGET_DEFAULTS)).lower() == "true"
SAP_CONNECTION_READY_TIMEOUT_SEC = 8.0

# 多开SAP：最多使用几个已登录Session。
MAX_WORKERS = max(1, min(5, int(os.getenv("MAX_WORKERS", "3"))))
CREATE_SESSIONS = os.getenv("CREATE_SESSIONS", "false").lower() == "true"

# 测试：0=全部；5=只处理前5条有效数据。
TEST_LIMIT = max(0, int(os.getenv("MAX_ITEMS", "0")))

# 已经有E列日期时是否重新覆盖。
OVERWRITE_EXISTING_DATE = os.getenv("OVERWRITE_EXISTING_DATE", "false").lower() == "true"

# 每处理多少条结果保存一次Excel。
SAVE_EVERY_RESULTS = 10

# 是否创建源Excel备份。
CREATE_BACKUP = True

# SAP等待参数。
SAP_ELEMENT_TIMEOUT_SEC = 20.0
SAP_PAGE_WAIT_SEC = 15.0
SAP_POLL_SEC = 0.20
SAP_STARTUP_POLL_SEC = 0.02
SAP_STEP_PAUSE_SEC = 0.15

# 查询结束后优先用Back回到同一T-code选择页面，失败才 /n 重进事务。
REUSE_TRANSACTION = True
MAX_BACK_STEPS_TO_SELECTION = 3

# Excel输出日期格式。
OUTPUT_DATE_NUMBER_FORMAT = "dd.mm.yyyy"

# VBS中确认过的控件ID。
ID_OKCD = "wnd[0]/tbar[0]/okcd"
ID_CHECK_C3 = "wnd[0]/usr/chkP_C3"
ID_PLANT = "wnd[0]/usr/ctxtS_WERKS-LOW"
ID_VENDOR = "wnd[0]/usr/ctxtS_LIFNR-LOW"
ID_MATERIAL = "wnd[0]/usr/ctxtS_MATNR-LOW"
ID_EXECUTE = "wnd[0]/tbar[1]/btn[8]"
ID_BACK = "wnd[0]/tbar[0]/btn[15]"

ID_RESULT_GRID = "wnd[0]/usr/cntlCON1/shellcont/shell"
ID_TAB1 = "wnd[0]/usr/tabsTAB_ST/tabpTAB1"
ID_PLAN_CLOSURE_DATE = (
    "wnd[0]/usr/tabsTAB_ST/tabpTAB1/"
    "ssubSUB1:ZMFM050035_N:0901/ctxtGS_ITAB-M_PLNDAT"
)


# ============================================================================
# 2. 数据结构
# ============================================================================


@dataclass(frozen=True)
class Task:
    excel_row: int
    material: str
    vendor: str


@dataclass(frozen=True)
class SessionRef:
    connection_index: int
    session_index: int
    system: str
    client: str
    user: str
    connection_description: str


@dataclass
class Result:
    excel_row: int
    material: str
    vendor: str
    status: str
    plan_closure_date_text: str = ""
    message: str = ""
    worker_id: int = 0
    elapsed_sec: float = 0.0


# ============================================================================
# 3. 通用工具
# ============================================================================


def normalize_identifier(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, float) and value.is_integer():
        return str(int(value))

    text = str(value).strip()

    if re.fullmatch(r"\d+\.0", text):
        return text[:-2]

    return text


def normalize_text(value: Any) -> str:
    return str(value or "").replace("\xa0", " ").strip()


def safe_print(*args, **kwargs) -> None:
    with PRINT_LOCK:
        print(*args, **kwargs)


def parse_sap_date(value: str) -> Optional[dt.date]:
    """
    把SAP日期文本解析为纯 date。

    重要：不要返回 datetime 再直接通过 Excel COM 写入。
    在某些 Windows / Office / 时区组合下，Python datetime 经 COM DATE
    marshaling 可能发生时区换算，午夜时间被换算到前一天，出现
    SAP=14.09.2026、Excel=13.09.2026 的现象。
    """
    text = normalize_text(value)
    if not text:
        return None

    # SAP画面有时会返回 "14. 09. 2026" 这类带空格格式。
    text = re.sub(r"\s*([./-])\s*", r"\1", text)

    formats = [
        "%d.%m.%Y",
        "%d/%m/%Y",
        "%Y-%m-%d",
        "%m/%d/%Y",
    ]

    for fmt in formats:
        try:
            return dt.datetime.strptime(text, fmt).date()
        except (ValueError, RuntimeError):
            continue

    return None


def excel_date_serial(value: dt.date) -> int:
    """
    直接生成Excel/OLE Automation日期序列号。
    1899-12-30 是Excel/COM日期序列的安全基准。
    用整数写 Value2 可以彻底绕开 Python datetime -> COM DATE 的时区转换。
    """
    return (value - dt.date(1899, 12, 30)).days


# ============================================================================
# 4. SAP GUI连接 / 多Session
# ============================================================================


def get_sap_application():
    from sap_gui_connection import GuiCollectionAccess
    sap_gui_auto = win32com.client.GetObject("SAPGUI")
    return GuiCollectionAccess(sap_gui_auto.GetScriptingEngine)


class SapSessionCheckError(RuntimeError):
    """A read-only preflight failure with a user-facing reason and technical evidence."""
    def __init__(self, code: str, issue: str, issue_zh: str, details: str = "", pending_sessions=None):
        self.code = code
        self.issue_summary = issue
        self.issue_summary_zh = issue_zh
        self.pending_sessions = pending_sessions or []
        super().__init__(f"[{code}] {issue}" + (f"\n{details}" if details else ""))


def read_session_identity(session) -> Tuple[str, str, str]:
    # Identity is mandatory. An inaccessible identity is not a signed-out window.
    info = session.Info
    return tuple(normalize_text(getattr(info, name)) for name in ("SystemName", "Client", "User"))


def get_session_by_ref(ref: SessionRef, application=None):
    application = application if application is not None else get_sap_application()
    connection = application.Children(ref.connection_index)
    session = connection.Children(ref.session_index)
    if (read_session_identity(session) != (ref.system, ref.client, ref.user)
            or (TARGET_CONNECTION_NAME and not matches_target_connection(connection_label(connection)))):
        raise SapSessionCheckError("SAP_SESSION_CHANGED",
            "SAP session identity changed; refusing to use another system/client/user.",
            "SAP 窗口的系统、Client 或账号已变化。请确认目标登录后重新检查，不会切换到其他环境。")
    return session


def session_info(session) -> Tuple[str, str, str, str]:
    identity = read_session_identity(session)
    try:
        transaction = normalize_text(session.Info.Transaction)
    except Exception:
        transaction = ""
    return (*identity, transaction)


def readable_transaction(session) -> str:
    # Unlike current_tcode's display fallback, a COM failure must not mean "home".
    value = session.Info.Transaction
    if value is None:
        raise RuntimeError("SAP did not return the current transaction.")
    return normalize_text(value).upper()


def session_readiness(session, allow_other_transactions: bool = False) -> Tuple[bool, str, str]:
    """Only read controls/state; never close dialogs, navigate or create a session."""
    busy = session.Busy
    if not isinstance(busy, (bool, int)):
        raise RuntimeError("SAP Busy state could not be verified.")
    if bool(busy):
        return False, "busy", "SAP is still busy"
    if session.FindById("wnd[1]", False) is not None:
        return False, "dialog", "an SAP dialog is open"
    if session.FindById("wnd[0]", False) is None:
        raise RuntimeError("SAP main window could not be read.")
    transaction = readable_transaction(session)
    if not allow_other_transactions and transaction not in {"", "SESSION_MANAGER", "SMEN", "S000", TCODE}:
        return False, "transaction", f"another transaction is open: {transaction}"
    return True, "ready", transaction or "SAP home"


def checked_sap_application():
    try:
        return get_sap_application()
    except Exception as error:
        raise SapSessionCheckError("SAP_GUI_UNAVAILABLE",
            "Cannot access SAP GUI Desktop. Complete SAP sign-in and check SAP GUI Scripting; browser sign-in alone is not enough.",
            "无法连接 SAP GUI 桌面。请完成 SAP 桌面登录并确认脚本可用；仅登录浏览器网页不够。", str(error)) from error


def connection_label(connection) -> str:
    for name in ("Description", "Name"):
        try:
            value = normalize_text(getattr(connection, name, ""))
            if value and not re.fullmatch(r"(?:con|conn|connection)\[\d+\]", value, re.IGNORECASE):
                return value
        except Exception:
            pass
    return ""


def matches_target_connection(label: str) -> bool:
    normalized = " ".join(label.casefold().split())
    target = " ".join(TARGET_CONNECTION_NAME.casefold().split())
    if normalized == target:
        return True
    token = re.search(r"\[\d+\]", target)
    return bool(token and token.group() in normalized)


def target_connection_indexes(application) -> List[int]:
    """Prove absence using the connection inventory, including signed-out entries."""
    try:
        count = int(application.Children.Count)
        matches = []
        for ci in range(count):
            label = connection_label(application.Children(ci))
            if not label:
                raise RuntimeError(f"Connection {ci + 1}: SAP Logon entry label is unreadable")
            if matches_target_connection(label):
                matches.append(ci)
    except Exception as error:
        raise SapSessionCheckError("SAP_TARGET_INVENTORY_UNREADABLE",
            "Cannot confirm whether the 949 connection is already open. Check SAP Logon/Scripting access; no extra connection will be opened.",
            "无法确认 949 连接是否已经打开。请检查 SAP Logon 和脚本权限；为避免重复登录，不会另开连接。", str(error)) from error
    if len(matches) > 1:
        raise SapSessionCheckError("SAP_TARGET_AMBIGUOUS",
            "More than one 949 connection is open. Verify the intended login; the Hub will not end other logons.",
            "检测到多个 949 连接。请确认目标登录后重新检查；Hub 不会结束其他登录。")
    return matches


def assert_no_target_alias(application) -> None:
    # A differently named Logon entry can point to the same production backend.
    # Do not create a second login merely because its display label differs.
    try:
        for ci in range(int(application.Children.Count)):
            connection = application.Children(ci)
            for si in range(int(connection.Children.Count)):
                system, client, user = read_session_identity(connection.Children(si))
                if system.upper() == TARGET_SYSTEM and client == TARGET_CLIENT and user:
                    raise SapSessionCheckError("SAP_TARGET_ALIAS_PRESENT",
                        "A VCE/100 login is already open under another SAP Logon entry. Verify the entry name; the Hub will not create a duplicate production login.",
                        "已有其他名称的 VCE/100 登录。请核对 SAP Logon 条目名称；Hub 不会再创建一个正式系统登录。")
    except SapSessionCheckError:
        raise
    except Exception as error:
        raise SapSessionCheckError("SAP_TARGET_INVENTORY_UNREADABLE",
            "Existing SAP logins could not be verified. Check disconnected/sign-in windows before opening 949; no extra login will be created automatically.",
            "无法核对已有 SAP 登录。请先处理断线或登录窗口，再打开 949；不会自动创建额外登录。", str(error)) from error


def sign_in_problem(session, ref: SessionRef) -> SapSessionCheckError:
    """Read-only classification: a connection object is not a completed login."""
    try:
        busy = session.Busy
        if not isinstance(busy, (bool, int)):
            raise RuntimeError("SAP Busy state could not be verified")
        if busy:
            return SapSessionCheckError("SAP_SESSION_BUSY",
                "SAP sign-in is still busy. Wait, then check again; no duplicate login will be opened.",
                "SAP 登录仍在处理中，请稍后重新检查；不会创建重复登录。")
        dialog = session.FindById("wnd[1]", False)
        title = normalize_text(dialog.Text) if dialog is not None else ""
        main = session.FindById("wnd[0]", False)
    except Exception as error:
        return SapSessionCheckError("SAP_LOGIN_STATE_UNREADABLE",
            "A 949 connection object exists, but its sign-in window cannot be verified. Check SAP Logon/window state; the Hub will not create a duplicate login.",
            "检测到 949 连接对象，但无法核实登录窗口。请检查 SAP Logon 和窗口状态；不会盲目创建重复登录。", str(error))
    if re.search(r"multiple\s+logons?|多重登录|重复登录|多次登录", title, re.I):
        return SapSessionCheckError("SAP_MULTIPLE_LOGONS",
            "SAP is waiting at 'License Information for Multiple Logons'. Review that SAP dialog yourself, then check again. The Hub will not end other logons or choose an option for you.",
            "949 登录被 SAP“多重登录”提示挡住。请在 SAP 中按公司规则自行处理后重新检查；不要随意结束其他登录，未保存工作可能丢失。Hub 不会代选。",
            f"SAP dialog: {title}", pending_sessions=[ref])
    if dialog is not None:
        return SapSessionCheckError("SAP_LOGIN_DIALOG_OPEN",
            "An SAP sign-in dialog needs attention. Handle it in SAP, then check again. No dialog option will be clicked automatically.",
            "SAP 登录有待处理的弹窗。请在 SAP 中处理后重新检查；系统不会代点弹窗选项。",
            f"SAP dialog: {title or '<untitled>'}", pending_sessions=[ref])
    if main is not None:
        return SapSessionCheckError("SAP_LOGIN_REQUIRED",
            "949 has an unfinished sign-in window, not a signed-in session. Complete sign-in in SAP, then check again. The Hub will show the existing window instead of creating another login.",
            "949 存在尚未完成的登录窗口，并不是已登录会话。Hub 会尝试显示该窗口，请完成 SAP 登录后重新检查，不会再创建一个登录。",
            "No signed-in user; SAP main window exists.", pending_sessions=[ref])
    return SapSessionCheckError("SAP_LOGIN_WINDOW_UNAVAILABLE",
        "949 has an incomplete connection object but no readable login window. Check SAP Logon for failed/disconnected connections; no automatic close or duplicate login will be attempted.",
        "949 仅有未完成的连接对象，未找到可用登录窗口。请检查 SAP Logon 的失败或断线提示；不会自动关闭连接或重复登录。")


def show_pending_sap_window(ref: SessionRef, shown_handles: set) -> str:
    """Display only: no credentials, keys, clicks, close, save or login choices."""
    session = get_session_by_ref(ref)  # Revalidate target and unchanged identity.
    busy = session.Busy
    if not isinstance(busy, (bool, int)):
        raise RuntimeError("SAP Busy state could not be verified before window display.")
    if busy:
        return "SAP is busy; window display deferred."
    main = session.FindById("wnd[0]", False)
    dialog = session.FindById("wnd[1]", False)
    windows = [window for window in (main, dialog) if window is not None]
    handles = [int(window.Handle) for window in windows]
    # Validate every handle before displaying anything; stale COM proxies must
    # not cause a different window/connection to be opened or closed.
    if not handles or any(not win32gui.IsWindow(handle) for handle in handles):
        raise RuntimeError("SAP login window handle is missing or no longer valid.")
    errors = []
    display_requested = False
    for handle in handles:  # Restore owner before modal so the dialog stays on top.
        if STOP_EVENT.is_set():
            raise HubStopped("APQP stopped before showing SAP.")
        if handle in shown_handles:
            continue
        shown_handles.add(handle)  # Do not steal focus on every readiness poll.
        display_requested = True
        try:
            win32gui.ShowWindow(handle, win32con.SW_RESTORE)
        except Exception as error:
            errors.append(str(error))
    if STOP_EVENT.is_set():
        raise HubStopped("APQP stopped before bringing SAP forward.")
    target = handles[-1]
    if display_requested:
        try:
            win32gui.SetForegroundWindow(target)
        except Exception as error:
            # Windows may prevent foreground activation. Visibility and the actual
            # login issue still remain useful; never use injected keys as a bypass.
            errors.append(str(error))
    visible = bool(win32gui.IsWindowVisible(target))
    return f"SAP pending window visible={visible}." + (" Display details: " + "; ".join(errors) if errors else "")


def discover_sap_sessions(allow_other_transactions: bool = False, application=None, *, limit_workers: bool = True) -> List[SessionRef]:
    from sap_gui_connection import SapGuiIssue
    application = application if application is not None else checked_sap_application()
    target_indexes = target_connection_indexes(application) if TARGET_CONNECTION_NAME else None
    if target_indexes == []:
        raise SapSessionCheckError("SAP_TARGET_CONNECTION_MISSING",
            "The 949 connection is not open. Open VCE - One Digital Core [949] in SAP Logon and check again.",
            "尚未打开 949 连接。请在 SAP Logon 中打开 VCE - One Digital Core [949] 后重新检查。")
    try:
        connection_count = int(application.Children.Count)
    except Exception as error:
        raise SapSessionCheckError("SAP_SESSION_SCAN_FAILED",
            "Cannot read the SAP connection list. Recheck SAP GUI Scripting and the signed-in desktop windows.",
            "无法读取 SAP 连接列表。请确认 SAP 桌面登录和脚本访问权限，再重新检查。", str(error)) from error
    refs: List[SessionRef] = []
    inventory_errors = []
    diagnostics = []
    pending_sessions = []
    for ci in range(connection_count):
        if target_indexes is not None and ci not in target_indexes:
            continue  # Never inspect or use QA/other known Logon entries.
        try:
            connection = application.Children(ci)
            session_count = int(connection.Children.Count)
        except SapGuiIssue as error:
            raise SapSessionCheckError(error.code, error.issue_summary, error.issue_summary_zh, str(error)) from error
        except Exception as error:
            inventory_errors.append(f"Connection {ci + 1}: {error}")
            continue
        description = connection_label(connection)
        for si in range(session_count):
            try:
                session = connection.Children(si)
                system, client, user = read_session_identity(session)
            except Exception as error:
                inventory_errors.append(f"Connection {ci + 1}, window {si + 1}: identity unreadable: {error}")
                continue
            if not user or not system or not client:
                diagnostics.append(f"Connection {ci + 1}, window {si + 1}: not signed in")
                # A known mismatching partial identity must not be shown or used.
                if TARGET_CONNECTION_NAME and ((system and TARGET_SYSTEM and system.upper() != TARGET_SYSTEM)
                                               or (client and TARGET_CLIENT and client != TARGET_CLIENT)):
                    inventory_errors.append(f"949 partial identity mismatch: expected {TARGET_SYSTEM}/{TARGET_CLIENT}, observed {system}/{client}")
                else:
                    pending_sessions.append((session, SessionRef(ci, si, system, client, user, description)))
                continue
            if TARGET_CONNECTION_NAME and ((TARGET_SYSTEM and system.upper() != TARGET_SYSTEM)
                                           or (TARGET_CLIENT and client != TARGET_CLIENT)):
                inventory_errors.append(f"949 identity mismatch: expected {TARGET_SYSTEM}/{TARGET_CLIENT}, observed {system}/{client}")
                continue
            if TARGET_SYSTEM and system.upper() != TARGET_SYSTEM:
                continue
            if TARGET_CLIENT and client != TARGET_CLIENT:
                continue
            refs.append(SessionRef(ci, si, system, client, user, description))
    if inventory_errors:
        # Unknown identities may belong to a second environment; never silently guess.
        raise SapSessionCheckError("SAP_SESSION_IDENTITY_UNREADABLE",
            "Some SAP connection identities are unreadable. The target environment cannot be confirmed; resolve disconnected or sign-in windows and check again. Existing work will not be closed.",
            "部分 SAP 连接的系统、Client 或账号无法读取，暂时不能确认目标环境。请处理断线或登录窗口后重新检查；不会关闭已有业务窗口。",
            "\n".join(inventory_errors))
    if not refs:
        if TARGET_CONNECTION_NAME and pending_sessions:
            error = sign_in_problem(*pending_sessions[0])
            error.args = (str(error) + "\n" + "\n".join(diagnostics),)
            raise error
        raise SapSessionCheckError("SAP_NOT_SIGNED_IN",
            "949 has a connection object but no signed-in session yet. Wait for SAP sign-in to appear or check SAP Logon connection messages." if TARGET_CONNECTION_NAME else "No matching signed-in SAP GUI session. Sign in to SAP Desktop and enable SAP GUI Scripting.",
            "949 仅有连接对象，尚无已登录会话。请等待 SAP 登录窗口出现，或检查 SAP Logon 的连接提示。" if TARGET_CONNECTION_NAME else "没有找到已登录的 SAP 桌面会话。请完成 SAP GUI 登录，再重新检查。", "\n".join(diagnostics))
    environments = {(ref.system, ref.client, ref.user) for ref in refs}
    if len(environments) != 1:
        raise SapSessionCheckError("SAP_ENVIRONMENT_AMBIGUOUS",
            "Multiple SAP systems/clients/users match. Keep one intended signed-in environment available; do not close unsaved work or end other logons blindly.",
            "检测到不同 SAP 系统、Client 或账号，不能自动判断目标环境。请先安全处理其他环境的连接，再重新检查；不要直接退出未保存的业务窗口。",
            "Systems/Clients: " + ", ".join(sorted({f"{ref.system}/{ref.client}" for ref in refs})))
    usable = []
    usable_transactions = {}
    rejected = []
    for ref in refs:
        try:
            session = get_session_by_ref(ref, application)
            ready, reason, detail = session_readiness(session, allow_other_transactions)
        except SapSessionCheckError:
            raise  # An identity change invalidates the environment snapshot.
        except Exception as error:
            ready, reason, detail = False, "unreadable", str(error)
        if not ready:
            rejected.append((reason, detail))
            diagnostics.append(f"Connection {ref.connection_index + 1}, window {ref.session_index + 1}: {detail}")
            continue
        usable.append(ref)
        usable_transactions[(ref.connection_index, ref.session_index)] = detail
    if not usable:
        reasons = {reason for reason, _ in rejected}
        code = "SAP_NO_IDLE_SESSION"
        issue = "No ready APQP/home window is available. Save your current SAP work, enter ZMFM050035 in the existing target window and check again."
        issue_zh = "没有就绪的 APQP/首页窗口。请先保存 SAP 当前工作，在现有目标窗口进入 ZMFM050035 后重新检查。"
        if reasons == {"busy"}:
            code, issue, issue_zh = "SAP_SESSION_BUSY", "SAP windows are still busy. Wait for SAP to finish, then check again.", "SAP 窗口仍在处理中，请等待响应结束后重新检查。"
        elif reasons == {"dialog"}:
            if TARGET_CONNECTION_NAME:
                for ref in refs:
                    dialog_problem = sign_in_problem(get_session_by_ref(ref), ref)
                    if dialog_problem.code == "SAP_MULTIPLE_LOGONS":
                        raise dialog_problem
            code, issue, issue_zh = "SAP_SESSION_DIALOG_OPEN", "An SAP dialog is blocking each available window. Review and handle the dialog in SAP, then check again; no button will be clicked automatically.", "可用 SAP 窗口上有弹窗。请在 SAP 中确认并处理后重新检查，系统不会代点确认按钮。"
        elif reasons == {"unreadable"}:
            code, issue, issue_zh = "SAP_SESSION_STATE_UNREADABLE", "Signed-in SAP windows were found, but their state could not be read. Check the existing SAP window and Scripting access, then check again.", "已找到 SAP 登录，但无法读取窗口状态。请检查现有 SAP 窗口和脚本访问权限后重新检查。"
        elif reasons == {"transaction"}:
            transactions = ", ".join(sorted({detail.rsplit(": ", 1)[-1] for _, detail in rejected}))
            issue += f" Current transaction(s): {transactions}."
            issue_zh = f"当前 SAP 窗口停在 {transactions}，尚未进入 APQP。请先保存 SAP 当前工作，在原窗口进入 ZMFM050035 后重新检查，不需要新建会话。"
        raise SapSessionCheckError(code, issue, issue_zh, "\n".join(diagnostics),
            pending_sessions=refs[:1] if TARGET_CONNECTION_NAME and reasons == {"dialog"} else None)
    if any(reason == "unreadable" for reason, _ in rejected):
        emit("notice", message=f"Skipped {sum(reason == 'unreadable' for reason, _ in rejected)} unreadable SAP window(s); using {len(usable)} verified ready window(s) in one environment.")
    if allow_other_transactions:
        # Prefer already available APQP/home windows, but another T-code is
        # eligible for startup too. No navigation takes place during discovery.
        usable.sort(key=lambda ref: usable_transactions[(ref.connection_index, ref.session_index)]
                    not in {"", "SAP home", "SESSION_MANAGER", "SMEN", "S000", TCODE})
    return usable[:MAX_WORKERS] if limit_workers else usable


class HubSessionConnector:
    """One startup, connection-open and same-window navigation attempt per run.

    Failed/slow COM calls may have succeeded externally: rechecks only inspect
    after an open attempt, even if SAP has not exposed the new connection yet.
    """
    def __init__(self, task_count=None):
        self.logon_attempted = False
        self.open_attempted = False
        self.navigation_refs = {}
        self.worker_limit = min(MAX_WORKERS, task_count) if task_count is not None else MAX_WORKERS
        self.shown_handles = set()

    def show_sign_in_issue(self, error) -> None:
        for ref in getattr(error, "pending_sessions", []):
            try:
                detail = show_pending_sap_window(ref, self.shown_handles)
            except Exception as display_error:
                detail = f"Could not display SAP login window; switch to SAP manually. {display_error}"
            error.args = (str(error) + "\n" + detail,)

    def ready_sessions(self) -> List[SessionRef]:
        if not AUTO_NAVIGATE_TARGET:
            return discover_sap_sessions()
        # A previous ambiguous request belongs to its original window. Do not
        # silently swap it for a different window or repeat StartTransaction.
        for ref in self.navigation_refs.values():
            self.verify_navigation(ref)
        try:
            refs = discover_sap_sessions(allow_other_transactions=True)[:self.worker_limit]
        except SapSessionCheckError as error:
            self.show_sign_in_issue(error)
            raise
        for ref in refs:
            session = get_session_by_ref(ref)
            if readable_transaction(session) not in {"", "SESSION_MANAGER", "SMEN", "S000", TCODE}:
                self.navigate_existing(ref)
        return refs

    def verify_navigation(self, ref) -> List[SessionRef]:
        # Bind only this verified window. Polling must not enumerate every SAP
        # connection/session again after a transaction has already been sent.
        session = get_session_by_ref(ref)
        deadline = time.monotonic() + SAP_CONNECTION_READY_TIMEOUT_SEC
        while True:
            if STOP_EVENT.is_set():
                raise HubStopped("APQP stopped while waiting for its query page.")
            try:
                ready, reason, transaction = session_readiness(session)
            except Exception as error:
                raise SapSessionCheckError('SAP_SESSION_STATE_UNREADABLE',
                    'The selected SAP window state cannot be read. Check its Scripting access and window, then check again.',
                    '无法读取选中 SAP 窗口的状态，请检查脚本权限和该窗口后重新检查。', str(error)) from error
            if reason == 'dialog':
                error = SapSessionCheckError('SAP_SESSION_DIALOG_OPEN',
                    'SAP needs your confirmation before entering APQP. Handle its dialog, then check again; no option will be chosen automatically.',
                    '进入 APQP 时 SAP 需要确认。请自行处理弹窗后重新检查，系统不会代选。', pending_sessions=[ref])
                self.show_sign_in_issue(error)
                raise error
            if ready and transaction == TCODE and is_selection_screen(session):
                if read_session_identity(session) != (ref.system, ref.client, ref.user):
                    raise SapSessionCheckError('SAP_SESSION_CHANGED', 'SAP identity changed during APQP navigation.', '进入 APQP 期间 SAP 会话身份已变化，请核对目标登录。')
                return [ref]
            if time.monotonic() >= deadline:
                raise SapSessionCheckError('SAP_APQP_NAVIGATION_PENDING',
                    'The existing window has not reached the APQP query page. Handle SAP prompts or enter ZMFM050035, then check again. Navigation will not be replayed.',
                    '原窗口尚未进入 APQP 查询页。请处理 SAP 提示或进入 ZMFM050035 后重新检查；不会重复跳转。')
            if STOP_EVENT.wait(SAP_STARTUP_POLL_SEC):
                raise HubStopped("APQP stopped while waiting for its query page.")

    def navigate_existing(self, source) -> None:
        started = time.perf_counter()
        key = (source.connection_index, source.session_index)
        if key in self.navigation_refs:
            self.verify_navigation(source)
            return
        # User-authorized startup switch in each selected existing window. The
        # per-record guard still refuses a manual T-code change after startup.
        session = get_session_by_ref(source)
        ready, _, _ = session_readiness(session, allow_other_transactions=True)
        if not ready:
            raise SapSessionCheckError("SAP_SESSION_CHANGED",
                "SAP window state changed before entering APQP. Check again; no navigation was sent.",
                "进入 APQP 前 SAP 窗口状态发生变化，请重新检查；尚未发送跳转命令。")
        if STOP_EVENT.is_set():
            raise HubStopped("APQP stopped before navigating to APQP.")
        self.navigation_refs[key] = source  # Set before COM: navigation may succeed even on error.
        emit("notice", message=f"Switching the existing SAP window from {readable_transaction(session)} to {TCODE}. No new session will be created.")
        try:
            # Deliberately no command-box fallback/replay after an ambiguous COM
            # response, and no automatic Save/Discard/Back/popup acknowledgment.
            session.StartTransaction(TCODE)
        except Exception as error:
            raise SapSessionCheckError("SAP_APQP_NAVIGATION_FAILED",
                "Could not confirm entering ZMFM050035. Review SAP prompts/transaction authorization, then check again. No new session was created and no save/discard choice was made.",
                "无法确认已进入 ZMFM050035。请检查 SAP 提示或事务权限后重新检查；没有新建会话，也没有代点保存或放弃。", str(error)) from error
        self.verify_navigation(source)
        emit('notice', message=f'APQP timing | SAP navigation and page verification: {(time.perf_counter() - started) * 1000:.0f} ms | window={source.session_index + 1}')

    def wait_for_ready(self, retry_codes, pending_code, issue, issue_zh, navigation_ref=None) -> List[SessionRef]:
        deadline = time.monotonic() + SAP_CONNECTION_READY_TIMEOUT_SEC
        while True:
            if STOP_EVENT.is_set():
                raise HubStopped("APQP stopped while waiting for SAP.")
            try:
                refs = discover_sap_sessions()
                if navigation_ref is not None:
                    session = get_session_by_ref(navigation_ref)
                    ready, reason, _ = session_readiness(session)
                    if reason == "dialog":
                        raise SapSessionCheckError("SAP_SESSION_DIALOG_OPEN",
                            "SAP needs your confirmation before entering APQP. Review its save/discard or other dialog, then check again; no option will be chosen automatically.",
                            "进入 APQP 时 SAP 需要确认。请自行处理保存/放弃或其他弹窗后重新检查，系统不会代选。")
                    if not ready or readable_transaction(session) != TCODE or not is_selection_screen(session):
                        raise SapSessionCheckError(pending_code, issue, issue_zh)
                return refs
            except SapSessionCheckError as error:
                self.show_sign_in_issue(error)
                if error.code not in retry_codes:
                    raise
                if time.monotonic() >= deadline:
                    raise SapSessionCheckError(pending_code, issue, issue_zh, str(error)) from error
            if STOP_EVENT.wait(0.2):
                raise HubStopped("APQP stopped while waiting for SAP.")

    def verify(self) -> List[SessionRef]:
        if STOP_EVENT.is_set():
            raise HubStopped("APQP stopped before SAP connection verification.")
        if not AUTO_OPEN_TARGET or not TARGET_CONNECTION_NAME:
            return self.ready_sessions()
        try:
            application = checked_sap_application()
        except SapSessionCheckError:
            if self.logon_attempted:
                raise
            self.logon_attempted = True
            try:
                from me01_source_list import launch_sap_logon
                launch_sap_logon()
            except Exception as error:
                raise SapSessionCheckError("SAP_LOGON_START_FAILED",
                    "SAP Logon could not be started. Open SAP Logon manually and check again.",
                    "无法启动 SAP Logon。请手动打开 SAP Logon 后重新检查。", str(error)) from error
            emit("notice", message="Starting SAP Logon to open VCE - One Digital Core [949].")
            # A short, cancellable startup wait, not a fixed delay on normal runs.
            deadline = time.monotonic() + 8
            while True:
                if STOP_EVENT.wait(0.2):
                    raise HubStopped("APQP stopped while starting SAP Logon.")
                try:
                    application = checked_sap_application()
                    break
                except SapSessionCheckError:
                    if time.monotonic() >= deadline:
                        raise
        if not target_connection_indexes(application):
            if self.open_attempted:
                raise SapSessionCheckError("SAP_TARGET_OPEN_PENDING",
                    "949 was already requested, but is not available yet. Check SAP Logon for connection/network errors, or open the entry manually. It will not be opened again automatically.",
                    "已请求打开 949，但连接尚不可用。请检查 SAP Logon 的连接或网络提示，必要时手动打开该条目；不会重复自动打开。")
            if STOP_EVENT.is_set():
                raise HubStopped("APQP stopped before opening SAP.")
            assert_no_target_alias(application)
            if target_connection_indexes(application):
                return self.ready_sessions()  # User opened it during preflight.
            if STOP_EVENT.is_set():
                raise HubStopped("APQP stopped before opening SAP.")
            self.open_attempted = True  # Set before COM: a failure can still open a window.
            emit("notice", message="Opening VCE - One Digital Core [949]. Complete SAP sign-in if requested.")
            try:
                # SAP's async mode leaves sign-in and security prompts interactive.
                application.OpenConnection(TARGET_CONNECTION_NAME, False)
            except Exception as error:
                raise SapSessionCheckError("SAP_TARGET_OPEN_FAILED",
                    "Could not confirm opening 949. Check SAP Logon and the configured entry name; no automatic retry will create another login.",
                    "无法确认 949 是否已打开。请检查 SAP Logon 和连接名称；不会自动重试并创建重复登录。", str(error)) from error
            # Async OpenConnection normally returns before SAP exposes a login.
            # Give SSO a bounded, cancellable chance instead of immediately warning.
            try:
                self.wait_for_ready({"SAP_TARGET_CONNECTION_MISSING", "SAP_NOT_SIGNED_IN", "SAP_SESSION_BUSY", "SAP_LOGIN_REQUIRED"},
                    "SAP_TARGET_OPEN_PENDING",
                    "949 was requested but sign-in is not ready. Complete SAP sign-in/connection prompts and check again; no duplicate connection will be opened.",
                    "已请求打开 949，但登录尚未就绪。请完成 SAP 登录或处理连接提示后重新检查；不会重复打开连接。")
            except SapSessionCheckError as error:
                if error.code != "SAP_NO_IDLE_SESSION":
                    raise
                # A startup transaction may be configured for a fresh SSO login.
                # Switch in the same window, just as for an existing ME11 page.
        return self.ready_sessions()


def wait_for_hub_sessions(hub, task_count=None) -> List[SessionRef]:
    connector = HubSessionConnector(task_count)
    try:
        return connector.verify()
    except HubStopped:
        raise
    except Exception as error:
        return hub.wait("SIGN_IN",
            getattr(error, "issue_summary", "SAP session verification failed. Review the details, resolve SAP sign-in/window state and check again."),
            getattr(error, "issue_summary_zh", "SAP 会话检查未通过。请查看详情并处理 SAP 登录或窗口状态后重新检查。"),
            connector.verify, detail=str(error),
            instructions="Handle SAP sign-in, authorization or save/discard prompts, then check again. APQP uses the existing window without creating a session. No save/discard choice is made automatically.",
            instructionsZh="请处理 SAP 登录、权限或保存/放弃提示后重新检查。APQP 复用原窗口，不新建会话，不自动选择保存或放弃。")


def prepare_sessions(task_count: int, verified_refs=None) -> List[SessionRef]:
    # Carry the selected windows through to workers instead of performing a new
    # home-only selection that can drop or replace them after startup.
    refs = (list(verified_refs) if verified_refs is not None else
            HubSessionConnector(task_count).verify() if AUTO_NAVIGATE_TARGET else discover_sap_sessions())
    if verified_refs is not None:
        for ref in refs:
            ready, reason, _ = session_readiness(get_session_by_ref(ref))
            if not ready:
                raise SapSessionCheckError("SAP_SESSION_CHANGED",
                    "A selected SAP window changed after APQP startup. Check its prompt/state before restarting.",
                    "选中的 SAP 窗口在 APQP 启动检查后发生变化，请检查该窗口的提示或状态后再启动。", reason)
    desired = min(MAX_WORKERS, task_count)
    if CREATE_SESSIONS:
        while len(refs) < desired:
            previous = {(r.connection_index, r.session_index) for r in refs}
            try:
                get_session_by_ref(refs[0]).CreateSession()
            except Exception as exc:
                emit("notice", message=f"SAP did not allow another session: {exc}")
                break
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if STOP_EVENT.is_set():
                    return refs[:desired]
                time.sleep(0.3)
                updated = discover_sap_sessions()
                if {(r.connection_index, r.session_index) for r in updated} - previous:
                    refs = updated
                    break
            else:
                emit("notice", message="SAP session limit reached or a new session is not ready. Using available sessions.")
                break
    if len(refs) < desired:
        emit("notice", message=f"Requested {desired} workers; {len(refs)} eligible SAP session(s) are available.")
    return refs[:desired]


# ============================================================================
# 5. SAP控件与页面等待
# ============================================================================


def find_by_id(session, element_id: str):
    try:
        return session.FindById(element_id)
    except Exception:
        return None


def element_exists(session, element_id: str) -> bool:
    return find_by_id(session, element_id) is not None


def wait_not_busy(session, timeout_sec: float = SAP_PAGE_WAIT_SEC) -> bool:
    deadline = time.time() + timeout_sec

    while time.time() < deadline:
        try:
            if not bool(session.Busy):
                return True
        except Exception:
            return True
        time.sleep(SAP_POLL_SEC)

    return False


def wait_element(session, element_id: str, timeout_sec: float = SAP_ELEMENT_TIMEOUT_SEC):
    deadline = time.time() + timeout_sec

    while time.time() < deadline:
        wait_not_busy(session, timeout_sec=2.0)
        element = find_by_id(session, element_id)
        if element is not None:
            return element
        time.sleep(SAP_POLL_SEC)

    return None


def status_bar(session) -> Tuple[str, str]:
    sbar = find_by_id(session, "wnd[0]/sbar")
    if sbar is None:
        return "", ""

    try:
        msg_type = normalize_text(sbar.MessageType)
    except Exception:
        msg_type = ""

    try:
        text = normalize_text(sbar.Text)
    except Exception:
        text = ""

    return msg_type, text


def popup_text(session) -> str:
    wnd1 = find_by_id(session, "wnd[1]")
    if wnd1 is None:
        return ""

    texts: List[str] = []
    candidates = [
        "wnd[1]/usr/txtMESSTXT1",
        "wnd[1]/usr/txtMESSTXT2",
        "wnd[1]/usr/txtSPOP-TEXTLINE1",
        "wnd[1]/usr/txtSPOP-TEXTLINE2",
    ]

    for element_id in candidates:
        obj = find_by_id(session, element_id)
        if obj is not None:
            try:
                value = normalize_text(obj.Text)
                if value:
                    texts.append(value)
            except Exception:
                pass

    try:
        title = normalize_text(wnd1.Text)
        if title:
            texts.insert(0, title)
    except Exception:
        pass

    return " | ".join(dict.fromkeys(texts))


def dismiss_popup(session) -> str:
    """Only acknowledge explicitly labelled informational dialogs, never Yes/No."""
    text = popup_text(session)
    if not element_exists(session, "wnd[1]"):
        return text
    if find_by_id(session, "wnd[1]/usr/btnSPOP-OPTION1") is not None:
        raise RuntimeError(f"SAP requires manual confirmation; no Yes/No option was chosen. {text}")
    button = find_by_id(session, "wnd[1]/tbar[0]/btn[0]")
    if button is not None:
        label = normalize_text(getattr(button, "Text", "") or getattr(button, "Tooltip", ""))
        if re.fullmatch(r"(OK|Continue|Enter|Information)(?:\s*\([^)]*\))?", label, re.I):
            button.Press()
            return text
    raise RuntimeError(f"Unexpected SAP dialog requires user review: {text}")


# ============================================================================
# 6. ZMFM050035 查询逻辑
# ============================================================================


def current_tcode(session) -> str:
    """安全读取当前SAP Transaction Code。"""
    try:
        return normalize_text(session.Info.Transaction).upper()
    except Exception:
        return ""


def is_selection_screen(session) -> bool:
    return (
        element_exists(session, ID_CHECK_C3)
        and element_exists(session, ID_PLANT)
        and element_exists(session, ID_VENDOR)
        and element_exists(session, ID_MATERIAL)
    )


def detect_zmfm_screen(session) -> str:
    """
    判断ZMFM050035当前页面。

    重要：不能像旧版那样在任何页面都连续Back，否则如果脚本从
    SAP Easy Access / 其他T-code启动，会被一路Back退出事务，最后连
    wnd[0]/tbar[0]/okcd 都可能不存在。
    """
    if is_selection_screen(session):
        return "SELECTION"

    if element_exists(session, ID_PLAN_CLOSURE_DATE) or element_exists(session, ID_TAB1):
        return "DETAIL"

    if element_exists(session, ID_RESULT_GRID):
        return "GRID"

    if element_exists(session, "wnd[1]"):
        return "POPUP"

    return "OTHER"


def wait_for_screen_state(
    session,
    expected_states,
    timeout_sec: float = 8.0,
) -> str:
    if isinstance(expected_states, str):
        expected_states = {expected_states}
    else:
        expected_states = set(expected_states)

    deadline = time.time() + timeout_sec
    last_state = "OTHER"

    while time.time() < deadline:
        wait_not_busy(session, timeout_sec=1.5)
        last_state = detect_zmfm_screen(session)
        if last_state in expected_states:
            return last_state
        time.sleep(SAP_POLL_SEC)

    return last_state


def start_transaction(session) -> None:
    """
    进入ZMFM050035。

    v2优先调用SAP GUI Scripting原生 StartTransaction()，不依赖命令框。
    只有原生方法失败时才回退到 wnd[0]/tbar[0]/okcd。
    """
    last_error = ""

    # 方式1：SAP GUI Scripting原生启动事务，最稳，也不要求命令框可见。
    try:
        session.StartTransaction(TCODE)
        wait_not_busy(session, timeout_sec=SAP_PAGE_WAIT_SEC)
        if wait_for_screen_state(session, "SELECTION", timeout_sec=SAP_ELEMENT_TIMEOUT_SEC) == "SELECTION":
            return
        last_error = f"StartTransaction后未进入{TCODE}选择页"
    except Exception as exc:
        last_error = f"StartTransaction失败: {exc}"

    # 方式2：命令框兜底。
    okcd = wait_element(session, ID_OKCD, timeout_sec=3)
    if okcd is not None:
        try:
            okcd.Text = f"/n{TCODE}"
            session.FindById("wnd[0]").SendVKey(0)
            wait_not_busy(session, timeout_sec=SAP_PAGE_WAIT_SEC)
            if wait_for_screen_state(session, "SELECTION", timeout_sec=SAP_ELEMENT_TIMEOUT_SEC) == "SELECTION":
                return
            last_error = f"命令框启动后仍未进入{TCODE}选择页"
        except Exception as exc:
            last_error = f"命令框启动失败: {exc}"

    msg_type, msg = status_bar(session)
    raise RuntimeError(
        f"无法进入{TCODE}选择页面 | 当前T-code={current_tcode(session) or '<unknown>'} "
        f"| Screen={detect_zmfm_screen(session)} | SAP={msg_type}:{msg} | {last_error}"
    )


def wait_until_selection_screen(session, timeout_sec: float) -> bool:
    return wait_for_screen_state(session, "SELECTION", timeout_sec=timeout_sec) == "SELECTION"


def press_back_once(session, expected_states, reason: str) -> str:
    """只退一步，并明确等待目标页面；绝不连续盲退。"""
    back = find_by_id(session, ID_BACK)
    if back is None:
        return detect_zmfm_screen(session)

    try:
        back.Press()
    except Exception:
        return detect_zmfm_screen(session)

    wait_not_busy(session, timeout_sec=8)

    # Back后若出现纯信息弹窗，可以安全关闭；不会自动点未知Yes/No。
    if element_exists(session, "wnd[1]"):
        dismiss_popup(session)
        wait_not_busy(session, timeout_sec=3)

    state = wait_for_screen_state(session, expected_states, timeout_sec=5.0)
    return state


def ensure_selection_screen(session) -> None:
    """
    v2状态恢复：
      * 已在Selection -> 直接复用；
      * 只有确认当前就在ZMFM050035的DETAIL/GRID时才Back；
      * SAP Easy Access / 其他T-code -> 绝不Back，直接StartTransaction；
      * DETAIL最多 DETAIL->GRID->SELECTION 两步；
      * GRID最多 GRID->SELECTION 一步。
    """
    state = detect_zmfm_screen(session)
    if state == "SELECTION":
        return

    tcode = current_tcode(session)

    # 如果有遗留信息弹窗，先清掉再重新判断。
    if state == "POPUP":
        dismiss_popup(session)
        wait_not_busy(session, timeout_sec=3)
        state = detect_zmfm_screen(session)
        if state == "SELECTION":
            return
        tcode = current_tcode(session)

    # 关键修复：不在目标T-code时绝不能盲目按Back。
    # 旧版就是这里会把SAP Easy Access继续Back出去。
    if tcode != TCODE and state not in {"GRID", "DETAIL"}:
        start_transaction(session)
        return

    if REUSE_TRANSACTION:
        if state == "DETAIL":
            print("   ↩️ 当前在APQP详情页：Back一次回结果Grid")
            state = press_back_once(
                session,
                {"GRID", "SELECTION"},
                "DETAIL->GRID",
            )
            if state == "SELECTION":
                return

        if state == "GRID":
            print("   ↩️ 当前在结果Grid：Back一次回ZMFM050035选择页")
            state = press_back_once(
                session,
                "SELECTION",
                "GRID->SELECTION",
            )
            if state == "SELECTION":
                return

    # 页面不符合预期时直接重启目标事务，不再多按Back。
    print(
        f"   🔄 页面状态无法安全复用，直接重新进入{TCODE} "
        f"| T-code={current_tcode(session) or '<unknown>'} "
        f"| Screen={detect_zmfm_screen(session)}"
    )
    start_transaction(session)

def fill_selection(session, material: str, vendor: str) -> None:
    check_c3 = wait_element(session, ID_CHECK_C3)
    plant = wait_element(session, ID_PLANT)
    vendor_field = wait_element(session, ID_VENDOR)
    material_field = wait_element(session, ID_MATERIAL)

    if any(x is None for x in (check_c3, plant, vendor_field, material_field)):
        raise RuntimeError("ZMFM050035选择页面字段不完整")

    check_c3.Selected = True
    plant.Text = PLANT
    vendor_field.Text = vendor
    material_field.Text = material

    time.sleep(SAP_STEP_PAUSE_SEC)


def wait_result_or_message(session, timeout_sec: float = SAP_ELEMENT_TIMEOUT_SEC) -> Tuple[str, str]:
    deadline = time.time() + timeout_sec
    last_status = ""

    while time.time() < deadline:
        wait_not_busy(session, timeout_sec=2)

        grid = find_by_id(session, ID_RESULT_GRID)
        if grid is not None:
            return "GRID", last_status

        if element_exists(session, "wnd[1]"):
            text = popup_text(session)
            dismiss_popup(session)
            return "POPUP", text

        msg_type, msg = status_bar(session)
        if msg:
            last_status = f"{msg_type}:{msg}" if msg_type else msg

        if msg_type in {"E", "A"}:
            return "ERROR", last_status

        time.sleep(SAP_POLL_SEC)

    return "TIMEOUT", last_status


def read_plan_closure_date(session) -> str:
    # 录制脚本里先 TAB2 -> TAB1。这里只需要确保TAB1可见并选中即可。
    tab1 = wait_element(session, ID_TAB1, timeout_sec=6)
    if tab1 is not None:
        try:
            tab1.Select()
        except Exception:
            pass

    date_field = wait_element(session, ID_PLAN_CLOSURE_DATE, timeout_sec=10)
    if date_field is None:
        msg_type, msg = status_bar(session)
        raise RuntimeError(
            "找不到APQP Plan Closure Date字段 GS_ITAB-M_PLNDAT"
            + (f" | SAP={msg_type}:{msg}" if msg else "")
        )

    try:
        return normalize_text(date_field.Text)
    except Exception as exc:
        raise RuntimeError(f"读取APQP Plan Closure Date失败：{exc}") from exc


def query_one(session, task: Task, worker_id: int) -> Result:
    started = time.time()

    try:
        ensure_selection_screen(session)
        fill_selection(session, task.material, task.vendor)

        session.FindById(ID_EXECUTE).Press()
        wait_not_busy(session)

        state, message = wait_result_or_message(session)

        if state != "GRID":
            return Result(
                excel_row=task.excel_row,
                material=task.material,
                vendor=task.vendor,
                status="NO_RESULT" if state in {"POPUP", "ERROR"} else state,
                message=message or f"未进入结果Grid，state={state}",
                worker_id=worker_id,
                elapsed_sec=time.time() - started,
            )

        grid = session.FindById(ID_RESULT_GRID)

        try:
            row_count = int(grid.RowCount)
        except Exception:
            row_count = 0

        if row_count <= 0:
            return Result(
                excel_row=task.excel_row,
                material=task.material,
                vendor=task.vendor,
                status="NO_RESULT",
                message="结果Grid行数=0",
                worker_id=worker_id,
                elapsed_sec=time.time() - started,
            )

        # 完全按你的VBS：选择第0行。
        try:
            grid.CurrentCellColumn = ""
        except Exception:
            pass
        grid.SelectedRows = "0"

        session.FindById(ID_EXECUTE).Press()
        wait_not_busy(session)

        if element_exists(session, "wnd[1]"):
            popup = dismiss_popup(session)
            if popup:
                return Result(
                    excel_row=task.excel_row,
                    material=task.material,
                    vendor=task.vendor,
                    status="DETAIL_POPUP",
                    message=popup,
                    worker_id=worker_id,
                    elapsed_sec=time.time() - started,
                )

        plan_date = read_plan_closure_date(session)

        if not plan_date:
            return Result(
                excel_row=task.excel_row,
                material=task.material,
                vendor=task.vendor,
                status="NO_DATE",
                message="SAP详情页APQP Plan Closure Date为空",
                worker_id=worker_id,
                elapsed_sec=time.time() - started,
            )

        return Result(
            excel_row=task.excel_row,
            material=task.material,
            vendor=task.vendor,
            status="SUCCESS",
            plan_closure_date_text=plan_date,
            message=f"ResultRows={row_count}",
            worker_id=worker_id,
            elapsed_sec=time.time() - started,
        )

    except Exception as exc:
        return Result(
            excel_row=task.excel_row,
            material=task.material,
            vendor=task.vendor,
            status="ERROR",
            message=str(exc),
            worker_id=worker_id,
            elapsed_sec=time.time() - started,
        )


# ============================================================================
# 7. Excel COM读写
# ============================================================================


def get_or_open_excel_workbook(path: Path, sheet_name: str):
    """
    优先连接用户已经打开的Excel；没有则启动独立Excel实例打开文件。
    返回 (excel_app, workbook, worksheet, owns_excel_instance)
    """
    path_norm = os.path.normcase(os.path.abspath(str(path)))

    # 尝试附着已打开Excel。
    try:
        excel = win32com.client.GetActiveObject("Excel.Application")
        for i in range(1, excel.Workbooks.Count + 1):
            wb = excel.Workbooks(i)
            try:
                wb_path = os.path.normcase(os.path.abspath(wb.FullName))
            except Exception:
                continue
            if wb_path == path_norm:
                ws = select_worksheet(wb, sheet_name)
                print("📗 已连接当前打开的Excel工作簿")
                return excel, wb, ws, False
    except Exception:
        pass

    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    try:
        # Do not run workbook macros or update external links on open.
        excel.AutomationSecurity = 3
        wb = excel.Workbooks.Open(str(path), UpdateLinks=0, ReadOnly="--preview" in sys.argv)
        ws = select_worksheet(wb, sheet_name)
    except Exception:
        excel.Quit()
        raise
    print("📗 已由RPA后台打开Excel工作簿")
    return excel, wb, ws, True


def excel_last_row(ws, column: int) -> int:
    # xlUp = -4162
    return int(ws.Cells(ws.Rows.Count, column).End(-4162).Row)


def iter_excel_input_rows(ws, columns=None):
    """One COM Range read per chunk, instead of three COM reads per row.

    New templates use A/B/C; legacy templates use A/D/E. Both preview modes use
    the same snapshot. Runtime still reads the live workbook again before SAP.
    """
    material_col, vendor_col, date_col = columns or (MATERIAL_COL, VENDOR_COL, OUTPUT_DATE_COL)
    last_material_row = excel_last_row(ws, material_col)
    last_vendor_row = excel_last_row(ws, vendor_col)
    last_row = max(last_material_row, last_vendor_row, DATA_START_ROW)
    for start in range(DATA_START_ROW, last_row + 1, 2000):
        end = min(start + 1999, last_row)
        block = ws.Range(f"A{start}:{chr(64 + date_col)}{end}").Value2
        if not isinstance(block, (tuple, list)) or len(block) != end - start + 1:
            raise RuntimeError("Excel returned an incomplete APQP input range. Save the workbook and upload again.")
        for offset, values in enumerate(block):
            if not isinstance(values, (tuple, list)) or len(values) != date_col:
                raise RuntimeError("Excel returned unreadable APQP input columns. No SAP query was started.")
            yield (start + offset, normalize_identifier(values[material_col - 1]),
                   normalize_identifier(values[vendor_col - 1]), normalize_text(values[date_col - 1]))


def select_excel_tasks(input_rows, overwrite_existing) -> Tuple[List[Task], int, int]:

    tasks: List[Task] = []
    skipped_existing = 0
    invalid_rows = 0

    for row, material, vendor, existing in input_rows:
        if not material and not vendor:
            continue

        if not material or not vendor:
            invalid_rows += 1
            continue

        if existing and not overwrite_existing:
            skipped_existing += 1
            continue

        tasks.append(Task(row, material, vendor))

        if TEST_LIMIT > 0 and len(tasks) >= TEST_LIMIT:
            break

    return tasks, skipped_existing, invalid_rows


def read_excel_tasks(ws, columns=None) -> Tuple[List[Task], int, int]:
    return select_excel_tasks(iter_excel_input_rows(ws, columns), OVERWRITE_EXISTING_DATE)


def write_result_to_excel(ws, result: Result, columns=None) -> None:
    if result.status != "SUCCESS":
        return

    cell = ws.Cells(result.excel_row, columns[2] if columns else OUTPUT_DATE_COL)
    parsed = parse_sap_date(result.plan_closure_date_text)

    if parsed is not None:
        # 不再使用：cell.Value = datetime(...)
        # 直接写Excel日期序列号，避免COM时区转换导致日期减1天。
        offset = 1462 if bool(ws.Parent.Date1904) else 0
        cell.Value2 = excel_date_serial(parsed) - offset
        cell.NumberFormat = OUTPUT_DATE_NUMBER_FORMAT

        # 回读校验：确保Excel最终显示的日期与SAP一致。
        try:
            excel_text = normalize_text(cell.Text)
            expected = parsed.strftime("%d.%m.%Y")
            if excel_text and excel_text != expected:
                safe_print(
                    f"⚠️ Excel日期回读不一致 行{result.excel_row}: "
                    f"SAP={expected} Excel={excel_text}"
                )
        except Exception:
            pass
    else:
        # SAP返回未知日期格式时，保留原文本，避免丢数据。
        cell.NumberFormat = "@"
        cell.Value2 = result.plan_closure_date_text


# ============================================================================
# 8. Worker / 主程序
# ============================================================================


PRINT_LOCK = threading.Lock()
STOP_EVENT = threading.Event()
HUB_UNSAFE_EVENT = threading.Event()
HUB_MODE = bool(os.environ.get("HUB_RUN_ID"))


def worker_loop(
    worker_id: int,
    session_ref: SessionRef,
    task_queue: "queue.Queue[Task]",
    result_queue: "queue.Queue[Result]",
) -> None:
    pythoncom.CoInitialize()

    try:
        session = get_session_by_ref(session_ref)

        safe_print(
            f"[W{worker_id}] ✅ 已连接SAP "
            f"[{session_ref.connection_index}/{session_ref.session_index}] "
            f"{session_ref.system}/{session_ref.client}"
        )

        while not STOP_EVENT.is_set() and not (HUB_MODE and HUB_UNSAFE_EVENT.is_set()):
            try:
                task = task_queue.get_nowait()
            except queue.Empty:
                break

            try:
                safe_print(
                    f"[W{worker_id}] ▶ Excel行{task.excel_row} "
                    f"Material={task.material} Vendor={task.vendor}"
                )

                session = get_session_by_ref(session_ref)
                if readable_transaction(session) not in {"", "SESSION_MANAGER", "SMEN", "S000", TCODE}:
                    result = Result(task.excel_row, task.material, task.vendor, "SESSION_CHANGED", message="SAP session switched to another transaction; not interrupted.", worker_id=worker_id)
                else:
                    result = query_one(session, task, worker_id)
                result_queue.put(result)
                if HUB_MODE and result.status not in {"SUCCESS", "NO_RESULT", "NO_DATE"}:
                    HUB_UNSAFE_EVENT.set()

                icon = "✅" if result.status == "SUCCESS" else "⚠️"
                safe_print(
                    f"[W{worker_id}] {icon} 行{task.excel_row} "
                    f"Status={result.status} "
                    f"Date={result.plan_closure_date_text or '-'} "
                    f"Time={result.elapsed_sec:.1f}s "
                    f"{('| ' + result.message) if result.message else ''}"
                )

            finally:
                task_queue.task_done()

    except Exception as exc:
        if HUB_MODE:
            HUB_UNSAFE_EVENT.set()
        safe_print(f"[W{worker_id}] 💥 Worker级错误：{exc}")

    finally:
        pythoncom.CoUninitialize()
        safe_print(f"[W{worker_id}] 🏁 Worker结束")


def emit(event: str, **payload) -> None:
    safe_print("APQP_EVENT " + json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def select_worksheet(wb, name: str):
    if name:
        return wb.Worksheets(name)
    try:
        sheet = wb.Worksheets("APQP_Input")
        validate_headers(sheet)
        return sheet
    except Exception:
        pass
    candidates = []
    for index in range(1, wb.Worksheets.Count + 1):
        sheet = wb.Worksheets(index)
        try:
            validate_headers(sheet)
            candidates.append(sheet)
        except (ValueError, RuntimeError):
            continue
    if len(candidates) != 1:
        raise ValueError("Keep exactly one APQP input worksheet with the template headers.")
    return candidates[0]


def validate_headers(ws):
    """Return an explicit per-sheet mapping; never guess a writable output column."""
    material = {"part no.", "part no", "material", "material no."}
    vendor = {"vendor", "supplier", "parma"}
    date = {"apqp plan closure date"}
    if getattr(ws, 'Range', None) is not None:
        block = ws.Range('A1:E1').Value2
        if not isinstance(block, (tuple, list)) or len(block) != 1 or len(block[0]) != 5:
            raise RuntimeError('Excel returned incomplete APQP headers. No SAP query was started.')
        headers = [normalize_text(value).lower() for value in block[0]]
    else:
        headers = [normalize_text(ws.Cells(1, column).Value2).lower() for column in range(1, 6)]
    if (headers[0] in material and headers[1] in {"ver", "version"} and
            headers[2] == "description" and headers[3] in vendor and headers[4] in date):
        return (1, 4, 5)
    reserved = material | vendor | date | {"ver", "version", "description"}
    if (headers[0] in material and headers[1] in vendor and headers[2] in date and
            not any(header in reserved for header in headers[3:])):
        return (1, 2, 3)
    raise ValueError("APQP headers do not match. Keep A: Part No., B: Vendor, C: APQP plan closure date. Legacy A–E templates are also supported. Save the workbook and upload again.")


def preview_payload(ws, tasks, skipped, invalid):
    return dict(sheetName=str(ws.Name), selected=len(tasks), skipped=skipped, invalid=invalid,
                sample=[dict(material=t.material, vendor=t.vendor, excelRow=t.excel_row) for t in tasks[:12]])


def listen_for_cancel() -> None:
    for line in sys.stdin:
        if line.strip() == "cancel":
            STOP_EVENT.set()
            return


def apply_result(ws, result: Result, columns=None) -> None:
    """Do not overwrite another row or a date changed while the workbook was open."""
    if result.status != "SUCCESS":
        return
    material_col, vendor_col, date_col = columns or (MATERIAL_COL, VENDOR_COL, OUTPUT_DATE_COL)
    if columns is not None:
        try:
            if validate_headers(ws) != columns:
                raise ValueError("APQP column mapping changed.")
        except (ValueError, RuntimeError):
            result.status = "EXCEL_CONFLICT"
            result.message = "Template headers changed while querying; date was not written."
            return
    material = normalize_identifier(ws.Cells(result.excel_row, material_col).Value2)
    vendor = normalize_identifier(ws.Cells(result.excel_row, vendor_col).Value2)
    if (material, vendor) != (result.material, result.vendor):
        result.status = "EXCEL_CONFLICT"
        result.message = "Material/Vendor changed while querying; date was not written."
        return
    if not OVERWRITE_EXISTING_DATE and normalize_text(ws.Cells(result.excel_row, date_col).Value2):
        result.status = "EXCEL_CONFLICT"
        result.message = "An existing date appeared while querying; date was not overwritten."
        return
    try:
        write_result_to_excel(ws, result, columns)
    except Exception as exc:
        result.status = "WRITE_ERROR"
        result.message = str(exc)


def main() -> None:
    if '--dates' in sys.argv:
        from apqp_date_api import main as date_main
        date_main()
        return
    preview_only = "--preview" in sys.argv
    excel_path = Path(EXCEL_PATH).resolve()
    if excel_path.suffix.lower() not in {".xlsx", ".xlsm"} or not excel_path.is_file():
        raise ValueError("Select an existing .xlsx or .xlsm workbook.")
    pythoncom.CoInitialize()
    excel = wb = ws = None
    owns_excel = False
    threads = []
    log_file = None
    hub = HubUserInteraction("APQP", emit, STOP_EVENT) if os.environ.get("HUB_RUN_ID") else None
    tasks = []
    skipped = 0
    try:
        excel_started = time.perf_counter()
        excel, wb, ws, owns_excel = get_or_open_excel_workbook(excel_path, SHEET_NAME)
        excel_open_ms = (time.perf_counter() - excel_started) * 1000
        validation_started = time.perf_counter()
        columns = validate_headers(ws)
        if preview_only:
            input_rows = list(iter_excel_input_rows(ws, columns))
            modes = {}
            for name, overwrite in (("keepExisting", False), ("refreshExisting", True)):
                mode_tasks, mode_skipped, mode_invalid = select_excel_tasks(input_rows, overwrite)
                modes[name] = preview_payload(ws, mode_tasks, mode_skipped, mode_invalid)
            current = modes["refreshExisting" if OVERWRITE_EXISTING_DATE else "keepExisting"]
            emit("preview", preview={**current, "modes": modes})
            return
        tasks, skipped, invalid = read_excel_tasks(ws, columns)
        emit('notice', message=f'APQP timing | Excel attach/open: {excel_open_ms:.0f} ms | live validation: {(time.perf_counter() - validation_started) * 1000:.0f} ms')
        if invalid:
            raise ValueError(f'{invalid} Excel row(s) have an incomplete Part No./Vendor. Correct the current Excel data before querying SAP; no SAP query was started.')
        if bool(wb.ReadOnly):
            raise RuntimeError("Workbook is read-only or open in another Excel instance. Close that copy and retry.")
        if not tasks:
            emit("complete", message="No pending rows.", total=0, processed=0, succeeded=0,
                 skipped=skipped, failed=invalid, workers=0, cancelled=False,
                 resultPath=str(excel_path), backupPath="", logPath="")
            return
        if hub:
            hub.start_listener()
        else:
            threading.Thread(target=listen_for_cancel, daemon=True).start()
        emit("preparing", message="Checking the SAP login and existing windows. Other T-codes can be switched to APQP automatically.")
        verified_refs = None
        if hub:
            emit("notice", message=f"APQP session policy: {APQP_SESSION_POLICY}; target={TARGET_CONNECTION_NAME}; System/Client={TARGET_SYSTEM}/{TARGET_CLIENT}. Save existing SAP work before starting; existing login dialogs will be shown, not auto-confirmed.")
            verified_refs = wait_for_hub_sessions(hub, len(tasks))
        session_refs = prepare_sessions(len(tasks), verified_refs)
        if STOP_EVENT.is_set():
            emit("complete", message="Cancelled before querying.", total=len(tasks), processed=0,
                 succeeded=0, skipped=skipped, failed=0, workers=0, cancelled=True,
                 resultPath=str(excel_path), backupPath="", logPath="")
            return
        # SaveCopyAs includes unsaved data from a workbook the user has open.
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        from hub_artifacts import artifact_directory
        artifacts = artifact_directory('apqp')
        backup_path = artifacts / f"{excel_path.stem}_APQP_Backup_{stamp}{excel_path.suffix}"
        wb.SaveCopyAs(str(backup_path))
        emit("workers", message=f"Using {len(session_refs)} SAP GUI session(s) in {session_refs[0].system}/{session_refs[0].client}.",
             workers=len(session_refs), total=len(tasks),
             system=session_refs[0].system, client=session_refs[0].client)
        task_q = queue.Queue()
        result_q = queue.Queue()
        for task in tasks:
            task_q.put(task)
        log_path = artifacts / f"APQP_PlanClosure_{stamp}.csv"
        log_file = open(log_path, "w", newline="", encoding="utf-8-sig")
        writer = csv.writer(log_file)
        writer.writerow(["Timestamp", "Worker", "Excel Row", "Material", "Vendor", "Status", "APQP Plan Closure Date", "Message"])
        for worker_id, ref in enumerate(session_refs, 1):
            thread = threading.Thread(target=worker_loop, args=(worker_id, ref, task_q, result_q), daemon=False)
            thread.start()
            threads.append(thread)
        completed = succeeded = failed = no_data = 0
        while any(thread.is_alive() for thread in threads) or not result_q.empty():
            try:
                result = result_q.get(timeout=0.3)
            except queue.Empty:
                continue
            apply_result(ws, result, columns)
            completed += 1
            if result.status == "SUCCESS":
                succeeded += 1
            elif result.status in {"NO_RESULT", "NO_DATE"}:
                no_data += 1
            else:
                failed += 1
            writer.writerow([dt.datetime.now().isoformat(), result.worker_id, result.excel_row,
                             result.material, result.vendor, result.status,
                             result.plan_closure_date_text, result.message])
            log_file.flush()
            emit("record", current=completed, total=len(tasks), material=result.material,
                 vendor=result.vendor, worker=result.worker_id, status=result.status,
                 message=f"Row {result.excel_row} | {result.material} / {result.vendor} | {result.status} | {result.plan_closure_date_text or result.message}")
            if completed % SAVE_EVERY_RESULTS == 0:
                wb.Save()
        for thread in threads:
            thread.join()
        wb.Save()
        if hub and HUB_UNSAFE_EVENT.is_set() and not STOP_EVENT.is_set():
            # All query workers have stopped and Excel/logs are flushed before publishing a pause.
            try:
                hub.wait("UNVERIFIED_STATE",
                    "A SAP query could not be safely verified. Partial results were saved; stop and review details.",
                    "有一条 SAP 查询无法安全验证。已保存部分结果，请停止并查看详情。")
            except HubStopped:
                STOP_EVENT.set()
        unprocessed = len(tasks) - completed
        failed += invalid + (0 if STOP_EVENT.is_set() else unprocessed)
        emit("complete", message=f"APQP: {succeeded} dates written, {no_data + skipped} skipped, {failed} failed; {unprocessed} not processed.",
             total=len(tasks), processed=completed, succeeded=succeeded, skipped=no_data + skipped,
             failed=failed, workers=len(session_refs), cancelled=STOP_EVENT.is_set(),
             resultPath=str(excel_path), backupPath=str(backup_path), logPath=str(log_path))
    except HubStopped:
        emit("complete", message="APQP stopped before querying.", total=len(tasks), processed=0,
             succeeded=0, skipped=skipped, failed=0, workers=0, cancelled=True,
             resultPath=str(excel_path), backupPath="", logPath="")
    finally:
        STOP_EVENT.set()
        for thread in threads:
            thread.join()
        if log_file is not None:
            log_file.close()
        if owns_excel:
            try:
                if wb is not None:
                    # All intended updates were explicitly saved above.
                    wb.Close(SaveChanges=False)
            finally:
                if excel is not None:
                    excel.Quit()
        pythoncom.CoUninitialize()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit("fatal", message=str(exc))
        sys.exit(1)
