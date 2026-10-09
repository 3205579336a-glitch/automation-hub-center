"""Read-only/mock acceptance and deterministic COM latency benchmark; no SAP access."""
import contextlib
import copy
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rfq_fixture', Path(__file__).with_name('test-rfq-integration.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
engine = fixture.engine
from rfq_interaction import InteractionController, HubCancelled, session_identity
from rfq_runtime_improvements import RuntimeImprovements, commodity_column, inspect_commodity, NPL_PROJECT_COLUMN


class Clock:
    def __init__(self): self.value = 0
    def now(self): return self.value
    def sleep(self, duration): self.value += duration


def task(material='111', row=2):
    return engine.MaterialTask(row, material, 'C100', 'P1', '2030-12-31', 'TECH', '120', '0', '25', False,
                              ['26517', '', '', '', ''], [False] * 5, '2030-12-31', [['a@example.com']] + [[]] * 4,
                              False, False, '', '')


class Grid:
    def __init__(self, tasks, clock=None):
        self.clock = clock or Clock()
        self.rows = [dict(MATNR=t.material, WERKS=t.plant, ZPSPID=t.project, ZCOMCODE='390101') for t in tasks]
        self.columns = ['MATNR', 'WERKS', 'ZPSPID', 'ZCOMCODE', engine.COL_TECH_USER, 'LIFNR1', engine.COL_AFM_REQUEST, 'LIFNR1_CB']
        self.calls = []
    @property
    def ColumnOrder(self):
        self.clock.sleep(.01)
        return self.columns
    @property
    def RowCount(self): return len(self.rows)
    def GetColumnTitles(self, column): return ['Commodity'] if column == 'ZCOMCODE' else [column]
    def GetColumnTooltip(self, column): return self.GetColumnTitles(column)[0]
    def GetCellValue(self, row, column):
        self.clock.sleep(.002)
        return self.rows[row].get(column, '')
    def ModifyCell(self, row, column, value):
        self.clock.sleep(.004); self.rows[row][column] = value; self.calls.append(('write', row, column, value))
    def ModifyCheckBox(self, row, column, value):
        self.clock.sleep(.004); self.rows[row][column] = value; self.calls.append(('checkbox', row, column, value))
    def TriggerModified(self): self.clock.sleep(.006); self.calls.append(('trigger',))
    def PressEnter(self): self.clock.sleep(.007); self.calls.append(('enter',))


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.column_env = patch.dict(os.environ, RFQ_COMMODITY_COLUMN='')
        self.column_env.start()
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.args = SimpleNamespace(control_dir=str(Path(self.temp.name) / 'interaction'), stop_file=str(Path(self.temp.name) / 'stop'), run_id='mock-run')
        self.events, self.states, self.originals = [], [], []
        self.cancelled = False
        self.replies = None
        def emit(kind, **data):
            self.events.append((kind, data))
            if self.replies: self.replies(kind, data)
        self.emit = emit
        self.controller = InteractionController(self.args, emit, lambda tasks, state, stage, issue: self.states.append(state), lambda stage: setattr(self, 'cancelled', True))
        self.runtime = RuntimeImprovements(engine, emit, self.controller, self.replace, self.clock.now, self.clock.sleep)
        self.runtime.hard_seconds = .5
        self.runtime.poll_seconds = .05
        self.tasks = [task()]
        self.runtime.tasks = self.tasks
        self.sap = engine.SapSession.__new__(engine.SapSession)
        self.sap.session = SimpleNamespace(Id='/app/con[0]/ses[0]', Info=SimpleNamespace(SystemName='VCE', Client='100', User='MOCK_USER'), Busy=False)
        self.sap.exists = lambda identifier: False
        self.sap.status_bar = lambda: ('S', '')
        self.grid = Grid(self.tasks)
        self.sap.find = lambda identifier, **kwargs: SimpleNamespace(Text='New Part List : Display') if identifier == 'wnd[0]' else self.grid

    def replace(self, obj, name, value):
        self.originals.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def tearDown(self):
        for obj, name, value in reversed(self.originals): setattr(obj, name, value)
        self.temp.cleanup()
        self.column_env.stop()

    def reply(self, data, action='continue'):
        directory = Path(self.args.control_dir)
        directory.mkdir(exist_ok=True)
        (directory / (data['requestId'] + '.json')).write_text(json.dumps(dict(runId=self.args.run_id, requestId=data['requestId'], action=action)), encoding='utf-8')

    def test_normal_response_no_warning(self):
        self.assertEqual(self.runtime.wait(self.sap, lambda: True, .2, 'test'), True)
        self.assertEqual(self.events, [])

    def test_slow_recovered_no_user_action(self):
        result = self.runtime.wait(self.sap, lambda: True if self.clock.value >= .3 else None, .1, 'test')
        self.assertTrue(result)
        self.assertIn('SAP_SLOW', [e[0] for e in self.events])
        self.assertEqual(self.events[-1][0], 'SAP_RECOVERED')
        self.assertEqual(self.states, [])

    def test_hard_timeout_recheck_then_resume_without_action_replay(self):
        self.replies = lambda kind, data: self.reply(data) if kind == 'ACTION_REQUIRED' else None
        self.assertTrue(self.runtime.wait(self.sap, lambda: None, .1, 'expected NPL', verify=lambda: True))
        self.assertIn('WAITING_FOR_USER', self.states)
        self.assertEqual(self.states[-1], 'RUNNING')

    def test_unknown_state_stop_only(self):
        def respond(kind, data):
            if kind == 'ACTION_REQUIRED':
                self.assertEqual(data['allowedActions'], ['stop'])
                self.reply(data, 'stop')
        self.replies = respond
        with self.assertRaises(HubCancelled): self.runtime.wait(self.sap, lambda: None, .1, 'unknown post-save screen')
        self.assertTrue(self.cancelled)

    def test_stop_after_create_preserves_graceful_commit_writeback_boundary(self):
        Path(self.args.stop_file).touch()
        self.runtime.phase = 'Creating RFQ'
        self.assertTrue(self.runtime.wait(self.sap, lambda: True if self.clock.value >= .3 else None, .1, 'pending commit'))
        self.assertFalse(self.cancelled)
        self.runtime.phase = 'NPL'
        with self.assertRaises(HubCancelled): self.runtime.stopped()

    def test_npl_hard_recheck_verifies_same_session_and_expected_grid(self):
        self.runtime.install()
        ready = False
        self.sap.find = lambda identifier, **kw: SimpleNamespace(Text='New Part List : Display') if identifier == 'wnd[0]' else self.grid if ready else None
        def respond(kind, data):
            nonlocal ready
            if kind == 'ACTION_REQUIRED':
                ready = True
                self.reply(data)
        self.replies = respond
        self.assertIs(self.sap.wait_grid_columns(engine.ID_GRID_CUSTOMER1, ['MATNR'], timeout=.1), self.grid)
        self.assertEqual(self.states[-1], 'RUNNING')

    def test_green_verification_is_profiled_without_changing_its_result(self):
        self.runtime.install()
        self.grid.rows[0][engine.COL_STATUS_ICON] = '@5B@'
        self.assertTrue(engine.green_status_debug(self.sap, self.grid, 0)[0])
        self.assertEqual(self.runtime.step_profile['postWriteVerification']['calls'], 1)

    def test_npl_hard_recheck_rejects_unknown_screen(self):
        self.runtime.install()
        self.sap.find = lambda identifier, **kw: SimpleNamespace(Text='SAP Easy Access') if identifier == 'wnd[0]' else None
        checks = 0
        def respond(kind, data):
            nonlocal checks
            if kind == 'ACTION_REQUIRED':
                checks += 1; self.reply(data, 'continue' if checks == 1 else 'stop')
        self.replies = respond
        with self.assertRaises(HubCancelled): self.sap.wait_grid_columns(engine.ID_GRID_CUSTOMER1, ['MATNR'], timeout=.1)
        self.assertEqual(checks, 2)
        self.assertNotIn('RUNNING', self.states)

    def test_known_popup_keeps_existing_recovery_signal(self):
        self.runtime.install()
        self.sap.find = lambda *a, **kw: None
        self.sap.exists = lambda identifier: identifier == 'wnd[1]'
        self.sap.window_text = lambda identifier: 'Existing RFQ business popup'
        with self.assertRaises(engine.SapRpaError) as caught: self.sap.wait_grid_columns(engine.ID_GRID_CUSTOMER1, ['MATNR'])
        self.assertEqual(caught.exception.stage, 'SAP_POPUP')
        self.assertEqual(self.states, [])

    def test_busy_read_error_never_counts_as_ready(self):
        self.runtime.install()
        class Broken:
            @property
            def Busy(self): raise RuntimeError('COM disconnected')
        self.sap.session = Broken()
        self.replies = lambda kind, data: self.reply(data, 'stop') if kind == 'ACTION_REQUIRED' else None
        with self.assertRaises(HubCancelled): self.sap.wait_not_busy(timeout=.1)

    def test_commodity_present_no_interruption(self):
        group = engine.TaskGroup('test', self.tasks)
        self.assertIs(self.runtime.commodity(self.sap, group, self.grid, self.tasks), self.grid)
        self.assertEqual(self.states, [])
        self.assertEqual(commodity_column(self.grid), 'ZCOMCODE')
        self.assertEqual(self.events[-1][1]['commodityColumn'], 'ZCOMCODE')

    def test_recorded_column_does_not_depend_on_translated_or_ambiguous_titles(self):
        self.grid.columns.append('OTHER_COMMODITY')
        self.grid.GetColumnTitles = lambda column: ['Commodity']
        self.assertEqual(commodity_column(self.grid), 'ZCOMCODE')
        self.grid.GetColumnTitles = lambda column: (_ for _ in ()).throw(RuntimeError('Title unavailable'))
        self.grid.GetColumnTooltip = self.grid.GetColumnTitles
        self.assertEqual(inspect_commodity(engine, self.sap, self.grid, self.tasks), ('ZCOMCODE', []))

    def test_missing_recorded_column_cannot_create_buyer_or_fall_back_to_a_title(self):
        calls = []
        self.replace(engine, 'create_buyer_receipt_skipping_existing_rfq', lambda *a: calls.append('CREATE'))
        self.runtime.install()
        self.grid.columns.remove('ZCOMCODE')
        self.grid.columns.append('OTHER_COMMODITY')
        self.grid.GetColumnTitles = lambda column: ['Commodity']
        self.grid.GetColumnTooltip = lambda column: 'Commodity'
        self.replies = lambda kind, data: self.reply(data, 'stop') if kind == 'ACTION_REQUIRED' else None
        with self.assertRaises(HubCancelled): engine.create_buyer_receipt_skipping_existing_rfq(self.sap, None, engine.TaskGroup('test', self.tasks), self.grid, self.tasks)
        self.assertEqual(calls, [])
        prompt = next(data for kind, data in self.events if kind == 'ACTION_REQUIRED')
        self.assertIn('ZCOMCODE', prompt['message'])
        self.assertEqual(prompt['recoveryPoint'], 'NPL_READ_FAILED')
        self.assertNotIn('open-fix-session', prompt['allowedActions'])

    def test_unreadable_recorded_value_cannot_create_buyer(self):
        calls = []
        self.replace(engine, 'create_buyer_receipt_skipping_existing_rfq', lambda *a: calls.append('CREATE'))
        self.runtime.install()
        original_read = self.grid.GetCellValue
        def read(row, column):
            if column == 'ZCOMCODE': raise RuntimeError('COM read failed')
            return original_read(row, column)
        self.grid.GetCellValue = read
        self.replies = lambda kind, data: self.reply(data, 'stop') if kind == 'ACTION_REQUIRED' else None
        with self.assertRaises(HubCancelled): engine.create_buyer_receipt_skipping_existing_rfq(self.sap, None, engine.TaskGroup('test', self.tasks), self.grid, self.tasks)
        self.assertEqual(calls, [])
        prompt = next(data for kind, data in self.events if kind == 'ACTION_REQUIRED')
        self.assertEqual(prompt['recoveryPoint'], 'NPL_READ_FAILED')
        self.assertIn('field ZCOMCODE', prompt['message'])
        self.assertIn('SAP row 1', prompt['message'])
        self.assertNotIn('COMMODITY_MISSING', [kind for kind, _ in self.events])

    def test_reported_three_materials_use_real_npl_project_and_commodity_columns(self):
        tasks = [task('53762733'), task('11145413', 21), task('11418052', 22)]
        for item in tasks: item.project = '775773'
        grid = Grid([tasks[1], tasks[2], tasks[0]])
        for row in grid.rows: row['ZCOMCODE'] = '430300'
        reads = []
        def strict_read(row, column):
            reads.append(column)
            if column not in grid.columns: raise ValueError('E_INVALIDARG 0x80070057')
            return grid.rows[row].get(column, '')
        grid.GetCellValue = strict_read
        calls = []
        self.replace(engine, 'create_buyer_receipt_skipping_existing_rfq', lambda *a: calls.append('CREATE'))
        self.runtime.install()
        original_mapping = self.sap.map_material_rows
        group = engine.TaskGroup('reported', tasks)
        matched, failed = engine.match_exact_npl_rows(self.sap, grid, group)
        self.assertEqual(failed, [])
        self.assertEqual([item.npl_row for item in matched], [2, 0, 1])
        self.assertEqual(self.sap.map_material_rows, original_mapping)
        engine.create_buyer_receipt_skipping_existing_rfq(self.sap, None, group, grid, matched)
        self.assertEqual(calls, ['CREATE'])  # Mock only: never call real SAP Create.
        self.assertNotIn('MPPPSPID', reads)
        self.assertIn('ZPSPID', reads)
        self.assertEqual(engine.COL_PROJECT_NPL, 'MPPPSPID')
        self.assertEqual(self.states, [])

    def test_npl_exact_match_rejects_wrong_project_without_changing_other_screen_mapping(self):
        self.runtime.install()
        self.grid.rows[0]['ZPSPID'] = 'WRONG'
        matched, failed = engine.match_exact_npl_rows(self.sap, self.grid, engine.TaskGroup('test', self.tasks))
        self.assertEqual(matched, [])
        self.assertEqual(len(failed), 1)
        self.grid.rows[0]['MPPPSPID'] = 'BUYER_PROJECT'
        _, rows = self.sap.map_material_rows(self.grid, self.tasks, project_column=engine.COL_PROJECT_NPL)
        self.assertEqual(rows[0]['project'], 'BUYER_PROJECT')

    def test_npl_field_read_failure_and_wrong_project_are_not_missing_commodity(self):
        original_read = self.grid.GetCellValue
        for field in ('MATNR', 'WERKS', NPL_PROJECT_COLUMN):
            with self.subTest(field=field):
                def read(row, column):
                    if column == field: raise ValueError('E_INVALIDARG')
                    return original_read(row, column)
                self.grid.GetCellValue = read
                with self.assertRaisesRegex(ValueError, 'field ' + field):
                    inspect_commodity(engine, self.sap, self.grid, self.tasks)
        self.grid.GetCellValue = original_read
        self.grid.rows[0]['ZPSPID'] = 'WRONG'
        with self.assertRaisesRegex(ValueError, 'Plant/Project mismatch'):
            inspect_commodity(engine, self.sap, self.grid, self.tasks)

    def test_unexpected_commodity_type_is_a_read_failure(self):
        self.grid.rows[0]['ZCOMCODE'] = SimpleNamespace()
        with self.assertRaisesRegex(ValueError, 'unexpected value type'):
            inspect_commodity(engine, self.sap, self.grid, self.tasks)

    def test_read_failure_rechecks_fresh_npl_then_allows_create(self):
        calls = []
        self.replace(engine, 'create_buyer_receipt_skipping_existing_rfq', lambda *a: calls.append('CREATE'))
        self.runtime.install()
        self.grid.columns.remove('ZPSPID')
        fresh = Grid(self.tasks)
        self.sap.prepare_npl_grid_for_group = lambda group: fresh
        def respond(kind, data):
            if kind == 'ACTION_REQUIRED':
                self.assertEqual(calls, [])
                self.assertEqual(data['recoveryPoint'], 'NPL_READ_FAILED')
                self.assertEqual(data['allowedActions'], ['continue', 'stop'])
                self.reply(data)
        self.replies = respond
        engine.create_buyer_receipt_skipping_existing_rfq(self.sap, None, engine.TaskGroup('test', self.tasks), self.grid, self.tasks)
        self.assertEqual(calls, ['CREATE'])
        self.assertEqual(self.states[-1], 'RUNNING')

    def test_recheck_updates_reason_both_directions_without_unlocking(self):
        self.runtime.install()
        for initial in ('NPL_READ_FAILED', 'COMMODITY_MISSING'):
            with self.subTest(initial=initial):
                self.events.clear(); self.states.clear()
                grid = Grid(self.tasks)
                fresh = Grid(self.tasks)
                if initial == 'NPL_READ_FAILED':
                    grid.columns.remove('ZCOMCODE')
                    fresh.rows[0]['ZCOMCODE'] = ''
                    expected = 'COMMODITY_MISSING'
                else:
                    grid.rows[0]['ZCOMCODE'] = ''
                    fresh.columns.remove('ZPSPID')
                    expected = 'NPL_READ_FAILED'
                self.sap.prepare_npl_grid_for_group = lambda group: fresh
                prompts = []
                def respond(kind, data):
                    if kind == 'ACTION_REQUIRED':
                        prompts.append(data)
                        self.assertEqual(data['recoveryPoint'], initial if len(prompts) == 1 else expected)
                        self.assertEqual(data['step'], data['recoveryPoint'])
                        self.assertNotIn('RUNNING', self.states)
                        self.assertEqual('open-fix-session' in data['allowedActions'], data['recoveryPoint'] == 'COMMODITY_MISSING')
                        self.reply(data, 'continue' if len(prompts) == 1 else 'stop')
                self.replies = respond
                with self.assertRaises(HubCancelled):
                    self.runtime.commodity(self.sap, engine.TaskGroup('test', self.tasks), grid, self.tasks)
                self.assertEqual(len(prompts), 2)
                self.assertNotEqual(prompts[0]['requestId'], prompts[1]['requestId'])
                checkpoint = json.loads((Path(self.args.control_dir) / 'checkpoint.json').read_text(encoding='utf-8'))
                self.assertEqual(checkpoint['recoveryPoint'], expected)

    def test_open_fix_action_cannot_bypass_read_failure_allowed_actions(self):
        self.grid.columns.remove('ZCOMCODE')
        calls = []
        self.runtime.open_fix = lambda *a: calls.append('OPEN')
        def respond(kind, data):
            if kind == 'ACTION_REQUIRED': self.reply(data, 'open-fix-session')
        self.replies = respond
        def stop_after_rejected_action(duration):
            Path(self.args.stop_file).touch()
        with patch('rfq_interaction.time.sleep', stop_after_rejected_action):
            with self.assertRaises(HubCancelled):
                self.runtime.commodity(self.sap, engine.TaskGroup('test', self.tasks), self.grid, self.tasks)
        self.assertEqual(calls, [])

    def test_npl_mapping_hook_restores_instance_on_error(self):
        self.replace(engine, 'match_exact_npl_rows', lambda *a: (_ for _ in ()).throw(ValueError('mapping failed')))
        self.runtime.install()
        original_mapping = self.sap.map_material_rows
        with self.assertRaisesRegex(ValueError, 'mapping failed'):
            engine.match_exact_npl_rows(self.sap, self.grid, engine.TaskGroup('test', self.tasks))
        self.assertEqual(self.sap.map_material_rows, original_mapping)

    def test_failed_recheck_does_not_restore_consumed_open_fix_action(self):
        self.grid.rows[0]['ZCOMCODE'] = ''
        self.sap.prepare_npl_grid_for_group = lambda group: self.grid
        calls, prompts = [], []
        self.runtime.open_fix = lambda *a: calls.append('OPEN') or 'Manual correction session ready: MOCK'
        def respond(kind, data):
            if kind == 'ACTION_REQUIRED':
                prompts.append(data)
                if len(prompts) == 1:
                    self.reply(data, 'open-fix-session')
                else:
                    self.assertNotIn('open-fix-session', data['allowedActions'])
                    self.reply(data, 'stop')
            elif kind == 'FIX_SESSION_RESULT': self.reply(data)
        self.replies = respond
        with self.assertRaises(HubCancelled):
            self.runtime.commodity(self.sap, engine.TaskGroup('test', self.tasks), self.grid, self.tasks)
        self.assertEqual(calls, ['OPEN'])
        self.assertNotIn('RUNNING', self.states)

    def test_internal_override_requires_an_existing_explicit_column(self):
        self.grid.columns.append('QA_COMMODITY')
        with patch.dict(os.environ, RFQ_COMMODITY_COLUMN=' QA_COMMODITY '):
            self.assertEqual(commodity_column(self.grid), 'QA_COMMODITY')
        with patch.dict(os.environ, RFQ_COMMODITY_COLUMN='MISSING_FIELD'):
            with self.assertRaisesRegex(ValueError, 'MISSING_FIELD'): commodity_column(self.grid)

    def test_missing_commodity_consolidates_requeries_and_rechecks(self):
        self.tasks = [task('111'), task('222', 3)]
        self.grid = Grid(self.tasks)
        for row in self.grid.rows: row['ZCOMCODE'] = '  '
        fresh = Grid(self.tasks)
        for row in fresh.rows: row['ZCOMCODE'] = ''
        query_count = 0
        def query(group):
            nonlocal query_count
            query_count += 1
            if query_count == 2:
                for row in fresh.rows: row['ZCOMCODE'] = 'Meaningful non-numeric code'
            return fresh
        self.sap.prepare_npl_grid_for_group = query
        prompts = []
        self.replies = lambda kind, data: (prompts.append(data), self.reply(data)) if kind == 'ACTION_REQUIRED' else None
        result = self.runtime.commodity(self.sap, engine.TaskGroup('test', self.tasks), self.grid, self.tasks)
        self.assertIs(result, fresh)
        self.assertEqual(query_count, 2)
        self.assertEqual(prompts[0]['materials'], ['111', '222'])
        self.assertEqual(len(prompts), 2)
        self.assertIn('COMMODITY_RECHECK_FAILED', [e[0] for e in self.events])
        self.assertEqual(self.states[-1], 'RUNNING')

    def test_missing_commodity_no_buyer_receipt_before_stop(self):
        calls = []
        self.replace(engine, 'create_buyer_receipt_skipping_existing_rfq', lambda *a: calls.append('CREATE'))
        self.runtime.install()
        self.grid.rows[0]['ZCOMCODE'] = None
        self.replies = lambda kind, data: self.reply(data, 'stop') if kind == 'ACTION_REQUIRED' else None
        with self.assertRaises(HubCancelled): engine.create_buyer_receipt_skipping_existing_rfq(self.sap, None, engine.TaskGroup('test', self.tasks), self.grid, self.tasks)
        self.assertEqual(calls, [])

    def test_unverified_or_subcommodity_column_is_not_accepted(self):
        self.grid.columns = ['SUB_COMMODITY']
        self.grid.GetColumnTitles = lambda column: ['Sub Commodity']
        self.grid.GetColumnTooltip = lambda column: 'Sub Commodity'
        with self.assertRaises(ValueError): commodity_column(self.grid)
        self.grid.columns = ['X', 'Y']
        self.grid.GetColumnTitles = lambda column: ['Commodity']
        with self.assertRaises(ValueError): commodity_column(self.grid)

    def test_secondary_session_unavailable_does_not_end_pause(self):
        self.grid.rows[0]['ZCOMCODE'] = ''
        fresh = Grid(self.tasks)
        self.sap.prepare_npl_grid_for_group = lambda group: fresh
        def unavailable(*a): raise ValueError('Session limit')
        self.runtime.open_fix = unavailable
        def respond(kind, data):
            if kind == 'ACTION_REQUIRED': self.reply(data, 'open-fix-session')
            if kind == 'FIX_SESSION_RESULT':
                self.assertEqual(self.controller.state, 'WAITING_FOR_USER')
                self.assertNotIn('open-fix-session', data['allowedActions'])
                self.reply(data)
        self.replies = respond
        self.assertIs(self.runtime.commodity(self.sap, engine.TaskGroup('test', self.tasks), self.grid, self.tasks), fresh)
        self.assertEqual(self.states[-1], 'RUNNING')

    def test_secondary_session_same_identity_no_new_connection_or_navigation(self):
        sessions = [self.sap.session]
        class Children:
            @property
            def Count(self): return len(sessions)
            def __call__(self, index): return sessions[index]
        self.sap.session.Parent = SimpleNamespace(Children=Children())
        self.sap.session.CreateSession = lambda: sessions.append(SimpleNamespace(Id='/app/con[0]/ses[1]', Busy=False, Info=self.sap.session.Info))
        message = self.runtime.open_fix(self.sap, session_identity(self.sap))
        self.assertIn('/ses[1]', message)
        self.assertEqual(self.sap.session.Id, '/app/con[0]/ses[0]')

    def test_sequential_values_and_measured_schema_cache_benchmark(self):
        measurements = []
        for writer, label in [(engine.fill_buyer_receipt_rows, 'Buyer Receipt'), (engine.fill_rfq_grid_rows, 'RFQ')]:
            outputs = []
            for cache in ('false', 'true'):
                clock = Clock()
                tasks = [task(str(1000 + index), index + 2) for index in range(50)]
                grid = Grid(tasks, clock)
                self.sap.session.Busy = False
                original_clock = self.runtime.clock
                self.runtime.clock = clock.now
                with patch.dict(os.environ, RFQ_SCHEMA_CACHE_ENABLED=cache), contextlib.redirect_stdout(io.StringIO()):
                    result = self.runtime.writer(writer, label)(self.sap, grid, tasks)
                self.runtime.clock = original_clock
                self.assertEqual(len(result), 50)
                outputs.append((copy.deepcopy(grid.rows), grid.calls, clock.value, self.events[-1][1]['profile']))
            self.assertEqual(outputs[0][0:2], outputs[1][0:2], 'Writes, checkbox state, TriggerModified and Enter order must remain identical')
            self.assertLess(outputs[1][2], outputs[0][2])
            self.assertLess(outputs[1][3]['columnMetadata']['calls'], outputs[0][3]['columnMetadata']['calls'])
            measurements.append(dict(step=label, rows=50, baselineSeconds=round(outputs[0][2], 3), optimizedSeconds=round(outputs[1][2], 3),
                                     baselineMetadataCalls=outputs[0][3]['columnMetadata']['calls'], optimizedMetadataCalls=outputs[1][3]['columnMetadata']['calls']))
        print('MOCK_BENCHMARK:' + json.dumps(measurements))


if __name__ == '__main__': unittest.main(argv=[__file__], verbosity=2)
