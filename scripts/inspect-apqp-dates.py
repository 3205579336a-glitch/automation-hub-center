"""Developer-only read-only POC for the existing Hub's APQP date domain.

Default mode only reads the current grid. Discovery/detail navigation requires
explicit modes/options. No Save, date-write, calendar or confirmation API exists.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import sys
import threading
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources' / 'rpa'))
from apqp_date_discovery import POC_POLICY
from apqp_date_sessions import target_environment, select_reader


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['inspect-grid', 'inspect-detail', 'discover'], default='inspect-grid')
    parser.add_argument('--environment', choices=['QA', 'PROD'], default='QA')
    parser.add_argument('--project', default='')
    parser.add_argument('--owner', default='', help='Recorded S_SDMEMB filter, not necessarily the signed-in SAP account.')
    parser.add_argument('--session-id', default='', help='Developer-only disambiguation of an existing window.')
    parser.add_argument('--max-rows', type=int, default=None, help='Inspection bound (1..10000); truncation is recorded.')
    parser.add_argument('--scroll-grid', action='store_true', help='Allow read-only ALV paging; restore its original viewport when safe. No row selection or data edit.')
    parser.add_argument('--read-row', type=int, default=None, help='Explicitly open ONE inspected result row; leaves its detail page open.')
    args = parser.parse_args()
    if args.mode == 'discover' and (not args.project.strip() or not args.owner.strip()):
        parser.error('discover requires --project and --owner')
    if args.max_rows is None:
        args.max_rows = 10000 if args.mode == 'discover' else 20
    if not 1 <= args.max_rows <= 10000:
        parser.error('--max-rows must be between 1 and 10000')
    if args.read_row is not None and (args.read_row < 0 or args.mode == 'inspect-detail'):
        parser.error('--read-row needs a nonnegative row in inspect-grid/discover mode')
    if args.scroll_grid and args.mode == 'inspect-detail':
        parser.error('--scroll-grid only applies to inspect-grid/discover')
    return args


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
    args = arguments()
    # GeneratedArtifacts recognizes this manifest under the same application
    # log root, so ordinary 60-day owned-artifact retention covers POC evidence.
    run_id = str(uuid4())
    directory = Path(os.environ.get('APPDATA', Path.home())) / 'sap-automation-toolbox' / '.local-data' / 'logs' / 'automation-runs' / run_id
    directory.mkdir(parents=True, exist_ok=False)
    started = datetime.now(timezone.utc).isoformat()
    manifest = dict(version=1, id=run_id, operation='apqp-date-poc', startedAt=started)
    manifest_path = directory / 'artifacts.json'
    manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    reader = None
    report = dict(policy=POC_POLICY, readOnly=True, writesEnabled=False, runId=run_id, mode=args.mode, environment=args.environment)
    code = 2
    try:
        import pythoncom
        import apqp_plan_closure as legacy
        pythoncom.CoInitialize()
        try:
            with target_environment(legacy, args.environment):
                app = legacy.checked_sap_application()
                reader = select_reader(legacy, app, args, stop)
                if args.mode == 'inspect-detail':
                    reader.read_open_detail()
                elif args.mode == 'discover':
                    reader.discover(args.project, args.owner, args.max_rows, scroll=args.scroll_grid)
                else:
                    reader.inspect_grid(args.max_rows, scroll=args.scroll_grid)
                if args.read_row is not None:
                    reader.open_observed_row(args.read_row)
                report.update(reader.report())
                code = 0 if report.get('detail', {}).get('allFourReadable', True) else 2
                report['outcome'] = 'READ_ONLY_COMPLETE' if code == 0 else 'PARTIAL_READ'
        finally:
            pythoncom.CoUninitialize()
    except (Exception, KeyboardInterrupt) as error:
        if reader is not None:
            report.update(reader.report())
        report.update(outcome='STOPPED', error=dict(code=getattr(error, 'code', 'SAP_INSPECTION_FAILED'),
            message=getattr(error, 'issue_summary', 'Read-only APQP inspection could not finish. Inspect the SAP screen before retrying.'),
            messageZh=getattr(error, 'issue_summary_zh', '只读 APQP 检查未完成，请核对 SAP 页面后重试。'),
            details=getattr(error, 'details', str(error))))
        code = 3 if stop.is_set() or getattr(error, 'code', '') == 'CANCELLED' else 2
    finally:
        target = directory / 'apqp-date-evidence.json'
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        manifest['finishedAt'] = datetime.now(timezone.utc).isoformat()
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        print(json.dumps(dict(outcome=report.get('outcome'), readOnly=True, writesEnabled=False,
                             rowCount=report.get('grid', {}).get('rowCount'),
                             gridFullyRead=report.get('grid', {}).get('complete'),
                             allFourDatesReadable=report.get('detail', {}).get('allFourReadable'),
                             error=report.get('error'), evidencePath=str(target)), ensure_ascii=False))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
