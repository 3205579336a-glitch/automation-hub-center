"""Offline multi-selection carry-over regression. No SAP/clipboard access."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources' / 'rpa'))
sys.argv = [sys.argv[0], '--hub', '--validate-only']
import rfq_engine as engine


def group(materials, supplier='54955'):
    return engine.TaskGroup(key=supplier, tasks=[
        SimpleNamespace(material=material, plant='C100', project='775773', vendors=[supplier])
        for material in materials])


class QuerySession(engine.SapSession):
    """Model SAP retaining select-options and appending clipboard imports."""
    def __init__(self):
        self._active_npl_query = ('C100', '775773', 'MULTI:56678260,56678261')
        self.fields = {engine.ID_MATERIAL: '56678260', 'wnd[0]/usr/ctxtS_MATNR-HIGH': '56678261'}
        self.values = ['56678260', '56678261']
        self.ranges = ['OLD_RANGE_MATERIAL']
        self.exclusions = ['15191854']
        self.popup = False
        self.clipboard = ''
        self.calls = []
        self.queries = []
        self.missing = set()
        self.clear_effective = True
        self.close_effective = True
        self.extra_result = []

    def set_text(self, control, value):
        self.calls.append(('set', control, value))
        self.fields[control] = value

    def exists(self, control):
        if control in self.missing:
            return False
        if control.startswith('wnd[1]'):
            return self.popup
        return True

    def press(self, control):
        self.calls.append(('press', control))
        if control == engine.ID_MATERIAL_MULTI:
            self.popup = True
        elif control == 'wnd[1]/tbar[0]/btn[16]':
            if self.clear_effective:
                self.values, self.ranges, self.exclusions = [], [], []
        elif control == 'wnd[1]/tbar[0]/btn[24]':
            self.values.extend(self.clipboard.splitlines())
        elif control == 'wnd[1]/tbar[0]/btn[8]' and self.close_effective:
            self.popup = False
            self.fields[engine.ID_MATERIAL] = self.values[0] if self.values else ''
            self.fields['wnd[0]/usr/ctxtS_MATNR-HIGH'] = ''
        elif control == engine.ID_EXECUTE:
            actual = self.values + self.ranges + [self.fields[engine.ID_MATERIAL]] + self.extra_result
            self.queries.append(list(dict.fromkeys(value for value in actual if value and value not in self.exclusions)))

    def press_first_existing(self, controls):
        for control in controls:
            if self.exists(control):
                self.press(control)
                return control
        return None

    def wait_grid_columns(self, *args, **kwargs):
        materials = self.queries[-1]
        return SimpleNamespace(RowCount=len(materials), materials=materials)

    @staticmethod
    def get_cell(grid, row, column):
        return grid.materials[row]


class MaterialResetTests(unittest.TestCase):
    def setUp(self):
        self.sap = QuerySession()
        self.clipboard = patch.object(engine, 'set_windows_clipboard_text',
                                      side_effect=lambda text: setattr(self.sap, 'clipboard', text))
        self.clipboard.start()
        self.settings = patch.multiple(engine, NPL_EXACT_MATERIAL_QUERY=True, NPL_MULTI_MATERIAL_QUERY=True)
        self.settings.start()

    def tearDown(self):
        self.settings.stop()
        self.clipboard.stop()

    def test_user_groups_replace_previous_materials_each_time(self):
        batches = [(['56678260', '56678261'], '54955'),
                   (['15191854'], '43888'),
                   (['17453892', '17453887', '17453888', '55606095'], '47986')]
        for materials, supplier in batches:
            grid = self.sap._execute_npl_query(group(materials, supplier))
            self.assertEqual(set(grid.materials), set(materials))
            self.assertEqual(self.sap.ranges, [])
            self.assertEqual(self.sap.exclusions, [])
        self.assertNotIn('56678261', self.sap.queries[1])
        self.assertNotIn('56678261', self.sap.queries[2])
        self.assertEqual(self.sap.calls.count(('press', 'wnd[1]/tbar[0]/btn[16]')), 3)

    def test_clipboard_upload_occurs_only_after_delete_all(self):
        self.sap._execute_npl_query(group(['17453892', '17453887']))
        clear = self.sap.calls.index(('press', 'wnd[1]/tbar[0]/btn[16]'))
        upload = self.sap.calls.index(('press', 'wnd[1]/tbar[0]/btn[24]'))
        execute = self.sap.calls.index(('press', engine.ID_EXECUTE))
        self.assertLess(clear, upload)
        self.assertLess(upload, execute)

    def test_single_to_single_clears_hidden_multiple_criteria(self):
        for material in ['15191854', '17453892']:
            self.sap._execute_npl_query(group([material]))
            self.assertEqual(self.sap.queries[-1], [material])
            self.assertEqual(self.sap.fields['wnd[0]/usr/ctxtS_MATNR-HIGH'], '')
        self.assertFalse(any(call == ('press', 'wnd[1]/tbar[0]/btn[24]') for call in self.sap.calls))

    def test_project_query_also_removes_previous_material_constraints(self):
        with patch.multiple(engine, NPL_EXACT_MATERIAL_QUERY=False, NPL_MULTI_MATERIAL_QUERY=False):
            self.sap._execute_npl_query(group(['15191854']))
        self.assertEqual(self.sap.queries, [[]])
        self.assertEqual(self.sap.values, [])

    def test_missing_clear_control_blocks_query_and_creation(self):
        self.sap.missing.add('wnd[1]/tbar[0]/btn[16]')
        with self.assertRaises(engine.SapRpaError) as caught:
            self.sap._execute_npl_query(group(['15191854']))
        self.assertEqual(caught.exception.stage, 'NPL_MATERIAL_RESET')
        self.assertEqual(self.sap.queries, [])
        self.assertIsNone(self.sap._active_npl_query)
        self.assertNotIn(('press', engine.ID_CREATE_BUYER_RECEIPT), self.sap.calls)

    def test_wrong_popup_is_not_cleared(self):
        self.sap.missing.add('wnd[1]/tbar[0]/btn[24]')
        with self.assertRaises(engine.SapRpaError):
            self.sap._execute_npl_query(group(['15191854']))
        self.assertNotIn(('press', 'wnd[1]/tbar[0]/btn[16]'), self.sap.calls)
        self.assertEqual(self.sap.queries, [])

    def test_clear_noop_or_unexpected_result_stops_before_buyer_receipt(self):
        for clear_effective, extra in [(False, []), (True, ['56678261'])]:
            self.sap.clear_effective = clear_effective
            self.sap.extra_result = extra
            with self.assertRaises(engine.SapRpaError) as caught:
                self.sap._execute_npl_query(group(['15191854']))
            self.assertEqual(caught.exception.stage, 'NPL_MATERIAL_SCOPE')
            self.assertIn('56678261', caught.exception.message)
            self.assertIsNone(self.sap._active_npl_query)
            self.assertNotIn(('press', engine.ID_CREATE_BUYER_RECEIPT), self.sap.calls)

    def test_popup_that_does_not_close_never_executes_query(self):
        self.sap.close_effective = False
        with patch.object(engine, 'SAP_WAIT_SEC', 0), self.assertRaises(engine.SapRpaError):
            self.sap._execute_npl_query(group(['15191854']))
        self.assertEqual(self.sap.queries, [])

    def test_grid_selection_replaces_old_selected_rows(self):
        class Grid:
            RowCount = 3
            selectedRows = '0,1'

            def ClearSelection(self):
                self.selectedRows = ''

        grid = Grid()
        engine.SapSession.select_rows(grid, [2])
        self.assertEqual(grid.selectedRows, '2')


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], verbosity=2)
