"""Create synthetic test input; no SAP calls and no real supplier data."""
from pathlib import Path
import sys
import openpyxl

path = Path(sys.argv[1])
book = openpyxl.Workbook()
sheet = book.active
sheet.title = 'RPA_Input'
sheet.append(['Plant', 'Project No.', 'Material', 'Supplier Parma', 'Supplier Email', 'Quotation Due Date', 'PPAP Date', 'Technology', '12 MR Qty', 'RFQ Qty Prototype', 'RFQ Qty Serial', 'Cost Breakdown'])
sheet.append(['C100', 'TEST-P1', '10000001', '12345', 'supplier@example.com', '2030-12-31', '2030-12-31', 'TEST_TECH', 120, 0, 25, 'No'])
sheet.append(['C100', 'TEST-P1', '10000002', '12345', 'supplier@example.com', '2030-12-31', '2030-12-31', 'TEST_TECH', 300, 10, 50, 'Yes'])
sheet.append(['C100', 'TEST-P1', '10000001', '12345', 'supplier@example.com', '2030-12-31', '2030-12-31', 'TEST_TECH', 120, 0, 25, 'No'])
book.save(path)
book.close()
