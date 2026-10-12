"""Read-only ME01 backend diagnostic. Never navigate, scroll, edit or save SAP."""
import json
import sys
import argparse
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources' / 'rpa'))
from me01_source_table import SourceListTable, identifier

TABLE = 'wnd[0]/usr/tblSAPLMEORTC_0205'


class CurrentViewOnly(SourceListTable):
    def page(self, position):
        table = self.session.findById(self.table_id)
        if int(position) != int(table.VerticalScrollbar.Position):
            raise RuntimeError('Read-only inspection would require scrolling; no action was taken.')
        return super().page(position)


class InteractiveReadCheck(CurrentViewOnly):
    """The operator moves the UI; this diagnostic never sets a SAP property."""
    def page(self, position):
        table = self.session.findById(self.table_id)
        bounded = min(max(0, int(position)), self.scroll_limit(table))
        if int(table.VerticalScrollbar.Position) != bounded:
            print(json.dumps({'scrollTo': bounded, 'instruction': 'Move the scrollbar only, then enter checked. Any other input cancels.'}), flush=True)
            if sys.stdin.readline().strip() != 'checked':
                raise RuntimeError('Read check cancelled. No business action was taken.')
        return super().page(bounded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--material', required=True)
    parser.add_argument('--plant', default='C100')
    parser.add_argument('--read-check', action='store_true', help='Run the real snapshot reader with operator-controlled scrolling; never edit or save.')
    parser.add_argument('--bulk-probe', action='store_true', help='Inspect the bulk-read JSON schema and duration without edits or scrolling.')
    parser.add_argument('--benchmark', action='store_true', help='Compare complete current-page legacy and bulk reads; no edits or scrolling.')
    args = parser.parse_args()
    import win32com.client
    app = win32com.client.GetObject('SAPGUI').GetScriptingEngine
    candidates = []
    for c in range(int(app.Children.Count)):
        connection = app.Children(c)
        for s in range(int(connection.Children.Count)):
            session = connection.Children(s)
            if session.Busy:
                continue
            material = session.findById('wnd[0]/usr/ctxtEORD-MATNR', False)
            plant = session.findById('wnd[0]/usr/ctxtEORD-WERKS', False)
            if (material is not None and plant is not None
                    and identifier(material.Text) == identifier(args.material) and str(plant.Text).strip() == args.plant
                    and session.findById(TABLE, False) is not None):
                candidates.append(session)
    if len(candidates) != 1:
        raise RuntimeError(f'Expected one idle ME01 table for {args.material}/{args.plant}; found {len(candidates)}. No action was taken.')
    session = candidates[0]
    if args.bulk_probe:
        started = time.perf_counter()
        raw = session.GetObjectTree(TABLE, [32025, 32015, 32000, 32011, 32009])
        parsed = json.loads(raw)
        checkboxes = []
        def find_checks(node):
            properties = node.get('properties', {})
            if properties.get('Type') == 'GuiCheckBox' and len(checkboxes) < 3:
                checkboxes.append(properties)
            for child in node.get('children', []):
                find_checks(child)
        find_checks(parsed)
        print(json.dumps({'seconds': time.perf_counter()-started, 'rootType': type(parsed).__name__,
                          'sample': str(raw)[:400], 'checkboxes': checkboxes, 'sapActions': 'none'}, ensure_ascii=True), flush=True)
        return
    def verify_context():
        if (identifier(session.findById('wnd[0]/usr/ctxtEORD-MATNR').Text) != identifier(args.material)
                or str(session.findById('wnd[0]/usr/ctxtEORD-WERKS').Text).strip() != args.plant
                or session.findById('wnd[1]', False) is not None):
            raise RuntimeError('Material/Plant changed or a modal appeared. Read-only check stopped.')
    adapter = (InteractiveReadCheck if args.read_check else CurrentViewOnly)(session, TABLE, lambda _session: None, verify_context=verify_context)
    if args.read_check:
        rows, blanks = adapter.snapshot()
        print(json.dumps({'readCheck': 'passed', 'rows': rows, 'blankRowCount': len(blanks), 'pages': adapter.read_trace,
                          'sapBusinessActions': 'none: no field edits, creation or Save'}, ensure_ascii=True), flush=True)
        return
    if args.benchmark:
        timings, exports = {}, {}
        current = int(session.findById(TABLE).VerticalScrollbar.Position)
        for mode in ('bulk', 'legacy'):
            reader = CurrentViewOnly(session, TABLE, lambda _session: None, verify_context=verify_context)
            if mode == 'legacy':
                reader.bulk_supported = False
            started = time.perf_counter()
            _, cells = reader.page(current)
            exports[mode] = {offset: reader.values(controls) for offset, controls in cells.items()}
            timings[mode] = time.perf_counter()-started
        if exports['bulk'] != exports['legacy']:
            raise RuntimeError('Current table changed or bulk/legacy read differs. No edit/save was performed.')
        print(json.dumps({'timingsSeconds': timings, 'allFieldsMatch': True, 'controlRows': len(exports['bulk']),
                          'speedup': timings['legacy']/max(timings['bulk'],0.000001), 'sapActions': 'none'}, ensure_ascii=True))
        return
    table = candidates[0].findById(TABLE)
    print(json.dumps({'initialPosition': int(table.VerticalScrollbar.Position), 'RowCount': int(table.RowCount),
                      'VisibleRowCount': int(table.VisibleRowCount), 'Maximum': int(table.VerticalScrollbar.Maximum),
                      'Range': int(table.VerticalScrollbar.Range), 'PageSize': int(table.VerticalScrollbar.PageSize),
                      'RowsCount': int(table.Rows.Count)}, ensure_ascii=True))
    current = int(table.VerticalScrollbar.Position)
    _, cells = adapter.page(current)
    values = {offset: adapter.values(controls) for offset, controls in cells.items()}
    fresh = {offset: {field: (candidates[0].findById(str(control.Id)), kind)
                      for field, (control, kind) in controls.items()} for offset, controls in cells.items()}
    fresh_values = {offset: adapter.values(controls) for offset, controls in fresh.items()}
    print(json.dumps({'currentValues': {offset: value for offset, value in values.items()
                                       if any(value.values()) or offset in (0, max(values))},
                      'blankRows': [offset for offset, value in values.items() if not any(value.values())]}, ensure_ascii=True))
    print(json.dumps({'freshById': {offset: value for offset, value in fresh_values.items()
                                  if any(value.values()) or offset in (0, max(fresh_values))}}, ensure_ascii=True))
    print(json.dumps({'sapActions': 'none: current viewport only; no scrolling, editing, navigation or save'}, ensure_ascii=True))


if __name__ == '__main__':
    main()
