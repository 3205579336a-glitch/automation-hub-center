"""Pause protocol and native adapters: all SAP/Excel objects mocked."""
import importlib.util
import io
import os
import sys
import threading
import queue
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).parents[1] / 'resources/rpa'
sys.path.insert(0, str(ROOT))
from hub_user_interaction import HubStopped, HubUserInteraction, session_identity, verify_session
import me01_source_list as me01
import apqp_plan_closure as apqp


class Children:
    def __init__(self, items): self.items = items
    @property
    def Count(self): return len(self.items)
    def __call__(self, index): return self.items[index]


def sap_session(system='TEST', user='TEST-USER', transaction='SESSION_MANAGER'):
    def find(name, *args):
        if name == 'wnd[1]': return None
        if name == 'wnd[0]/sbar': return SimpleNamespace(MessageType='', Text='')
        return Mock()
    return SimpleNamespace(Id='mock-session', Busy=False,
        Info=SimpleNamespace(SystemName=system, Client='100', User=user, Transaction=transaction), findById=Mock(side_effect=find))


class Tests(unittest.TestCase):
    def test_input_values_reach_read_only_verification(self):
        hub = HubUserInteraction('APQP', lambda event, **payload: hub.responses.put(dict(requestId=payload['interaction']['requestId'], action='continue', values={'choice': 'a'})) if event == 'interaction' else None)
        result = hub.wait('BUSINESS_INPUT', 'Review', '检查', lambda values: values['choice'], fields=[dict(id='choice', type='dropdown')])
        self.assertEqual(result, 'a')

    def test_failed_check_waits_then_resumes_once(self):
        events = []
        checks = []
        hub = HubUserInteraction('APQP', lambda event, **payload: emit(event, payload))
        hub.run_id = 'mock-run'
        def emit(event, payload):
            events.append(event)
            if event == 'interaction':
                hub.responses.put(dict(requestId=payload['interaction']['requestId'], action='continue'))
        def verify():
            checks.append(1)
            if len(checks) == 1: raise RuntimeError('still wrong')
            return 'verified'
        self.assertEqual(hub.wait('SIGN_IN', 'Login', '登录', verify), 'verified')
        self.assertEqual(events, ['interaction', 'recovering', 'interaction', 'recovering', 'interaction-resolved'])
        self.assertEqual(len(checks), 2)
        self.assertEqual(hub.active_request_id, '')

    def test_unknown_only_stops(self):
        def emit(event, **payload):
            self.assertEqual(payload['interaction']['allowedActions'], ['stop'])
            hub.stop_event.set()
        hub = HubUserInteraction('Source List', emit)
        with self.assertRaises(HubStopped): hub.wait('UNKNOWN', 'Unknown', '未知')

    def test_stale_run_or_request_ignored_by_stdin(self):
        hub = HubUserInteraction('APQP', Mock())
        hub.run_id = 'run'
        hub.active_request_id = 'current'
        lines = ['{"runId":"run","requestId":"old","action":"stop"}',
                 '{"runId":"old-run","requestId":"current","action":"stop"}',
                 '{"runId":"run","requestId":"current","action":"continue"}']
        with patch('sys.stdin', io.StringIO('\n'.join(lines))): hub.listen()
        self.assertFalse(hub.stop_event.is_set())
        self.assertEqual(hub.responses.qsize(), 1)
        with patch('sys.stdin', io.StringIO('cancel\n')): hub.listen()
        self.assertTrue(hub.stop_event.is_set())

    def test_stop_wins_during_verification(self):
        hub = HubUserInteraction('APQP', lambda event, **payload: hub.responses.put(dict(requestId=payload['interaction']['requestId'], action='continue')) if event == 'interaction' else None)
        def verify(): hub.stop_event.set()
        with self.assertRaises(HubStopped): hub.wait('SIGN_IN', 'Login', '登录', verify)

    def test_read_only_session_identity_guard(self):
        session = sap_session()
        identity = session_identity(session)
        verify_session(session, identity)
        session.Info.User = 'OTHER'
        with self.assertRaises(RuntimeError): verify_session(session, identity)
        session.Info.User = 'TEST-USER'
        session.Busy = True
        with self.assertRaises(RuntimeError): verify_session(session, identity)

    def test_session_detection_never_guesses_between_environments(self):
        app = SimpleNamespace(Children=Children([SimpleNamespace(Children=Children([sap_session('QA'), sap_session('PROD')]))]))
        with patch.object(me01.win32com.client, 'GetObject', return_value=SimpleNamespace(GetScriptingEngine=app)):
            with self.assertRaises(RuntimeError): me01.find_hub_session()

    def test_session_detection_does_not_hijack_another_transaction(self):
        busy_task = sap_session(transaction='VA01')
        idle = sap_session()
        app = SimpleNamespace(Children=Children([SimpleNamespace(Children=Children([busy_task, idle]))]))
        with patch.object(me01.win32com.client, 'GetObject', return_value=SimpleNamespace(GetScriptingEngine=app)):
            self.assertIs(me01.find_hub_session(), idle)
        self.assertEqual(busy_task.findById.call_count, 1)  # wnd[1] read, no text/click writes

    def test_source_supplier_recheck_checks_same_material_before_any_write(self):
        session = sap_session()
        fields = {
            'wnd[0]/usr/ctxtEORD-MATNR': SimpleNamespace(Text=''),
            'wnd[0]/usr/ctxtEORD-WERKS': SimpleNamespace(Text='', SetFocus=Mock()),
            'wnd[0]/usr/tblSAPLMEORTC_0205': SimpleNamespace(RowCount=2),
            'wnd[0]': SimpleNamespace(sendVKey=Mock()),
            'wnd[0]/tbar[0]/btn[11]': SimpleNamespace(Press=Mock()),
            'wnd[0]/sbar': SimpleNamespace(MessageType='', Text='')
        }
        session.findById = lambda name, *args: fields.get(name)
        apply = Mock()
        def pause(stage, issue, zh, verify, **context):
            fields['wnd[0]/usr/ctxtEORD-MATNR'].Text = 'WRONG'
            with self.assertRaises(RuntimeError): verify()
            apply.assert_not_called()
            fields['wnd[0]/usr/ctxtEORD-MATNR'].Text = '16808656'
            return verify()
        with patch.object(me01, 'HUB_INTERACTION', SimpleNamespace(wait=pause)), patch.object(me01, 'wait_ready'), patch.object(me01, 'locate_supplier_row', side_effect=[(-1, ['101']), (1, ['101', '41889'])]), patch.object(me01, 'apply_target_supplier', apply):
            me01.maintain_material(session, '16808656', '41889')
        apply.assert_called_once_with(session, 'wnd[0]/usr/tblSAPLMEORTC_0205', 1)
        fields['wnd[0]/tbar[0]/btn[11]'].Press.assert_called_once()

    def test_source_unknown_error_saves_and_never_starts_next_material(self):
        session = sap_session()
        results = SimpleNamespace(assignments={'a': {'material': '16808656', 'parma': '41889', 'rows': [2]}, 'b': {'material': 'NEXT', 'parma': '41889', 'rows': [3]}}, existing_statuses=Mock(return_value=set()), write=Mock(), save=Mock())
        hub = SimpleNamespace(start_listener=Mock(), stop_event=threading.Event(), wait=Mock(side_effect=HubStopped()))
        events = []
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'input.xlsx'
            path.write_bytes(b'mocked')
            with patch.dict(os.environ, {'EXCEL_PATH': str(path), 'HUB_RUN_ID': 'MOCK'}), patch.object(me01, 'WorkbookResults', return_value=results), patch.object(me01, 'HubUserInteraction', return_value=hub), patch.object(me01, 'find_hub_session', return_value=session), patch.object(me01, 'open_me01'), patch.object(me01, 'maintain_material', side_effect=RuntimeError('unknown')) as maintain, patch.object(me01, 'emit', side_effect=lambda event, **payload: events.append((event, payload))):
                self.assertEqual(me01.main(), 0)
            maintain.assert_called_once()
            self.assertGreaterEqual(results.save.call_count, 2)
            self.assertTrue(events[-1][1]['cancelled'])
            self.assertEqual(events[-1][1]['processed'], 1)
        me01.HUB_INTERACTION = None

    def test_apqp_unknown_query_stops_other_task_scheduling(self):
        tasks = queue.Queue()
        tasks.put(apqp.Task(2, '16808656', '41889'))
        tasks.put(apqp.Task(3, 'NEXT', '41889'))
        outputs = queue.Queue()
        session = sap_session()
        ref = apqp.SessionRef(0, 0, 'TEST', '100', 'TEST-USER', 'Test')
        result = apqp.Result(2, '16808656', '41889', 'ERROR', message='unknown')
        apqp.STOP_EVENT.clear()
        apqp.HUB_UNSAFE_EVENT.clear()
        try:
            with patch.object(apqp, 'HUB_MODE', True), patch.object(apqp, 'get_session_by_ref', return_value=session), patch.object(apqp, 'current_tcode', return_value=apqp.TCODE), patch.object(apqp, 'query_one', return_value=result) as query, patch.object(apqp, 'safe_print'):
                apqp.worker_loop(1, ref, tasks, outputs)
            query.assert_called_once()
            self.assertTrue(apqp.HUB_UNSAFE_EVENT.is_set())
            self.assertEqual(tasks.qsize(), 1)
            self.assertEqual(outputs.get().status, 'ERROR')
        finally:
            apqp.HUB_UNSAFE_EVENT.clear()


if __name__ == '__main__': unittest.main()
