"""Developer acceptance: one explicitly authorized QA APQP, four explicit dates.

Requires --confirm-qa-write; never opens connections, never uses production,
never retries Save. Before/after values and every checkpoint stay in owned logs.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources/rpa'))
from apqp_date_api import IDENTITY_COLUMNS, identities, save_summary
from apqp_date_discovery import ApqpDiscovery
from apqp_date_sessions import select_reader, target_environment
from apqp_date_update import read_dates, return_to_list, update_open_record, verify_detail_identity
from apqp_dates import DATE_FIELDS, date_value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('apqp', 'project', 'user', 'date'):
        parser.add_argument('--' + key, required=True)
    parser.add_argument('--confirm-qa-write', action='store_true', required=True)
    args = parser.parse_args()
    target_date = date_value(args.date)
    if not target_date:
        parser.error('A real YYYY-MM-DD target date is required.')
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'): stream.reconfigure(encoding='utf-8', errors='backslashreplace')
    run_id = str(uuid4())
    directory = Path(os.environ['APPDATA']) / 'sap-automation-toolbox/.local-data/logs/automation-runs' / run_id
    directory.mkdir(parents=True, exist_ok=False)
    target = directory / 'apqp-date-qa-acceptance.json'
    manifest = dict(version=1, id=run_id, operation='apqp-date-qa-acceptance', startedAt=datetime.now(timezone.utc).isoformat())
    save_summary(directory / 'artifacts.json', manifest)
    state = dict(environment='QA', system='CEQ', client='100', apqp=args.apqp, project=args.project,
                 userFilter=args.user, targetDates={field.key: target_date for field in DATE_FIELDS},
                 accepted=False, events=[])
    def checkpoint(event, **data):
        state['events'].append(dict(event=event, at=datetime.now(timezone.utc).isoformat(), **data))
        save_summary(target, state)  # Durable before each write/Save; never replay SAP on file errors.
        print(json.dumps(dict(event=event, **data), ensure_ascii=False), flush=True)
    import pythoncom
    import apqp_plan_closure as legacy
    pythoncom.CoInitialize()
    try:
        with target_environment(legacy, 'QA'):
            app = legacy.checked_sap_application()
            reader = select_reader(legacy, app, SimpleNamespace(mode='discover', session_id=''), threading.Event())
            grid = reader.discover(args.project, args.user, scroll=True, required_columns=IDENTITY_COLUMNS)
            queue = identities(grid, args.project, args.user)
            if args.apqp not in queue: raise ValueError('The explicitly authorized APQP is not in this QA result.')
            index, identity = queue[args.apqp]
            reader.open_observed_row(index)
            state['session'] = reader.latest['session']
            state['identity'] = verify_detail_identity(reader, identity)
            state['before'] = read_dates(reader)
            checkpoint('BEFORE_VALUES_RECORDED')
            def reopen(verifier, expected):
                if verifier.optional(legacy.ID_RESULT_GRID) is None: return_to_list(verifier)
                fresh_grid = verifier.inspect_grid(10000, scroll=True, required_columns=IDENTITY_COLUMNS)
                found = identities(fresh_grid, args.project, args.user)
                fresh_index, actual = found[expected['apqp']]
                if any(actual[key] != expected[key] for key in ('material', 'vendor', 'plant', 'project')):
                    raise ValueError('Reopened APQP business identity changed.')
                fresh = ApqpDiscovery(legacy, verifier.ref, app, verifier.stop)
                fresh.latest['grid'] = fresh_grid
                fresh.open_observed_row(fresh_index)
                return fresh
            result = update_open_record(reader, identity, state['before'], state['targetDates'], checkpoint, reopen)
            state['after'] = result['dates']
            state['changedFields'] = result['changedFields']
            state['accepted'] = result['status'] == 'VERIFIED' and result['dates'] == state['targetDates']
            checkpoint('QA_ACCEPTANCE_COMPLETE', status=result['status'])
            # Only this just-opened, verified detail is returned to the list.
            return_to_list(result['reader'])
    except Exception as error:
        state['error'] = dict(code=getattr(error, 'code', 'QA_ACCEPTANCE_FAILED'), details=str(error))
        checkpoint('STOPPED', **state['error'])
        return 2
    finally:
        pythoncom.CoUninitialize()
        save_summary(target, state)
        manifest['finishedAt'] = datetime.now(timezone.utc).isoformat()
        save_summary(directory / 'artifacts.json', manifest)
        print(json.dumps(dict(accepted=state['accepted'], evidencePath=str(target)), ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__': raise SystemExit(main())
