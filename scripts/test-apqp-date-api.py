"""No real SAP/Excel. Native API contract and production-write gate regression."""
from copy import deepcopy
from pathlib import Path
import json
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources/rpa'))
from apqp_date_api import run, save_summary, WRITE_GATE, IDENTITY_COLUMNS, locate_update_targets
from apqp_dates import ApqpDateIssue, DATE_FIELDS
from apqp_date_fakes import DateSession, application, legacy, enable_bulk_dates
from apqp_date_discovery import ApqpDiscovery


class ApiTests(unittest.TestCase):
    def test_fresh_query_hash_index_avoids_re_reading_all_48_ids_for_first_target(self):
        self.session = DateSession(count=48)
        self.app = application(self.session)
        from apqp_date_sessions import select_reader, target_environment
        from types import SimpleNamespace
        with target_environment(legacy, 'PROD'):
            reader = select_reader(legacy, self.app, SimpleNamespace(mode='discover', session_id='', allow_navigation=True), threading.Event())
            grid = reader.discover('775773', 'EE00221', scroll=True, required_columns=IDENTITY_COLUMNS, allow_navigation=True, batch_rows=True)
            target = dict(apqp='2000000047', material='10000047', vendor='0041889', plant='C100', project='775773')
            before = reader.metrics['gridCellReads']
            evidence, found = locate_update_targets(reader, [target], '775773', 'EE00221', fresh_scan=grid)
            self.assertEqual(found[target['apqp']][0], 47)
            self.assertEqual(reader.metrics['gridCellReads'] - before, 6, 'Only six fresh identity cells, not 48 IDs plus six cells')
            reader.latest['grid'] = evidence
            reader.open_observed_row(47)
            self.assertEqual(self.session.state, 'detail')

    def setUp(self):
        self.session = DateSession(count=3)
        self.app = application(self.session)
        self.stop = threading.Event()
        self.query = dict(project='775773', userId='EE00221', environment='PROD')
        self.saved, self.events = [], []

    def call(self, request):
        return run(request, legacy, self.app, self.stop, lambda event, **data: self.events.append((event, data)), lambda rows: self.saved.append(deepcopy(rows)))

    def snapshot(self): return self.call(dict(action='query', query=self.query))

    def preview(self, snapshot, change):
        edits = [dict(apqp=row['apqp'], dates=dict(row['dates'])) for row in snapshot['records']]
        change(edits)
        return self.call(dict(action='preview', query=self.query, originals=snapshot['records'], session=snapshot['session'], edits=edits))

    def test_query_executes_once_reads_all_details_and_returns_to_grid(self):
        result = self.snapshot()
        self.assertEqual(len(result['records']), 3)
        self.assertTrue(all(row['readable'] for row in result['records']))
        self.assertEqual(sum(call == ('execute', 'selection') for call in self.session.calls), 1)
        self.assertEqual(sum(call == ('execute', 'grid') for call in self.session.calls), 3)
        self.assertEqual(self.session.state, 'grid')
        self.assertEqual(result['session']['client'], '100')
        self.assertEqual(len(self.saved), 3)

    def test_48_record_query_reuses_one_bound_reader_and_limits_session_roundtrips(self):
        self.session = DateSession(count=48)
        self.app = application(self.session)
        with patch.object(legacy, 'get_session_by_ref', wraps=legacy.get_session_by_ref) as resolve, \
                patch.object(ApqpDiscovery, '_read_detail_fields', autospec=True,
                             side_effect=ApqpDiscovery._read_detail_fields) as read:
            result = self.snapshot()
        # One inventory eligibility check + one binding. Never resolve per guard/row.
        self.assertEqual(resolve.call_count, 2)
        self.assertEqual(read.call_count, 48)
        self.assertLessEqual(result['performance']['sessionChecks'], 350)
        self.assertEqual(result['performance']['referenceResolutions'], 1)
        self.assertEqual(result['performance']['detailsOpened'], 48)
        self.assertEqual(result['performance']['detailsReturned'], 48)
        self.assertEqual(result['performance']['dateValueReads'], 48 * 8,
                         'Keep a lightweight second date comparison before leaving editable details')
        self.assertEqual(len(self.saved), 48)
        self.assertEqual(len(result['records']), 48)
        self.assertEqual(self.session.state, 'grid')

    def test_query_automatically_navigates_from_another_tcode_in_the_same_window(self):
        self.session.state, self.session.Info.Transaction = 'other', 'ME11'
        result = self.snapshot()
        self.assertEqual(len(result['records']), 3)
        self.assertEqual(self.session.calls[0], ('navigate', 'ZMFM050035'))
        self.assertEqual(result['session']['sessionId'], self.session.Id)
        self.session.StartTransaction.assert_called_once_with('ZMFM050035')

    def test_startup_prefers_an_idle_window_over_an_unrelated_business_window(self):
        idle = DateSession(count=1)
        idle.Id = '/app/con[0]/ses[1]'
        self.session.state, self.session.Info.Transaction = 'other', 'ME12'
        self.app = application(self.session, idle)
        result = self.snapshot()
        self.assertEqual(result['session']['sessionId'], idle.Id)
        self.assertEqual(self.session.calls, [])
        self.assertEqual(len(result['records']), 1)

    def test_startup_refuses_ambiguous_windows_but_explicit_query_can_leave_a_clean_detail(self):
        self.session.state, self.session.Info.Transaction = 'other', 'ME11'
        other = DateSession()
        other.state, other.Info.Transaction, other.Id = 'other', 'ME13', '/app/con[0]/ses[1]'
        self.app = application(self.session, other)
        with patch.object(legacy, 'MAX_WORKERS', 1), self.assertRaises(ApqpDateIssue) as issue: self.snapshot()
        self.assertEqual(issue.exception.code, 'SAP_SESSION_AMBIGUOUS')
        self.assertEqual(self.session.calls + other.calls, [])
        self.app = application(self.session)
        self.session.state, self.session.Info.Transaction = 'detail', legacy.TCODE
        self.snapshot()
        self.assertEqual(self.session.calls[0], ('navigate', legacy.TCODE))

    def test_navigation_save_or_discard_prompt_is_not_clicked_or_replayed(self):
        self.session.state, self.session.Info.Transaction = 'other', 'ME11'
        def prompt(transaction):
            self.session.calls.append(('navigate', transaction))
            self.session.popup = True
        self.session.StartTransaction.side_effect = prompt
        with self.assertRaises(ApqpDateIssue) as issue: self.snapshot()
        self.assertEqual(issue.exception.code, 'SAP_UNEXPECTED_POPUP')
        self.assertEqual(self.session.calls, [('navigate', 'ZMFM050035')])
        self.assertTrue(self.session.popup)
        self.assertEqual(self.saved, [])

    def test_slow_navigation_waits_for_the_target_without_resending_start(self):
        self.session.state, self.session.Info.Transaction = 'other', 'ME11'
        def pending(transaction): self.session.calls.append(('navigate', transaction))
        def ready(_): self.session.state, self.session.Info.Transaction = 'selection', legacy.TCODE
        self.session.StartTransaction.side_effect = pending
        original = ApqpDiscovery.__init__
        def constructor(reader, *args, **kwargs):
            original(reader, *args, **kwargs)
            reader.sleep = ready
        with patch.object(ApqpDiscovery, '__init__', constructor):
            result = self.snapshot()
        self.assertEqual(len(result['records']), 3)
        self.session.StartTransaction.assert_called_once()

    def test_lightweight_return_keeps_concurrently_edited_dates_and_does_not_go_back(self):
        def changed(rows):
            self.saved.append(deepcopy(rows))
            self.session.dates[DATE_FIELDS[0].control_id].text = '21.10.2026'
        with self.assertRaises(ApqpDateIssue) as issue:
            run(dict(action='query', query=self.query), legacy, self.app, self.stop, lambda *a, **k: None, changed)
        self.assertEqual(issue.exception.code, 'SAP_DETAIL_CHANGED')
        self.assertEqual(self.session.state, 'detail')
        self.assertNotIn(('back', 'detail'), self.session.calls)
        self.assertEqual(self.session.dates[DATE_FIELDS[0].control_id].text, '21.10.2026')

    def test_batch_grid_rejects_identity_or_viewport_changes_before_opening_details(self):
        for change in (lambda: setattr(self.session.Info, 'User', 'OTHER'),
                       lambda: setattr(self.session.grid, '_first_visible', 1)):
            self.session = DateSession(count=3)
            self.app = application(self.session)
            self.session.grid.on_read = change
            with self.assertRaises(ApqpDateIssue): self.snapshot()
            self.assertNotIn(('execute', 'grid'), self.session.calls)
            self.assertEqual(self.saved, [])

    def test_bulk_dates_match_compatibility_reads_without_individual_field_reads(self):
        expected = self.snapshot()['records']
        self.session = DateSession(count=3)
        self.app = application(self.session)
        enable_bulk_dates(self.session)
        self.saved.clear()
        result = self.snapshot()
        self.assertEqual(result['records'], expected)
        self.assertEqual(self.session.bulk_reads, 6)
        self.assertEqual(result['performance']['bulkDetailReads'], 6)
        date_ids = {field.control_id for field in DATE_FIELDS}
        # Readiness checks the first date control only, not each value/Changeable.
        self.assertEqual(sum(call.args[0] in date_ids for call in self.session.FindById.call_args_list), 3)

    def test_bulk_invalid_json_missing_date_and_foreign_session_fail_without_back_or_save(self):
        for kind in ('invalid-json', 'missing-date', 'foreign-session', 'missing-root', 'duplicate-date', 'null-text'):
            self.session = DateSession(count=3)
            self.app = application(self.session)
            enable_bulk_dates(self.session)
            export = self.session.GetObjectTree
            def invalid(root, properties):
                value = export(root, properties)
                if kind == 'invalid-json': return '{bad json'
                tree = json.loads(value)
                if kind == 'missing-date': tree['children'].pop()
                if kind == 'foreign-session': tree['properties']['Id'] = '/app/con[99]/ses[0]/' + root
                if kind == 'missing-root': tree['properties']['Id'] = 'wnd[0]/usr/another-container'
                if kind == 'duplicate-date': tree['children'].append(tree['children'][0])
                if kind == 'null-text': tree['children'][0]['properties']['Text'] = None
                return json.dumps(tree)
            self.session.GetObjectTree = invalid
            with self.subTest(kind=kind), self.assertRaises(ApqpDateIssue): self.snapshot()
            self.assertEqual(self.session.state, 'detail')
            self.assertNotIn(('back', 'detail'), self.session.calls)

    def test_bulk_detects_an_edit_or_unreadable_second_snapshot_before_return(self):
        for kind in ('changed-date', 'missing-date', 'popup', 'changed-user'):
            self.session = DateSession(count=3)
            self.app = application(self.session)
            enable_bulk_dates(self.session)
            def change(rows):
                if kind == 'changed-date': self.session.dates[DATE_FIELDS[0].control_id].text = '21.10.2026'
                if kind == 'missing-date': self.session.dates.pop(DATE_FIELDS[0].control_id)
                if kind == 'popup': self.session.popup = True
                if kind == 'changed-user': self.session.Info.User = 'OTHER'
            with self.subTest(kind=kind), self.assertRaises(ApqpDateIssue):
                run(dict(action='query', query=self.query), legacy, self.app, self.stop, lambda *a, **k: None, change)
            self.assertNotIn(('back', 'detail'), self.session.calls)

    def test_find_again_reuses_the_verified_result_list_without_manual_back(self):
        self.snapshot()
        self.session.calls.clear()
        result = self.snapshot()
        self.assertEqual(len(result['records']), 3)
        self.assertEqual(sum(call == ('navigate', 'ZMFM050035') for call in self.session.calls), 1)
        self.assertEqual(sum(call == ('execute', 'selection') for call in self.session.calls), 1)

    def test_preview_re_reads_only_edited_records_and_uses_three_way_comparison(self):
        snapshot = self.snapshot()
        self.session.calls.clear()
        result = self.preview(snapshot, lambda edits: edits[0]['dates'].__setitem__('fPlanDate', '2026-11-01'))
        self.assertEqual(result['preview']['changedRecords'], 1)
        self.assertEqual(result['preview']['changedFields'], 1)
        self.assertEqual(result['preview']['unchanged'], 2)
        self.assertEqual(self.session.calls, [('execute', 'grid'), ('back', 'detail')])

    def test_sap_concurrent_change_is_a_conflict_not_a_write(self):
        snapshot = self.snapshot()
        self.session.values[snapshot['records'][0]['apqp']][1] = '22.10.2026'
        result = self.preview(snapshot, lambda edits: edits[0]['dates'].__setitem__('gPlanDate', '2026-11-01'))
        self.assertEqual(result['preview']['conflicts'], 1)
        self.assertEqual(result['preview']['changes'], [])

    def test_blank_date_is_validation_error_without_sap_action(self):
        snapshot = self.snapshot()
        self.session.calls.clear()
        result = self.preview(snapshot, lambda edits: edits[0]['dates'].__setitem__('gPlanDate', None))
        self.assertEqual(result['preview']['invalid'], 1)
        self.assertEqual(self.session.calls, [])

    def test_already_applied_changes_need_no_save(self):
        snapshot = self.snapshot()
        self.session.values[snapshot['records'][0]['apqp']][0] = '01.11.2026'
        result = self.preview(snapshot, lambda edits: edits[0]['dates'].__setitem__('fPlanDate', '2026-11-01'))
        self.assertEqual(result['preview']['changedFields'], 0)
        self.assertEqual(result['preview']['unchanged'], 3)

    def test_direct_execute_cannot_bypass_write_gate(self):
        with patch('apqp_date_update.PRODUCTION_WRITES_AUTHORIZED', False), self.assertRaises(ApqpDateIssue) as issue:
            self.call(dict(action='execute', query=self.query, writesEnabled=True))
        self.assertEqual(issue.exception.code, 'APQP_DATE_PRODUCTION_LOCKED')
        self.assertEqual(self.session.calls, [])

    def test_enabled_production_still_requires_durable_checkpoints_before_any_action(self):
        with self.assertRaises(ApqpDateIssue) as issue: self.call(dict(action='execute', query=self.query))
        self.assertEqual(issue.exception.code, 'APQP_DATE_CHECKPOINT_REQUIRED')
        self.assertEqual(self.session.calls, [])

    def test_duplicate_apqp_and_filter_mismatch_fail_before_detail_navigation(self):
        for field, value in ((0, self.session.grid.rows[0][0]), (4, 'OTHER_PROJECT')):
            self.session = DateSession(count=3)
            self.app = application(self.session)
            self.session.grid.rows[1][field] = value
            with self.assertRaises(ApqpDateIssue): self.snapshot()
            self.assertNotIn(('execute', 'grid'), self.session.calls)

    def test_plant_mismatch_names_actual_value_and_shows_matching_project_and_user(self):
        for row in self.session.grid.rows:
            row[3] = 'C999'
        with self.assertRaises(ApqpDateIssue) as issue: self.snapshot()
        error = issue.exception
        self.assertEqual(error.code, 'SAP_QUERY_FILTER_MISMATCH')
        self.assertIn('工厂（Plant）：预期 C100 / 0000，SAP 实际 C999', error.issue_summary_zh)
        self.assertEqual(error.comparison['mismatchRows'], 3)
        self.assertEqual(error.comparison['totalRows'], 3)
        self.assertEqual(error.comparison['rows'][0]['rowNumber'], 1)
        self.assertEqual([check['matches'] for check in error.comparison['rows'][0]['checks']], [False, True, True])
        self.assertEqual(json.loads(error.details), error.comparison)
        self.assertNotIn(('execute', 'grid'), self.session.calls)

    def test_project_and_user_mismatches_are_separate_and_blank_is_explicit(self):
        self.session.grid.rows[0][4] = 'OTHER_PROJECT'
        self.session.grid.rows[1][5] = ''
        with self.assertRaises(ApqpDateIssue) as issue: self.snapshot()
        self.assertIn('NPL / 项目编号', issue.exception.issue_summary_zh)
        self.assertIn('User ID（SD）', issue.exception.issue_summary_zh)
        self.assertIn('（空白）', issue.exception.issue_summary_zh)
        self.assertEqual(issue.exception.comparison['mismatchRows'], 2)
        self.assertEqual([check['field'] for row in issue.exception.comparison['rows'] for check in row['checks'] if not check['matches']], ['project', 'userId'])

    def test_mismatch_samples_are_bounded_without_hiding_total_count(self):
        self.session = DateSession(count=25)
        self.app = application(self.session)
        for row in self.session.grid.rows:
            row[3] = 'C999'
        with self.assertRaises(ApqpDateIssue) as issue: self.snapshot()
        self.assertEqual(issue.exception.comparison['totalRows'], 25)
        self.assertEqual(issue.exception.comparison['mismatchRows'], 25)
        self.assertEqual(len(issue.exception.comparison['rows']), 20)

    def test_shared_0000_is_valid_and_is_preserved_in_query_and_preview(self):
        self.session.grid.rows[0][3] = '0000'
        snapshot = self.snapshot()
        self.assertEqual(snapshot['records'][0]['plant'], '0000')
        result = self.preview(snapshot, lambda edits: edits[0]['dates'].__setitem__('fPlanDate', '2026-11-01'))
        self.assertEqual(result['records'][0]['plant'], '0000')
        self.assertEqual(result['preview']['changedFields'], 1)
        self.session.grid.rows[0][3] = 'C100'
        with self.assertRaises(ApqpDateIssue) as issue:
            self.preview(snapshot, lambda edits: edits[0]['dates'].__setitem__('fPlanDate', '2026-11-01'))
        self.assertEqual(issue.exception.code, 'APQP_IDENTITY_CHANGED')

    def test_business_query_reads_only_six_identity_columns_even_in_104_column_grid(self):
        self.session.grid.ColumnOrder += [f'UNUSED_{i}' for i in range(98)]
        for row in self.session.grid.rows:
            row.extend(['unneeded'] * 98)
        original = self.session.grid.GetCellValue
        calls = []
        def measured(row, column):
            calls.append(column)
            return original(row, column)
        self.session.grid.GetCellValue = measured
        result = self.snapshot()
        self.assertEqual(len(result['records']), 3)
        self.assertEqual(set(calls), set(IDENTITY_COLUMNS))
        self.assertEqual(len(calls), 3 * 6 * 3, 'One grid read + two identity checks, not 104 columns per read')
        self.assertTrue(any(event == 'workers' for event, _ in self.events))
        self.assertEqual([data['current'] for event, data in self.events if event == 'record'], [1, 2, 3])

    def test_unexpected_return_popup_stops_without_blind_confirmation(self):
        self.session.unknown_return_popup = True
        with self.assertRaises(ApqpDateIssue) as issue: self.snapshot()
        self.assertEqual(issue.exception.code, 'SAP_UNEXPECTED_POPUP')
        self.assertEqual(sum(call == ('execute', 'grid') for call in self.session.calls), 1)
        self.assertEqual(len(self.saved), 1)

    def test_stop_preserves_partial_read_and_does_not_return_or_save(self):
        def persist(rows): self.saved.append(deepcopy(rows)); self.stop.set()
        with self.assertRaises(ApqpDateIssue): run(dict(action='query', query=self.query), legacy, self.app, self.stop, lambda *args, **kwargs: None, persist)
        self.assertEqual(len(self.saved), 1)
        self.assertEqual(self.session.state, 'detail')
        self.assertNotIn(('back', 'detail'), self.session.calls)

    def test_hub_date_management_rejects_qa_and_only_uses_949(self):
        self.session = DateSession(count=1, system='CEQ')
        self.app = application(self.session)
        self.query['environment'] = 'QA'
        with self.assertRaises(ApqpDateIssue) as caught: self.snapshot()
        self.assertEqual(caught.exception.code, 'APQP_DATE_PRODUCTION_ONLY')
        self.assertEqual(self.session.calls, [])

    def test_preview_will_not_use_another_account_or_changed_identity(self):
        snapshot = self.snapshot()
        self.session.Info.User = 'OTHER'
        with self.assertRaises(ApqpDateIssue): self.preview(snapshot, lambda edits: edits[0]['dates'].__setitem__('fPlanDate', '2026-11-01'))

    def test_missing_field_does_not_become_a_valid_blank(self):
        self.session.dates.pop(DATE_FIELDS[0].control_id)
        with self.assertRaises(ApqpDateIssue) as issue: self.snapshot()
        self.assertEqual(issue.exception.code, 'APQP_DATE_UNREADABLE')
        self.assertEqual(self.saved, [])

    def test_summary_retries_only_file_replace_and_never_replays_sap(self):
        replace = Path.replace
        attempts = []
        def locked_then_saved(source, target):
            attempts.append(source)
            if len(attempts) < 3:
                raise PermissionError('Fake Windows scanner lock')
            return replace(source, target)
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'replace', locked_then_saved):
            target = Path(directory) / 'apqp-dates-result.json'
            save_summary(target, dict(readOnly=True, writesEnabled=False, records=[]), sleep=lambda _: None)
            self.assertEqual(len(attempts), 3)
            self.assertTrue(json.loads(target.read_text())['readOnly'])
            self.assertEqual(self.session.calls, [])


if __name__ == '__main__': unittest.main(verbosity=2)
