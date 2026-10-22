"""Hub APQP date query/preview protocol. Deliberately contains NO SAP date writes.

The execute boundary rejects even direct engine calls until controlled QA
acceptance proves detail identity, direct assignment and Save/re-read semantics.
"""
import json
import os
from pathlib import Path
import re
import threading
import time
from types import SimpleNamespace
from uuid import uuid4

from apqp_date_discovery import ApqpDiscovery
from apqp_date_sessions import select_reader, target_environment
from apqp_dates import ApqpDateIssue, compare_dates, fingerprint
import apqp_date_update as date_update
from hub_user_interaction import HubStopped, HubUserInteraction

WRITE_GATE = 'APQP_DATE_WRITE_NOT_VALIDATED'
IDENTITY_COLUMNS = ('APQPNO', 'MATNR', 'LIFNR', 'WERKS', 'PSPID_1', 'SD')  # Live-observed 2026-10-20.


def save_summary(target, state, sleep=time.sleep):
    """Bounded FILE-only retry for Windows scanner/share locks. Never replay SAP."""
    temporary = target.with_name(target.name + '.' + str(uuid4()) + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(state, stream, ensure_ascii=False, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    for delay in (0, 0.01, 0.025, 0.05, 0.1, 0.2, 0.4):
        if delay:
            sleep(delay)
        try:
            temporary.replace(target)
            return
        except PermissionError:
            if delay == 0.4:
                raise  # Keep the owned temporary evidence; do not delete or recreate SAP work.


def fail(code, en, zh, details=''):
    raise ApqpDateIssue(code, en, zh, details)


def record_identity(row):
    v = row['values']
    return dict(apqp=v['APQPNO'].strip(), material=v['MATNR'].strip(), vendor=v['LIFNR'].strip(),
                plant=v['WERKS'].strip(), project=v['PSPID_1'].strip(), owner=v['SD'].strip())


def identities(grid, project, owner):
    if not grid['complete']:
        fail('SAP_GRID_INCOMPLETE', 'Not all SAP rows could be loaded. No editable snapshot was created.', 'SAP 结果未完整加载，未生成可编辑快照。')
    if not set(IDENTITY_COLUMNS).issubset({column['id'] for column in grid['columns']}):
        fail('SAP_GRID_COLUMNS_CHANGED', 'The APQP identity columns differ from the inspected layout.', 'APQP 标识列与已检查布局不同，请联系 Key User。')
    result, mismatches = {}, []
    mismatch_count = 0
    differing = {}
    for row in grid['rows']:
        item = record_identity(row)
        if not item['apqp'] or item['apqp'] in result:
            fail('MULTIPLE_APQP_MATCHES', 'An APQP number is blank or repeated. Records cannot be identified safely.', 'APQP 编号为空或重复，无法安全识别记录。')
        checks = []
        for field, label, label_zh, column, expected, actual in (
                ('plant', 'Plant', '工厂（Plant）', 'WERKS', 'C100 / 0000', item['plant']),
                ('project', 'NPL / Project', 'NPL / 项目编号', 'PSPID_1', project, item['project']),
                ('userId', 'User ID (SD)', 'User ID（SD）', 'SD', owner, item['owner'])):
            matches = actual in {'C100', '0000'} if field == 'plant' else actual.upper() == expected.upper() if field == 'userId' else actual == expected
            checks.append(dict(field=field, label=label, labelZh=label_zh, column=column,
                               expected=expected, actual=actual, matches=matches))
            if not matches:
                summary = differing.setdefault(field, dict(label=label, labelZh=label_zh, expected=expected, actual=[]))
                if actual not in summary['actual'] and len(summary['actual']) < 3:
                    summary['actual'].append(actual)
        if not all(check['matches'] for check in checks):
            mismatch_count += 1
            if len(mismatches) < 20:
                mismatches.append(dict(rowNumber=row['index'] + 1, apqp=item['apqp'], material=item['material'], checks=checks))
        result[item['apqp']] = (row['index'], item)
    if mismatch_count:
        en, zh = [], []
        for summary in differing.values():
            en.append(f"{summary['label']}: expected {summary['expected']}, SAP returned " + ' / '.join(value or '(blank)' for value in summary['actual']))
            zh.append(f"{summary['labelZh']}：预期 {summary['expected']}，SAP 实际 " + ' / '.join(value or '（空白）' for value in summary['actual']))
        comparison = dict(totalRows=len(grid['rows']), mismatchRows=mismatch_count, sampleLimit=20, rows=mismatches)
        details = json.dumps(comparison, ensure_ascii=False)
        issue = ApqpDateIssue('SAP_QUERY_FILTER_MISMATCH',
            '; '.join(en) + f'. {mismatch_count} SAP result row(s) do not match. No SAP dates were changed.',
            '；'.join(zh) + f'。共 {mismatch_count} 条 SAP 结果不一致，未修改 SAP 日期。', details)
        issue.comparison = comparison
        raise issue
    return result


def read_records(reader, grid, wanted, emit, persist):
    records = []
    reader.bulk_detail_enabled = True
    emit('workers', workers=1, current=0, total=len(wanted), message='Reading the four dates from SAP details.')
    started = time.monotonic()
    for number, (index, identity) in enumerate(wanted, 1):
        item_started = time.monotonic()
        emit('notice', message=f"Reading APQP {identity['apqp']} ({number}/{len(wanted)}).", current=number - 1, total=len(wanted),
             material=identity['material'], vendor=identity['vendor'], apqp=identity['apqp'], step='READING_DATES')
        detail = reader.open_observed_row(index)
        detail_read_ms = round((time.monotonic() - item_started) * 1000)
        if not detail['allFourReadable']:
            fail('APQP_DATE_UNREADABLE', 'One of the four SAP dates could not be read. Missing values are not treated as blanks.',
                 'SAP 四个日期中存在不可读取的值，不会将其当作空白日期。', identity['apqp'])
        dates = {key: value['date'] for key, value in detail['fields'].items()}
        records.append({key: identity[key] for key in ('apqp', 'material', 'vendor', 'plant', 'project')}
                       | dict(dates=dates, readable=True))
        persist(records)  # Preserve each completed read before attempting any return/navigation.
        reader.return_read_detail()
        emit('record', message=f"Read APQP {identity['apqp']}.", current=number, total=len(wanted), status='READ', elapsedMs=round((time.monotonic() - started) * 1000),
             material=identity['material'], vendor=identity['vendor'], apqp=identity['apqp'], step='READ_COMPLETE',
             detailReadMs=detail_read_ms, recordElapsedMs=round((time.monotonic() - item_started) * 1000))
    return records


def run(request, legacy, app, stop, emit, persist, checkpoint=None):
    action = request.get('action')
    if action not in {'query', 'preview', 'execute'}:
        raise ValueError('Unsupported APQP date action.')
    query = request.get('query', {})
    if (query.get('environment') not in {'QA', 'PROD'} or any(not isinstance(query.get(key), str)
            or not re.fullmatch(r'[A-Za-z0-9_/-]{1,32}', query[key]) for key in ('project', 'userId'))):
        raise ValueError('Invalid NPL/User/environment.')
    if action == 'execute' and not date_update.writes_enabled(query['environment']):
        fail('APQP_DATE_PRODUCTION_LOCKED' if query['environment'] == 'PROD' else WRITE_GATE,
             'Date writes are not enabled for this environment.', '此环境的日期写入尚未开放。')
    with target_environment(legacy, query['environment']):
        if action == 'execute':
            if checkpoint is None:
                fail('APQP_DATE_CHECKPOINT_REQUIRED', 'A durable write checkpoint is required.', '写入必须保留持久化安全检查点。')
            return run_updates(request, legacy, app, stop, emit, persist, checkpoint)
        if action == 'query':
            started = time.monotonic()
            reader = select_reader(legacy, app, SimpleNamespace(mode='discover', session_id='', allow_navigation=True), stop)
            grid = reader.discover(query['project'], query['userId'], scroll=True, required_columns=IDENTITY_COLUMNS,
                                   allow_navigation=True, batch_rows=True)
            reader.metrics['selectionAndListMs'] = round((time.monotonic() - started) * 1000)
            queue = identities(grid, query['project'], query['userId'])
            records = read_records(reader, grid, list(queue.values()), emit, persist)
            reader.metrics['totalMs'] = round((time.monotonic() - started) * 1000)
            return dict(records=records, session=reader.latest['session'], stageOnly=date_update.STAGE_ONLY, queryEvidence=reader.latest.get('query'),
                        performance=reader.metrics,
                        findings=dict(uniqueAcrossReturnedResult=True, businessIdentityOnDetailConfirmed=False,
                                      allMatchingRecordsConfirmed=False, writesEnabled=False))
        originals, edits = request['originals'], request['edits']
        if len({row['apqp'] for row in originals}) != len(originals) or len({row['apqp'] for row in edits}) != len(edits):
            raise ValueError('Duplicate APQP identities.')
        desired = {row['apqp']: row['dates'] for row in edits}
        if set(desired) != {row['apqp'] for row in originals}:
            raise ValueError('The edited record set differs from the original snapshot.')
        # Unedited rows never need a SAP write; avoid reopening them for preview.
        proposed = [row for row in originals if compare_dates(row['dates'], row['dates'], desired[row['apqp']])['status'] == 'CHANGES_PROPOSED']
        current, observations = {}, []
        session = request['session']
        if proposed:
            reader = select_reader(legacy, app, SimpleNamespace(mode='inspect-grid', session_id=session['sessionId']), stop)
            if reader.latest['session'] != session:
                fail('SAP_SESSION_LOST', 'Use the same SAP environment/account/window as the query.', '请使用查询时相同的 SAP 系统、账号和窗口。')
            grid = reader.inspect_grid(10000, scroll=True, required_columns=IDENTITY_COLUMNS)
            queue = identities(grid, query['project'], query['userId'])
            wanted = []
            for row in proposed:
                if row['apqp'] not in queue:
                    fail('APQP_NOT_FOUND', 'An edited APQP is no longer in the original result.', '原结果中已找不到待修改 APQP。', row['apqp'])
                index, identity = queue[row['apqp']]
                if any(identity[key] != row[key] for key in ('material', 'vendor', 'plant', 'project')):
                    fail('APQP_IDENTITY_CHANGED', 'An APQP identity changed since the query. Query again.', 'APQP 标识与查询快照不同，请重新查询。', row['apqp'])
                wanted.append((index, identity))
            observations = read_records(reader, grid, wanted, emit, persist)
            current = {row['apqp']: row['dates'] for row in observations}
        preview = dict(total=len(originals), changedRecords=0, changedFields=0, unchanged=0, conflicts=0, invalid=0, changes=[], issues=[])
        for row in originals:
            if stop.is_set():
                fail('CANCELLED', 'Preview stopped. No SAP dates were changed.', '预览已停止，未修改 SAP 日期。')
            plan = compare_dates(row['dates'], current.get(row['apqp'], row['dates']), desired[row['apqp']])
            if plan['status'] == 'CHANGES_PROPOSED':
                preview['changedRecords'] += 1
                preview['changedFields'] += len(plan['changes'])
                preview['changes'].extend(dict(apqp=row['apqp'], field=change['field'], current=change['current'], desired=change['desired']) for change in plan['changes'])
            elif plan['status'] in {'CONFLICT', 'VALIDATION_ERROR'}:
                preview['conflicts' if plan['status'] == 'CONFLICT' else 'invalid'] += 1
                preview['issues'].append(dict(apqp=row['apqp'], status=plan['status']))
            else:
                preview['unchanged'] += 1
        return dict(records=observations, session=session, preview=preview)


def locate_update_targets(reader, originals, project, owner):
    """Scan only APQP numbers, then verify all six identity cells of targets.

    Never trust a cached row position: row fingerprints and detail identity are
    still verified immediately before input. Scan all IDs to detect duplicates.
    """
    started, before = time.monotonic(), reader.metrics['gridCellReads']
    scan = reader.inspect_grid(10000, scroll=True, required_columns=('APQPNO',), batch_rows=True)
    if not scan['complete']:
        fail('SAP_GRID_INCOMPLETE', 'The APQP number list is incomplete.', 'APQP 编号列表不完整，未打开详情。')
    indices = {}
    for row in scan['rows']:
        number = row['values']['APQPNO'].strip()
        if not number or number in indices:
            fail('MULTIPLE_APQP_MATCHES', 'An APQP number is blank or repeated.', 'APQP 编号为空或重复，无法安全定位。')
        indices[number] = row['index']
    grid = reader.session.FindById(legacy_id := reader.legacy.ID_RESULT_GRID)
    from apqp_date_discovery import collection_values
    if not set(IDENTITY_COLUMNS).issubset(collection_values(grid.ColumnOrder)):
        fail('SAP_GRID_COLUMNS_CHANGED', 'APQP identity columns changed.', 'APQP 标识列已变化。')
    evidence = dict(scan, columns=[dict(id=name) for name in IDENTITY_COLUMNS], rows=[], complete=False, targeted=True)
    queue = {}
    for original in originals:
        if original['apqp'] not in indices:
            fail('APQP_NOT_FOUND', 'The APQP is no longer in the result.', '结果中已找不到待修改 APQP。', original['apqp'])
        index = indices[original['apqp']]
        reader.guard()
        grid = reader.session.FindById(legacy_id)
        start, visible = reader.grid_viewport(grid)
        if grid.RowCount != scan['rowCount']:
            fail('SAP_GRID_CHANGED', 'The APQP list changed during location.', '定位期间 APQP 列表已变化。')
        if not start <= index < start + visible:
            grid.FirstVisibleRow = min(index, max(0, grid.RowCount - visible))
            grid = reader.wait(lambda: reader.optional(legacy_id), 'target APQP row loading')
            start, visible = reader.grid_viewport(grid)
            if not start <= index < start + visible:
                fail('SAP_GRID_ROW_NOT_VISIBLE', 'The target APQP row did not load.', '目标 APQP 行未加载。')
        values = reader._row_values(grid, index, evidence['columns'])
        reader.guard()
        if grid.RowCount != scan['rowCount'] or values['APQPNO'].strip() != original['apqp']:
            fail('SAP_GRID_CHANGED', 'The target APQP row changed.', '目标 APQP 行已变化。')
        observed = dict(index=index, values=values, fingerprint=fingerprint(values))
        identity = identities(dict(complete=True, columns=evidence['columns'], rows=[observed]), project, owner)[original['apqp']][1]
        if any(identity[key] != original[key] for key in ('material', 'vendor', 'plant', 'project')):
            fail('APQP_IDENTITY_CHANGED', 'APQP identity changed. Query again.', 'APQP 标识已变化，请重新查询。', original['apqp'])
        evidence['rows'].append(observed)
        queue[original['apqp']] = (index, identity)
    reader.metrics.update(locateMs=round((time.monotonic()-started)*1000),
                          locateGridCellReads=reader.metrics['gridCellReads']-before,
                          locateRowCount=scan['rowCount'], locateTargets=len(originals))
    return evidence, queue


def run_updates(request, legacy, app, stop, emit, persist, checkpoint):
    """Single-click, single-worker update with per-record compare immediately before input."""
    originals, edits, query, session = request['originals'], request['edits'], request['query'], request['session']
    desired = {row['apqp']: row['dates'] for row in edits}
    comments = {row['apqp']: date_update.sd_comments(row.get('sdComments')) for row in edits}
    if (len(desired) != len(edits) or len({row['apqp'] for row in originals}) != len(originals)
            or set(desired) != {row['apqp'] for row in originals}):
        raise ValueError('The edited APQP set differs from the trusted snapshot.')
    wanted = []
    for row in originals:
        if any(row['dates'][date_update.SD_CONTROLS[group]['actual']] == desired[row['apqp']][date_update.SD_CONTROLS[group]['actual']]
               for group in comments[row['apqp']]):
            fail('APQP_DATE_VALIDATION_FAILED', 'SD Comment requires an edited matching actual date.',
                 'SD Comment 只能随对应实际日期的修改一起填写。', row['apqp'])
        plan = compare_dates(row['dates'], row['dates'], desired[row['apqp']])
        if plan['status'] == 'VALIDATION_ERROR':
            fail('APQP_DATE_VALIDATION_FAILED', 'Populated dates cannot be cleared. Nothing was saved.', '已有日期不能清空，本次未保存。', row['apqp'])
        if plan['changes']: wanted.append(row)
    reader = select_reader(legacy, app, SimpleNamespace(mode='inspect-grid', session_id=session['sessionId']), stop)
    if reader.latest['session'] != session:
        fail('SAP_SESSION_LOST', 'Use the original SAP environment/window/account.', '请使用查询时的原 SAP 环境、窗口及账号。')
    stage_only = date_update.STAGE_ONLY
    active = wanted[:1] if stage_only else wanted
    emit('notice', step='LOCATING_APQP', current=0, total=len(wanted), message='Locating only the edited APQP record.',
         **({key: active[0][key] for key in ('apqp', 'material', 'vendor')} if active else {}))
    def load_grid(current):
        return locate_update_targets(current, active, query['project'], query['userId'])
    grid, queue = load_grid(reader)
    def open_identity(current, original, current_grid, current_queue):
        if original['apqp'] not in current_queue:
            fail('APQP_NOT_FOUND', 'The APQP is no longer in the original result.', '原结果中已找不到 APQP。', original['apqp'])
        index, identity = current_queue[original['apqp']]
        if any(identity[key] != original[key] for key in ('material', 'vendor', 'plant', 'project')):
            fail('APQP_IDENTITY_CHANGED', 'APQP identity changed. Query again.', 'APQP 标识已变化，请重新查询。', original['apqp'])
        fresh = ApqpDiscovery(legacy, current.ref, app, current.stop)
        fresh.latest['grid'] = current_grid
        fresh.open_observed_row(index, load_dates=False)
        return fresh
    def reopen(verifier, original):
        if verifier.optional(legacy.ID_RESULT_GRID) is None: date_update.return_to_list(verifier)
        fresh_grid, fresh_queue = load_grid(verifier)
        return open_identity(verifier, original, fresh_grid, fresh_queue)
    completed, succeeded, skipped, staged = [], 0, 0, 0
    emit('workers', workers=1, current=0, total=len(wanted), message=f"Checking and updating changed {query['environment']} APQPs.")
    for row in active:
        reader.check_stop()
        emit('notice', step='CHECKING_DATES', apqp=row['apqp'], material=row['material'], vendor=row['vendor'], current=len(completed), total=len(wanted), message='Checking current SAP dates before input.')
        opened = open_identity(reader, row, grid, queue)
        def record_checkpoint(stage, **data):
            checkpoint(stage, apqp=row['apqp'], material=row['material'], vendor=row['vendor'], **data)
            emit('notice', step=stage, apqp=row['apqp'], material=row['material'], vendor=row['vendor'], current=len(completed), total=len(wanted), message=stage)
        outcome = date_update.update_open_record(opened, row, row['dates'], desired[row['apqp']], record_checkpoint, reopen,
                                                 environment=query['environment'], comments=comments[row['apqp']], stage_only=stage_only)
        completed.append(dict(row, dates=outcome['dates'], readable=True, saved=outcome['status'] == 'VERIFIED', inputStatus=outcome['status']))
        succeeded += outcome['status'] == 'VERIFIED'
        skipped += outcome['status'] == 'UNCHANGED'
        staged += outcome['status'] == 'STAGED'
        persist(completed)
        emit('record', current=len(completed), total=len(wanted), status=outcome['status'], apqp=row['apqp'], material=row['material'], vendor=row['vendor'], message=outcome['status'])
        if stage_only or stop.is_set(): break  # Do NOT leave/back from unsaved test inputs.
        date_update.return_to_list(outcome['reader'])
        reader = ApqpDiscovery(legacy, reader.ref, app, stop.is_set)
        grid, queue = load_grid(reader)
    return dict(records=completed, session=session, performance=reader.metrics,
                update=dict(total=len(wanted), processed=len(completed), succeeded=succeeded, skipped=skipped,
                            staged=staged, stageOnly=stage_only, cancelled=stop.is_set()))


def main():
    def emit(event, **data):
        print('APQP_EVENT ' + json.dumps(dict(event=event, **data), ensure_ascii=False), flush=True)

    stop = threading.Event()
    hub = HubUserInteraction('APQP', emit, stop)
    hub.start_listener()
    directory = Path(os.environ['HUB_ARTIFACT_DIR']).resolve()
    target = directory / 'apqp-dates-result.json'
    state = dict(readOnly=True, writesEnabled=False, records=[], writePolicy=date_update.write_policy())
    written = 0
    journal = (directory / 'apqp-dates-readings.jsonl').open('a', encoding='utf-8')
    write_journal = None

    def persist(records):
        nonlocal written
        state['records'] = records
        # Append each completed read once: O(N), not N rewrites of an expanding
        # snapshot. Final/failed summary is written once after SAP work ends.
        for record in records[written:]:
            journal.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n')
        written = len(records)
        journal.flush()

    def checkpoint(event, **data):
        nonlocal write_journal
        item = dict(event=event, **data)
        state.setdefault('writeEvents', []).append(item)
        state['writeCheckpoint'] = event
        if event in {'SD_CONFIRM_INPUT_DISPATCHED', 'SD_COMMENT_INPUT_DISPATCHED', 'DATE_INPUT_DISPATCHED', 'SAVE_DISPATCHED'}: state['writeMayHaveOccurred'] = True
        # Durable before each SAP write, without repeatedly rewriting a growing
        # batch snapshot. A hard stop still leaves the exact last dispatched action.
        if write_journal is None:
            write_journal = (directory / 'apqp-dates-write-events.jsonl').open('x', encoding='utf-8')
        write_journal.write(json.dumps(item, ensure_ascii=False, allow_nan=False) + '\n')
        write_journal.flush()
        os.fsync(write_journal.fileno())

    try:
        request_path = Path(os.environ['APQP_DATE_REQUEST_PATH']).resolve()
        if request_path.parent != directory or request_path.stat().st_size > 16_000_000:
            raise ValueError('Invalid owned APQP request file.')
        request = json.loads(request_path.read_text(encoding='utf-8'))
        if request.get('action') not in {'query', 'preview', 'execute'}:
            fail(WRITE_GATE, 'Date writes are not enabled. No SAP action was sent.', '日期写入尚未开放，未向 SAP 发送操作。')
        import pythoncom
        import apqp_plan_closure as legacy
        pythoncom.CoInitialize()
        try:
            updating = request.get('action') == 'execute'
            emit('preparing', message='Checking edited dates before updating SAP.' if updating else 'Reading SAP APQP dates. No SAP dates will be changed.')
            if updating:
                state['readOnly'] = False
                state['writesEnabled'] = date_update.writes_enabled(request.get('query', {}).get('environment'))
                state['environment'] = request.get('query', {}).get('environment')
            data = run(request, legacy, legacy.checked_sap_application(), stop, emit, persist, checkpoint)
            state.update(data)
            persist(state['records'])
            result = dict(success=True, data=data, resultPath=str(target))
        finally:
            pythoncom.CoUninitialize()
    except (Exception, HubStopped) as error:
        diagnostic = getattr(error, 'details', '') or str(error)
        state['error'] = str(error)
        state['errorCode'] = getattr(error, 'code', 'APQP_DATE_READ_FAILED')
        state['errorDetails'] = diagnostic
        state['comparison'] = getattr(error, 'comparison', None)
        persist(state['records'])
        result = dict(success=False, errorCode=getattr(error, 'code', 'APQP_DATE_READ_FAILED'),
                      message=getattr(error, 'issue_summary', 'APQP dates could not be safely read. Review details and prepare the SAP query window.'),
                      messageZh=getattr(error, 'issue_summary_zh', '未能安全读取 APQP 日期，请查看详情并准备 SAP 查询窗口。'),
                      details=diagnostic, comparison=getattr(error, 'comparison', None),
                      logPath=str(target), cancelled=stop.is_set(), writeMayHaveOccurred=state.get('writeMayHaveOccurred', False),
                      succeeded=sum(event['event'] == 'UPDATE_VERIFIED' for event in state.get('writeEvents', [])))
    finally:
        journal.flush()
        os.fsync(journal.fileno())
        journal.close()
        if write_journal is not None: write_journal.close()
        save_summary(target, state)
    emit('complete', message='APQP date operation completed.' if result['success'] else result['message'], dateResult=result)


if __name__ == '__main__':
    main()
