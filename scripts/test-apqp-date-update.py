"""Write-path regression with fake SAP only; never opens a live SAP connection."""
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources/rpa'))
from apqp_date_api import identities, IDENTITY_COLUMNS, run
from apqp_date_discovery import ApqpDiscovery
from apqp_date_sessions import target_environment, select_reader
from apqp_date_update import DETAIL_IDENTITY, SAVE_ID, SAVE_YES, SAVE_NO, SD_CONTROLS, read_dates, return_to_list, update_open_record, write_policy
from apqp_dates import DATE_FIELDS, ApqpDateIssue
from apqp_date_fakes import DateSession, application, legacy


class WritableDate:
    Changeable = True
    def __init__(self, session, key): self.session, self.key, self.text = session, key, ''
    @property
    def Text(self): return self.text
    @Text.setter
    def Text(self, value):
        self.session.calls.append(('set-date', self.key, value))
        self.text = value
        if self.session.on_set: self.session.on_set()


class SdControl:
    Changeable = True
    def __init__(self, session, group, checkbox):
        self.session, self.group, self.checkbox = session, group, checkbox
        self.selected, self.text = False, 'Keep ' + group.upper()
    @property
    def Selected(self): return self.selected
    @Selected.setter
    def Selected(self, value):
        self.session.calls.append(('set-sd', self.group, value))
        if not self.session.ignore_sd: self.selected = value
        if self.session.unlock_dates:
            field = next(f for f in DATE_FIELDS if f.key == SD_CONTROLS[self.group]['actual'])
            self.session.dates[field.control_id].Changeable = value
        if self.session.on_sd_set: self.session.on_sd_set()
    @property
    def Text(self): return self.text
    @Text.setter
    def Text(self, value):
        self.session.calls.append(('set-comment', self.group, value))
        self.text = value[:2] if self.session.truncate_comment else value


class WritableSession(DateSession):
    def __init__(self, count=1, state='grid', **kwargs):
        super().__init__(count=count, state=state, system=kwargs.pop('system', 'CEQ'), **kwargs)
        self.dates = {field.control_id: WritableDate(self, field.key) for field in DATE_FIELDS}
        self.on_save = self.on_set = None
        self.status = SimpleNamespace(MessageType='', Text='')
        self.wrong_detail = False
        self.ignore_sd = self.truncate_comment = self.unlock_dates = False
        self.on_sd_set = None
        self.save_question = None
        self.on_yes = None
        self.sd = {identifier: SdControl(self, group, key == 'checkbox')
                   for group, config in SD_CONTROLS.items() for key, identifier in config.items() if key != 'actual'}
        self.sd_values = {row[0]: {group: dict(selected=False, comment='Keep ' + group.upper()) for group in SD_CONTROLS}
                          for row in self.grid.rows}
    def execute(self):
        if self.state == 'grid':
            values = self.sd_values[self.grid.rows[int(self.grid.SelectedRows)][0]]
            for group, config in SD_CONTROLS.items():
                self.sd[config['checkbox']].selected = values[group]['selected']
                self.sd[config['comment']].text = values[group]['comment']
        super().execute()
    def find(self, identifier, required=True):
        if self.save_question is not None and self.popup:
            if identifier == 'wnd[1]': return SimpleNamespace(Text='Question')
            if identifier == 'wnd[1]/usr/lbl[1,2]': return SimpleNamespace(Text=self.save_question)
            if identifier == SAVE_YES: return SimpleNamespace(Text='Yes', Press=self.confirm_save)
            if identifier == SAVE_NO: return SimpleNamespace(Text='No', Press=lambda: self.calls.append(('no',)))
        if self.state == 'detail' and identifier in self.sd:
            return self.sd[identifier]
        if identifier in DETAIL_IDENTITY.values() and self.state == 'detail':
            column = {'apqp': 0, 'material': 1, 'vendor': 2}[next(key for key, value in DETAIL_IDENTITY.items() if value == identifier)]
            return SimpleNamespace(Text='WRONG' if self.wrong_detail else self.grid.rows[int(self.grid.SelectedRows)][column])
        if identifier == SAVE_ID: return SimpleNamespace(Press=self.save)
        if identifier == 'wnd[0]/sbar': return self.status
        return super().find(identifier, required)
    def save(self):
        self.calls.append(('save', self.state))
        if self.save_question is not None:
            self.popup = True
            return
        self.commit()
    def confirm_save(self):
        self.calls.append(('save-yes',))
        if self.on_yes: self.on_yes()
        self.popup = False
        self.commit()
    def commit(self):
        number = self.grid.rows[int(self.grid.SelectedRows)][0]
        before = self.values[number]
        self.values[number] = [self.dates[field.control_id].text if not field.key.endswith('ActualDate')
            or self.sd[SD_CONTROLS[field.key[0]]['checkbox']].selected else before[index]
            for index, field in enumerate(DATE_FIELDS)]
        self.sd_values[number] = {group: dict(selected=self.sd[config['checkbox']].selected,
                                            comment=self.sd[config['comment']].text) for group, config in SD_CONTROLS.items()}
        self.status.MessageType, self.status.Text = 'S', 'Changes saved'
        if self.on_save: self.on_save()


def reopen(reader, identity):
    if reader.optional(legacy.ID_RESULT_GRID) is None:
        return_to_list(reader)
    grid = reader.inspect_grid(scroll=True, required_columns=IDENTITY_COLUMNS)
    index, current = identities(grid, '775773', 'EE00221')[identity['apqp']]
    if any(current[key] != identity[key] for key in ('material', 'vendor', 'plant', 'project')):
        raise ValueError('Identity changed')
    fresh = ApqpDiscovery(legacy, reader.ref, reader.application, reader.stop)
    fresh.latest['grid'] = grid
    fresh.open_observed_row(index)
    return fresh


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.session = WritableSession()
        self.stop = threading.Event()
        self.app = application(self.session)
        with target_environment(legacy, 'QA'):
            self.reader = select_reader(legacy, self.app, SimpleNamespace(mode='inspect-grid', session_id=''), self.stop)
            grid = self.reader.inspect_grid(required_columns=IDENTITY_COLUMNS)
            index, self.identity = next(iter(identities(grid, '775773', 'EE00221').values()))
            self.reader.open_observed_row(index)
        self.original = read_dates(self.reader)
        self.desired = {field.key: '2026-10-20' for field in DATE_FIELDS}
        self.checkpoints = []
        self.session.calls.clear()
    def update(self, comments=None, stage_only=False):
        return update_open_record(self.reader, self.identity, self.original, self.desired,
                                  lambda event, **data: self.checkpoints.append((event, data)), reopen, comments=comments, stage_only=stage_only)
    def saves(self): return [call for call in self.session.calls if call[0] == 'save']
    def test_changed_fields_only_saved_once_and_values_survive_reopen(self):
        result = self.update()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertEqual(result['dates'], self.desired)
        self.assertEqual(result['changedFields'], 3)  # G planned was already today.
        self.assertEqual(len(self.saves()), 1)
        self.assertEqual(sum(call[0] == 'set-date' for call in self.session.calls), 3)
        self.assertIn(('back', 'detail'), self.session.calls)
        self.assertIn(('execute', 'grid'), self.session.calls)
        self.assertEqual(self.checkpoints[-1][0], 'UPDATE_VERIFIED')
    def test_wrong_detail_identity_blocks_every_setter_and_save(self):
        self.session.wrong_detail = True
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(self.session.calls, [])
    def test_default_qa_primitive_cannot_be_redirected_to_production(self):
        self.reader.identity = (self.reader.identity[0], 'VCE', '100', self.reader.identity[3])
        with self.assertRaises(ApqpDateIssue) as error: self.update()
        self.assertEqual(error.exception.code, 'APQP_DATE_QA_ONLY')
        self.assertEqual(self.session.calls, [])
    def test_conflict_and_clear_block_without_writing(self):
        self.session.dates[DATE_FIELDS[2].control_id].text = '24.12.2026'
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(self.session.calls, [])
        self.session.dates[DATE_FIELDS[2].control_id].text = '25.12.2026'
        self.desired['gPlanDate'] = None
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(self.session.calls, [])
    def test_already_applied_is_not_saved_again(self):
        for field in DATE_FIELDS: self.session.dates[field.control_id].text = '20.10.2026'
        self.assertEqual(self.update()['status'], 'UNCHANGED')
        self.assertEqual(self.session.calls, [])
    def test_all_changeable_controls_are_checked_before_first_setter(self):
        self.session.sd[SD_CONTROLS['h']['checkbox']].selected = True
        self.session.dates[DATE_FIELDS[3].control_id].Changeable = False
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(self.session.calls, [])
    def test_stop_before_save_keeps_staged_inputs_and_never_saves(self):
        self.session.on_set = self.stop.set
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(self.saves(), [])
        self.assertEqual(self.checkpoints[-1][0], 'STAGED_UNSAVED')
    def test_stop_after_save_still_finishes_bounded_verification(self):
        self.session.on_save = self.stop.set
        self.assertEqual(self.update()['status'], 'VERIFIED')
        self.assertTrue(self.stop.is_set())
        self.assertEqual(len(self.saves()), 1)
    def test_unknown_save_popup_is_never_accepted_or_replayed(self):
        self.session.on_save = lambda: setattr(self.session, 'popup', True)
        with self.assertRaises(ApqpDateIssue) as error: self.update()
        self.assertEqual(error.exception.code, 'APQP_SAVE_OUTCOME_UNCERTAIN')
        self.assertEqual(len(self.saves()), 1)
        self.assertEqual(self.checkpoints[-1][0], 'SAVE_OUTCOME_UNCERTAIN')
        self.assertNotIn(('back', 'detail'), self.session.calls)
    def test_save_com_failure_never_replays_save(self):
        def failure(): raise RuntimeError('Connection lost after dispatch')
        self.session.on_save = failure
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(len(self.saves()), 1)
    def test_status_error_keeps_the_detail_open(self):
        self.session.on_save = lambda: setattr(self.session.status, 'MessageType', 'E')
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(len(self.saves()), 1)
        self.assertNotIn(('back', 'detail'), self.session.calls)
    def test_reopened_identity_or_dates_must_match(self):
        self.session.on_save = lambda: setattr(self.session, 'wrong_detail', True)
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(len(self.saves()), 1)
    def test_real_protocol_runs_single_click_qa_update_without_a_separate_preview(self):
        return_to_list(self.reader)
        original = dict(self.identity, dates=self.original, readable=True)
        request = dict(action='execute', query=dict(project='775773', userId='EE00221', environment='QA'),
                       originals=[original], edits=[dict(apqp=self.identity['apqp'], dates=self.desired)], session=self.reader.latest['session'])
        events, saved, checkpoints = [], [], []
        with patch('apqp_date_update.QA_WRITES_VALIDATED', True), patch('apqp_date_update.STAGE_ONLY', False):
            result = run(request, legacy, self.app, self.stop, lambda event, **data: events.append((event, data)),
                         lambda records: saved.append(records.copy()), lambda event, **data: checkpoints.append(event))
        self.assertEqual(result['update']['succeeded'], 1)
        self.assertEqual(result['records'][0]['dates'], self.desired)
        self.assertEqual(len(self.saves()), 1)
        self.assertIn('UPDATE_VERIFIED', checkpoints)
        self.assertEqual(saved[-1][0]['apqp'], self.identity['apqp'])
        self.assertTrue(any(event == 'notice' and data.get('material') == self.identity['material'] for event, data in events))

    def prepare_production(self):
        self.session = WritableSession(system='VCE')
        self.app = application(self.session)
        with target_environment(legacy, 'PROD'):
            self.reader = select_reader(legacy, self.app, SimpleNamespace(mode='inspect-grid', session_id=''), self.stop)
            grid = self.reader.inspect_grid(required_columns=IDENTITY_COLUMNS)
            index, self.identity = next(iter(identities(grid, '775773', 'EE00221').values()))
            self.reader.open_observed_row(index)
        self.original = read_dates(self.reader)
        self.session.calls.clear()

    def production_update(self):
        return update_open_record(self.reader, self.identity, self.original, self.desired,
            lambda event, **data: self.checkpoints.append((event, data)), reopen, environment='PROD', stage_only=False)

    def test_authorized_production_saves_once_and_verifies_reopened_values(self):
        self.prepare_production()
        result = self.production_update()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertEqual(result['dates'], self.desired)
        self.assertEqual(len(self.saves()), 1)
        before = next(data for event, data in self.checkpoints if event == 'CURRENT_VALUES_VERIFIED')
        self.assertEqual((before['environment'], before['system'], before['client']), ('PROD', 'VCE', '100'))
        self.assertTrue(before['writePolicy']['productionOwnerAuthorized'])
        self.assertFalse(before['writePolicy']['qaSaveAcceptancePassed'])
        self.assertFalse(before['writePolicy']['productionSaveAcceptancePassed'])

    def test_production_authorization_is_not_qa_acceptance_and_can_be_disabled(self):
        self.assertTrue(write_policy()['productionOwnerAuthorized'])
        self.assertFalse(write_policy()['qaSaveAcceptancePassed'])
        self.prepare_production()
        with patch('apqp_date_update.PRODUCTION_WRITES_AUTHORIZED', False), self.assertRaises(ApqpDateIssue) as error:
            self.production_update()
        self.assertEqual(error.exception.code, 'APQP_DATE_PRODUCTION_LOCKED')
        self.assertEqual(self.session.calls, [])

    def test_production_preserves_read_only_conflict_and_unknown_popup_protections(self):
        for failure in ('read-only', 'conflict', 'popup'):
            self.prepare_production()
            if failure == 'read-only':
                self.session.sd[SD_CONTROLS['h']['checkbox']].selected = True
                self.session.dates[DATE_FIELDS[3].control_id].Changeable = False
            if failure == 'conflict': self.session.dates[DATE_FIELDS[2].control_id].text = '24.12.2026'
            if failure == 'popup': self.session.popup = True
            with self.subTest(failure=failure), self.assertRaises(ApqpDateIssue): self.production_update()
            self.assertEqual(self.session.calls, [])

    def test_production_request_cannot_write_a_qa_or_other_client_window(self):
        with self.assertRaises(ApqpDateIssue) as error: self.production_update()
        self.assertEqual(error.exception.code, 'APQP_DATE_ENVIRONMENT_MISMATCH')
        self.assertEqual(self.session.calls, [])
        self.prepare_production()
        self.reader.identity = (self.reader.identity[0], 'VCE', '949', self.reader.identity[3])
        with self.assertRaises(ApqpDateIssue): self.production_update()
        self.assertEqual(self.session.calls, [])

    def test_native_production_execution_preserves_original_environment_and_changed_only_save(self):
        self.prepare_production()
        return_to_list(self.reader)
        original = dict(self.identity, dates=self.original, readable=True)
        request = dict(action='execute', query=dict(project='775773', userId='EE00221', environment='PROD'),
                       originals=[original], edits=[dict(apqp=self.identity['apqp'], dates=self.desired)], session=self.reader.latest['session'])
        with patch('apqp_date_update.STAGE_ONLY', False):
            result = run(request, legacy, self.app, self.stop, lambda *a, **k: None, lambda rows: None,
                         lambda event, **data: self.checkpoints.append((event, data)))
        self.assertEqual(result['update']['succeeded'], 1)
        self.assertEqual(result['session']['system'], 'VCE')
        self.assertEqual(len(self.saves()), 1)

    def test_actual_dates_select_matching_sd_first_and_blank_comments_preserve_originals(self):
        self.update({'g': ' ', 'h': ''})
        writes = [call for call in self.session.calls if call[0].startswith('set-')]
        self.assertEqual(writes[:2], [('set-sd', 'g', True), ('set-sd', 'h', True)])
        self.assertFalse(any(call[0] == 'set-comment' for call in writes))
        verified = self.checkpoints[-1][1]['sd']
        self.assertEqual(verified, {'g': {'selected': True, 'comment': 'Keep G'}, 'h': {'selected': True, 'comment': 'Keep H'}})

    def test_recorded_g_and_h_optional_comments_save_yes_once_and_survive_reopen(self):
        self.session.save_question = 'Do you want to save the data?'
        self.assertEqual(self.update({'g': 'AAA', 'h': '555'})['status'], 'VERIFIED')
        self.assertEqual(len(self.saves()), 1)
        self.assertEqual(self.session.calls.count(('save-yes',)), 1)
        self.assertEqual(self.checkpoints[-1][1]['sd']['g']['comment'], 'AAA')
        self.assertEqual(self.checkpoints[-1][1]['sd']['h']['comment'], '555')
        self.assertIn('SAVE_CONFIRMATION_DISPATCHED', [event for event, _ in self.checkpoints])

    def test_planned_date_only_does_not_touch_any_sd_control(self):
        self.desired = dict(self.original, gPlanDate='2026-11-22')
        self.update()
        self.assertFalse(any(call[0] in {'set-sd', 'set-comment'} for call in self.session.calls))

    def test_only_g_actual_change_does_not_touch_h_checkbox_or_comment(self):
        self.desired = dict(self.original, gActualDate='2026-10-22')
        self.update({'g': 'AAA'})
        self.assertFalse(any(call[0] in {'set-sd', 'set-comment'} and call[1] == 'h' for call in self.session.calls))

    def test_already_checked_sd_is_not_reassigned(self):
        for group, config in SD_CONTROLS.items():
            self.session.sd[config['checkbox']].selected = True
            self.session.sd[config['checkbox']].Changeable = False
        self.update()
        self.assertFalse(any(call[0] == 'set-sd' for call in self.session.calls))

    def test_missing_readonly_or_ignored_checkbox_never_saves(self):
        for failure in ('missing', 'read-only', 'ignored'):
            self.setUp()
            if failure == 'missing': self.session.sd[SD_CONTROLS['g']['checkbox']] = None
            if failure == 'read-only': self.session.sd[SD_CONTROLS['g']['checkbox']].Changeable = False
            if failure == 'ignored': self.session.ignore_sd = True
            with self.subTest(failure=failure), self.assertRaises(ApqpDateIssue): self.update()
            self.assertEqual(self.saves(), [])
            self.assertFalse(any(call[0] == 'set-date' for call in self.session.calls))

    def test_checkbox_can_unlock_actual_date_and_stop_after_tick_is_staged_unsaved(self):
        self.session.unlock_dates = True
        self.session.dates[DATE_FIELDS[1].control_id].Changeable = False
        self.assertEqual(self.update()['status'], 'VERIFIED')
        self.setUp()
        self.session.on_sd_set = self.stop.set
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(self.saves(), [])
        self.assertEqual(self.checkpoints[-1][0], 'STAGED_UNSAVED')

    def test_comments_require_matching_actual_edits_and_reject_truncation(self):
        self.desired = dict(self.original, gPlanDate='2026-11-22')
        with self.assertRaises(ApqpDateIssue): self.update({'g': 'AAA'})
        self.assertEqual(self.session.calls, [])
        self.setUp()
        self.session.truncate_comment = True
        with self.assertRaises(ApqpDateIssue): self.update({'g': 'AAA'})
        self.assertEqual(self.saves(), [])

    def test_readonly_comment_and_missing_h_controls_do_not_save_or_input_dates(self):
        for failure in ('read-only comment', 'missing H'):
            self.setUp()
            if failure == 'read-only comment': self.session.sd[SD_CONTROLS['g']['comment']].Changeable = False
            else: self.session.sd[SD_CONTROLS['h']['checkbox']] = None
            with self.subTest(failure=failure), self.assertRaises(ApqpDateIssue): self.update({'g': 'AAA'})
            self.assertEqual(self.saves(), [])
            self.assertFalse(any(call[0] == 'set-date' for call in self.session.calls))

    def test_already_applied_actual_date_does_not_silently_ignore_new_comment(self):
        self.session.dates[DATE_FIELDS[1].control_id].text = '20.10.2026'
        with self.assertRaises(ApqpDateIssue) as error: self.update({'g': 'new comment'})
        self.assertEqual(error.exception.code, 'APQP_DATE_CONFLICT')
        self.assertEqual(self.session.calls, [])

    def test_save_delete_question_or_ambiguous_yes_is_not_replayed(self):
        for question in ('Delete the data before saving?', 'Continue with the changes?'):
            self.setUp()
            self.session.save_question = question
            with self.subTest(question=question), self.assertRaises(ApqpDateIssue) as error: self.update()
            self.assertEqual(error.exception.code, 'APQP_SAVE_OUTCOME_UNCERTAIN')
            self.assertNotIn(('save-yes',), self.session.calls)
            self.assertEqual(len(self.saves()), 1)
        self.setUp()
        self.session.save_question = 'Do you want to save the data?'
        self.session.on_yes = lambda: (_ for _ in ()).throw(RuntimeError('Ambiguous Yes Press'))
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(self.session.calls.count(('save-yes',)), 1)
        self.assertEqual(len(self.saves()), 1)

    def test_reopened_sd_must_be_verified_not_just_the_dates(self):
        def lose_flag(): self.session.sd_values[self.identity['apqp']]['g']['selected'] = False
        self.session.on_save = lose_flag
        with self.assertRaises(ApqpDateIssue) as error: self.update()
        self.assertEqual(error.exception.code, 'APQP_SAVE_OUTCOME_UNCERTAIN')
        self.assertEqual(len(self.saves()), 1)

    def test_stage_only_fills_without_save_yes_back_reopen_or_committed_changes(self):
        before = [list(row) for row in self.session.values.values()]
        self.session.save_question = 'Is the PPAP Level correctly selected?'
        result = self.update({'g': 'AAA'}, stage_only=True)
        self.assertEqual(result['status'], 'STAGED')
        self.assertEqual(self.session.state, 'detail')
        self.assertEqual(self.saves(), [])
        self.assertNotIn(('save-yes',), self.session.calls)
        self.assertNotIn(('back', 'detail'), self.session.calls)
        self.assertEqual(list(self.session.values.values()), before)
        self.assertEqual(self.checkpoints[-1][0], 'STAGED_READY_NOT_SAVED')

    def test_custom_step_ppap_level_confirmation_is_recognized_in_future_save_path(self):
        self.session.save_question = 'Is the PPAP Level correctly selected?'
        original_find = self.session.find
        body = SimpleNamespace(Text='Is the PPAP Level correctly selected?')
        class Nodes:
            Count = 1
            def __call__(self, index): return body
        def custom(identifier, required=True):
            if self.session.popup:
                if identifier == 'wnd[1]': return SimpleNamespace(Text='STEP', Children=Nodes())
                if identifier == 'wnd[1]/usr/lbl[1,2]': return None
            return original_find(identifier, required)
        self.session.FindById.side_effect = custom
        self.update()
        self.assertEqual(self.session.calls.count(('save-yes',)), 1)
        event = next(data for event, data in self.checkpoints if event == 'SAVE_CONFIRMATION_DISPATCHED')
        self.assertEqual(event['kind'], 'PPAP_LEVEL')

    def test_fast_stage_location_reads_only_ids_plus_first_target_and_never_opens_next(self):
        s = WritableSession(count=48)
        app = application(s)
        originals = [dict(apqp=r[0], material=r[1], vendor=r[2], plant=r[3], project=r[4], dates=dict(self.original), readable=True) for r in s.grid.rows]
        edits = [dict(apqp=r['apqp'], dates=dict(r['dates'], **({'gActualDate': '2026-10-22'} if i in (46,47) else {}))) for i,r in enumerate(originals)]
        request = dict(action='execute', query=dict(project='775773', userId='EE00221', environment='QA'), originals=originals,
                       edits=edits, session=self.reader.latest['session'], stageOnly=False)
        # Renderer/native request flags cannot turn off the authoritative policy.
        with patch('apqp_date_update.QA_WRITES_VALIDATED', True):
            result = run(request, legacy, app, self.stop, lambda *a, **k: None, lambda rows: None, lambda *a, **k: None)
        self.assertEqual(result['performance']['locateGridCellReads'], 54)  # 48 IDs + 6 target identity values, not 48*6.
        self.assertEqual(result['update']['staged'], 1)
        self.assertEqual(result['update']['succeeded'], 0)
        self.assertTrue(result['update']['stageOnly'])
        self.assertEqual((result['update']['total'], result['update']['processed']), (2,1))
        self.assertEqual(result['records'][0]['apqp'], originals[46]['apqp'])
        self.assertEqual(s.state, 'detail')
        self.assertEqual([call for call in s.calls if call[0] in ('save','save-yes','back')], [])
        self.assertEqual(s.values[originals[46]['apqp']][1], '')
        self.assertEqual(s.values[originals[47]['apqp']][1], '')

    def test_fast_locator_blocks_changed_supplier_material_owner_duplicate_or_selected_row(self):
        for failure in ('material', 'supplier', 'owner', 'duplicate', 'selected row'):
            self.setUp()
            return_to_list(self.reader)
            original = dict(self.identity, dates=self.original, readable=True)
            if failure == 'material': self.session.grid.rows[0][1] = 'OTHER'
            if failure == 'supplier': self.session.grid.rows[0][2] = 'OTHER'
            if failure == 'owner': self.session.grid.rows[0][5] = 'OTHER'
            if failure == 'duplicate': self.session.grid.rows.append(list(self.session.grid.rows[0]))
            if failure == 'selected row':
                self.session.grid.on_select = lambda: self.session.grid.rows[0].__setitem__(1, 'OTHER')
            self.session.calls.clear()
            request = dict(action='execute', query=dict(project='775773', userId='EE00221', environment='QA'),
                originals=[original], edits=[dict(apqp=self.identity['apqp'], dates=self.desired)], session=self.reader.latest['session'])
            with self.subTest(failure=failure), patch('apqp_date_update.QA_WRITES_VALIDATED', True), self.assertRaises(ApqpDateIssue):
                run(request, legacy, self.app, self.stop, lambda *a, **k: None, lambda rows: None, lambda *a, **k: None)
            self.assertFalse(any(call[0].startswith('set-') or call[0] == 'save' for call in self.session.calls))


if __name__ == '__main__': unittest.main(verbosity=2)
