"""Hub APQP planned-date protocol: query, changed-only Save and reopen verification."""
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
from apqp_dates import ApqpDateIssue, FIELD_SCHEMA, compare_dates, fingerprint
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
                       | dict(dates=dates, readable=True, editable={key: value.get('changeableObserved') is True for key, value in detail['fields'].items()}))
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
    if query['environment'] != 'PROD':
        fail('APQP_DATE_PRODUCTION_ONLY', 'APQP date management uses SAP 949.', 'APQP 日期管理固定使用 SAP 949。')
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
            return dict(records=records, fieldSchema=FIELD_SCHEMA, session=reader.latest['session'], stageOnly=date_update.STAGE_ONLY, queryEvidence=reader.latest.get('query'),
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


def locate_update_targets(reader, originals, project, owner, *, fresh_scan=None):
    """Scan only APQP numbers, then verify all six identity cells of targets.

    Never trust a cached row position: row fingerprints and detail identity are
    still verified immediately before input. Scan all IDs to detect duplicates.
    """
    started, before = time.monotonic(), reader.metrics['gridCellReads']
    # Only reuse the immediately preceding owned query, never an old/cached row
    # index. After Save the caller always requests a fresh APQP-number scan.
    scan = fresh_scan if fresh_scan is not None else reader.inspect_grid(10000, scroll=True, required_columns=('APQPNO',), batch_rows=True)
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


def run_candidates(request, legacy, app, stop, emit, persist, checkpoint, wanted, desired, comments):
    """Skip proven pre-input failures; save/reopen each successful planned update.

    A warning/error after any input dispatch, an unknown popup, session/identity
    change or uncertain navigation is never caught as an ordinary record issue.
    """
    query, session = request['query'], request['session']
    records, issues, staged, skipped, succeeded, saved_fields, reader = [], [], 0, 0, 0, 0, None
    stage_only = date_update.STAGE_ONLY
    total = len(wanted)
    emit('workers', workers=1, current=0, total=total, message='Updating changed APQP planned dates.')

    def record_issue(row, code, en, zh, navigation):
        item = {key: row[key] for key in ('apqp', 'material', 'vendor')}
        item.update(code=code, message=en, messageZh=zh, navigation=navigation)
        checkpoint('RECORD_SKIPPED_BEFORE_INPUT', inputDispatched=False, saveDispatched=False, **item)
        issues.append(item)
        emit('record', current=len(records)+len(issues), total=total, status='FAILED', step='RECORD_SKIPPED_BEFORE_INPUT',
             **{key: row[key] for key in ('apqp', 'material', 'vendor')}, message=en, issue=item)

    for row in wanted:
        fresh_scan = None
        if stop.is_set(): fail('CANCELLED', 'APQP update stopped. Review previously recorded results.', '已停止 APQP 修改，请核查已记录的结果。')
        proposal = compare_dates(row['dates'], row['dates'], desired[row['apqp']])
        invalid_comment = bool(comments[row['apqp']])
        if proposal['status'] == 'VALIDATION_ERROR' or invalid_comment:
            record_issue(row, 'APQP_DATE_VALIDATION_FAILED',
                         'Planned-date maintenance does not edit SD Comment.' if invalid_comment else 'Populated dates cannot be cleared. Nothing was entered.',
                         '计划日期维护不修改 SD Comment。' if invalid_comment else '已有日期不能清空，本条未输入。', 'NOT_OPENED')
            continue
        if reader is None:
            reader = select_reader(legacy, app, SimpleNamespace(mode='discover', session_id=session['sessionId'], allow_navigation=True), stop)
            if reader.latest['session'] != session:
                fail('SAP_SESSION_LOST', 'Use the original SAP environment/window/account.', '请使用原 SAP 环境、窗口及账号。')
            # One fresh selection per batch also handles an APQP list left on
            # unrelated filters. Never infer the target is absent from a stale
            # list, and never repeat the full per-detail date read here.
            emit('notice', step='NAVIGATING_APQP', message='Opening ZMFM050035 in the original SAP window.')
            fresh_scan = reader.discover(query['project'], query['userId'], scroll=True, required_columns=IDENTITY_COLUMNS,
                                         allow_navigation=True, batch_rows=True)
            reader.bulk_detail_enabled = True
        emit('notice', step='LOCATING_APQP', current=len(records)+len(issues), total=total,
             **{key: row[key] for key in ('apqp', 'material', 'vendor')}, message='Locating the next edited APQP.')
        grid, _ = locate_update_targets(reader, [row], query['project'], query['userId'], fresh_scan=fresh_scan)
        reader.latest['grid'] = grid
        index = next(item['index'] for item in grid['rows'] if item['values']['APQPNO'].strip() == row['apqp'])
        reader.open_observed_row(index, load_dates=False)
        input_dispatched = False

        def record_checkpoint(stage, **data):
            nonlocal input_dispatched
            if stage in {'SD_CONFIRM_INPUT_DISPATCHED', 'DATE_INPUT_DISPATCHED', 'SD_COMMENT_INPUT_DISPATCHED', 'SAVE_DISPATCHED'}:
                input_dispatched = True  # Even an ambiguous setter must stop, not skip.
            checkpoint(stage, **{key: row[key] for key in ('apqp', 'material', 'vendor')}, **data)
            emit('notice', step=stage, current=len(records)+len(issues), total=total,
                 **{key: row[key] for key in ('apqp', 'material', 'vendor')}, message=stage)
        try:
            def reopen(verifier, identity):
                if verifier.optional(legacy.ID_RESULT_GRID) is None:
                    date_update.return_to_list(verifier)
                fresh = ApqpDiscovery(legacy, verifier.ref, app, verifier.stop)
                fresh.bulk_detail_enabled = True
                evidence, matches = locate_update_targets(fresh, [identity], query['project'], query['userId'])
                fresh.latest['grid'] = evidence
                fresh.open_observed_row(matches[identity['apqp']][0], load_dates=False)
                return fresh
            outcome = date_update.update_open_record(reader, row, row['dates'], desired[row['apqp']], record_checkpoint,
                reopen, environment=query['environment'], comments=comments[row['apqp']], stage_only=stage_only)
        except ApqpDateIssue as error:
            if input_dispatched or error.code not in date_update.SAFE_PREINPUT_ISSUES:
                raise
            record_checkpoint('SKIP_RETURN_DISPATCHED', code=error.code, reason=error.issue_summary)
            date_update.return_unchanged_input_detail(reader, row)
            detail = getattr(error, 'details', '')
            record_issue(row, error.code, error.issue_summary + ((' ' + detail) if detail else ''),
                         error.issue_summary_zh + ((' ' + detail) if detail else ''), 'RETURNED_UNCHANGED')
            continue
        reader = outcome['reader']
        reader.stop = stop.is_set
        fields_saved = outcome['changedFields'] if outcome['status'] == 'VERIFIED' else 0
        records.append(dict(row, dates=outcome['dates'], readable=True, saved=outcome['status'] == 'VERIFIED', inputStatus=outcome['status'], changedFieldsSaved=fields_saved))
        persist(records)
        staged += outcome['status'] == 'STAGED'
        skipped += outcome['status'] == 'UNCHANGED'
        succeeded += outcome['status'] == 'VERIFIED'
        saved_fields += fields_saved
        emit('record', current=len(records)+len(issues), total=total, status=outcome['status'],
             **{key: row[key] for key in ('apqp', 'material', 'vendor')}, message=outcome['status'])
        if staged or stop.is_set(): break  # Never Back/next after uncommitted input.
        if outcome['status'] == 'VERIFIED':
            reader.return_read_detail()  # Reopened values were verified as saved, not edit-buffer values.
        else:
            date_update.return_unchanged_input_detail(reader, row)
    return dict(records=records, fieldSchema=FIELD_SCHEMA, session=session, performance=reader.metrics if reader else {},
                update=dict(total=total, processed=len(records)+len(issues), succeeded=succeeded, skipped=skipped,
                            staged=staged, failed=len(issues), issues=issues, savedFields=saved_fields, stageOnly=stage_only, cancelled=stop.is_set()))


def run_updates(request, legacy, app, stop, emit, persist, checkpoint):
    """Single-click planned-date batch, with a fresh comparison before each input."""
    originals, edits = request['originals'], request['edits']
    desired = {row['apqp']: row['dates'] for row in edits}
    comments = {row['apqp']: date_update.sd_comments(row.get('sdComments')) for row in edits}
    if (len(desired) != len(edits) or len({row['apqp'] for row in originals}) != len(originals)
            or set(desired) != {row['apqp'] for row in originals}):
        raise ValueError('The edited APQP set differs from the trusted snapshot.')
    wanted = []
    for row in originals:
        if set(row['dates']) != {field.key for field in date_update.DATE_FIELDS} or set(desired[row['apqp']]) != set(row['dates']):
            fail('APQP_DATE_SCHEMA_CHANGED', 'The date layout changed. Read the four planned dates again.', '日期字段已更新，请重新读取四个计划日期。')
        if any(row['dates'][key] != desired[row['apqp']][key] for key in row['dates']) or comments[row['apqp']]:
            wanted.append(row)
    return run_candidates(request, legacy, app, stop, emit, persist, checkpoint, wanted, desired, comments)


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
