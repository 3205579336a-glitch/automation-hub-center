"""Opt-in real Excel check, disposable synthetic files only. Never accesses SAP."""
import importlib.util
from datetime import datetime
from pathlib import Path
import shutil
import sys
import time
from unittest.mock import patch

if '--run-excel-check' not in sys.argv:
    raise SystemExit('Pass --run-excel-check to use a new private Excel instance with disposable files.')

spec = importlib.util.spec_from_file_location('rfq_fixture', Path(__file__).with_name('test-rfq-integration.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
from rfq_source_writeback import SourceWorkbookWriteback
import win32com.client

case = fixture.RfqTests()
case.setUp()
app = book = writer = None
try:
    case.book(rows=[['C100', '775773', '111', '26517', 'buyer@example.com', datetime(2030, 12, 31)],
                    ['C100', '775773', '222', '26517', 'buyer@example.com', datetime(2030, 12, 31)]])
    source = case.path.with_name('disposable-original.xlsx')
    shutil.copy2(case.path, source)
    before = fixture.engine.openpyxl.load_workbook(source)
    try:
        original = {(cell.row, cell.column): (cell.value, cell.number_format, cell.style_id)
                    for row in before.active for cell in row}
    finally:
        before.close()
    started = time.monotonic()
    writer = SourceWorkbookWriteback(fixture.engine, source, case.path, 'RPA_Input')
    writer.pending = {row: {'RFQ Number': '0000123456', 'RFQ Status': 'SUCCESS',
                            'Error Message': '=literal SAP message'} for row in (2, 3)}
    result = writer.flush()
    if result['status'] != 'synced' and writer.book is not None:
        from rfq_source_writeback import row_values, comparable
        values = row_values(writer.book.Worksheets('RPA_Input'), 2, len(writer.baseline_headers))
        print('EXCEL_CHECK synthetic comparison:', [(writer.baseline_headers[index], repr(comparable(writer.baseline_rows[2][index], writer.epoch)), repr(value))
              for index, value in enumerate(values)], flush=True)
    assert result['status'] == 'synced', result
    assert writer.owned, 'Closed source must use a new private Excel instance.'
    writer.close()
    writer = None
    saved = fixture.engine.openpyxl.load_workbook(source)
    try:
        columns = {cell.value: cell.column for cell in saved.active[1]}
        for row in (2, 3):
            assert saved.active.cell(row, columns['RFQ Number']).value == '0000123456'
            message = saved.active.cell(row, columns['Error Message'])
            assert message.value == '=literal SAP message' and message.data_type == 's'
        for (row, column), expected in original.items():
            cell = saved.active.cell(row, column)
            assert cell.value == expected[0], (row, column, expected[0], cell.value)
            # Excel may renumber style IDs and escape date separators when it
            # reserializes an XLSX. Compare the effective number format instead.
            format_key = lambda value: value.replace('\\', '').replace('"', '').lower()
            assert format_key(cell.number_format) == format_key(expected[1]), (row, column, expected[1], cell.number_format)
    finally:
        saved.close()
    print(f'EXCEL_CHECK closed original: PASS ({time.monotonic() - started:.2f}s; inputs/styles/dates/IDs/literal text preserved)', flush=True)

    # This app stands in for the user's already-open Excel. It is created here
    # solely for this check; no unrelated workbook or Excel process is closed.
    app = win32com.client.DispatchEx('Excel.Application')
    app.AutomationSecurity = 3
    app.DisplayAlerts = False
    app.EnableEvents = False
    book = app.Workbooks.Open(Filename=str(source), UpdateLinks=0, ReadOnly=False, AddToMru=False)
    writer = SourceWorkbookWriteback(fixture.engine, source, case.path, 'RPA_Input')
    writer.pending = {row: {'RFQ Number': '0000123456', 'RFQ Status': 'SUCCESS'} for row in (2, 3)}
    # A private invisible test instance has no interactive focus/ROT
    # registration cycle. Bind its exact real COM handle explicitly; discovery
    # across user-visible instances is covered by separate mocked ROT tests.
    with patch('rfq_source_writeback.attach_workbook', return_value=(app, book)):
        result = writer.flush()
    assert result['status'] == 'synced', result
    assert not writer.owned, 'An already-open workbook must be attached, never opened again.'
    writer.close()
    writer = None
    assert str(book.FullName) == str(source), 'Writeback must leave user-owned workbook open.'
    assert book.Saved
    print('EXCEL_CHECK already-open original: PASS (bound exact COM workbook; left open; no SAP access)', flush=True)
finally:
    if writer is not None:
        writer.close()
    if book is not None:
        book.Close(SaveChanges=False)
    if app is not None:
        app.Quit()
    case.tearDown()
