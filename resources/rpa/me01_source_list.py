from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import winreg
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any

import openpyxl
import win32com.client


PLANT = "C100"
SOURCE_LIST_USAGE = "1"
SHEET_NAME = "ME01_Input"
EVENT_PREFIX = "ME01_EVENT "
MATERIAL_HEADERS = {"material no.", "material no", "material", "part number"}
PARMA_HEADERS = {"parma", "parma no.", "parma no", "supplier", "supplier code", "intended supplier"}
RESULT_HEADERS = {"status": "ME01 Status", "error": "Error Message", "updated": "Updated At"}


def emit(event: str, **payload: Any) -> None:
    print(EVENT_PREFIX + json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def clean(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def normalize_identifier(value: Any) -> str:
    text = clean(value)
    if text.isdigit():
        return text.lstrip("0") or "0"
    return text.upper()


def same_path(first: Any, second: Path) -> bool:
    try:
        return os.path.normcase(os.path.abspath(clean(first))) == os.path.normcase(str(second))
    except Exception:
        return False


def find_open_excel_workbook(path: Path) -> Any | None:
    try:
        excel = win32com.client.GetActiveObject("Excel.Application")
    except Exception:
        return None
    try:
        for index in range(1, excel.Workbooks.Count + 1):
            workbook = excel.Workbooks(index)
            if same_path(workbook.FullName, path):
                return workbook
    except Exception:
        return None
    return None


class WorkbookResults:
    def __init__(self, path: Path, backup_path: Path) -> None:
        self.path = path
        self.open_excel_workbook = find_open_excel_workbook(path)
        self.workbook: Any
        self.sheet: Any
        self.result_columns: dict[str, int] = {}
        self.assignments: OrderedDict[str, dict[str, Any]] = OrderedDict()
        if self.open_excel_workbook is not None:
            self.mode = "excel-com"
            self.workbook = self.open_excel_workbook
            self.workbook.SaveCopyAs(str(backup_path))
            self.sheet = self._excel_sheet()
            self._read_excel_com()
            emit("preparing", message="The workbook is open in Excel. Results will be written through Excel without closing it.")
        else:
            self.mode = "openpyxl"
            shutil.copy2(path, backup_path)
            self.workbook = openpyxl.load_workbook(path)
            self.sheet = self.workbook[SHEET_NAME] if SHEET_NAME in self.workbook.sheetnames else self.workbook[self.workbook.sheetnames[0]]
            self._read_openpyxl()
        if not self.assignments:
            raise RuntimeError("No Material No. and Parma values were found in the uploaded workbook.")

    def _excel_sheet(self) -> Any:
        try:
            return self.workbook.Worksheets(SHEET_NAME)
        except Exception:
            return self.workbook.Worksheets(1)

    def _add_assignment(self, material: str, parma: str, row: int) -> None:
        if not material and not parma:
            return
        if not material or not parma:
            raise RuntimeError(f"Excel row {row} must contain both Material No. and Parma.")
        material_key = normalize_identifier(material)
        parma_key = normalize_identifier(parma)
        existing = self.assignments.get(material_key)
        if existing and normalize_identifier(existing["parma"]) != parma_key:
            raise RuntimeError(f"Material {material} has more than one Parma. Keep only the supplier that should be fixed.")
        if existing:
            existing["rows"].append(row)
        else:
            self.assignments[material_key] = {"material": material, "parma": parma, "rows": [row]}

    def _read_excel_com(self) -> None:
        max_column = max(1, int(self.sheet.UsedRange.Columns.Count))
        max_row = max(1, int(self.sheet.UsedRange.Rows.Count))
        material_column = 0
        parma_column = 0
        for column in range(1, max_column + 1):
            title = clean(self.sheet.Cells(1, column).Value).lower()
            if title in MATERIAL_HEADERS:
                material_column = column
            if title in PARMA_HEADERS:
                parma_column = column
            for key, result_title in RESULT_HEADERS.items():
                if title == result_title.lower():
                    self.result_columns[key] = column
        if not material_column or not parma_column:
            raise RuntimeError('Missing required column(s) "Material No." or "Parma". Download a fresh ME01 template.')
        for key, title in RESULT_HEADERS.items():
            if key not in self.result_columns:
                max_column += 1
                self.sheet.Cells(1, max_column).Value = title
                self.result_columns[key] = max_column
        for row in range(2, max_row + 1):
            self._add_assignment(clean(self.sheet.Cells(row, material_column).Value), clean(self.sheet.Cells(row, parma_column).Value), row)

    def _read_openpyxl(self) -> None:
        material_column = 0
        parma_column = 0
        for column in range(1, self.sheet.max_column + 1):
            title = clean(self.sheet.cell(1, column).value).lower()
            if title in MATERIAL_HEADERS:
                material_column = column
            if title in PARMA_HEADERS:
                parma_column = column
            for key, result_title in RESULT_HEADERS.items():
                if title == result_title.lower():
                    self.result_columns[key] = column
        if not material_column or not parma_column:
            raise RuntimeError('Missing required column(s) "Material No." or "Parma". Download a fresh ME01 template.')
        for key, title in RESULT_HEADERS.items():
            if key not in self.result_columns:
                column = self.sheet.max_column + 1
                self.sheet.cell(1, column, title)
                self.result_columns[key] = column
        for row in range(2, self.sheet.max_row + 1):
            self._add_assignment(clean(self.sheet.cell(row, material_column).value), clean(self.sheet.cell(row, parma_column).value), row)

    def existing_statuses(self, rows: list[int]) -> set[str]:
        column = self.result_columns["status"]
        if self.mode == "excel-com":
            return {clean(self.sheet.Cells(row, column).Value).upper() for row in rows}
        return {clean(self.sheet.cell(row, column).value).upper() for row in rows}

    def write(self, rows: list[int], status: str, message: str) -> None:
        timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
        for row in rows:
            values = {"status": status, "error": message, "updated": timestamp}
            for key, value in values.items():
                column = self.result_columns[key]
                if self.mode == "excel-com":
                    self.sheet.Cells(row, column).Value = value
                else:
                    self.sheet.cell(row, column, value)

    def save(self) -> None:
        if self.mode == "excel-com":
            self.workbook.Save()
        else:
            self.workbook.save(self.path)


def wait_ready(session: Any, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if not session.Busy:
                return
        except Exception:
            pass
        time.sleep(0.15)
    raise RuntimeError("SAP GUI did not become ready within 30 seconds.")


def status_error(session: Any) -> str:
    try:
        bar = session.findById("wnd[0]/sbar")
        if str(bar.MessageType).upper() in {"E", "A"}:
            return clean(bar.Text) or "SAP returned an error message."
    except Exception:
        return ""
    return ""


def try_active_session() -> Any | None:
    try:
        application = win32com.client.GetObject("SAPGUI").GetScriptingEngine
    except Exception:
        return None
    try:
        for connection_index in range(application.Children.Count):
            connection = application.Children(connection_index)
            for session_index in range(connection.Children.Count):
                session = connection.Children(session_index)
                session.findById("wnd[0]")
                return session
    except Exception:
        return None
    return None


def sap_logon_candidates() -> list[Path]:
    candidates: list[Path] = []
    configured = os.environ.get("SAPLOGON_EXE", "").strip()
    if configured:
        candidates.append(Path(configured))
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for registry_path in (
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\saplogon.exe",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\saplogon.exe",
        ):
            try:
                with winreg.OpenKey(hive, registry_path) as key:
                    candidates.append(Path(clean(winreg.QueryValue(key, None))))
            except OSError:
                pass
    for root in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if root:
            candidates.append(Path(root) / "SAP" / "FrontEnd" / "SAPgui" / "saplogon.exe")
    return candidates


def launch_sap_logon() -> None:
    executable = next((path for path in sap_logon_candidates() if path.is_file()), None)
    if executable is None:
        raise RuntimeError("No SAP GUI session is open and saplogon.exe could not be found. Open SAP Logon manually, then retry.")
    subprocess.Popen([str(executable)], close_fds=True)


def find_active_session() -> Any:
    session = try_active_session()
    if session is not None:
        return session
    launch_sap_logon()
    emit("waiting-for-sap", message="SAP Logon was opened. Select the correct system and complete sign-in; waiting up to 3 minutes.")
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        session = try_active_session()
        if session is not None:
            return session
        time.sleep(1)
    raise RuntimeError("SAP Logon was opened, but no signed-in SAP GUI session became available within 3 minutes.")


def open_me01(session: Any) -> None:
    session.findById("wnd[0]").maximize()
    command = session.findById("wnd[0]/tbar[0]/okcd")
    command.Text = "/nME01"
    session.findById("wnd[0]").sendVKey(0)
    wait_ready(session)
    error = status_error(session)
    if error:
        raise RuntimeError(f"ME01 could not be opened: {error}")


def supplier_at(session: Any, table_id: str, visible_row: int) -> str:
    table = session.findById(table_id)
    try:
        return clean(table.GetCell(visible_row, 2).Text)
    except Exception:
        pass
    for control_type in ("ctxt", "txt"):
        try:
            return clean(session.findById(f"{table_id}/{control_type}EORD-LIFNR[2,{visible_row}]").Text)
        except Exception:
            pass
    return ""


def scroll_table(session: Any, table_id: str, position: int) -> Any:
    table = session.findById(table_id)
    table.VerticalScrollbar.Position = position
    wait_ready(session)
    return session.findById(table_id)


def locate_supplier_row(session: Any, table_id: str, target_parma: str) -> tuple[int, list[str]]:
    table = session.findById(table_id)
    total_rows = int(table.RowCount)
    visible_rows = max(1, int(table.VisibleRowCount))
    found_suppliers: list[str] = []
    for start in range(0, total_rows, visible_rows):
        scroll_table(session, table_id, start)
        page_rows = min(visible_rows, total_rows - start)
        for visible_row in range(page_rows):
            supplier = supplier_at(session, table_id, visible_row)
            if not supplier:
                continue
            if supplier not in found_suppliers:
                found_suppliers.append(supplier)
            if normalize_identifier(supplier) == normalize_identifier(target_parma):
                return start + visible_row, found_suppliers
    return -1, found_suppliers


def apply_target_supplier(session: Any, table_id: str, target_absolute_row: int) -> None:
    table = session.findById(table_id)
    total_rows = int(table.RowCount)
    visible_rows = max(1, int(table.VisibleRowCount))
    for start in range(0, total_rows, visible_rows):
        table = scroll_table(session, table_id, start)
        page_rows = min(visible_rows, total_rows - start)
        for visible_row in range(page_rows):
            supplier = supplier_at(session, table_id, visible_row)
            if not supplier:
                continue
            absolute_row = start + visible_row
            if absolute_row == target_absolute_row:
                session.findById(f"{table_id}/chkRM06W-FESKZ[8,{visible_row}]").Selected = True
                table.GetAbsoluteRow(absolute_row).Selected = True
                session.findById(f"{table_id}/ctxtEORD-AUTET[10,{visible_row}]").Text = SOURCE_LIST_USAGE


def maintain_material(session: Any, material: str, parma: str) -> None:
    material_field = session.findById("wnd[0]/usr/ctxtEORD-MATNR")
    plant_field = session.findById("wnd[0]/usr/ctxtEORD-WERKS")
    material_field.Text = material
    plant_field.Text = PLANT
    plant_field.SetFocus()
    plant_field.caretPosition = len(PLANT)
    session.findById("wnd[0]").sendVKey(0)
    wait_ready(session)
    error = status_error(session)
    if error:
        raise RuntimeError(error)

    table_id = "wnd[0]/usr/tblSAPLMEORTC_0205"
    table = session.findById(table_id)
    if int(table.RowCount) < 1:
        raise RuntimeError("No source-list row was available for this material and Plant C100.")
    target_row, suppliers = locate_supplier_row(session, table_id, parma)
    if target_row < 0:
        supplier_list = ", ".join(suppliers) if suppliers else "none"
        raise RuntimeError(f"Parma {parma} was not found in the Source List. Suppliers shown: {supplier_list}.")
    apply_target_supplier(session, table_id, target_row)
    session.findById("wnd[0]/tbar[0]/btn[11]").Press()
    wait_ready(session)
    error = status_error(session)
    if error:
        raise RuntimeError(error)


def main() -> int:
    excel_path = Path(os.environ.get("EXCEL_PATH", "")).expanduser().resolve()
    if not excel_path.is_file():
        raise RuntimeError("The selected ME01 workbook was not found.")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = excel_path.with_name(f"{excel_path.stem}_backup_{timestamp}{excel_path.suffix}")
    results = WorkbookResults(excel_path, backup_path)
    emit("preparing", message=f"Backup created: {backup_path}", backupPath=str(backup_path))

    total = len(results.assignments)
    emit("connecting", message="Connecting to SAP GUI. SAP Logon will open automatically if needed.", total=total)
    session = find_active_session()
    open_me01(session)

    succeeded = 0
    failed = 0
    skipped = 0
    for current, assignment in enumerate(results.assignments.values(), start=1):
        material = assignment["material"]
        parma = assignment["parma"]
        excel_rows = assignment["rows"]
        if results.existing_statuses(excel_rows) == {"SUCCESS"}:
            skipped += 1
            emit("record", message=f"{material} / Parma {parma}: already SUCCESS; skipped.", material=material,
                 parma=parma, current=current, total=total, status="skipped")
            continue
        emit("record", message=f"Material {material}: locating Parma {parma} in Plant {PLANT}.",
             material=material, parma=parma, current=current, total=total, status="running")
        try:
            maintain_material(session, material, parma)
            succeeded += 1
            results.write(excel_rows, "SUCCESS", "")
            emit("record", message=f"{material} / Parma {parma}: matching Source List row fixed and saved.",
                 material=material, parma=parma, current=current, total=total, status="success")
        except Exception as error:
            failed += 1
            message = clean(error) or error.__class__.__name__
            results.write(excel_rows, "ERROR", message)
            emit("record", message=f"{material} / Parma {parma}: {message}", material=material,
                 parma=parma, current=current, total=total, status="failed")
            try:
                open_me01(session)
            except Exception:
                pass
        results.save()

    results.save()
    emit("complete", message="ME01 source-list batch finished.", processed=total, succeeded=succeeded,
         skipped=skipped, failed=failed, resultPath=str(excel_path), backupPath=str(backup_path))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit("fatal", message=clean(error) or error.__class__.__name__)
        raise SystemExit(1)
