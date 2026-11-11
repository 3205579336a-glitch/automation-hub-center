"""Hub-only MM02 update. No SAP action is taken on import."""
from __future__ import annotations

import json
import os
import re
import time
from collections import Counter
from pathlib import Path

from hub_user_interaction import HubStopped, HubUserInteraction, session_identity
from sap_gui_connection import SapGuiConnector, SapGuiIssue

CLASS_NAME = 'YY_COMMODITY'
HOME = {'SESSION_MANAGER', 'S000'}
MATERIAL = 'wnd[0]/usr/ctxtRMMG1-MATNR'
VIEW = 'wnd[1]/usr/tblSAPLMGMMTC_VIEW'
ORG = 'wnd[1]/usr/cntlCUSTOM_CONTAINER/shellcont/shell'
CLASSIFY = 'wnd[0]/usr/btn%#AUTOTEXT003'
CLASSES = 'wnd[0]/usr/subSUBSCR_ZUORD:SAPLCLFM:1600/tblSAPLCLFMTC_OBJ_CLASS'
ASSIGNMENT_INSERT = 'wnd[0]/usr/btn%#AUTOTEXT003'  # Same ID as CLASSIFY, on the different Classification screen.
ASSIGNMENT_TOTAL = 'wnd[0]/usr/txtRMCLF-PAGANZ'  # The right side of "Entry ... / ..."; excludes empty input slots.
CHARS = ('wnd[0]/usr/subSUBSCR_BEWERT:SAPLCTMS:5000/tabsTABSTRIP_CHAR/tabpTAB1/'
         'ssubTABSTRIP_CHAR_GR:SAPLCTMS:5100/tblSAPLCTMSCHARS_S')
RECORDED_COMMODITY_LABEL = 'p&sm commodity code'
COMMODITY_HELP_TREE = 'wnd[1]/usr/cntlCONTAINER/shellcont/shell/shellcont[1]/shell[1]'
COMMODITY_HELP_CANCEL = 'wnd[1]/tbar[0]/btn[12]'
SAVE = 'wnd[0]/tbar[0]/btn[11]'


class RowRejected(RuntimeError):
    """A recognized material rejection before any master-data edit."""


class SaveUncertain(RuntimeError):
    """Save may have reached SAP. Never replay it or advance to another row."""


class ClassificationViewportChanged(RuntimeError):
    """Only a read-only viewport scan may be restarted after this error."""


def emit(event, **payload):
    print('MM02_EVENT ' + json.dumps(dict(event=event, **payload), ensure_ascii=True), flush=True)


def id_key(value):
    text = str(value or '').strip()
    return (text.lstrip('0') or '0') if re.fullmatch(r'[0-9]+', text) else text.upper()


def validate_tasks(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 5000:
        raise ValueError('The MM02 input list is invalid.')
    seen = set()
    total = 0
    for task in value:
        if not isinstance(task, dict):
            raise ValueError('The MM02 input contains an invalid record.')
        material, code, rows = task.get('material'), task.get('subCommodity'), task.get('excelRows')
        if (not isinstance(material, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,39}', material)
                or not isinstance(code, str) or not re.fullmatch(r'[0-9]{6}', code)
                or not isinstance(rows, list) or not rows or any(type(row) is not int or not 2 <= row <= 1_048_576 for row in rows)
                or id_key(material) in seen):
            raise ValueError('The MM02 input contains an invalid material, code or duplicate.')
        seen.add(id_key(material))
        total += len(rows)
        if total > 20_000:
            raise ValueError('Too many MM02 input rows.')
    return value


def find(session, control):
    return session.FindById(control, False)


def status(session):
    bar = find(session, 'wnd[0]/sbar')
    if bar is None:
        return '', ''
    return str(bar.MessageType or '').strip().upper(), str(bar.Text or '').strip()


def popup(session):
    return find(session, 'wnd[2]') is not None or find(session, 'wnd[1]') is not None


def check_stop(stopped):
    if stopped():
        raise HubStopped()


def wait_for(session, ids, stopped, *, known_popup=False, material_entry=False, timeout=18):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        check_stop(stopped)
        if not session.Busy:
            if find(session, 'wnd[2]') is not None:
                raise RuntimeError('An unexpected SAP dialog is open. No option was selected.')
            modal = find(session, 'wnd[1]') is not None
            for control_id in ids:
                if modal != control_id.startswith('wnd[1]'):
                    continue
                control = find(session, control_id)
                if control is not None:
                    return control_id, control
            if modal and not known_popup:
                raise RuntimeError('An unexpected SAP dialog is open. No option was selected.')
            if not modal:
                kind, message = status(session)
                if kind in {'E', 'A', 'W'}:
                    if material_entry and kind == 'E' and find(session, MATERIAL) is not None:
                        raise RowRejected(message or 'SAP rejected this material.')
                    raise RuntimeError(message or 'SAP returned an error or warning.')
        time.sleep(.10)
    raise RuntimeError('SAP did not reach the expected MM02 screen. No confirmation was selected.')


def control(session, control_id):
    obj = find(session, control_id)
    if obj is None:
        raise RuntimeError(f'The expected MM02 control is missing: {control_id}')
    return obj


def ensure_clear(session, stage):
    if popup(session):
        raise RuntimeError(f'{stage}: an unexpected SAP dialog is open. No option was selected.')
    kind, message = status(session)
    if kind in {'A', 'E', 'W'}:
        raise RuntimeError(f'{stage}: {message or "SAP returned an error or warning."}')


def open_classification(session, identity, material, stopped):
    check_stop(stopped)
    if session.Busy or popup(session) or session_identity(session) != identity:
        raise RuntimeError('The original SAP window is no longer idle or could not be verified.')
    transaction = str(session.Info.Transaction).upper()
    if transaction not in HOME | {'MM02'}:
        raise RuntimeError('The original SAP window has moved to a different transaction.')
    command = control(session, 'wnd[0]/tbar[0]/okcd')
    command.Text = '/nMM02'
    control(session, 'wnd[0]').SendVKey(0)
    _, field = wait_for(session, [MATERIAL], stopped)
    if str(session.Info.Transaction).upper() != 'MM02' or not field.Changeable:
        raise RuntimeError('The MM02 material entry screen could not be verified.')
    field.Text = material
    if id_key(field.Text) != id_key(material):
        raise RuntimeError('SAP did not retain the intended material number.')
    control(session, 'wnd[0]').SendVKey(0)
    first, table = wait_for(session, [VIEW, ORG, CLASSIFY], stopped, known_popup=True, material_entry=True)
    if first == VIEW:
        # Recorded view (third row). If an organization popup is present,
        # follow the recording's first row; there are no user-entered options.
        view = control(session, VIEW + '/txtMSICHTAUSW-DYTXT[0,2]')
        if not str(view.Text or '').strip():
            raise RuntimeError('The recorded MM02 view is not available for this material.')
        table.GetAbsoluteRow(2).Selected = True
        view.SetFocus()
        control(session, 'wnd[1]/tbar[0]/btn[0]').Press()
        first, table = wait_for(session, [ORG, CLASSIFY], stopped, known_popup=True)
    if first == ORG:
        if int(table.RowCount) < 1:
            raise RuntimeError('SAP did not offer the recorded organizational level.')
        table.SelectedRows = '0'
        control(session, 'wnd[1]/tbar[0]/btn[0]').Press()
        _, table = wait_for(session, [CLASSIFY], stopped)
    ensure_clear(session, 'Open Classification')
    table.Press()
    wait_for(session, [CLASSES], stopped)
    ensure_clear(session, 'Classification')


def row_label(session, table_id, offset):
    if table_id == CLASSES:
        return find(session, f'{CLASSES}/ctxtRMCLF-CLASS[0,{offset}]')
    fields = [field for prefix in ('ctxt', 'txt', 'lbl')
              if (field := find(session, f'{CHARS}/{prefix}RCTMS-MNAME[0,{offset}]')) is not None]
    if len(fields) > 1:
        raise RuntimeError('A General characteristic label could not be read uniquely.')
    if not fields:
        value = find(session, f'{CHARS}/ctxtRCTMS-MWERT[1,{offset}]')
        if value is not None and input_text(value):
            raise RuntimeError('A General characteristic value has no readable label.')
    return fields[0] if fields else None


def input_text(field):
    text = str(field.Text or '').strip()
    # This SAP layout returns underscore masks for non-materialized blank rows.
    return '' if re.fullmatch(r'_+', text) else text


def classification_label(field, table_id):
    return input_text(field) if table_id == CLASSES else str(field.Text or '').strip()


def assignment_count(session):
    field = find(session, ASSIGNMENT_TOTAL)
    if field is None or field.Changeable:
        return None
    text = str(field.Text or '').strip()
    return int(text) if re.fullmatch(r'[0-9]{1,5}', text) else None


def classification_geometry(table, area, requested):
    scrollbar = table.VerticalScrollbar
    actual, maximum = int(scrollbar.Position), int(scrollbar.Maximum)
    visible, count = int(table.VisibleRowCount), int(table.RowCount)
    details = (f'{area}: requested={requested}, position={actual}, maximum={maximum}, '
               f'visible={visible}, reportedRows={count}')
    if not 0 <= actual <= maximum <= 500 or not 0 <= visible <= 100 or count < 0:
        raise RuntimeError(f'Invalid Classification table geometry: {details}.')
    return scrollbar, actual, maximum, visible, count, details


def classification_page(session, table_id, position, stopped):
    area = 'Assignments' if table_id == CLASSES else 'General'
    _, table = wait_for(session, [table_id], stopped)
    ensure_clear(session, f'Read {area}')
    scrollbar, actual, maximum, visible, count, details = classification_geometry(table, area, position)
    if position > maximum:
        raise ClassificationViewportChanged(f'SAP refreshed the Classification scroll range: {details}.')
    if actual != position:
        # Scrolling can rebuild the table, or SAP can clamp to 0 when the
        # virtual input rows disappear. Never map the returned page to the
        # requested index if that happens.
        try:
            scrollbar.Position = position
        except Exception as error:
            _, table = wait_for(session, [table_id], stopped)
            ensure_clear(session, f'Read {area}')
            _, _, latest_maximum, _, _, latest = classification_geometry(table, area, position)
            if position > latest_maximum:
                raise ClassificationViewportChanged(f'SAP refreshed the Classification scroll range: {latest}.') from error
            raise
        _, table = wait_for(session, [table_id], stopped)
        ensure_clear(session, f'Read {area}')
        _, actual, maximum, visible, count, details = classification_geometry(table, area, position)
        if actual != position:
            raise ClassificationViewportChanged(f'SAP returned a different Classification scroll position: {details}.')
    return table, maximum, visible, count, details


def scan_classification_rows(session, table_id, stopped):
    """Read live viewport controls; RowCount may include virtual input rows."""
    try:
        return scan_classification_rows_once(session, table_id, stopped)
    except ClassificationViewportChanged as first:
        # Start at zero with no accumulated rows. In particular, do not merge
        # the old virtual pages with a refreshed table reporting 3 real rows.
        try:
            return scan_classification_rows_once(session, table_id, stopped)
        except ClassificationViewportChanged as second:
            raise ClassificationViewportChanged(f'{second} The table also refreshed on the first attempt: {first}') from second


def scan_classification_rows_once(session, table_id, stopped):
    rows = {}
    position = 0
    for _ in range(101):
        _, maximum, visible, count, details = classification_page(session, table_id, position, stopped)
        page = visible_classification_rows(session, table_id, visible, details)
        if table_id == CLASSES and position == 0:
            total = assignment_count(session)
            if total is not None and total == sum(bool(text) for text, _ in page.values()):
                # The live Entry total proves all actual assignments are here.
                # Scrolling through extra slots can close a just-inserted blank row.
                return page
        if not page and (position != maximum or count != 0):
            raise RuntimeError(f'Classification page contains no readable rows: {details}.')
        for offset, value in page.items():
            index = position + offset
            if index in rows and rows[index][:1] != value[:1]:
                raise RuntimeError(f'Classification rows shifted while scrolling: {details}.')
            rows[index] = value
        if position == maximum:
            # SAP can advertise additional virtual rows even at the last scroll
            # position. Accept the readable span when the viewport is full, or
            # when it visibly ends in empty entry slots rather than clipped data.
            if position + len(page) < count and len(page) < visible and page[len(page) - 1][0]:
                raise RuntimeError(f'The end of the Classification table is clipped: {details}.')
            return rows
        position = min(maximum, position + max(1, len(page) - 1))
    raise RuntimeError('The Classification table exceeded the safe page limit.')


def visible_classification_rows(session, table_id, visible, details):
    page = {}
    for offset in range(visible):
        field = row_label(session, table_id, offset)
        if field is None:
            continue  # Trailing slots may have no controls.
        if offset != len(page):
            raise RuntimeError(f'Classification has an unreadable row between controls: {details}.')
        text = classification_label(field, table_id)
        page[offset] = (text, table_id == CLASSES and not text and bool(field.Changeable))
    return page


def locate_classification_row_once(session, table_id, index, expected, stopped):
    table = control(session, table_id)
    position = int(table.VerticalScrollbar.Position)
    if not position <= index < position + int(table.VisibleRowCount):
        position = min(index, int(table.VerticalScrollbar.Maximum))
    table, maximum, _, _, _ = classification_page(session, table_id, position, stopped)
    field = row_label(session, table_id, index - position)
    if field is None and position != min(index, maximum):
        position = min(index, maximum)
        table, _, _, _, _ = classification_page(session, table_id, position, stopped)
        field = row_label(session, table_id, index - position)
    if field is None or classification_label(field, table_id) != expected:
        raise RuntimeError('The target Classification row moved before it could be used.')
    return table, position, field


def locate_classification_row(session, table_id, index, snapshot, stopped):
    expected = snapshot[index]
    try:
        return locate_classification_row_once(session, table_id, index, expected[0], stopped)
    except ClassificationViewportChanged:
        refreshed = scan_classification_rows(session, table_id, stopped)
        before = {row: text for row, (text, _) in snapshot.items() if text}
        after = {row: text for row, (text, _) in refreshed.items() if text}
        if after != before or refreshed.get(index) != expected:
            raise RuntimeError('Classification records changed while locating the target row; no row was guessed.')
        return locate_classification_row_once(session, table_id, index, expected[0], stopped)


def insert_class_row(session):
    ensure_clear(session, 'Insert class assignment')
    control(session, CLASSES)  # The entry screen reuses the button ID for Classification.
    button = find(session, ASSIGNMENT_INSERT)
    # Never search the General toolbar. Its different button is ALSO called Insert Row.
    if (button is None or str(button.Type) != 'GuiButton' or not button.Changeable
            or str(button.Tooltip or '').strip().casefold() not in {'insert row', 'insert line', '插入行', '插入行项目'}):
        raise RuntimeError('The verified Assignments Insert Row button is missing or disabled. No other button was clicked.')
    button.Press()


def inserted_class_slot(session, snapshot, stopped):
    """Read only the viewport SAP leaves after Insert Row; scrolling can close it."""
    occupied = {index: text for index, (text, _) in snapshot.items() if text}
    last_assigned = max(occupied, default=-1)
    deadline = time.monotonic() + 2
    while True:
        _, table = wait_for(session, [CLASSES], stopped)
        ensure_clear(session, 'Read new class row')
        _, start, _, visible, _, details = classification_geometry(table, 'Assignments after Insert Row', 'current')
        page = visible_classification_rows(session, CLASSES, visible, details)
        live = {start + offset: text for offset, (text, _) in page.items() if text}
        expected = {index: text for index, text in occupied.items() if start <= index < start + visible}
        total = assignment_count(session)
        if live != expected or (total is not None and total != len(occupied)):
            raise RuntimeError(f'Existing assignments could not be verified after Insert Row. {details}.')
        # Require the last existing assignment in the same viewport, directly
        # proving that the empty input is after it even when SAP auto-scrolls.
        anchored = last_assigned in live if occupied else start == 0
        if anchored:
            for offset, (_, editable) in page.items():
                row = start + offset
                if editable and row > last_assigned:
                    field = row_label(session, CLASSES, offset)
                    if (int(control(session, CLASSES).VerticalScrollbar.Position) != start or field is None
                            or not field.Changeable or input_text(field)):
                        raise RuntimeError('The inserted class row changed before it could be used.')
                    return row, start, field
        if time.monotonic() >= deadline:
            raise RuntimeError(f'No verified editable class row was visible after Insert Row. {details}.')
        time.sleep(.10)


def values_heading(session):
    """Read the rendered Values for Class heading when SAP exposes it."""
    try:
        read_tree = session.GetObjectTree
        raw = read_tree('wnd[0]/usr', [32025, 32000])  # Id and Text, used by the other native readers.
    except (AttributeError, RuntimeError):
        return None
    except Exception as error:
        if getattr(error, 'hresult', None) in {-2147352570, -2147352573}:
            return None
        raise
    if not isinstance(raw, str) or len(raw) > 1_000_000:
        raise RuntimeError('The active Classification heading could not be read.')
    pending = [json.loads(raw)]
    headings = set()
    while pending:
        node = pending.pop()
        props = node.get('properties', {})
        text = str(props.get('Text') or '').replace('\xa0', ' ').strip()
        heading = re.fullmatch(r'Values\s+for\s+Class\s+([A-Za-z0-9_./-]+)(?:\s+-\s+Object\s+(.+))?', text, re.I)
        if heading:
            headings.add((heading[1].upper(), heading[2]))
        pending.extend(node.get('children', []))
    if len(headings) > 1:
        raise RuntimeError('SAP showed multiple active Classification headings.')
    return next(iter(headings), None)


def select_class(session, material, stopped, allow_assign):
    rows = scan_classification_rows(session, CLASSES, stopped)
    assignments = Counter(text.upper() for text, _ in rows.values() if text)
    if assignments[CLASS_NAME] > 1:
        raise RuntimeError(f'Multiple {CLASS_NAME} assignments were found.')
    added = assignments[CLASS_NAME] == 0
    if added:
        if not allow_assign:
            raise RuntimeError(f'The reopened record does not have class {CLASS_NAME}.')
        # Use the first editable slot after all current assignments; several
        # empty rows are normal. Never replace YY_PLM or another assignment.
        last_assigned = max((index for index, (text, _) in rows.items() if text), default=-1)
        row = next((index for index, (_, editable) in rows.items() if editable and index > last_assigned), None)
        if row is None:
            check_stop(stopped)
            insert_class_row(session)
            row, position, field = inserted_class_slot(session, rows, stopped)
        else:
            _, position, field = locate_classification_row(session, CLASSES, row, rows, stopped)
        if not field.Changeable or input_text(field):
            raise RuntimeError('The selected class row is no longer editable and empty.')
        check_stop(stopped)
        field.SetFocus()
        if int(control(session, CLASSES).VerticalScrollbar.Position) != position or not field.Changeable or input_text(field):
            raise RuntimeError('The class row changed when SAP focused it. No value was entered.')
        field.Text = CLASS_NAME
    else:
        row = next(index for index, (text, _) in rows.items() if text.upper() == CLASS_NAME)
        table, position, field = locate_classification_row(session, CLASSES, row, rows, stopped)
        # Select and focus the existing class, not the previously active first row.
        for other, (text, _) in rows.items():
            if other != row and text and position <= other < position + int(table.VisibleRowCount):
                visible = row_label(session, CLASSES, other - position)
                if visible is None:
                    continue
                if str(visible.Text or '').strip() != text:
                    raise RuntimeError('An existing assignment moved while selecting the commodity class.')
                current = table.GetAbsoluteRow(other)
                if current.Selected:
                    current.Selected = False
        table.GetAbsoluteRow(row).Selected = True
        field.SetFocus()
    control(session, 'wnd[0]').SendVKey(0)
    wait_for(session, [CHARS], stopped)
    ensure_clear(session, 'Select commodity class')
    current = control(session, CLASSES)
    start = int(current.VerticalScrollbar.Position)
    def retained(index, expected):
        if not 0 <= index - start < int(current.VisibleRowCount):
            return False
        found = row_label(session, CLASSES, index - start)
        return found is not None and str(found.Text or '').strip().upper() == expected

    other_changed = any(text and other != row and 0 <= other - start < int(current.VisibleRowCount)
                        and not retained(other, text.upper()) for other, (text, _) in rows.items())
    if other_changed or not retained(row, CLASS_NAME):
        # SAP can re-sort assignments after validating the newly entered class.
        after = scan_classification_rows(session, CLASSES, stopped)
        expected = assignments.copy()
        if added:
            expected[CLASS_NAME] += 1
        if Counter(text.upper() for text, _ in after.values() if text) != expected:
            raise RuntimeError(f'SAP did not retain {CLASS_NAME} and the original class assignments.')
        row = next(index for index, (text, _) in after.items() if text.upper() == CLASS_NAME)
        current, _, _ = locate_classification_row(session, CLASSES, row, after, stopped)
    if sum(assignments.values()) + int(added) > 1:
        heading = values_heading(session)
        if heading is not None:
            class_name, object_id = heading
            if class_name != CLASS_NAME:
                raise RuntimeError(f'The General area is showing {class_name}, not the expected {CLASS_NAME}.')
            if object_id and id_key(object_id) != id_key(material):
                raise RuntimeError('The General area belongs to a different material.')
        elif not current.GetAbsoluteRow(row).Selected:
            raise RuntimeError(f'SAP did not confirm {CLASS_NAME} as the selected class.')
    return added


def is_sub_commodity(label):
    if ' '.join(str(label or '').casefold().split()) == RECORDED_COMMODITY_LABEL:
        return True
    name = re.sub(r'[\s_\-‐‑–—:：]+', '', str(label or '')).upper()
    return name in {'SUBCOMMODITY', 'SUBCOMMODITYCODE', 'YYSUBCOMMODITY', 'YYSUBCOMMODITYCODE',
                    '子商品类别', '子商品类别代码', '子品类', '子品类代码'}


def characteristic(session, stopped):
    # Verified on this SAP layout: the recorded value cell [1,0] is paired
    # with "P&SM Commodity code". Don't scroll a fresh, unsaved assignment
    # just to inspect virtual slots. Still reject duplicate visible matches.
    table = control(session, CHARS)
    if int(table.VerticalScrollbar.Position) == 0:
        label = row_label(session, CHARS, 0)
        if label is not None and ' '.join(str(label.Text or '').casefold().split()) == RECORDED_COMMODITY_LABEL:
            _, _, visible, _, details = classification_page(session, CHARS, 0, stopped)
            rows = visible_classification_rows(session, CHARS, visible, details)
            if [row for row, (name, _) in rows.items() if is_sub_commodity(name)] != [0]:
                raise RuntimeError('The recorded P&SM Commodity code is missing or ambiguous in General.')
            return control(session, f'{CHARS}/ctxtRCTMS-MWERT[1,0]')
    rows = scan_classification_rows(session, CHARS, stopped)
    matches = [row for row, (name, _) in rows.items() if is_sub_commodity(name)]
    if len(matches) != 1:
        raise RuntimeError('Exactly one Sub-commodity characteristic could not be verified. No blind row update was made.')
    row = matches[0]
    _, start, _ = locate_classification_row(session, CHARS, row, rows, stopped)
    return control(session, f'{CHARS}/ctxtRCTMS-MWERT[1,{row - start}]')


def display_key(text):
    return ' '.join(str(text or '').split()).casefold()


def commodity_help_window(session):
    modal = find(session, 'wnd[1]')
    if (modal is None or find(session, 'wnd[2]') is not None
            or display_key(modal.Text) != RECORDED_COMMODITY_LABEL):
        raise RuntimeError('SAP did not open the verified P&SM Commodity code value help.')
    return modal


def commodity_help_catalog(session, stopped):
    """Read the key/description pairs from the verified native F4 tree, without selecting anything."""
    commodity_help_window(session)
    tree = control(session, COMMODITY_HELP_TREE)
    if str(tree.Type) != 'GuiShell' or str(tree.SubType) != 'Tree':
        raise RuntimeError('The SAP commodity value-help tree could not be verified.')
    columns = tree.GetColumnNames()
    if not 1 <= int(columns.Count) <= 12:
        raise RuntimeError('The SAP commodity value-help columns could not be verified.')
    titles = {str(columns(i)): display_key(tree.GetColumnTitleFromName(columns(i))) for i in range(int(columns.Count))}
    description = [name for name, title in titles.items() if title == 'description']
    if (titles.get('&Hierarchy') != f'value hierarchy for char. {RECORDED_COMMODITY_LABEL}'
            or len(description) != 1):
        raise RuntimeError('The SAP commodity key and description columns could not be verified.')
    nodes = tree.GetAllNodeKeys()
    if not 1 <= int(nodes.Count) <= 10_000:
        raise RuntimeError('The SAP commodity value-help list is empty or too large to verify.')
    catalog = {}
    for index in range(int(nodes.Count)):
        check_stop(stopped)
        node = nodes(index)
        key = str(tree.GetNodeTextByKey(node) or '').strip()
        if not re.fullmatch(r'[0-9]+', key):
            continue
        label = display_key(tree.GetItemText(node, description[0]))
        if label:
            catalog.setdefault(label, set()).add(key)
    if not any(re.fullmatch(r'[0-9]{6}', key) for keys in catalog.values() for key in keys):
        raise RuntimeError('No six-digit keys could be verified in SAP commodity value help.')
    return catalog


class CommodityCodeReader:
    """A live SAP help catalog cached only for this MM02 run and session."""

    def __init__(self):
        self.catalog = None

    def read(self, session, target, stopped):
        display = input_text(target)
        if not display or re.fullmatch(r'[0-9]{6}', display):
            return display
        if self.catalog is None:
            ensure_clear(session, 'Before reading commodity value help')
            check_stop(stopped)
            target.SetFocus()
            control(session, 'wnd[0]').SendVKey(4)
            wait_for(session, ['wnd[1]'], stopped, known_popup=True, timeout=5)
            commodity_help_window(session)
            try:
                catalog = commodity_help_catalog(session, stopped)
            finally:
                # Cancel only the recognized F4 dialog; never select a value,
                # confirm a popup, or dispatch Save as part of this read.
                commodity_help_window(session)
                cancel = control(session, COMMODITY_HELP_CANCEL)
                if (str(cancel.Type) != 'GuiButton' or not cancel.Changeable
                        or display_key(cancel.Tooltip) not in {'cancel (f12)', 'cancel'}):
                    raise RuntimeError('The SAP commodity value help could not be closed safely.')
                cancel.Press()
                wait_for(session, [CHARS], lambda: False, timeout=5)
            ensure_clear(session, 'After reading commodity value help')
            if input_text(characteristic(session, stopped)) != display:
                raise RuntimeError('The commodity value changed while reading value help; no value was selected.')
            self.catalog = catalog
        keys = self.catalog.get(display_key(display), set())
        if len(keys) != 1 or not re.fullmatch(r'[0-9]{6}', next(iter(keys), '')):
            raise RuntimeError(f'SAP displayed {display!r}, but its six-digit commodity key could not be uniquely verified.')
        return next(iter(keys))


def maintain_material(session, identity, material, code, stopped, code_reader=None):
    code_reader = code_reader if code_reader is not None else CommodityCodeReader()
    open_classification(session, identity, material, stopped)
    added = select_class(session, material, stopped, True)
    target = characteristic(session, stopped)
    display = input_text(target)
    before = code_reader.read(session, target, stopped)
    if before == code and not added:
        return 'skipped', before, 'Already has the requested Sub-commodity; not saved again.'
    if display and not re.fullmatch(r'[0-9]{6}', display):
        # Opening/closing value help can replace the input control handle.
        target = characteristic(session, stopped)
        if input_text(target) != display:
            raise RuntimeError('The original Sub-commodity changed before editing.')
    if not target.Changeable:
        raise RuntimeError('The Sub-commodity field is read-only in SAP.')
    check_stop(stopped)
    target.SetFocus()
    target.Text = code
    if str(target.Text or '').strip() != code:
        raise RuntimeError('SAP did not retain the full six-digit Sub-commodity.')
    ensure_clear(session, 'Before Save')
    if session_identity(session) != identity or str(session.Info.Transaction).upper() != 'MM02':
        raise RuntimeError('The original MM02 session could not be verified before Save.')
    button = control(session, SAVE)
    check_stop(stopped)
    try:
        button.Press()  # One Save only, including when COM throws or SAP warns.
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if not session.Busy:
                ensure_clear(session, 'After Save')
                kind, message = status(session)
                if kind == 'S':
                    # Never use the just-edited control as proof of persistence.
                    open_classification(session, identity, material, lambda: False)
                    select_class(session, material, lambda: False, False)
                    actual = code_reader.read(session, characteristic(session, lambda: False), lambda: False)
                    if actual != code:
                        raise RuntimeError(f'The reopened material has a different Sub-commodity: expected {code}, read {actual or "(blank)"}.')
                    return 'success', before, message or 'Saved and verified by reopening the same material.'
            time.sleep(.10)
        raise RuntimeError('SAP did not return a successful save status.')
    except Exception as error:
        raise SaveUncertain(f'Save was sent once, but the result could not be verified. Check SAP before retrying. {error}') from error


def connect(interaction):
    connector = SapGuiConnector('VCE - One Digital Core [949]', 'VCE', '100',
                                stop=interaction.stop_event.is_set, cancelled=HubStopped)

    def verified():
        session, meta = connector.select(allow_open=False)
        if meta['transaction'] not in HOME:
            raise SapGuiIssue('MM02_HOME_REQUIRED', 'Open an idle Production 949 window at SAP Easy Access. No business window will be changed.',
                              '请在正式 949 登录中准备一个停在 SAP 首页的空闲窗口。不会切换已有业务页面。')
        return session

    try:
        return verified()
    except SapGuiIssue as error:
        return interaction.wait('SIGN_IN', error.issue_summary, error.issue_summary_zh, verified, str(error))


def write_result(path, tasks, results):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'MM02_Result'
    sheet.append(['Material', 'Sub-commodity', 'Previous value', 'Excel rows', 'Status', 'Message'])
    for index, task in enumerate(tasks):
        result = results[index] if index < len(results) else dict(status='not processed', previous='', message='')
        sheet.append([task['material'], task['subCommodity'], result['previous'],
                      ', '.join(map(str, task['excelRows']))[:30000], result['status'], result['message'][:2000]])
        for cell in sheet[sheet.max_row]:
            cell.data_type = 's'  # Text IDs and untrusted SAP messages must not become formulas.
    for cell in sheet[1]:
        cell.font = Font(bold=True, color='FFFFFF')
        cell.fill = PatternFill('solid', fgColor='16355A')
        cell.alignment = Alignment(vertical='center')
    for column, width in zip('ABCDEF', (23, 20, 20, 18, 19, 78)):
        sheet.column_dimensions[column].width = width
    sheet.freeze_panes = 'A2'
    sheet.auto_filter.ref = sheet.dimensions
    staging = path.with_suffix('.tmp.xlsx')
    workbook.save(staging)
    staging.replace(path)


def run(directory, interaction):
    tasks = validate_tasks(json.loads((directory / 'mm02-input.json').read_text(encoding='utf-8')))
    results = []
    error_code, summary = '', ''
    log_path = directory / 'mm02-progress.jsonl'
    result_path = directory / 'MM02_Sub_commodity_Result.xlsx'
    stopped = interaction.stop_event.is_set
    with log_path.open('x', encoding='utf-8') as log:
        try:
            emit('connecting', total=len(tasks), message='Checking the signed-in Production 949 SAP window.')
            session = connect(interaction)
            identity = session_identity(session)
            if (identity[1].upper(), identity[2]) != ('VCE', '100'):
                raise RuntimeError('The selected SAP window is not Production 949.')
            code_reader = CommodityCodeReader()
            for index, task in enumerate(tasks):
                check_stop(stopped)
                material, code = task['material'], task['subCommodity']
                emit('record', current=index, total=len(tasks), material=material, status='running', message=f'Processing material {material}.')
                log.write(json.dumps(dict(material=material, excelRows=task['excelRows'], status='started')) + '\n')
                log.flush()
                try:
                    outcome, before, message = maintain_material(session, identity, material, code, stopped, code_reader)
                except RowRejected as error:
                    outcome, before, message = 'failed', '', str(error)
                except HubStopped:
                    raise
                except Exception as error:
                    outcome, before, message = 'failed', '', str(error)
                    error_code = 'MM02_SAVE_UNVERIFIED' if isinstance(error, SaveUncertain) else 'MM02_SCREEN_UNVERIFIED'
                    summary = f'Material {material} (Excel row {task["excelRows"][0]}): {message}'
                result = dict(status=outcome, previous=before, message=message)
                results.append(result)
                log.write(json.dumps(dict(material=material, **result)) + '\n')
                log.flush()
                emit('record', current=index + 1, total=len(tasks), material=material, status=outcome, message=f'{material}: {message}')
                if error_code:
                    break
        except HubStopped:
            error_code, summary = 'CANCELLED', 'Stopped. Verified SAP changes are preserved.'
        except Exception as error:
            error_code, summary = 'MM02_EXECUTION_FAILED', str(error)
    succeeded = sum(item['status'] == 'success' for item in results)
    skipped = sum(item['status'] == 'skipped' for item in results)
    failed = sum(item['status'] == 'failed' for item in results)
    emit('saving', message='Saving the separate MM02 result workbook in the Hub log folder.')
    try:
        write_result(result_path, tasks, results)
    except Exception as error:
        error_code = error_code or 'MM02_RESULT_FAILED'
        summary = f'{summary} The Excel result could not be saved; use the run log. {error}'.strip()
    if not summary:
        summary = f'MM02 finished: {succeeded} updated, {skipped} unchanged, {failed} failed.'
    emit('complete', success=not error_code, errorCode=error_code, message=summary, total=len(tasks),
         processed=len(results), succeeded=succeeded, skipped=skipped, failed=failed)


def main():
    import pythoncom
    directory = Path(os.environ['HUB_ARTIFACT_DIR']).resolve(strict=True)
    interaction = HubUserInteraction('Sub-commodity', emit)
    interaction.start_listener()
    pythoncom.CoInitialize()
    try:
        run(directory, interaction)
        return 0
    finally:
        pythoncom.CoUninitialize()


if __name__ == '__main__':
    raise SystemExit(main())
