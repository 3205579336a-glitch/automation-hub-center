"""Offline APQP engine tests. Never connect to SAP or Excel."""
import datetime as dt
import importlib.util
import queue
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

SPEC = importlib.util.spec_from_file_location('apqp_test_engine', Path(__file__).parents[1] / 'resources/rpa/apqp_plan_closure.py')
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)


class Children:
    def __init__(self, items): self.items = items
    @property
    def Count(self): return len(self.items)
    def __call__(self, index): return self.items[index]


def session(system='VCE', client='100', transaction='SESSION_MANAGER'):
    return SimpleNamespace(Info=SimpleNamespace(SystemName=system, Client=client, User='TEST', Transaction=transaction), Busy=False, FindById=Mock(side_effect=RuntimeError('Not found')))


def application(sessions):
    return SimpleNamespace(Children=Children([SimpleNamespace(Description='Test', Children=Children(sessions))]))


class Sheet:
    def __init__(self, date1904=False):
        self.values = {(2, 1): SimpleNamespace(Value2='00012345'), (2, 4): SimpleNamespace(Value2='0041889'), (2, 5): SimpleNamespace(Value2=None, Text='14.09.2026')}
        self.Parent = SimpleNamespace(Date1904=date1904)
    def Cells(self, row, col): return self.values[(row, col)]


class ApqpTests(unittest.TestCase):
    def setUp(self): M.STOP_EVENT.clear()

    def header_sheet(self, headers):
        ws = Sheet()
        for col in range(1, 6):
            ws.values[(1, col)] = SimpleNamespace(Value2=headers[col - 1] if col <= len(headers) else '')
        return ws

    def test_new_and_legacy_column_mapping(self):
        new = self.header_sheet(['Part No.', 'Vendor', 'APQP plan closure date'])
        old = self.header_sheet(['Part No.', 'Ver', 'Description', 'Vendor', 'APQP plan closure date'])
        self.assertEqual(M.validate_headers(new), (1, 2, 3))
        self.assertEqual(M.validate_headers(old), (1, 4, 5))

    def test_incorrect_and_duplicate_headers_fail_closed(self):
        for headers in [['Vendor', 'Part No.', 'APQP plan closure date'],
                        ['Part No.', 'Vendor', 'APQP plan closure date', 'Vendor'],
                        ['Part No.', 'Ver', 'Vendor', 'APQP plan closure date']]:
            with self.assertRaises(ValueError): M.validate_headers(self.header_sheet(headers))

    def test_new_template_bulk_read(self):
        calls = []
        ws = SimpleNamespace(Range=lambda address: calls.append(address) or SimpleNamespace(Value2=(('00012345', '0041889', None),)))
        with patch.object(M, 'excel_last_row', return_value=2):
            rows = list(M.iter_excel_input_rows(ws, (1, 2, 3)))
        self.assertEqual(calls, ['A2:C2'])
        self.assertEqual(rows, [(2, '00012345', '0041889', '')])

    def test_new_template_writes_only_c_and_preserves_identifiers(self):
        for old_epoch in [False, True]:
            ws = self.header_sheet(['Part No.', 'Vendor', 'APQP plan closure date'])
            ws.Parent.Date1904 = old_epoch
            ws.values[(2, 2)] = SimpleNamespace(Value2='0041889')
            ws.values[(2, 3)] = SimpleNamespace(Value2=None, Text='14.09.2026')
            result = M.Result(2, '00012345', '0041889', 'SUCCESS', '14.09.2026')
            M.apply_result(ws, result, (1, 2, 3))
            self.assertEqual(result.status, 'SUCCESS')
            self.assertEqual(ws.Cells(2, 3).Value2, M.excel_date_serial(dt.date(2026, 9, 14)) - (1462 if old_epoch else 0))
            self.assertEqual(ws.Cells(2, 3).NumberFormat, 'dd.mm.yyyy')
            self.assertEqual(ws.Cells(2, 2).Value2, '0041889')
            self.assertIsNone(ws.Cells(2, 5).Value2)

    def test_changed_headers_or_existing_date_prevent_new_template_write(self):
        for change_header in [False, True]:
            ws = self.header_sheet(['Part No.', 'Vendor', 'APQP plan closure date'])
            ws.values[(2, 2)] = SimpleNamespace(Value2='0041889')
            ws.values[(2, 3)] = SimpleNamespace(Value2=46000, Text='old date')
            if change_header: ws.Cells(1, 3).Value2 = 'Changed'
            result = M.Result(2, '00012345', '0041889', 'SUCCESS', '14.09.2026')
            with patch.object(M, 'OVERWRITE_EXISTING_DATE', False): M.apply_result(ws, result, (1, 2, 3))
            self.assertEqual(result.status, 'EXCEL_CONFLICT')
            self.assertEqual(ws.Cells(2, 3).Value2, 46000)

    def test_sheet_search_skips_wrong_headers(self):
        invalid = self.header_sheet(['Not APQP'])
        valid = self.header_sheet(['Part No.', 'Vendor', 'APQP plan closure date'])
        def sheets(key):
            if isinstance(key, str): raise ValueError('No preferred sheet')
            return [invalid, valid][key - 1]
        sheets.Count = 2
        self.assertIs(M.select_worksheet(SimpleNamespace(Worksheets=sheets), ''), valid)

    def test_bulk_snapshot_modes_and_identifiers(self):
        rows = [("00012345", None, None, "0041889", None),
                ("00099999", None, None, "0041889", 46000),
                ("00077777", None, None, None, None),
                (None, None, None, None, None)]
        calls = []
        ws = SimpleNamespace(Range=lambda address: calls.append(address) or SimpleNamespace(Value2=tuple(rows)))
        with patch.object(M, 'excel_last_row', return_value=5):
            snapshot = list(M.iter_excel_input_rows(ws))
        keep = M.select_excel_tasks(snapshot, False)
        refresh = M.select_excel_tasks(snapshot, True)
        self.assertEqual(calls, ['A2:E5'])
        self.assertEqual((len(keep[0]), keep[1], keep[2]), (1, 1, 1))
        self.assertEqual((len(refresh[0]), refresh[1], refresh[2]), (2, 0, 1))
        self.assertEqual((keep[0][0].material, keep[0][0].vendor), ('00012345', '0041889'))

    def test_bulk_chunks_bound_com_calls(self):
        calls = []
        def read(address):
            calls.append(address)
            start, end = (int(part[1:]) for part in address.split(':'))
            return SimpleNamespace(Value2=tuple((str(row), None, None, '0041889', None) for row in range(start, end + 1)))
        with patch.object(M, 'excel_last_row', return_value=5001):
            rows = list(M.iter_excel_input_rows(SimpleNamespace(Range=read)))
        self.assertEqual(len(rows), 5000)
        self.assertEqual(calls, ['A2:E2001', 'A2002:E4001', 'A4002:E5001'])

    def test_incomplete_bulk_range_fails_closed(self):
        ws = SimpleNamespace(Range=lambda _: SimpleNamespace(Value2=(("123", None),)))
        with patch.object(M, 'excel_last_row', return_value=2):
            with self.assertRaisesRegex(RuntimeError, 'unreadable APQP'):
                list(M.iter_excel_input_rows(ws))

    def test_task_limit_preserves_original_selection_order(self):
        rows = [(2, '001', '004', 'date'), (3, '002', '004', ''), (4, '', '004', ''), (5, '003', '004', '')]
        with patch.object(M, 'TEST_LIMIT', 1):
            tasks, skipped, invalid = M.select_excel_tasks(rows, False)
        self.assertEqual([t.excel_row for t in tasks], [3])
        self.assertEqual((skipped, invalid), (1, 0))

    def test_date_safe(self):
        for text in ['14.09.2026', '14. 09. 2026', '2026-09-14', '14/09/2026']:
            self.assertEqual(M.parse_sap_date(text), dt.date(2026, 9, 14))
        self.assertIsNone(M.parse_sap_date('invalid'))
        self.assertEqual(M.normalize_identifier('0041889'), '0041889')

    def test_excel_1900_and_1904(self):
        for old_epoch in [False, True]:
            ws = Sheet(old_epoch)
            result = M.Result(2, '00012345', '0041889', 'SUCCESS', '14.09.2026')
            M.apply_result(ws, result)
            self.assertEqual(ws.Cells(2, 5).Value2, M.excel_date_serial(dt.date(2026, 9, 14)) - (1462 if old_epoch else 0))
            self.assertEqual(ws.Cells(2, 5).NumberFormat, 'dd.mm.yyyy')

    def test_existing_date_preserved(self):
        ws = Sheet(); ws.Cells(2, 5).Value2 = 46000
        result = M.Result(2, '00012345', '0041889', 'SUCCESS', '14.09.2026')
        with patch.object(M, 'OVERWRITE_EXISTING_DATE', False): M.apply_result(ws, result)
        self.assertEqual(result.status, 'EXCEL_CONFLICT')
        self.assertEqual(ws.Cells(2, 5).Value2, 46000)

    def test_changed_identifiers_preserved(self):
        ws = Sheet(); ws.Cells(2, 1).Value2 = 'OTHER'
        result = M.Result(2, '00012345', '0041889', 'SUCCESS', '14.09.2026')
        M.apply_result(ws, result)
        self.assertEqual(result.status, 'EXCEL_CONFLICT')
        self.assertIsNone(ws.Cells(2, 5).Value2)

    def test_system_and_client_isolation(self):
        for sessions in [[session(), session('CEQ')], [session(), session(client='200')]]:
            with patch.object(M, 'get_sap_application', return_value=application(sessions)), patch.object(M, 'TARGET_SYSTEM', ''), patch.object(M, 'TARGET_CLIENT', ''):
                with self.assertRaisesRegex(RuntimeError, 'Multiple SAP'): M.discover_sap_sessions()

    def test_only_idle_target_sessions(self):
        sessions = [session(), session(), session(transaction='ME01')]
        with patch.object(M, 'get_sap_application', return_value=application(sessions)):
            self.assertEqual(len(M.discover_sap_sessions()), 2)

    def test_create_missing_sessions(self):
        sessions = [session()]
        sessions[0].CreateSession = lambda: sessions.append(session())
        with patch.object(M, 'get_sap_application', return_value=application(sessions)), patch.object(M, 'MAX_WORKERS', 3), patch.object(M, 'CREATE_SESSIONS', True), patch.object(M.time, 'sleep'):
            self.assertEqual(len(M.prepare_sessions(10)), 3)

    def test_session_identity_changes_refused(self):
        ref = M.SessionRef(0, 0, 'VCE', '100', 'TEST', '')
        with patch.object(M, 'get_sap_application', return_value=application([session('CEQ')])):
            with self.assertRaisesRegex(RuntimeError, 'identity changed'): M.get_session_by_ref(ref)

    def test_confirmation_popup_not_clicked(self):
        button = Mock()
        with patch.object(M, 'element_exists', return_value=True), patch.object(M, 'popup_text', return_value='Save changes?'), patch.object(M, 'find_by_id', return_value=button):
            with self.assertRaisesRegex(RuntimeError, 'manual confirmation'): M.dismiss_popup(Mock())
        button.Press.assert_not_called()

    def test_multiple_workers_consume_each_row_once(self):
        tasks = queue.Queue(); results = queue.Queue()
        for i in range(20): tasks.put(M.Task(i + 2, str(i), '0041889'))
        refs = [M.SessionRef(0, i, 'VCE', '100', 'TEST', '') for i in range(3)]
        barrier = threading.Barrier(3)
        seen_workers = set()
        def query(_session, task, worker):
            if worker not in seen_workers:
                seen_workers.add(worker)
                barrier.wait(timeout=3)
            return M.Result(task.excel_row, task.material, task.vendor, 'SUCCESS', '14.09.2026', worker_id=worker)
        with patch.object(M, 'get_session_by_ref', side_effect=lambda ref: session()), patch.object(M, 'query_one', side_effect=query), patch.object(M, 'safe_print'):
            workers = [threading.Thread(target=M.worker_loop, args=(i + 1, ref, tasks, results)) for i, ref in enumerate(refs)]
            for worker in workers: worker.start()
            for worker in workers: worker.join()
        rows = [results.get_nowait().excel_row for _ in range(results.qsize())]
        self.assertEqual(sorted(rows), list(range(2, 22)))
        self.assertTrue(tasks.empty())
        self.assertEqual(seen_workers, {1, 2, 3})

    def test_cancel_does_not_take_next_row(self):
        M.STOP_EVENT.set()
        tasks = queue.Queue(); tasks.put(M.Task(2, '123', '456'))
        with patch.object(M, 'get_session_by_ref', return_value=session()), patch.object(M, 'query_one') as query, patch.object(M, 'safe_print'):
            M.worker_loop(1, M.SessionRef(0, 0, 'VCE', '100', 'TEST', ''), tasks, queue.Queue())
        query.assert_not_called()
        self.assertEqual(tasks.qsize(), 1)

    def test_query_uses_first_result_and_reads_date(self):
        grid = SimpleNamespace(RowCount=2, CurrentCellColumn='initial', SelectedRows='')
        execute = Mock()
        gui = SimpleNamespace(FindById=lambda key: grid if key == M.ID_RESULT_GRID else execute)
        task = M.Task(2, '00012345', '0041889')
        with patch.object(M, 'ensure_selection_screen'), patch.object(M, 'fill_selection') as fill, patch.object(M, 'wait_not_busy'), patch.object(M, 'wait_result_or_message', return_value=('GRID', '')), patch.object(M, 'element_exists', return_value=False), patch.object(M, 'read_plan_closure_date', return_value='14.09.2026'):
            result = M.query_one(gui, task, 1)
        fill.assert_called_once_with(gui, task.material, task.vendor)
        self.assertEqual(grid.SelectedRows, '0')
        self.assertEqual(execute.Press.call_count, 2)
        self.assertEqual(result.status, 'SUCCESS')
        self.assertEqual(result.plan_closure_date_text, '14.09.2026')

    def test_missing_result_does_not_change_excel(self):
        ws = Sheet()
        result = M.Result(2, '00012345', '0041889', 'NO_RESULT')
        M.apply_result(ws, result)
        self.assertIsNone(ws.Cells(2, 5).Value2)


if __name__ == '__main__': unittest.main()
