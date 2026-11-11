import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources' / 'rpa'))
import mm02_sub_commodity as mm02


class Field:
    def __init__(self, text='', changeable=True, focus=None):
        self.Text, self.Changeable, self.focus = text, changeable, focus

    def SetFocus(self):
        if self.focus:
            self.focus(self)


class Table:
    def __init__(self, count, visible=None, maximum=0, reported=None):
        self.RowCount = count if reported is None else reported
        self.VisibleRowCount = count if visible is None else visible
        self.VerticalScrollbar = SimpleNamespace(Position=0, Maximum=maximum)
        self.rows = [SimpleNamespace(Selected=False) for _ in range(count)]

    def GetAbsoluteRow(self, index):
        return self.rows[index]


class RebuildingScrollbar:
    def __init__(self, requests, mode):
        self.Maximum = 1
        self.requests, self.mode = requests, mode

    @property
    def Position(self):
        return 0

    @Position.setter
    def Position(self, value):
        self.requests.append(value)
        if self.mode != 'unstable':
            self.Maximum = 0
        if self.mode == 'reject':
            raise RuntimeError('Requested scrollbar position is no longer allowed')


class InsertedScrollbar:
    def __init__(self, sap):
        self.sap, self._position, self.Maximum = sap, 1, 3

    @property
    def Position(self):
        return self._position

    @Position.setter
    def Position(self, value):
        self.sap.class_scroll_requests.append(value)
        self._position = value
        if value == 0:
            # Match the failing live behavior: leaving the auto-scrolled
            # viewport closes the draft entry slots before any text is entered.
            self.Maximum = 1
            for field in self.sap.classes:
                if not mm02.input_text(field):
                    field.Text, field.Changeable = '_' * 18, False


def button(action):
    return SimpleNamespace(Press=action)


class Collection:
    def __init__(self, items):
        self.items, self.Count = items, len(items)

    def __call__(self, index):
        return self.items[index]


class ValueHelpTree:
    Type, SubType = 'GuiShell', 'Tree'

    def __init__(self, rows):
        self.rows = rows

    def GetColumnNames(self):
        return Collection(['&Hierarchy', 'C         11', 'C         13'])

    def GetColumnTitleFromName(self, name):
        return {'&Hierarchy': 'Value Hierarchy for Char. P&SM Commodity code',
                'C         11': 'Description', 'C         13': 'Text'}[name]

    def GetAllNodeKeys(self):
        return Collection(list(range(len(self.rows))))

    def GetNodeTextByKey(self, key):
        return self.rows[key][0]

    def GetItemText(self, key, name):
        assert name == 'C         11'
        return self.rows[key][1]


class Sap:
    Busy = False
    Id = '/app/con[0]/ses[0]'

    def __init__(self, labels=('Main Commodity', 'Sub-commodity'), class_missing=False,
                 persist=True, warning=False, locked=False, organization=False,
                 assignments=None, class_layout=None, general_layout=None, heading=False, stuck=False, sort=False,
                 rebuild_classes=None, rebuild_general=None, recorded=False, insert_tooltip='Insert Row',
                 value_help_rows=None, help_title='P&SM Commodity code', auto_scroll_insert=False,
                 changed_anchor_after_insert=False):
        self.Info = SimpleNamespace(SystemName='VCE', Client='100', User='TEST', Transaction='SESSION_MANAGER')
        self.screen = 'home'
        self.saved = '390105'
        self.class_exists = not class_missing
        self.labels, self.persist, self.warning = labels, persist, warning
        self.locked, self.organization = locked, organization
        self.assignments = list(assignments) if assignments is not None else [mm02.CLASS_NAME if self.class_exists else '']
        self.class_layout, self.general_layout = class_layout or {}, general_layout or {}
        self.heading, self.stuck, self.sort = heading, stuck, sort
        self.rebuild_classes, self.rebuild_general = rebuild_classes, rebuild_general
        self.recorded, self.insert_tooltip = recorded, insert_tooltip
        self.auto_scroll_insert, self.changed_anchor_after_insert = auto_scroll_insert, changed_anchor_after_insert
        self.value_help_rows, self.help_title = value_help_rows, help_title
        self.help_open, self.help_opens, self.help_cancels = False, 0, 0
        self.focused_value = None
        self.assignment_inserts, self.general_inserts = 0, 0
        self.class_scroll_requests, self.general_scroll_requests = [], []
        self.command, self.material = Field(), Field()
        self.bar = SimpleNamespace(MessageType='', Text='')
        self.saves, self.opens, self.view_confirmations = 0, 0, 0
        self.reopened_materials = []

    def enter(self, key):
        if key == 4:
            assert self.screen == 'classification' and self.focused_value in self.values
            self.help_open = True
            self.help_opens += 1
            return
        assert key == 0
        if self.command.Text == '/nMM02':
            self.opens += 1
            self.screen = 'entry'
            self.command.Text = ''
            self.Info.Transaction = 'MM02'
            self.bar.MessageType = self.bar.Text = ''
            self.material = Field()
        elif self.screen == 'entry':
            if self.locked:
                self.bar.MessageType, self.bar.Text = 'E', 'Material is locked.'
                return
            self.reopened_materials.append(self.material.Text)
            self.screen = 'views'
        elif self.screen == 'classification' and self.focused is not None:
            if not self.stuck:
                self.active_class = self.focused.Text
            if self.sort:
                self.classes.sort(key=lambda field: (not field.Text, field.Text))
            for i, field in enumerate(self.classes):
                self.class_table.GetAbsoluteRow(i).Selected = field is self.focused and not self.heading

    def open_class(self):
        self.screen = 'classification'
        self.focused = None
        self.classes = [Field(text, not (self.recorded and text.startswith('_')), focus=lambda field: setattr(self, 'focused', field))
                        for text in self.assignments]
        self.active_class = next((field.Text for field in self.classes if field.Text), '')
        self.class_table = Table(len(self.classes), **self.class_layout)
        self.char_table = Table(len(self.labels), **self.general_layout)
        if self.rebuild_classes:
            self.class_table.VerticalScrollbar = RebuildingScrollbar(self.class_scroll_requests, self.rebuild_classes)
        if self.rebuild_general:
            self.char_table.VerticalScrollbar = RebuildingScrollbar(self.general_scroll_requests, self.rebuild_general)
        saved_display = dict(self.value_help_rows or []).get(self.saved, self.saved)
        self.values = [Field(saved_display if mm02.is_sub_commodity(label) else '999999' if label else '',
                             focus=lambda field: setattr(self, 'focused_value', field)) for label in self.labels]

    def cancel_help(self):
        self.help_open = False
        self.help_cancels += 1

    def insert_assignment(self):
        self.assignment_inserts += 1
        for field in self.classes:
            if not mm02.input_text(field):
                field.Text, field.Changeable = '', True
        if self.auto_scroll_insert:
            if self.changed_anchor_after_insert:
                self.classes[1].Text = 'CHANGED_CLASS'
            while len(self.classes) < 6:
                self.classes.append(Field('', focus=lambda field: setattr(self, 'focused', field)))
                self.class_table.rows.append(SimpleNamespace(Selected=False))
            self.class_table.RowCount = 6
            self.class_table.VerticalScrollbar = InsertedScrollbar(self)
            return
        self.class_table.RowCount = 5
        self.class_table.VerticalScrollbar = RebuildingScrollbar(self.class_scroll_requests, 'unstable')
        self.class_table.VerticalScrollbar.Maximum = 2

    def insert_general(self):
        self.general_inserts += 1
        raise AssertionError('General Insert Row must never be used for adding a class')

    def save(self):
        self.saves += 1
        if self.warning:
            self.bar.MessageType, self.bar.Text = 'W', 'Manual review required.'
        else:
            if self.persist:
                self.saved = next(self.values[i].Text for i, label in enumerate(self.labels) if mm02.is_sub_commodity(label))
                self.assignments = [field.Text for field in self.classes]
                self.class_exists = mm02.CLASS_NAME in self.assignments
            self.bar.MessageType, self.bar.Text = 'S', 'Material changed.'

    def GetObjectTree(self, _root, _properties):
        if not self.heading:
            raise AttributeError('GetObjectTree unavailable')
        return json.dumps({'children': [{'properties': {'Text': f'Values for Class {self.active_class} - Object {self.material.Text}'}}]})

    def accept_view(self):
        self.view_confirmations += 1
        self.screen = 'org' if self.organization else 'detail'

    def FindById(self, name, _strict=False):
        common = {'wnd[0]': SimpleNamespace(SendVKey=self.enter), 'wnd[0]/sbar': self.bar, 'wnd[0]/tbar[0]/okcd': self.command}
        if name in common:
            return common[name]
        if self.screen == 'entry':
            return self.material if name == mm02.MATERIAL else None
        if self.screen == 'views':
            return {'wnd[1]': Field(), mm02.VIEW: Table(3), mm02.VIEW + '/txtMSICHTAUSW-DYTXT[0,2]': Field('Recorded view'),
                    'wnd[1]/tbar[0]/btn[0]': button(self.accept_view)}.get(name)
        if self.screen == 'org':
            return {'wnd[1]': Field(), mm02.ORG: SimpleNamespace(RowCount=1),
                    'wnd[1]/tbar[0]/btn[0]': button(lambda: setattr(self, 'screen', 'detail'))}.get(name)
        if self.screen == 'detail':
            return button(self.open_class) if name == mm02.CLASSIFY else None
        if self.screen != 'classification':
            return None
        if self.help_open:
            help_controls = {'wnd[1]': Field(self.help_title), mm02.COMMODITY_HELP_TREE: ValueHelpTree(self.value_help_rows or []),
                             mm02.COMMODITY_HELP_CANCEL: SimpleNamespace(Type='GuiButton', Tooltip='Cancel   (F12)',
                                                                         Changeable=True, Press=self.cancel_help)}
            if name in help_controls:
                return help_controls[name]
        class_start = self.class_table.VerticalScrollbar.Position
        char_start = self.char_table.VerticalScrollbar.Position
        actions = {} if not self.recorded else {
            mm02.ASSIGNMENT_TOTAL: Field(str(sum(bool(mm02.input_text(field)) for field in self.classes)), False),
            mm02.ASSIGNMENT_INSERT: SimpleNamespace(Type='GuiButton', Tooltip=self.insert_tooltip, Changeable=True, Press=self.insert_assignment),
            mm02.CHARS.rsplit('/', 1)[0] + '/btnRCTMS-EINF': SimpleNamespace(Type='GuiButton', Tooltip='Insert Row', Changeable=True, Press=self.insert_general),
        }
        return {mm02.CLASSES: self.class_table, mm02.CHARS: self.char_table, mm02.SAVE: button(self.save),
                **actions,
                **{f'{mm02.CLASSES}/ctxtRMCLF-CLASS[0,{i}]': field
                   for i, field in enumerate(self.classes[class_start:class_start + self.class_table.VisibleRowCount])},
                **{f'{mm02.CHARS}/ctxtRCTMS-MNAME[0,{i}]': Field(label)
                   for i, label in enumerate(self.labels[char_start:char_start + self.char_table.VisibleRowCount]) if label is not None},
                **{f'{mm02.CHARS}/ctxtRCTMS-MWERT[1,{i}]': field
                   for i, field in enumerate(self.values[char_start:char_start + self.char_table.VisibleRowCount])}}.get(name)


class Mm02Tests(unittest.TestCase):
    def maintain(self, sap, code='012345'):
        return mm02.maintain_material(sap, mm02.session_identity(sap), '000123', code, lambda: False)

    def test_targets_named_characteristic_not_first_row_and_reopens_same_material(self):
        sap = Sap(organization=True)
        self.assertEqual(self.maintain(sap)[:2], ('success', '390105'))
        self.assertEqual((sap.saves, sap.opens, sap.saved, sap.values[0].Text), (1, 2, '012345', '999999'))
        self.assertEqual(sap.reopened_materials, ['000123', '000123'])

    def test_matching_value_and_locked_material_do_not_save(self):
        sap = Sap()
        self.assertEqual(self.maintain(sap, '390105')[0], 'skipped')
        self.assertEqual(sap.saves, 0)
        locked = Sap(locked=True)
        with self.assertRaises(mm02.RowRejected):
            self.maintain(locked)
        self.assertEqual(locked.saves, 0)

    def test_reads_real_sap_description_as_the_saved_code_and_skips_if_already_equal(self):
        sap = Sap(labels=('P&SM Commodity code', 'Release to Manufacturing Date'),
                  value_help_rows=[('1', 'Cab'), ('100001', 'Cabs, complete'), ('120407', 'Other commodity')])
        sap.saved = ''
        reader = mm02.CommodityCodeReader()
        identity = mm02.session_identity(sap)
        self.assertEqual(mm02.maintain_material(sap, identity, '000123', '100001', lambda: False, reader)[0], 'success')
        self.assertEqual(sap.values[0].Text, 'Cabs, complete')
        self.assertEqual((sap.saves, sap.help_opens, sap.help_cancels), (1, 1, 1))
        self.assertEqual(mm02.maintain_material(sap, identity, '000123', '100001', lambda: False, reader)[:2], ('skipped', '100001'))
        self.assertEqual((sap.saves, sap.help_opens, sap.help_cancels), (1, 1, 1))

    def test_ambiguous_description_or_wrong_help_does_not_trigger_a_write(self):
        ambiguous = Sap(value_help_rows=[('100001', 'Cabs, complete'), ('100002', 'Cabs, complete')])
        ambiguous.saved = '100001'
        with self.assertRaisesRegex(RuntimeError, 'could not be uniquely verified'):
            self.maintain(ambiguous, '100001')
        self.assertEqual((ambiguous.saves, ambiguous.help_cancels), (0, 1))
        wrong = Sap(value_help_rows=[('100001', 'Cabs, complete')], help_title='Unexpected popup')
        wrong.saved = '100001'
        with self.assertRaisesRegex(RuntimeError, 'did not open the verified'):
            self.maintain(wrong, '100001')
        self.assertEqual((wrong.saves, wrong.help_cancels), (0, 0))

    def test_description_for_different_saved_code_stays_unverified(self):
        sap = Sap(value_help_rows=[('390105', 'Original commodity'), ('100001', 'Cabs, complete')], persist=False)
        with self.assertRaisesRegex(mm02.SaveUncertain, 'expected 100001, read 390105'):
            self.maintain(sap, '100001')
        self.assertEqual((sap.saves, sap.help_opens, sap.help_cancels), (1, 1, 1))

    def test_missing_class_is_assigned_without_overwriting_other_classes(self):
        sap = Sap(class_missing=True)
        self.assertEqual(self.maintain(sap)[0], 'success')
        self.assertTrue(sap.class_exists)
        self.assertEqual(sap.saves, 1)

    def test_real_layout_uses_only_upper_insert_and_the_recorded_general_field(self):
        sap = Sap(assignments=['YY_PLM', '_' * 18, '_' * 18], labels=('P&SM Commodity code', 'Release to Manufacturing Date'),
                  recorded=True, heading=True, general_layout={'visible': 10, 'reported': 11}, rebuild_general='unstable')
        self.assertEqual(self.maintain(sap)[:2], ('success', '390105'))
        self.assertEqual(sap.assignments, ['YY_PLM', 'YY_COMMODITY', ''])
        self.assertEqual((sap.assignment_inserts, sap.general_inserts, sap.saves), (1, 0, 1))
        self.assertEqual((sap.saved, sap.values[1].Text), ('012345', '999999'))
        self.assertEqual((sap.class_scroll_requests, sap.general_scroll_requests), ([], []))

    def test_real_two_class_layout_preserves_saps_auto_scrolled_input_row(self):
        sap = Sap(assignments=['YY_PLM', 'YY_2541', '_' * 18], class_layout={'visible': 3, 'reported': 4, 'maximum': 1},
                  labels=('P&SM Commodity code', 'Release to Manufacturing Date'), recorded=True, heading=True,
                  auto_scroll_insert=True)
        self.assertEqual(self.maintain(sap, '120407')[0], 'success')
        self.assertEqual(sap.assignments[:3], ['YY_PLM', 'YY_2541', 'YY_COMMODITY'])
        self.assertEqual((sap.saved, sap.assignment_inserts, sap.general_inserts, sap.saves), ('120407', 1, 0, 1))
        self.assertEqual(sap.class_scroll_requests, [], 'Do not scroll away from SAP’s inserted input row')

    def test_changed_anchor_in_auto_scrolled_viewport_is_not_written(self):
        sap = Sap(assignments=['YY_PLM', 'YY_2541', '_' * 18], class_layout={'visible': 3, 'reported': 4, 'maximum': 1},
                  recorded=True, auto_scroll_insert=True, changed_anchor_after_insert=True)
        with self.assertRaisesRegex(RuntimeError, 'Existing assignments could not be verified after Insert Row'):
            self.maintain(sap, '120407')
        self.assertNotIn('YY_COMMODITY', [field.Text for field in sap.classes])
        self.assertEqual((sap.assignment_inserts, sap.saves, sap.class_scroll_requests), (1, 0, []))

    def test_same_id_with_wrong_tooltip_does_not_press_either_insert(self):
        sap = Sap(assignments=['YY_PLM', '_' * 18, '_' * 18], recorded=True, insert_tooltip='Classification')
        with self.assertRaisesRegex(RuntimeError, 'verified Assignments Insert Row button'):
            self.maintain(sap)
        self.assertEqual((sap.assignment_inserts, sap.general_inserts, sap.saves), (0, 0, 0))

    def test_duplicate_recorded_general_label_is_not_written(self):
        sap = Sap(labels=('P&SM Commodity code', 'P&SM Commodity code'))
        with self.assertRaisesRegex(RuntimeError, 'missing or ambiguous in General'):
            self.maintain(sap)
        self.assertEqual(sap.saves, 0)

    def test_screenshot_yy_plm_two_empty_rows_and_virtual_row_count(self):
        for heading in (True, False):
            sap = Sap(assignments=['YY_PLM', '', ''], class_layout={'visible': 3, 'reported': 49}, heading=heading)
            self.assertEqual(self.maintain(sap)[0], 'success')
            self.assertEqual(sap.assignments, ['YY_PLM', 'YY_COMMODITY', ''])
            self.assertEqual((sap.saved, sap.saves, sap.values[0].Text), ('012345', 1, '999999'))

    def test_finds_existing_class_and_target_field_on_later_pages(self):
        sap = Sap(assignments=['YY_PLM', 'ANOTHER_CLASS', '', 'YY_COMMODITY', ''],
                  class_layout={'visible': 3, 'reported': 49, 'maximum': 2}, heading=True,
                  labels=('Another field', 'Main Commodity', 'Description', 'Sub-commodity Code', ''),
                  general_layout={'visible': 3, 'reported': 49, 'maximum': 2})
        self.assertEqual(self.maintain(sap)[0], 'success')
        self.assertEqual(sap.assignments, ['YY_PLM', 'ANOTHER_CLASS', '', 'YY_COMMODITY', ''])
        self.assertEqual((sap.saved, sap.saves), ('012345', 1))

    def test_scroll_range_shrinks_to_zero_after_sap_refresh(self):
        for mode in ('clamp', 'reject'):
            with self.subTest(mode=mode):
                sap = Sap(assignments=['YY_PLM', '', ''], labels=('Main Commodity', 'Sub-commodity', ''),
                          heading=True, rebuild_classes=mode, rebuild_general=mode)
                self.assertEqual(self.maintain(sap)[0], 'success')
                self.assertEqual(sap.assignments, ['YY_PLM', 'YY_COMMODITY', ''])
                self.assertEqual((sap.saved, sap.saves), ('012345', 1))
                self.assertEqual(sap.class_scroll_requests, [1, 1])
                self.assertEqual(sap.general_scroll_requests, [1, 1])

    def test_scroll_retries_are_bounded_and_explain_the_requested_position(self):
        sap = Sap(assignments=['YY_PLM', '', ''], rebuild_classes='unstable')
        with self.assertRaisesRegex(mm02.ClassificationViewportChanged, r'Assignments: requested=1, position=0, maximum=1, visible=3, reportedRows=3'):
            self.maintain(sap)
        self.assertEqual(sap.class_scroll_requests, [1, 1])
        self.assertEqual([field.Text for field in sap.classes], ['YY_PLM', '', ''])
        self.assertEqual(sap.saves, 0)

    def test_class_resorting_is_verified_but_wrong_active_pane_never_saves(self):
        sap = Sap(assignments=['YY_PLM', '', ''], class_layout={'visible': 3, 'reported': 49}, heading=True, sort=True)
        self.assertEqual(self.maintain(sap)[0], 'success')
        self.assertEqual(sap.assignments, ['YY_COMMODITY', 'YY_PLM', ''])
        stuck = Sap(assignments=['YY_PLM', '', ''], heading=True, stuck=True)
        with self.assertRaisesRegex(RuntimeError, 'General area is showing YY_PLM'):
            self.maintain(stuck)
        self.assertEqual(stuck.saves, 0)

    def test_unreadable_interior_characteristic_is_not_treated_as_padding(self):
        sap = Sap(labels=('Commodity', None, 'Sub-commodity'), general_layout={'visible': 3, 'reported': 49})
        with self.assertRaisesRegex(RuntimeError, 'unreadable row between controls'):
            self.maintain(sap)
        self.assertEqual(sap.saves, 0)

    def test_missing_or_ambiguous_characteristic_never_saves(self):
        for labels in [('Commodity', 'Other'), ('Sub-commodity', 'Sub commodity')]:
            sap = Sap(labels=labels)
            with self.assertRaisesRegex(RuntimeError, 'Exactly one Sub-commodity'):
                self.maintain(sap)
            self.assertEqual(sap.saves, 0)

    def test_warning_and_false_ack_stop_without_save_replay(self):
        for kwargs in [dict(persist=False), dict(warning=True)]:
            sap = Sap(**kwargs)
            with self.assertRaises(mm02.SaveUncertain):
                self.maintain(sap)
            self.assertEqual(sap.saves, 1)

    def test_unknown_save_keeps_completed_results_and_marks_remaining_not_processed(self):
        from openpyxl import load_workbook
        tasks = [dict(material=f'00012{i}', subCommodity='012345', excelRows=[i + 2]) for i in range(3)]
        fake = Sap()
        with tempfile.TemporaryDirectory() as temp, redirect_stdout(io.StringIO()) as output:
            directory = Path(temp)
            (directory / 'mm02-input.json').write_text(json.dumps(tasks), encoding='utf-8')
            with patch.object(mm02, 'connect', return_value=fake), patch.object(mm02, 'maintain_material', side_effect=[
                ('success', '390105', '=should remain text'), mm02.SaveUncertain('Check the saved value')]):
                mm02.run(directory, SimpleNamespace(stop_event=SimpleNamespace(is_set=lambda: False)))
            final = json.loads(output.getvalue().splitlines()[-1].removeprefix('MM02_EVENT '))
            self.assertEqual((final['succeeded'], final['failed'], final['errorCode']), (1, 1, 'MM02_SAVE_UNVERIFIED'))
            workbook = load_workbook(directory / 'MM02_Sub_commodity_Result.xlsx')
            self.assertEqual(workbook.active['B2'].value, '012345')
            self.assertEqual(workbook.active['F2'].data_type, 's')
            self.assertEqual(workbook.active['E4'].value, 'not processed')
            workbook.close()


if __name__ == '__main__':
    unittest.main()
