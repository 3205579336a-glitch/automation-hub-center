"""Offline smoke engine: runs the REAL date API with FAKE SAP objects only."""
import json
import importlib.util
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'resources/rpa'))
sys.path.insert(0, str(ROOT / 'scripts'))
from apqp_date_fakes import DateSession, application, legacy, enable_bulk_dates
import apqp_date_api
import apqp_date_update

request = json.loads(Path(os.environ['APQP_DATE_REQUEST_PATH']).read_text(encoding='utf-8'))
session_type = DateSession
if request['action'] == 'execute':
    spec = importlib.util.spec_from_file_location('offline_apqp_write_fakes', ROOT / 'scripts/test-apqp-date-update.py')
    fake_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fake_module)
    session_type = fake_module.WritableSession
session = session_type(count=25, state='home' if request['action'] == 'query' else 'grid',
                      system='CEQ' if request['query']['environment'] == 'QA' else 'VCE')
# Different suppliers exercise display sorting without changing original SAP row order.
for index, row in enumerate(session.grid.rows):
    row[2] = ('0041889', '0000101', '0006587')[index % 3]
if request['action'] == 'execute':
    session.save_question = 'Do you want to save the APQP data?'
if request['action'] == 'query':
    # Exercise automatic same-window navigation and the batched date path through
    # renderer -> IPC -> runner -> native protocol, not just unit tests.
    session.state, session.Info.Transaction = 'other', 'ME11'
    enable_bulk_dates(session)
# A measurable asynchronous operation so UI lock/Stop can be tested deterministically.
session.grid.on_read = lambda: time.sleep(0.003)
if request['action'] == 'preview' and request['query']['userId'] == 'CONFLICT':
    session.grid.rows = [row[:-1] + ['CONFLICT'] for row in session.grid.rows]
    session.values['2000000000'][0] = '22.10.2026'
if request['query']['userId'] == 'CONFLICT':
    session.grid.rows = [row[:-1] + ['CONFLICT'] for row in session.grid.rows]
if request['query']['userId'] == 'MISMATCH':
    session.grid.rows = [row[:3] + ['C999'] + [row[4], 'MISMATCH'] for row in session.grid.rows]
if request['query']['userId'] == 'SHARED':
    session.grid.rows = [row[:3] + ['0000'] + [row[4], 'SHARED'] for row in session.grid.rows]
with patch.object(legacy, 'checked_sap_application', return_value=application(session)), patch.object(apqp_date_update, 'QA_WRITES_VALIDATED', request['action'] == 'execute' and request['query']['environment'] == 'QA'):
    apqp_date_api.main()
