"""Small Hub adapter around the supplied v32 SAP engine; no SAP selectors here."""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from collections import Counter
from pathlib import Path

from rfq_defaults import DEFAULTS, ENGINE_KEYS, ENGINE_VERSION
from rfq_interaction import (business_key, business_values, InteractionController,
                             HubCancelled, session_identity, check_session,
                             verify_staging, verify_saved_buyer, is_manual_buyer_issue)


def initialize(env_path):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace", line_buffering=True)
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--hub", action="store_true")
    parser.add_argument("--excel-path")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--target-env", choices=["PROD", "QA"], default="PROD")
    parser.add_argument("--event-mode", default="jsonl")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--production-confirmed", action="store_true")
    parser.add_argument("--stop-file", default="")
    parser.add_argument("--control-dir", default="")
    args, _ = parser.parse_known_args()
    if args.hub:
        for key in ENGINE_KEYS:
            os.environ.pop(key, None)
        os.environ.update(DEFAULTS)
        os.environ.update({
            "EXCEL_PATH": args.excel_path or "",
            "SAP_TARGET_ENV": args.target_env,
            "EXPECTED_SAP_SYSTEM": "VCE" if args.target_env == "PROD" else "CEQ",
            "EXPECTED_SAP_CLIENT": "100",
            "EXPECTED_SAP_USER": "",
            "ALLOW_PRODUCTION_WRITE": "true" if args.production_confirmed and not args.validate_only else "false",
        })
    else:
        # Standalone development: optional .env. Defaults never require a file.
        for key, value in DEFAULTS.items():
            os.environ.setdefault(key, value)
        if env_path.exists():
            from dotenv import load_dotenv
            load_dotenv(env_path, override=True)
        # Standalone execution still requires an explicit write opt-in.
        if not env_path.exists() and not args.production_confirmed:
            os.environ["ALLOW_PRODUCTION_WRITE"] = "false"
        if args.excel_path:
            os.environ["EXCEL_PATH"] = args.excel_path
    return args


def emit(args, event, **data):
    print("HUB_EVENT:" + json.dumps({"type": event, "runId": args.run_id,
          "engineVersion": ENGINE_VERSION, **data}, ensure_ascii=False, default=str), flush=True)


def validate_workbook(engine, path):
    """Use engine aliases/date/boolean/task/group rules in a memory-only store.

    ExcelStore normally saves on construction. Do not call its constructor during
    preview: neither the source workbook nor SAP may be modified here.
    """
    if path.suffix.lower() not in {".xlsx", ".xlsm"}:
        raise ValueError("Upload an .xlsx or .xlsm workbook.")
    store = engine.ExcelStore.__new__(engine.ExcelStore)
    store.workbook = engine.openpyxl.load_workbook(path, keep_vba=path.suffix.lower() == ".xlsm")
    try:
        store.worksheet = store._select_input_worksheet(engine.SHEET_NAME)
        store.header_to_column = {}
        store.logical_columns = {}
        store.status_columns = {}
        store.status_headers_changed = False
        store.dirty_rows = set()
        store._read_headers()
        store._resolve_aliases()
        required = ["plant", "project", "material", "vendor1", "vendor1_email1", "quotation_due_date",
                    "ppap_date", "tech_user", "qty_12mr", "rfq_qty_s"]
        required_labels = {"ppap_date": "PPAP Date", "tech_user": "Technology",
                           "qty_12mr": "12 MR Qty", "rfq_qty_s": "RFQ Qty Serial"}
        display_labels = {**required_labels, "vendor1": "Supplier Parma", "project": "Project No."}
        missing = [display_labels.get(k, engine.HEADER_ALIASES[k][0]) for k in required if not store.logical_columns.get(k)]
        if missing:
            raise ValueError("Missing required columns: " + ", ".join(missing))
        # v32 uses fixed E/F for header inputs. Resolve those positions from the
        # same aliases first, so existing and reordered Hub templates both work.
        engine.SUPPLIER_EMAIL_EXCEL_COL = store.logical_columns["vendor1_email1"]
        engine.RFQ_DUE_DATE_EXCEL_COL = store.logical_columns["quotation_due_date"]
        for key in required:
            matches = [col for col in range(1, store.worksheet.max_column + 1)
                       if engine.normalize_header(store.worksheet.cell(1, col).value)
                       in {engine.normalize_header(a) for a in engine.HEADER_ALIASES[key]}]
            if len(matches) != 1:
                raise ValueError("Duplicate/ambiguous column: " + engine.HEADER_ALIASES[key][0])
        store._ensure_status_headers()
        store.save = lambda: None
        # Hub templates no longer supply implicit quantities. Required I/K are
        # checked against raw cells below; optional J stays blank (no SAP write).
        engine.DEFAULT_12MR_QTY = ""
        engine.DEFAULT_RFQ_QTY_PROTOTYPE = ""
        engine.DEFAULT_RFQ_QTY_SERIAL = ""
        # Parse completed rows too, so a later copy of an already-created RFQ
        # cannot become a new execution. This masks status only in memory.
        status_reader = store.current_rfq_status
        original_states = {r: status_reader(r) for r in range(2, store.worksheet.max_row + 1)}
        store.current_rfq_status = lambda row: ''
        tasks = store.load_tasks()
        store.current_rfq_status = status_reader
        by_row = {task.excel_row: task for task in tasks}
        completed = {business_key(t): t.excel_row for t in tasks
                     if original_states[t.excel_row] in {'SUCCESS', 'ALREADY_EXISTS'}}
        rows, active, seen, exact = [], [], {}, {}
        blank_rows = 0
        for row in range(2, store.worksheet.max_row + 1):
            values = [store.value(row, key) for key in required]
            # Plant C100 may be prefilled on otherwise empty template rows.
            if not any(engine.safe_text(v) for v in values[1:]):
                blank_rows += 1
                continue
            task = by_row.get(row)
            state = original_states[row]
            skip = state in {"SUCCESS", "ALREADY_EXISTS"}
            duplicate_of = None
            note = state if skip else ''
            error = ""
            if not task and not skip:
                error = engine.safe_text(store.worksheet.cell(row, store.status_columns["Error Message"]).value)
                error = error or "Material is required."
            if task:
                if len(task.plant) != 4 or not task.plant.isalnum():
                    error = "Plant must contain four letters or digits."
                elif len(task.material) > 40 or any(c.isspace() for c in task.material):
                    error = "Material must be a valid identifier without spaces (max 40 characters)."
                elif len(task.vendors[0]) > 10 or not task.vendors[0].isalnum():
                    error = "Supplier Parma must be an identifier of up to 10 characters."
                elif len(task.project) > 24 or any(c.isspace() for c in task.project):
                    error = "Project No. must be an identifier of up to 24 characters."
                key = (*engine.parma_group_key(task), task.material)
                empty = [label for key, label in required_labels.items() if not engine.safe_text(store.value(row, key))]
                if empty and not skip:
                    error = "Required fields are blank: " + ", ".join(empty)
                if not error:
                    signature = business_key(task)
                    if signature in exact:
                        duplicate_of = exact[signature]
                        skip = True
                        note = f'Duplicate of Excel row {duplicate_of}'
                    else:
                        exact[signature] = row
                        if signature in completed:
                            skip = True
                            note = state if state in {'SUCCESS', 'ALREADY_EXISTS'} else f'Already processed in Excel row {completed[signature]}'
                        elif key in seen:
                            previous = seen[key]
                            left, right = business_values(previous), business_values(task)
                            differences = [f'{name}: {left[name]!r} -> {right[name]!r}' for name in left if left[name] != right[name]]
                            error = f'Different business data for the same material/group as Excel row {previous.excel_row}: ' + '; '.join(differences)
                        else:
                            active.append(task)
                        seen.setdefault(key, task)
            rows.append({"excelRow": row, "plant": engine.safe_text(values[0]),
                         "project": engine.safe_text(values[1]), "material": engine.normalize_material(values[2]),
                         "supplier": engine.normalize_identifier(values[3]),
                         "quotationDueDate": task.quotation_due_date if task else engine.safe_text(values[5]),
                         "qty12mr": task.qty_12mr if task else engine.safe_text(store.value(row, "qty_12mr")),
                         "rfqQtyPrototype": task.rfq_qty_p if task else engine.safe_text(store.value(row, "rfq_qty_p")),
                         "rfqQtySerial": task.rfq_qty_s if task else engine.safe_text(store.value(row, "rfq_qty_s")),
                         "costBreakdown": task.cost_breakdown[0] if task else None,
                         "valid": not error, "skipped": skip, "duplicateOf": duplicate_of,
                         "message": error or note})
        groups = engine.build_groups(active)
        group_rows = []
        warnings = []
        for group in groups:
            # Keep v32's first-row header policy; disclose conflicts before confirmation.
            conflicts = []
            for name, getter in [("Quotation Due Date", lambda t: t.quotation_due_date),
                                 ("Supplier Email", lambda t: t.emails),
                                 ("Vendors", lambda t: t.vendors),
                                 ("RFQ Comment", lambda t: t.rfq_comment),
                                 ("Allow Without Preferred Supplier", lambda t: t.allow_without_preferred)]:
                if len({str(getter(t)) for t in group.tasks}) > 1:
                    conflicts.append(name)
            if conflicts:
                warnings.append(f"{group.key}: {', '.join(conflicts)} differ; the first row's values will be used.")
            group_rows.append({"key": group.key, "plant": group.plant, "project": group.project,
                               "supplier": group.vendors[0], "materials": [t.material for t in group.tasks]})
        return {"sheetName": store.worksheet.title, "totalRows": len(rows), "validRows": len(active),
                "duplicateRows": sum(r['duplicateOf'] is not None for r in rows),
                "invalidRows": sum(not r["valid"] for r in rows), "skippedRows": sum(r["skipped"] for r in rows),
                "skippedBlankRows": blank_rows, "sample": rows, "groups": group_rows,
                "groupCount": len(groups), "plants": sorted({t.plant for t in active}), "warnings": warnings}
    finally:
        store.workbook.close()


def run_hub(engine, args):
    """Observe existing engine boundaries, never replace the recorded SAP flow."""
    context = {"current": 0, "total": 0}
    outcomes = []
    numbers = set()
    result_store = None
    log_path = ""
    pending = []
    row_materials = {}
    save_error = ""
    originals = []
    current_group = None
    csv_handles = None
    paused_states = {}

    def event(kind, **data):
        emit(args, kind, **{**context, **data})

    def replace(obj, name, value):
        originals.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    try:
        if not args.excel_path:
            raise ValueError("Select an RFQ workbook first.")
        preview = validate_workbook(engine, Path(args.excel_path))
        event("VALIDATION_COMPLETED", preview=preview)
        if args.validate_only:
            return 0
        if preview["invalidRows"] or not preview["validRows"]:
            raise ValueError("Correct all invalid rows and provide at least one ready material before starting.")
        if args.target_env == "PROD" and not args.production_confirmed:
            raise ValueError("Production execution requires confirmation.")
        engine.STOP_REQUESTED = False
        context["total"] = preview["groupCount"]
        event("RUN_STARTED", materials=preview["validRows"], message="Connecting to SAP. Complete SAP sign-in if requested.")

        old_init = engine.ExcelStore.__init__
        def init_store(self, *a, **kw):
            nonlocal result_store
            old_init(self, *a, **kw)
            result_store = self
        replace(engine.ExcelStore, "__init__", init_store)

        old_write = engine.ExcelStore.write_status
        def write_status(self, rows, **kw):
            rows = list(rows)
            old_write(self, rows, **kw)
            state = kw.get("rfq_status", "")
            buyer_state = kw.get("buyer_status", "")
            kind = None
            if state == "SUCCESS":
                kind = "RFQ_CREATED"
            elif "INPUT_REQUIRED" in state or "INPUT_REQUIRED" in buyer_state or state == "CREATED_NUMBER_NOT_FOUND":
                kind = "ACTION_REQUIRED"
            elif state == "ALREADY_EXISTS" or "SKIP" in state:
                kind = "MATERIAL_SKIPPED"
            elif "ERROR" in state or "ERROR" in buyer_state or buyer_state == "STATUS_NOT_GREEN":
                kind = "RECOVERABLE_ERROR"
            elif kw.get("buyer_status") == "SUCCESS":
                kind = "BUYER_RECEIPT_SAVED"
            if kind:
                pending.append((kind, {"rows": rows, "rfqNumber": kw.get("rfq_number", ""),
                                       "materials": [row_materials[r] for r in rows if r in row_materials],
                                       "step": kw.get("error_stage") or kind,
                                       "message": kw.get("error_message") or kind.replace("_", " ").capitalize()}))
        replace(engine.ExcelStore, "write_status", write_status)

        old_save = engine.ExcelStore.save
        def save(self):
            nonlocal save_error
            try:
                result = old_save(self)
                save_error = ""
            except Exception as exc:
                save_error = str(exc)
                raise
            while pending:
                kind, data = pending.pop(0)
                if data.get("rfqNumber"):
                    numbers.add(data["rfqNumber"])
                event(kind, **data)
            return result
        replace(engine.ExcelStore, "save", save)

        old_load = engine.ExcelStore.load_tasks
        def load_tasks(self):
            tasks = old_load(self)
            accepted = {r['excelRow'] for r in preview['sample'] if r['valid'] and not r['skipped']}
            for row in preview['sample']:
                if row.get('duplicateOf') is not None:
                    self.write_status([row['excelRow']], rfq_status='DUPLICATE_SKIPPED',
                                      error_stage='INPUT_DEDUPLICATION', error_message=row['message'])
                elif row['skipped'] and row['message'].startswith('Already processed'):
                    self.write_status([row['excelRow']], rfq_status='ALREADY_EXISTS',
                                      error_stage='INPUT_DEDUPLICATION', error_message=row['message'])
            self.save()
            return [task for task in tasks if task.excel_row in accepted]
        replace(engine.ExcelStore, 'load_tasks', load_tasks)

        # Only the desktop protocol enables blocking user interaction. Standalone
        # legacy runs and validation-only calls retain their existing behavior.
        controller = None
        if args.control_dir:
            def persist(tasks, state, stage, message):
                if result_store is not None:
                    if state == 'WAITING_FOR_USER':
                        for task in tasks:
                            paused_states.setdefault(task.excel_row, result_store.current_rfq_status(task.excel_row))
                    result_store.write_status([t.excel_row for t in tasks
                                               if result_store.current_rfq_status(t.excel_row) not in {'SUCCESS', 'ALREADY_EXISTS'}],
                                              rfq_status=state, error_stage=stage, error_message=message[:3000])
                    result_store.save()
                    if state == 'RUNNING':
                        paused_states.clear()

            def cancel(stage):
                engine.STOP_REQUESTED = True
                if result_store is not None:
                    unfinished = [r['excelRow'] for r in preview['sample'] if not r['skipped']
                                  and result_store.current_rfq_status(r['excelRow']) not in {'SUCCESS', 'ALREADY_EXISTS'}]
                    result_store.write_status(unfinished, rfq_status='CANCELLED', error_stage=stage,
                                              error_message='Stopped by user. Existing SAP objects are preserved; review before retrying.')
                    for row, status in paused_states.items():
                        if status == 'CREATED_NUMBER_NOT_FOUND':
                            result_store.write_status([row], rfq_status=status, error_stage='RFQ_NUMBER',
                                                      error_message='Stopped by user. RFQ creation outcome is uncertain; verify in SAP before retrying.')
                    result_store.save()
                if csv_handles is not None and current_group is not None:
                    old_append(*csv_handles, current_group, status='CANCELLED', error_stage=stage,
                               error_message='Stopped by user at the preserved recovery point.')

            def interaction_event(kind, **data):
                event(kind, **data)
                # Include the group checkpoint in the durable diagnostic record.
                if kind in {'ACTION_REQUIRED', 'RECOVERING', 'INTERACTION_RESOLVED'}:
                    target = Path(args.control_dir) / 'checkpoint.json'
                    checkpoint = json.loads(target.read_text(encoding='utf-8')) if target.exists() else {}
                    target.write_text(json.dumps({**checkpoint, **context, **data, 'runId': args.run_id}, default=str, ensure_ascii=False), encoding='utf-8')

            controller = InteractionController(args, interaction_event, persist, cancel)

            def pause_staging(sap, tasks, issue):
                identity = session_identity(sap)
                def verify():
                    check_session(sap, identity)
                    return verify_staging(engine, sap, tasks)
                return controller.wait('PROD_RFQ_STAGING', issue, tasks, verify)
            replace(engine, 'HUB_STAGING_RECOVERY', pause_staging)

            old_buyer_save = engine.save_buyer_receipt
            def buyer_save(sap, grid, tasks):
                try:
                    result = old_buyer_save(sap, grid, tasks)
                    if len(result[0]) == len(tasks):
                        return result
                    issue = 'Buyer Receipt is not saved green for every material. Correct and save it manually in SAP.'
                except engine.SapRpaError as exc:
                    # Preserve the original tested automatic master-data recovery.
                    if (exc.stage == 'BUYER_RECEIPT_SAVE_POPUP' and engine.CONTINUE_AFTER_BUYER_RECEIPT_MASTER_DATA_ERROR
                            and engine.is_recoverable_buyer_receipt_master_data_error(exc.message)):
                        raise
                    # A bounded pre-RFQ checkpoint: Continue verifies a manual
                    # saved-green result. It NEVER presses Save again.
                    if exc.stage not in {'BUYER_RECEIPT_SAVE_POPUP', 'BUYER_RECEIPT_SAVE'} or not is_manual_buyer_issue(exc.message):
                        raise
                    issue = exc.message
                identity = session_identity(sap)
                def verify():
                    check_session(sap, identity)
                    return verify_saved_buyer(engine, sap, tasks)
                return controller.wait('BUYER_RECEIPT_SAVED_GREEN', issue, tasks, verify)
            replace(engine, 'save_buyer_receipt', buyer_save)

        old_process = engine.process_group
        def process(sap, excel, group):
            nonlocal current_group
            current_group = group
            row_materials.clear()
            row_materials.update({t.excel_row: t.material for t in group.tasks})
            context.update(current=context["current"] + 1, groupKey=group.key,
                           supplier=group.vendors[0], plant=group.plant, project=group.project,
                           materials=[t.material for t in group.tasks])
            event("GROUP_STARTED", message="Finding materials in NPL.")
            try:
                return old_process(sap, excel, group)
            except Exception as exc:
                if controller is None:
                    raise
                if (isinstance(exc, engine.SapRpaError) and exc.stage == 'CREATE_BUYER_RECEIPT'
                        and is_manual_buyer_issue(exc.message)):
                    # Resume only after the user supplies a verified saved-green
                    # Buyer Receipt. Never repeat Create Buyer Receipt here.
                    identity = session_identity(sap)
                    def verify():
                        check_session(sap, identity)
                        return verify_saved_buyer(engine, sap, group.tasks)
                    tasks, debug, grid = controller.wait('BUYER_RECEIPT_SAVED_GREEN', exc.message, group.tasks, verify)
                    for task in tasks:
                        excel.write_status([task.excel_row], buyer_status='SUCCESS', buyer_row=task.buyer_receipt_row,
                                           rfq_status='READY_TO_CREATE', error_stage='', error_message=debug.get(task.material,''))
                    excel.save()
                    try:
                        return engine.complete_rfq_from_buyer_receipt(sap, excel, group, grid, tasks)
                    except Exception as recovery_error:
                        controller.wait(getattr(recovery_error, 'stage', 'UNEXPECTED'), str(recovery_error), tasks)
                # Automatic recovery has already been tried inside old_process.
                # Unknown/post-commit outcomes have no safe Continue boundary.
                controller.wait(getattr(exc, 'stage', 'UNEXPECTED'), str(exc), group.tasks)
        replace(engine, "process_group", process)

        for name, kind, message in [
            ("create_buyer_receipt_skipping_existing_rfq", "BUYER_RECEIPT_STARTED", "Creating Buyer Receipt."),
            ("save_buyer_receipt", "GROUP_PROGRESS", "Saving and checking green Buyer Receipt status."),
            ("complete_rfq_from_buyer_receipt", "RFQ_STARTED", "Preparing and creating RFQ.")]:
            def observe(original, event_kind, text):
                def wrapped(*a, **kw):
                    event(event_kind, message=text)
                    return original(*a, **kw)
                return wrapped
            replace(engine, name, observe(getattr(engine, name), kind, message))

        old_csv = engine.create_csv_log
        def csv_log(path):
            nonlocal log_path, csv_handles
            handle, writer, target = old_csv(path)
            csv_handles = (handle, writer)
            log_path = str(target)
            return handle, writer, target
        replace(engine, "create_csv_log", csv_log)

        old_append = engine.append_group_log
        def append(*a, **kw):
            old_append(*a, **kw)
            status = kw["status"]
            if status.startswith("SUCCESS") and result_store is not None:
                group = a[2]
                if any(result_store.current_rfq_status(t.excel_row) != "SUCCESS" for t in group.tasks):
                    status = "SUCCESS_WITH_SKIPS"
            outcomes.append(status)
            event("GROUP_FAILED" if kw["status"] == "ERROR" else "GROUP_COMPLETED",
                  message=kw.get("error_message") or status, groupStatus=status,
                  succeeded=sum(s.startswith("SUCCESS") for s in outcomes),
                  skipped=sum(not s.startswith("SUCCESS") and s != "ERROR" for s in outcomes),
                  failed=outcomes.count("ERROR"))
            # Graceful Windows cancellation: finish the current group and save;
            # do not kill the process between SAP commit and Excel write-back.
            if args.stop_file and Path(args.stop_file).exists():
                engine.STOP_REQUESTED = True
        replace(engine, "append_group_log", append)

        # Read a pending cancellation before any SAP connection is attempted.
        if args.stop_file and Path(args.stop_file).exists():
            event("RUN_CANCELLED", message="Cancelled before SAP started.")
            return 3
        engine.standalone_main()
        if save_error:
            raise RuntimeError("Result workbook could not be saved: " + save_error)
        stats = Counter(outcomes)
        details = {"processed": len(outcomes), "total": preview["groupCount"],
                   "succeeded": stats["SUCCESS"] + stats["SUCCESS_WITH_SKIPS"],
                   "withSkips": stats["SUCCESS_WITH_SKIPS"], "failed": stats["ERROR"],
                   "skipped": sum(v for k, v in stats.items() if not k.startswith("SUCCESS") and k != "ERROR"),
                   "materials": preview["validRows"], "rfqNumbers": sorted(numbers),
                   "resultPath": str(result_store.output_path) if result_store else "", "logPath": log_path}
        event("RESULT_FILE", **details)
        if engine.STOP_REQUESTED:
            event("RUN_CANCELLED", **details, message="Stopped after saving the current group. Review results before restarting.")
            return 3
        if len(outcomes) < preview["groupCount"]:
            event("RUN_FAILED", **details, message="Stopped in an unresolved SAP state. Review the saved Buyer Receipt and result before restarting.")
            return 1
        event("RUN_COMPLETED", **details, message="RFQ run finished. Review the result workbook for any skipped or failed materials.")
        return 0
    except HubCancelled:
        event('RUN_CANCELLED', state='CANCELLED', message='Stopped safely. Existing SAP objects were preserved. Review results before retrying.',
              resultPath=str(result_store.output_path) if result_store else '', logPath=log_path,
              rfqNumbers=sorted(numbers), processed=len(outcomes), total=context['total'],
              succeeded=sum(s.startswith('SUCCESS') for s in outcomes), failed=outcomes.count('ERROR'),
              skipped=sum(not s.startswith('SUCCESS') and s != 'ERROR' for s in outcomes))
        return 3
    except (Exception, SystemExit) as exc:
        traceback.print_exc()
        event("RUN_FAILED", message=str(exc), resultPath=str(result_store.output_path) if result_store else "", logPath=log_path,
              rfqNumbers=sorted(numbers), processed=len(outcomes),
              succeeded=sum(s.startswith("SUCCESS") for s in outcomes), failed=outcomes.count("ERROR"),
              skipped=sum(not s.startswith("SUCCESS") and s != "ERROR" for s in outcomes))
        return 1
    finally:
        for obj, name, value in reversed(originals):
            setattr(obj, name, value)
