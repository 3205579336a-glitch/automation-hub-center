"""Pause protocol and native adapters: all SAP/Excel objects mocked."""
import importlib.util
import io
import os
import sys
import json
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
    finder = Mock(side_effect=find)
    return SimpleNamespace(Id='mock-session', Busy=False,
        Info=SimpleNamespace(SystemName=system, Client='100', User=user, Transaction=transaction), findById=finder, FindById=finder)


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

    def test_classified_recheck_updates_visible_reason_and_keeps_technical_details(self):
        requests, checks = [], []
        hub = HubUserInteraction('APQP', lambda event, **payload: emit(event, payload))
        def emit(event, payload):
            if event == 'interaction':
                requests.append(payload['interaction'])
                hub.responses.put(dict(requestId=payload['interaction']['requestId'], action='continue'))
        def verify():
            checks.append(1)
            if len(checks) == 1:
                raise apqp.SapSessionCheckError('SAP_SESSION_BUSY', 'SAP is busy', 'SAP 仍在处理中', 'COM diagnostic')
            return 'verified'
        self.assertEqual(hub.wait('SIGN_IN', 'Sign in', '请登录', verify, detail='Initial diagnostic'), 'verified')
        self.assertEqual(requests[0]['message'], 'Initial diagnostic')
        self.assertEqual(requests[1]['issueSummary'], 'SAP is busy')
        self.assertEqual(requests[1]['issueSummaryZh'], 'SAP 仍在处理中')
        self.assertIn('COM diagnostic', requests[1]['message'])
        self.assertTrue(requests[1]['message'].startswith('The issue is still present.'))

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
        app = SimpleNamespace(Children=Children([SimpleNamespace(Description='VCE - One Digital Core [949]', Children=Children([sap_session('QA'), sap_session('PROD')]))]))
        with patch.object(me01.win32com.client, 'GetObject', return_value=SimpleNamespace(GetScriptingEngine=app)):
            with self.assertRaises(RuntimeError): me01.find_hub_session()

    def test_session_detection_does_not_hijack_another_transaction(self):
        busy_task = sap_session(system='VCE', transaction='VA01')
        idle = sap_session(system='VCE')
        app = SimpleNamespace(Children=Children([SimpleNamespace(Description='VCE - One Digital Core [949]', Children=Children([busy_task, idle]))]))
        with patch.object(me01.win32com.client, 'GetObject', return_value=SimpleNamespace(GetScriptingEngine=app)):
            self.assertIs(me01.find_hub_session(), idle)
        self.assertEqual(busy_task.findById.call_count, 2)  # Only wnd[0]/wnd[1] reads, no navigation/writes.


    def test_source_unknown_error_saves_and_never_starts_next_material(self):
        session = sap_session()
        results = SimpleNamespace(mode='excel-com', assignments={'a': {'material': '16808656', 'parma': '41889', 'dualSourcing': False, 'rows': [2]}, 'b': {'material': 'NEXT', 'parma': '41889', 'dualSourcing': True, 'rows': [3]}}, existing_statuses=Mock(return_value={'SUCCESS'}), write=Mock(), save=Mock())
        hub = SimpleNamespace(start_listener=Mock(), stop_event=threading.Event(), wait=Mock(side_effect=HubStopped()))
        events = []
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'input.xlsx'
            path.write_bytes(b'mocked')
            with patch.dict(os.environ, {'EXCEL_PATH': str(path), 'HUB_RUN_ID': 'MOCK', 'HUB_ARTIFACT_DIR':folder, 'ME01_VALID_FROM':'2026-10-12', 'ME01_VALID_TO':'2099-12-31', 'ME01_PURCH_ORG':'C100'}), patch.object(me01, 'WorkbookResults', return_value=results), patch.object(me01, 'HubUserInteraction', return_value=hub), patch.object(me01, 'find_hub_session', return_value=session), patch.object(me01, 'open_me01'), patch.object(me01, 'maintain_material', side_effect=RuntimeError('unknown')) as maintain, patch.object(me01, 'emit', side_effect=lambda event, **payload: events.append((event, payload))):
                self.assertEqual(me01.main(), 0)
            maintain.assert_called_once()
            maintain.assert_called_once()
            self.assertEqual(maintain.call_args.args[:7], (session, '16808656', '41889', False, '2026-10-12','2099-12-31','C100'))
            self.assertEqual(maintain.call_args.args[7]['material'], '16808656')
            self.assertEqual(maintain.call_args.args[7]['outcome'], 'failed')
            self.assertIn('unknown', hub.wait.call_args.kwargs['detail'])
            self.assertEqual(hub.wait.call_args.kwargs['rows'], [2])
            self.assertTrue((Path(folder) / 'me01-errors.log').exists())
            diagnostics = [json.loads(line) for line in (Path(folder)/'me01-performance.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(diagnostics[0]['phase'],'startup')
            self.assertEqual(diagnostics[0]['workbookMode'],'excel-com')
            self.assertEqual(diagnostics[0]['recordCount'],2)
            self.assertGreaterEqual(diagnostics[0]['engineReadySeconds'],0)
            self.assertEqual(diagnostics[-1]['outcome'],'failed')
            results.existing_statuses.assert_not_called()
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
