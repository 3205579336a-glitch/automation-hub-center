import csv
import datetime
import json
import os
import re
import time
import queue
import shutil
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import openpyxl
import pythoncom
import win32com.client
from dotenv import load_dotenv
from playwright.sync_api import Page, Frame, Locator, sync_playwright, TimeoutError as PWTimeout

load_dotenv()


# ============================================================
# 1. 配置区
# ============================================================

EXCEL_PATH = os.getenv(
    "EXCEL_PATH",
    r"C:\Users\A533700\Downloads\Base Data.xlsx",
)

SOURCE_SHEET_NAME = os.getenv("SOURCE_SHEET_NAME", "").strip()

# Excel F列 = 6
PR_COLUMN = int(os.getenv("PR_COLUMN", "9"))
DATA_START_ROW = int(os.getenv("DATA_START_ROW", "2"))

HEADLESS = os.getenv("HEADLESS", "false").strip().lower() == "true"
BROWSER_CHANNEL = os.getenv("BROWSER_CHANNEL", "chrome").strip().lower()
PROCESS_ALL_ITEMS = True
OVERWRITE_EXISTING_PROJECT_REF = (
    os.getenv("OVERWRITE_EXISTING_PROJECT_REF", "true").strip().lower() == "true"
)

MAX_ITEMS_PER_PR = int(os.getenv("MAX_ITEMS_PER_PR", "300"))
PAGE_TIMEOUT_MS = int(os.getenv("PAGE_TIMEOUT_MS", "30000"))
LOGIN_TIMEOUT_SEC = int(os.getenv("LOGIN_TIMEOUT_SEC", "180"))

# Item顶部号码确认切换后，给详情区留出的刷新时间。
# 原版默认1.2秒，对几十个Item会非常慢；快速版默认0.25秒。
# 若SAP环境较慢或发现跨Item读到旧WBS，可调回0.5~1.0。
ITEM_SWITCH_PAUSE_SEC = max(
    0.05,
    float(os.getenv("ITEM_SWITCH_PAUSE_SEC", "0.25")),
)

# 快速模式仍保留“Item号码变化、写入值校验、最终保存”三层验证，
# 只是缓存稳定的SAP DOM ID，并移除重复扫描与固定长等待。
FAST_ITEM_MODE = os.getenv(
    "FAST_ITEM_MODE",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

FAST_TAB_SETTLE_SEC = max(
    0.0,
    float(os.getenv("FAST_TAB_SETTLE_SEC", "0.05")),
)

FAST_FIELD_TIMEOUT_SEC = max(
    1.0,
    float(os.getenv("FAST_FIELD_TIMEOUT_SEC", "4")),
)

FAST_WRITE_VERIFY_TIMEOUT_SEC = max(
    0.5,
    float(os.getenv("FAST_WRITE_VERIFY_TIMEOUT_SEC", "2")),
)

# SAP在PR标题出现后，顶部Item控件可能还会继续异步渲染。
ITEM_HEADER_WAIT_SEC = max(
    3.0,
    float(os.getenv("ITEM_HEADER_WAIT_SEC", "20")),
)

# 仅在“本次运行的当前批次”内合并重复PR。
# 这不是跨运行记忆：关闭程序后不会保留任何历史状态。
# 同一个PR会在ME52N内部遍历全部Item，因此无需按Excel重复行反复修改。
DEDUPLICATE_PRS_CURRENT_RUN = os.getenv(
    "DEDUPLICATE_PRS_CURRENT_RUN",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# ME52N是写操作。默认强制单浏览器，避免多个会话同时修改同一个PR。
FORCE_SINGLE_WORKER_FOR_WRITE = os.getenv(
    "FORCE_SINGLE_WORKER_FOR_WRITE",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# ── 分批处理配置 ────────────────────────────────────────────────
# 默认测试第1批，每批覆盖100个Excel行：
#   第1批：DATA_START_ROW ~ DATA_START_ROW+99
#   第2批：后续100行
#
# BATCH_SIZE=0 表示从DATA_START_ROW开始处理全部剩余行。
BATCH_NUMBER = max(1, int(os.getenv("BATCH_NUMBER", "1")))
BATCH_SIZE = max(0, int(os.getenv("BATCH_SIZE", "100")))

# 可选：直接指定本次从哪个Excel行开始。
# 0 = 按BATCH_NUMBER自动计算；
# 例如首批跑完第2~101行后，可设置：
#   BATCH_START_ROW=102
#   BATCH_SIZE=500
# 这样第二阶段会处理第102~601行，不会跳行。
BATCH_START_ROW = max(
    0,
    int(os.getenv("BATCH_START_ROW", "0")),
)

# ── 多浏览器配置 ────────────────────────────────────────────────
# 每个Worker都会启动一个独立浏览器和独立SAP会话。
# ME52N属于写操作，建议先用3个，确认稳定后再调到4或5。
NUM_WORKERS = max(1, int(os.getenv("NUM_WORKERS", "1")))
WORKER_START_DELAY_SEC = max(
    0.0,
    float(os.getenv("WORKER_START_DELAY_SEC", "2")),
)

# 单个Worker首次进入SAP失败时，不直接让整个程序退出；
# 其他已登录的Worker仍可继续领取队列中的任务。
WORKER_LOGIN_RETRIES = max(
    1,
    int(os.getenv("WORKER_LOGIN_RETRIES", "2")),
)

# 单个PR最终返回ERROR时，在同一个Worker中恢复ME52N并自动重试。
TASK_ERROR_RETRIES = max(
    0,
    int(os.getenv("TASK_ERROR_RETRIES", "1")),
)

# 连续失败达到该数量时，强制重新进入ME52N，避免一个坏会话
# 连续吃掉后续任务。
MAX_CONSECUTIVE_ERRORS = max(
    1,
    int(os.getenv("MAX_CONSECUTIVE_ERRORS", "2")),
)

# ── 无记忆模式 ──────────────────────────────────────────────────
# 每一行Excel都作为独立任务处理，不再用seen_prs记住并跳过重复PR。
# 每个任务开始前重新进入ME52N，避免继承上一条PR的页面状态。
FORCE_FRESH_ME52N_EACH_TASK = os.getenv(
    "FORCE_FRESH_ME52N_EACH_TASK",
    "false",
).strip().lower() in {"1", "true", "yes", "y", "on"}

BASE_URL = (
    "https://ui5ce.volvo.com/sap/bc/gui/sap/its/webgui"
    "?~transaction={tcode}#"
)

NAV_OPTS = {
    "timeout": PAGE_TIMEOUT_MS,
    "wait_until": "commit",
}


# ============================================================
# 2. WBS -> GPN 对照字典
#
# 左边必须是SAP里读取到的外部WBS；
# 右边是要写入 Customer Data -> Project Ref 的GPN。
#
# 后续增加项目时，直接继续添加：
# "新的WBS": "新的GPN",
# ============================================================

# 仅允许处理下面两个WBS。
# 其他任何WBS即使出现在旧字典中，也绝不会写入Project Ref。
TARGET_PROJECT_REF = os.getenv("TARGET_PROJECT_REF", "775873").strip() or "775873"

_default_allowed_wbs = (
    "JY415-03671-01-01-01",
    "JY415-03671-01-01-05",
)
_allowed_wbs_env = os.getenv("ALLOWED_WBS", "").strip()
_configured_allowed_wbs = tuple(
    wbs.strip().upper()
    for wbs in re.split(r"[;,|\r\n]+", _allowed_wbs_env)
    if wbs.strip()
) if _allowed_wbs_env else _default_allowed_wbs

ALLOWED_WBS_TO_GPN: Dict[str, str] = {
    wbs: TARGET_PROJECT_REF for wbs in dict.fromkeys(_configured_allowed_wbs)
}

ALLOWED_WBS = frozenset(ALLOWED_WBS_TO_GPN.keys())

# 保留这个名字是为了兼容后续代码，但内容只有白名单中的两条。
WBS_TO_GPN: Dict[str, str] = dict(ALLOWED_WBS_TO_GPN)


# ============================================================
# 2A. PR级去重、Checkpoint和Excel回写配置
# ============================================================

# Checkpoint主键 = PR + Rule Version。
# 后续若修改WBS白名单、目标Project Ref或覆盖规则，请把v1改成v2。
RULE_VERSION = os.getenv(
    "RULE_VERSION",
    f"{TARGET_PROJECT_REF}-v1",
).strip() or f"{TARGET_PROJECT_REF}-v1"

ENABLE_CHECKPOINT = os.getenv(
    "ENABLE_CHECKPOINT",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

_checkpoint_env = os.getenv("CHECKPOINT_PATH", "").strip()
CHECKPOINT_PATH = (
    _checkpoint_env
    if _checkpoint_env
    else str(Path(EXCEL_PATH).with_name("ME52N_ProjectRef_Checkpoint.xlsx"))
)

CHECKPOINT_SHEET_NAME = os.getenv(
    "CHECKPOINT_SHEET_NAME",
    "RPA_Status",
).strip() or "RPA_Status"

# 下次运行时自动跳过的状态。
# RUNNING / ERROR / PARTIAL / SAVE_ERROR / NO_MATCH默认会重新运行。
SKIP_CHECKPOINT_STATUSES = frozenset(
    status.strip().upper()
    for status in re.split(
        r"[;,|]",
        os.getenv(
            "SKIP_CHECKPOINT_STATUSES",
            "SUCCESS;ALREADY_OK",
        ),
    )
    if status.strip()
)

WRITEBACK_TO_SOURCE_EXCEL = os.getenv(
    "WRITEBACK_TO_SOURCE_EXCEL",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

CREATE_SOURCE_BACKUP = os.getenv(
    "CREATE_SOURCE_BACKUP",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}

# PR与Excel行的映射范围：
# CURRENT_BATCH = 只扫描本批Excel行（推荐，速度快）。跨批次重复PR由Checkpoint跳过；
#                 当后续批次扫描到重复PR时，再回写该批对应行。
# FULL_SHEET    = 每次启动都扫描整个Sheet并立即找到该PR的全部重复行；
#                 大文件或UsedRange异常时可能非常慢。
PR_ROW_MAPPING_SCOPE = os.getenv(
    "PR_ROW_MAPPING_SCOPE",
    "CURRENT_BATCH",
).strip().upper()
if PR_ROW_MAPPING_SCOPE not in {"CURRENT_BATCH", "FULL_SHEET"}:
    PR_ROW_MAPPING_SCOPE = "CURRENT_BATCH"

# 扫描较大范围时定期输出进度，避免看起来像卡死。
SCAN_PROGRESS_EVERY_ROWS = max(
    100,
    int(os.getenv("SCAN_PROGRESS_EVERY_ROWS", "5000")),
)

SOURCE_STATUS_HEADER = os.getenv("SOURCE_STATUS_HEADER", "RPA Status").strip() or "RPA Status"
SOURCE_LAST_RUN_HEADER = os.getenv("SOURCE_LAST_RUN_HEADER", "RPA Last Run").strip() or "RPA Last Run"
SOURCE_NOTE_HEADER = os.getenv("SOURCE_NOTE_HEADER", "RPA Note").strip() or "RPA Note"
SOURCE_RULE_HEADER = os.getenv("SOURCE_RULE_HEADER", "RPA Rule Version").strip() or "RPA Rule Version"
SOURCE_MASTER_ROW_HEADER = os.getenv("SOURCE_MASTER_ROW_HEADER", "RPA Master Row").strip() or "RPA Master Row"

CHECKPOINT_SAVE_RETRIES = max(1, int(os.getenv("CHECKPOINT_SAVE_RETRIES", "5")))
CHECKPOINT_SAVE_RETRY_SEC = max(0.2, float(os.getenv("CHECKPOINT_SAVE_RETRY_SEC", "1")))
SAVE_VERIFY_TIMEOUT_SEC = max(2.0, float(os.getenv("SAVE_VERIFY_TIMEOUT_SEC", "12")))

# 第一次Ctrl+C：停止领取新PR，但让当前PR完成并保存。
GRACEFUL_STOP_AFTER_CURRENT_PR = os.getenv(
    "GRACEFUL_STOP_AFTER_CURRENT_PR",
    "true",
).strip().lower() in {"1", "true", "yes", "y", "on"}


# ============================================================
# 2B. 并发运行状态
# ============================================================

LOG_LOCK = threading.Lock()
SUMMARY_LOCK = threading.Lock()
PRINT_LOCK = threading.Lock()
CHECKPOINT_LOCK = threading.Lock()
SOURCE_EXCEL_LOCK = threading.Lock()
STOP_EVENT = threading.Event()

# 每个Playwright Page只由所属Worker线程使用，因此可安全缓存稳定DOM ID。
# 只缓存 frame索引 + element id，不缓存旧Locator句柄；SAP重绘后仍会重新解析。
PAGE_DOM_CACHE: Dict[int, Dict[str, Tuple[int, str]]] = {}


def safe_print(*args, **kwargs) -> None:
    """避免多个浏览器线程的日志彼此穿插到同一行。"""
    with PRINT_LOCK:
        try:
            print(*args, **kwargs)
        except UnicodeEncodeError:
            # Some corporate Windows consoles still use GBK/cp1252. Keep the
            # worker alive even when an informational emoji cannot be encoded.
            printable = [str(value).encode("ascii", "backslashreplace").decode("ascii") for value in args]
            print(*printable, **kwargs)


def format_me52n_event(payload: Dict[str, Any]) -> str:
    """Serialize desktop events safely when payloads contain pathlib paths."""
    return "ME52N_EVENT " + json.dumps(
        payload,
        ensure_ascii=False,
        default=str,
    )


def same_excel_path(value: Any, expected: Path) -> bool:
    try:
        actual = os.path.normcase(os.path.abspath(str(value)))
        target = os.path.normcase(os.path.abspath(str(expected)))
        return actual == target
    except Exception:
        return False


def find_open_excel_workbook(path: Path) -> Any:
    """Return the matching workbook from the active Excel instance, if any."""
    try:
        excel = win32com.client.GetActiveObject("Excel.Application")
        for index in range(1, excel.Workbooks.Count + 1):
            workbook = excel.Workbooks(index)
            if same_excel_path(workbook.FullName, path):
                return workbook
    except Exception:
        return None
    return None


# ============================================================
# 3. 通用工具
# ============================================================

def normalize_identifier(value: Any) -> str:
    """避免Excel把采购申请号读成 5047061209.0。"""
    if value is None:
        return ""

    if isinstance(value, float) and value.is_integer():
        return str(int(value))

    text = str(value).strip()

    if re.fullmatch(r"\d+\.0", text):
        return text[:-2]

    return text


def normalize_text(value: Any) -> str:
    return (
        str(value or "")
        .replace("\xa0", " ")
        .replace("–", "-")
        .replace("—", "-")
        .strip()
    )


def normalize_wbs(value: Any) -> str:
    text = normalize_text(value).upper()
    text = text.replace("<<<", "").replace(">>>", "")
    text = re.sub(r"\s+", "", text)
    return text.strip("<>")


def utc_now_text() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def goto(page: Page, tcode: str) -> None:
    url = BASE_URL.format(tcode=tcode)

    try:
        page.goto(url, **NAV_OPTS)
    except PWTimeout:
        print(f"⚠️ 打开 {tcode} 超时，尝试刷新并重新进入...")
        try:
            page.reload(timeout=PAGE_TIMEOUT_MS, wait_until="commit")
        except Exception:
            pass
        page.goto(url, timeout=PAGE_TIMEOUT_MS, wait_until="commit")


def frame_text(frame: Frame) -> str:
    try:
        return normalize_text(
            frame.evaluate(
                """
                () => {
                    const output = [];

                    if (document.body) {
                        output.push(document.body.innerText || "");
                        output.push(document.body.textContent || "");
                    }

                    document.querySelectorAll(
                        "input, textarea, select, [title], [aria-label]"
                    ).forEach(el => {
                        output.push(el.value || "");
                        output.push(el.getAttribute("title") || "");
                        output.push(el.getAttribute("aria-label") || "");
                    });

                    return output.join(" ");
                }
                """
            )
        )
    except Exception:
        return ""


def visible(locator: Locator) -> bool:
    try:
        return locator.count() > 0 and locator.first.is_visible()
    except Exception:
        return False


def find_frame(
    page: Page,
    predicate,
    timeout_sec: float = 20,
    interval: float = 0.3,
) -> Optional[Frame]:
    deadline = time.time() + timeout_sec

    while time.time() < deadline:
        for frame in page.frames:
            try:
                if predicate(frame):
                    return frame
            except Exception:
                continue

        time.sleep(interval)

    return None


def css_id_locator(frame: Frame, element_id: str) -> Locator:
    return frame.locator(f'[id={json.dumps(element_id)}]')


def dismiss_continue_buttons(page: Page, timeout_sec: float = 2) -> None:
    """处理SAP保存时可能弹出的 Continue / Yes / OK。"""
    deadline = time.time() + timeout_sec

    button_names = [
        re.compile(r"^Continue$", re.I),
        re.compile(r"^Yes$", re.I),
        re.compile(r"^OK$", re.I),
        re.compile(r"^Enter$", re.I),
    ]

    while time.time() < deadline:
        clicked = False

        for frame in page.frames:
            for name in button_names:
                try:
                    button = frame.get_by_role("button", name=name)
                    if visible(button):
                        button.first.click(timeout=2000)
                        clicked = True
                        time.sleep(0.3)
                        break
                except Exception:
                    continue

            if clicked:
                break

        if not clicked:
            return


def wait_for_me52n(page: Page, timeout_sec: int = LOGIN_TIMEOUT_SEC) -> bool:
    """
    等待登录完成并进入ME52N。
    登录页面不会满足以下特征。
    """
    deadline = time.time() + timeout_sec

    while time.time() < deadline:
        for frame in page.frames:
            text = frame_text(frame).lower()

            if (
                "change purchase req" in text
                or "select document" in text
                or "purchase requisition" in text
                or "account assignment" in text
                or "customer data" in text
            ):
                return True

        time.sleep(0.5)

    return False


# ============================================================
# 4. 根据标签定位SAP输入框
# ============================================================

def find_input_near_label(
    frame: Frame,
    label_text: str,
) -> Optional[Dict[str, Any]]:
    """
    根据画面标签找到同一行右侧最近的 input/textarea/select/role=textbox。

    SAP WebGUI的element id会变化，因此不直接写死ID。
    """
    script = r"""
    (labelWanted) => {
        const norm = value => String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .replace(/:$/, "")
            .trim()
            .toLowerCase();

        const wanted = norm(labelWanted);

        const visible = el => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 1 &&
                rect.height > 1
            );
        };

        const labels = Array.from(
            document.querySelectorAll(
                "label, span, div, td, th, b, font"
            )
        ).filter(el => {
            if (!visible(el)) return false;

            const text = norm(el.innerText || el.textContent || "");
            if (!text) return false;

            return text === wanted || text.startsWith(wanted + " ");
        });

        const inputs = Array.from(
            document.querySelectorAll(
                "input, textarea, select, [role='textbox'], [role='combobox']"
            )
        ).filter(visible);

        let best = null;

        for (const label of labels) {
            const lr = label.getBoundingClientRect();

            for (const input of inputs) {
                const ir = input.getBoundingClientRect();

                const verticalDistance = Math.abs(
                    (lr.top + lr.height / 2) - (ir.top + ir.height / 2)
                );

                const rightGap = ir.left - lr.right;

                // 同一行优先；位于标签右侧优先。
                let score = verticalDistance * 100;

                if (rightGap >= -10) {
                    score += Math.max(0, rightGap);
                } else {
                    score += 100000 + Math.abs(rightGap);
                }

                // 距离太远的一般不是对应字段。
                if (verticalDistance > 45) {
                    score += 50000;
                }

                if (!best || score < best.score) {
                    best = {
                        score,
                        id: input.id || "",
                        tag: input.tagName || "",
                        value:
                            input.value !== undefined
                                ? String(input.value || "")
                                : String(input.innerText || ""),
                        title: input.getAttribute("title") || "",
                        ariaLabel: input.getAttribute("aria-label") || "",
                        lsdata: input.getAttribute("lsdata") || "",
                        x: ir.left,
                        y: ir.top,
                    };
                }
            }
        }

        return best;
    }
    """

    try:
        result = frame.evaluate(script, label_text)

        if result and result.get("id"):
            return result

    except Exception:
        pass

    return None


def collect_json_strings(value: Any) -> List[str]:
    output: List[str] = []

    if isinstance(value, dict):
        for key, child in value.items():
            output.append(str(key))
            output.extend(collect_json_strings(child))

    elif isinstance(value, list):
        for child in value:
            output.extend(collect_json_strings(child))

    elif value is not None:
        output.append(str(value))

    return output


def read_labeled_field(
    page: Page,
    label_text: str,
    timeout_sec: float = 10,
) -> Tuple[str, Optional[Frame], Optional[Dict[str, Any]], List[str]]:
    """
    返回：
        实际值
        所在frame
        元素信息
        从value/title/aria-label/lsdata中收集到的全部候选文本
    """
    deadline = time.time() + timeout_sec

    while time.time() < deadline:
        for frame in page.frames:
            info = find_input_near_label(frame, label_text)

            if not info:
                continue

            candidates = [
                normalize_text(info.get("value")),
                normalize_text(info.get("title")),
                normalize_text(info.get("ariaLabel")),
            ]

            lsdata_raw = info.get("lsdata") or ""

            if lsdata_raw:
                try:
                    candidates.extend(
                        normalize_text(x)
                        for x in collect_json_strings(json.loads(lsdata_raw))
                    )
                except Exception:
                    candidates.append(normalize_text(lsdata_raw))

            candidates = [x for x in candidates if x]

            value = normalize_text(info.get("value"))

            return value, frame, info, candidates

        time.sleep(0.3)

    return "", None, None, []


def fill_labeled_field(
    page: Page,
    label_text: str,
    value: str,
    timeout_sec: float = 10,
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    deadline = time.time() + timeout_sec
    last_error = ""

    while time.time() < deadline:
        for frame in page.frames:
            info = find_input_near_label(frame, label_text)

            if not info or not info.get("id"):
                continue

            locator = css_id_locator(frame, info["id"])

            try:
                locator.click(timeout=3000)

                try:
                    locator.press("Control+A", timeout=2000)
                except Exception:
                    pass

                locator.fill(str(value), timeout=5000)
                locator.dispatch_event("input")
                locator.dispatch_event("change")

                try:
                    locator.press("Tab", timeout=2000)
                except Exception:
                    pass

                return True, "", info

            except Exception as exc:
                last_error = str(exc)

                # SAP部分输入框不允许Playwright fill，使用DOM赋值兜底。
                try:
                    ok = frame.evaluate(
                        """
                        ({elementId, newValue}) => {
                            const el = document.getElementById(elementId);
                            if (!el) return false;

                            el.focus();
                            el.value = newValue;

                            el.dispatchEvent(
                                new Event("input", {bubbles: true})
                            );
                            el.dispatchEvent(
                                new Event("change", {bubbles: true})
                            );
                            el.dispatchEvent(
                                new KeyboardEvent("keydown", {
                                    key: "Tab",
                                    code: "Tab",
                                    bubbles: true
                                })
                            );
                            el.blur();

                            return true;
                        }
                        """,
                        {
                            "elementId": info["id"],
                            "newValue": str(value),
                        },
                    )

                    if ok:
                        return True, "", info

                except Exception as fallback_exc:
                    last_error = (
                        f"{last_error}; DOM兜底失败: {fallback_exc}"
                    )

        time.sleep(0.3)

    return False, last_error or f"找不到字段：{label_text}", None



# ============================================================
# 4A. 快速DOM缓存与字段读写
# ============================================================

def _page_dom_cache(page: Page) -> Dict[str, Tuple[int, str]]:
    return PAGE_DOM_CACHE.setdefault(id(page), {})


def _cache_element(
    page: Page,
    cache_key: str,
    frame: Frame,
    element_id: str,
) -> None:
    if not element_id:
        return

    try:
        frame_index = page.frames.index(frame)
    except ValueError:
        return

    _page_dom_cache(page)[cache_key] = (
        frame_index,
        element_id,
    )


def _cached_locator(
    page: Page,
    cache_key: str,
) -> Tuple[Optional[Frame], Optional[Locator]]:
    entry = _page_dom_cache(page).get(cache_key)
    if not entry:
        return None, None

    frame_index, element_id = entry
    if frame_index < 0 or frame_index >= len(page.frames):
        _page_dom_cache(page).pop(cache_key, None)
        return None, None

    frame = page.frames[frame_index]
    locator = css_id_locator(frame, element_id)

    try:
        if locator.count() > 0:
            return frame, locator.first
    except Exception:
        pass

    _page_dom_cache(page).pop(cache_key, None)
    return None, None


def _read_locator_value(locator: Locator) -> str:
    try:
        return normalize_text(locator.input_value(timeout=800))
    except Exception:
        pass

    try:
        value = locator.get_attribute("value")
        if value is not None:
            return normalize_text(value)
    except Exception:
        pass

    try:
        return normalize_text(locator.inner_text(timeout=800))
    except Exception:
        return ""


def _locator_candidates(locator: Locator) -> List[str]:
    output: List[str] = []

    for attr in ["value", "title", "aria-label", "lsdata"]:
        try:
            value = locator.get_attribute(attr)
            if value:
                output.append(normalize_text(value))
        except Exception:
            continue

    return output


def read_labeled_field_fast(
    page: Page,
    label_text: str,
    cache_key: str,
    timeout_sec: float = FAST_FIELD_TIMEOUT_SEC,
) -> Tuple[str, Optional[Frame], Optional[Dict[str, Any]], List[str]]:
    """优先通过缓存ID直接读取；失败时才执行原来的全DOM标签搜索。"""
    if FAST_ITEM_MODE:
        deadline = time.time() + timeout_sec

        while time.time() < deadline:
            frame, locator = _cached_locator(page, cache_key)
            if frame is None or locator is None:
                break

            try:
                if locator.is_visible():
                    value = _read_locator_value(locator)
                    info = {
                        "id": _page_dom_cache(page)[cache_key][1],
                        "value": value,
                        "title": locator.get_attribute("title") or "",
                        "ariaLabel": locator.get_attribute("aria-label") or "",
                        "lsdata": locator.get_attribute("lsdata") or "",
                    }
                    return value, frame, info, _locator_candidates(locator)
            except Exception:
                _page_dom_cache(page).pop(cache_key, None)
                break

            time.sleep(0.05)

    value, frame, info, candidates = read_labeled_field(
        page,
        label_text,
        timeout_sec=timeout_sec,
    )

    if frame is not None and info and info.get("id"):
        _cache_element(
            page,
            cache_key,
            frame,
            info["id"],
        )

    return value, frame, info, candidates


def fill_known_field_fast(
    page: Page,
    frame: Frame,
    info: Dict[str, Any],
    cache_key: str,
    value: str,
) -> Tuple[bool, str]:
    """使用已经找到的字段ID直接写入，避免再次按标签扫描整个页面。"""
    element_id = normalize_text(info.get("id"))
    if not element_id:
        return False, "字段ID为空"

    _cache_element(page, cache_key, frame, element_id)
    locator = css_id_locator(frame, element_id).first

    try:
        locator.click(timeout=2000, force=True)
        try:
            locator.press("Control+A", timeout=800)
        except Exception:
            pass
        locator.fill(str(value), timeout=2500)
        locator.dispatch_event("input")
        locator.dispatch_event("change")
        try:
            locator.press("Tab", timeout=800)
        except Exception:
            pass
        return True, ""
    except Exception as first_exc:
        try:
            ok = frame.evaluate(
                """
                ({elementId, newValue}) => {
                    const el = document.getElementById(elementId);
                    if (!el) return false;
                    el.focus();
                    el.value = newValue;
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                    el.blur();
                    return true;
                }
                """,
                {
                    "elementId": element_id,
                    "newValue": str(value),
                },
            )
            if ok:
                return True, ""
        except Exception as second_exc:
            return False, f"直接写入失败: {first_exc}; DOM兜底失败: {second_exc}"

        return False, f"直接写入失败: {first_exc}"


def verify_known_field_value(
    page: Page,
    cache_key: str,
    expected_value: str,
    timeout_sec: float = FAST_WRITE_VERIFY_TIMEOUT_SEC,
) -> Tuple[bool, str]:
    """通过同一字段ID快速校验，不再重新按标签搜索。"""
    deadline = time.time() + timeout_sec
    last_value = ""

    while time.time() < deadline:
        _, locator = _cached_locator(page, cache_key)
        if locator is None:
            break

        try:
            last_value = normalize_text(_read_locator_value(locator))
            if last_value == normalize_text(expected_value):
                return True, last_value
        except Exception:
            pass

        time.sleep(0.08)

    return False, last_value


# ============================================================
# 5. SAP标签页、文档选择和Item导航
# ============================================================

def click_tab(
    page: Page,
    tab_name: str,
    timeout_sec: float = 10,
) -> bool:
    cache_key = f"tab:{tab_name.casefold()}"

    if FAST_ITEM_MODE:
        _, cached = _cached_locator(page, cache_key)
        if cached is not None:
            try:
                if cached.is_visible():
                    cached.click(timeout=1800, force=True)
                    if FAST_TAB_SETTLE_SEC > 0:
                        time.sleep(FAST_TAB_SETTLE_SEC)
                    return True
            except Exception:
                _page_dom_cache(page).pop(cache_key, None)

    deadline = time.time() + timeout_sec

    while time.time() < deadline:
        for frame in page.frames:
            candidates = [
                frame.get_by_role(
                    "tab",
                    name=re.compile(
                        rf"^\s*{re.escape(tab_name)}\s*$",
                        re.I,
                    ),
                ),
                frame.get_by_text(
                    re.compile(
                        rf"^\s*{re.escape(tab_name)}\s*$",
                        re.I,
                    ),
                    exact=True,
                ),
                frame.locator(
                    f'[title*={json.dumps(tab_name)} i]'
                ),
            ]

            for locator in candidates:
                try:
                    if not visible(locator):
                        continue

                    target = locator.first
                    element_id = target.get_attribute("id") or ""
                    target.click(timeout=2500, force=True)

                    if element_id:
                        _cache_element(
                            page,
                            cache_key,
                            frame,
                            element_id,
                        )

                    if FAST_TAB_SETTLE_SEC > 0:
                        time.sleep(FAST_TAB_SETTLE_SEC)
                    return True
                except Exception:
                    continue

        time.sleep(0.08 if FAST_ITEM_MODE else 0.3)

    return False



def select_document_dialog_is_open(page: Page) -> bool:
    for frame in page.frames:
        text = frame_text(frame).lower()

        if "select document" in text and "other document" in text:
            return True

    return False


def debug_visible_buttons(page: Page, prefix: str = "") -> None:
    """失败时打印当前SAP页面上的按钮名称和title，便于下一轮精确调整。"""
    print(f"{prefix}🔬 当前页面可见按钮调查:")

    for frame_index, frame in enumerate(page.frames):
        try:
            items = frame.evaluate(
                """
                () => Array.from(
                    document.querySelectorAll(
                        "button, input[type='button'], " +
                        "[role='button'], [title]"
                    )
                ).map(el => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);

                    const isVisible =
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        rect.width > 1 &&
                        rect.height > 1;

                    if (!isVisible) return null;

                    return {
                        text: (el.innerText || el.value || "").trim(),
                        title: el.getAttribute("title") || "",
                        ariaLabel: el.getAttribute("aria-label") || "",
                        id: el.id || "",
                    };
                }).filter(Boolean).slice(0, 80)
                """
            )

            if items:
                print(f"{prefix}   Frame {frame_index}:")
                for item in items:
                    print(
                        f"{prefix}      text='{item['text'][:35]}' "
                        f"| title='{item['title'][:45]}' "
                        f"| aria='{item['ariaLabel'][:45]}' "
                        f"| id='{item['id']}'"
                    )

        except Exception:
            continue


def get_loaded_pr_number(
    page: Page,
) -> str:
    """
    读取当前ME52N页面真正加载的PR。

    优先级：
      1. 页面标题：Change Purchase Req. 98062145
      2. 顶部标题为Purchase Requisition的输入框

    注意：Select Document弹窗打开时不返回结果，避免把弹窗里
    输入的新PR误认为已经加载。
    """
    if select_document_dialog_is_open(page):
        return ""

    title_patterns = [
        re.compile(
            r"Change\s+Purchase\s+Req(?:uisition)?\.?\s+(\d+)",
            re.I,
        ),
        re.compile(
            r"Purchase\s+Requisition\s+(\d+)",
            re.I,
        ),
    ]

    # 先查页面标题，日志里已确认id通常是M0:35-title。
    for frame in page.frames:
        candidates = [
            frame.locator('[id="M0:35-title"]'),
            frame.locator(
                '[title*="Change Purchase Req" i]'
            ),
        ]

        for locator in candidates:
            try:
                count = min(locator.count(), 10)

                for index in range(count):
                    el = locator.nth(index)

                    if not el.is_visible():
                        continue

                    values = [
                        el.inner_text(timeout=1500),
                        el.get_attribute("title") or "",
                        el.get_attribute("aria-label") or "",
                    ]

                    for value in values:
                        for pattern in title_patterns:
                            match = pattern.search(
                                normalize_text(value)
                            )

                            if match:
                                return normalize_identifier(
                                    match.group(1)
                                )

            except Exception:
                continue

    # 再查顶部PR输入框。Select Document已经关闭，所以不会误读弹窗。
    for frame in page.frames:
        try:
            inputs = frame.locator(
                (
                    'input[title="Purchase Requisition"],'
                    '[role="textbox"][title="Purchase Requisition"],'
                    'input[aria-label="Purchase Requisition"],'
                    '[role="textbox"][aria-label="Purchase Requisition"]'
                )
            )

            count = min(inputs.count(), 20)

            values = []

            for index in range(count):
                el = inputs.nth(index)

                if not el.is_visible():
                    continue

                try:
                    value = normalize_identifier(
                        el.input_value(timeout=1500)
                    )
                except Exception:
                    value = normalize_identifier(
                        el.get_attribute("value")
                    )

                if re.fullmatch(r"\d{6,12}", value):
                    box = el.bounding_box()

                    # ME52N顶部字段通常靠近页面上方，优先取y值较小的。
                    values.append(
                        (
                            float(box["y"]) if box else 99999,
                            value,
                        )
                    )

            if values:
                values.sort(key=lambda item: item[0])
                return values[0][1]

        except Exception:
            continue

    return ""


def wait_target_pr_loaded(
    page: Page,
    pr_number: str,
    timeout_sec: float = 40,
) -> Tuple[bool, str]:
    """
    只有同时满足以下条件才算真正加载成功：
      1. Select Document弹窗已经关闭；
      2. 页面标题或顶部PR字段明确等于目标PR；
      3. 页面存在ME52N详情区域。

    这可避免“弹窗里有新PR号码、背景仍是旧PR”导致假成功。
    """
    deadline = time.time() + timeout_sec
    last_loaded_pr = ""

    while time.time() < deadline:
        dismiss_continue_buttons(
            page,
            timeout_sec=0.3,
        )

        if select_document_dialog_is_open(page):
            time.sleep(0.35)
            continue

        loaded_pr = get_loaded_pr_number(page)

        if loaded_pr:
            last_loaded_pr = loaded_pr

        if loaded_pr == pr_number:
            detail_found = False

            for frame in page.frames:
                text = frame_text(frame).lower()

                if (
                    "account assignment" in text
                    or "customer data" in text
                    or "material data" in text
                    or "change purchase req" in text
                ):
                    detail_found = True
                    break

            if detail_found:
                time.sleep(0.5)
                return True, ""

        time.sleep(0.35)

    if last_loaded_pr:
        return (
            False,
            (
                f"目标PR {pr_number} 未真正加载，"
                f"当前页面仍是PR {last_loaded_pr}"
            ),
        )

    return (
        False,
        f"采购申请 {pr_number} 加载超时，未识别到当前页面PR",
    )


def click_other_purchase_requisition(
    page: Page,
) -> bool:
    """
    打开Select Document窗口。

    日志已确认实际按钮：
      text = Other Purchase Requisition
      id   = M0:48::btn[17]
      shortcut = Shift+F5

    依次使用：
      1. 精确ID；
      2. 文字及其可点击父节点；
      3. Shift+F5。
    """
    if select_document_dialog_is_open(page):
        return True

    for attempt in range(1, 4):
        # 方式1：精确ID。
        for frame in page.frames:
            try:
                button = css_id_locator(
                    frame,
                    "M0:48::btn[17]",
                )

                if visible(button):
                    button.first.click(
                        timeout=4000,
                        force=True,
                    )

                    deadline = time.time() + 5

                    while time.time() < deadline:
                        if select_document_dialog_is_open(page):
                            return True
                        time.sleep(0.25)

            except Exception:
                continue

        # 方式2：按可见文字，再尝试最近的可点击父节点。
        for frame in page.frames:
            try:
                texts = frame.get_by_text(
                    re.compile(
                        r"^\s*Other\s+Purchase\s+Requisition\s*$",
                        re.I,
                    ),
                    exact=True,
                )

                count = min(texts.count(), 10)

                for index in range(count):
                    target = texts.nth(index)

                    if not target.is_visible():
                        continue

                    try:
                        target.click(
                            timeout=3000,
                            force=True,
                        )
                    except Exception:
                        parent = target.locator(
                            (
                                "xpath=ancestor-or-self::*["
                                "@role='button' or "
                                "self::button or "
                                "self::input or "
                                "@onclick or "
                                "@lsdata"
                                "][1]"
                            )
                        )

                        if (
                            parent.count() > 0
                            and parent.first.is_visible()
                        ):
                            parent.first.click(
                                timeout=3000,
                                force=True,
                            )
                        else:
                            continue

                    deadline = time.time() + 5

                    while time.time() < deadline:
                        if select_document_dialog_is_open(page):
                            return True
                        time.sleep(0.25)

            except Exception:
                continue

        # 方式3：SAP快捷键。
        try:
            page.keyboard.press("Shift+F5")

            deadline = time.time() + 6

            while time.time() < deadline:
                if select_document_dialog_is_open(page):
                    return True
                time.sleep(0.25)

        except Exception:
            pass

        time.sleep(0.7)

    return False


def open_select_document_dialog(page: Page) -> bool:
    return click_other_purchase_requisition(page)


def get_dialog_pr_value(
    page: Page,
) -> str:
    """
    读取Select Document弹窗中的PR输入框值。
    """
    if not select_document_dialog_is_open(page):
        return ""

    best: Optional[Tuple[float, str]] = None

    for frame in page.frames:
        try:
            info = find_input_near_label(
                frame,
                "Purchase Requisition",
            )

            if not info:
                continue

            value = normalize_identifier(
                info.get("value")
            )

            if not re.fullmatch(r"\d{6,12}", value):
                continue

            score = float(info.get("y", 99999))

            if best is None or score < best[0]:
                best = (score, value)

        except Exception:
            continue

    return best[1] if best else ""


def click_other_document_in_dialog(
    page: Page,
) -> bool:
    """
    点击Select Document弹窗中的Other Document。
    """
    for frame in page.frames:
        candidates = [
            frame.get_by_text(
                re.compile(
                    r"^\s*Other\s+Document\s*$",
                    re.I,
                ),
                exact=True,
            ),
            frame.get_by_role(
                "button",
                name=re.compile(
                    r"^\s*Other\s+Document\s*$",
                    re.I,
                ),
            ),
            frame.locator(
                (
                    '[title*="Other Document" i],'
                    '[aria-label*="Other Document" i],'
                    'input[value*="Other Document" i],'
                    '[lsdata*="Other Document" i]'
                )
            ),
        ]

        for locator in candidates:
            try:
                count = min(locator.count(), 10)

                for index in range(count):
                    target = locator.nth(index)

                    if not target.is_visible():
                        continue

                    try:
                        target.click(
                            timeout=4000,
                            force=True,
                        )
                        return True

                    except Exception:
                        parent = target.locator(
                            (
                                "xpath=ancestor-or-self::*["
                                "@role='button' or "
                                "self::button or "
                                "self::input or "
                                "@onclick or "
                                "@lsdata"
                                "][1]"
                            )
                        )

                        if (
                            parent.count() > 0
                            and parent.first.is_visible()
                        ):
                            parent.first.click(
                                timeout=4000,
                                force=True,
                            )
                            return True

            except Exception:
                continue

    # 默认按钮兜底：在PR字段按Enter。
    for frame in page.frames:
        try:
            info = find_input_near_label(
                frame,
                "Purchase Requisition",
            )

            if not info or not info.get("id"):
                continue

            locator = css_id_locator(
                frame,
                info["id"],
            )

            locator.click(
                timeout=3000,
                force=True,
            )
            locator.press(
                "Enter",
                timeout=3000,
            )
            return True

        except Exception:
            continue

    return False


def recover_me52n_page(
    page: Page,
    reason: str = "",
) -> bool:
    """
    当前Worker页面状态损坏时，重新进入ME52N。
    """
    # 完整重建事务后DOM ID可能变化，先清除当前Page缓存。
    PAGE_DOM_CACHE.pop(id(page), None)

    if reason:
        safe_print(
            f"   🔄 恢复ME52N页面：{reason}"
        )

    # 若掉回Start SAP Easy Access，先尝试点击启动按钮。
    for frame in page.frames:
        try:
            start_button = frame.get_by_text(
                re.compile(
                    r"Start\s+SAP\s+Easy\s+Access",
                    re.I,
                ),
                exact=False,
            )

            if visible(start_button):
                start_button.first.click(
                    timeout=5000,
                    force=True,
                )
                time.sleep(2)
                break

        except Exception:
            continue

    try:
        goto(page, "ME52N")

        if wait_for_me52n(
            page,
            timeout_sec=50,
        ):
            time.sleep(1)
            return True

    except Exception:
        pass

    return False


def choose_purchase_requisition_once(
    page: Page,
    pr_number: str,
) -> Tuple[bool, str]:
    if not open_select_document_dialog(page):
        current_pr = get_loaded_pr_number(page)

        return (
            False,
            (
                "无法打开 Select Document 窗口"
                + (
                    f"，当前页面PR={current_pr}"
                    if current_pr
                    else ""
                )
            ),
        )

    # 选择Purch. Requisition单选框。
    for frame in page.frames:
        try:
            radio = frame.get_by_role(
                "radio",
                name=re.compile(
                    r"Purch\.\s*Requisition",
                    re.I,
                ),
            )

            if visible(radio):
                try:
                    checked = radio.first.is_checked()
                except Exception:
                    checked = (
                        normalize_text(
                            radio.first.get_attribute(
                                "aria-checked"
                            )
                        ).lower() == "true"
                    )

                if not checked:
                    radio.first.click(
                        timeout=3000,
                        force=True,
                    )

                break

        except Exception:
            continue

    ok, error, info = fill_labeled_field(
        page,
        "Purchase Requisition",
        pr_number,
        timeout_sec=12,
    )

    if not ok:
        return (
            False,
            f"无法填写Purchase Requisition：{error}",
        )

    # 填完后重新读取弹窗里的值，避免写入错误输入框。
    time.sleep(0.4)
    actual_dialog_pr = get_dialog_pr_value(page)

    if actual_dialog_pr != pr_number:
        return (
            False,
            (
                "Purchase Requisition输入校验失败："
                f"期望={pr_number}，"
                f"弹窗实际值='{actual_dialog_pr}'"
            ),
        )

    if not click_other_document_in_dialog(page):
        return False, "找不到或无法触发 Other Document 按钮"

    return wait_target_pr_loaded(
        page,
        pr_number,
        timeout_sec=45,
    )


def choose_purchase_requisition(
    page: Page,
    pr_number: str,
) -> Tuple[bool, str]:
    """
    失败后恢复ME52N并再尝试一次。
    """
    errors: List[str] = []

    for attempt in range(1, 3):
        ok, error = choose_purchase_requisition_once(
            page,
            pr_number,
        )

        if ok:
            return True, ""

        errors.append(
            f"第{attempt}次: {error}"
        )

        if attempt < 2:
            if not recover_me52n_page(
                page,
                reason=(
                    f"打开PR {pr_number}失败"
                ),
            ):
                break

    return False, " | ".join(errors)



def _parse_item_text(value: Any) -> Optional[Dict[str, str]]:
    """
    解析：
        1 [ 10 ] 935032, NIPPLE, 1 1/16-12 UN
    """
    raw = normalize_text(value)

    if not raw:
        return None

    match = re.search(
        r"(?:^|\s)(\d+)\s*\[\s*(\d+)\s*\]\s*(.*)",
        raw,
    )

    if not match:
        return None

    return {
        "seq": match.group(1),
        "itemNo": match.group(2),
        "description": normalize_text(match.group(3)),
        "raw": raw,
    }


def mark_item_selector(
    frame: Frame,
) -> Optional[Dict[str, Any]]:
    """
    在SAP页面中识别截图顶部的Item选择框及右侧下拉箭头。

    该控件不一定是标准<select>，因此同时检查value、文本、
    title、aria-label和lsdata，并用位置和尺寸进行评分。
    """
    script = r"""
    () => {
        const norm = value => String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const visible = el => {
            if (!el) return false;

            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);

            return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 4 &&
                rect.height > 4
            );
        };

        document.querySelectorAll(
            '[data-rpa-item-selector="1"],' +
            '[data-rpa-item-arrow="1"]'
        ).forEach(el => {
            el.removeAttribute("data-rpa-item-selector");
            el.removeAttribute("data-rpa-item-arrow");
        });

        const pattern = /(?:^|\s)(\d+)\s*\[\s*(\d+)\s*\]\s*(.*)/;

        const nodes = Array.from(
            document.querySelectorAll(
                "input, select, option, [role='combobox'], " +
                "[role='textbox'], [aria-valuetext], [lsdata], " +
                "span, div, td"
            )
        ).filter(visible);

        const candidates = [];

        for (const el of nodes) {
            const rect = el.getBoundingClientRect();

            if (rect.top > 520) continue;
            if (rect.width < 120 || rect.width > 900) continue;
            if (rect.height > 100) continue;

            const values = [];

            if (
                el.tagName === "SELECT" &&
                el.selectedOptions &&
                el.selectedOptions.length
            ) {
                values.push(el.selectedOptions[0].text);
                values.push(el.selectedOptions[0].value);
            }

            values.push(el.value || "");
            values.push(el.getAttribute("aria-valuetext") || "");
            values.push(el.getAttribute("aria-label") || "");
            values.push(el.getAttribute("title") || "");
            values.push(el.getAttribute("lsdata") || "");
            values.push(el.innerText || "");
            values.push(el.textContent || "");

            let parsed = null;

            for (const value of values) {
                const raw = norm(value);

                if (!raw || raw.length > 500) continue;

                const match = raw.match(pattern);

                if (match) {
                    parsed = {
                        raw,
                        seq: match[1],
                        itemNo: match[2],
                        description: norm(match[3] || ""),
                    };
                    break;
                }
            }

            if (!parsed) continue;

            let score = rect.top * 10 + rect.left / 10;

            if (rect.width >= 250 && rect.width <= 750) {
                score -= 2000;
            }

            const role = String(
                el.getAttribute("role") || ""
            ).toLowerCase();

            if (
                el.tagName === "SELECT" ||
                role === "combobox"
            ) {
                score -= 3000;
            }

            candidates.push({
                el,
                score,
                rect,
                parsed,
            });
        }

        if (!candidates.length) {
            return null;
        }

        candidates.sort((a, b) => a.score - b.score);

        const best = candidates[0];
        best.el.setAttribute(
            "data-rpa-item-selector",
            "1"
        );

        const clickable = Array.from(
            document.querySelectorAll(
                "button, input[type='button'], " +
                "[role='button'], [title], [aria-label], [lsdata]"
            )
        ).filter(visible).map(el => {
            const rect = el.getBoundingClientRect();

            return {
                el,
                rect,
                text: norm(
                    el.innerText ||
                    el.value ||
                    el.getAttribute("title") ||
                    el.getAttribute("aria-label") ||
                    ""
                ),
            };
        }).filter(item => {
            const sameRow =
                Math.abs(item.rect.top - best.rect.top) <= 35;

            const rightOfSelector =
                item.rect.left >= best.rect.right - 15 &&
                item.rect.left <= best.rect.right + 90;

            const metadata = item.text.toLowerCase();

            return (
                sameRow &&
                (
                    rightOfSelector ||
                    metadata.includes("dropdown") ||
                    metadata.includes("open list") ||
                    metadata.includes("select item")
                )
            );
        });

        clickable.sort((a, b) => {
            const aDistance = Math.abs(
                a.rect.left - best.rect.right
            );

            const bDistance = Math.abs(
                b.rect.left - best.rect.right
            );

            return aDistance - bDistance;
        });

        let arrow = null;

        if (clickable.length) {
            arrow = clickable[0].el;
            arrow.setAttribute(
                "data-rpa-item-arrow",
                "1"
            );
        }

        return {
            raw: best.parsed.raw,
            seq: best.parsed.seq,
            itemNo: best.parsed.itemNo,
            description: best.parsed.description,
            selectorId: best.el.id || "",
            selectorTag: best.el.tagName || "",
            x: best.rect.left,
            y: best.rect.top,
            width: best.rect.width,
            height: best.rect.height,
            arrowFound: Boolean(arrow),
            arrowId: arrow ? (arrow.id || "") : "",
        };
    }
    """

    try:
        return frame.evaluate(script)
    except Exception:
        return None


def current_item_signature(
    page: Page,
) -> Optional[Dict[str, Any]]:
    """
    获取当前正在显示的Item。
    """
    best: Optional[Dict[str, Any]] = None
    best_frame_index = -1

    for frame_index, frame in enumerate(page.frames):
        result = mark_item_selector(frame)

        if not result:
            continue

        if (
            best is None
            or float(result.get("y", 99999))
            < float(best.get("y", 99999))
        ):
            best = result
            best_frame_index = frame_index

    if best is not None:
        best["frame_index"] = best_frame_index
        best["key"] = (
            f"{best.get('seq', '')}|"
            f"{best.get('itemNo', '')}|"
            f"{normalize_text(best.get('description', ''))}"
        )

    return best


def open_item_dropdown(
    page: Page,
) -> bool:
    """
    展开截图中的Item下拉列表。
    """
    for frame in page.frames:
        info = mark_item_selector(frame)

        if not info:
            continue

        candidates = [
            frame.locator('[data-rpa-item-arrow="1"]'),
            frame.locator('[data-rpa-item-selector="1"]'),
        ]

        for locator in candidates:
            try:
                if not visible(locator):
                    continue

                locator.first.click(
                    timeout=4000,
                    force=True,
                )
                time.sleep(0.6)

                return True

            except Exception:
                continue

    return False


def collect_open_item_options(
    page: Page,
) -> List[Dict[str, Any]]:
    """
    Item下拉框展开后，读取所有可见选项。
    """
    script = r"""
    () => {
        const norm = value => String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const visible = el => {
            if (!el) return false;

            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);

            return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 20 &&
                rect.height > 5
            );
        };

        const pattern =
            /^\s*(\d+)\s*\[\s*(\d+)\s*\]\s*(.*?)\s*$/;

        const nodes = Array.from(
            document.querySelectorAll(
                "option, li, tr, td, [role='option'], " +
                "[role='listitem'], [lsdata], span, div"
            )
        ).filter(visible);

        const output = [];

        for (const el of nodes) {
            const rect = el.getBoundingClientRect();

            if (rect.height > 75) continue;
            if (rect.width > 950) continue;

            const values = [
                el.innerText,
                el.textContent,
                el.value,
                el.getAttribute("aria-label"),
                el.getAttribute("title"),
                el.getAttribute("lsdata")
            ];

            let parsed = null;

            for (const value of values) {
                const raw = norm(value);

                if (!raw || raw.length > 500) continue;

                const match = raw.match(pattern);

                if (match) {
                    parsed = {
                        raw,
                        seq: match[1],
                        itemNo: match[2],
                        description: norm(match[3] || ""),
                    };
                    break;
                }
            }

            if (!parsed) continue;

            output.push({
                id: el.id || "",
                tag: el.tagName || "",
                role: el.getAttribute("role") || "",
                raw: parsed.raw,
                seq: parsed.seq,
                itemNo: parsed.itemNo,
                description: parsed.description,
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
            });
        }

        return output;
    }
    """

    items: List[Dict[str, Any]] = []

    for frame_index, frame in enumerate(page.frames):
        try:
            results = frame.evaluate(script) or []

            for result in results:
                result["frame_index"] = frame_index
                items.append(result)

        except Exception:
            continue

    # 同一个选项可能在父子元素中出现多次，按Item号去重，
    # 优先保留高度较小、面积较小的真实行元素。
    best_by_item: Dict[str, Dict[str, Any]] = {}

    for item in items:
        item_no = normalize_identifier(
            item.get("itemNo")
        )

        if not item_no:
            continue

        area = (
            float(item.get("width", 0))
            * float(item.get("height", 0))
        )

        item["_area"] = area

        old = best_by_item.get(item_no)

        if old is None or area < old.get("_area", float("inf")):
            best_by_item[item_no] = item

    output = list(best_by_item.values())

    output.sort(
        key=lambda item: (
            int(item.get("seq") or 999999),
            int(item.get("itemNo") or 999999),
        )
    )

    for item in output:
        item.pop("_area", None)

    return output


def get_item_dropdown_entries(
    page: Page,
) -> List[Dict[str, Any]]:
    """
    展开下拉框并获取全部Item，然后关闭列表。
    """
    if not open_item_dropdown(page):
        return []

    items = collect_open_item_options(page)

    try:
        page.keyboard.press("Escape")
    except Exception:
        pass

    time.sleep(0.3)

    return items


def get_item_overview_entries(
    page: Page,
) -> List[Dict[str, Any]]:
    """
    备用方法：从ME52N Item Overview表格的Item列读取全部行。

    日志中已确认Item列标题ID类似：
        grid#C106#0,2#cp4
    """
    script = r"""
    () => {
        const norm = value => String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const visible = el => {
            if (!el) return false;

            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);

            return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 2 &&
                rect.height > 2
            );
        };

        const headers = Array.from(
            document.querySelectorAll(
                '[title="Item of requisition"],' +
                '[aria-label="Item of requisition"]'
            )
        ).filter(visible);

        const output = [];

        for (const header of headers) {
            const match = String(header.id || "").match(
                /^(grid#[^#]+)#0,(\d+)/
            );

            if (!match) continue;

            const prefix = match[1];
            const col = match[2];

            const cells = Array.from(
                document.querySelectorAll(
                    `[id^="${prefix}#"]`
                )
            ).filter(visible);

            for (const cell of cells) {
                const idMatch = String(cell.id || "").match(
                    new RegExp(
                        "^" +
                        prefix.replace(
                            /[.*+?^${}()|[\]\\]/g,
                            "\\$&"
                        ) +
                        "#(\\d+)," +
                        col
                    )
                );

                if (!idMatch) continue;

                const row = Number(idMatch[1]);

                if (!Number.isFinite(row) || row <= 0) {
                    continue;
                }

                const values = [
                    cell.innerText,
                    cell.textContent,
                    cell.value,
                    cell.getAttribute("title"),
                    cell.getAttribute("aria-label"),
                    cell.getAttribute("lsdata")
                ];

                let itemNo = "";

                for (const value of values) {
                    const raw = norm(value);
                    const valueMatch = raw.match(
                        /(?:^|\D)(\d{1,5})(?:\D|$)/
                    );

                    if (valueMatch) {
                        itemNo = valueMatch[1];
                        break;
                    }
                }

                if (!itemNo) continue;

                const rect = cell.getBoundingClientRect();

                output.push({
                    id: cell.id || "",
                    row,
                    itemNo,
                    seq: String(row),
                    description: "",
                    raw: itemNo,
                    x: rect.left,
                    y: rect.top,
                    width: rect.width,
                    height: rect.height,
                });
            }
        }

        return output;
    }
    """

    items: List[Dict[str, Any]] = []

    for frame_index, frame in enumerate(page.frames):
        try:
            results = frame.evaluate(script) or []

            for result in results:
                result["frame_index"] = frame_index
                items.append(result)

        except Exception:
            continue

    best: Dict[str, Dict[str, Any]] = {}

    for item in items:
        item_no = normalize_identifier(
            item.get("itemNo")
        )

        if item_no and item_no not in best:
            best[item_no] = item

    output = list(best.values())

    output.sort(
        key=lambda item: (
            int(item.get("row") or 999999),
            int(item.get("itemNo") or 999999),
        )
    )

    return output


def discover_all_pr_items(
    page: Page,
) -> Tuple[List[Dict[str, Any]], str]:
    """
    同时使用下拉框和Item Overview发现Item，并合并去重。
    """
    dropdown_items = get_item_dropdown_entries(page)
    grid_items = get_item_overview_entries(page)

    merged: Dict[str, Dict[str, Any]] = {}

    for item in dropdown_items + grid_items:
        item_no = normalize_identifier(
            item.get("itemNo")
        )

        if not item_no:
            continue

        # 下拉框内容包含描述，优先于Overview的简单Item号。
        if (
            item_no not in merged
            or (
                item.get("description")
                and not merged[item_no].get("description")
            )
        ):
            merged[item_no] = item

    items = list(merged.values())

    items.sort(
        key=lambda item: (
            int(item.get("seq") or item.get("row") or 999999),
            int(item.get("itemNo") or 999999),
        )
    )

    if dropdown_items and grid_items:
        method = "Item下拉框 + Item Overview"
    elif dropdown_items:
        method = "Item下拉框"
    elif grid_items:
        method = "Item Overview"
    else:
        current = current_item_signature(page)

        if current:
            items = [current]
            method = "当前Item兜底"
        else:
            method = "未识别"

    return items, method


def select_item_from_dropdown(
    page: Page,
    item_no: str,
) -> bool:
    """
    从截图中的下拉列表直接选择指定Item。
    """
    if not open_item_dropdown(page):
        return False

    pattern = re.compile(
        rf"^\s*\d+\s*\[\s*{re.escape(str(item_no))}\s*\]",
        re.I,
    )

    candidates: List[Tuple[float, Locator]] = []

    for frame in page.frames:
        locators = [
            frame.get_by_text(
                pattern,
                exact=False,
            ),
            frame.locator(
                '[role="option"], [role="listitem"], option, li, tr, td'
            ),
        ]

        for locator in locators:
            try:
                count = min(locator.count(), 300)

                for index in range(count):
                    target = locator.nth(index)

                    if not target.is_visible():
                        continue

                    values = []

                    try:
                        values.append(
                            target.inner_text(timeout=500)
                        )
                    except Exception:
                        pass

                    values.extend(
                        [
                            target.get_attribute("value") or "",
                            target.get_attribute("title") or "",
                            target.get_attribute("aria-label") or "",
                        ]
                    )

                    if not any(
                        pattern.search(normalize_text(value))
                        for value in values
                    ):
                        continue

                    box = target.bounding_box()

                    if not box:
                        continue

                    area = float(box["width"]) * float(box["height"])
                    candidates.append((area, target))

            except Exception:
                continue

    candidates.sort(key=lambda pair: pair[0])

    for _, target in candidates:
        try:
            target.click(
                timeout=4000,
                force=True,
            )
            time.sleep(0.8)

            current = current_item_signature(page)

            if (
                current is None
                or normalize_identifier(
                    current.get("itemNo")
                )
                == normalize_identifier(item_no)
            ):
                return True

        except Exception:
            continue

    try:
        page.keyboard.press("Escape")
    except Exception:
        pass

    return False


def select_item_from_overview(
    page: Page,
    item: Dict[str, Any],
) -> bool:
    """
    从Item Overview表格点击对应Item行。
    """
    frame_index = int(item.get("frame_index", -1))
    element_id = normalize_text(item.get("id"))

    if (
        frame_index < 0
        or frame_index >= len(page.frames)
        or not element_id
    ):
        return False

    frame = page.frames[frame_index]

    try:
        cell = css_id_locator(
            frame,
            element_id,
        )

        cell.click(
            timeout=4000,
            force=True,
        )

        # SAP表格有时第一次点击只选中单元格，再按Enter加载详情。
        try:
            cell.press(
                "Enter",
                timeout=1500,
            )
        except Exception:
            pass

        time.sleep(0.8)
        return True

    except Exception:
        return False


def select_pr_item(
    page: Page,
    item: Dict[str, Any],
) -> bool:
    """
    优先通过下拉框选择，失败时使用Item Overview表格。
    """
    item_no = normalize_identifier(
        item.get("itemNo")
    )

    current = current_item_signature(page)

    if (
        current
        and normalize_identifier(
            current.get("itemNo")
        )
        == item_no
    ):
        return True

    if select_item_from_dropdown(
        page,
        item_no,
    ):
        return True

    # 重新从Overview中找相同Item，避免下拉框元素信息已过期。
    overview_items = get_item_overview_entries(page)

    for overview_item in overview_items:
        if normalize_identifier(
            overview_item.get("itemNo")
        ) == item_no:
            if select_item_from_overview(
                page,
                overview_item,
            ):
                return True

    if item.get("id"):
        return select_item_from_overview(
            page,
            item,
        )

    return False





# ============================================================
# 5A. 可验证的Item顺序导航
# ============================================================

def read_current_item_header(
    page: Page,
) -> Optional[Dict[str, Any]]:
    """
    读取顶部真实Item控件，例如：
        1 [ 10 ] 935032, NIPPLE, 1 1/16-12 UN

    以 Next item 按钮为定位锚点，优先选它左侧同一行的控件，
    避免把Item Overview表格里的数字当成当前Item。
    """
    script = r"""
    () => {
        const norm = value => String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const visible = el => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 2 &&
                rect.height > 2
            );
        };

        const pattern = /(?:^|\s)(\d+)\s*\[\s*(\d+)\s*\]\s*(.*)/;

        const nextEls = Array.from(document.querySelectorAll(
            '[id="M0:46:1:4:2:1:1::0:61"],' +
            '[title="Next item"],' +
            '[aria-label="Next item"],' +
            '[title*="Next item" i],' +
            '[aria-label*="Next item" i]'
        )).filter(visible);

        const nextRect = nextEls.length
            ? nextEls[0].getBoundingClientRect()
            : null;

        const nodes = Array.from(document.querySelectorAll(
            "input, select, option, [role='combobox'], " +
            "[role='textbox'], [aria-valuetext], [lsdata], " +
            "span, div, td"
        )).filter(visible);

        const matches = [];

        for (const el of nodes) {
            const rect = el.getBoundingClientRect();
            if (rect.top > 550) continue;
            if (rect.width < 80 || rect.width > 1000) continue;
            if (rect.height > 130) continue;

            const values = [];
            if (
                el.tagName === "SELECT" &&
                el.selectedOptions &&
                el.selectedOptions.length
            ) {
                values.push(el.selectedOptions[0].text);
                values.push(el.selectedOptions[0].value);
            }

            values.push(el.value || "");
            values.push(el.getAttribute("aria-valuetext") || "");
            values.push(el.getAttribute("aria-label") || "");
            values.push(el.getAttribute("title") || "");
            values.push(el.getAttribute("lsdata") || "");
            values.push(el.innerText || "");
            values.push(el.textContent || "");

            let parsed = null;
            for (const value of values) {
                const raw = norm(value);
                if (!raw || raw.length > 600) continue;
                const match = raw.match(pattern);
                if (match) {
                    parsed = {
                        raw,
                        seq: match[1],
                        itemNo: match[2],
                        description: norm(match[3] || ""),
                    };
                    break;
                }
            }
            if (!parsed) continue;

            let score = rect.top * 10 + rect.left / 10;
            if (nextRect) {
                const vertical = Math.abs(
                    (rect.top + rect.height / 2) -
                    (nextRect.top + nextRect.height / 2)
                );
                const gap = nextRect.left - rect.right;
                score = vertical * 1000 + (
                    gap >= -30
                        ? Math.abs(gap)
                        : 100000 + Math.abs(gap)
                );
            }

            const role = String(el.getAttribute("role") || "").toLowerCase();
            if (el.tagName === "SELECT" || role === "combobox") {
                score -= 5000;
            }
            if (rect.width >= 200 && rect.width <= 800) {
                score -= 2000;
            }

            matches.push({
                score,
                id: el.id || "",
                tag: el.tagName || "",
                raw: parsed.raw,
                seq: parsed.seq,
                itemNo: parsed.itemNo,
                description: parsed.description,
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
            });
        }

        if (!matches.length) return null;
        matches.sort((a, b) => a.score - b.score);
        return matches[0];
    }
    """

    best = None
    best_frame_index = -1

    for frame_index, frame in enumerate(page.frames):
        try:
            result = frame.evaluate(script)
            if not result:
                continue
            if (
                best is None
                or float(result.get("score", 999999))
                < float(best.get("score", 999999))
            ):
                best = result
                best_frame_index = frame_index
        except Exception:
            continue

    if best:
        best["frame_index"] = best_frame_index
        best["itemNo"] = normalize_identifier(best.get("itemNo"))
        best["seq"] = normalize_identifier(best.get("seq"))
        best["key"] = (
            f"{best.get('seq', '')}|"
            f"{best.get('itemNo', '')}|"
            f"{normalize_text(best.get('description', ''))}"
        )

    return best



def _parse_item_header_text_relaxed(value: Any) -> Optional[Dict[str, str]]:
    """兼容SAP顶部Item控件的几种显示格式。"""
    raw = normalize_text(value)
    if not raw:
        return None

    patterns = [
        # 1 [ 10 ] 935032, description
        re.compile(r"(?:^|\s)(\d+)\s*\[\s*(\d+)\s*\]\s*(.*)"),
        # [ 10 ] 935032, description
        re.compile(r"^\s*\[\s*(\d+)\s*\]\s*(.*)"),
        # Item 10 / Item: 10
        re.compile(r"\bItem\s*[:#-]?\s*(\d{1,5})\b", re.I),
    ]

    match = patterns[0].search(raw)
    if match:
        return {
            "seq": match.group(1),
            "itemNo": match.group(2),
            "description": normalize_text(match.group(3)),
            "raw": raw,
        }

    match = patterns[1].search(raw)
    if match:
        return {
            "seq": "",
            "itemNo": match.group(1),
            "description": normalize_text(match.group(2)),
            "raw": raw,
        }

    match = patterns[2].search(raw)
    if match:
        return {
            "seq": "",
            "itemNo": match.group(1),
            "description": "",
            "raw": raw,
        }

    return None


def read_current_item_header_relaxed(
    page: Page,
) -> Optional[Dict[str, Any]]:
    """
    先使用严格识别；失败后使用旧版Item selector和Item标签附近输入框兜底。
    只接受非0 Item，避免把Item Overview的行号0误认为真实Item。
    """
    current = read_current_item_header(page)
    if current and normalize_identifier(current.get("itemNo")) not in {"", "0"}:
        return current

    # 旧版selector识别器对部分SAP WebGUI布局更有效。
    try:
        current = current_item_signature(page)
    except Exception:
        current = None

    if current:
        item_no = normalize_identifier(current.get("itemNo"))
        raw = normalize_text(current.get("raw"))
        if item_no not in {"", "0"} and "[" in raw and "]" in raw:
            return current

    # 最后按顶部Item标签附近的输入/组合框读取。
    for frame_index, frame in enumerate(page.frames):
        try:
            info = find_input_near_label(frame, "Item")
            if not info:
                continue

            y = float(info.get("y", 99999))
            if y > 650:
                continue

            candidates = [
                info.get("value"),
                info.get("title"),
                info.get("ariaLabel"),
                info.get("lsdata"),
            ]

            lsdata_raw = info.get("lsdata") or ""
            if lsdata_raw:
                try:
                    candidates.extend(
                        collect_json_strings(json.loads(lsdata_raw))
                    )
                except Exception:
                    pass

            for candidate in candidates:
                parsed = _parse_item_header_text_relaxed(candidate)
                if not parsed:
                    continue

                item_no = normalize_identifier(parsed.get("itemNo"))
                if item_no in {"", "0"}:
                    continue

                return {
                    **parsed,
                    "itemNo": item_no,
                    "frame_index": frame_index,
                    "id": info.get("id", ""),
                    "key": (
                        f"{parsed.get('seq', '')}|"
                        f"{item_no}|"
                        f"{normalize_text(parsed.get('description', ''))}"
                    ),
                }
        except Exception:
            continue

    return None


def wait_for_current_item_header(
    page: Page,
    timeout_sec: float = ITEM_HEADER_WAIT_SEC,
) -> Optional[Dict[str, Any]]:
    """等待SAP异步完成顶部Item控件渲染。"""
    deadline = time.time() + timeout_sec

    while time.time() < deadline:
        current = read_current_item_header_relaxed(page)
        if current:
            return current
        time.sleep(0.10 if FAST_ITEM_MODE else 0.4)

    return None


def debug_item_header_candidates(page: Page, prefix: str = "") -> None:
    """Item识别失败时打印顶部区域可疑控件，便于继续精确调整。"""
    safe_print(f"{prefix}🔬 顶部Item候选调查:")

    script = r"""
    () => {
        const norm = v => String(v || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const visible = el => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 2 && r.height > 2 &&
                s.display !== 'none' && s.visibility !== 'hidden';
        };
        return Array.from(document.querySelectorAll(
            "input, select, [role='combobox'], [role='textbox'], " +
            "[aria-valuetext], [title], [aria-label], [lsdata], span, div"
        )).filter(visible).map(el => {
            const r = el.getBoundingClientRect();
            const values = [
                el.value,
                el.innerText,
                el.getAttribute('aria-valuetext'),
                el.getAttribute('title'),
                el.getAttribute('aria-label'),
                el.getAttribute('lsdata')
            ].map(norm).filter(Boolean);
            return {
                id: el.id || '',
                y: Math.round(r.top),
                x: Math.round(r.left),
                width: Math.round(r.width),
                values
            };
        }).filter(x =>
            x.y < 650 && x.values.some(v =>
                /\[\s*\d+\s*\]/.test(v) || /\bitem\b/i.test(v)
            )
        ).slice(0, 30);
    }
    """

    for frame_index, frame in enumerate(page.frames):
        try:
            rows = frame.evaluate(script) or []
            for row in rows:
                safe_print(
                    f"{prefix}   Frame={frame_index} id='{row.get('id', '')}' "
                    f"| x={row.get('x')} y={row.get('y')} w={row.get('width')} "
                    f"| values={row.get('values', [])[:4]}"
                )
        except Exception:
            continue


def wait_item_header_change(
    page: Page,
    old_item_no: str,
    timeout_sec: float = 10,
) -> Optional[Dict[str, Any]]:
    deadline = time.time() + timeout_sec
    old_item_no = normalize_identifier(old_item_no)

    while time.time() < deadline:
        current = read_current_item_header_relaxed(page)
        if (
            current
            and current.get("itemNo")
            and current.get("itemNo") != old_item_no
        ):
            time.sleep(ITEM_SWITCH_PAUSE_SEC)
            return current
        time.sleep(0.08 if FAST_ITEM_MODE else 0.25)

    return None


def click_item_navigation_button(
    page: Page,
    direction: str,
    old_item_no: str,
    timeout_sec: float = 10,
) -> Optional[Dict[str, Any]]:
    """点击Previous/Next item，并验证顶部Item号码真的改变。"""
    if direction == "next":
        exact_id = "M0:46:1:4:2:1:1::0:61"
        title_pattern = re.compile(r"^Next\s+item$", re.I)
    elif direction == "previous":
        exact_id = "M0:46:1:4:2:1:1::0:58"
        title_pattern = re.compile(r"^Previous\s+item$", re.I)
    else:
        raise ValueError("direction必须是previous或next")

    for frame in page.frames:
        candidates = [
            css_id_locator(frame, exact_id),
            frame.locator(
                '[title*="' + direction + ' item" i],'
                '[aria-label*="' + direction + ' item" i]'
            ),
            frame.get_by_role("button", name=title_pattern),
        ]

        for locator in candidates:
            try:
                if not visible(locator):
                    continue
                locator.first.click(timeout=4000, force=True)
                changed = wait_item_header_change(
                    page,
                    old_item_no,
                    timeout_sec=timeout_sec,
                )
                if changed:
                    return changed
            except Exception:
                continue

    return None


def rewind_to_first_item(
    page: Page,
) -> Tuple[bool, Optional[Dict[str, Any]], int]:
    """连续点击Previous item，直到Item号码不再变化。"""
    current = wait_for_current_item_header(page)
    if not current:
        return False, None, 0

    moves = 0
    seen = set()

    for _ in range(MAX_ITEMS_PER_PR):
        item_no = normalize_identifier(current.get("itemNo"))
        if not item_no or item_no == "0":
            return False, None, moves
        if item_no in seen:
            break
        seen.add(item_no)

        previous = click_item_navigation_button(
            page,
            "previous",
            item_no,
            timeout_sec=5,
        )
        if not previous:
            break
        current = previous
        moves += 1

    return True, current, moves


def click_next_item_verified(
    page: Page,
    old_item_no: str,
) -> Optional[Dict[str, Any]]:
    return click_item_navigation_button(
        page,
        "next",
        old_item_no,
        timeout_sec=8,
    )


# ============================================================
# 6. WBS读取、Project Ref写入和保存
# ============================================================

WBS_REGEX = re.compile(
    r"JY\d{3}-\d{5}-\d{2}-\d{2}-\d{2}",
    re.I,
)


def extract_external_wbs(
    raw_value: str,
    candidates: List[str],
) -> str:
    """
    SAP某些字段画面上可能显示 <<<PR08559197>>>，
    但title、aria-label或lsdata中可能保存外部WBS。
    因此会检查所有候选内容。
    """
    all_texts = [raw_value] + candidates

    for text in all_texts:
        match = WBS_REGEX.search(normalize_text(text).upper())

        if match:
            return normalize_wbs(match.group(0))

    return normalize_wbs(raw_value)


def read_wbs_element(
    page: Page,
) -> Tuple[str, Dict[str, Any]]:
    if not click_tab(page, "Account Assignment", timeout_sec=6):
        return "", {
            "error": "无法打开 Account Assignment 标签页"
        }

    raw_value, frame, info, candidates = read_labeled_field_fast(
        page,
        "WBS Element",
        cache_key="field:wbs_element",
        timeout_sec=FAST_FIELD_TIMEOUT_SEC,
    )

    if info is None:
        return "", {
            "error": "找不到 WBS Element 字段"
        }

    external_wbs = extract_external_wbs(
        raw_value,
        candidates,
    )

    return external_wbs, {
        "raw_value": raw_value,
        "candidates": candidates,
        "element_id": info.get("id", ""),
        "title": info.get("title", ""),
        "aria_label": info.get("ariaLabel", ""),
    }


def write_project_ref(
    page: Page,
    gpn: str,
) -> Tuple[bool, bool, str, str]:
    """
    快速安全写入：
      - 只进行一次标签定位；后续Item复用字段ID；
      - 使用同一个字段ID直接写入；
      - 使用同一个字段ID快速校验；
      - 仍保留覆盖配置与最终PR保存。
    """
    if not click_tab(page, "Customer Data", timeout_sec=6):
        return False, False, "", "无法打开 Customer Data 标签页"

    old_value, frame, info, candidates = read_labeled_field_fast(
        page,
        "Project Ref",
        cache_key="field:project_ref",
        timeout_sec=FAST_FIELD_TIMEOUT_SEC,
    )

    if info is None or frame is None:
        return False, False, "", "找不到 Project Ref 字段"

    old_value = normalize_text(old_value)
    gpn = normalize_identifier(gpn)

    if old_value == gpn:
        return True, False, old_value, ""

    if old_value and not OVERWRITE_EXISTING_PROJECT_REF:
        return (
            True,
            False,
            old_value,
            "Project Ref已有值，按照配置未覆盖",
        )

    ok, error = fill_known_field_fast(
        page,
        frame,
        info,
        cache_key="field:project_ref",
        value=gpn,
    )

    if not ok:
        return False, False, old_value, error

    verified, verify_value = verify_known_field_value(
        page,
        cache_key="field:project_ref",
        expected_value=gpn,
    )

    if not verified:
        # 缓存失效时仅做一次原始标签读取兜底，避免为了速度牺牲正确性。
        verify_value, _, _, _ = read_labeled_field(
            page,
            "Project Ref",
            timeout_sec=2,
        )
        verify_value = normalize_text(verify_value)

        if verify_value != gpn:
            return (
                False,
                False,
                old_value,
                f"写入后校验失败，页面值为 '{verify_value}'",
            )

    return True, True, old_value, ""



def save_purchase_requisition(page: Page) -> Tuple[bool, str]:
    """
    点击Save后必须读到SAP明确的保存成功消息。

    以前只要按钮点击没有抛异常就返回成功，这会把权限错误、锁定、
    或SAP未接受修改误记为SUCCESS。现在没有确认消息时按SAVE_ERROR处理。
    """
    clicked = False

    for frame in page.frames:
        candidates = [
            frame.get_by_role(
                "button",
                name=re.compile(r"^Save", re.I),
            ),
            frame.locator(
                '[title^="Save" i], [aria-label^="Save" i]'
            ),
        ]

        for locator in candidates:
            try:
                if visible(locator):
                    locator.first.click(timeout=4000)
                    clicked = True
                    break
            except Exception:
                continue

        if clicked:
            break

    if not clicked:
        try:
            page.keyboard.press("Control+S")
            clicked = True
        except Exception as exc:
            return False, f"Save按钮和Ctrl+S均失败：{exc}"

    dismiss_continue_buttons(page, timeout_sec=4)

    success_patterns = [
        r"Purchase requisition\s+\d+\s+(?:has been\s+)?(?:changed|saved)",
        r"Document\s+\d+\s+(?:has been\s+)?(?:changed|saved)",
    ]
    failure_patterns = [
        r"Document has not been changed",
        r"No data was changed",
        r"not authorized",
        r"could not be saved",
        r"was not saved",
        r"is locked",
    ]
    deadline = time.monotonic() + SAVE_VERIFY_TIMEOUT_SEC
    last_failure = ""

    while time.monotonic() < deadline:
        messages: List[str] = []
        for frame in page.frames:
            text = frame_text(frame)
            for pattern in failure_patterns:
                match = re.search(pattern, text, re.I)
                if match:
                    last_failure = match.group(0)
            for pattern in success_patterns:
                match = re.search(pattern, text, re.I)
                if match:
                    messages.append(match.group(0))

        if last_failure:
            return False, f"SAP未确认保存：{last_failure}"
        if messages:
            return True, " | ".join(dict.fromkeys(messages))
        time.sleep(0.2)

    return False, "点击Save后未检测到SAP保存成功消息"


# ============================================================
# 7. 单个PR处理
# ============================================================

def process_purchase_requisition(
    page: Page,
    excel_row: int,
    pr_number: str,
) -> Dict[str, Any]:
    print(f"\n▶ Excel行{excel_row} | 开始处理PR {pr_number}")

    if FORCE_FRESH_ME52N_EACH_TASK:
        fresh_ok = recover_me52n_page(
            page,
            reason=(
                f"无记忆模式：Excel行{excel_row}处理PR {pr_number}前"
                "重新进入ME52N"
            ),
        )

        if not fresh_ok:
            return {
                "status": "ERROR",
                "pr": pr_number,
                "excel_row": excel_row,
                "changed_items": 0,
                "matched_items": 0,
                "unmapped_items": 0,
                "filtered_items": 0,
                "item_errors": 1,
                "save_message": "",
                "detail": "无记忆模式下重新进入ME52N失败",
            }

    opened, error = choose_purchase_requisition(page, pr_number)

    if not opened:
        print(f"❌ PR {pr_number} 打开失败：{error}")
        return {
            "status": "ERROR",
            "pr": pr_number,
            "excel_row": excel_row,
            "changed_items": 0,
            "matched_items": 0,
            "unmapped_items": 0,
            "filtered_items": 0,
            "item_errors": 1,
            "save_message": "",
            "detail": error,
        }

    print(f"✅ PR {pr_number} 已加载")

    # rewind_to_first_item内部已经包含顶部Item等待，不再提前重复扫描一次。
    header_ok, current, rewind_moves = rewind_to_first_item(page)
    if not header_ok or current is None:
        print(
            f"❌ PR {pr_number} 等待{ITEM_HEADER_WAIT_SEC:.0f}秒后仍无法识别"
            "顶部真实Item控件，本PR停止处理"
        )
        debug_item_header_candidates(page, prefix="   ")
        return {
            "status": "ERROR",
            "pr": pr_number,
            "excel_row": excel_row,
            "changed_items": 0,
            "matched_items": 0,
            "unmapped_items": 0,
            "filtered_items": 0,
            "item_errors": 1,
            "save_message": "",
            "detail": "无法识别顶部真实Item控件",
        }

    print(
        f"↤ PR {pr_number} 已定位到第一Item "
        f"| Item={current.get('itemNo')} "
        f"| 回退次数={rewind_moves}"
    )

    # 仅用于防止同一个PR内部Next Item循环；每个PR都会重新创建，
    # 不会跨PR、跨Excel行保存任何记忆。
    seen_items = set()
    item_logs = []
    matched_items = 0
    changed_items = 0
    filtered_items = 0
    item_errors = 0
    processed_items = 0

    for item_index in range(1, MAX_ITEMS_PER_PR + 1):
        # current来自首次定位或上一次已验证的Next Item结果，
        # 不再每个Item开始时重复扫描整个页面。
        if not current:
            item_errors += 1
            print(
                f"   ❌ 第{item_index}个Item无法读取顶部Item号码，"
                "停止当前PR，避免继续误处理"
            )
            item_logs.append(
                f"Index {item_index}: 顶部Item读取失败"
            )
            break

        item_no = normalize_identifier(current.get("itemNo"))
        item_description = normalize_text(current.get("description"))

        if not item_no or item_no == "0":
            item_errors += 1
            print(
                f"   ❌ 识别到无效Item号码 '{item_no}'，"
                "停止当前PR"
            )
            item_logs.append(
                f"Item {item_no or '<空>'}: 无效Item号码"
            )
            break

        if item_no in seen_items:
            print(
                f"↩️ PR {pr_number} Item已循环回到 "
                f"{item_no}，停止遍历"
            )
            break

        seen_items.add(item_no)
        processed_items += 1

        print(
            f"   ── [{item_index}] 当前前端Item "
            f"{item_no} {item_description[:70]}"
        )

        wbs, wbs_debug = read_wbs_element(page)

        if not wbs:
            item_errors += 1
            error_text = wbs_debug.get("error", "WBS Element为空")
            print(f"   ❌ Item {item_no} 无法读取WBS：{error_text}")
            item_logs.append(
                f"Item {item_no}: WBS读取失败({error_text})"
            )
        else:
            wbs = normalize_wbs(wbs)
            print(
                f"   🔎 Item {item_no} WBS='{wbs}' "
                f"| raw='{wbs_debug.get('raw_value', '')}' "
                f"| id='{wbs_debug.get('element_id', '')}'"
            )

            if wbs not in ALLOWED_WBS:
                filtered_items += 1
                print(
                    f"   ⏭️ Item {item_no} WBS={wbs} "
                    "不在允许清单中，跳过"
                )
                item_logs.append(
                    f"Item {item_no}: WBS={wbs}, 白名单外跳过"
                )
            else:
                gpn = ALLOWED_WBS_TO_GPN[wbs]
                matched_items += 1
                ok, changed, old_value, write_error = write_project_ref(
                    page,
                    gpn,
                )

                if ok:
                    if changed:
                        changed_items += 1
                        print(
                            f"   ✍️ Item {item_no} "
                            f"WBS={wbs} → Project Ref={gpn} "
                            f"| '{old_value}' → '{gpn}'"
                        )
                    else:
                        print(
                            f"   ✅ Item {item_no} "
                            f"WBS={wbs} → Project Ref={gpn} "
                            f"| 无需修改 (当前='{old_value}')"
                        )
                    item_logs.append(
                        f"Item {item_no}: {wbs}->{gpn}, "
                        f"old={old_value or '<空>'}, changed={changed}"
                    )
                else:
                    item_errors += 1
                    print(
                        f"   ❌ Item {item_no} "
                        f"Project Ref写入失败：{write_error}"
                    )
                    item_logs.append(
                        f"Item {item_no}: {wbs}->{gpn}, "
                        f"写入失败({write_error})"
                    )

        next_item = click_next_item_verified(page, item_no)

        if not next_item:
            print(
                f"   🏁 Item {item_no} 后没有可验证的下一Item，"
                "当前PR遍历结束"
            )
            break

        print(
            f"   ➡️ 前端Item已确认切换："
            f"{item_no} → {next_item.get('itemNo')}"
        )
        current = next_item

    save_ok = True
    save_message = ""

    if changed_items > 0:
        save_ok, save_message = save_purchase_requisition(page)
        if save_ok:
            print(
                f"💾 PR {pr_number} 保存完成 "
                f"| 已修改Item={changed_items}"
                + (f" | {save_message}" if save_message else "")
            )
        else:
            print(f"❌ PR {pr_number} 保存失败：{save_message}")
    else:
        print(f"ℹ️ PR {pr_number} 没有产生修改，不执行保存")

    print(
        f"📊 PR {pr_number} Item汇总 "
        f"| 实际前端遍历={processed_items} "
        f"| 白名单匹配={matched_items} "
        f"| 白名单外跳过={filtered_items} "
        f"| 修改={changed_items} "
        f"| 错误={item_errors}"
    )

    if not save_ok:
        status = "SAVE_ERROR"
    elif item_errors:
        status = "PARTIAL"
    elif changed_items > 0:
        status = "SUCCESS"
    elif matched_items > 0:
        # 找到目标WBS，但Project Ref本来已经正确。
        status = "ALREADY_OK"
    else:
        # 没有任何Item命中允许的WBS，不能再伪装成SUCCESS。
        status = "NO_MATCH"

    return {
        "status": status,
        "pr": pr_number,
        "excel_row": excel_row,
        "changed_items": changed_items,
        "matched_items": matched_items,
        "unmapped_items": 0,
        "filtered_items": filtered_items,
        "item_errors": item_errors,
        "save_message": save_message,
        "detail": " || ".join(item_logs),
    }




# ============================================================
# 8. Excel读取、PR分组、Checkpoint与运行日志
# ============================================================

CHECKPOINT_HEADERS = [
    "Purchase Requisition",
    "Rule Version",
    "Status",
    "Last Start",
    "Last Finish",
    "Worker",
    "Master Excel Row",
    "Source Excel Rows",
    "Matched Items",
    "Changed Items",
    "Filtered Items",
    "Item Errors",
    "Save Message",
    "Detail",
]


def compress_excel_rows(rows: List[int]) -> str:
    """把[2,3,4,7,9,10]压缩成2-4,7,9-10。"""
    values = sorted({int(row) for row in rows if int(row) > 0})
    if not values:
        return ""

    output: List[str] = []
    start = values[0]
    end = values[0]

    for value in values[1:]:
        if value == end + 1:
            end = value
            continue

        output.append(str(start) if start == end else f"{start}-{end}")
        start = value
        end = value

    output.append(str(start) if start == end else f"{start}-{end}")
    return ",".join(output)


def excel_safe_text(value: Any, limit: int = 30000) -> str:
    text = normalize_text(value)
    if len(text) <= limit:
        return text
    return text[: limit - 20] + " ...<truncated>"


def save_workbook_with_retry(workbook, path: Path, purpose: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    last_error: Optional[Exception] = None

    for attempt in range(1, CHECKPOINT_SAVE_RETRIES + 1):
        try:
            workbook.save(path)
            return
        except Exception as exc:
            last_error = exc
            if attempt < CHECKPOINT_SAVE_RETRIES:
                safe_print(
                    f"⚠️ {purpose}保存失败，"
                    f"{CHECKPOINT_SAVE_RETRY_SEC:.1f}秒后重试 "
                    f"({attempt}/{CHECKPOINT_SAVE_RETRIES})：{exc}"
                )
                time.sleep(CHECKPOINT_SAVE_RETRY_SEC)

    raise RuntimeError(
        f"{purpose}连续{CHECKPOINT_SAVE_RETRIES}次保存失败：{last_error}"
    )


class CheckpointStore:
    """固定Checkpoint文件；主键为PR + Rule Version。"""

    def __init__(self) -> None:
        self.enabled = ENABLE_CHECKPOINT
        self.path = Path(CHECKPOINT_PATH)
        self.workbook = None
        self.worksheet = None
        self.columns: Dict[str, int] = {}
        self.row_index: Dict[Tuple[str, str], int] = {}

        if not self.enabled:
            return

        if self.path.exists():
            self.workbook = openpyxl.load_workbook(self.path)
        else:
            self.workbook = openpyxl.Workbook()
            self.workbook.active.title = CHECKPOINT_SHEET_NAME

        if CHECKPOINT_SHEET_NAME in self.workbook.sheetnames:
            self.worksheet = self.workbook[CHECKPOINT_SHEET_NAME]
        else:
            self.worksheet = self.workbook.create_sheet(CHECKPOINT_SHEET_NAME)

        self._ensure_headers()
        self._rebuild_index()
        save_workbook_with_retry(self.workbook, self.path, "Checkpoint")

    def _ensure_headers(self) -> None:
        assert self.worksheet is not None
        existing: Dict[str, int] = {}

        for column in range(1, self.worksheet.max_column + 1):
            header = normalize_text(self.worksheet.cell(1, column).value)
            if header:
                existing[header] = column

        next_column = max(existing.values(), default=0) + 1
        for header in CHECKPOINT_HEADERS:
            if header not in existing:
                self.worksheet.cell(1, next_column).value = header
                existing[header] = next_column
                next_column += 1

        self.columns = existing
        self.worksheet.freeze_panes = "A2"
        self.worksheet.auto_filter.ref = self.worksheet.dimensions

    def _rebuild_index(self) -> None:
        assert self.worksheet is not None
        self.row_index = {}
        pr_column = self.columns["Purchase Requisition"]
        rule_column = self.columns["Rule Version"]

        for row in range(2, self.worksheet.max_row + 1):
            pr_number = normalize_identifier(
                self.worksheet.cell(row, pr_column).value
            )
            rule_version = normalize_text(
                self.worksheet.cell(row, rule_column).value
            )
            if pr_number and rule_version:
                self.row_index[(pr_number, rule_version)] = row

    def get_record(self, pr_number: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None

        with CHECKPOINT_LOCK:
            key = (normalize_identifier(pr_number), RULE_VERSION)
            row = self.row_index.get(key)
            if row is None:
                return None

            assert self.worksheet is not None
            return {
                header: self.worksheet.cell(row, self.columns[header]).value
                for header in CHECKPOINT_HEADERS
            }

    def update(
        self,
        pr_number: str,
        status: str,
        source_rows: List[int],
        master_row: int,
        worker: str,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self.enabled:
            return

        result = result or {}
        pr_number = normalize_identifier(pr_number)
        status = normalize_text(status).upper()
        now = utc_now_text()

        with CHECKPOINT_LOCK:
            assert self.worksheet is not None
            assert self.workbook is not None

            key = (pr_number, RULE_VERSION)
            row = self.row_index.get(key)
            if row is None:
                row = self.worksheet.max_row + 1
                self.row_index[key] = row

            values: Dict[str, Any] = {
                "Purchase Requisition": pr_number,
                "Rule Version": RULE_VERSION,
                "Status": status,
                "Worker": worker,
                "Master Excel Row": master_row,
                "Source Excel Rows": compress_excel_rows(source_rows),
                "Matched Items": result.get("matched_items", 0),
                "Changed Items": result.get("changed_items", 0),
                "Filtered Items": result.get("filtered_items", 0),
                "Item Errors": result.get("item_errors", 0),
                "Save Message": excel_safe_text(result.get("save_message", ""), 2000),
                "Detail": excel_safe_text(result.get("detail", "")),
            }

            if status == "RUNNING":
                values["Last Start"] = now
                values["Last Finish"] = ""
            else:
                old_start = self.worksheet.cell(
                    row,
                    self.columns["Last Start"],
                ).value
                values["Last Start"] = old_start or now
                values["Last Finish"] = now

            for header, value in values.items():
                self.worksheet.cell(row, self.columns[header]).value = value

            self.worksheet.auto_filter.ref = self.worksheet.dimensions
            save_workbook_with_retry(self.workbook, self.path, "Checkpoint")


class SourceStatusWriter:
    """把PR级结果回写到源Excel中该PR的全部重复行。"""

    def __init__(self) -> None:
        self.enabled = WRITEBACK_TO_SOURCE_EXCEL
        self.path = Path(EXCEL_PATH)
        self.workbook = None
        self.worksheet = None
        self.mode = "disabled"
        self.read_path = self.path
        self.columns: Dict[str, int] = {}
        self.backup_path: Optional[Path] = None

        if not self.enabled:
            return

        if CREATE_SOURCE_BACKUP:
            self.backup_path = self.path.with_name(
                f"{self.path.stem}_RPA_Backup_"
                f"{datetime.datetime.now():%Y%m%d_%H%M%S_%f}"
                f"{self.path.suffix}"
            )

        # Attach to the workbook when the user already has it open. openpyxl
        # cannot replace an Excel-locked file, while Excel COM can update it in
        # place without closing the user's window.
        pythoncom.CoInitialize()
        try:
            open_workbook = find_open_excel_workbook(self.path)
            if open_workbook is not None:
                self.mode = "excel-com"
                if self.backup_path is None:
                    self.backup_path = self.path.with_name(
                        f"{self.path.stem}_RPA_Snapshot_"
                        f"{datetime.datetime.now():%Y%m%d_%H%M%S_%f}"
                        f"{self.path.suffix}"
                    )
                # SaveCopyAs includes unsaved input without renaming or closing
                # the visible workbook. The snapshot is also the read source.
                open_workbook.SaveCopyAs(str(self.backup_path))
                self.read_path = self.backup_path
                worksheet = self._select_com_worksheet(open_workbook)
                self._ensure_headers_com(worksheet)
                open_workbook.Save()
                safe_print(
                    "📗 已连接用户打开的Excel；运行期间保持工作簿开启并直接写回结果"
                )
                return
        finally:
            pythoncom.CoUninitialize()

        self.mode = "openpyxl"
        if self.backup_path is not None:
            shutil.copy2(self.path, self.backup_path)

        self.workbook = openpyxl.load_workbook(self.path)
        self.worksheet = (
            self.workbook[SOURCE_SHEET_NAME]
            if SOURCE_SHEET_NAME
            else self.workbook.active
        )
        self._ensure_headers()
        save_workbook_with_retry(self.workbook, self.path, "源Excel")

    def _select_com_worksheet(self, workbook: Any) -> Any:
        if SOURCE_SHEET_NAME:
            return workbook.Worksheets(SOURCE_SHEET_NAME)
        return workbook.Worksheets(1)

    def _ensure_headers_com(self, worksheet: Any) -> None:
        existing: Dict[str, int] = {}
        try:
            # xlToLeft = -4159. Avoid scanning Excel's full column set.
            max_column = int(
                worksheet.Cells(1, worksheet.Columns.Count).End(-4159).Column
            )
        except Exception:
            max_column = max(1, int(worksheet.UsedRange.Columns.Count))

        for column in range(1, max_column + 1):
            header = normalize_text(worksheet.Cells(1, column).Value)
            if header:
                existing[header] = column

        headers = [
            SOURCE_STATUS_HEADER,
            SOURCE_LAST_RUN_HEADER,
            SOURCE_NOTE_HEADER,
            SOURCE_RULE_HEADER,
            SOURCE_MASTER_ROW_HEADER,
        ]
        next_column = max(existing.values(), default=0) + 1
        for header in headers:
            if header not in existing:
                worksheet.Cells(1, next_column).Value = header
                existing[header] = next_column
                next_column += 1
        self.columns = existing

    def _with_open_excel(self, action, label: str) -> None:
        """Run one short Excel action in the calling worker's COM apartment."""
        last_error: Optional[Exception] = None
        pythoncom.CoInitialize()
        try:
            for attempt in range(1, CHECKPOINT_SAVE_RETRIES + 1):
                try:
                    workbook = find_open_excel_workbook(self.path)
                    if workbook is None:
                        raise RuntimeError(
                            "源Excel在运行期间被关闭；请重新打开原工作簿后重试"
                        )
                    worksheet = self._select_com_worksheet(workbook)
                    action(workbook, worksheet)
                    return
                except Exception as exc:
                    last_error = exc
                    if attempt < CHECKPOINT_SAVE_RETRIES:
                        time.sleep(CHECKPOINT_SAVE_RETRY_SEC)
            raise RuntimeError(f"{label}失败：{last_error}") from last_error
        finally:
            pythoncom.CoUninitialize()

    def _ensure_headers(self) -> None:
        assert self.worksheet is not None
        existing: Dict[str, int] = {}

        for column in range(1, self.worksheet.max_column + 1):
            header = normalize_text(self.worksheet.cell(1, column).value)
            if header:
                existing[header] = column

        headers = [
            SOURCE_STATUS_HEADER,
            SOURCE_LAST_RUN_HEADER,
            SOURCE_NOTE_HEADER,
            SOURCE_RULE_HEADER,
            SOURCE_MASTER_ROW_HEADER,
        ]

        next_column = max(existing.values(), default=0) + 1
        for header in headers:
            if header not in existing:
                self.worksheet.cell(1, next_column).value = header
                existing[header] = next_column
                next_column += 1

        self.columns = existing

    def update_rows(
        self,
        rows: List[int],
        pr_number: str,
        status: str,
        master_row: int,
        note: str,
        save_now: bool = True,
    ) -> None:
        if not self.enabled:
            return

        with SOURCE_EXCEL_LOCK:
            if self.mode == "excel-com":
                now = utc_now_text()

                def write_rows(workbook: Any, worksheet: Any) -> None:
                    for row in sorted(set(rows)):
                        worksheet.Cells(row, self.columns[SOURCE_STATUS_HEADER]).Value = status
                        worksheet.Cells(row, self.columns[SOURCE_LAST_RUN_HEADER]).Value = now
                        worksheet.Cells(row, self.columns[SOURCE_NOTE_HEADER]).Value = excel_safe_text(note, 3000)
                        worksheet.Cells(row, self.columns[SOURCE_RULE_HEADER]).Value = RULE_VERSION
                        worksheet.Cells(row, self.columns[SOURCE_MASTER_ROW_HEADER]).Value = master_row
                    if save_now:
                        workbook.Save()

                self._with_open_excel(write_rows, "源Excel写回")
                return

            assert self.worksheet is not None
            assert self.workbook is not None
            now = utc_now_text()

            for row in sorted(set(rows)):
                self.worksheet.cell(row, self.columns[SOURCE_STATUS_HEADER]).value = status
                self.worksheet.cell(row, self.columns[SOURCE_LAST_RUN_HEADER]).value = now
                self.worksheet.cell(row, self.columns[SOURCE_NOTE_HEADER]).value = excel_safe_text(note, 3000)
                self.worksheet.cell(row, self.columns[SOURCE_RULE_HEADER]).value = RULE_VERSION
                self.worksheet.cell(row, self.columns[SOURCE_MASTER_ROW_HEADER]).value = master_row

            if save_now:
                save_workbook_with_retry(self.workbook, self.path, "源Excel")

    def save(self) -> None:
        if not self.enabled:
            return
        with SOURCE_EXCEL_LOCK:
            if self.mode == "excel-com":
                self._with_open_excel(
                    lambda workbook, _worksheet: workbook.Save(),
                    "源Excel保存",
                )
                return
            assert self.workbook is not None
            save_workbook_with_retry(self.workbook, self.path, "源Excel")


def result_note(result: Dict[str, Any]) -> str:
    return (
        f"Status={result.get('status', '')}; "
        f"Matched={result.get('matched_items', 0)}; "
        f"Changed={result.get('changed_items', 0)}; "
        f"Filtered={result.get('filtered_items', 0)}; "
        f"Errors={result.get('item_errors', 0)}; "
        f"Save={result.get('save_message', '')}; "
        f"Detail={result.get('detail', '')}"
    )


def get_batch_row_range(ws_max_row: int) -> Tuple[int, int]:
    start_row = (
        BATCH_START_ROW
        if BATCH_START_ROW > 0
        else DATA_START_ROW + (BATCH_NUMBER - 1) * BATCH_SIZE
    )

    if BATCH_SIZE == 0:
        return start_row, ws_max_row

    return start_row, min(start_row + BATCH_SIZE - 1, ws_max_row)


def load_pr_tasks(
    checkpoint_store: CheckpointStore,
    source_writer: Optional[SourceStatusWriter] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, int], List[Dict[str, Any]]]:
    """
    1. 当前批次按唯一PR建立任务；
    2. 默认只扫描当前批次，避免为了找全Sheet重复行而遍历巨大UsedRange；
    3. 跨批次、跨运行的重复PR由Checkpoint跳过；
    4. FULL_SHEET模式仍可扫描整个Sheet，但使用iter_rows顺序读取并输出进度。
    """
    source_path = (
        source_writer.read_path
        if source_writer is not None and source_writer.enabled
        else Path(EXCEL_PATH)
    )
    if not source_path.exists():
        raise FileNotFoundError(f"Excel不存在：{source_path}")

    owned_workbook = None

    # SourceStatusWriter已经打开了源Excel时直接复用，避免同一个大文件再次加载。
    if (
        source_writer is not None
        and source_writer.enabled
        and source_writer.mode == "openpyxl"
        and source_writer.worksheet is not None
    ):
        ws = source_writer.worksheet
        safe_print("📖 复用已打开的源Excel工作表读取PR，避免重复加载文件")
    else:
        owned_workbook = openpyxl.load_workbook(
            source_path,
            data_only=True,
            read_only=True,
        )
        ws = (
            owned_workbook[SOURCE_SHEET_NAME]
            if SOURCE_SHEET_NAME
            else owned_workbook.active
        )

    start_row, end_row = get_batch_row_range(ws.max_row)

    stats = {
        "sheet_max_row": ws.max_row,
        "batch_start_row": start_row,
        "batch_end_row": end_row,
        "scanned_rows": 0,
        "mapping_scanned_rows": 0,
        "blank_rows": 0,
        "invalid_rows": 0,
        "duplicate_rows": 0,
        "candidate_unique_prs": 0,
        "checkpoint_skipped_prs": 0,
        "task_count": 0,
        "unique_tasks": 0,
    }

    all_pr_rows: Dict[str, List[int]] = {}
    candidate_prs: List[str] = []
    seen_in_batch = set()

    if PR_ROW_MAPPING_SCOPE == "FULL_SHEET":
        scan_start = DATA_START_ROW
        scan_end = ws.max_row
    else:
        scan_start = start_row
        scan_end = end_row

    if scan_start <= scan_end and scan_start <= ws.max_row:
        safe_print(
            f"🔎 正在扫描PR列：模式={PR_ROW_MAPPING_SCOPE} | "
            f"Excel行={scan_start}~{scan_end} | Sheet max_row={ws.max_row}"
        )

        rows_iter = ws.iter_rows(
            min_row=scan_start,
            max_row=scan_end,
            min_col=PR_COLUMN,
            max_col=PR_COLUMN,
            values_only=True,
        )

        for offset, values in enumerate(rows_iter):
            row = scan_start + offset
            stats["mapping_scanned_rows"] += 1
            raw_value = values[0] if values else None
            pr_number = normalize_identifier(raw_value)

            is_valid_pr = bool(re.fullmatch(r"\d+", pr_number or ""))
            if is_valid_pr:
                all_pr_rows.setdefault(pr_number, []).append(row)

            # FULL_SHEET模式只把当前批次范围内的PR加入任务；
            # CURRENT_BATCH模式下扫描范围本身就是当前批次。
            if not (start_row <= row <= end_row):
                if stats["mapping_scanned_rows"] % SCAN_PROGRESS_EVERY_ROWS == 0:
                    safe_print(
                        f"   …已扫描 {stats['mapping_scanned_rows']} 行 "
                        f"(当前Excel行 {row})"
                    )
                continue

            stats["scanned_rows"] += 1

            if not pr_number:
                stats["blank_rows"] += 1
                continue

            if not is_valid_pr:
                stats["invalid_rows"] += 1
                safe_print(
                    f"⚠️ Excel行{row} 第{PR_COLUMN}列值 "
                    f"'{pr_number}' 不是纯数字PR，已跳过"
                )
                continue

            if pr_number in seen_in_batch:
                stats["duplicate_rows"] += 1
                continue

            seen_in_batch.add(pr_number)
            candidate_prs.append(pr_number)

            if stats["mapping_scanned_rows"] % SCAN_PROGRESS_EVERY_ROWS == 0:
                safe_print(
                    f"   …已扫描 {stats['mapping_scanned_rows']} 行 "
                    f"(当前Excel行 {row})"
                )

    if owned_workbook is not None:
        owned_workbook.close()

    stats["candidate_unique_prs"] = len(candidate_prs)

    tasks: List[Dict[str, Any]] = []
    skipped_records: List[Dict[str, Any]] = []

    for pr_number in candidate_prs:
        source_rows = all_pr_rows.get(pr_number, [])
        master_row = source_rows[0] if source_rows else 0
        checkpoint = checkpoint_store.get_record(pr_number)
        previous_status = normalize_text(
            checkpoint.get("Status") if checkpoint else ""
        ).upper()

        task = {
            "pr": pr_number,
            "master_row": master_row,
            "source_rows": source_rows,
            "previous_status": previous_status,
        }

        if previous_status in SKIP_CHECKPOINT_STATUSES:
            stats["checkpoint_skipped_prs"] += 1
            skipped_records.append(task)
            safe_print(
                f"⏭️ PR {pr_number} Checkpoint={previous_status} "
                f"| Rule={RULE_VERSION} | Excel行={compress_excel_rows(source_rows)}"
            )
            continue

        tasks.append(task)

    stats["task_count"] = len(tasks)
    stats["unique_tasks"] = len(tasks)
    return tasks, stats, skipped_records

def create_log_writer(batch_stats: Dict[str, int]) -> Tuple[Any, csv.DictWriter, Path]:
    source_path = Path(EXCEL_PATH)
    start_row = batch_stats.get("batch_start_row", DATA_START_ROW)
    end_row = batch_stats.get("batch_end_row", start_row)
    batch_label = "ALL" if BATCH_SIZE == 0 else f"{BATCH_NUMBER:03d}"

    log_path = source_path.with_name(
        f"ME52N_ProjectRef_Batch{batch_label}_"
        f"Rows{start_row}-{end_row}_"
        f"{datetime.datetime.now():%Y%m%d_%H%M%S}.csv"
    )
    log_file = open(log_path, "w", newline="", encoding="utf-8-sig")

    fieldnames = [
        "Timestamp",
        "Worker",
        "Batch Number",
        "Batch Excel Row Start",
        "Batch Excel Row End",
        "Task Position",
        "Master Excel Row",
        "Source Excel Rows",
        "Purchase Requisition",
        "Rule Version",
        "Status",
        "Previous Checkpoint Status",
        "Matched Items",
        "Changed Items",
        "Unmapped Items",
        "Filtered Items",
        "Item Errors",
        "Save Message",
        "Detail",
    ]
    writer = csv.DictWriter(log_file, fieldnames=fieldnames)
    writer.writeheader()
    log_file.flush()
    return log_file, writer, log_path


def append_log(
    log_file,
    writer: csv.DictWriter,
    result: Dict[str, Any],
    worker_id: int,
    task_position: int,
    batch_stats: Dict[str, int],
) -> None:
    with LOG_LOCK:
        writer.writerow(
            {
                "Timestamp": utc_now_text(),
                "Worker": "CHECKPOINT" if worker_id == 0 else f"W{worker_id}",
                "Batch Number": "ALL" if BATCH_SIZE == 0 else BATCH_NUMBER,
                "Batch Excel Row Start": batch_stats.get("batch_start_row", ""),
                "Batch Excel Row End": batch_stats.get("batch_end_row", ""),
                "Task Position": task_position,
                "Master Excel Row": result.get("master_row", result.get("excel_row", "")),
                "Source Excel Rows": compress_excel_rows(result.get("source_rows", [])),
                "Purchase Requisition": result.get("pr", ""),
                "Rule Version": RULE_VERSION,
                "Status": result.get("status", ""),
                "Previous Checkpoint Status": result.get("previous_status", ""),
                "Matched Items": result.get("matched_items", 0),
                "Changed Items": result.get("changed_items", 0),
                "Unmapped Items": result.get("unmapped_items", 0),
                "Filtered Items": result.get("filtered_items", 0),
                "Item Errors": result.get("item_errors", 0),
                "Save Message": result.get("save_message", ""),
                "Detail": result.get("detail", ""),
            }
        )
        log_file.flush()


# ============================================================
# 9. 主程序
# ============================================================

def start_worker_sap_session(page: Page, worker_id: int) -> bool:
    for login_attempt in range(1, WORKER_LOGIN_RETRIES + 1):
        safe_print(
            f"[W{worker_id}] 🌐 正在进入ME52N "
            f"(登录尝试 {login_attempt}/{WORKER_LOGIN_RETRIES})..."
        )

        try:
            goto(page, "ME52N")
            if wait_for_me52n(page, timeout_sec=LOGIN_TIMEOUT_SEC):
                safe_print(f"[W{worker_id}] ✅ SAP登录完成，开始领取任务")
                return True
        except Exception as exc:
            safe_print(f"[W{worker_id}] ⚠️ SAP登录异常: {exc}")

        if login_attempt < WORKER_LOGIN_RETRIES:
            safe_print(f"[W{worker_id}] 🔄 等待3秒后重新进入ME52N")
            time.sleep(3)

    safe_print(
        f"[W{worker_id}] ❌ 无法建立SAP会话，"
        "该Worker退出；任务将由其他Worker继续领取"
    )
    return False


def worker_loop(
    worker_id: int,
    task_queue: "queue.Queue[Tuple[int, Dict[str, Any]]]",
    log_file,
    log_writer: csv.DictWriter,
    batch_stats: Dict[str, int],
    summary: Dict[str, int],
    progress: Dict[str, int],
    checkpoint_store: CheckpointStore,
    source_writer: SourceStatusWriter,
) -> None:
    try:
        with sync_playwright() as playwright:
            launch_options: Dict[str, Any] = {"headless": HEADLESS}
            if BROWSER_CHANNEL in {"chrome", "msedge"}:
                launch_options["channel"] = BROWSER_CHANNEL

            try:
                browser = playwright.chromium.launch(**launch_options)
            except Exception as exc:
                if "channel" not in launch_options:
                    raise
                safe_print(
                    f"[W{worker_id}] ⚠️ 无法启动 {BROWSER_CHANNEL}，"
                    f"回退到 Playwright Chromium：{exc}"
                )
                browser = playwright.chromium.launch(headless=HEADLESS)
            context = browser.new_context()
            page = context.new_page()
            page.on("dialog", lambda dialog: dialog.accept())

            if not start_worker_sap_session(page, worker_id):
                browser.close()
                return

            consecutive_errors = 0

            while not STOP_EVENT.is_set():
                try:
                    task_position, task = task_queue.get_nowait()
                except queue.Empty:
                    break

                pr_number = task["pr"]
                master_row = int(task.get("master_row") or 0)
                source_rows = list(task.get("source_rows") or [])
                previous_status = normalize_text(task.get("previous_status")).upper()

                try:
                    safe_print(
                        "\n"
                        f"[W{worker_id}] [{task_position}/{batch_stats.get('task_count', 0)}] "
                        f"▶ PR {pr_number} | Master行={master_row} "
                        f"| Excel行={compress_excel_rows(source_rows)}"
                    )

                    try:
                        checkpoint_store.update(
                            pr_number,
                            "RUNNING",
                            source_rows,
                            master_row,
                            f"W{worker_id}",
                            {"detail": "SAP任务已开始，尚未产生最终结果"},
                        )
                    except Exception as exc:
                        result = {
                            "status": "ERROR",
                            "pr": pr_number,
                            "excel_row": master_row,
                            "master_row": master_row,
                            "source_rows": source_rows,
                            "previous_status": previous_status,
                            "changed_items": 0,
                            "matched_items": 0,
                            "unmapped_items": 0,
                            "filtered_items": 0,
                            "item_errors": 1,
                            "save_message": "",
                            "detail": f"Checkpoint无法写入RUNNING，未启动SAP: {exc}",
                        }
                        safe_print(
                            f"[W{worker_id}] ❌ PR {pr_number} "
                            f"Checkpoint写入失败，未执行SAP：{exc}"
                        )
                    else:
                        try:
                            source_writer.update_rows(
                                source_rows,
                                pr_number,
                                "RUNNING",
                                master_row,
                                f"PR {pr_number} 正在由W{worker_id}处理",
                            )
                        except Exception as exc:
                            safe_print(
                                f"[W{worker_id}] ⚠️ 源Excel RUNNING回写失败，"
                                f"Checkpoint仍有效：{exc}"
                            )

                        result = None
                        for task_attempt in range(1, TASK_ERROR_RETRIES + 2):
                            try:
                                result = process_purchase_requisition(
                                    page,
                                    master_row,
                                    pr_number,
                                )
                            except Exception as exc:
                                result = {
                                    "status": "ERROR",
                                    "pr": pr_number,
                                    "excel_row": master_row,
                                    "changed_items": 0,
                                    "matched_items": 0,
                                    "unmapped_items": 0,
                                    "filtered_items": 0,
                                    "item_errors": 1,
                                    "save_message": "",
                                    "detail": f"执行异常: {exc}",
                                }
                                safe_print(
                                    f"[W{worker_id}] ❌ PR {pr_number} "
                                    f"发生意外异常：{exc}"
                                )

                            if result.get("status") != "ERROR":
                                break

                            if task_attempt <= TASK_ERROR_RETRIES:
                                safe_print(
                                    f"[W{worker_id}] 🔁 PR {pr_number} "
                                    f"第{task_attempt}次失败，恢复ME52N后重试"
                                )
                                if not recover_me52n_page(
                                    page,
                                    reason=f"W{worker_id}重试PR {pr_number}",
                                ):
                                    break

                        result.update(
                            {
                                "master_row": master_row,
                                "source_rows": source_rows,
                                "previous_status": previous_status,
                            }
                        )

                    status = normalize_text(result.get("status", "ERROR")).upper()

                    try:
                        checkpoint_store.update(
                            pr_number,
                            status,
                            source_rows,
                            master_row,
                            f"W{worker_id}",
                            result,
                        )
                    except Exception as exc:
                        safe_print(
                            f"[W{worker_id}] ❌ PR {pr_number} SAP已完成，"
                            f"但最终Checkpoint保存失败：{exc}"
                        )
                        result["detail"] = (
                            excel_safe_text(result.get("detail", ""), 20000)
                            + f" || 最终Checkpoint保存失败: {exc}"
                        )

                    try:
                        source_writer.update_rows(
                            source_rows,
                            pr_number,
                            status,
                            master_row,
                            result_note(result),
                        )
                    except Exception as exc:
                        safe_print(
                            f"[W{worker_id}] ⚠️ PR {pr_number} 源Excel回写失败，"
                            f"请以Checkpoint为准：{exc}"
                        )

                    if status == "ERROR":
                        consecutive_errors += 1
                    else:
                        consecutive_errors = 0

                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                        safe_print(
                            f"[W{worker_id}] 🧯 连续{consecutive_errors}条ERROR，"
                            "强制重建当前ME52N页面"
                        )
                        recover_me52n_page(
                            page,
                            reason=f"W{worker_id}连续失败保护",
                        )
                        consecutive_errors = 0

                    with SUMMARY_LOCK:
                        summary[status] = summary.get(status, 0) + 1
                        progress["completed"] += 1
                        completed = progress["completed"]
                        total = batch_stats.get("task_count", 0)

                    append_log(
                        log_file,
                        log_writer,
                        result,
                        worker_id,
                        task_position,
                        batch_stats,
                    )
                    safe_print(
                        f"[W{worker_id}] 📈 批次进度 {completed}/{total} "
                        f"| PR {pr_number} | 状态={status}"
                    )

                finally:
                    task_queue.task_done()

            try:
                context.close()
            except Exception:
                pass
            try:
                browser.close()
            except Exception:
                pass

            safe_print(f"[W{worker_id}] 🏁 当前Worker任务完成")

    except Exception as exc:
        safe_print(f"[W{worker_id}] 💥 Worker级异常：{exc}")


def main() -> None:
    print("=" * 76)
    print("ME52N Project Ref RPA - PR Grouped + Persistent Checkpoint")
    print("=" * 76)
    print(f"Excel: {EXCEL_PATH}")
    print(f"Sheet: {SOURCE_SHEET_NAME or '<第一个Sheet>'}")

    try:
        from openpyxl.utils import get_column_letter
        pr_col_letter = get_column_letter(PR_COLUMN)
    except Exception:
        pr_col_letter = str(PR_COLUMN)

    print(f"PR列: {pr_col_letter} / 第{PR_COLUMN}列")
    print("允许处理的WBS: " + ", ".join(sorted(ALLOWED_WBS)))
    print(f"目标Project Ref: {TARGET_PROJECT_REF}")
    print(f"Rule Version: {RULE_VERSION}")
    print(f"覆盖已有Project Ref: {OVERWRITE_EXISTING_PROJECT_REF}")
    print(
        f"批次设置: BATCH_NUMBER={BATCH_NUMBER}, "
        f"BATCH_SIZE={BATCH_SIZE or '全部'}, "
        f"BATCH_START_ROW={BATCH_START_ROW or '自动'}"
    )
    print("PR级分组: 固定开启；同一个PR只进入SAP一次")
    print(f"Checkpoint: {ENABLE_CHECKPOINT} | {CHECKPOINT_PATH}")
    print("Checkpoint跳过状态: " + ", ".join(sorted(SKIP_CHECKPOINT_STATUSES)))
    print(f"源Excel结果回写: {WRITEBACK_TO_SOURCE_EXCEL}")
    print(f"并发浏览器配置: NUM_WORKERS={NUM_WORKERS}")
    print(f"强制单浏览器写入: {FORCE_SINGLE_WORKER_FOR_WRITE}")
    print(f"浏览器通道: {BROWSER_CHANNEL}")
    print(f"Item切换等待: {ITEM_SWITCH_PAUSE_SEC}s")
    print(f"PR行映射扫描范围: {PR_ROW_MAPPING_SCOPE}")

    checkpoint_store = CheckpointStore()
    source_writer = SourceStatusWriter()

    if source_writer.backup_path:
        print(f"源Excel备份: {source_writer.backup_path}")

    tasks, batch_stats, skipped_records = load_pr_tasks(
        checkpoint_store,
        source_writer,
    )
    start_row = batch_stats.get("batch_start_row", DATA_START_ROW)
    end_row = batch_stats.get("batch_end_row", start_row)

    print("\n📦 当前批次:")
    print(f"   Excel行范围: {start_row} ~ {end_row}")
    print(f"   当前批次扫描行数: {batch_stats.get('scanned_rows', 0)}")
    print(f"   PR映射实际扫描行数: {batch_stats.get('mapping_scanned_rows', 0)}")
    print(f"   空PR行: {batch_stats.get('blank_rows', 0)}")
    print(f"   非法PR行: {batch_stats.get('invalid_rows', 0)}")
    print(f"   批次内重复PR行: {batch_stats.get('duplicate_rows', 0)}")
    print(f"   当前批次唯一PR: {batch_stats.get('candidate_unique_prs', 0)}")
    print(f"   Checkpoint跳过: {len(skipped_records)}")
    print(f"   最终SAP任务数: {len(tasks)}")

    for skipped in skipped_records:
        previous_status = skipped.get("previous_status", "")
        try:
            source_writer.update_rows(
                skipped.get("source_rows", []),
                skipped["pr"],
                previous_status,
                skipped.get("master_row", 0),
                f"Checkpoint命中，未重复进入SAP；原状态={previous_status}",
                save_now=False,
            )
        except Exception as exc:
            safe_print(f"⚠️ PR {skipped['pr']} 跳过状态回写失败：{exc}")

    if skipped_records and WRITEBACK_TO_SOURCE_EXCEL:
        try:
            source_writer.save()
        except Exception as exc:
            safe_print(f"⚠️ 跳过状态批量保存源Excel失败：{exc}")

    if not tasks:
        print("\n当前批次没有需要进入SAP处理的PR，程序结束。")
        print(format_me52n_event({
            "status": "NO_TASKS",
            "planned": 0,
            "completed": 0,
            "skipped": len(skipped_records),
            "logPath": "",
            "checkpointPath": CHECKPOINT_PATH,
            "backupPath": source_writer.backup_path or "",
            "startRow": start_row,
            "endRow": end_row,
            "counts": {},
        }))
        return

    actual_workers = calculate_worker_count(
        len(tasks), NUM_WORKERS, FORCE_SINGLE_WORKER_FOR_WRITE
    )
    if FORCE_SINGLE_WORKER_FOR_WRITE:
        print(
            "🔒 写操作安全模式：本次强制使用1个浏览器，"
            "避免多个SAP会话并发维护PR"
        )

    log_file, log_writer, log_path = create_log_writer(batch_stats)

    for skipped in skipped_records:
        append_log(
            log_file,
            log_writer,
            {
                "status": f"SKIPPED_{skipped.get('previous_status', '')}",
                "pr": skipped["pr"],
                "master_row": skipped.get("master_row", 0),
                "source_rows": skipped.get("source_rows", []),
                "previous_status": skipped.get("previous_status", ""),
                "detail": "Checkpoint命中，未重复进入SAP",
            },
            0,
            0,
            batch_stats,
        )

    print(f"\n📝 本次运行日志: {log_path}")
    print(f"📌 固定Checkpoint: {CHECKPOINT_PATH}")
    print(f"🌐 即将打开 {actual_workers} 个独立浏览器。")

    task_queue: queue.Queue = queue.Queue()
    for task_position, task in enumerate(tasks, start=1):
        task_queue.put((task_position, task))

    summary = {
        "SUCCESS": 0,
        "ALREADY_OK": 0,
        "NO_MATCH": 0,
        "PARTIAL": 0,
        "ERROR": 0,
        "SAVE_ERROR": 0,
    }
    progress = {"completed": 0}
    threads: List[threading.Thread] = []

    try:
        for worker_id in range(1, actual_workers + 1):
            thread = threading.Thread(
                target=worker_loop,
                args=(
                    worker_id,
                    task_queue,
                    log_file,
                    log_writer,
                    batch_stats,
                    summary,
                    progress,
                    checkpoint_store,
                    source_writer,
                ),
                name=f"ME52N-Worker-{worker_id}",
                daemon=False,
            )
            thread.start()
            threads.append(thread)

            if worker_id < actual_workers and WORKER_START_DELAY_SEC > 0:
                time.sleep(WORKER_START_DELAY_SEC)

        for thread in threads:
            thread.join()

    except KeyboardInterrupt:
        safe_print(
            "\n⛔ 收到停止指令：停止领取新PR；"
            "当前PR会继续到保存和最终Checkpoint后再停止。"
        )
        STOP_EVENT.set()

        if GRACEFUL_STOP_AFTER_CURRENT_PR:
            try:
                for thread in threads:
                    while thread.is_alive():
                        thread.join(timeout=1)
            except KeyboardInterrupt:
                safe_print(
                    "\n⚠️ 收到第二次停止指令。"
                    "Checkpoint中仍为RUNNING的PR会在下次自动重跑。"
                )
        else:
            for thread in threads:
                thread.join(timeout=10)

    finally:
        with LOG_LOCK:
            log_file.close()

    remaining = task_queue.qsize()

    print("\n" + "=" * 76)
    print("当前批次执行完成")
    print("=" * 76)
    print(f"Excel行范围: {start_row} ~ {end_row}")
    print(f"当前批次唯一PR: {batch_stats.get('candidate_unique_prs', 0)}")
    print(f"Checkpoint跳过: {len(skipped_records)}")
    print(f"计划SAP任务: {len(tasks)}")
    print(f"已完成SAP任务: {progress.get('completed', 0)}")
    print(f"未领取/未完成: {remaining}")
    print(f"实际修改并保存成功: {summary.get('SUCCESS', 0)}")
    print(f"原值已经正确: {summary.get('ALREADY_OK', 0)}")
    print(f"没有匹配目标WBS: {summary.get('NO_MATCH', 0)}")
    print(f"部分完成: {summary.get('PARTIAL', 0)}")
    print(f"执行错误: {summary.get('ERROR', 0)}")
    print(f"保存错误: {summary.get('SAVE_ERROR', 0)}")
    print(f"详细日志: {log_path}")
    print(f"固定Checkpoint: {CHECKPOINT_PATH}")
    print(format_me52n_event({
        "status": "CANCELLED" if STOP_EVENT.is_set() else "COMPLETE",
        "planned": len(tasks),
        "completed": progress.get("completed", 0),
        "remaining": remaining,
        "skipped": len(skipped_records),
        "workers": actual_workers,
        "logPath": log_path,
        "checkpointPath": CHECKPOINT_PATH,
        "backupPath": source_writer.backup_path or "",
        "startRow": start_row,
        "endRow": end_row,
        "counts": summary,
    }))


def calculate_worker_count(task_count: int, requested_workers: int, force_single: bool) -> int:
    """Return the real number of isolated browser workers for this batch."""
    if task_count <= 0:
        return 0
    if force_single:
        return 1
    return min(max(1, requested_workers), task_count)

    if BATCH_SIZE > 0:
        print("\n下一批推荐配置：")
        print(f"   BATCH_START_ROW={end_row + 1}")
        print(f"   BATCH_SIZE={BATCH_SIZE}")
        print("   # 跨批次重复PR会由Checkpoint自动跳过。")


if __name__ == "__main__":
    main()
