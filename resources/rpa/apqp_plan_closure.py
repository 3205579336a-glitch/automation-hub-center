# -*- coding: utf-8 -*-
r"""
ZMFM050035 - APQP Plan Closure Date 批量查询并回写 Excel (DateSafe v3)

Excel:
    C:\Users\A533700\Downloads\New Microsoft Excel Worksheet.xlsx
Sheet:
    Sheet1

列定义：
    A = Part No. / Material
    B = Ver            （仅保留，不参与SAP查询）
    C = Description    （仅保留，不参与SAP查询）
    D = Vendor
    E = APQP plan closure date（回写）

SAP查询逻辑：
    T-code = ZMFM050035
    P_C3 = True
    Plant = C100
    Vendor = Excel D列
    Material = Excel A列
    Execute
    结果Grid选择第0行
    Execute
    读取字段：GS_ITAB-M_PLNDAT
    回写Excel E列

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
    3. 默认不会覆盖Excel E列已有日期；需要重查时把 OVERWRITE_EXISTING_DATE=True。
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


# ============================================================================
# 1. 配置区
# ============================================================================

EXCEL_PATH = os.getenv("EXCEL_PATH", "")
SHEET_NAME = os.getenv("SHEET_NAME", "").strip()

DATA_START_ROW = 2
MATERIAL_COL = 1       # A
VENDOR_COL = 4         # D
OUTPUT_DATE_COL = 5    # E

TCODE = "ZMFM050035"
PLANT = os.getenv("PLANT", "C100").strip().upper()

# SAP环境过滤。
# 如果只打开一个SAP系统，可以保持空字符串。
# 如果同时开了QA和Prod，请务必填系统名，例如 "VCE" / "CEQ"（以你SAP Info为准）。
TARGET_SYSTEM = os.getenv("TARGET_SYSTEM", "").strip().upper()
TARGET_CLIENT = os.getenv("TARGET_CLIENT", "").strip()
TARGET_CONNECTION_CONTAINS = ""

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
        except ValueError:
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
    sap_gui_auto = win32com.client.GetObject("SAPGUI")
    return sap_gui_auto.GetScriptingEngine


def get_session_by_ref(ref: SessionRef):
    application = get_sap_application()
    connection = application.Children(ref.connection_index)
    session = connection.Children(ref.session_index)
    if session_info(session)[:3] != (ref.system, ref.client, ref.user):
        raise RuntimeError("SAP session identity changed; refusing to use another system/client/user.")
    return session


def session_info(session) -> Tuple[str, str, str, str]:
    try:
        info = session.Info
        system = normalize_text(getattr(info, "SystemName", ""))
        client = normalize_text(getattr(info, "Client", ""))
        user = normalize_text(getattr(info, "User", ""))
        transaction = normalize_text(getattr(info, "Transaction", ""))
        return system, client, user, transaction
    except Exception:
        return "", "", "", ""


def discover_sap_sessions() -> List[SessionRef]:
    application = get_sap_application()
    refs: List[SessionRef] = []
    for ci in range(application.Children.Count):
        connection = application.Children(ci)
        description = normalize_text(getattr(connection, "Description", ""))
        for si in range(connection.Children.Count):
            session = connection.Children(si)
            system, client, user, transaction = session_info(session)
            if not user or not system or not client:
                continue
            if TARGET_SYSTEM and system.upper() != TARGET_SYSTEM:
                continue
            if TARGET_CLIENT and client != TARGET_CLIENT:
                continue
            refs.append(SessionRef(ci, si, system, client, user, description))
    if not refs:
        raise RuntimeError("No matching signed-in SAP GUI session. Sign in and enable SAP GUI Scripting.")
    environments = {(ref.system, ref.client, ref.user) for ref in refs}
    if len(environments) != 1:
        raise RuntimeError("Multiple SAP systems/clients/users match. Specify System and Client to avoid mixing environments.")
    usable = []
    for ref in refs:
        session = get_session_by_ref(ref)
        if bool(session.Busy) or element_exists(session, "wnd[1]"):
            continue
        if current_tcode(session) not in {"", "SESSION_MANAGER", "SMEN", "S000", TCODE}:
            continue
        usable.append(ref)
    if not usable:
        raise RuntimeError("No idle SAP session is available. Open SAP Easy Access in the selected system; other transactions will not be interrupted.")
    return usable[:MAX_WORKERS]


def prepare_sessions(task_count: int) -> List[SessionRef]:
    refs = discover_sap_sessions()
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


def read_excel_tasks(ws) -> Tuple[List[Task], int, int]:
    last_material_row = excel_last_row(ws, MATERIAL_COL)
    last_vendor_row = excel_last_row(ws, VENDOR_COL)
    last_row = max(last_material_row, last_vendor_row, DATA_START_ROW)

    tasks: List[Task] = []
    skipped_existing = 0
    invalid_rows = 0

    for row in range(DATA_START_ROW, last_row + 1):
        material = normalize_identifier(ws.Cells(row, MATERIAL_COL).Value2)
        vendor = normalize_identifier(ws.Cells(row, VENDOR_COL).Value2)
        existing = normalize_text(ws.Cells(row, OUTPUT_DATE_COL).Value2)

        if not material and not vendor:
            continue

        if not material or not vendor:
            invalid_rows += 1
            continue

        if existing and not OVERWRITE_EXISTING_DATE:
            skipped_existing += 1
            continue

        tasks.append(Task(row, material, vendor))

        if TEST_LIMIT > 0 and len(tasks) >= TEST_LIMIT:
            break

    return tasks, skipped_existing, invalid_rows


def write_result_to_excel(ws, result: Result) -> None:
    if result.status != "SUCCESS":
        return

    cell = ws.Cells(result.excel_row, OUTPUT_DATE_COL)
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

        while not STOP_EVENT.is_set():
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
                if current_tcode(session) not in {"", "SESSION_MANAGER", "SMEN", "S000", TCODE}:
                    result = Result(task.excel_row, task.material, task.vendor, "SESSION_CHANGED", message="SAP session switched to another transaction; not interrupted.", worker_id=worker_id)
                else:
                    result = query_one(session, task, worker_id)
                result_queue.put(result)

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
        safe_print(f"[W{worker_id}] 💥 Worker级错误：{exc}")

    finally:
        pythoncom.CoUninitialize()
        safe_print(f"[W{worker_id}] 🏁 Worker结束")


def create_log_path(excel_path: Path) -> Path:
    return excel_path.with_name(
        f"ZMFM050035_APQP_PlanClosure_"
        f"{dt.datetime.now():%Y%m%d_%H%M%S}.csv"
    )


def emit(event: str, **payload) -> None:
    safe_print("APQP_EVENT " + json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def select_worksheet(wb, name: str):
    if name:
        return wb.Worksheets(name)
    for index in range(1, wb.Worksheets.Count + 1):
        sheet = wb.Worksheets(index)
        if sheet.Name.lower() == "apqp_input":
            return sheet
    return wb.Worksheets(1)


def validate_headers(ws) -> None:
    aliases = [
        {"part no.", "part no", "material", "material no."},
        {"ver", "version"},
        {"description"},
        {"vendor", "supplier", "parma"},
        {"apqp plan closure date"},
    ]
    for column, allowed in enumerate(aliases, 1):
        value = normalize_text(ws.Cells(1, column).Value2).lower()
        if value not in allowed:
            raise RuntimeError(f"Unexpected header in column {column}. Download the APQP template and keep A–E unchanged.")


def preview_payload(ws, tasks, skipped, invalid):
    return dict(sheetName=str(ws.Name), selected=len(tasks), skipped=skipped, invalid=invalid,
                sample=[dict(material=t.material, vendor=t.vendor, excelRow=t.excel_row) for t in tasks[:12]])


def listen_for_cancel() -> None:
    for line in sys.stdin:
        if line.strip() == "cancel":
            STOP_EVENT.set()
            return


def apply_result(ws, result: Result) -> None:
    """Do not overwrite another row or a date changed while the workbook was open."""
    if result.status != "SUCCESS":
        return
    material = normalize_identifier(ws.Cells(result.excel_row, MATERIAL_COL).Value2)
    vendor = normalize_identifier(ws.Cells(result.excel_row, VENDOR_COL).Value2)
    if (material, vendor) != (result.material, result.vendor):
        result.status = "EXCEL_CONFLICT"
        result.message = "Material/Vendor changed while querying; date was not written."
        return
    if not OVERWRITE_EXISTING_DATE and normalize_text(ws.Cells(result.excel_row, OUTPUT_DATE_COL).Value2):
        result.status = "EXCEL_CONFLICT"
        result.message = "An existing date appeared while querying; date was not overwritten."
        return
    try:
        write_result_to_excel(ws, result)
    except Exception as exc:
        result.status = "WRITE_ERROR"
        result.message = str(exc)


def main() -> None:
    preview_only = "--preview" in sys.argv
    excel_path = Path(EXCEL_PATH).resolve()
    if excel_path.suffix.lower() not in {".xlsx", ".xlsm"} or not excel_path.is_file():
        raise ValueError("Select an existing .xlsx or .xlsm workbook.")
    pythoncom.CoInitialize()
    excel = wb = ws = None
    owns_excel = False
    threads = []
    log_file = None
    try:
        excel, wb, ws, owns_excel = get_or_open_excel_workbook(excel_path, SHEET_NAME)
        validate_headers(ws)
        tasks, skipped, invalid = read_excel_tasks(ws)
        if preview_only:
            emit("preview", preview=preview_payload(ws, tasks, skipped, invalid))
            return
        if bool(wb.ReadOnly):
            raise RuntimeError("Workbook is read-only or open in another Excel instance. Close that copy and retry.")
        if not tasks:
            emit("complete", message="No pending rows.", total=0, processed=0, succeeded=0,
                 skipped=skipped, failed=invalid, workers=0, cancelled=False,
                 resultPath=str(excel_path), backupPath="", logPath="")
            return
        threading.Thread(target=listen_for_cancel, daemon=True).start()
        emit("preparing", message="Checking the SAP environment and available idle sessions.")
        session_refs = prepare_sessions(len(tasks))
        if STOP_EVENT.is_set():
            emit("complete", message="Cancelled before querying.", total=len(tasks), processed=0,
                 succeeded=0, skipped=skipped, failed=0, workers=0, cancelled=True,
                 resultPath=str(excel_path), backupPath="", logPath="")
            return
        # SaveCopyAs includes unsaved data from a workbook the user has open.
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        backup_path = excel_path.with_name(f"{excel_path.stem}_APQP_Backup_{stamp}{excel_path.suffix}")
        wb.SaveCopyAs(str(backup_path))
        emit("workers", message=f"Using {len(session_refs)} SAP GUI session(s) in {session_refs[0].system}/{session_refs[0].client}.",
             workers=len(session_refs), total=len(tasks),
             system=session_refs[0].system, client=session_refs[0].client)
        task_q = queue.Queue()
        result_q = queue.Queue()
        for task in tasks:
            task_q.put(task)
        log_path = excel_path.with_name(f"APQP_PlanClosure_{stamp}.csv")
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
            apply_result(ws, result)
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
        unprocessed = len(tasks) - completed
        failed += invalid + (0 if STOP_EVENT.is_set() else unprocessed)
        emit("complete", message=f"APQP: {succeeded} dates written, {no_data + skipped} skipped, {failed} failed; {unprocessed} not processed.",
             total=len(tasks), processed=completed, succeeded=succeeded, skipped=no_data + skipped,
             failed=failed, workers=len(session_refs), cancelled=STOP_EVENT.is_set(),
             resultPath=str(excel_path), backupPath=str(backup_path), logPath=str(log_path))
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
