"""Offline original-workbook writeback tests; all Excel/SAP COM is mocked."""
import contextlib
import copy
import io
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('rfq_fixture', Path(__file__).with_name('test-rfq-integration.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
engine = fixture.engine
from rfq_source_writeback import SourceWorkbookWriteback, comparable, attach_workbook


class Cell:
    def __init__(self, sheet, row, column):
        self.sheet, self.row, self.column = sheet, row, column

    @property
    def Value2(self):
        return self.sheet.data.get((self.row, self.column))

    @Value2.setter
    def Value2(self, value):
        self.sheet.writes += 1
        if self.sheet.fail_write_at == self.sheet.writes:
            raise RuntimeError('Mock Excel write interrupted')
        self.sheet.data[self.row, self.column] = value

    @property
    def HasFormula(self):
        return isinstance(self.Value2, str) and self.Value2.startswith('=') and self.NumberFormat != '@'

    @property
    def NumberFormat(self):
        return self.sheet.formats.get((self.row, self.column), 'General')

    @NumberFormat.setter
    def NumberFormat(self, value):
        self.sheet.formats[self.row, self.column] = value


class Sheet:
    def __init__(self, workbook, name):
        sheet = workbook[name]
        self.data = {(cell.row, cell.column): comparable(cell.value, workbook.epoch) for row in sheet for cell in row}
        self.formats = {(cell.row, cell.column): cell.number_format for row in sheet for cell in row}
        self.ProtectContents = False
        self.writes = 0
        self.fail_write_at = None

    @property
    def UsedRange(self):
        return SimpleNamespace(Column=1, Columns=SimpleNamespace(Count=max(column for _, column in self.data)))

    def Cells(self, row, column):
        return Cell(self, row, column)

    def Range(self, start, end):
        values = tuple(self.data.get((start.row, column)) for column in range(start.column, end.column + 1))
        return SimpleNamespace(Value2=(values,), Formula=(tuple(str(value) if isinstance(value, (int, float)) else value for value in values),))


class Book:
    def __init__(self, path, baseline):
        self.FullName = str(path)
        self.sheet = Sheet(baseline, 'RPA_Input')
        self.ReadOnly = self.Date1904 = False
        self.Saved = True
        self.save_error = False
        self.save_count = self.close_count = 0
        self.saved_data = copy.deepcopy(self.sheet.data)

    def Worksheets(self, name):
        if name != 'RPA_Input':
            raise ValueError('Unknown worksheet')
        return self.sheet

    def Save(self):
        self.save_count += 1
        if self.save_error:
            raise RuntimeError('Mock workbook is locked')
        self.saved_data = copy.deepcopy(self.sheet.data)
        self.Saved = True

    def Close(self, **kwargs):
        assert kwargs == {'SaveChanges': False}
        self.close_count += 1


class SourceWritebackTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.RfqTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.fixture.book(rows=[['C100', '775773', '111', '26517', 'buyer@example.com', '2030-12-31'],
                                ['C100', '775773', '222', '26517', 'buyer@example.com', '2030-12-31']])
        self.source = self.fixture.path.with_name('original.xlsx')
        self.writer = SourceWorkbookWriteback(engine, self.source, self.fixture.path, 'RPA_Input')
        book = engine.openpyxl.load_workbook(self.fixture.path)
        try:
            self.book = Book(self.source, book)
        finally:
            book.close()
        self.app = SimpleNamespace(Ready=True, Visible=False, Workbooks=SimpleNamespace(Count=0, Open=MagicMock(return_value=self.book)), Quit=MagicMock())
        self.book.Application = self.app
        self.enterContext(patch('rfq_source_writeback.attach_workbook', return_value=(self.app, self.book)))
        self.input_before = copy.deepcopy(self.book.sheet.data)

    def record(self, rows=(2,), number='0000123456'):
        self.writer.pending.update({row: {'RFQ Number': number, 'RFQ Status': 'SUCCESS', 'Last Run Time': '2030-01-01 10:00:00'} for row in rows})

    def column(self, header):
        return next(column for (row, column), value in self.book.sheet.data.items() if row == 1 and value == header)

    def test_open_original_is_updated_for_each_group_and_not_closed(self):
        self.record()
        self.assertEqual(self.writer.flush()['status'], 'synced')
        self.assertEqual(self.book.saved_data[2, self.column('RFQ Number')], '0000123456')
        self.record((3,), '0000999999')
        summary = self.writer.close()
        self.assertEqual(summary['writtenRows'], 2)
        self.assertEqual(self.book.save_count, 2)
        self.assertEqual(self.book.close_count, 0)
        self.app.Quit.assert_not_called()
        for cell, value in self.input_before.items():
            self.assertEqual(self.book.sheet.data[cell], value)

    def test_closed_original_uses_private_macro_disabled_excel_then_closes_only_ours(self):
        self.record((2, 3))
        with patch('rfq_source_writeback.attach_workbook', return_value=(None, None)), \
                patch('win32com.client.DispatchEx', return_value=self.app) as launch:
            self.assertEqual(self.writer.flush()['status'], 'synced')
            self.writer.close()
        launch.assert_called_once_with('Excel.Application')
        self.assertEqual(self.app.AutomationSecurity, 3)
        self.assertFalse(self.app.EnableEvents)
        self.app.Workbooks.Open.assert_called_once_with(Filename=str(self.source.resolve()), UpdateLinks=0,
            ReadOnly=False, Notify=False, AddToMru=False, IgnoreReadOnlyRecommended=True)
        self.assertEqual(self.book.close_count, 1)
        self.app.Quit.assert_called_once()

    def test_no_pending_results_does_not_open_or_save_excel(self):
        with patch('rfq_source_writeback.attach_workbook') as attach:
            self.assertEqual(self.writer.close()['status'], 'unchanged')
        attach.assert_not_called()
        self.assertEqual(self.book.save_count, 0)

    def test_private_excel_becomes_visible_or_unsaved_is_never_discarded(self):
        for visible, saved in ((True, True), (False, False)):
            with self.subTest(visible=visible, saved=saved):
                self.writer.app, self.writer.book, self.writer.owned = self.app, self.book, True
                self.app.Visible, self.book.Saved = visible, saved
                self.writer.close()
                self.assertEqual(self.book.close_count, 0)
                self.assertTrue(self.app.Visible)
                self.app.Quit.assert_not_called()

    def test_readonly_protected_or_editing_excel_leaves_pending_without_writes(self):
        for owner, field in ((self.book, 'ReadOnly'), (self.book.sheet, 'ProtectContents'), (self.app, 'Ready')):
            with self.subTest(field=field), patch.object(owner, field, field != 'Ready'):
                self.record()
                summary = self.writer.flush()
                self.assertEqual(summary['status'], 'pending')
                self.assertEqual(self.book.sheet.writes, 0)
                self.assertIn('do not rerun SAP', summary['message'])
        self.assertEqual(self.writer.flush()['status'], 'synced')

    def test_all_input_columns_are_checked_before_any_output_is_written(self):
        for column in range(1, len(self.writer.baseline_headers) + 1):
            with self.subTest(column=column):
                self.book.sheet.data = copy.deepcopy(self.input_before)
                self.book.sheet.data[3, column] = 'USER_CHANGED'
                self.record((2, 3))
                self.assertEqual(self.writer.flush()['status'], 'pending')
                self.assertEqual(self.book.sheet.writes, 0)
                self.assertEqual(self.book.save_count, 0)

    def test_sorted_rows_are_not_written_by_stale_excel_row_number(self):
        self.book.sheet.data[2, 3], self.book.sheet.data[3, 3] = '222', '111'
        self.record((2, 3))
        self.assertEqual(self.writer.flush()['status'], 'pending')
        self.assertEqual(self.book.sheet.writes, 0)

    def test_new_rfQ_number_cannot_be_overwritten(self):
        column = len(self.writer.baseline_headers) + 1
        self.book.sheet.data[1, column] = 'RFQ Number'
        self.book.sheet.data[2, column] = 'ANOTHER_RFQ'
        self.record()
        self.assertEqual(self.writer.flush()['status'], 'pending')
        self.assertEqual(self.book.sheet.data[2, column], 'ANOTHER_RFQ')
        self.assertEqual(self.book.sheet.writes, 0)

    def test_existing_compatible_result_headers_are_reused_not_duplicated(self):
        for index, header in enumerate(reversed(engine.STATUS_HEADERS), len(self.writer.baseline_headers) + 1):
            self.book.sheet.data[1, index] = header
        self.record((2, 3))
        self.assertEqual(self.writer.flush()['status'], 'synced')
        self.assertEqual(sum(value == 'RFQ Number' for (row, _), value in self.book.sheet.data.items() if row == 1), 1)

    def test_partial_com_failure_can_retry_only_result_writes_without_duplicate_columns(self):
        self.record((2, 3))
        self.book.sheet.fail_write_at = len(engine.STATUS_HEADERS) + 2
        self.assertEqual(self.writer.flush()['status'], 'pending')
        self.book.sheet.fail_write_at = None
        self.assertEqual(self.writer.flush()['status'], 'synced')
        self.assertEqual(self.writer.summary()['writtenRows'], 2)
        self.assertEqual(self.book.save_count, 1)

    def test_save_failure_preserves_pending_and_does_not_claim_synced(self):
        self.record()
        self.book.save_error = True
        self.assertEqual(self.writer.flush()['status'], 'pending')
        self.assertEqual(self.writer.summary()['writtenRows'], 0)
        self.book.save_error = False
        self.assertEqual(self.writer.flush()['status'], 'synced')

    def test_result_does_not_disappear_when_following_status_update_has_no_number(self):
        self.record()
        self.writer.flush()
        self.writer.pending[2] = {'RFQ Status': 'SUCCESS', 'Error Message': ''}
        self.assertEqual(self.writer.flush()['status'], 'synced')
        self.assertEqual(self.book.saved_data[2, self.column('RFQ Number')], '0000123456')

    def test_user_changes_previously_written_result_is_a_conflict(self):
        self.record()
        self.writer.flush()
        self.book.sheet.data[2, self.column('RFQ Number')] = 'USER_RFQ'
        self.record()
        self.assertEqual(self.writer.flush()['status'], 'pending')
        self.assertEqual(self.book.sheet.data[2, self.column('RFQ Number')], 'USER_RFQ')

    def test_different_workbook_or_date_system_is_not_modified(self):
        for field, value in (('FullName', str(self.source.with_name('different.xlsx'))), ('Date1904', True)):
            with self.subTest(field=field), patch.object(self.book, field, value):
                self.record()
                self.assertEqual(self.writer.flush()['status'], 'pending')
                self.assertEqual(self.book.sheet.writes, 0)

    def test_output_formulas_are_not_replaced(self):
        column = len(self.writer.baseline_headers) + 1
        self.book.sheet.data[1, column] = 'RFQ Status'
        self.book.sheet.data[2, column] = '=A2'
        self.record()
        self.assertEqual(self.writer.flush()['status'], 'pending')
        self.assertEqual(self.book.sheet.writes, 0)

    def test_unknown_rows_and_duplicate_headers_are_rejected(self):
        self.record((500,))
        self.assertEqual(self.writer.flush()['status'], 'pending')
        self.assertEqual(self.book.sheet.writes, 0)
        self.writer.pending.clear()
        self.record()
        self.book.sheet.data[1, len(self.writer.baseline_headers) + 1] = 'Material'
        self.assertEqual(self.writer.flush()['status'], 'pending')
        self.assertEqual(self.book.sheet.writes, 0)

    def test_result_copy_failure_never_flushes_source(self):
        # The adapter saves its durable result copy first. Source failure may
        # not suppress this checkpoint or issue SAP operations a second time.
        import rfq_runtime
        source = Path(rfq_runtime.__file__).read_text(encoding='utf-8')
        save = source[source.index('        def save(self):'):source.index('        replace(engine.ExcelStore, "save", save)')]
        self.assertLess(save.index('result = old_save(self)'), save.index('source_writer.flush()'))
        self.assertNotIn('process_group(', save)

    def test_existing_excel_instances_are_found_without_opening_another(self):
        app = SimpleNamespace(Workbooks=SimpleNamespace(Count=1, Item=lambda index: self.book))
        with patch('win32com.client.GetActiveObject', return_value=app), \
                patch('win32com.client.DispatchEx') as create:
            self.assertEqual(attach_workbook(self.source), (app, self.book))
        create.assert_not_called()

    def test_another_excel_process_is_found_via_exact_document_moniker(self):
        moniker = SimpleNamespace(GetDisplayName=lambda context, unused: '!' + str(self.source))
        unrelated = SimpleNamespace(GetDisplayName=lambda context, unused: str(self.source.with_name('unrelated.xlsx')))
        table = SimpleNamespace(EnumRunning=lambda: [unrelated, moniker], GetObject=MagicMock(return_value='EXACT_DOCUMENT'))
        with patch('win32com.client.GetActiveObject', side_effect=RuntimeError('not the active Excel process')), \
                patch('pythoncom.GetRunningObjectTable', return_value=table), \
                patch('pythoncom.CreateBindCtx', return_value='CONTEXT'), \
                patch('win32com.client.Dispatch', return_value=self.book) as dispatch, \
                patch('win32com.client.DispatchEx') as create:
            self.assertEqual(attach_workbook(self.source), (self.app, self.book))
        table.GetObject.assert_called_once_with(moniker)
        dispatch.assert_called_once_with('EXACT_DOCUMENT')
        create.assert_not_called()

    def test_literal_error_text_is_not_misread_as_a_formula_on_a_later_update(self):
        self.writer.pending[2] = {'Error Message': '=literal SAP text'}
        self.assertEqual(self.writer.flush()['status'], 'synced')
        self.writer.pending[2] = {'Error Message': ''}
        self.assertEqual(self.writer.flush()['status'], 'synced')

    def test_hub_updates_original_after_durable_copy_and_restores_hooks(self):
        for row in (2, 3):
            self.book.sheet.data[row, 2] = 'P1'
            self.book.sheet.data[row, 5] = 'a@example.com'
        self.fixture.args.source_excel_path = str(self.source)
        self.fixture.args.source_baseline_path = str(self.fixture.path)
        old_save = engine.ExcelStore.save
        with contextlib.redirect_stdout(io.StringIO()):
            code, events = self.fixture.mock_run()
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]['sourceWriteback']['status'], 'synced')
        self.assertEqual(events[-1]['sourceWriteback']['writtenRows'], 2)
        self.assertEqual(self.book.saved_data[2, self.column('RFQ Number')], '1000123456')
        self.assertEqual(self.book.saved_data[3, self.column('RFQ Number')], '1000123456')
        self.assertIs(engine.ExcelStore.save, old_save)
        self.assertEqual(self.book.close_count, 0)

    def test_hub_readonly_original_does_not_hide_sap_numbers_or_retry_sap(self):
        for row in (2, 3):
            self.book.sheet.data[row, 2] = 'P1'
            self.book.sheet.data[row, 5] = 'a@example.com'
        self.fixture.args.source_excel_path = str(self.source)
        self.fixture.args.source_baseline_path = str(self.fixture.path)
        self.book.ReadOnly = True
        with contextlib.redirect_stdout(io.StringIO()):
            code, events = self.fixture.mock_run()
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]['rfqNumbers'], ['1000123456'])
        self.assertEqual(events[-1]['sourceWriteback']['status'], 'pending')
        self.assertEqual(sum(event['type'] == 'GROUP_STARTED' for event in events), 1)
        with_copy = engine.openpyxl.load_workbook(self.fixture.path)
        try:
            headers = {cell.value: cell.column for cell in with_copy.active[1]}
            self.assertEqual(with_copy.active.cell(2, headers['RFQ Number']).value, '1000123456')
        finally:
            with_copy.close()

    def test_cancelled_run_also_flushes_the_confirmed_original_results(self):
        for row in (2, 3):
            self.book.sheet.data[row, 2] = 'P1'
            self.book.sheet.data[row, 5] = 'a@example.com'
        self.fixture.args.source_excel_path = str(self.source)
        self.fixture.args.source_baseline_path = str(self.fixture.path)
        with contextlib.redirect_stdout(io.StringIO()):
            code, events = self.fixture.mock_run(stop=True)
        self.assertEqual(code, 3)
        self.assertEqual(events[-1]['type'], 'RUN_CANCELLED')
        self.assertEqual(events[-1]['sourceWriteback']['status'], 'synced')
        self.assertEqual(self.book.saved_data[2, self.column('RFQ Number')], '1000123456')


if __name__ == '__main__':
    unittest.main(argv=[__file__], verbosity=2)
