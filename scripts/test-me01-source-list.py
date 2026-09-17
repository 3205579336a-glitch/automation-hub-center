from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "resources" / "rpa" / "me01_source_list.py"
SPEC = importlib.util.spec_from_file_location("me01_source_list", SCRIPT)
assert SPEC and SPEC.loader
ME01 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ME01)


class FakeCell:
    def __init__(self, value=None):
        self.Value = value


class FakeCells:
    def __init__(self, values):
        self.values = values

    def __call__(self, row, column):
        return self.values.setdefault((row, column), FakeCell())


class FakeWorksheets:
    def __init__(self, sheet):
        self.sheet = sheet

    def __call__(self, _name_or_index):
        return self.sheet


class FakeWorkbook:
    def __init__(self):
        values = {
            (1, 1): FakeCell("Material No."),
            (1, 2): FakeCell("Parma"),
            (1, 3): FakeCell("ME01 Status"),
            (1, 4): FakeCell("Error Message"),
            (1, 5): FakeCell("Updated At"),
            (2, 1): FakeCell("16808656"),
            (2, 2): FakeCell("41889"),
        }
        sheet = SimpleNamespace(
            Cells=FakeCells(values),
            UsedRange=SimpleNamespace(Columns=SimpleNamespace(Count=5), Rows=SimpleNamespace(Count=2)),
        )
        self.Worksheets = FakeWorksheets(sheet)
        self.saved_copy = None
        self.save_count = 0

    def SaveCopyAs(self, path):
        self.saved_copy = path

    def Save(self):
        self.save_count += 1


class FakeTableCell:
    def __init__(self, text):
        self.Text = text


class FakeAbsoluteRow:
    def __init__(self):
        self.Selected = False


class FakeTable:
    def __init__(self):
        self.RowCount = 2
        self.VisibleRowCount = 8
        self.VerticalScrollbar = SimpleNamespace(Position=0)
        self.suppliers = ["101", "0000041889"]
        self.rows = [FakeAbsoluteRow(), FakeAbsoluteRow()]

    def GetCell(self, row, column):
        return FakeTableCell(self.suppliers[row] if column == 2 else "")

    def GetAbsoluteRow(self, row):
        return self.rows[row]


class FakeSession:
    Busy = False

    def __init__(self):
        self.table = FakeTable()
        self.checkboxes = [SimpleNamespace(Selected=True), SimpleNamespace(Selected=False)]
        self.usage = [SimpleNamespace(Text=""), SimpleNamespace(Text="")]

    def findById(self, identifier):
        if identifier == "wnd[0]/usr/tblSAPLMEORTC_0205":
            return self.table
        if "chkRM06W-FESKZ[8," in identifier:
            return self.checkboxes[int(identifier.rsplit(",", 1)[1].rstrip("]"))]
        if "ctxtEORD-AUTET[10," in identifier:
            return self.usage[int(identifier.rsplit(",", 1)[1].rstrip("]"))]
        raise KeyError(identifier)


class Me01Tests(unittest.TestCase):
    def test_open_excel_workbook_uses_com_and_stays_open(self):
        workbook = FakeWorkbook()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.xlsx"
            backup = Path(directory) / "backup.xlsx"
            with patch.object(ME01, "find_open_excel_workbook", return_value=workbook):
                results = ME01.WorkbookResults(source, backup)
            self.assertEqual(results.mode, "excel-com")
            self.assertEqual(results.assignments["16808656"]["parma"], "41889")
            results.write([2], "SUCCESS", "")
            results.save()
            self.assertEqual(workbook.Worksheets(1).Cells(2, 3).Value, "SUCCESS")
            self.assertEqual(workbook.save_count, 1)
            self.assertEqual(workbook.saved_copy, str(backup))

    def test_parma_selects_second_supplier_and_preserves_existing_fix(self):
        session = FakeSession()
        table_id = "wnd[0]/usr/tblSAPLMEORTC_0205"
        row, suppliers = ME01.locate_supplier_row(session, table_id, "41889")
        self.assertEqual(row, 1)
        self.assertEqual(suppliers, ["101", "0000041889"])
        ME01.apply_target_supplier(session, table_id, row)
        self.assertTrue(session.checkboxes[0].Selected)
        self.assertTrue(session.checkboxes[1].Selected)
        self.assertEqual(session.usage[1].Text, "1")
        self.assertTrue(session.table.rows[1].Selected)

    def test_sap_logon_is_launched_when_no_session_exists(self):
        expected_session = object()
        with patch.object(ME01, "try_active_session", side_effect=[None, expected_session]), \
             patch.object(ME01, "launch_sap_logon") as launch:
            actual_session = ME01.find_active_session()
        launch.assert_called_once_with()
        self.assertIs(actual_session, expected_session)


if __name__ == "__main__":
    unittest.main()
