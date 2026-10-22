"""Buyer Receipt save-question queue regression tests. No SAP or Excel writes."""
import contextlib
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rfq_fixture', Path(__file__).with_name('test-rfq-integration.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
engine = fixture.engine

YES_ID = 'wnd[1]/usr/btnBUTTON_1'
NO_ID = 'wnd[1]/usr/btnBUTTON_2'


class Clock:
    def __init__(self):
        self.value = 0.0

    def now(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


def question(**overrides):
    return dict(title='Buyer Receipt : Create', yes='YES', no='NO') | overrides


class SapGui:
    """Fresh controls, reused wnd[1] ID/title, optional asynchronous next prompt."""
    def __init__(self, clock, dialogs, *, gap=0.0, busy=0.0, stuck=False):
        self.clock, self.dialogs = clock, list(dialogs)
        self.gap, self.busy_seconds, self.stuck = gap, busy, stuck
        self.visible_at = self.busy_until = 0.0
        self.Id = '/app/con[0]/ses[0]'
        self.Info = SimpleNamespace(SystemName='VCE', Client='100', User='MOCK_USER')
        self.presses, self.lookups, self.waits = [], [], 0
        self.on_press = None
        self.nested = self.read_failure = False
        self.last_lookup = None

    @property
    def Busy(self):
        return self.clock.now() < self.busy_until

    def press_yes(self):
        # This assertion catches stale cached controls / intervening tree reads.
        assert self.last_lookup == YES_ID
        assert not self.Busy
        self.presses.append(YES_ID)
        if not self.stuck:
            self.dialogs.pop(0)
        self.visible_at = self.clock.now() + self.gap
        self.busy_until = self.clock.now() + self.busy_seconds
        if self.on_press:
            self.on_press()

    def FindById(self, identifier, required=True):
        self.lookups.append(identifier)
        self.last_lookup = identifier
        if self.read_failure:
            raise RuntimeError('COM read failed')
        if identifier == 'wnd[2]':
            control = SimpleNamespace(Text='Unknown nested question') if self.nested else None
        elif not self.dialogs or self.clock.now() < self.visible_at:
            control = None
        else:
            modal = self.dialogs[0]
            controls = {'wnd[1]': SimpleNamespace(Text=modal['title'])}
            if modal.get('yes') is not None:
                controls[YES_ID] = SimpleNamespace(Text=modal['yes'], Press=self.press_yes)
            if modal.get('no') is not None:
                controls[NO_ID] = SimpleNamespace(Text=modal['no'])
            if modal.get('continue'):
                controls['wnd[1]/tbar[0]/btn[0]'] = SimpleNamespace(Text='Continue')
            if modal.get('question'):
                controls['wnd[1]/usr/lbl[1,2]'] = SimpleNamespace(Text=modal['question'])
            control = controls.get(identifier)
        if control is None and required:
            raise RuntimeError('Control not found: ' + identifier)
        return control


class BuyerSaveTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.enterContext(patch.object(engine.time, 'monotonic', self.clock.now))
        self.enterContext(patch.object(engine.time, 'time', self.clock.now))
        self.enterContext(patch.object(engine.time, 'sleep', self.clock.sleep))
        self.enterContext(patch.object(engine, 'BUYER_SAVE_CONFIRM_TIMEOUT_SEC', 1.0))
        self.enterContext(patch.object(engine, 'BUYER_SAVE_QUEUE_TIMEOUT_SEC', 10.0))
        self.enterContext(patch.object(engine, 'BUYER_SAVE_CONFIRMATION_LIMIT', 500))
        self.enterContext(patch.object(engine, 'SAP_POLL_SEC', 0.05))
        self.enterContext(patch.object(engine, 'REQUIRE_BUYER_SAVE_CONFIRMATION', True))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def sap(self, dialogs, **options):
        sap = engine.SapSession.__new__(engine.SapSession)
        sap.session = SapGui(self.clock, dialogs, **options)
        sap.window_text = lambda identifier: 'popup diagnostic'
        sap.popup_grid_rows = lambda identifier: [{'MESSAGE': 'Missing purchasing master data'}]
        return sap

    def test_single_and_many_identical_questions_are_not_three_retries(self):
        for count in (1, 4, 10, 50, 100):
            with self.subTest(count=count):
                sap = self.sap([question() for _ in range(count)])
                start = self.clock.now()
                self.assertTrue(sap.wait_and_confirm_buyer_receipt_save())
                self.assertEqual(sap.session.presses, [YES_ID] * count)
                self.assertEqual(sap.session.dialogs, [])
                self.assertLess(self.clock.now() - start, count * 0.06 + 0.4)

    def test_temporary_absence_and_busy_between_questions_do_not_end_queue(self):
        sap = self.sap([question() for _ in range(8)], gap=0.15, busy=0.10)
        self.assertTrue(sap.wait_and_confirm_buyer_receipt_save())
        self.assertEqual(len(sap.session.presses), 8)

    def test_waits_for_initial_delayed_question(self):
        sap = self.sap([question()])
        sap.session.visible_at = 0.4
        self.assertTrue(sap.wait_and_confirm_buyer_receipt_save())
        self.assertEqual(len(sap.session.presses), 1)

    def test_business_message_before_or_after_yes_keeps_recovery_stage(self):
        message = {'title': 'Message Display', 'continue': True}
        for prefix in ([], [question(), question(), question(), question()]):
            with self.subTest(confirmed=len(prefix)):
                sap = self.sap(prefix + [message])
                with self.assertRaises(engine.SapRpaError) as error:
                    sap.wait_and_confirm_buyer_receipt_save()
                self.assertEqual(error.exception.stage, 'BUYER_RECEIPT_SAVE_POPUP')
                self.assertIn('Missing purchasing master data', str(error.exception))
                self.assertEqual(len(sap.session.presses), len(prefix))

    def test_unknown_questions_and_misleading_buttons_are_not_confirmed(self):
        cases = [
            dict(title='Delete record', yes='YES', no='NO'),
            dict(title='License information for multiple logons', yes='YES', no='NO'),
            dict(title='Buyer Receipt : Create', yes='Delete', no='Cancel'),
            dict(title='Buyer Receipt : Create', yes='YES', no=None),
            dict(title='Buyer Receipt : Delete', yes='YES', no='NO'),
            dict(title='Buyer Receipt : Create', question='Discard changes?', yes='YES', no='NO'),
            dict(title='Buyer Receipt : Create', question='Delete this entry and save?', yes='YES', no='NO'),
            dict(title='Question', yes='YES', no='NO'),
        ]
        for modal in cases:
            for prefix in ([], [question()]):
                with self.subTest(modal=modal, prefix=bool(prefix)):
                    sap = self.sap(prefix + [modal])
                    with self.assertRaises(engine.SapRpaError):
                        sap.wait_and_confirm_buyer_receipt_save()
                    self.assertEqual(len(sap.session.presses), len(prefix))

    def test_recognizes_save_title_and_localized_exact_yes_no(self):
        for modal in (dict(title='Save', yes='&Yes', no='&No'),
                      dict(title='Buyer Receipt : Create', yes='是(&Y)', no='否(&N)'),
                      dict(title='Question', question='Do you want to save?', yes='YES', no='NO')):
            with self.subTest(modal=modal):
                sap = self.sap([modal])
                self.assertTrue(sap.wait_and_confirm_buyer_receipt_save())
                self.assertEqual(sap.session.presses, [YES_ID])

    def test_ambiguous_press_error_is_not_replayed(self):
        sap = self.sap([question(), question()])
        def fail_after_dispatch():
            raise RuntimeError('COM disconnected after Press')
        sap.session.on_press = fail_after_dispatch
        with self.assertRaises(engine.SapRpaError) as error:
            sap.wait_and_confirm_buyer_receipt_save()
        self.assertIn('不会重放Save', str(error.exception))
        self.assertEqual(sap.session.presses, [YES_ID])
        self.assertEqual(len(sap.session.dialogs), 1)

    def test_changed_session_identity_stops_before_next_yes(self):
        for field in ('Id', 'SystemName', 'Client', 'User'):
            with self.subTest(field=field):
                sap = self.sap([question(), question()])
                def change_identity():
                    setattr(sap.session if field == 'Id' else sap.session.Info, field, 'CHANGED')
                sap.session.on_press = change_identity
                with self.assertRaises(engine.SapRpaError):
                    sap.wait_and_confirm_buyer_receipt_save()
                self.assertEqual(sap.session.presses, [YES_ID])

    def test_unreadable_modal_state_does_not_look_like_closed_window(self):
        sap = self.sap([question(), question()])
        sap.session.on_press = lambda: setattr(sap.session, 'read_failure', True)
        with self.assertRaises(engine.SapRpaError):
            sap.wait_and_confirm_buyer_receipt_save()
        self.assertEqual(sap.session.presses, [YES_ID])

    def test_extra_modal_is_never_clicked_through(self):
        sap = self.sap([question()])
        sap.session.nested = True
        with self.assertRaises(engine.SapRpaError):
            sap.wait_and_confirm_buyer_receipt_save()
        self.assertEqual(sap.session.presses, [])

    def test_stuck_known_prompt_has_count_and_time_safety_bounds(self):
        for limit, timeout in ((5, 10.0), (500, 0.21)):
            with self.subTest(limit=limit, timeout=timeout):
                sap = self.sap([question()], stuck=True)
                with patch.object(engine, 'BUYER_SAVE_CONFIRMATION_LIMIT', limit), \
                        patch.object(engine, 'BUYER_SAVE_QUEUE_TIMEOUT_SEC', timeout):
                    with self.assertRaises(engine.SapRpaError) as error:
                        sap.wait_and_confirm_buyer_receipt_save()
                self.assertIn('安全上限', str(error.exception))
                self.assertLessEqual(len(sap.session.presses), 5)

    def test_no_confirmation_is_only_optional_when_explicitly_configured(self):
        with self.assertRaises(engine.SapRpaError):
            self.sap([]).wait_and_confirm_buyer_receipt_save()
        with patch.object(engine, 'REQUIRE_BUYER_SAVE_CONFIRMATION', False):
            self.assertFalse(self.sap([]).wait_and_confirm_buyer_receipt_save())
            sap = self.sap([dict(title='Delete', yes='YES', no='NO')])
            with self.assertRaises(engine.SapRpaError):
                sap.wait_and_confirm_buyer_receipt_save()
            self.assertEqual(sap.session.presses, [])

    def test_real_save_boundary_presses_save_once_then_verifies_each_material(self):
        tasks = [SimpleNamespace(material=str(1000 + row), buyer_receipt_row=row) for row in range(6)]
        sap = self.sap([question() for _ in tasks])
        grid = object()
        with patch.object(sap, 'select_rows') as select_rows, \
                patch.object(sap, 'press') as save, \
                patch.object(sap, 'raise_on_status_error') as check_status, \
                patch.object(sap, 'wait_grid_columns', return_value=grid), \
                patch.object(sap, 'map_material_rows', return_value=({t.material: [row] for row, t in enumerate(tasks)}, {})), \
                patch.object(engine, 'green_status_debug', return_value=(True, 'green')) as green:
            successful, debug, current = engine.save_buyer_receipt(sap, grid, tasks)
        self.assertEqual(successful, tasks)
        self.assertEqual(len(debug), len(tasks))
        self.assertIs(current, grid)
        select_rows.assert_called_once_with(grid, list(range(len(tasks))))
        save.assert_called_once_with(engine.ID_SAVE)
        check_status.assert_called_once_with('BUYER_RECEIPT_SAVE')
        self.assertEqual(green.call_count, len(tasks))
        self.assertEqual(sap.session.presses, [YES_ID] * len(tasks))


if __name__ == '__main__':
    unittest.main(argv=[__file__], verbosity=2)
