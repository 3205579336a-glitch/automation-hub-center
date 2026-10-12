"""Source List row upsert. Discover named SAP controls; never use numeric GetCell."""
import re
import json
import time
from datetime import datetime

FIELDS = {'from': 'EORD-VDATU', 'to': 'EORD-BDATU', 'supplier': 'EORD-LIFNR',
          'org': 'EORD-EKORG', 'fixed': 'RM06W-FESKZ', 'usage': 'EORD-AUTET'}
CELL_ID = re.compile(r'/(ctxt|txt|chk)([^/\[]+)\[(\d+),(\d+)\]$')


def sap_bool(value):
    if value is True or value == 1 or value == -1 or str(value).strip().lower() == 'true':
        return True
    if value is False or value == 0 or str(value).strip().lower() == 'false':
        return False
    raise RuntimeError(f'Unreadable SAP boolean {value!r}; no checkbox state is guessed.')


class BulkCell:
    """One atomic GetObjectTree read. Only edits resolve a fresh live COM control."""
    def __init__(self, session, properties):
        self.session, self.properties = session, properties
        self.Id = properties['Id']

    @property
    def Text(self):
        if 'Text' not in self.properties or self.properties['Text'] is None:
            raise RuntimeError(f'Bulk SAP Text missing for {self.Id}.')
        return self.properties['Text']

    @Text.setter
    def Text(self, value):
        self.session.findById(self.Id).Text = value

    @property
    def Selected(self):
        return sap_bool(self.properties.get('Checked', self.properties.get('Selected')))

    @Selected.setter
    def Selected(self, value):
        self.session.findById(self.Id).Selected = value

    @property
    def Changeable(self):
        return sap_bool(self.properties.get('Changeable'))

    def SetFocus(self):
        self.session.findById(self.Id).SetFocus()

    @property
    def caretPosition(self):
        return self.session.findById(self.Id).caretPosition

    @caretPosition.setter
    def caretPosition(self, value):
        self.session.findById(self.Id).caretPosition = value


def identifier(value):
    text = str(value or '').strip()
    return (text.lstrip('0') or '0') if text.isdigit() else text.upper()


def parse_date(value):
    text = str(value or '').strip()
    for shape, pattern in ((r'\d{1,2}\.\d{1,2}\.\d{4}', '%d.%m.%Y'),
                           (r'\d{4}-\d{1,2}-\d{1,2}', '%Y-%m-%d'), (r'\d{8}', '%Y%m%d')):
        if re.fullmatch(shape, text):
            try:
                return datetime.strptime(text, pattern).date()
            except ValueError:
                pass
    raise RuntimeError(f'Unreadable Source List date: {text!r}. No date is guessed.')


class SourceListTable:
    def __init__(self, session, table_id, wait_ready, check_stop=lambda: None, verify_context=lambda: None):
        self.session, self.table_id, self.wait_ready, self.check_stop = session, table_id, wait_ready, check_stop
        self.verify_context = verify_context
        self.stage = 'Read Source List controls'
        self.read_trace = []
        self.bulk_supported = None
        self.metrics = {'bulkReads': 0, 'legacyPages': 0, 'pageReadSeconds': 0.0}
        self.boundary_shape = None
        self.before_rows, self.expected_rows = {}, {}

    def page(self, position):
        started = time.perf_counter()
        self.verify_context()
        table = self.session.findById(self.table_id)
        # Use the live scrollbar limit, not RowCount - VisibleRowCount. The latter
        # can include a partly visible/virtual row without materialized controls.
        # SAP builds may reject rather than clamp an invalid position (613).
        last_start = self.scroll_limit(table)
        bounded = min(max(0, int(position)), last_start)
        if int(table.VerticalScrollbar.Position) != bounded:
            table.VerticalScrollbar.Position = bounded
        self.wait_ready(self.session)
        table = self.session.findById(self.table_id)
        cells = self.bulk_cells(table)
        if cells is not None:
            self.metrics['pageReadSeconds'] += time.perf_counter() - started
            return table, cells
        cells = {}
        # IDs come from the live table, including the actual column positions.
        for index in range(int(table.Children.Count)):
            control = table.Children(index)
            match = CELL_ID.search(str(control.Id))
            if match:
                kind, field, _, visible = match.groups()
                row = cells.setdefault(int(visible), {})
                if field in row:
                    raise RuntimeError(f'Duplicate SAP field {field}; cannot identify a unique row.')
                row[field] = (control, kind)
        self.metrics['legacyPages'] += 1
        self.metrics['pageReadSeconds'] += time.perf_counter() - started
        return table, cells

    def bulk_cells(self, table):
        if self.bulk_supported is False:
            return None
        try:
            reader = self.session.GetObjectTree
        except AttributeError:
            self.bulk_supported = False
            return None
        except Exception as error:
            if getattr(error, 'hresult', None) in {-2147352570, -2147352573}:
                self.bulk_supported = False
                return None
            raise
        # An invalid JSON/permission failure is NOT treated as a blank table or
        # silently ignored. Old clients without the method use the safe legacy path.
        # Magic DispID 32011 is checkbox Checked. The string "Selected" resolves
        # to a different SAP component property and exports empty checkbox states.
        raw = reader(self.table_id, [32025, 32015, 32000, 32011, 32009])
        tree = json.loads(raw)
        expected_table_id = str(table.Id)
        cells, table_seen = {}, False
        def visit(node):
            nonlocal table_seen
            if not isinstance(node, dict):
                raise RuntimeError('Invalid SAP bulk object-tree node.')
            properties = node.get('properties', {})
            control_id = str(properties.get('Id', ''))
            if control_id == expected_table_id:
                table_seen = True
            match = CELL_ID.search(control_id)
            if match and control_id.startswith(expected_table_id + '/'):
                kind, field, _, visible = match.groups()
                row = cells.setdefault(int(visible), {})
                if field in row:
                    raise RuntimeError(f'Duplicate SAP field {field}; cannot identify a unique row.')
                row[field] = (BulkCell(self.session, properties), kind)
            for child in node.get('children', []):
                visit(child)
        visit(tree)
        if not table_seen or not cells:
            raise RuntimeError('SAP bulk export did not contain the requested Source List table/controls.')
        self.bulk_supported = True
        self.metrics['bulkReads'] += 1
        return cells

    @staticmethod
    def scroll_limit(table):
        maximum = int(table.VerticalScrollbar.Maximum)
        if maximum < 0:
            raise RuntimeError('Source List has an invalid scrollbar limit; no row is guessed.')
        return maximum

    def page_details(self, table, cells):
        return (f'start={int(table.VerticalScrollbar.Position)}, '
                f'RowCount={int(table.RowCount)}, VisibleRowCount={int(table.VisibleRowCount)}, '
                f'scrollMaximum={self.scroll_limit(table)}, controlRows={sorted(cells)}')

    def values(self, controls):
        missing = set(FIELDS.values()) - set(controls)
        if missing:
            raise RuntimeError(f'Source List controls missing: {sorted(missing)}. Found: {sorted(controls)}. Record this SAP layout before retrying.')
        values = {field: bool(control.Selected) if kind == 'chk' else str(control.Text or '').strip()
                  for field, (control, kind) in controls.items()}
        for role in ('from', 'to'):
            field = FIELDS[role]
            if values[field]:
                values[field] = parse_date(values[field]).isoformat()
        for role in ('supplier', 'org'):
            field = FIELDS[role]
            values[field] = identifier(values[field]) if values[field] else ''
        return values

    def snapshot(self, cancellable=True):
        rows, blanks, seen = {}, {}, set()
        position = 0
        horizon = None
        initial_span = None
        first_page = None
        self.read_trace = []
        while True:
            if cancellable:
                self.check_stop()
            table, cells = self.page(position)
            start = int(table.VerticalScrollbar.Position)
            total, visible = int(table.RowCount), int(table.VisibleRowCount)
            maximum = self.scroll_limit(table)
            details = self.page_details(table, cells)
            self.read_trace.append(details)
            if horizon is None:
                # Freeze the advertised extent for this read; never keep
                # extending the scan if blank-entry metadata grows during paging.
                horizon = total
            if visible < 1 or not cells or min(cells) != 0:
                raise RuntimeError(f'Source List has no readable first visible row. {details}')
            # Enumerate actual controls. Never skip an internal hole, and advance
            # only by the readable span so the next page includes a clipped row.
            span = max(cells) + 1
            if initial_span is None:
                initial_span = span
            if set(cells) != set(range(span)):
                raise RuntimeError(f'Source List has a gap in visible row controls. {details}')
            if start > len(seen):
                raise RuntimeError(f'Source List scrolling skipped unread rows. {details}')
            page_values = {}
            for offset in range(span):
                absolute = start + offset
                try:
                    page_values[offset] = self.values(cells[offset])
                except Exception as error:
                    raise RuntimeError(f'Source List row {absolute + 1} cannot be read: {error}. {details}') from error
            if first_page is None:
                first_page = page_values
                if (self.boundary_shape == (total, visible, maximum, span)
                        and not any(page_values[span - 1].values())):
                    # Geometry already proved in this material, not a cached row
                    # snapshot: still validate/read EVERY current field below.
                    horizon = span
            elif (start == 1 and len(seen) == initial_span and span == initial_span - 1
                  and horizon == initial_span + maximum and maximum == initial_span - 1
                  and not any(first_page[initial_span - 1].values())
                  and page_values == {offset: first_page[offset] for offset in range(span)}
                  and any(page_values[offset] != first_page[start + offset] for offset in range(span))):
                # Verified on ME01: when scrolling into empty entry slots, SAP
                # may echo the original prefix instead of advancing data, while
                # Position and the number of controls DO change. Never map that
                # echo to absolute rows. Restore the top and verify the entire
                # original page (including every blank/other field) before using
                # its row locators. No business edit or Save is retried here.
                if cancellable:
                    self.check_stop()
                restored_table, restored_cells = self.page(0)
                restored_values = {offset: self.values(controls) for offset, controls in restored_cells.items()}
                if (int(restored_table.VerticalScrollbar.Position) != 0
                        or int(restored_table.RowCount) != horizon
                        or self.scroll_limit(restored_table) != maximum
                        or restored_values != first_page):
                    raise RuntimeError('ME01 empty-area echo could not be verified after returning to the top. '
                                       'No row will be guessed. ' + self.page_details(restored_table, restored_cells))
                self.read_trace.append('Confirmed ME01 empty-area prefix echo; restored and verified all top-page controls.')
                self.boundary_shape = (horizon, visible, maximum, initial_span)
                return rows, blanks
            progress = False
            for offset, values in page_values.items():
                absolute = start + offset
                if absolute in seen:
                    if values != rows.get(absolute, blanks.get(absolute)):
                        raise RuntimeError(f'Source List row {absolute + 1} changed during paging. {details}. '
                                           f'Before={rows.get(absolute, blanks.get(absolute))!r}; '
                                           f'After={values!r}; pages={self.read_trace!r}')
                    continue
                seen.add(absolute); progress = True
                if not any(values.values()):
                    blanks[absolute] = values
                    continue
                if not all(values[FIELDS[role]] for role in ('from', 'to', 'supplier')):
                    raise RuntimeError(f'Source List row {absolute + 1} is incomplete; it will not be overwritten.')
                if values[FIELDS['from']] > values[FIELDS['to']]:
                    raise RuntimeError(f'Source List row {absolute + 1} has invalid dates.')
                rows[absolute] = values
            # Maximum is a permissible scrollbar position, NOT a requirement to
            # scroll there. Once the initial table extent is fully read, stop.
            if start + span >= horizon:
                break
            # ME01 can report RowCount = data slots + viewport padding. Probe
            # the next position with overlap, rather than jumping into that
            # padding. A shrinking, contiguous viewport ending in a verified
            # blank, with every overlapping row identical, establishes the real
            # addressable boundary. Never infer an end after a nonempty row.
            if (start > 0 and span < initial_span and start + span == len(seen)
                    and start + span - 1 in blanks):
                self.read_trace.append(f'Confirmed empty entry boundary at row {start + span}; ignored viewport padding.')
                if start == 1 and start + span == initial_span:
                    self.boundary_shape = (horizon, visible, maximum, initial_span)
                break
            if start == maximum:
                # RowCount may include virtual trailing slots. Accept them only
                # at the real scroll end with a fully read, empty trailing row.
                # A hidden tail following nonempty data remains an unsafe state.
                if start + span < horizon and start + span - 1 not in blanks:
                    raise RuntimeError(f'Source List has an unread tail after nonempty data. {details}')
                break
            if not progress:
                raise RuntimeError(f'Source List paging made no progress; no row is guessed. {details}')
            # With an empty tail, move just one row to verify that the table
            # really ends there. Otherwise overlap one row while paging so a
            # shifted/changed row is detected before any business write.
            step = 1 if start + span - 1 in blanks else max(1, span - 1)
            position = min(start + step, maximum)
        return rows, blanks

    def controls_for(self, absolute, expected):
        table = self.session.findById(self.table_id)
        start = int(table.VerticalScrollbar.Position)
        # Keep visible rows on their current page. In particular, adding row 2
        # must not scroll into ME01's virtual append area when it is already visible.
        position = start if start <= absolute < start + int(table.VisibleRowCount) else absolute
        table, cells = self.page(position)
        offset = absolute - int(table.VerticalScrollbar.Position)
        controls = cells.get(offset)
        # A partly visible last row may not have controls until scrolled into view.
        if controls is None and position != absolute:
            table, cells = self.page(absolute)
            offset = absolute - int(table.VerticalScrollbar.Position)
            controls = cells.get(offset)
        if controls is None or self.values(controls) != expected:
            raise RuntimeError(f'Source List row {absolute + 1} changed during review; stop and check SAP.')
        return controls

    def upsert(self, parma, dual, valid_from, valid_to, org):
        if not isinstance(dual, bool):
            raise RuntimeError('Dual Sourcing must be an explicit Yes/No.')
        first, last = parse_date(valid_from), parse_date(valid_to)
        org, parma = identifier(org), identifier(parma)
        if first > last or not re.fullmatch(r'[A-Z0-9]{1,4}', org) or not parma:
            raise RuntimeError('Invalid new Source List dates, Parma or purchasing organization.')
        self.stage = 'Read Source List controls'
        rows, blanks = self.snapshot()
        candidates = {row: values for row, values in rows.items()
                      if values[FIELDS['supplier']] == parma and values[FIELDS['org']] == org}
        exact = [row for row, values in candidates.items()
                 if values[FIELDS['from']] == first.isoformat() and values[FIELDS['to']] == last.isoformat()]
        covering = [row for row, values in candidates.items()
                    if values[FIELDS['from']] <= first.isoformat() and values[FIELDS['to']] >= last.isoformat()]
        if len(exact) > 1 or len(covering) > 1:
            raise RuntimeError('Multiple target supplier rows cover the requested validity. Review SAP; no duplicate is created.')
        target = (exact or covering or [None])[0]
        if target is None:
            overlaps = [values for values in candidates.values()
                        if values[FIELDS['from']] <= last.isoformat() and first.isoformat() <= values[FIELDS['to']]]
            if overlaps:
                periods = ', '.join(f"{values[FIELDS['from']]} to {values[FIELDS['to']]}" for values in overlaps)
                raise RuntimeError(f'Target supplier {parma} has an overlapping but different validity interval: {periods}. '
                                   f'Requested: {first.isoformat()} to {last.isoformat()}. '
                                   'Match the existing dates to keep that row, or review dates in SAP. No row is created or overwritten.')
            if not blanks:
                raise RuntimeError('No verified empty Source List row is available. Add an empty row in SAP and retry after reviewing results.')
            target = min(blanks)
        creating = target not in rows
        before = {**rows, **({target: blanks[target]} if creating else {})}
        expected = {row: dict(values) for row, values in before.items()}
        if creating:
            expected[target].update({FIELDS['from']: first.isoformat(), FIELDS['to']: last.isoformat(),
                                     FIELDS['supplier']: parma, FIELDS['org']: org})
        expected[target].update({FIELDS['fixed']: True, FIELDS['usage']: '1'})
        if not dual:
            for row in rows:
                if row != target:
                    expected[row].update({FIELDS['fixed']: False, FIELDS['usage']: ''})
        self.before_rows = {row: dict(values) for row, values in rows.items()}
        self.expected_rows = {row: dict(values) for row, values in expected.items()}
        # Existing suppliers, dates and all other fields are immutable. No delete
        # commands or row clearing are permitted, even as a future optimization.
        for row, values in rows.items():
            allowed = {FIELDS['fixed'], FIELDS['usage']}
            if row not in expected or any(expected[row][field] != value for field, value in values.items() if field not in allowed):
                raise RuntimeError('Existing Source List row would be removed or overwritten. No business edit is permitted.')
        changes = [row for row in expected if expected[row] != before[row]]
        # Resolve every affected control and confirm editability before the first write.
        for row in changes:
            self.check_stop()
            controls = self.controls_for(row, before[row])
            for field in FIELDS.values():
                if expected[row][field] != before[row][field]:
                    control = controls[field][0]
                    try:
                        changeable = control.Changeable
                    except AttributeError:
                        changeable = True
                    if not changeable:
                        raise RuntimeError(f'Source List row {row + 1} field {field} is read-only. No selection was changed.')
        self.check_stop()
        # Target first. After the first write, finish this material before honoring Stop.
        for row in sorted(changes, key=lambda value: value != target):
            self.stage = 'Add target source row' if creating and row == target else 'Switch Fix / MRP'
            current = dict(before[row])
            for role in ('from', 'to', 'supplier', 'org', 'fixed', 'usage'):
                field = FIELDS[role]
                if before[row][field] == expected[row][field]:
                    continue
                # A field edit can recreate table controls; reacquire them.
                controls = self.controls_for(row, current)
                control = controls[field][0]
                value = expected[row][field]
                if role == 'fixed':
                    control.Selected = value
                else:
                    control.Text = parse_date(value).strftime('%d.%m.%Y') if role in ('from', 'to') else value
                current[field] = value
        self.stage = 'Verify Source List before Save'
        actual, _ = self.snapshot(cancellable=False)
        if actual != expected:
            raise RuntimeError('Source List readback differs from the planned rows. Do not save or automatically replay; review partial SAP edits.')
        return bool(changes)
