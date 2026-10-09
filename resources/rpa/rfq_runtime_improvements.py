"""Hub-only read/verification hooks. No new SAP transaction or commit/retry flow."""
import os
import time
from collections import defaultdict

from rfq_interaction import check_session, session_identity

# Confirmed by the user's ZMFM050072 NPL SAP GUI recording:
# CUSTOMER1.setCurrentCell(-1, "ZCOMCODE") / selectColumn("ZCOMCODE").
NPL_COMMODITY_COLUMN = 'ZCOMCODE'
# Confirmed on the NPL CUSTOMER1 grid. MPPPSPID belongs to other RFQ screens;
# do not change the engine's shared constant or Buyer Receipt field mapping.
NPL_PROJECT_COLUMN = 'ZPSPID'


def collection_strings(value):
    # Do not stringify COM collections: that can invoke an unsafe default member.
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [item for item in value if isinstance(item, str)]
    output = []
    try:
        count = min(1000, int(value.Count))
    except Exception:
        return output
    for index in range(count):
        for accessor in ('ElementAt', 'Item'):
            try:
                item = getattr(value, accessor)(index)
                if isinstance(item, str):
                    output.append(item)
                    break
            except Exception:
                pass
    return output


def commodity_column(grid):
    columns = collection_strings(grid.ColumnOrder)
    column = os.environ.get('RFQ_COMMODITY_COLUMN', '').strip() or NPL_COMMODITY_COLUMN
    if column not in columns:
        # Never guess a different field from its translated/display title.
        raise ValueError('Verified Commodity column is not present: ' + column + '. No Buyer Receipt was created.')
    return column


def inspect_commodity(engine, sap, grid, tasks):
    column = commodity_column(grid)
    columns = collection_strings(grid.ColumnOrder)
    for field in ('MATNR', 'WERKS', NPL_PROJECT_COLUMN):
        if field not in columns:
            raise ValueError('NPL column is not present: ' + field)
    def read(row, field, material):
        try:
            return grid.GetCellValue(row, field)
        except Exception as exc:
            raise ValueError(f'NPL read failed: material {material}, SAP row {row + 1}, field {field}: {exc}') from exc
    # Do not use get_cell here: it converts a failed COM read into an empty
    # string, which cannot prove that a master-data field is actually missing.
    mapping = defaultdict(list)
    for row in range(int(grid.RowCount)):
        material = engine.normalize_identifier(read(row, 'MATNR', '?'))
        mapping[material].append(row)
    missing = []
    for task in tasks:
        rows = mapping.get(task.material, [])
        if len(rows) != 1:
            raise ValueError(f'Material {task.material}: expected one NPL row, found {len(rows)}.')
        row = rows[0]
        if engine.normalize_identifier(read(row, 'WERKS', task.material)).upper() != task.plant or engine.normalize_identifier(read(row, NPL_PROJECT_COLUMN, task.material)) != task.project:
            raise ValueError(f'Material {task.material}: NPL Plant/Project mismatch.')
        value = read(row, column, task.material)
        if value is not None and not isinstance(value, str):
            raise ValueError(f'NPL read failed: material {task.material}, SAP row {row + 1}, field {column}: unexpected value type.')
        if value is None or not value.strip() or value.strip().casefold() in {'null', 'none'}:
            missing.append(task.material)
    return column, missing


class GridProbe:
    """Transparent per-writer timing proxy; forwards the original COM calls in order."""
    def __init__(self, grid, runtime):
        object.__setattr__(self, '_grid', grid)
        object.__setattr__(self, '_runtime', runtime)

    def __getattr__(self, name):
        target = getattr(self._grid, name)
        if name in {'ModifyCell', 'ModifyCheckBox', 'TriggerModified', 'PressEnter'}:
            def measured(*args, **kwargs):
                category = 'validation' if name == 'PressEnter' else 'trigger' if name == 'TriggerModified' else 'write.' + (str(args[1]) if len(args) > 1 else name)
                return self._runtime.measure(category, lambda: target(*args, **kwargs))
            return measured
        return target

    def __setattr__(self, name, value):
        self._runtime.measure('focus', lambda: setattr(self._grid, name, value))


class RuntimeImprovements:
    def __init__(self, engine, event, controller, replace, clock=time.monotonic, sleep=time.sleep):
        self.engine, self.event, self.controller, self.replace = engine, event, controller, replace
        self.clock, self.sleep = clock, sleep
        self.group = None
        self.tasks = []
        self.phase = 'NPL'
        self.profile = None
        self.step_profile = defaultdict(lambda: {'seconds': 0., 'calls': 0})
        self.hard_seconds = self.setting('RFQ_WAIT_HARD_TIMEOUT_SEC', 180, 30, 900)
        self.poll_seconds = self.setting('RFQ_WAIT_POLL_SEC', engine.SAP_POLL_SEC, .05, 2)

    @staticmethod
    def setting(name, default, low, high):
        try:
            value = float(os.environ.get(name, default))
            return value if low <= value <= high else default
        except (ValueError, TypeError):
            return default

    def measure(self, category, work):
        start = self.clock()
        try:
            return work()
        finally:
            profile = self.profile if self.profile is not None else self.step_profile
            profile[category]['seconds'] += max(0, self.clock() - start)
            profile[category]['calls'] += 1

    def wait(self, sap, predicate, timeout, detail, verify=None):
        start = self.clock()
        soft = max(.05, float(timeout))
        hard = max(soft, self.hard_seconds)
        warned = False
        while self.clock() - start < hard:
            self.stopped()
            try:
                result = predicate()
            except self.engine.SapRpaError:
                raise  # Preserve recognized popup/business recovery signals.
            except Exception:
                result = None
            elapsed = self.clock() - start
            if result is not None:
                if warned:
                    self.event('SAP_RECOVERED', state='RUNNING', step=self.phase, waitSeconds=round(elapsed, 1), message='SAP responded; continuing the pending step without replaying an action.')
                return result
            if elapsed >= soft:
                if not warned or elapsed - last_notice >= 5:
                    self.event('SAP_SLOW', state='SAP_SLOW', step=self.phase, waitSeconds=round(elapsed, 1), message='SAP is responding slowly. Still waiting for ' + detail + '. No action is required yet.')
                    last_notice = elapsed
                warned = True
            self.sleep(self.poll_seconds)
        issue = f'SAP has not reached the expected state after {hard:.0f}s: {detail}. No SAP action will be replayed.'
        if self.controller is not None and self.tasks:
            return self.controller.wait('SAP_SLOW_HARD_TIMEOUT', issue, self.tasks, verify,
                extra={'issueSummary': 'SAP has not reached the expected screen; automation is paused to prevent an unsafe action.',
                       'issueSummaryZh': 'SAP 尚未到达预期页面；自动化已暂停，避免不安全操作。',
                       'instructions': 'Check SAP. Recheck only verifies the pending state; it never replays a Save/Create action.',
                       'instructionsZh': '请检查 SAP。重新检查只验证当前等待状态，不会重复保存或创建。'})
        raise self.engine.SapRpaError('SAP_SLOW_HARD_TIMEOUT', issue)

    def stopped(self):
        # Preserve the accepted graceful-stop contract after BR creation starts:
        # do not interrupt a pending SAP commit / RFQ number / Excel writeback.
        # At a hard-timeout pause the shared controller still permits Stop, with
        # an explicit review warning, but never replays the uncertain action.
        if self.phase == 'NPL' and self.controller and self.controller.args.stop_file and os.path.exists(self.controller.args.stop_file):
            self.controller.cancel('SAP_WAIT')
            from rfq_interaction import HubCancelled
            raise HubCancelled()

    def install(self):
        engine, runtime = self.engine, self
        original_process = engine.process_group
        def process(sap, excel, group):
            runtime.group, runtime.tasks, runtime.phase = group, list(group.tasks), 'NPL'
            runtime.step_profile = defaultdict(lambda: {'seconds': 0., 'calls': 0})
            try:
                return original_process(sap, excel, group)
            finally:
                runtime.event('RUNTIME_PROFILE', profile={key: {'seconds': round(value['seconds'], 6), 'calls': value['calls']} for key, value in runtime.step_profile.items()},
                              message='Group synchronization and post-write verification profile; nested timings are not additive.')
        self.replace(engine, 'process_group', process)

        original_match = engine.match_exact_npl_rows
        def match_npl(sap, grid, group):
            mapping = sap.map_material_rows
            def npl_mapping(candidate, tasks, plant_column=None, project_column=None):
                if project_column == engine.COL_PROJECT_NPL:
                    project_column = NPL_PROJECT_COLUMN
                return mapping(candidate, tasks, plant_column=plant_column, project_column=project_column)
            sap.map_material_rows = npl_mapping
            try:
                return original_match(sap, grid, group)
            finally:
                sap.map_material_rows = mapping
        self.replace(engine, 'match_exact_npl_rows', match_npl)

        def wait_not_busy(sap, timeout=engine.SAP_WAIT_SEC):
            def predicate():
                return True if not bool(sap.session.Busy) else None
            # Busy alone does not prove a safe screen after a pending commit.
            return runtime.measure('busyWait', lambda: runtime.wait(sap, predicate, timeout, 'SAP Busy to clear'))
        self.replace(engine.SapSession, 'wait_not_busy', wait_not_busy)

        def wait_exists(sap, control_id, timeout=engine.SAP_WAIT_SEC):
            def predicate():
                if bool(sap.session.Busy):
                    return None
                return sap.find(control_id, required=False)
            return runtime.measure('locateGridOrControl', lambda: runtime.wait(sap, predicate, timeout, control_id))
        self.replace(engine.SapSession, 'wait_exists', wait_exists)

        def wait_grid_columns(sap, control_id, columns, timeout=engine.SAP_LONG_WAIT_SEC):
            identity = session_identity(sap)
            def predicate():
                if sap.session.Busy:
                    return None
                grid = sap.find(control_id, required=False)
                if grid is not None and all(sap.column_exists(grid, c) for c in columns):
                    return grid
                if sap.exists('wnd[1]'):
                    text = sap.window_text('wnd[1]')
                    if text:
                        raise engine.SapRpaError('SAP_POPUP', text)
                return None
            # Only NPL can safely continue here: no BR creation or commit has
            # happened, and exact matching + Commodity validation still follow.
            def verify():
                check_session(sap, identity)
                title = engine.safe_text(sap.find('wnd[0]').Text).casefold()
                if 'new part list' not in title or 'buyer receipt' in title or runtime.phase != 'NPL':
                    raise ValueError('Return to the original NPL result; an unknown screen cannot resume.')
                result = predicate()
                if result is None:
                    raise ValueError('The expected NPL grid/columns are not ready.')
                return result
            can_recheck = runtime.phase == 'NPL' and control_id == engine.ID_GRID_CUSTOMER1 and engine.COL_MATERIAL in columns
            return runtime.measure('locateGridOrControl', lambda: runtime.wait(sap, predicate, timeout, 'grid ' + control_id, verify if can_recheck else None))
        self.replace(engine.SapSession, 'wait_grid_columns', wait_grid_columns)

        for name, phase in [('fill_buyer_receipt_rows', 'Buyer Receipt'), ('fill_rfq_grid_rows', 'RFQ')]:
            self.replace(engine, name, self.writer(getattr(engine, name), phase))
        original_green = engine.green_status_debug
        def green(*args, **kwargs):
            return runtime.measure('postWriteVerification', lambda: original_green(*args, **kwargs))
        self.replace(engine, 'green_status_debug', green)

        original_create = engine.create_buyer_receipt_skipping_existing_rfq
        def create(sap, excel, group, grid, tasks):
            runtime.group, runtime.tasks, runtime.phase = group, list(tasks), 'NPL'
            grid = runtime.commodity(sap, group, grid, list(tasks))
            runtime.phase = 'Creating Buyer Receipt'
            return original_create(sap, excel, group, grid, tasks)
        self.replace(engine, 'create_buyer_receipt_skipping_existing_rfq', create)
        for name, phase in [('save_buyer_receipt', 'Saving Buyer Receipt'), ('complete_rfq_from_buyer_receipt', 'Creating RFQ')]:
            original = getattr(engine, name)
            def observe(work, label):
                def wrapped(*args, **kwargs):
                    runtime.phase = label
                    return work(*args, **kwargs)
                return wrapped
            self.replace(engine, name, observe(original, phase))

    def writer(self, original, phase):
        def wrapped(sap, grid, tasks):
            previous_profile, self.profile = self.profile, defaultdict(lambda: {'seconds': 0., 'calls': 0})
            self.phase = phase
            column_exists, mapping = sap.column_exists, sap.map_material_rows
            cache = {}
            # Cache only schema answers for this single writer/grid lifecycle.
            # No values, material mappings, or COM controls survive the call.
            optimized = os.environ.get('RFQ_SCHEMA_CACHE_ENABLED', 'true').casefold() == 'true'
            def columns(candidate, column):
                key = (id(getattr(candidate, '_grid', candidate)), column)
                if not optimized or key not in cache:
                    answer = self.measure('columnMetadata', lambda: column_exists(candidate, column))
                    if optimized:
                        cache[key] = answer
                    return answer
                return cache[key]
            sap.column_exists = columns
            sap.map_material_rows = lambda *a, **kw: self.measure('mapping', lambda: mapping(*a, **kw))
            try:
                return original(sap, GridProbe(grid, self), tasks)
            finally:
                sap.column_exists, sap.map_material_rows = column_exists, mapping
                metrics = {key: {'seconds': round(value['seconds'], 6), 'calls': value['calls']} for key, value in self.profile.items()}
                self.profile = previous_profile
                self.event('WRITE_PROFILE', step=phase, profile=metrics, message=phase + ' field-write profile (sequential; focus, TriggerModified and Enter preserved).')
        return wrapped

    def commodity(self, sap, group, grid, tasks):
        self.event('COMMODITY_CHECK_STARTED', step='COMMODITY', message='Checking Commodity before Buyer Receipt creation.')
        extra = {}
        def describe(column, missing, error=None):
            stage = 'NPL_READ_FAILED' if error else 'COMMODITY_MISSING'
            extra.update(step=stage, recoveryPoint=stage, materials=missing,
                allowedActions=['continue', 'stop'] if error else ['continue', 'stop', 'open-fix-session'],
                issueSummary='NPL data could not be read or verified. Commodity has not been confirmed missing.' if error else 'Commodity must be maintained in SAP before Buyer Receipt creation.',
                issueSummaryZh='NPL 数据读取或校验失败，尚未确认 Commodity 缺失，请勿因此修改主数据。' if error else '请先在 SAP 维护以下物料的 Commodity，再创建 Buyer Receipt。',
                instructions='Keep the original NPL screen open, resolve any SAP dialog, then Recheck NPL Data. If it fails again, send the field/row details to the key user.' if error else 'Use another SAP session to correct master data. Keep the original NPL screen unchanged, then click I have Fixed It – Recheck.',
                instructionsZh='请保留原 NPL 页面，处理 SAP 弹窗后重新读取并检查；若仍失败，请把详情中的字段、行号和错误交给 key user。' if error else '请在另一个 SAP 会话维护主数据，保持原 NPL 页面不变；完成后点击“已修复，重新检查”。')
            diagnostic = str(error) if error else 'Commodity column=' + column
            self.event('COMMODITY_CHECK_RESULT', commodityColumn=column, projectColumn=NPL_PROJECT_COLUMN,
                       affectedMaterials=missing, recoveryPoint=stage if missing else '', message=diagnostic)
            if missing:
                self.event(stage, affectedMaterials=missing, commodityColumn=column,
                           message=diagnostic if error else 'Commodity is empty; Buyer Receipt has not been created.')
            return stage, diagnostic
        try:
            column, missing = inspect_commodity(self.engine, sap, grid, tasks)
        except Exception as exc:
            column, missing = '', [task.material for task in tasks]
            stage, diagnostic = describe(column, missing, exc)
        else:
            stage, diagnostic = describe(column, missing)
        if not missing:
            return grid
        if self.controller is None:
            raise self.engine.SapRpaError(stage, diagnostic)
        identity = session_identity(sap)
        def verify():
            self.event('COMMODITY_RECHECK_STARTED', message='Re-querying exact NPL materials and checking Commodity again.')
            try:
                check_session(sap, identity)
                current = sap.find(self.engine.ID_GRID_CUSTOMER1, required=False)
                title = self.engine.safe_text(sap.find('wnd[0]').Text).casefold()
                if current is None or 'new part list' not in title or 'buyer receipt' in title:
                    raise ValueError('Return to the original NPL result. The automation session must not be navigated away.')
                query_group = self.engine.TaskGroup(key=group.key, tasks=list(tasks))
                fresh = sap.prepare_npl_grid_for_group(query_group)
                matched, failed = self.engine.match_exact_npl_rows(sap, fresh, query_group)
                if failed or len(matched) != len(tasks):
                    raise ValueError('NPL exact material mapping changed; no Buyer Receipt was created.')
                fresh_column, remaining = inspect_commodity(self.engine, sap, fresh, matched)
            except Exception as exc:
                describe('', [task.material for task in tasks], exc)
                self.event('COMMODITY_RECHECK_FAILED', message=str(exc))
                raise
            if remaining:
                describe(fresh_column, remaining)
                issue = 'Commodity is empty: ' + ', '.join(remaining)
                self.event('COMMODITY_RECHECK_FAILED', message=issue)
                raise ValueError(issue)
            self.event('COMMODITY_RECHECK_SUCCESS', commodityColumn=fresh_column, message='Fresh NPL data confirms Commodity. Resuming Buyer Receipt creation.')
            return fresh
        return self.controller.wait(stage, diagnostic + '. Materials: ' + ', '.join(missing),
            tasks, verify, open_fix=lambda: self.open_fix(sap, identity), extra=extra)

    def open_fix(self, sap, identity):
        check_session(sap, identity)
        connection = sap.session.Parent
        before = {str(connection.Children(i).Id) for i in range(int(connection.Children.Count))}
        # Same connection/session identity. Never OpenConnection or choose a
        # multiple-logon option; no Commodity transaction is guessed or executed.
        sap.session.CreateSession()
        deadline = self.clock() + 12
        while self.clock() < deadline:
            self.stopped()
            for index in range(int(connection.Children.Count)):
                candidate = connection.Children(index)
                if str(candidate.Id) in before or candidate.Busy:
                    continue
                info = candidate.Info
                if (str(info.SystemName), str(info.Client), str(info.User)) != identity[1:]:
                    continue
                return 'Manual correction session ready: ' + str(candidate.Id) + '. Maintain Commodity manually; the original RFQ session remains paused.'
            self.sleep(.25)
        raise ValueError('An additional SAP session is unavailable. Use another existing SAP session to maintain Commodity, then Recheck.')
