"""APQP date-domain evidence and desired-state comparison. No SAP writes/Excel I/O."""
from dataclasses import asdict, dataclass
from datetime import date, datetime
import hashlib
import json
import re


@dataclass(frozen=True)
class DateField:
    key: str
    technical_name: str
    temporary_label: str

    @property
    def control_id(self):
        return ('wnd[0]/usr/tabsTAB_ST/tabpTAB1/ssubSUB1:ZMFM050035_N:0901/ctxt'
                + self.technical_name)


# Labels verified read-only against the live detail page on 2026-10-20.
# Keep the technical selectors unchanged.
DATE_FIELDS = (
    DateField('gPlanDate', 'GS_ITAB-G_PLNDAT', 'RTS Action & Closure Planned Date'),
    DateField('gActualDate', 'GS_ITAB-G_ACTDAT', 'RTS Action & Closure Actual Date'),
    DateField('hPlanDate', 'GS_ITAB-H_PLNDAT', 'Total PPAP Planned Date'),
    DateField('hActualDate', 'GS_ITAB-H_ACTDAT', 'Total PPAP Actual Date'),
)
ID_PROJECT = 'wnd[0]/usr/txtS_PCODE-LOW'
ID_OWNER = 'wnd[0]/usr/txtS_SDMEMB-LOW'


class ApqpDateIssue(RuntimeError):
    def __init__(self, code, message, message_zh, details=''):
        self.code = code
        self.issue_summary = message
        self.issue_summary_zh = message_zh
        self.details = details
        super().__init__(f'[{code}] {message}' + (f' {details}' if details else ''))


def date_value(value):
    """ISO/day-dot-month dates; ambiguous slash dates never silently guessed."""
    if value is None or isinstance(value, str) and not value.strip():
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, str):
        raise ValueError('Use a real date or YYYY-MM-DD; numeric serials need an explicit workbook date system.')
    text = re.sub(r'\s*([./-])\s*', r'\1', value.strip())
    formats = ['%Y-%m-%d', '%d.%m.%Y', '%Y%m%d']
    slash = re.fullmatch(r'(\d{1,2})/(\d{1,2})/(\d{4})', text)
    if slash:
        left, right = int(slash[1]), int(slash[2])
        if left <= 12 and right <= 12 and left != right:
            raise ValueError('Ambiguous date. Use YYYY-MM-DD.')
        formats.append('%d/%m/%Y' if left > 12 or left == right else '%m/%d/%Y')
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError('Invalid date. Use YYYY-MM-DD.')


def fingerprint(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def field_definitions():
    return [dict(**asdict(field), controlId=field.control_id, labelIsTemporary=False) for field in DATE_FIELDS]


def compare_dates(original, current, desired):
    """Pure future-preview foundation; never writes, clears, or dispatches Save.

    Fields not edited in Excel preserve any newer SAP value. A desired value
    already in SAP is idempotently satisfied, not a reason to save again.
    Missing keys/accidental blanks cannot become destructive instructions.
    """
    fields = []
    for field in DATE_FIELDS:
        item = dict(field=field.key, label=field.temporary_label, labelIsTemporary=False)
        try:
            a, b, c = (date_value(values[field.key]) for values in (original, current, desired))
            item.update(original=a, current=b, desired=c)
            if c is None and a is not None:
                item.update(status='VALIDATION_ERROR', reason='Blank does not authorize clearing an existing SAP date.')
            elif c == a:
                item.update(status='NO_CHANGE', expectedAfterSave=b)
            elif c == b:
                item.update(status='ALREADY_APPLIED', expectedAfterSave=b)
            elif b != a:
                item.update(status='CONFLICT', reason='SAP data changed since export. Refresh before updating.')
            else:
                item.update(status='CHANGE', expectedAfterSave=c)
        except (ValueError, KeyError, TypeError) as error:
            item.update(status='VALIDATION_ERROR', reason=str(error))
        fields.append(item)
    statuses = {field['status'] for field in fields}
    state = ('VALIDATION_ERROR' if 'VALIDATION_ERROR' in statuses else
             'CONFLICT' if 'CONFLICT' in statuses else
             'CHANGES_PROPOSED' if 'CHANGE' in statuses else 'NO_CHANGE')
    return dict(status=state, fields=fields,
                changes=[field for field in fields if field['status'] == 'CHANGE'] if state == 'CHANGES_PROPOSED' else [],
                writesEnabled=False)
