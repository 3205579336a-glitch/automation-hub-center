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
import apqp_date_update as date_update
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


class PlannedWriteTests(unittest.TestCase):
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
        self.desired = dict(self.original, fPlanDate='2026-10-27', mPlanDate='2026-12-30')
        self.checkpoints = []
        self.session.calls.clear()

    def update(self, stage_only=False, checkpoint=None):
        return update_open_record(self.reader, self.identity, self.original, self.desired,
            checkpoint or (lambda event, **data: self.checkpoints.append((event, data))),
            reopen, environment='QA', stage_only=stage_only)

    def test_four_recorded_planned_selectors_only_and_no_actual_sd_access(self):
        self.desired = {field.key: '2026-10-27' for field in DATE_FIELDS}
        result = self.update()
        self.assertEqual(result['status'], 'VERIFIED')
        self.assertEqual(result['dates'], self.desired)
        self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 1)
        self.assertEqual({c[1] for c in self.session.calls if c[0] == 'set-date'}, set(self.desired))
        self.assertFalse(any(c[0] in {'set-sd', 'set-comment'} for c in self.session.calls))
        accessed = [str(call.args[0]) for call in self.session.FindById.call_args_list]
        self.assertFalse(any('_ACTDAT' in control or '_SDCONF' in control or '_SDCOMMENT' in control for control in accessed))

    def test_only_edited_fields_are_written(self):
        self.desired = dict(self.original, mPlanDate='2026-12-30')
        self.update()
        self.assertEqual([c[1] for c in self.session.calls if c[0] == 'set-date'], ['mPlanDate'])

    def test_all_permissions_checked_before_any_setter(self):
        self.session.dates[DATE_FIELDS[-1].control_id].Changeable = False
        with self.assertRaises(ApqpDateIssue) as caught: self.update()
        self.assertEqual(caught.exception.code, 'APQP_DATE_READ_ONLY')
        self.assertIn('M_PLNDAT', caught.exception.details)
        self.assertFalse(any(c[0] in {'set-date', 'save'} for c in self.session.calls))

    def test_wrong_identity_and_conflict_never_input_or_save(self):
        for mode in ('identity', 'conflict', 'clear'):
            self.setUp()
            if mode == 'identity': self.session.wrong_detail = True
            if mode == 'conflict': self.session.dates[DATE_FIELDS[0].control_id].text = '26.10.2026'
            if mode == 'clear': self.desired['gPlanDate'] = None
            with self.assertRaises(ApqpDateIssue): self.update()
            self.assertFalse(any(c[0] in {'set-date', 'save'} for c in self.session.calls))

    def test_already_applied_does_not_save_again(self):
        for field in DATE_FIELDS:
            value = self.desired[field.key]
            self.session.dates[field.control_id].text = '' if value is None else value[8:10]+'.'+value[5:7]+'.'+value[:4]
        self.assertEqual(self.update()['status'], 'UNCHANGED')
        self.assertFalse(any(c[0] == 'save' for c in self.session.calls))

    def test_stop_after_input_never_saves_or_goes_back(self):
        self.session.on_set = self.stop.set
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertIn('STAGED_UNSAVED', [c[0] for c in self.checkpoints])
        self.assertFalse(any(c[0] in {'save', 'back'} for c in self.session.calls))

    def test_save_confirmation_and_ppap_question_are_recognized_once(self):
        for question in ('Do you want to save the APQP data?', 'Is the PPAP Level correctly selected?'):
            self.setUp(); self.session.save_question = question
            self.assertEqual(self.update()['status'], 'VERIFIED')
            self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 1)
            self.assertEqual(sum(c[0] == 'save-yes' for c in self.session.calls), 1)

    def test_custom_step_question_body_is_read_not_title_only(self):
        self.session.save_question = 'Is the PPAP Level correctly selected?'
        original_find = self.session.find
        def find(identifier, required=True):
            if self.session.popup and identifier == 'wnd[1]':
                child = SimpleNamespace(Text=self.session.save_question, Children=None)
                return SimpleNamespace(Text='STEP', Children=SimpleNamespace(Count=1, __call__=lambda _: child))
            return original_find(identifier, required)
        # Standard message control remains available, as in the recorded question.
        self.session.FindById.side_effect = find
        self.assertEqual(self.update()['status'], 'VERIFIED')

    def test_unknown_delete_and_repeated_save_dialogs_never_blindly_confirm(self):
        for question in ('Unknown STEP', 'Save and delete the record?'):
            self.setUp(); self.session.save_question = question
            with self.assertRaises(ApqpDateIssue) as caught: self.update()
            self.assertEqual(caught.exception.code, 'APQP_SAVE_OUTCOME_UNCERTAIN')
            self.assertFalse(any(c[0] == 'save-yes' for c in self.session.calls))
        self.setUp(); self.session.save_question = 'Is the PPAP Level correctly selected?'
        self.session.confirm_save = lambda: self.session.calls.append(('save-yes',))  # Remains open.
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertEqual(sum(c[0] == 'save-yes' for c in self.session.calls), 1)

    def test_save_com_failure_is_not_replayed(self):
        def broken():
            self.session.calls.append(('save',)); raise RuntimeError('COM outcome unknown')
        self.session.save = broken
        with self.assertRaises(ApqpDateIssue) as caught: self.update()
        self.assertEqual(caught.exception.code, 'APQP_SAVE_OUTCOME_UNCERTAIN')
        self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 1)

    def test_committed_values_are_reopened_not_edit_buffer(self):
        self.session.on_save = lambda: self.session.values['2000000000'].__setitem__(0, '')
        with self.assertRaises(ApqpDateIssue) as caught: self.update()
        self.assertEqual(caught.exception.code, 'APQP_SAVE_OUTCOME_UNCERTAIN')
        self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 1)

    def test_post_input_warning_stops_without_save(self):
        self.session.on_set = lambda: setattr(self.session.status, 'MessageType', 'W')
        self.session.status.Text = 'Record warning'
        with self.assertRaises(ApqpDateIssue): self.update()
        self.assertFalse(any(c[0] == 'save' for c in self.session.calls))

    def test_save_status_error_and_wrong_environment_never_replay(self):
        def rejected():
            self.session.status.MessageType, self.session.status.Text = 'E', 'Save rejected'
        self.session.on_save = rejected
        with self.assertRaises(ApqpDateIssue) as caught: self.update()
        self.assertEqual(caught.exception.code, 'APQP_SAVE_OUTCOME_UNCERTAIN')
        self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 1)
        self.assertFalse(any(c[0] == 'back' for c in self.session.calls))
        for system, client in [('VCE', '100'), ('CEQ', '949')]:
            self.setUp()
            self.reader.identity = (self.reader.identity[0], system, client, self.reader.identity[3])
            with self.assertRaises(ApqpDateIssue): self.update()
            self.assertFalse(any(c[0] in {'set-date', 'save'} for c in self.session.calls))

    def test_authorization_not_falsely_claimed_as_live_acceptance(self):
        self.assertFalse(write_policy()['stageOnly'])
        self.assertTrue(date_update.writes_enabled('PROD'))
        self.assertTrue(date_update.writes_enabled('QA'))
        self.assertFalse(write_policy()['qaSaveAcceptancePassed'])
        self.assertFalse(write_policy()['productionSaveAcceptancePassed'])

    def test_legacy_input_only_primitive_remains_no_save_for_diagnostics(self):
        self.assertEqual(self.update(stage_only=True)['status'], 'STAGED')
        self.assertFalse(any(c[0] in {'save', 'save-yes', 'back'} for c in self.session.calls))


class PlannedBatchTests(unittest.TestCase):
    def setUp(self):
        self.session = WritableSession(count=3, system='VCE')
        self.stop, self.events, self.checkpoints = threading.Event(), [], []
        self.app = application(self.session)
        self.query = dict(project='775773', userId='EE00221', environment='PROD')
        self.originals = [dict(apqp=row[0], material=row[1], vendor=row[2], plant=row[3], project=row[4],
            dates=dict(fPlanDate=None, gPlanDate='2026-10-20', hPlanDate='2026-12-25', mPlanDate=None),
            editable={field.key: True for field in DATE_FIELDS}, readable=True) for row in self.session.grid.rows]
        self.edits = [dict(apqp=r['apqp'], dates=dict(r['dates'], fPlanDate='2026-10-27')) for r in self.originals]
        self.binding = dict(sessionId=self.session.Id, system='VCE', client='100', sapUser='MOCK_SAP_LOGIN')

    def call(self):
        return run(dict(action='execute', query=self.query, originals=self.originals, edits=self.edits, session=self.binding),
            legacy, self.app, self.stop, lambda event, **data: self.events.append((event, data)), lambda _: None,
            lambda event, **data: self.checkpoints.append((event, data)))

    def configure(self, callback):
        original = self.session.execute
        def execute():
            opening = self.session.state == 'grid'
            original()
            if opening: callback(int(self.session.grid.SelectedRows))
        self.session.execute = execute

    def test_batch_saves_each_record_once_and_verifies_all(self):
        result = self.call()
        self.assertEqual(result['update']['succeeded'], 3)
        self.assertEqual(result['update']['savedFields'], 3)
        self.assertEqual(result['update']['failed'], 0)
        self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 3)
        self.assertEqual(sum(e[0] == 'UPDATE_VERIFIED' for e in self.checkpoints), 3)
        self.assertTrue(all(row['saved'] for row in result['records']))
        self.assertEqual(self.session.state, 'grid')

    def test_saved_field_count_excludes_unchanged_fields_and_readonly_skips(self):
        self.edits[1]['dates']['mPlanDate'] = '2026-12-30'
        self.configure(lambda i: setattr(self.session.dates[DATE_FIELDS[0].control_id], 'Changeable', i != 0))
        result = self.call()
        self.assertEqual(result['update']['succeeded'], 2)
        self.assertEqual(result['update']['savedFields'], 3)
        self.assertEqual([r['changedFieldsSaved'] for r in result['records']], [2, 1])

    def test_readonly_first_skips_untouched_and_saves_the_other_two(self):
        self.configure(lambda i: setattr(self.session.dates[DATE_FIELDS[0].control_id], 'Changeable', i != 0))
        result = self.call()
        self.assertEqual(result['update']['succeeded'], 2)
        self.assertEqual(result['update']['failed'], 1)
        self.assertEqual(result['update']['issues'][0]['code'], 'APQP_DATE_READ_ONLY')
        self.assertEqual(result['update']['issues'][0]['navigation'], 'RETURNED_UNCHANGED')
        self.assertEqual(self.session.values['2000000000'][0], '')
        self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 2)

    def test_all_grey_records_have_reasons_and_zero_save(self):
        self.configure(lambda _: setattr(self.session.dates[DATE_FIELDS[0].control_id], 'Changeable', False))
        result = self.call()
        self.assertEqual(result['update']['failed'], 3)
        self.assertEqual(result['update']['succeeded'], 0)
        self.assertFalse(any(c[0] in {'set-date', 'save'} for c in self.session.calls))

    def test_preinput_warning_or_error_skips_then_continues(self):
        for kind in ('W', 'E'):
            self.setUp()
            def status(i):
                self.session.status.MessageType = kind if i == 0 else ''
                self.session.status.Text = 'Blocked' if i == 0 else ''
            self.configure(status)
            result = self.call()
            self.assertEqual(result['update']['failed'], 1)
            self.assertEqual(result['update']['succeeded'], 2)

    def test_invalid_clear_skips_without_opening_and_saves_others(self):
        self.edits[0]['dates']['gPlanDate'] = None
        result = self.call()
        self.assertEqual(result['update']['issues'][0]['navigation'], 'NOT_OPENED')
        self.assertEqual(result['update']['succeeded'], 2)

    def test_conflict_is_not_overwritten_and_other_records_continue(self):
        self.session.values['2000000000'][0] = '26.10.2026'
        result = self.call()
        self.assertEqual(result['update']['issues'][0]['code'], 'APQP_DATE_CONFLICT')
        self.assertEqual(result['update']['succeeded'], 2)
        self.assertEqual(self.session.values['2000000000'][0], '26.10.2026')

    def test_execution_navigates_from_another_tcode_or_clean_detail(self):
        for state, transaction in (('other', 'ME11'), ('selection', legacy.TCODE), ('detail', legacy.TCODE)):
            self.setUp(); self.session.state, self.session.Info.Transaction = state, transaction
            result = self.call()
            self.assertEqual(result['update']['succeeded'], 3)
            self.assertEqual(sum(c[0] == 'navigate' for c in self.session.calls), 1)

    def test_navigation_never_chooses_save_or_discard(self):
        self.session.state, self.session.Info.Transaction = 'other', 'ME11'
        def prompt(_):
            self.session.calls.append(('navigate',)); self.session.popup = True
        self.session.StartTransaction.side_effect = prompt
        with self.assertRaises(ApqpDateIssue): self.call()
        self.assertFalse(any(c[0] in {'save', 'save-yes', 'no', 'set-date'} for c in self.session.calls))
        self.assertEqual(sum(c[0] == 'navigate' for c in self.session.calls), 1)

    def test_existing_result_on_unrelated_filters_is_queried_again_once(self):
        rows = self.session.grid.rows
        self.session.grid.rows = []  # Current APQP list is unrelated to the stored query.
        start = self.session.start
        def original_scope(transaction):
            start(transaction)
            self.session.grid.rows = rows
        self.session.StartTransaction.side_effect = original_scope
        result = self.call()
        self.assertEqual(result['update']['succeeded'], 3)
        self.assertEqual(sum(c[0] == 'navigate' for c in self.session.calls), 1)

    def test_locator_uses_id_not_stale_row_and_rejects_duplicates(self):
        self.session.grid.rows.reverse()
        self.assertEqual(self.call()['update']['succeeded'], 3)
        self.setUp(); self.session.grid.rows[1][0] = self.session.grid.rows[0][0]
        with self.assertRaises(ApqpDateIssue): self.call()
        self.assertFalse(any(c[0] in {'save', 'set-date'} for c in self.session.calls))

    def test_original_account_or_session_change_never_rebinds(self):
        self.session.Info.User = 'OTHER'
        with self.assertRaises(ApqpDateIssue): self.call()
        self.assertFalse(any(c[0] == 'save' for c in self.session.calls))

    def test_partial_input_failure_never_skips_or_saves(self):
        def ambiguous(): raise RuntimeError('setter outcome unknown')
        self.session.on_set = ambiguous
        with self.assertRaises(RuntimeError): self.call()
        self.assertEqual(sum(c[0] == 'set-date' for c in self.session.calls), 1)
        self.assertFalse(any(c[0] in {'save', 'back'} for c in self.session.calls))
        self.assertIn('STAGED_UNSAVED', [e[0] for e in self.checkpoints])

    def test_unknown_save_dialog_stops_before_next_record(self):
        self.session.save_question = 'Unknown STEP'
        with self.assertRaises(ApqpDateIssue) as caught: self.call()
        self.assertEqual(caught.exception.code, 'APQP_SAVE_OUTCOME_UNCERTAIN')
        self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 1)
        self.assertFalse(any(c[0] == 'save-yes' for c in self.session.calls))

    def test_stop_after_save_verifies_current_record_without_starting_next(self):
        self.session.on_save = self.stop.set
        result = self.call()
        self.assertTrue(result['update']['cancelled'])
        self.assertEqual(result['update']['succeeded'], 1)
        self.assertEqual(sum(c[0] == 'save' for c in self.session.calls), 1)

    def test_stop_between_skips_never_opens_next_record(self):
        self.configure(lambda _: setattr(self.session.dates[DATE_FIELDS[0].control_id], 'Changeable', False))
        original = self.session.back
        def stop_back(): original(); self.stop.set()
        self.session.back = stop_back
        with self.assertRaises(ApqpDateIssue): self.call()
        self.assertEqual(sum(c == ('execute', 'grid') for c in self.session.calls), 1)

    def test_unsafe_return_or_concurrent_edit_stops_instead_of_skipping(self):
        self.configure(lambda _: setattr(self.session.dates[DATE_FIELDS[0].control_id], 'Changeable', False))
        self.session.unknown_return_popup = True
        with self.assertRaises(ApqpDateIssue): self.call()
        self.assertEqual(sum(c == ('execute', 'grid') for c in self.session.calls), 1)

    def test_old_actual_date_snapshot_is_rejected_before_sap(self):
        self.originals[0]['dates']['gActualDate'] = self.originals[0]['dates'].pop('fPlanDate')
        with self.assertRaises(ApqpDateIssue) as caught: self.call()
        self.assertEqual(caught.exception.code, 'APQP_DATE_SCHEMA_CHANGED')
        self.assertEqual(self.session.calls, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
