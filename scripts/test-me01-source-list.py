from __future__ import annotations

import importlib.util
import re
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
        self.calls = 0

    def __call__(self, row, column):
        self.calls += 1
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
            (1, 6): FakeCell("Dual Sourcing"),
            (2, 6): FakeCell("Yes"),
        }
        sheet = SimpleNamespace(
            Cells=FakeCells(values),
            UsedRange=SimpleNamespace(Columns=SimpleNamespace(Count=6), Rows=SimpleNamespace(Count=2)),
        )
        self.Worksheets = FakeWorksheets(sheet)
        self.saved_copy = None
        self.save_count = 0

    def SaveCopyAs(self, path):
        self.saved_copy = path

    def Save(self):
        self.save_count += 1




class Me01Tests(unittest.TestCase):
    def bulk_workbook(self, rows=201):
        workbook = FakeWorkbook()
        sheet = workbook.Worksheets(1)
        sheet.UsedRange.Rows.Count = rows
        sheet.range_calls = []
        def read(address):
            sheet.range_calls.append(address)
            match = re.fullmatch(r'A(\d+):([A-Z]+)(\d+)', address)
            first, letters, last = match.groups()
            columns = 0
            for letter in letters:
                columns = columns*26 + ord(letter)-64
            values = tuple(tuple(sheet.Cells.values.get((r,c), FakeCell()).Value
                                 for c in range(1,columns+1)) for r in range(int(first),int(last)+1))
            return SimpleNamespace(Value2=values[0][0] if int(first)==int(last) and columns==1 else values)
        sheet.Range = read
        return workbook

    def test_open_excel_bulk_read_avoids_per_cell_round_trips_for_blank_template(self):
        workbook = self.bulk_workbook()
        with tempfile.TemporaryDirectory() as directory, patch.object(ME01, 'find_open_excel_workbook', return_value=workbook):
            results = ME01.WorkbookResults(Path(directory)/'source.xlsx', Path(directory)/'backup.xlsx')
        sheet = workbook.Worksheets(1)
        self.assertEqual(sheet.range_calls, ['A1:F1','A1:F1','A2:F201'])
        self.assertEqual(sheet.Cells.calls, 0)
        self.assertEqual(results.assignments['16808656']['rows'], [2])
        self.assertTrue(results.assignments['16808656']['dualSourcing'])

    def test_bulk_read_chunks_keep_original_row_numbers_and_detect_conflicts(self):
        workbook = self.bulk_workbook(5000)
        sheet = workbook.Worksheets(1)
        sheet.Cells.values.update({(4999,1):FakeCell('20503551'),(4999,2):FakeCell('6587'),(4999,6):FakeCell('No')})
        with tempfile.TemporaryDirectory() as directory, patch.object(ME01, 'find_open_excel_workbook', return_value=workbook):
            results = ME01.WorkbookResults(Path(directory)/'source.xlsx', Path(directory)/'backup.xlsx')
            self.assertEqual(results.assignments['20503551']['rows'], [4999])
            self.assertFalse(results.assignments['20503551']['dualSourcing'])
            self.assertEqual(sheet.range_calls[-2:], ['A2:F4097','A4098:F5000'])
            self.assertEqual(sheet.Cells.calls, 0)
            sheet.Cells.values.update({(5000,1):FakeCell('20503551'),(5000,2):FakeCell('6587'),(5000,6):FakeCell('Yes')})
            with self.assertRaisesRegex(RuntimeError, 'conflicting'):
                ME01.WorkbookResults(Path(directory)/'source.xlsx', Path(directory)/'backup.xlsx')

    def test_bulk_range_checks_rectangle_shape_and_single_cell(self):
        sheet = self.bulk_workbook().Worksheets(1)
        self.assertEqual(ME01.com_range_values(sheet,1,1,1),(('Material No.',),))
        self.assertEqual(ME01.excel_column(27),'AA')
        sheet.Range = lambda _address: SimpleNamespace(Value2=((1,),))
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            ME01.com_range_values(sheet,2,3,2)
        sheet.Range = lambda _address: (_ for _ in ()).throw(RuntimeError('Excel disconnected'))
        with self.assertRaisesRegex(RuntimeError, 'disconnected'):
            ME01.com_range_values(sheet,2,3,2)

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






    def test_dual_sourcing_is_required_and_duplicate_modes_must_match(self):
        for value in [None, '', 'maybe']:
            with self.assertRaises(RuntimeError): ME01.parse_dual_sourcing(value, 2)
        self.assertFalse(ME01.parse_dual_sourcing(False, 2))
        self.assertTrue(ME01.parse_dual_sourcing('✓', 2))
        from collections import OrderedDict
        results = object.__new__(ME01.WorkbookResults)
        results.assignments = OrderedDict()
        results._add_assignment('16808656', '41889', 2, 'Yes')
        with self.assertRaisesRegex(RuntimeError, 'conflicting'):
            results._add_assignment('16808656', '41889', 3, 'No')



    def test_openpyxl_mode_reads_required_choice_and_rejects_old_template(self):
        import openpyxl
        with tempfile.TemporaryDirectory() as folder:
            source, backup = Path(folder) / 'input.xlsx', Path(folder) / 'backup.xlsx'
            w = openpyxl.Workbook()
            w.active.title = 'ME01_Input'
            w.active.append(['Material No.', 'Parma', 'Dual Sourcing', 'ME01 Status'])
            w.active.append(['16808656', '41889', 'No', 'SUCCESS'])
            w.save(source)
            with patch.object(ME01, 'find_open_excel_workbook', return_value=None):
                results = ME01.WorkbookResults(source, backup)
                self.assertFalse(results.assignments['16808656']['dualSourcing'])
                results.workbook.close()
                w.active.cell(2,3).value = ''
                w.save(source)
                with self.assertRaisesRegex(RuntimeError, 'required'):
                    ME01.WorkbookResults(source, backup)
            w.close()

    def test_download_template_preserves_table_annotations_and_required_validation(self):
        import openpyxl
        w = openpyxl.load_workbook(SCRIPT.parent.parent / 'templates' / 'ME01_Source_List_Template.xlsx')
        try:
            s = w['ME01_Input']
            self.assertEqual([c.value for c in s[1]], ['Material No.', 'Parma', 'Dual Sourcing', 'ME01 Status', 'Error Message', 'Updated At'])
            self.assertEqual(s.tables['Me01SourceListInput'].ref, 'A1:F201')
            self.assertIsNone(s['C1'].comment)
            self.assertTrue(all(s[c].comment is not None for c in ['A1','B1','D1','E1','F1']))
            v = list(s.data_validations.dataValidation)[0]
            self.assertEqual(str(v.sqref), 'C2:C1001')
            self.assertEqual(v.formula1, '"Yes,No"')
            self.assertTrue(v.showErrorMessage)
            self.assertFalse(v.allow_blank)
        finally:
            w.close()




    def test_sap_logon_is_launched_when_no_session_exists(self):
        expected_session = object()
        with patch.object(ME01, "try_active_session", side_effect=[None, expected_session]), \
             patch.object(ME01, "launch_sap_logon") as launch:
            actual_session = ME01.find_active_session()
        launch.assert_called_once_with()
        self.assertIs(actual_session, expected_session)


if __name__ == "__main__":
    unittest.main()
