"""Changed-only APQP date writer, with explicit owner-authorized production access.

No retries of assignments, Save or SAP confirmations. Every Save is followed by
leaving/reopening the same verified business record, not a read of its edit buffer.
"""
from apqp_date_discovery import ApqpDiscovery
from apqp_dates import ApqpDateIssue, DATE_FIELDS, compare_dates, date_value
import re

QA_WRITES_VALIDATED = False  # Set only after the owner-authorized live QA acceptance.
PRODUCTION_WRITES_VALIDATED = False
PRODUCTION_WRITES_AUTHORIZED = True  # Explicit owner request, 2026-10-20; not QA/production acceptance evidence.
STAGE_ONLY = True  # Owner request, 2026-10-22: fill ONE record, never press Save.
PREFIX = 'wnd[0]/usr/tabsTAB_ST/tabpTAB1/ssubSUB1:ZMFM050035_N:0901/'
DETAIL_IDENTITY = {'apqp': PREFIX + 'txtGS_ITAB-APQPNO',
                   'material': PREFIX + 'txtGS_ITAB-MATNR', 'vendor': PREFIX + 'txtGS_ITAB-LIFNR'}
SAVE_ID = 'wnd[0]/tbar[0]/btn[11]'
# G selectors are from the owner's 2026-10-22 recording. H is the matching
# Total PPAP technical group; both exact controls must be readable at runtime.
SD_CONTROLS = {group: dict(actual=group + 'ActualDate',
    checkbox=PREFIX + f'chkGS_ITAB-{group.upper()}_SDCONF',
    comment=PREFIX + f'txtGS_ITAB-{group.upper()}_SDCOMMENT') for group in ('g', 'h')}
SAVE_YES = 'wnd[1]/usr/btnBUTTON_1'
SAVE_NO = 'wnd[1]/usr/btnBUTTON_2'


def sd_comments(value):
    if value is None:
        return {}
    if (not isinstance(value, dict) or set(value) - set(SD_CONTROLS)
            or any(not isinstance(text, str) or len(text) > 255 or re.search(r'[\x00-\x1f\x7f]', text)
                   for text in value.values())):
        issue('APQP_DATE_INVALID_REQUEST', 'Invalid optional SD Comment. Use at most 255 single-line characters.',
              'SD Comment 格式无效，请使用不超过 255 字符的单行文字。')
    return {group: text.strip() for group, text in value.items() if text.strip()}


def read_sd(reader, group):
    config = SD_CONTROLS[group]
    try:
        reader.check_stop()
        checkbox, comment = reader.optional(config['checkbox']), reader.optional(config['comment'])
        selected = checkbox.Selected if checkbox is not None else None
        text = comment.Text if comment is not None else None
        if not isinstance(selected, bool) or not isinstance(text, str):
            raise ValueError('SD selected/text values are not readable')
    except ApqpDateIssue:
        raise
    except Exception as error:
        issue('APQP_SD_UNREADABLE', 'The matching SD conf / SD Comment controls could not be verified. Review SAP.',
              '无法核实对应的 SD conf / SD Comment 控件，请核查 SAP。', f"{group.upper()}: {config['checkbox']} / {config['comment']}: {error}")
    return dict(selected=selected, comment=text)


def wait_save_response(reader, checkpoint, timeout=20):
    """Future save path: one Yes per recognized question; never generic STEP->Yes."""
    deadline, confirmed = reader.clock() + timeout, set()
    while reader.clock() < deadline:
        busy = reader.session.Busy
        if not isinstance(busy, (bool, int)):
            raise ValueError('SAP Busy is unreadable after Save')
        if busy:
            reader.sleep(0.02)
            continue
        # guard rejects every popup, so verify the same bound identity/transaction
        # explicitly before inspecting the narrowly scoped Save question.
        if reader._identity() != reader.identity or reader.legacy.readable_transaction(reader.session) != reader.legacy.TCODE:
            raise ValueError('The APQP session changed after Save')
        popup = reader.optional('wnd[1]')
        if popup is not None:
            yes, no = reader.optional(SAVE_YES), reader.optional(SAVE_NO)
            normalize = lambda value: str(value).replace('&', '').strip().casefold()
            question = [str(getattr(popup, 'Text', ''))]
            for identifier in ('wnd[1]/usr/txtMESSTXT1', 'wnd[1]/usr/txtMESSTXT2',
                               'wnd[1]/usr/lbl[1,1]', 'wnd[1]/usr/lbl[1,2]',
                               'wnd[1]/usr/txtSPOP-TEXTLINE1', 'wnd[1]/usr/txtSPOP-TEXTLINE2'):
                control = reader.optional(identifier)
                if control is not None: question.append(str(control.Text))
            text = ' '.join(question).casefold()
            # This custom STEP dialog stores its body outside standard MESSTXT
            # controls. Read a bounded public control tree only on the fallback.
            if 'save' not in text and '保存' not in text and 'ppap level correctly selected' not in text:
                nodes, seen = [popup], 0
                while nodes:
                    node = nodes.pop()
                    seen += 1
                    if seen > 128: raise ValueError('APQP confirmation control tree is too large')
                    value = getattr(node, 'Text', '')
                    if isinstance(value, str) and value: question.append(value)
                    children = getattr(node, 'Children', None)
                    if children is not None:
                        count = children.Count
                        if not isinstance(count, int) or not 0 <= count <= 128:
                            raise ValueError('APQP confirmation controls could not be verified')
                        nodes.extend(children(index) for index in range(count))
                text = ' '.join(question).casefold()
            text = re.sub(r'\s+', ' ', text)
            kind = ('PPAP_LEVEL' if 'is the ppap level correctly selected' in text else
                    'SAVE' if any(word in text for word in ('save', '保存', 'speichern')) else '')
            safe = (kind and kind not in confirmed and yes is not None and no is not None
                    and normalize(yes.Text) in {'yes', '是', '是(y)', '是（y）', 'ja'}
                    and normalize(no.Text) in {'no', '否', '否(n)', '否（n）', 'nein'}
                    and not any(word in text for word in ('delete', 'discard', 'logoff', 'log off', 'logon', 'terminate', '删除', '放弃', '注销')))
            if not safe:
                raise ValueError('Unrecognized APQP Save dialog; no option selected: ' + ' | '.join(question))
            checkpoint('SAVE_CONFIRMATION_DISPATCHED', button=SAVE_YES, kind=kind, question=' | '.join(question))
            confirmed.add(kind)  # A failed/ambiguous Press must never be replayed.
            reader.session.FindById(SAVE_YES).Press()
            continue
        reader.guard()
        status = reader.session.FindById('wnd[0]/sbar')
        kind, message = str(status.MessageType).strip(), str(status.Text).strip()
        if kind == 'S' and message:
            return message
        if kind in {'E', 'A'}:
            raise ValueError(f'Save was rejected: {kind}: {message}')
        reader.sleep(0.02)
    raise ValueError('APQP Save/confirmation was not positively acknowledged within 20 seconds')


def issue(code, en, zh, details=''):
    raise ApqpDateIssue(code, en, zh, details)


def writes_enabled(environment):
    return QA_WRITES_VALIDATED if environment == 'QA' else PRODUCTION_WRITES_AUTHORIZED if environment == 'PROD' else False


def write_policy():
    return dict(productionOwnerAuthorized=PRODUCTION_WRITES_AUTHORIZED,
                authorization='OWNER_REQUEST_2026-10-20' if PRODUCTION_WRITES_AUTHORIZED else 'NOT_AUTHORIZED',
                qaSaveAcceptancePassed=QA_WRITES_VALIDATED, productionSaveAcceptancePassed=PRODUCTION_WRITES_VALIDATED,
                stageOnly=STAGE_ONLY)


def verify_detail_identity(reader, expected):
    reader.guard()
    observed = {}
    for key, identifier in DETAIL_IDENTITY.items():
        reader.check_stop()
        control = reader.optional(identifier)
        if control is None or not isinstance(control.Text, str):
            issue('APQP_DETAIL_IDENTITY_UNREADABLE', 'The APQP detail identity is not readable. No dates were written.',
                  '无法读取 APQP 详情标识，未写入日期。', identifier)
        actual, wanted = control.Text.strip(), expected[key].strip()
        observed[key] = actual
        if key != 'apqp' and actual.isdigit() and wanted.isdigit():
            actual, wanted = actual.lstrip('0') or '0', wanted.lstrip('0') or '0'
        if actual != wanted:
            issue('APQP_DETAIL_IDENTITY_MISMATCH', 'The open APQP is not the requested record. No dates were written.',
                  '打开的 APQP 与指定记录不一致，未写入日期。', f'{key}: expected={expected[key]}, actual={observed[key]}')
    reader.guard()
    return observed


def read_dates(reader):
    detail = reader.read_open_detail()
    if not detail['allFourReadable']:
        issue('APQP_DATE_UNREADABLE', 'The four dates could not all be read. No Save was sent.', '无法完整读取四个日期，未发送保存。')
    return {key: value['date'] for key, value in detail['fields'].items()}


def return_to_list(reader):
    reader.guard()
    reader.session.FindById(reader.legacy.ID_BACK).Press()
    reader.wait(lambda: reader.optional(reader.legacy.ID_RESULT_GRID), 'APQP result list')


def update_open_record(reader, identity, original, desired, checkpoint, reopen, *, environment='QA', comments=None, stage_only=True):
    """Caller selected the exact record in the explicitly requested environment.

    reopen(reader, identity) must locate the same APQP in the returned list and
    return a freshly opened reader. A Save-dispatched outcome is never retried.
    """
    if environment == 'QA' and reader.identity[1:3] != ('CEQ', '100'):
        issue('APQP_DATE_QA_ONLY', 'Real date tests are restricted to QA CEQ/client 100.', '真实日期测试仅允许 QA CEQ / Client 100。')
    if environment not in {'QA', 'PROD'} or environment == 'PROD' and reader.identity[1:3] != ('VCE', '100'):
        issue('APQP_DATE_ENVIRONMENT_MISMATCH', 'The SAP write target does not match the requested environment.',
              'SAP 写入目标与指定环境不一致，未输入或保存日期。')
    if environment == 'PROD' and not PRODUCTION_WRITES_AUTHORIZED:
        issue('APQP_DATE_PRODUCTION_LOCKED', 'Production writes are not authorized.', '正式系统写入尚未授权。')
    verify_detail_identity(reader, identity)
    current = read_dates(reader)
    comments = sd_comments(comments)
    plan = compare_dates(original, current, desired)
    if plan['status'] in {'CONFLICT', 'VALIDATION_ERROR'}:
        issue('APQP_DATE_CONFLICT' if plan['status'] == 'CONFLICT' else 'APQP_DATE_VALIDATION_FAILED',
              'SAP dates changed, or a populated date was cleared. Query again; nothing was saved.',
              'SAP 日期已变化，或已有日期被清空。请重新查询，本条未保存。', identity['apqp'])
    edited_actuals = {group for group, config in SD_CONTROLS.items()
                      if original[config['actual']] != desired[config['actual']]}
    if set(comments) - edited_actuals:
        issue('APQP_DATE_VALIDATION_FAILED', 'SD Comment can be entered only with an edited matching actual date.',
              'SD Comment 只能随对应实际日期的修改一起填写。')
    groups = {group for group, config in SD_CONTROLS.items()
              if config['actual'] in {change['field'] for change in plan['changes']}}
    if set(comments) - groups:
        issue('APQP_DATE_CONFLICT', 'The actual date was already applied by another change. Refresh before replacing its SD Comment.',
              '实际日期已被其他修改更新，请刷新后再更改对应 SD Comment。')
    if not plan['changes']:
        return dict(status='UNCHANGED', dates=current, reader=reader, changedFields=0)
    expected = dict(current)
    expected.update({change['field']: change['desired'] for change in plan['changes']})
    before_sd = {group: read_sd(reader, group) for group in groups}
    expected_sd = {group: dict(selected=True, comment=comments.get(group, values['comment']))
                   for group, values in before_sd.items()}
    # Checkbox-gated actual dates can become writable after SD conf is selected.
    # Read-only planned dates and read-only required checkboxes still fail before
    # any setter. Recheck EVERY date/comment after ticking, before date input.
    for group in groups:
        if not before_sd[group]['selected'] and reader.session.FindById(SD_CONTROLS[group]['checkbox']).Changeable is not True:
            issue('APQP_SD_READ_ONLY', 'The required SD conf checkbox is read-only. Nothing was written.',
                  '所需 SD conf 勾选框为只读，未写入。', group.upper())
    for field in DATE_FIELDS:
        if field.key in {change['field'] for change in plan['changes']}:
            control = reader.session.FindById(field.control_id)
            gated = any(SD_CONTROLS[group]['actual'] == field.key and not before_sd[group]['selected'] for group in groups)
            if control.Changeable is not True and not gated:
                issue('APQP_DATE_READ_ONLY', 'A requested SAP date is read-only. No dates were written.', '待修改的 SAP 日期为只读，未写入日期。', field.technical_name)
    checkpoint('CURRENT_VALUES_VERIFIED', original=original, current=current, desired=expected,
               environment=environment, system=reader.identity[1], client=reader.identity[2], writePolicy=write_policy(),
               sdBefore=before_sd, sdExpected=expected_sd)
    staged = False
    try:
        for group in sorted(groups):
            reader.guard()
            if not before_sd[group]['selected']:
                staged = True
                checkpoint('SD_CONFIRM_INPUT_DISPATCHED', group=group, selected=True)
                reader.session.FindById(SD_CONTROLS[group]['checkbox']).Selected = True
                reader.guard()
                if read_sd(reader, group)['selected'] is not True:
                    issue('APQP_SD_INPUT_REJECTED', 'SAP did not retain SD conf. No Save was sent.', 'SAP 未保留 SD conf 勾选，未发送保存。', group.upper())
        for change in plan['changes']:
            field = next(field for field in DATE_FIELDS if field.key == change['field'])
            if reader.session.FindById(field.control_id).Changeable is not True:
                issue('APQP_DATE_READ_ONLY', 'A requested date is read-only after SD conf. No Save was sent.',
                      '勾选 SD conf 后待修改日期仍为只读，未发送保存。', field.technical_name)
        for group in comments.keys() & groups:
            control = reader.session.FindById(SD_CONTROLS[group]['comment'])
            if control.Changeable is not True:
                issue('APQP_SD_READ_ONLY', 'SD Comment is read-only. No Save was sent.', 'SD Comment 为只读，未发送保存。', group.upper())
        for change in plan['changes']:
            reader.guard()
            field = next(field for field in DATE_FIELDS if field.key == change['field'])
            control = reader.session.FindById(field.control_id)
            staged = True  # Ambiguous setter outcomes are never replayed.
            checkpoint('DATE_INPUT_DISPATCHED', field=field.key)
            control.Text = change['desired'][8:10] + '.' + change['desired'][5:7] + '.' + change['desired'][:4]
            reader.guard()
            if date_value(control.Text) != change['desired']:
                issue('APQP_DATE_INPUT_REJECTED', 'SAP did not retain the entered date. No Save was sent.', 'SAP 未保留输入日期，未发送保存。', field.key)
        for group in sorted(comments.keys() & groups):
            reader.guard()
            control = reader.session.FindById(SD_CONTROLS[group]['comment'])
            if control.Text != comments[group]:
                staged = True
                checkpoint('SD_COMMENT_INPUT_DISPATCHED', group=group, comment=comments[group])
                control.Text = comments[group]
                reader.guard()
                if control.Text.rstrip() != comments[group].rstrip():
                    issue('APQP_SD_INPUT_REJECTED', 'SAP did not retain SD Comment. No Save was sent.', 'SAP 未保留 SD Comment，未发送保存。', group.upper())
        verify_detail_identity(reader, identity)
        if read_dates(reader) != expected:
            issue('APQP_DATE_INPUT_REJECTED', 'Date verification failed before Save.', '保存前日期核对失败，未发送保存。')
        if any(read_sd(reader, group) != values for group, values in expected_sd.items()):
            issue('APQP_SD_INPUT_REJECTED', 'SD conf / Comment verification failed before Save.', '保存前 SD conf / Comment 核对失败，未发送保存。')
        reader.guard()  # Stop before Save leaves staged inputs for manual review.
    except Exception:
        if staged:
            checkpoint('STAGED_UNSAVED', message='Inputs may be staged in SAP. Review manually; do not blindly retry.')
        raise
    if stage_only:
        checkpoint('STAGED_READY_NOT_SAVED', dates=expected, sd=expected_sd, saved=False)
        return dict(status='STAGED', dates=expected, reader=reader, changedFields=len(plan['changes']))
    checkpoint('SAVE_DISPATCHED', expected=expected)
    # After dispatch, honour Stop only after bounded verification of this Save.
    verifier = ApqpDiscovery(reader.legacy, reader.ref, reader.application, lambda: False)
    try:
        reader.session.FindById(SAVE_ID).Press()
        message = wait_save_response(verifier, checkpoint)
        checkpoint('SAVE_ACKNOWLEDGED', message=message)
        reopened = reopen(verifier, identity)
        verify_detail_identity(reopened, identity)
        after = read_dates(reopened)
        if after != expected:
            raise ValueError(f'Reopened date values differ: expected={expected}, actual={after}')
        after_sd = {group: read_sd(reopened, group) for group in groups}
        if after_sd != expected_sd:
            raise ValueError(f'Reopened SD values differ: expected={expected_sd}, actual={after_sd}')
        checkpoint('UPDATE_VERIFIED', dates=after, changedFields=len(plan['changes']), sd=after_sd)
        return dict(status='VERIFIED', dates=after, reader=reopened, changedFields=len(plan['changes']))
    except Exception as error:
        checkpoint('SAVE_OUTCOME_UNCERTAIN', details=str(error))
        issue('APQP_SAVE_OUTCOME_UNCERTAIN', 'Save was sent once, but could not be verified. Stop and inspect SAP; do not retry automatically.',
              '保存已发送一次，但未能核实结果。请停止并检查 SAP，不要自动重试。', str(error))
