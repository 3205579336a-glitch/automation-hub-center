"""Read-only APQP discovery POC; reuse the existing Hub APQP session adapter.

No Save, date assignment, popup confirmation, connection creation or blind Back.
Raw grid columns are evidence, not a guessed APQP/business-key mapping.
"""
from datetime import datetime, timezone
import json
import time

from apqp_dates import ApqpDateIssue, DATE_FIELDS, ID_OWNER, ID_PROJECT, date_value, fingerprint, field_definitions

POC_POLICY = 'apqp-dates-read-only-v1'
HOME_TRANSACTIONS = {'SESSION_MANAGER', 'SMEN', 'S000'}


def collection_values(value, limit=512):
    """Enumerate known SAP GuiCollection APIs without COM default stringification."""
    if isinstance(value, (list, tuple)):
        values = list(value)
    elif isinstance(value, str):
        values = [value]  # A title is one string, not an invented delimited list.
    else:
        count = value.Count
        if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= limit:
            raise ValueError('Invalid SAP collection Count')
        values = []
        for index in range(count):
            try:
                item = value.ElementAt(index)
            except AttributeError:
                item = value.Item(index)
            values.append(item)
    if len(values) > limit or not all(isinstance(item, str) for item in values):
        raise ValueError('SAP collection is too large or contains non-text entries')
    return values


class ApqpDiscovery:
    def __init__(self, legacy, ref, application, stop=None, clock=time.monotonic, sleep=time.sleep):
        self.legacy, self.ref, self.application = legacy, ref, application
        self.stop = stop or (lambda: False)
        self.clock, self.sleep = clock, sleep
        self.session = legacy.get_session_by_ref(ref, application)
        self.identity = self._identity()
        if not all(self.identity) or self.identity[1:] != (ref.system, ref.client, ref.user):
            self.fail('SAP_SESSION_LOST', 'The SAP session identity could not be verified.', '无法确认 SAP 会话身份。')
        self.query_dispatched = self.navigation_dispatched = False
        self.detail_dispatched = False
        self.return_dispatched = False
        self._detail_controls = {}
        self.bulk_detail_enabled = False  # Business read collector opts in; writes/POC keep the original path.
        self._bulk_detail_reader = None
        self._bulk_detail_supported = None
        self._detail_was_bulk = False
        self.metrics = dict(sessionChecks=0, referenceResolutions=1, dateValueReads=0,
                            gridCellReads=0, detailsOpened=0, detailsReturned=0, bulkDetailReads=0)
        self.latest = dict(policy=POC_POLICY, readOnly=True, writesEnabled=False,
                           session=dict(sessionId=self.identity[0], system=ref.system, client=ref.client, sapUser=ref.user),
                           fieldDefinitions=field_definitions(), findings={
                               'businessIdentityConfirmed': False, 'allMatchingRecordsConfirmed': False,
                               'directTextAssignment': 'NOT_TESTED', 'saveAndReopenVerification': 'NOT_TESTED'},
                           performance=self.metrics)

    @staticmethod
    def fail(code, message, zh, details=''):
        raise ApqpDateIssue(code, message, zh, details)

    def _identity(self):
        return (str(self.session.Id), *self.legacy.read_session_identity(self.session))

    def check_stop(self):
        if self.stop():
            self.fail('CANCELLED', 'Read-only inspection stopped. No SAP dates were changed.', '只读检查已停止，未修改 SAP 日期。')

    def guard(self, allow_home=False, waiting=False, *, allow_navigation=False, transition_from=None):
        self.check_stop()
        try:
            # Keep the original COM object, not a repeatedly resolved index that
            # could now name a different window. Identity/state stay live; a
            # disconnected object fails closed and is never silently rebound.
            self.metrics['sessionChecks'] += 1
            if self._identity() != self.identity:
                raise ValueError('System/Client/User/session changed')
            busy = self.session.Busy
            if not isinstance(busy, (bool, int)):
                raise ValueError('Busy is unreadable')
            if self.session.FindById('wnd[1]', False) is not None:
                self.fail('SAP_UNEXPECTED_POPUP', 'Handle the SAP dialog manually. No option was selected.',
                          '请手动处理 SAP 弹窗，系统未代选任何按钮。')
            transaction = self.legacy.readable_transaction(self.session)
            if (transaction != self.legacy.TCODE and not (allow_home and transaction in HOME_TRANSACTIONS)
                    and not (allow_navigation and bool(transaction))
                    and not (waiting and transition_from and transaction == transition_from)):
                self.fail('SAP_SESSION_UNAVAILABLE', 'This window is being used by another transaction; it will not be interrupted.',
                          '此窗口正在处理其他事务，不会被中断。', transaction)
            if busy and not waiting:
                self.fail('SAP_SLOW', 'SAP is busy. No action was sent; wait for it to respond.', 'SAP 正在处理，未发送操作，请等待响应。')
            return not bool(busy)
        except ApqpDateIssue:
            raise
        except Exception as error:
            self.fail('SAP_SESSION_LOST', 'The original SAP session could not be read. Check its connection.',
                      '无法读取原 SAP 会话，请检查连接。', str(error))

    def wait(self, read, description, allow_home=False, timeout=20, *, transition_from=None):
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            self.check_stop()
            busy = self.session.Busy
            if not isinstance(busy, (bool, int)):
                self.fail('SAP_SESSION_LOST', 'SAP Busy state is unreadable.', '无法读取 SAP 忙碌状态。')
            if busy:
                # Info/controls can block during SAP's server round trip. Poll
                # Busy + Stop only; validate the entire session before accepting
                # any ready page. Nothing is dispatched while waiting.
                self.sleep(0.02)
                continue
            # Polls only read. Validate the bound session/dialog/transaction once
            # when ready, immediately before accepting a result or sending action.
            value = read()
            if value is not None:
                self.guard(allow_home)
                return value
            self.guard(allow_home, waiting=True, transition_from=transition_from)
            self.sleep(0.02)
        self.fail('SAP_SLOW', 'SAP has not reached the expected read-only screen. Inspect it before trying again.',
                  'SAP 尚未进入预期只读页面，请检查后再试。不会重放操作。', description)

    def optional(self, identifier):
        # Only a genuine optional missing control means absence. COM failures
        # propagate; an unreadable page is not an empty result/date.
        return self.session.FindById(identifier, False)

    def selection(self):
        controls = [self.optional(identifier) for identifier in (self.legacy.ID_PLANT, ID_PROJECT, ID_OWNER)]
        return controls if all(control is not None for control in controls) else None

    def grid_viewport(self, grid):
        start, visible = grid.FirstVisibleRow, grid.VisibleRowCount
        if (isinstance(start, bool) or not isinstance(start, int) or start < 0
                or isinstance(visible, bool) or not isinstance(visible, int) or visible < 1):
            self.fail('SAP_GRID_UNREADABLE', 'SAP grid visibility could not be verified.', '无法确认 SAP Grid 可见行范围。')
        return start, visible

    def _row_values(self, grid, index, columns):
        values = {}
        for column in columns:
            self.check_stop()
            value = grid.GetCellValue(index, column['id'])
            self.metrics['gridCellReads'] += 1
            values[column['id']] = '' if value is None else str(value)
        return values

    def inspect_grid(self, max_rows=20, scroll=False, required_columns=None, *, batch_rows=False):
        if isinstance(max_rows, bool) or not isinstance(max_rows, int) or not 1 <= max_rows <= 10000:
            raise ValueError('Inspection row limit must be between 1 and 10000.')
        grid = self.wait(lambda: self.optional(self.legacy.ID_RESULT_GRID), 'APQP result grid')
        all_columns = collection_values(grid.ColumnOrder)
        if not all_columns or len(set(all_columns)) != len(all_columns):
            self.fail('SAP_GRID_UNREADABLE', 'The real SAP grid column IDs could not be enumerated.', '无法枚举 SAP Grid 的真实技术列名。')
        columns = list(required_columns) if required_columns is not None else all_columns
        if not columns or len(set(columns)) != len(columns) or not set(columns).issubset(all_columns):
            self.fail('SAP_GRID_COLUMNS_CHANGED', 'Required APQP identity columns are missing.', '缺少必要的 APQP 标识列，请联系 Key User。')
        count = grid.RowCount
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            self.fail('SAP_GRID_UNREADABLE', 'SAP returned an invalid row count.', 'SAP 返回的行数无效。')
        original_start, original_visible = self.grid_viewport(grid)
        definitions = []
        for position, column in enumerate(columns):
            self.check_stop()
            if position % 16 == 0:
                self.guard()
            item = dict(id=column)
            try:
                item['titles'] = collection_values(grid.GetColumnTitles(column), 32)
            except Exception as error:
                item.update(titles=[], titleReadError=str(error))
            definitions.append(item)
        self.guard()
        evidence = dict(rowCount=count, columnCount=len(all_columns), inspectedColumnCount=len(columns), columns=definitions,
                        rows=[], complete=False, technicalIdentityCandidates=[], emptyObservedRows=[],
                        notReadOutsideViewport=[], viewport=dict(initialFirstVisibleRow=original_start,
                            initialVisibleRowCount=original_visible, scrollingAllowed=bool(scroll),
                            pages=[], restoreStatus='NOT_NEEDED'))
        self.latest['grid'] = evidence
        moved = False
        try:
            for index in range(min(count, max_rows)):
                # Business queries read six identity cells per row, with live
                # session/layout checks bracketing each loaded viewport. No SAP
                # action occurs within this batch; Stop is still checked per cell.
                if not batch_rows or index == 0 or not start <= index < start + visible:
                    self.guard()
                    grid = self.session.FindById(self.legacy.ID_RESULT_GRID)
                    if grid.RowCount != count:
                        self.fail('SAP_GRID_CHANGED', 'The SAP result changed while being read.', '读取期间 SAP 结果已变化。')
                    start, visible = self.grid_viewport(grid)
                if not start <= index < start + visible:
                    if not scroll:
                        # Windows ALV may return empty strings for unloaded
                        # off-screen rows. Never call those empty APQPs.
                        evidence['notReadOutsideViewport'].append(index)
                        continue
                    self.guard()
                    moved = True  # Even an uncertain setter is not replayed.
                    grid.FirstVisibleRow = min(index, max(0, count - visible))

                    def visible_grid():
                        current = self.optional(self.legacy.ID_RESULT_GRID)
                        if current is None:
                            return None
                        first, size = self.grid_viewport(current)
                        return current if first <= index < first + size else None

                    grid = self.wait(visible_grid, 'APQP grid page loading')
                    start, visible = self.grid_viewport(grid)
                page = dict(firstVisibleRow=start, visibleRowCount=visible)
                if not evidence['viewport']['pages'] or evidence['viewport']['pages'][-1] != page:
                    # Enumerate the (COM) column collection per page, not for
                    # every row. Cell access uses technical IDs, not positions.
                    if collection_values(grid.ColumnOrder) != all_columns:
                        self.fail('SAP_GRID_CHANGED', 'SAP grid columns changed during paging.', '分页期间 SAP Grid 列已变化。')
                    evidence['viewport']['pages'].append(page)
                values = {}
                for column in columns:
                    # No SAP action per cell. Check Stop per cell and verify
                    # identity/dialogs before accepting a complete row.
                    self.check_stop()
                    value = grid.GetCellValue(index, column)
                    self.metrics['gridCellReads'] += 1
                    if not isinstance(value, (str, int, float, bool)) and value is not None:
                        self.fail('SAP_GRID_UNREADABLE', 'A SAP grid cell returned an unsupported value.', 'SAP Grid 单元格返回了不可读取的值。', f'{index}/{column}')
                    values[column] = '' if value is None else str(value)
                if not batch_rows or index + 1 == min(count, max_rows) or index + 1 >= start + visible:
                    self.guard()
                    if batch_rows and (grid.RowCount != count or self.grid_viewport(grid) != (start, visible)):
                        self.fail('SAP_GRID_CHANGED', 'The loaded SAP page changed during reading.', '读取期间 SAP 已加载页面发生变化。')
                if not any(value.strip() for value in values.values()):
                    evidence['emptyObservedRows'].append(index)
                evidence['rows'].append(dict(index=index, values=values, fingerprint=fingerprint(values)))
        finally:
            if moved:
                if self.stop():
                    evidence['viewport']['restoreStatus'] = 'SKIPPED_STOP'
                else:
                    try:
                        self.guard()
                        current = self.session.FindById(self.legacy.ID_RESULT_GRID)
                        if current.RowCount != count or collection_values(current.ColumnOrder) != all_columns:
                            raise ValueError('Grid changed; do not scroll another result')
                        current.FirstVisibleRow = original_start
                        self.guard()
                        evidence['viewport']['restoreStatus'] = ('RESTORED' if self.grid_viewport(current)[0] == original_start else 'NOT_CONFIRMED')
                    except Exception as error:
                        evidence['viewport'].update(restoreStatus='SKIPPED_OR_FAILED', restoreDetails=str(error))
        self.guard()
        if grid.RowCount != count or collection_values(grid.ColumnOrder) != all_columns:
            self.fail('SAP_GRID_CHANGED', 'The SAP result changed while being read. Inspect it again.', '读取期间 SAP 结果已变化，请重新检查。')
        evidence['complete'] = len(evidence['rows']) == count and not evidence['emptyObservedRows']
        if evidence['rows']:
            for column in columns:
                values = [row['values'][column] for row in evidence['rows']]
                if all(values) and len(set(values)) == len(values):
                    evidence['technicalIdentityCandidates'].append(dict(column=column,
                        uniqueInObservedRows=True, uniqueAcrossReturnedResult=True if evidence['complete'] else None,
                        businessIdentityConfirmed=False))
        self.latest['findings']['returnedGridFullyRead'] = evidence['complete']
        return evidence

    def discover(self, project, owner, max_rows=10000, scroll=False, required_columns=None,
                 *, allow_navigation=False, batch_rows=False):
        if self.navigation_dispatched or self.query_dispatched:
            self.fail('SAP_QUERY_ALREADY_DISPATCHED', 'This POC query cannot be replayed. Inspect the current page instead.', '本次 POC 查询不能重放，请改为检查当前页面。')
        if not project.strip() or not owner.strip():
            raise ValueError('NPL and User ID are required.')
        if isinstance(max_rows, bool) or not isinstance(max_rows, int) or not 1 <= max_rows <= 10000:
            raise ValueError('Inspection row limit must be between 1 and 10000.')
        self.guard(allow_home=True, allow_navigation=allow_navigation)
        transaction = self.legacy.readable_transaction(self.session)
        if transaction == self.legacy.TCODE and self.selection() is None and self.optional(self.legacy.ID_RESULT_GRID) is None:
            self.fail('SAP_SESSION_UNAVAILABLE', 'Use SAP home or a clean APQP query page. Existing APQP detail work will not be abandoned.',
                      '请使用 SAP 首页或干净的 APQP 查询页，不会退出已有 APQP 详情工作。')
        self.navigation_dispatched = True
        # A new selection screen avoids reusing the old material/vendor query.
        # No command-box fallback or retry after an uncertain navigation call.
        try:
            self.session.StartTransaction(self.legacy.TCODE)
        except Exception as error:
            self.fail('SAP_NAVIGATION_UNCERTAIN', 'SAP navigation outcome is uncertain. Inspect the original window.', '无法确认 SAP 跳转结果，请检查原窗口。', str(error))
        controls = self.wait(self.selection, 'Plant/NPL/User query controls', transition_from=transaction)
        self.guard()
        criteria = dict(plant='C100', project=project.strip(), ownerFilter=owner.strip())
        for control, value in zip(controls, criteria.values()):
            self.guard()
            control.Text = value  # Query filters only; never GS_ITAB date controls.
        self.guard()
        if [str(control.Text).strip() for control in controls] != list(criteria.values()):
            self.fail('SAP_QUERY_FILTER_MISMATCH', 'SAP did not retain the requested NPL/User filters.', 'SAP 未保留指定的 NPL/User 筛选条件。')
        legacy_filters = {}
        for name, identifier, attribute in (
            ('materialLow', self.legacy.ID_MATERIAL, 'Text'), ('vendorLow', self.legacy.ID_VENDOR, 'Text'),
            ('legacyP_C3', self.legacy.ID_CHECK_C3, 'Selected')):
            control = self.optional(identifier)
            legacy_filters[name] = getattr(control, attribute) if control is not None else None
        # Do not silently clear or copy legacy filter choices. A non-empty
        # Material/Vendor would invalidate the "NPL + User" research question.
        if any(str(legacy_filters[name] or '').strip() for name in ('materialLow', 'vendorLow')):
            self.fail('SAP_EXTRA_FILTERS', 'The query has additional Material/Vendor filters. Clear them manually and inspect again.',
                      '查询页还保留了物料/供应商条件，请手动清空并重新检查。')
        self.latest['query'] = dict(criteria=criteria, observedLegacyFilters=legacy_filters,
                                    otherAndHiddenFiltersVerified=False, executeCount=0)
        execute = self.session.FindById(self.legacy.ID_EXECUTE)
        self.guard()
        self.query_dispatched = True
        self.latest['query']['executeCount'] = 1  # Set before dispatch: never replay.
        try:
            execute.Press()
        except Exception as error:
            self.fail('SAP_QUERY_OUTCOME_UNCERTAIN', 'Query outcome is uncertain; no second Execute was sent.', '查询结果未确认，未再次执行。', str(error))
        return self.inspect_grid(max_rows, scroll=scroll, required_columns=required_columns, batch_rows=batch_rows)

    def read_open_detail(self):
        self.guard()
        return self._read_detail_fields()

    def _bulk_detail_values(self):
        """Optional SAP object-tree API, already used by the Source List reader.

        Only genuine absence of the API selects the compatibility path. Invalid
        JSON, foreign IDs and unreadable dates are never accepted as blank dates.
        No tree/other SAP text is persisted; retain only the four known fields.
        """
        if not self.bulk_detail_enabled or self._bulk_detail_supported is False:
            return None
        self.check_stop()
        if self._bulk_detail_reader is None:
            try:
                self._bulk_detail_reader = self.session.GetObjectTree
            except Exception as error:
                if isinstance(error, AttributeError) or getattr(error, 'hresult', None) in {-2147352570, -2147352573}:
                    self._bulk_detail_supported = False
                    return None
                raise
        root = DATE_FIELDS[0].control_id.rsplit('/', 1)[0]
        # Observed SAP property DISPIDs: Id, Type, Text, Changeable.
        raw = self._bulk_detail_reader(root, [32025, 32015, 32000, 32009])
        if not isinstance(raw, str) or len(raw) > 2_000_000:
            self.fail('SAP_DETAIL_UNREADABLE', 'SAP detail export is invalid.', 'SAP 详情批量读取无效。')
        try:
            nodes, fields, seen_root, count = [json.loads(raw)], {}, False, 0
            by_id = {field.control_id: field.key for field in DATE_FIELDS}
            while nodes:
                self.check_stop()
                node = nodes.pop()
                count += 1
                if count > 10000 or not isinstance(node, dict):
                    raise ValueError('Invalid/oversized object-tree node')
                properties = node.get('properties', {})
                children = node.get('children', [])
                if not isinstance(properties, dict) or not isinstance(children, list):
                    raise ValueError('Invalid object-tree properties/children')
                identifier = properties.get('Id', '')
                if not isinstance(identifier, str):
                    raise ValueError('Invalid control Id')
                if identifier.startswith('/app/'):
                    prefix = self.identity[0].rstrip('/') + '/'
                    if not identifier.startswith(prefix):
                        raise ValueError('Object tree belongs to another SAP session')
                    identifier = identifier[len(prefix):]
                if identifier == root:
                    seen_root = True
                if identifier in by_id:
                    key = by_id[identifier]
                    if key in fields:
                        raise ValueError('Duplicate APQP date control')
                    fields[key] = properties
                nodes.extend(children)
            if not seen_root:
                raise ValueError('Requested APQP detail container is missing')
        except ApqpDateIssue:
            raise
        except (ValueError, TypeError) as error:
            self.fail('SAP_DETAIL_UNREADABLE', 'SAP detail export could not be verified.', '无法核实 SAP 详情批量读取结果。', str(error))
        self._bulk_detail_supported = True
        self.metrics['bulkDetailReads'] += 1
        return fields

    def _read_detail_fields(self):
        """Called only after a checked detail-ready boundary; no SAP actions."""
        values = {}
        self._detail_controls = {}
        bulk = self._bulk_detail_values()
        self._detail_was_bulk = bulk is not None
        self.latest['detail'] = dict(fields=values, allFourReadable=False,
                                     recordIdentityOnDetailConfirmed=False, safeForUpdates=False)
        for field in DATE_FIELDS:
            self.check_stop()
            control = self.optional(field.control_id) if bulk is None else bulk.get(field.key)
            item = dict(controlId=field.control_id, label=field.temporary_label, labelIsTemporary=False)
            values[field.key] = item
            if control is None:
                item.update(status='UNREADABLE', date=None)
                continue
            try:
                text = control.Text if bulk is None else control.get('Text')
                self.metrics['dateValueReads'] += 1
                if not isinstance(text, str):
                    raise ValueError('SAP date Text is not a string')
                item['text'] = text
                if bulk is None:
                    self._detail_controls[field.key] = control
                normalized = date_value(text)
                item.update(status='READ' if normalized else 'EMPTY', date=normalized)
            except ValueError as error:
                item.update(status='INVALID_DATE', date=None, details=str(error))
            except Exception as error:
                item.update(status='UNREADABLE', date=None, details=str(error))
            try:
                changeable = control.Changeable if bulk is None else control.get('Changeable')
                if isinstance(changeable, str) and changeable.strip().lower() in {'true', 'false'}:
                    changeable = changeable.strip().lower() == 'true'
                item['changeableObserved'] = changeable if isinstance(changeable, bool) else None
            except Exception:
                item['changeableObserved'] = None
        self.guard()
        self.latest['detail']['allFourReadable'] = all(item['status'] in {'READ', 'EMPTY'} for item in values.values())
        return self.latest['detail']

    def open_observed_row(self, index, *, load_dates=True):
        if self.detail_dispatched:
            self.fail('SAP_DETAIL_ALREADY_DISPATCHED', 'Detail opening cannot be replayed automatically.', '不会自动重复打开详情。')
        evidence = self.latest.get('grid', {})
        rows = [row for row in evidence.get('rows', []) if row['index'] == index]
        if len(rows) != 1:
            raise ValueError('Inspect this exact result row before opening it.')
        self.guard()
        grid = self.session.FindById(self.legacy.ID_RESULT_GRID)
        start, visible = self.grid_viewport(grid)
        if not start <= index < start + visible:
            if not evidence.get('viewport', {}).get('scrollingAllowed'):
                self.fail('SAP_GRID_ROW_NOT_VISIBLE', 'The inspected row is not loaded in the current viewport. No detail was opened.',
                          '所检查行不在当前已加载可见区，未打开详情。')
            if grid.RowCount != evidence['rowCount']:
                self.fail('SAP_GRID_CHANGED', 'The result row count changed. No detail was opened.', '结果行数已变化，未打开详情。')
            self.guard()
            grid.FirstVisibleRow = min(index, max(0, evidence['rowCount'] - visible))

            def visible_grid():
                current = self.optional(self.legacy.ID_RESULT_GRID)
                if current is None:
                    return None
                first, size = self.grid_viewport(current)
                return current if first <= index < first + size else None

            grid = self.wait(visible_grid, 'inspected APQP row loading')
        current = self._row_values(grid, index, evidence['columns'])
        if grid.RowCount != evidence['rowCount'] or fingerprint(current) != rows[0]['fingerprint']:
            self.fail('SAP_GRID_CHANGED', 'The selected result row changed. No detail was opened.', '所选结果行已变化，未打开详情。')
        grid.SelectedRows = str(index)
        if str(grid.SelectedRows).strip() != str(index):
            self.fail('SAP_SELECTION_MISMATCH', 'The requested result row was not selected.', '未选中指定的结果行。')
        selected = self._row_values(grid, index, evidence['columns'])
        if fingerprint(selected) != rows[0]['fingerprint']:
            self.fail('SAP_GRID_CHANGED', 'The selected row changed before opening. No action was sent.', '所选行在打开前已变化，未发送操作。')
        self.guard()
        self.detail_dispatched = True
        self.metrics['detailsOpened'] += 1
        self.latest['detailNavigation'] = dict(observedRow=index, rowFingerprint=rows[0]['fingerprint'], executeCount=1)
        try:
            self.session.FindById(self.legacy.ID_EXECUTE).Press()
        except Exception as error:
            self.fail('SAP_DETAIL_OUTCOME_UNCERTAIN', 'Detail opening could not be confirmed. Inspect SAP; no action was replayed.',
                      '无法确认详情打开结果，请检查 SAP，未重放操作。', str(error))
        self.wait(lambda: True if any(self.optional(field.control_id) is not None for field in DATE_FIELDS) else None,
                  'recorded APQP G/H detail controls')
        return self._read_detail_fields() if load_dates else None

    def return_read_detail(self):
        """Leave only our own unchanged detail, once; never confirm a popup.

        Reuse controls only within this open page. The second check needs Text
        only, not repeated FindById/Changeable/labels and nested guards. Even
        editable dates are compared, so a user's concurrent edit is not abandoned.
        """
        if (not self.detail_dispatched or self.return_dispatched
                or not self.latest.get('detail', {}).get('allFourReadable')):
            self.fail('SAP_DETAIL_CHANGED', 'No completed owned detail is available to return from.', '没有已完成读取的当前详情，未返回。')
        observed = {}
        bulk = self._bulk_detail_values() if self._detail_was_bulk else None
        for field in DATE_FIELDS:
            self.check_stop()
            control = self._detail_controls.get(field.key) if not self._detail_was_bulk else (bulk or {}).get(field.key)
            if control is None:
                self.fail('SAP_DETAIL_CHANGED', 'The open detail is no longer readable. It was not closed.', '当前详情已不可读取，未关闭。')
            observed[field.key] = control.Text if not self._detail_was_bulk else control.get('Text')
            self.metrics['dateValueReads'] += 1
        self.guard()
        if observed != {key: value.get('text') for key, value in self.latest['detail']['fields'].items()}:
            self.fail('SAP_DETAIL_CHANGED', 'The open detail changed during the read. It was not closed or saved.', '读取期间详情发生变化，未关闭或保存。')
        self.return_dispatched = True
        self.session.FindById(self.legacy.ID_BACK).Press()
        grid = self.wait(lambda: self.optional(self.legacy.ID_RESULT_GRID), 'APQP result list after detail read')
        if grid.RowCount != self.latest['grid']['rowCount']:
            self.fail('SAP_GRID_CHANGED', 'The result list changed after returning. No action was replayed.', '返回后结果列表已变化，未重放操作。')
        # Re-arm only after a positively verified return. Exceptions keep the
        # dispatched flag set: an uncertain navigation is never repeated.
        self.detail_dispatched = False
        self.return_dispatched = False
        self._detail_controls = {}
        self.metrics['detailsReturned'] += 1

    def report(self):
        return dict(self.latest, inspectedAt=datetime.now(timezone.utc).isoformat())
