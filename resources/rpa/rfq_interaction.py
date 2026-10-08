"""Hub-only checkpoints. Verification is read-only; never replay SAP commits."""
import json
import re
import time
import uuid
from dataclasses import asdict
from decimal import Decimal, InvalidOperation
from pathlib import Path


def quantity_key(value):
    if value == '':
        return value  # Blank optional quantity is not zero.
    try:
        numeric = Decimal(value)
        if numeric.is_finite():
            text = format(numeric, 'f') if numeric else '0'
            return text.rstrip('0').rstrip('.') if '.' in text else text
    except InvalidOperation:
        pass
    return value


def business_values(task):
    # Include every input in the dataclass, including optional vendor slots and
    # future input fields. Only execution metadata is excluded.
    values = {k: v for k, v in asdict(task).items()
              if k not in {'excel_row', 'npl_row', 'buyer_receipt_row', 'rfq_row'}}
    for name in ('qty_12mr', 'rfq_qty_p', 'rfq_qty_s'):
        values[name] = quantity_key(values[name])
    return values


def business_key(task):
    return json.dumps(business_values(task), sort_keys=True, ensure_ascii=False)


class HubCancelled(BaseException):
    """Bypass the legacy per-group retry/error handlers, but run their finally."""


class InteractionController:
    def __init__(self, args, emit, persist, cancel):
        self.args, self.emit, self.persist, self.cancel = args, emit, persist, cancel
        self.state = 'RUNNING'

    def wait(self, stage, issue, tasks, verify=None):
        directory = Path(self.args.control_dir)
        directory.mkdir(parents=True, exist_ok=True)
        self.persist(tasks, 'WAITING_FOR_USER', stage, issue)
        self.state = 'WAITING_FOR_USER'
        while True:
            request_id = str(uuid.uuid4())
            data = dict(requestId=request_id, automation='RFQ', severity='ATTENTION',
                        state='WAITING_FOR_USER', step=stage, recoveryPoint=stage,
                        rows=[t.excel_row for t in tasks], materials=[t.material for t in tasks],
                        message=issue, allowedActions=['continue', 'stop'] if verify else ['stop'])
            duplicate = re.search(r'Material[= ]([^\s:;]+): expected one SAP row, found (\d+)', issue)
            if duplicate:
                material, count = duplicate.groups()
                data.update(issueSummary=f'Material {material} matches {count} SAP rows. A unique row is required.',
                            issueSummaryZh=f'物料 {material} 匹配到 {count} 行 SAP 数据，需要确认唯一目标行。')
            elif stage == 'BUYER_RECEIPT_SAVED_GREEN':
                data.update(issueSummary='Buyer Receipt data needs correction or its saved green status cannot be confirmed.',
                            issueSummaryZh='Buyer Receipt 数据需要修正，或尚未确认已保存为绿色状态。')
            else:
                data.update(issueSummary='The current SAP screen or data could not be verified.' if verify else 'An unexpected SAP state was detected.',
                            issueSummaryZh='当前 SAP 页面或数据未通过验证。' if verify else '检测到未确认的 SAP 状态。')
            checkpoint = {**data, 'runId': self.args.run_id}
            # Local diagnostics only. No credential/COM objects are serialized.
            (directory / 'checkpoint.json').write_text(json.dumps(checkpoint, ensure_ascii=False), encoding='utf-8')
            self.emit('ACTION_REQUIRED', **data)
            response = directory / (request_id + '.json')
            while True:
                if self.args.stop_file and Path(self.args.stop_file).exists():
                    action = 'stop'
                    break
                if response.exists():
                    try:
                        command = json.loads(response.read_text(encoding='utf-8'))
                        response.unlink()
                        if isinstance(command, dict) and command.get('runId') == self.args.run_id and command.get('requestId') == request_id:
                            action = command.get('action')
                            if action == 'stop' or action == 'continue' and verify:
                                break
                    except (OSError, ValueError):
                        pass
                time.sleep(0.2)
            if action == 'stop':
                self.state = 'CANCELLED'
                self.cancel(stage)
                raise HubCancelled()
            self.state = 'RECOVERING'
            self.persist(tasks, 'RECOVERING', stage, issue)
            self.emit('RECOVERING', requestId=request_id, state='RECOVERING', step=stage,
                      message='Checking the current SAP state. No SAP writes during verification.')
            try:
                result = verify()
            except Exception as exc:
                issue = 'The issue is still present. / 问题仍未解决：' + str(exc)
                self.state = 'WAITING_FOR_USER'
                self.persist(tasks, 'WAITING_FOR_USER', stage, issue)
                continue
            # A simultaneous Stop always wins over verification success.
            if self.args.stop_file and Path(self.args.stop_file).exists():
                self.state = 'CANCELLED'
                self.cancel(stage)
                raise HubCancelled()
            self.persist(tasks, 'RUNNING', '', '')
            if self.args.stop_file and Path(self.args.stop_file).exists():
                self.state = 'CANCELLED'
                self.cancel(stage)
                raise HubCancelled()
            self.state = 'RUNNING'
            self.emit('INTERACTION_RESOLVED', requestId=request_id, state='RUNNING', step=stage,
                      message='SAP state verified. Resuming the current checkpoint.')
            return result


def session_identity(sap):
    info = sap.session.Info
    identity = (str(sap.session.Id), str(info.SystemName), str(info.Client), str(info.User))
    if not all(identity):
        raise ValueError('Cannot verify the SAP session identity.')
    return identity


def check_session(sap, identity):
    if session_identity(sap) != identity:
        raise ValueError('SAP session/system/client/user changed. Return to the original session.')
    if sap.session.Busy:
        raise ValueError('SAP is still busy.')
    if sap.exists('wnd[1]'):
        raise ValueError('Resolve the SAP dialog first: ' + sap.popup_message_text('wnd[1]'))
    kind, message = sap.status_bar()
    if kind in {'E', 'A'}:
        raise ValueError(message or 'SAP still reports an error.')


def verify_staging(engine, sap, tasks):
    """Read-only screen and row mapping; ambiguity is never auto-deleted."""
    title = engine.safe_text(sap.find('wnd[0]').Text).casefold()
    if 'rfq' not in title or 'buyer receipt' in title:
        raise ValueError('Return to the RFQ/Quotation Creation by vendor screen.')
    grid = sap.find(engine.ID_GRID_CUSTOMER1, required=False)
    if grid is None or not sap.column_exists(grid, engine.COL_MATERIAL):
        raise ValueError('RFQ material grid is not available.')
    mapping, _ = sap.map_material_rows(grid, tasks)
    for task in tasks:
        rows = mapping.get(task.material, [])
        if len(rows) != 1:
            raise ValueError(f'Material {task.material}: expected one SAP row, found {len(rows)}; SAP rows {[r+1 for r in rows]}. No checkbox was changed.')
        row = rows[0]
        if engine.normalize_identifier(sap.get_cell(grid, row, 'WERKS')).upper() != task.plant:
            raise ValueError(f'Material {task.material}: Plant does not match.')
        project = engine.normalize_identifier(sap.get_cell(grid, row, engine.COL_PROJECT_NPL))
        if project and project != task.project:
            raise ValueError(f'Material {task.material}: Project does not match.')
        for i, vendor in enumerate(task.vendors, 1):
            if not vendor:
                continue
            if engine.normalize_identifier(sap.get_cell(grid, row, f'LIFNR{i}')) != vendor:
                raise ValueError(f'Material {task.material}: Supplier Parma in slot {i} does not match.')
            column = f'LIFNR{i}_CB'
            if engine.safe_text(grid.GetCellType(row, column)).casefold() != 'checkbox':
                raise ValueError(f'Material {task.material}: {column} is not a checkbox.')
            if not task.cost_breakdown[i-1] and not grid.GetCellChangeable(row, column):
                raise ValueError(f'Material {task.material}: {column} is read-only.')
    return grid, mapping


def verify_saved_buyer(engine, sap, tasks):
    group = engine.TaskGroup(key='manual-resume', tasks=list(tasks))
    resumed = engine.try_resume_saved_buyer_receipt(sap, group)
    if resumed is None:
        raise ValueError('Correct and save the current Buyer Receipt in SAP; all requested materials must have green saved status.')
    grid, accepted, debug = resumed
    for task in accepted:
        row = task.buyer_receipt_row
        if engine.normalize_identifier(sap.get_cell(grid, row, 'WERKS')).upper() != task.plant:
            raise ValueError(f'Material {task.material}: Buyer Receipt Plant mismatch.')
        if engine.normalize_identifier(sap.get_cell(grid, row, engine.COL_PROJECT_NPL)) != task.project:
            raise ValueError(f'Material {task.material}: Buyer Receipt Project mismatch.')
        for i, vendor in enumerate(task.vendors, 1):
            if vendor and engine.normalize_identifier(sap.get_cell(grid, row, f'LIFNR{i}')) != vendor:
                raise ValueError(f'Material {task.material}: Buyer Receipt supplier mismatch.')
        for field, column in [('qty_12mr', engine.COL_12MR_QTY), ('rfq_qty_p', engine.COL_RFQ_QTY_PROTOTYPE), ('rfq_qty_s', engine.COL_RFQ_QTY_SERIAL)]:
            expected = getattr(task, field)
            if expected and quantity_key(engine.format_quantity(sap.get_cell(grid, row, column), '')) != quantity_key(expected):
                raise ValueError(f'Material {task.material}: saved {field} does not match the uploaded quantity.')
    return accepted, debug, grid


def is_manual_buyer_issue(message):
    # Only explicit prerequisite/master-data failures at the save boundary can
    # offer Continue. An arbitrary popup text is not a recoverable classification.
    text = ' '.join(message.casefold().split())
    return any(field in text for field in ('sub commodity', 'subcommodity', 'material master', 'technology', 'techman', 'vendor company view')) and any(
        word in text for word in ('missing', 'required', 'needs', 'need ', 'incorrect', 'invalid', 'does not exist', '缺失', '必填', '需要'))
