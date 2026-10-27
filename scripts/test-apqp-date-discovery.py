"""APQP date POC regression tests. All SAP objects are fake; no real SAP access."""
import contextlib
from datetime import date, datetime
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'resources/rpa'))
sys.path.insert(0, str(ROOT / 'scripts'))
import apqp_plan_closure as legacy
from apqp_dates import ApqpDateIssue, DATE_FIELDS, ID_OWNER, ID_PROJECT, compare_dates, date_value, fingerprint
from apqp_date_discovery import ApqpDiscovery, collection_values

spec = importlib.util.spec_from_file_location('date_poc_cli', ROOT / 'scripts/inspect-apqp-dates.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class Children:
    def __init__(self, values): self.values = values
    @property
    def Count(self): return len(self.values)
    def __call__(self, index): return self.values[index]


class DateControl:
    def __init__(self, text): self.text = text
    @property
    def Text(self): return self.text
    @Text.setter
    def Text(self, value): raise AssertionError('POC must NEVER assign SAP dates')
    Changeable = True


class Grid:
    def __init__(self, rows):
        self.rows = rows
        self.ColumnOrder = ['FIELD_ALPHA', 'FIELD_BETA', 'FIELD_GAMMA']
        self.selected = ''
        self._first_visible, self.VisibleRowCount = 0, 30
        self.page_moves, self.on_scroll = [], None
        self.virtualized = False
        self.on_select = self.on_read = None
    @property
    def RowCount(self): return len(self.rows)
    @property
    def FirstVisibleRow(self): return self._first_visible
    @FirstVisibleRow.setter
    def FirstVisibleRow(self, value):
        self.page_moves.append(value)
        self._first_visible = value
        if self.on_scroll: self.on_scroll()
    @property
    def SelectedRows(self): return self.selected
    @SelectedRows.setter
    def SelectedRows(self, value):
        self.selected = value
        if self.on_select: self.on_select()
    def GetColumnTitles(self, column): return ['Observed title ' + column]
    def GetCellValue(self, row, column):
        if self.on_read: self.on_read()
        if self.virtualized and not self.FirstVisibleRow <= row < self.FirstVisibleRow + self.VisibleRowCount:
            return ''
        return self.rows[row][self.ColumnOrder.index(column)]


class Session:
    def __init__(self, state='grid', rows=None, system='VCE', user='MOCK_SAP_LOGIN'):
        self.Id = '/app/con[0]/ses[0]'
        self.Info = SimpleNamespace(SystemName=system, Client='100', User=user,
                                    Transaction='SESSION_MANAGER' if state == 'home' else legacy.TCODE)
        self.state, self.Busy, self.popup = state, False, False
        self.grid = Grid(rows if rows is not None else [['A01', '111', '001'], ['A02', '222', '002']])
        self.filters = {legacy.ID_PLANT: SimpleNamespace(Text=''), ID_PROJECT: SimpleNamespace(Text=''),
                        ID_OWNER: SimpleNamespace(Text=''), legacy.ID_MATERIAL: SimpleNamespace(Text=''),
                        legacy.ID_VENDOR: SimpleNamespace(Text=''), legacy.ID_CHECK_C3: SimpleNamespace(Selected=False)}
        self.dates = {field.control_id: DateControl('20.10.2026') for field in DATE_FIELDS}
        self.calls = []
        self.after_query_error = False
        self.start_error = False
        self.FindById = Mock(side_effect=self.find)
        self.StartTransaction = Mock(side_effect=self.start)

    def start(self, transaction):
        self.calls.append(('navigate', transaction))
        if self.start_error: raise RuntimeError('Ambiguous navigation')
        self.Info.Transaction, self.state = transaction, 'selection'

    def execute(self):
        self.calls.append(('execute', self.state))
        if self.state == 'selection':
            self.state = 'grid'
            if self.after_query_error: raise RuntimeError('COM error after query')
        elif self.state == 'grid': self.state = 'detail'
        else: raise AssertionError('Execute on an unrecognized screen')

    def find(self, identifier, required=True):
        control = None
        if identifier == 'wnd[0]': control = SimpleNamespace(Text='Mock APQP')
        elif identifier == 'wnd[1]': control = SimpleNamespace(Text='Unknown question') if self.popup else None
        elif identifier == legacy.ID_EXECUTE: control = SimpleNamespace(Press=self.execute)
        elif self.state == 'selection': control = self.filters.get(identifier)
        elif self.state == 'grid' and identifier == legacy.ID_RESULT_GRID: control = self.grid
        elif self.state == 'detail': control = self.dates.get(identifier)
        if identifier == 'wnd[0]/tbar[0]/btn[11]': raise AssertionError('Save is forbidden in this POC')
        if control is None and required: raise RuntimeError('Control missing: ' + identifier)
        return control


def application(*sessions):
    label = 'VCE - One Digital Core [949]' if sessions[0].Info.SystemName == 'VCE' else 'CEQ - One Digital Core - QA [321]'
    return SimpleNamespace(Children=Children([SimpleNamespace(Description=label, Children=Children(list(sessions)))]))


class DateDomainTests(unittest.TestCase):
    def test_only_recorded_four_control_ids_and_temporary_labels(self):
        self.assertEqual([field.technical_name for field in DATE_FIELDS],
                         ['GS_ITAB-F_PLNDAT', 'GS_ITAB-G_PLNDAT', 'GS_ITAB-H_PLNDAT', 'GS_ITAB-M_PLNDAT'])
        for field in DATE_FIELDS:
            self.assertIn('/ssubSUB1:ZMFM050035_N:0901/ctxtGS_ITAB-', field.control_id)

    def test_dates_keep_day_without_timezone_conversion(self):
        for value in ('2026-10-20', '20.10.2026', '20. 10. 2026', '20261020', date(2026, 10, 20), datetime(2026, 10, 20)):
            self.assertEqual(date_value(value), '2026-10-20')
        self.assertEqual(date_value('10/20/2026'), '2026-10-20')
        self.assertIsNone(date_value('  '))

    def test_invalid_ambiguous_and_untyped_excel_dates_do_not_become_blanks(self):
        for value in ('30.02.2026', '10/11/2026', 'CLEAR', 46000, True, object()):
            with self.subTest(value=type(value).__name__), self.assertRaises(ValueError): date_value(value)

    def dates(self, value): return {field.key: value for field in DATE_FIELDS}

    def test_change_only_and_already_applied_retry_require_no_blind_save(self):
        original = self.dates('2026-10-20')
        desired = dict(original, fPlanDate='2026-10-25', mPlanDate='2026-10-26')
        plan = compare_dates(original, original, desired)
        self.assertEqual([field['field'] for field in plan['changes']], ['fPlanDate', 'mPlanDate'])
        self.assertFalse(plan['writesEnabled'])
        retry = compare_dates(original, desired, desired)
        self.assertEqual(retry['status'], 'NO_CHANGE')
        self.assertEqual(retry['changes'], [])
        self.assertEqual(sum(field['status'] == 'ALREADY_APPLIED' for field in retry['fields']), 2)

    def test_conflict_blocks_entire_record_proposal(self):
        original = self.dates('2026-10-20')
        result = compare_dates(original, dict(original, fPlanDate='2026-10-22'), dict(original, fPlanDate='2026-10-25'))
        self.assertEqual(result['status'], 'CONFLICT')
        self.assertEqual(result['changes'], [])

    def test_unedited_fields_preserve_newer_sap_values(self):
        original = self.dates('2026-10-20')
        result = compare_dates(original, dict(original, gPlanDate='2026-10-22'), original)
        self.assertEqual(result['status'], 'NO_CHANGE')
        self.assertEqual(result['fields'][1]['expectedAfterSave'], '2026-10-22')

    def test_blanks_and_missing_values_never_authorize_clear(self):
        self.assertEqual(compare_dates(self.dates(None), self.dates(None), self.dates(''))['status'], 'NO_CHANGE')
        self.assertEqual(compare_dates(self.dates('2026-10-20'), self.dates('2026-10-20'), self.dates(''))['status'], 'VALIDATION_ERROR')
        self.assertEqual(compare_dates({}, {}, {})['status'], 'VALIDATION_ERROR')


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(legacy, 'TARGET_CONNECTION_NAME', ''))
        self.current = Session()
        self.app = application(self.current)
        self.ref = legacy.SessionRef(0, 0, 'VCE', '100', 'MOCK_SAP_LOGIN', 'VCE - One Digital Core [949]')
        self.stop = threading.Event()
        self.reader = ApqpDiscovery(legacy, self.ref, self.app, self.stop.is_set)

    def test_grid_inspection_does_not_navigate_select_or_write(self):
        grid = self.reader.inspect_grid()
        self.assertTrue(grid['complete'])
        self.assertEqual(grid['rowCount'], 2)
        self.assertEqual([column['id'] for column in grid['columns']], self.current.grid.ColumnOrder)
        self.assertEqual(self.current.calls, [])
        self.assertEqual(self.current.grid.SelectedRows, '')
        self.assertFalse(self.reader.report()['findings']['businessIdentityConfirmed'])

    def test_unique_sample_is_not_assumed_a_verified_apqp_identifier(self):
        grid = self.reader.inspect_grid(max_rows=1)
        self.assertFalse(grid['complete'])
        self.assertTrue(grid['technicalIdentityCandidates'])
        for column in grid['technicalIdentityCandidates']:
            self.assertIsNone(column['uniqueAcrossReturnedResult'])
            self.assertFalse(column['businessIdentityConfirmed'])

    def test_offscreen_empty_cells_are_not_claimed_to_be_complete_apqp_records(self):
        self.current.grid.VisibleRowCount = 1
        self.current.grid.virtualized = True
        grid = self.reader.inspect_grid()
        self.assertFalse(grid['complete'])
        self.assertEqual(grid['notReadOutsideViewport'], [1])
        self.assertEqual(len(grid['rows']), 1)
        self.assertEqual(self.current.grid.FirstVisibleRow, 0)

    def test_opt_in_grid_paging_loads_rows_and_restores_without_selecting_or_saving(self):
        self.current.grid.VisibleRowCount = 1
        self.current.grid.virtualized = True
        grid = self.reader.inspect_grid(scroll=True)
        self.assertTrue(grid['complete'])
        self.assertEqual(len(grid['rows']), 2)
        self.assertEqual(grid['rows'][1]['values']['FIELD_ALPHA'], 'A02')
        self.assertEqual(grid['viewport']['restoreStatus'], 'RESTORED')
        self.assertEqual(self.current.grid.FirstVisibleRow, 0)
        self.assertEqual(self.current.grid.SelectedRows, '')
        self.assertEqual(self.current.calls, [])

    def test_visible_but_empty_rows_are_marked_unverified_not_complete(self):
        self.current.grid.rows = [['', '', '']]
        grid = self.reader.inspect_grid(scroll=True)
        self.assertFalse(grid['complete'])
        self.assertEqual(grid['emptyObservedRows'], [0])

    def test_explicit_detail_read_reloads_observed_offscreen_row_before_fingerprint(self):
        self.current.grid.VisibleRowCount = 1
        self.current.grid.virtualized = True
        self.reader.inspect_grid(scroll=True)
        self.assertEqual(self.current.grid.FirstVisibleRow, 0)
        self.assertTrue(self.reader.open_observed_row(1)['allFourReadable'])
        self.assertEqual(self.current.grid.SelectedRows, '1')
        self.assertEqual(self.current.calls, [('execute', 'grid')])

    def test_stop_during_paging_does_not_send_a_restore_action(self):
        self.current.grid.VisibleRowCount = 1
        self.current.grid.on_scroll = self.stop.set
        with self.assertRaises(ApqpDateIssue) as issue: self.reader.inspect_grid(scroll=True)
        self.assertEqual(issue.exception.code, 'CANCELLED')
        self.assertEqual(self.current.grid.page_moves, [1])
        self.assertEqual(self.reader.latest['grid']['viewport']['restoreStatus'], 'SKIPPED_STOP')
        self.assertEqual(self.current.calls, [])

    def test_changed_session_during_paging_is_not_scrolled_back(self):
        self.current.grid.VisibleRowCount = 1
        self.current.grid.on_scroll = lambda: setattr(self.current.Info, 'User', 'OTHER')
        with self.assertRaises(ApqpDateIssue): self.reader.inspect_grid(scroll=True)
        self.assertEqual(self.current.grid.page_moves, [1])
        self.assertEqual(self.reader.latest['grid']['viewport']['restoreStatus'], 'SKIPPED_OR_FAILED')
        self.assertFalse(self.reader.latest['grid']['complete'])
        self.assertEqual(self.current.calls, [])

    def test_unreadable_viewport_or_cell_never_becomes_a_complete_snapshot(self):
        with patch.object(self.current.grid, 'VisibleRowCount', 0), self.assertRaises(ApqpDateIssue):
            self.reader.inspect_grid()
        self.current.grid.rows[0][0] = object()
        with self.assertRaises(ApqpDateIssue) as issue: self.reader.inspect_grid()
        self.assertEqual(issue.exception.code, 'SAP_GRID_UNREADABLE')
        self.assertFalse(self.reader.latest['grid']['complete'])

    def test_query_once_returns_all_observed_rows_without_material_queries(self):
        self.current.state, self.current.Info.Transaction = 'home', 'SESSION_MANAGER'
        grid = self.reader.discover('775773', 'EE00221')
        self.assertEqual(grid['rowCount'], 2)
        self.assertTrue(grid['complete'])
        self.assertEqual(self.current.calls, [('navigate', 'ZMFM050035'), ('execute', 'selection')])
        self.assertEqual(self.current.filters[ID_OWNER].Text, 'EE00221')
        self.assertEqual(self.reader.latest['session']['sapUser'], 'MOCK_SAP_LOGIN')
        self.assertEqual(self.current.filters[legacy.ID_MATERIAL].Text, '')
        self.assertFalse(self.current.filters[legacy.ID_CHECK_C3].Selected)
        self.assertFalse(self.reader.latest['findings']['allMatchingRecordsConfirmed'])

    def test_extra_filters_prevent_an_incomplete_query(self):
        self.current.state = 'selection'
        self.current.filters[legacy.ID_MATERIAL].Text = 'FILTER_FROM_LEGACY'
        with self.assertRaises(ApqpDateIssue) as issue: self.reader.discover('775773', 'EE00221')
        self.assertEqual(issue.exception.code, 'SAP_EXTRA_FILTERS')
        self.assertFalse(any(kind == 'execute' for kind, _ in self.current.calls))

    def test_query_and_navigation_failures_are_not_replayed(self):
        for attribute in ('start_error', 'after_query_error'):
            with self.subTest(attribute=attribute):
                self.current.state = 'selection'
                self.current.start_error = attribute == 'start_error'
                self.current.after_query_error = attribute == 'after_query_error'
                reader = ApqpDiscovery(legacy, self.ref, self.app)
                with self.assertRaises(ApqpDateIssue): reader.discover('775773', 'EE00221')
                before = list(self.current.calls)
                with self.assertRaises(ApqpDateIssue): reader.discover('775773', 'EE00221')
                self.assertEqual(self.current.calls, before)

    def test_other_transactions_and_existing_detail_are_not_hijacked(self):
        for state, transaction in (('home', 'ME11'), ('detail', 'ZMFM050035')):
            self.current.state, self.current.Info.Transaction = state, transaction
            with self.assertRaises(ApqpDateIssue): self.reader.discover('775773', 'EE00221')
            self.assertEqual(self.current.calls, [])

    def test_explicit_detail_read_opens_one_row_and_never_touches_save_or_dates(self):
        self.reader.inspect_grid()
        detail = self.reader.open_observed_row(1)
        self.assertTrue(detail['allFourReadable'])
        self.assertEqual(self.current.calls, [('execute', 'grid')])
        self.assertEqual(self.current.grid.SelectedRows, '1')
        self.assertEqual(self.current.state, 'detail')
        self.assertFalse(detail['recordIdentityOnDetailConfirmed'])
        self.assertFalse(detail['safeForUpdates'])
        self.assertFalse(any('btn[11]' in call.args[0] for call in self.current.FindById.call_args_list))

    def test_unreadable_or_invalid_dates_are_not_reported_as_empty(self):
        self.current.state = 'detail'
        self.current.dates[DATE_FIELDS[0].control_id].text = 'bad-date'
        self.current.dates[DATE_FIELDS[1].control_id].text = ''
        self.current.dates.pop(DATE_FIELDS[2].control_id)
        values = self.reader.read_open_detail()
        self.assertFalse(values['allFourReadable'])
        self.assertEqual(values['fields']['fPlanDate']['status'], 'INVALID_DATE')
        self.assertEqual(values['fields']['gPlanDate']['status'], 'EMPTY')
        self.assertEqual(values['fields']['hPlanDate']['status'], 'UNREADABLE')

    def test_changed_row_before_or_during_selection_prevents_opening(self):
        self.reader.inspect_grid()
        self.current.grid.rows[0][0] = 'DIFFERENT_RECORD'
        with self.assertRaises(ApqpDateIssue): self.reader.open_observed_row(0)
        self.assertEqual(self.current.calls, [])
        self.current.grid.rows[0][0] = 'A01'
        self.current.grid.on_select = lambda: self.current.grid.rows[0].__setitem__(0, 'CHANGED_AFTER_SELECT')
        with self.assertRaises(ApqpDateIssue): self.reader.open_observed_row(0)
        self.assertEqual(self.current.calls, [])

    def test_busy_unknown_popup_and_cancel_never_press_any_button(self):
        for attribute, value in (('Busy', True), ('Busy', 'unreadable'), ('popup', True)):
            with patch.object(self.current, attribute, value), self.assertRaises(ApqpDateIssue): self.reader.guard()
        self.stop.set()
        with self.assertRaises(ApqpDateIssue) as error: self.reader.inspect_grid()
        self.assertEqual(error.exception.code, 'CANCELLED')
        self.assertEqual(self.current.calls, [])

    def test_identity_and_transaction_changes_stop_mid_read(self):
        for attribute, value in (('Client', '949'), ('SystemName', 'CEQ'), ('User', 'OTHER'), ('Transaction', 'ME12')):
            with self.subTest(attribute=attribute), patch.object(self.current.Info, attribute, value), self.assertRaises(ApqpDateIssue):
                self.reader.inspect_grid()
        with patch.object(self.current, 'Id', '/app/con[9]/ses[9]'), self.assertRaises(ApqpDateIssue): self.reader.inspect_grid()

    def test_identity_change_during_cell_read_discards_the_incomplete_row(self):
        self.current.grid.on_read = lambda: setattr(self.current.Info, 'User', 'OTHER')
        with self.assertRaises(ApqpDateIssue) as issue: self.reader.inspect_grid()
        self.assertEqual(issue.exception.code, 'SAP_SESSION_LOST')
        self.assertEqual(self.reader.latest['grid']['rows'], [])
        self.assertFalse(self.reader.latest['grid']['complete'])

    def test_stop_is_checked_per_cell_without_waiting_for_a_full_row(self):
        reads = []
        self.current.grid.on_read = lambda: (reads.append(True), self.stop.set())
        with self.assertRaises(ApqpDateIssue) as issue: self.reader.inspect_grid()
        self.assertEqual(issue.exception.code, 'CANCELLED')
        self.assertEqual(len(reads), 1)
        self.assertEqual(self.reader.latest['grid']['rows'], [])
        self.assertEqual(self.current.calls, [])

    def test_busy_wait_is_bounded_and_never_dispatches_an_action(self):
        elapsed = [0.0]
        self.reader.clock = lambda: elapsed[0]
        self.reader.sleep = lambda duration: elapsed.__setitem__(0, elapsed[0] + duration)
        self.current.Busy = True
        with self.assertRaises(ApqpDateIssue) as issue: self.reader.wait(lambda: None, 'Fake grid', timeout=0.2)
        self.assertEqual(issue.exception.code, 'SAP_SLOW')
        self.assertLess(elapsed[0], 0.3)
        self.assertEqual(self.current.calls, [])

    def test_guard_uses_live_original_identity_without_rebinding_by_index(self):
        with patch.object(legacy, 'get_session_by_ref', side_effect=AssertionError('Do not rebind')):
            self.assertTrue(self.reader.inspect_grid()['complete'])
        with patch.object(legacy, 'read_session_identity', side_effect=RuntimeError('Original COM object disconnected')):
            with self.assertRaises(ApqpDateIssue) as issue: self.reader.guard()
        self.assertEqual(issue.exception.code, 'SAP_SESSION_LOST')
        self.assertEqual(self.current.calls, [])

    def test_wait_validates_the_identity_after_the_ready_read(self):
        def changed():
            self.current.Info.User = 'OTHER'
            return object()
        with self.assertRaises(ApqpDateIssue) as issue: self.reader.wait(changed, 'Fake page')
        self.assertEqual(issue.exception.code, 'SAP_SESSION_LOST')
        self.assertEqual(self.current.calls, [])

    def test_busy_poll_avoids_blocking_info_reads_until_ready(self):
        self.current.Busy = True
        original = legacy.read_session_identity
        def live_identity(session):
            if session.Busy: raise AssertionError('Do not read Info during a server round trip')
            return original(session)
        self.reader.sleep = lambda _: setattr(self.current, 'Busy', False)
        with patch.object(legacy, 'read_session_identity', side_effect=live_identity):
            self.assertTrue(self.reader.wait(lambda: True, 'Fake response'))
        self.assertEqual(self.current.calls, [])

    def test_stop_is_checked_per_cell_during_preopen_fingerprints(self):
        self.reader.inspect_grid()
        reads = []
        self.current.grid.on_read = lambda: (reads.append(True), self.stop.set())
        with self.assertRaises(ApqpDateIssue) as issue: self.reader.open_observed_row(0)
        self.assertEqual(issue.exception.code, 'CANCELLED')
        self.assertEqual(len(reads), 1)
        self.assertEqual(self.current.calls, [])
        self.assertEqual(self.current.grid.SelectedRows, '')

    def test_uncertain_return_cannot_be_dispatched_twice(self):
        self.reader.inspect_grid()
        self.reader.open_observed_row(0)
        calls = []
        def failed_return():
            calls.append('back')
            raise RuntimeError('COM failed after return dispatch')
        original_find = self.current.find
        self.current.FindById.side_effect = lambda identifier, *args: (
            SimpleNamespace(Press=failed_return) if identifier == legacy.ID_BACK else original_find(identifier, *args))
        with self.assertRaises(RuntimeError): self.reader.return_read_detail()
        with self.assertRaises(ApqpDateIssue): self.reader.return_read_detail()
        with self.assertRaises(ApqpDateIssue): self.reader.open_observed_row(1)
        self.assertEqual(calls, ['back'])

    def test_row_count_changes_and_unreadable_cells_do_not_create_a_complete_snapshot(self):
        self.current.grid.on_read = lambda: self.current.grid.rows.append(['NEW', 'NEW', 'NEW']) if len(self.current.grid.rows) == 2 else None
        with self.assertRaises(ApqpDateIssue): self.reader.inspect_grid()
        self.assertFalse(self.reader.latest['grid']['complete'])

    def test_invalid_limits_and_zero_results_are_explicit(self):
        with self.assertRaises(ValueError): self.reader.discover('775773', 'EE00221', max_rows=0)
        with self.assertRaises(ValueError): self.reader.inspect_grid(max_rows=True)
        self.assertEqual(self.current.calls, [])
        self.current.grid.rows.clear()
        result = self.reader.inspect_grid()
        self.assertEqual(result['rowCount'], 0)
        self.assertTrue(result['complete'])

    def test_collection_enumeration_never_stringifies_com_default_member(self):
        class Collection:
            Count = 2
            def ElementAt(self, index): return ['TECH_A', 'TECH_B'][index]
            def __str__(self): raise AssertionError('No default COM member')
        self.assertEqual(collection_values(Collection()), ['TECH_A', 'TECH_B'])
        self.assertEqual(collection_values('Column title'), ['Column title'])
        with self.assertRaises(ValueError): collection_values([object()])

    def test_detail_open_is_not_replayed_after_it_was_dispatched(self):
        self.reader.inspect_grid()
        self.reader.open_observed_row(0)
        with self.assertRaises(ApqpDateIssue): self.reader.open_observed_row(0)
        self.assertEqual(len(self.current.calls), 1)

    def test_cli_saves_only_json_evidence_in_owned_log_manifest_and_preserves_legacy_settings(self):
        args = SimpleNamespace(mode='inspect-grid', environment='PROD', session_id='', project='', owner='', max_rows=20, read_row=None, scroll_grid=False)
        previous = legacy.TARGET_SYSTEM, legacy.TARGET_CLIENT, legacy.TARGET_CONNECTION_NAME
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', APPDATA=directory), \
                patch.object(cli, 'arguments', return_value=args), patch.object(legacy, 'checked_sap_application', return_value=self.app), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(), 0)
            root = Path(directory) / 'sap-automation-toolbox/.local-data/logs/automation-runs'
            evidence = next(root.glob('*/apqp-date-evidence.json'))
            report = json.loads(evidence.read_text(encoding='utf-8'))
            self.assertTrue(report['readOnly'])
            self.assertFalse(report['writesEnabled'])
            self.assertNotIn('password', evidence.read_text(encoding='utf-8').lower())
            manifest = json.loads(evidence.with_name('artifacts.json').read_text())
            self.assertEqual(manifest['operation'], 'apqp-date-poc')
            self.assertTrue(manifest['finishedAt'])
            self.assertEqual(len(list(root.rglob('*.xlsx'))), 0)
        self.assertEqual((legacy.TARGET_SYSTEM, legacy.TARGET_CLIENT, legacy.TARGET_CONNECTION_NAME), previous)

    def test_cli_refuses_multiple_matching_grids_and_keeps_error_evidence(self):
        args = SimpleNamespace(mode='inspect-grid', environment='PROD', session_id='', project='', owner='', max_rows=20, read_row=None, scroll_grid=False)
        other = Session()
        other.Id = '/app/con[0]/ses[1]'
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', APPDATA=directory), \
                patch.object(cli, 'arguments', return_value=args), patch.object(legacy, 'checked_sap_application', return_value=application(self.current, other)), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(), 2)
            report = json.loads(next(Path(directory).rglob('apqp-date-evidence.json')).read_text(encoding='utf-8'))
            self.assertEqual(report['error']['code'], 'SAP_SESSION_AMBIGUOUS')
        self.assertEqual(self.current.calls, [])

    def test_qa_and_production_use_separate_environments_and_restore_settings(self):
        previous = legacy.TARGET_SYSTEM, legacy.TARGET_CLIENT, legacy.TARGET_CONNECTION_NAME
        for environment, system, label in (('QA', 'CEQ', '321'), ('PROD', 'VCE', '949')):
            current = Session(system=system)
            args = SimpleNamespace(mode='inspect-grid', session_id='')
            with cli.target_environment(legacy, environment):
                self.assertEqual(legacy.TARGET_SYSTEM, system)
                self.assertEqual(legacy.TARGET_CLIENT, '100')  # Entry 949/321 is not the SAP Client.
                self.assertIn(label, legacy.TARGET_CONNECTION_NAME)
                reader = cli.select_reader(legacy, application(current), args, self.stop)
                self.assertEqual(reader.report()['session']['system'], system)
                other_system = 'CEQ' if system == 'VCE' else 'VCE'
                with self.assertRaises(legacy.SapSessionCheckError):
                    cli.select_reader(legacy, application(Session(system=other_system)), args, self.stop)
        self.assertEqual((legacy.TARGET_SYSTEM, legacy.TARGET_CLIENT, legacy.TARGET_CONNECTION_NAME), previous)


if __name__ == '__main__':
    unittest.main(verbosity=2)
