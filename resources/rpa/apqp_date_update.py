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
STAGE_ONLY = False  # Owner request, 2026-10-27: save and verify planned F/G/H/M dates.
QA_WRITES_AUTHORIZED = True  # Workflow authorization, not a claim of live acceptance.
# Only record-level failures proven to precede every setter can be skipped.
SAFE_PREINPUT_ISSUES = {'APQP_DATE_CONFLICT', 'APQP_DATE_VALIDATION_FAILED',
                       'APQP_DATE_READ_ONLY', 'APQP_SD_READ_ONLY', 'APQP_RECORD_WARNING', 'APQP_RECORD_ERROR'}
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
    return QA_WRITES_AUTHORIZED if environment == 'QA' else PRODUCTION_WRITES_AUTHORIZED if environment == 'PROD' else False


def write_policy():
    return dict(productionOwnerAuthorized=PRODUCTION_WRITES_AUTHORIZED,
                authorization='OWNER_REQUEST_2026-10-27' if PRODUCTION_WRITES_AUTHORIZED else 'NOT_AUTHORIZED',
                qaOwnerAuthorized=QA_WRITES_AUTHORIZED,
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


def return_unchanged_input_detail(reader, identity):
    """Leave an owned unchanged detail once; never confirm Save/discard."""
    baseline = getattr(reader, 'input_baseline', None)
    if baseline is None:
        issue('APQP_UNSAFE_RECORD_RETURN', 'No unchanged detail baseline is available. Review SAP.', '无法确认详情未变化，请核查 SAP。')
    verify_detail_identity(reader, identity)
    if read_dates(reader) != baseline:
        issue('APQP_UNSAFE_RECORD_RETURN', 'The detail changed before skipping. It was not closed.', '跳过前详情发生变化，未关闭详情。')
    reader.return_read_detail()


def check_input_status(reader):
    status = reader.optional('wnd[0]/sbar')
    if status is not None and str(status.MessageType).strip() in {'W', 'E', 'A'} and str(status.Text).strip():
        warning = str(status.MessageType).strip() == 'W'
        issue('APQP_RECORD_WARNING' if warning else 'APQP_RECORD_ERROR',
              'SAP reported a record warning/error. Review this record.', 'SAP 返回本条警告或错误，请核查本条。', str(status.Text).strip())


def update_open_record(reader, identity, original, desired, checkpoint, reopen, *, environment='QA', comments=None, stage_only=False):
    """Changed-only F/G/H/M planned dates. Never edit actual dates or SD flags."""
    expected_system = 'CEQ' if environment == 'QA' else 'VCE'
    if environment not in {'QA', 'PROD'} or reader.identity[1:3] != (expected_system, '100'):
        issue('APQP_DATE_ENVIRONMENT_MISMATCH', 'The SAP target differs from the requested environment.', 'SAP 目标与指定环境不一致，未输入日期。')
    if not writes_enabled(environment):
        issue('APQP_DATE_PRODUCTION_LOCKED', 'Date writes are not authorized for this environment.', '此环境尚未授权日期写入。')
    if comments:
        issue('APQP_DATE_INVALID_REQUEST', 'Planned-date maintenance does not change SD Comment.', '计划日期维护不修改 SD Comment。')
    verify_detail_identity(reader, identity)
    reader.input_baseline = None
    current = read_dates(reader)
    reader.input_baseline = dict(current)
    check_input_status(reader)
    plan = compare_dates(original, current, desired)
    if plan['status'] in {'CONFLICT', 'VALIDATION_ERROR'}:
        issue('APQP_DATE_CONFLICT' if plan['status'] == 'CONFLICT' else 'APQP_DATE_VALIDATION_FAILED',
              'SAP dates changed, or a populated date was cleared. Nothing was entered.',
              'SAP 日期已变化，或已有日期被清空。本条未输入。', identity['apqp'])
    if not plan['changes']:
        return dict(status='UNCHANGED', dates=current, reader=reader, changedFields=0)
    changes = [(next(field for field in DATE_FIELDS if field.key == item['field']), item['desired']) for item in plan['changes']]
    for field, _ in changes:
        if reader.session.FindById(field.control_id).Changeable is not True:
            issue('APQP_DATE_READ_ONLY', 'This SAP planned date is grey/read-only. Nothing was entered.',
                  '此 SAP 计划日期为灰色、不可修改，本条未输入。', field.temporary_label + ' / ' + field.technical_name)
    expected = dict(current)
    expected.update({field.key: value for field, value in changes})
    checkpoint('CURRENT_VALUES_VERIFIED', original=original, current=current, desired=expected,
               environment=environment, system=reader.identity[1], client=reader.identity[2], writePolicy=write_policy())
    staged = False
    try:
        for field, value in changes:
            reader.guard()
            control = reader.session.FindById(field.control_id)
            if control.Changeable is not True:
                issue('APQP_DATE_READ_ONLY', 'SAP edit permission changed. No Save was sent.', 'SAP 编辑权限已变化，未发送保存。', field.technical_name)
            staged = True  # Even an ambiguous setter is never replayed or skipped.
            checkpoint('DATE_INPUT_DISPATCHED', field=field.key, technicalName=field.technical_name)
            control.Text = value[8:10] + '.' + value[5:7] + '.' + value[:4]
            reader.guard()
            if date_value(control.Text) != value:
                issue('APQP_DATE_INPUT_REJECTED', 'SAP did not retain the planned date. No Save was sent.', 'SAP 未保留计划日期，未发送保存。', field.temporary_label)
        verify_detail_identity(reader, identity)
        if read_dates(reader) != expected:
            issue('APQP_DATE_INPUT_REJECTED', 'Planned date verification failed before Save.', '保存前计划日期核对失败，未发送保存。')
        check_input_status(reader)
        reader.guard()
    except Exception:
        if staged:
            checkpoint('STAGED_UNSAVED', message='SAP may contain unsaved inputs. Review manually; do not blindly retry.')
        raise
    if stage_only:
        checkpoint('STAGED_READY_NOT_SAVED', dates=expected, saved=False)
        return dict(status='STAGED', dates=expected, reader=reader, changedFields=len(changes))
    checkpoint('SAVE_DISPATCHED', expected=expected)
    verifier = ApqpDiscovery(reader.legacy, reader.ref, reader.application, lambda: False)
    try:
        reader.session.FindById(SAVE_ID).Press()  # Exactly once.
        message = wait_save_response(verifier, checkpoint)
        checkpoint('SAVE_ACKNOWLEDGED', message=message)
        reopened = reopen(verifier, identity)
        verify_detail_identity(reopened, identity)
        after = read_dates(reopened)
        if after != expected:
            raise ValueError(f'Reopened planned dates differ: expected={expected}, actual={after}')
        checkpoint('UPDATE_VERIFIED', dates=after, changedFields=len(changes))
        return dict(status='VERIFIED', dates=after, reader=reopened, changedFields=len(changes))
    except Exception as error:
        checkpoint('SAVE_OUTCOME_UNCERTAIN', details=str(error))
        issue('APQP_SAVE_OUTCOME_UNCERTAIN', 'Save was sent once, but could not be verified. Stop and inspect SAP; do not retry automatically.',
              '保存已发送一次，但未能核实结果。请停止并检查 SAP，不要自动重试。', str(error))
