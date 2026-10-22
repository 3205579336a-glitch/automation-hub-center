"""Offline APQP engine tests. Never connect to SAP or Excel."""
import datetime as dt
import importlib.util
import os
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
    def find(name, *args):
        if name == 'wnd[0]': return SimpleNamespace()
        if args and args[0] is False: return None
        raise RuntimeError('Not found')
    return SimpleNamespace(Info=SimpleNamespace(SystemName=system, Client=client, User='TEST', Transaction=transaction), Busy=False, FindById=Mock(side_effect=find))


def application(sessions):
    return SimpleNamespace(Children=Children([SimpleNamespace(Description='Test', Children=Children(sessions))]))


class Sheet:
    def __init__(self, date1904=False):
        self.values = {(2, 1): SimpleNamespace(Value2='00012345'), (2, 4): SimpleNamespace(Value2='0041889'), (2, 5): SimpleNamespace(Value2=None, Text='14.09.2026')}
        self.Parent = SimpleNamespace(Date1904=date1904)
    def Cells(self, row, col): return self.values[(row, col)]


class ApqpTests(unittest.TestCase):
    def setUp(self): M.STOP_EVENT.clear()

    def test_real_header_range_uses_one_bulk_read_and_keeps_shape_guard(self):
        ws = SimpleNamespace(Range=Mock(return_value=SimpleNamespace(Value2=(('Part No.', 'Vendor', 'APQP plan closure date', '', ''),))), Cells=Mock())
        self.assertEqual(M.validate_headers(ws), (1, 2, 3))
        ws.Range.assert_called_once_with('A1:E1')
        ws.Cells.assert_not_called()
        ws.Range.return_value.Value2 = (('Part No.',),)
        with self.assertRaisesRegex(RuntimeError, 'incomplete APQP headers'):
            M.validate_headers(ws)

    def test_live_invalid_data_is_rejected_before_any_sap_access(self):
        ws = self.header_sheet(['Part No.', 'Vendor', 'APQP plan closure date'])
        with patch.object(M, 'EXCEL_PATH', str(Path(__file__).parents[1] / 'resources/templates/APQP_Plan_Closure_Template.xlsx')), \
             patch.object(sys, 'argv', ['engine']), patch.object(M, 'get_or_open_excel_workbook', return_value=(None, SimpleNamespace(ReadOnly=False), ws, False)), \
             patch.object(M, 'read_excel_tasks', return_value=([M.Task(2, '123', '41889')], 0, 1)), \
             patch.object(M, 'wait_for_hub_sessions') as connect, patch.object(M, 'prepare_sessions') as prepare, patch.object(M, 'emit'):
            with self.assertRaisesRegex(ValueError, 'incomplete Part No./Vendor'):
                M.main()
        connect.assert_not_called()
        prepare.assert_not_called()

    def test_navigation_ready_path_has_no_sleep_or_full_inventory_scan(self):
        current = session(transaction='ME11')
        app = self.production([self.connection([current])])
        current.StartTransaction = Mock(side_effect=lambda _: self.mark_apqp_selection(current))
        refs = M.HubSessionConnector(task_count=1).verify()
        connector = M.HubSessionConnector(task_count=1)
        with patch.object(M, 'discover_sap_sessions', side_effect=AssertionError('No inventory scan while verifying a bound window')), \
             patch.object(M.STOP_EVENT, 'wait') as wait, patch.object(M, 'get_sap_application', return_value=app) as application:
            self.assertEqual(connector.verify_navigation(refs[0]), refs)
        wait.assert_not_called()
        application.assert_called_once()

    def test_navigation_poll_is_20ms_and_does_not_rescan_connections(self):
        current = session()
        self.mark_apqp_selection(current)
        app = self.production([self.connection([current])])
        ref = M.SessionRef(0, 0, 'VCE', '100', 'TEST', 'VCE - One Digital Core [949]')
        current.Busy = True
        polls = []
        def tick(seconds):
            polls.append(seconds)
            if len(polls) == 2: current.Busy = False
            return False
        with patch.object(M, 'SAP_CONNECTION_READY_TIMEOUT_SEC', 1), patch.object(M.STOP_EVENT, 'wait', side_effect=tick), \
             patch.object(M, 'get_sap_application', return_value=app) as application, \
             patch.object(M, 'discover_sap_sessions', side_effect=AssertionError('No repeated inventory scan')):
            self.assertEqual(M.HubSessionConnector().verify_navigation(ref), [ref])
        self.assertEqual(polls, [0.02, 0.02])
        application.assert_called_once()

    def test_native_entry_supports_collection_aliases_without_children(self):
        from sap_gui_fakes import Collection
        current = session()
        conn = SimpleNamespace(Description='VCE - One Digital Core [949]', Sessions=Collection([current]))
        raw = SimpleNamespace(Connections=Collection([conn]))
        with patch.object(M.win32com.client, 'GetObject', return_value=SimpleNamespace(GetScriptingEngine=raw)):
            app = M.get_sap_application()
            self.assertIs(app.Children(0).Children(0), current)
            self.assertEqual(app.Children.Count, 1)

    def test_native_entry_preserves_explicit_scripting_disabled_reason(self):
        from sap_gui_fakes import application, connection
        raw = application([connection(disabled=True)])
        with patch.object(M.win32com.client, 'GetObject', return_value=SimpleNamespace(GetScriptingEngine=raw)):
            with self.assertRaisesRegex(RuntimeError, 'SAP_SCRIPTING_DISABLED'):
                M.get_sap_application().Children(0).Children.Count
            with patch.object(M, 'TARGET_CONNECTION_NAME', 'VCE - One Digital Core [949]'):
                with self.assertRaises(M.SapSessionCheckError) as result:
                    M.discover_sap_sessions()
                self.assertEqual(result.exception.code, 'SAP_SCRIPTING_DISABLED')
                self.assertIn('IT', result.exception.issue_summary)

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

    def test_optional_connection_description_can_fail_without_blocking(self):
        class Connection:
            Children = Children([session()])
            Name = 'Fallback display label'
            @property
            def Description(self): raise RuntimeError('COM Description unavailable')
        app = SimpleNamespace(Children=Children([Connection()]))
        with patch.object(M, 'get_sap_application', return_value=app):
            refs = M.discover_sap_sessions()
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0].connection_description, 'Fallback display label')

    def test_unreadable_busy_window_does_not_hide_healthy_window(self):
        class BadWindow:
            Info = session().Info
            @property
            def Busy(self): raise RuntimeError('COM Busy unavailable')
        app = application([BadWindow(), session()])
        with patch.object(M, 'get_sap_application', return_value=app), patch.object(M, 'emit') as emit:
            refs = M.discover_sap_sessions()
        self.assertEqual([ref.session_index for ref in refs], [1])
        self.assertEqual(emit.call_args.args[0], 'notice')

    def test_unknown_transaction_is_not_treated_as_home(self):
        class BadInfo:
            SystemName, Client, User = 'VCE', '100', 'TEST'
            @property
            def Transaction(self): raise RuntimeError('COM Transaction unavailable')
        broken = session(); broken.Info = BadInfo()
        with patch.object(M, 'get_sap_application', return_value=application([broken])):
            with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
        self.assertEqual(error.exception.code, 'SAP_SESSION_STATE_UNREADABLE')
        self.assertEqual(M.session_info(broken)[:3], ('VCE', '100', 'TEST'))
        with patch.object(M, 'get_sap_application', return_value=application([broken, session()])), patch.object(M, 'emit'):
            self.assertEqual(M.discover_sap_sessions()[0].session_index, 1)

    def test_popup_read_failure_does_not_mean_no_popup(self):
        broken = session(); broken.FindById.side_effect = RuntimeError('COM popup state unavailable')
        with patch.object(M, 'get_sap_application', return_value=application([broken])):
            with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
        self.assertEqual(error.exception.code, 'SAP_SESSION_STATE_UNREADABLE')

    def test_busy_dialog_and_other_transaction_have_specific_reasons(self):
        busy = session(); busy.Busy = True
        popup = session(); popup.FindById.side_effect = lambda *_: SimpleNamespace()
        other = session(transaction='ME01')
        for value, code in [(busy, 'SAP_SESSION_BUSY'), (popup, 'SAP_SESSION_DIALOG_OPEN'), (other, 'SAP_NO_IDLE_SESSION')]:
            with self.subTest(code=code), patch.object(M, 'get_sap_application', return_value=application([value])):
                with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
                self.assertEqual(error.exception.code, code)
                self.assertTrue(error.exception.issue_summary_zh)
        self.assertIn('ME01', str(error.exception))
        self.assertIn('ME01', error.exception.issue_summary_zh)

    def test_unknown_identity_and_unreadable_connection_remain_blocked(self):
        class BadInfo:
            @property
            def SystemName(self): raise RuntimeError('Identity unavailable')
        bad = session(); bad.Info = BadInfo()
        class BadConnection:
            @property
            def Children(self): raise RuntimeError('Connection inventory unavailable')
        for app in [application([bad, session()]), SimpleNamespace(Children=Children([BadConnection(), application([session()]).Children(0)]))]:
            with patch.object(M, 'get_sap_application', return_value=app):
                with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
            self.assertEqual(error.exception.code, 'SAP_SESSION_IDENTITY_UNREADABLE')

    def test_environment_ambiguity_includes_busy_foreign_window(self):
        foreign = session('CEQ'); foreign.Busy = True
        with patch.object(M, 'get_sap_application', return_value=application([session(), foreign])), patch.object(M, 'TARGET_SYSTEM', ''), patch.object(M, 'TARGET_CLIENT', ''):
            with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
        self.assertEqual(error.exception.code, 'SAP_ENVIRONMENT_AMBIGUOUS')

    def test_scan_and_login_errors_are_classified(self):
        with patch.object(M, 'get_sap_application', side_effect=RuntimeError('COM unavailable')):
            with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
        self.assertEqual(error.exception.code, 'SAP_GUI_UNAVAILABLE')
        with patch.object(M, 'get_sap_application', return_value=SimpleNamespace()):
            with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
        self.assertEqual(error.exception.code, 'SAP_SESSION_SCAN_FAILED')
        signed_out = session(); signed_out.Info.User = ''
        with patch.object(M, 'get_sap_application', return_value=application([signed_out])):
            with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
        self.assertEqual(error.exception.code, 'SAP_NOT_SIGNED_IN')

    def test_hub_pause_keeps_original_reason_and_does_not_reopen_connection(self):
        hub = SimpleNamespace(wait=Mock(return_value=['verified']))
        error = M.SapSessionCheckError('SAP_NO_IDLE_SESSION', 'ME01 is open', '当前窗口在 ME01', 'technical evidence')
        with patch.object(M, 'discover_sap_sessions', side_effect=error) as discover, patch.object(M, 'get_sap_application', return_value=SimpleNamespace()), patch('me01_source_list.launch_sap_logon') as launch:
            self.assertEqual(M.wait_for_hub_sessions(hub), ['verified'])
            self.assertIsInstance(hub.wait.call_args.args[3].__self__, M.HubSessionConnector)
        self.assertEqual(hub.wait.call_args.args[1:3], ('ME01 is open', '当前窗口在 ME01'))
        self.assertIn('technical evidence', hub.wait.call_args.kwargs['detail'])
        launch.assert_not_called()

    def production(self, connections=None):
        self.enterContext(patch.object(M, 'TARGET_CONNECTION_NAME', 'VCE - One Digital Core [949]'))
        self.enterContext(patch.object(M, 'AUTO_OPEN_TARGET', True))
        self.enterContext(patch.object(M, 'AUTO_NAVIGATE_TARGET', True))
        self.enterContext(patch.object(M, 'SAP_CONNECTION_READY_TIMEOUT_SEC', 0))
        self.enterContext(patch.object(M, 'TARGET_SYSTEM', 'VCE'))
        self.enterContext(patch.object(M, 'TARGET_CLIENT', '100'))
        app = SimpleNamespace(Children=Children(connections or []), OpenConnection=Mock())
        self.enterContext(patch.object(M, 'get_sap_application', return_value=app))
        self.enterContext(patch.object(M, 'emit'))
        return app

    def connection(self, sessions, label='VCE - One Digital Core [949]'):
        return SimpleNamespace(Description=label, Children=Children(sessions))

    def test_949_reuses_production_ignoring_known_qa(self):
        app = self.production([self.connection([session('CEQ')], 'QA [321]'), self.connection([session(), session()])])
        refs = M.HubSessionConnector().verify()
        self.assertEqual([ref.connection_index for ref in refs], [1, 1])
        self.assertEqual(len(M.prepare_sessions(2)), 2)
        app.OpenConnection.assert_not_called()

    def test_949_missing_opens_once_then_reuses_verified_sso(self):
        app = self.production([self.connection([session('CEQ')], 'QA [321]')])
        app.OpenConnection.side_effect = lambda *_: app.Children.items.append(self.connection([session()]))
        connector = M.HubSessionConnector()
        self.assertEqual(connector.verify()[0].connection_index, 1)
        self.assertEqual(connector.verify()[0].client, '100')
        app.OpenConnection.assert_called_once_with('VCE - One Digital Core [949]', False)

    def test_949_async_open_pending_never_replayed_even_after_error(self):
        for fail in [False, True]:
            with self.subTest(fail=fail):
                app = self.production()
                if fail: app.OpenConnection.side_effect = RuntimeError('COM timeout after request')
                connector = M.HubSessionConnector()
                for attempt in range(3):
                    with self.assertRaises(M.SapSessionCheckError) as error: connector.verify()
                    self.assertEqual(error.exception.code, 'SAP_TARGET_OPEN_FAILED' if fail and attempt == 0 else 'SAP_TARGET_OPEN_PENDING')
                app.OpenConnection.assert_called_once()

    def test_949_failed_open_can_still_have_created_login(self):
        app = self.production()
        def open_then_fail(*_):
            app.Children.items.append(self.connection([session()]))
            raise RuntimeError('COM return failed')
        app.OpenConnection.side_effect = open_then_fail
        connector = M.HubSessionConnector()
        with self.assertRaises(M.SapSessionCheckError): connector.verify()
        self.assertEqual(connector.verify()[0].system, 'VCE')
        app.OpenConnection.assert_called_once()

    def test_949_existing_signed_out_empty_busy_popup_and_other_transaction_never_reopened(self):
        signed_out = session(); signed_out.Info.User = ''
        busy = session(); busy.Busy = True
        popup = session(); popup.FindById.side_effect = lambda *_: SimpleNamespace()
        for windows, code in [([], 'SAP_NOT_SIGNED_IN'), ([signed_out], 'SAP_LOGIN_REQUIRED'),
                              ([busy], 'SAP_SESSION_BUSY'), ([popup], 'SAP_SESSION_DIALOG_OPEN')]:
            with self.subTest(code=code):
                app = self.production([self.connection(windows)])
                with self.assertRaises(M.SapSessionCheckError) as error: M.HubSessionConnector().verify()
                self.assertEqual(error.exception.code, code)
                app.OpenConnection.assert_not_called()

    def test_949_mismatched_system_client_and_duplicate_entries_block(self):
        for connections, code in [([self.connection([session('CEQ')])], 'SAP_SESSION_IDENTITY_UNREADABLE'),
                                  ([self.connection([session(client='949')])], 'SAP_SESSION_IDENTITY_UNREADABLE'),
                                  ([self.connection([session()]), self.connection([session()])], 'SAP_TARGET_AMBIGUOUS')]:
            app = self.production(connections)
            with self.assertRaises(M.SapSessionCheckError) as error: M.HubSessionConnector().verify()
            self.assertEqual(error.exception.code, code)
            app.OpenConnection.assert_not_called()

    def test_949_unknown_inventory_or_alias_never_causes_extra_login(self):
        class BadConnection:
            Name = 'con[0]'
            @property
            def Description(self): raise RuntimeError('Unreadable Description')
        for connections, code in [([BadConnection()], 'SAP_TARGET_INVENTORY_UNREADABLE'),
                                  ([self.connection([session()], 'Another production label')], 'SAP_TARGET_ALIAS_PRESENT')]:
            app = self.production(connections)
            with self.assertRaises(M.SapSessionCheckError) as error: M.HubSessionConnector().verify()
            self.assertEqual(error.exception.code, code)
            app.OpenConnection.assert_not_called()

    def test_949_logon_launch_wait_is_cancellable_and_once_only(self):
        self.production()
        connector = M.HubSessionConnector()
        with patch.object(M, 'get_sap_application', side_effect=RuntimeError('GUI unavailable')), patch('me01_source_list.launch_sap_logon') as launch, patch.object(M.STOP_EVENT, 'wait', return_value=True):
            with self.assertRaises(M.HubStopped): connector.verify()
            self.assertTrue(connector.logon_attempted)
            with self.assertRaises(M.SapSessionCheckError): connector.verify()
            launch.assert_called_once()

    def test_949_logon_launch_failure_is_actionable_and_not_retried(self):
        app = self.production()
        connector = M.HubSessionConnector()
        with patch.object(M, 'get_sap_application', side_effect=RuntimeError('GUI unavailable')), patch('me01_source_list.launch_sap_logon', side_effect=RuntimeError('saplogon.exe not found')) as launch:
            with self.assertRaises(M.SapSessionCheckError) as error: connector.verify()
            self.assertEqual(error.exception.code, 'SAP_LOGON_START_FAILED')
            with self.assertRaises(M.SapSessionCheckError): connector.verify()
            launch.assert_called_once()
        app.OpenConnection.assert_not_called()

    def test_949_starts_logon_then_opens_target_after_scripting_becomes_available(self):
        app = self.production()
        app.OpenConnection.side_effect = lambda *_: app.Children.items.append(self.connection([session()]))
        started = False
        def get_application():
            nonlocal started
            if not started:
                started = True
                raise RuntimeError('Not started')
            return app
        with patch.object(M, 'get_sap_application', side_effect=get_application), patch('me01_source_list.launch_sap_logon') as launch, patch.object(M.STOP_EVENT, 'wait', return_value=False):
            self.assertEqual(M.HubSessionConnector().verify()[0].client, '100')
        launch.assert_called_once()
        app.OpenConnection.assert_called_once()

    def test_949_hub_recheck_preserves_once_only_connector(self):
        app = self.production()
        signed_out = session(); signed_out.Info.User = ''
        app.OpenConnection.side_effect = lambda *_: app.Children.items.append(self.connection([signed_out]))
        def wait(stage, issue, issue_zh, verify, **context):
            self.assertEqual(stage, 'SIGN_IN')
            self.assertIn('949', issue)
            self.assertIn('949', issue_zh)
            with self.assertRaises(M.SapSessionCheckError): verify()
            signed_out.Info.User = 'TEST'
            return verify()
        self.assertEqual(M.wait_for_hub_sessions(SimpleNamespace(wait=wait))[0].client, '100')
        app.OpenConnection.assert_called_once()

    def unsigned_session(self, title=None):
        gui = session(); gui.Info.User = ''
        main = SimpleNamespace(Handle='101', Restore=Mock(), SendVKey=Mock())
        dialog = SimpleNamespace(Handle='102', Text=title, SendVKey=Mock(), Close=Mock()) if title is not None else None
        gui.FindById.side_effect = lambda key, *args: main if key == 'wnd[0]' else dialog if key == 'wnd[1]' else None
        gui.CreateSession, gui.StartTransaction = Mock(), Mock()
        return gui, main, dialog

    def native_window_mocks(self):
        return {name: self.enterContext(patch.object(M.win32gui, name, return_value=True))
                for name in ['IsWindow', 'IsWindowVisible', 'ShowWindow', 'SetForegroundWindow']}

    def test_unsigned_multiple_logon_restores_owner_and_dialog_without_choosing_any_option(self):
        gui, main, dialog = self.unsigned_session('License Information for Multiple Logons')
        app = self.production([self.connection([gui])])
        native = self.native_window_mocks()
        connector = M.HubSessionConnector()
        for _ in range(2):
            with self.assertRaises(M.SapSessionCheckError) as error: connector.verify()
            self.assertEqual(error.exception.code, 'SAP_MULTIPLE_LOGONS')
            self.assertIn('多重登录', error.exception.issue_summary_zh)
            self.assertIn('visible=True', str(error.exception))
        self.assertEqual(native['ShowWindow'].call_args_list, [((101, M.win32con.SW_RESTORE),), ((102, M.win32con.SW_RESTORE),)])
        native['SetForegroundWindow'].assert_called_once_with(102)
        app.OpenConnection.assert_not_called()
        gui.CreateSession.assert_not_called(); gui.StartTransaction.assert_not_called()
        main.SendVKey.assert_not_called(); dialog.SendVKey.assert_not_called(); dialog.Close.assert_not_called()

    def test_hidden_unsigned_login_window_is_displayed_not_confused_with_signed_in_session(self):
        gui, _, _ = self.unsigned_session()
        app = self.production([self.connection([gui])])
        native = self.native_window_mocks()
        with self.assertRaises(M.SapSessionCheckError) as error: M.HubSessionConnector().verify()
        self.assertEqual(error.exception.code, 'SAP_LOGIN_REQUIRED')
        native['ShowWindow'].assert_called_once_with(101, M.win32con.SW_RESTORE)
        native['SetForegroundWindow'].assert_called_once_with(101)
        app.OpenConnection.assert_not_called()

    def test_unknown_sign_in_dialog_is_displayed_without_pressing_it(self):
        gui, _, dialog = self.unsigned_session('SAP Logon Error')
        app = self.production([self.connection([gui])])
        native = self.native_window_mocks()
        with self.assertRaises(M.SapSessionCheckError) as error: M.HubSessionConnector().verify()
        self.assertEqual(error.exception.code, 'SAP_LOGIN_DIALOG_OPEN')
        self.assertIn('SAP Logon Error', str(error.exception))
        native['SetForegroundWindow'].assert_called_once_with(102)
        dialog.SendVKey.assert_not_called(); dialog.Close.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_show_pending_invalid_handle_or_identity_change_does_not_operate_any_window(self):
        gui, _, _ = self.unsigned_session('License Information for Multiple Logons')
        app = self.production([self.connection([gui])])
        native = self.native_window_mocks()
        native['IsWindow'].return_value = False
        ref = M.SessionRef(0, 0, 'VCE', '100', '', 'VCE [949]')
        with self.assertRaises(RuntimeError): M.show_pending_sap_window(ref, set())
        native['ShowWindow'].assert_not_called()
        gui.Info.SystemName = 'CEQ'
        with self.assertRaises(M.SapSessionCheckError): M.show_pending_sap_window(ref, set())
        native['ShowWindow'].assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_foreground_restriction_keeps_real_login_problem_and_does_not_retry_connection(self):
        gui, _, _ = self.unsigned_session('License Information for Multiple Logons')
        app = self.production([self.connection([gui])])
        native = self.native_window_mocks()
        native['SetForegroundWindow'].side_effect = RuntimeError('Windows foreground restriction')
        with self.assertRaises(M.SapSessionCheckError) as error: M.HubSessionConnector().verify()
        self.assertEqual(error.exception.code, 'SAP_MULTIPLE_LOGONS')
        self.assertIn('Windows foreground restriction', str(error.exception))
        app.OpenConnection.assert_not_called()

    def test_readonly_discovery_classifies_multi_logon_but_does_not_show_window(self):
        gui, _, _ = self.unsigned_session('License Information for Multiple Logons')
        self.production([self.connection([gui])])
        native = self.native_window_mocks()
        with self.assertRaises(M.SapSessionCheckError) as error: M.discover_sap_sessions()
        self.assertEqual(error.exception.code, 'SAP_MULTIPLE_LOGONS')
        native['ShowWindow'].assert_not_called(); native['SetForegroundWindow'].assert_not_called()

    def test_unsigned_foreign_identity_is_neither_shown_nor_reopened(self):
        gui, _, _ = self.unsigned_session(); gui.Info.Client = '949'
        app = self.production([self.connection([gui])])
        native = self.native_window_mocks()
        with self.assertRaises(M.SapSessionCheckError) as error: M.HubSessionConnector().verify()
        self.assertEqual(error.exception.code, 'SAP_SESSION_IDENTITY_UNREADABLE')
        native['ShowWindow'].assert_not_called()
        app.OpenConnection.assert_not_called()

    def mark_apqp_selection(self, gui):
        gui.Info.Transaction = M.TCODE
        old_find = gui.FindById.side_effect
        gui.FindById.side_effect = lambda key, *args: SimpleNamespace() if key in {M.ID_CHECK_C3, M.ID_PLANT, M.ID_VENDOR, M.ID_MATERIAL} else old_find(key, *args)

    def test_other_transaction_switches_in_same_window_without_creating_session(self):
        for transaction in ['ME11', 'ME01', 'ZMFM050072']:
            with self.subTest(transaction=transaction):
                old = session(transaction=transaction)
                old.StartTransaction = Mock(side_effect=lambda _: self.mark_apqp_selection(old))
                old.CreateSession, old.SendCommand, old.sendVKey = Mock(), Mock(), Mock()
                app = self.production([self.connection([old])])
                connector = M.HubSessionConnector()
                refs = connector.verify()
                self.assertEqual([ref.session_index for ref in refs], [0])
                self.assertEqual(len(connector.verify()), 1)
                self.assertEqual(old.Info.Transaction, M.TCODE)
                self.assertEqual(app.Children(0).Children.Count, 1)
                old.StartTransaction.assert_called_once_with(M.TCODE)
                old.CreateSession.assert_not_called(); old.SendCommand.assert_not_called(); old.sendVKey.assert_not_called()
                app.OpenConnection.assert_not_called()

    def test_home_and_other_tcodes_can_all_supply_existing_parallel_workers(self):
        windows = [session(transaction='ME11'), session(), session(transaction='ME01')]
        for current in windows:
            current.StartTransaction = Mock(side_effect=lambda _, current=current: self.mark_apqp_selection(current))
            current.CreateSession = Mock()
        app = self.production([self.connection(windows)])
        connector = M.HubSessionConnector(task_count=3)
        with patch.object(M, 'MAX_WORKERS', 3):
            refs = connector.verify()
            self.assertEqual([ref.session_index for ref in refs], [1, 0, 2])
            # Handoff must preserve the selected windows, not scan for home again.
            with patch.object(M, 'discover_sap_sessions', side_effect=AssertionError('No new selection during handoff')):
                self.assertEqual(M.prepare_sessions(3, refs), refs)
            self.assertEqual(len(connector.verify()), 3)
        windows[0].StartTransaction.assert_called_once_with(M.TCODE)
        windows[1].StartTransaction.assert_not_called()
        windows[2].StartTransaction.assert_called_once_with(M.TCODE)
        for current in windows:
            current.CreateSession.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_one_excel_row_navigates_only_one_existing_business_window(self):
        windows = [session(transaction=tcode) for tcode in ('ME11', 'ME01', 'ZMFM050072')]
        for current in windows:
            current.StartTransaction = Mock(side_effect=lambda _, current=current: self.mark_apqp_selection(current))
        app = self.production([self.connection(windows)])
        refs = M.HubSessionConnector(task_count=1).verify()
        self.assertEqual([ref.session_index for ref in refs], [0])
        windows[0].StartTransaction.assert_called_once_with(M.TCODE)
        windows[1].StartTransaction.assert_not_called()
        windows[2].StartTransaction.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_single_worker_prefers_home_even_if_other_tcodes_appear_first(self):
        windows = [session(transaction='ME11'), session(transaction='ME01'), session()]
        for current in windows:
            current.StartTransaction = Mock()
        app = self.production([self.connection(windows)])
        with patch.object(M, 'MAX_WORKERS', 1):
            refs = M.HubSessionConnector(task_count=10).verify()
        self.assertEqual([ref.session_index for ref in refs], [2])
        for current in windows:
            current.StartTransaction.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_partial_parallel_navigation_preserves_each_once_only_attempt(self):
        windows = [session(transaction='ME11'), session(transaction='ME01'), session(transaction='ME12')]
        for current in windows:
            current.StartTransaction = Mock(side_effect=lambda _, current=current: self.mark_apqp_selection(current))
        windows[1].StartTransaction.side_effect = RuntimeError('COM response unavailable')
        app = self.production([self.connection(windows)])
        connector = M.HubSessionConnector(task_count=3)
        with self.assertRaisesRegex(M.SapSessionCheckError, 'SAP_APQP_NAVIGATION_FAILED'):
            connector.verify()
        with self.assertRaisesRegex(M.SapSessionCheckError, 'SAP_APQP_NAVIGATION_PENDING'):
            connector.verify()
        self.mark_apqp_selection(windows[1])  # User resolves the original window.
        self.assertEqual(len(connector.verify()), 3)
        for current in windows:
            current.StartTransaction.assert_called_once_with(M.TCODE)
        app.OpenConnection.assert_not_called()

    def test_worker_handoff_refuses_a_window_changed_after_startup(self):
        current = session()
        self.production([self.connection([current])])
        refs = M.HubSessionConnector(task_count=1).verify()
        current.Info.Transaction = 'ME11'  # A later user change, not startup.
        with self.assertRaisesRegex(M.SapSessionCheckError, 'SAP_SESSION_CHANGED'):
            M.prepare_sessions(1, refs)

    def test_direct_worker_preparation_also_honors_explicit_auto_navigation(self):
        current = session(transaction='ME11')
        current.StartTransaction = Mock(side_effect=lambda _: self.mark_apqp_selection(current))
        app = self.production([self.connection([current])])
        refs = M.prepare_sessions(1)
        self.assertEqual([ref.session_index for ref in refs], [0])
        current.StartTransaction.assert_called_once_with(M.TCODE)
        app.OpenConnection.assert_not_called()

    def test_same_window_navigation_error_and_timeout_do_not_replay_request(self):
        for fail in [False, True]:
            with self.subTest(fail=fail):
                old = session(transaction='ME11')
                old.CreateSession = Mock()
                old.StartTransaction = Mock(side_effect=RuntimeError('Not authorized') if fail else None)
                app = self.production([self.connection([old])])
                connector = M.HubSessionConnector()
                for attempt in range(2):
                    with self.assertRaises(M.SapSessionCheckError) as error: connector.verify()
                    self.assertEqual(error.exception.code, 'SAP_APQP_NAVIGATION_FAILED' if fail and attempt == 0 else 'SAP_APQP_NAVIGATION_PENDING')
                old.StartTransaction.assert_called_once_with(M.TCODE)
                old.CreateSession.assert_not_called()
                app.OpenConnection.assert_not_called()
                self.mark_apqp_selection(old)
                self.assertEqual(connector.verify()[0].session_index, 0)

    def test_logged_out_qa_does_not_block_me11_in_production(self):
        qa = session('CEQ'); qa.Info.User = ''
        old = session(transaction='ME11')
        old.CreateSession = Mock()
        old.StartTransaction = Mock(side_effect=lambda _: self.mark_apqp_selection(old))
        app = self.production([self.connection([qa], 'CEQ - One Digital Core - QA [321]'), self.connection([old])])
        refs = M.HubSessionConnector().verify()
        self.assertEqual((refs[0].connection_index, refs[0].session_index), (1, 0))
        old.StartTransaction.assert_called_once_with(M.TCODE)
        old.CreateSession.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_same_window_navigation_com_error_can_still_have_reached_apqp(self):
        old = session(transaction='ME11')
        app = self.production([self.connection([old])])
        def navigate_then_fail(_):
            self.mark_apqp_selection(old)
            raise RuntimeError('COM response lost')
        old.StartTransaction = Mock(side_effect=navigate_then_fail)
        old.CreateSession = Mock()
        connector = M.HubSessionConnector()
        with self.assertRaises(M.SapSessionCheckError): connector.verify()
        self.assertEqual(connector.verify()[0].session_index, 0)
        old.StartTransaction.assert_called_once_with(M.TCODE)
        old.CreateSession.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_business_session_with_popup_or_busy_is_not_navigated(self):
        for blocked in ['popup', 'busy', 'transaction-unreadable']:
            old = session(transaction='ME11'); old.CreateSession, old.StartTransaction = Mock(), Mock()
            if blocked == 'popup': old.FindById.side_effect = lambda *_: SimpleNamespace()
            if blocked == 'busy': old.Busy = True
            if blocked == 'transaction-unreadable': old.Info.Transaction = None
            app = self.production([self.connection([old])])
            with self.assertRaises(M.SapSessionCheckError): M.HubSessionConnector().verify()
            old.CreateSession.assert_not_called()
            old.StartTransaction.assert_not_called()
            app.OpenConnection.assert_not_called()

    def test_same_window_navigation_polling_is_cancellable(self):
        old = session(transaction='ME11'); old.CreateSession, old.StartTransaction = Mock(), Mock()
        app = self.production([self.connection([old])])
        with patch.object(M, 'SAP_CONNECTION_READY_TIMEOUT_SEC', 8), patch.object(M.STOP_EVENT, 'wait', return_value=True):
            with self.assertRaises(M.HubStopped): M.HubSessionConnector().verify()
        old.StartTransaction.assert_called_once_with(M.TCODE)
        old.CreateSession.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_navigation_save_discard_dialog_is_not_clicked_or_replayed(self):
        old = session(transaction='ME11')
        old.CreateSession, old.sendVKey = Mock(), Mock()
        def navigate(_): old.FindById.side_effect = lambda *_: SimpleNamespace(Press=Mock())
        old.StartTransaction = Mock(side_effect=navigate)
        app = self.production([self.connection([old])])
        connector = M.HubSessionConnector()
        for _ in range(2):
            with self.assertRaises(M.SapSessionCheckError) as error: connector.verify()
            self.assertEqual(error.exception.code, 'SAP_SESSION_DIALOG_OPEN')
        old.StartTransaction.assert_called_once_with(M.TCODE)
        old.CreateSession.assert_not_called(); old.sendVKey.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_navigation_requires_real_apqp_fields_before_allowing_execution(self):
        old = session(transaction='ME11'); old.CreateSession = Mock()
        old.StartTransaction = Mock(side_effect=lambda _: setattr(old.Info, 'Transaction', M.TCODE))
        self.production([self.connection([old])])
        connector = M.HubSessionConnector()
        for _ in range(2):
            with self.assertRaises(M.SapSessionCheckError) as error: connector.verify()
            self.assertEqual(error.exception.code, 'SAP_APQP_NAVIGATION_PENDING')
        self.mark_apqp_selection(old)
        self.assertEqual(connector.verify()[0].session_index, 0)
        old.StartTransaction.assert_called_once_with(M.TCODE)
        old.CreateSession.assert_not_called()

    def test_logon_only_async_sso_waits_for_target_instead_of_immediate_pause(self):
        app = self.production()
        def complete_sso(_seconds):
            if not app.Children.items: app.Children.items.append(self.connection([session()]))
            return False
        with patch.object(M, 'SAP_CONNECTION_READY_TIMEOUT_SEC', 8), patch.object(M.STOP_EVENT, 'wait', side_effect=complete_sso):
            refs = M.HubSessionConnector().verify()
        self.assertEqual(refs[0].system, 'VCE')
        app.OpenConnection.assert_called_once()

    def test_hub_defaults_enable_949_and_same_window_navigation_with_old_blank_runner_fields(self):
        spec = importlib.util.spec_from_file_location('apqp_hub_defaults_test', SPEC.origin)
        module = importlib.util.module_from_spec(spec)
        self.enterContext(patch.dict(sys.modules, {spec.name: module}))
        with patch.dict(os.environ, {'HUB_RUN_ID': 'offline-test', 'TARGET_SYSTEM': '', 'TARGET_CLIENT': '', 'APQP_TARGET_CONNECTION_NAME': ''}), patch.dict(os.environ):
            for key in ['APQP_AUTO_OPEN_TARGET', 'APQP_AUTO_NAVIGATE_TARGET']: os.environ.pop(key, None)
            spec.loader.exec_module(module)
        self.assertEqual((module.TARGET_SYSTEM, module.TARGET_CLIENT), ('VCE', '100'))
        self.assertEqual(module.TARGET_CONNECTION_NAME, 'VCE - One Digital Core [949]')
        self.assertTrue(module.AUTO_OPEN_TARGET)
        self.assertTrue(module.AUTO_NAVIGATE_TARGET)

    def test_preview_never_verifies_or_opens_sap_even_with_auto_enabled(self):
        app = self.production()
        ws = self.header_sheet(['Part No.', 'Vendor', 'APQP plan closure date'])
        with patch.object(M, 'EXCEL_PATH', str(Path(__file__).parents[1] / 'resources/templates/APQP_Plan_Closure_Template.xlsx')), patch.object(sys, 'argv', ['engine', '--preview']), patch.object(M, 'get_or_open_excel_workbook', return_value=(None, SimpleNamespace(), ws, False)), patch.object(M, 'iter_excel_input_rows', return_value=iter([(2, '123', '41889', '')])), patch.object(M, 'wait_for_hub_sessions') as verify, patch.object(M, 'prepare_sessions') as prepare, patch.object(M, 'preview_payload', return_value={}):
            M.main()
        verify.assert_not_called()
        prepare.assert_not_called()
        app.OpenConnection.assert_not_called()

    def test_949_stop_and_disabled_auto_open_do_not_launch(self):
        app = self.production()
        M.STOP_EVENT.set()
        with self.assertRaises(M.HubStopped): M.HubSessionConnector().verify()
        M.STOP_EVENT.clear()
        with patch.object(M, 'AUTO_OPEN_TARGET', False):
            with self.assertRaises(M.SapSessionCheckError) as error: M.HubSessionConnector().verify()
        self.assertEqual(error.exception.code, 'SAP_TARGET_CONNECTION_MISSING')
        app.OpenConnection.assert_not_called()

    def test_949_label_token_exactness_and_identity_recheck(self):
        self.production()
        self.assertTrue(M.matches_target_connection('VCE - One Digital Core [949]'))
        self.assertTrue(M.matches_target_connection('Company Production [949]'))
        self.assertFalse(M.matches_target_connection('QA [1949]'))
        self.assertFalse(M.matches_target_connection('QA [321]'))
        ref = M.SessionRef(0, 0, 'VCE', '100', 'TEST', 'VCE [949]')
        with patch.object(M, 'get_sap_application', return_value=SimpleNamespace(Children=Children([self.connection([session()], 'Other [321]')]))):
            with self.assertRaises(M.SapSessionCheckError) as error: M.get_session_by_ref(ref)
        self.assertEqual(error.exception.code, 'SAP_SESSION_CHANGED')

    def test_multiple_healthy_sessions_are_limited_without_creating_or_navigating(self):
        sessions = [session() for _ in range(5)]
        for value in sessions:
            value.CreateSession, value.StartTransaction, value.sendVKey = Mock(), Mock(), Mock()
        with patch.object(M, 'get_sap_application', return_value=application(sessions)), patch.object(M, 'MAX_WORKERS', 3):
            refs = M.discover_sap_sessions()
        self.assertEqual(len(refs), 3)
        for value in sessions:
            value.CreateSession.assert_not_called(); value.StartTransaction.assert_not_called(); value.sendVKey.assert_not_called()

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
