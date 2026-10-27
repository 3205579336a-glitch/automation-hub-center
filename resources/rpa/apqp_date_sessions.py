"""Shared selection adapter for the developer POC and Hub's read-only date API."""
from contextlib import contextmanager
from apqp_date_discovery import ApqpDiscovery, HOME_TRANSACTIONS
from apqp_dates import ApqpDateIssue


@contextmanager
def target_environment(legacy, environment):
    if environment not in {'QA', 'PROD'}:
        raise ValueError('Choose QA or PROD.')
    settings = dict(TARGET_SYSTEM='VCE' if environment == 'PROD' else 'CEQ', TARGET_CLIENT='100',
                    TARGET_CONNECTION_NAME='VCE - One Digital Core [949]' if environment == 'PROD'
                    else 'CEQ - One Digital Core - QA [321]')
    old = {key: getattr(legacy, key) for key in settings}
    try:
        for key, value in settings.items():
            setattr(legacy, key, value)
        yield
    finally:
        for key, value in old.items():
            setattr(legacy, key, value)


def select_reader(legacy, app, args, stop):
    # Only explicit end-user discovery/navigation may leave another page.
    # Updates constrain it to the original session/account; developer inspection
    # and preview stay on their existing result screen.
    navigate = args.mode == 'discover' and getattr(args, 'allow_navigation', False)
    # Inventory all eligible windows before choosing. MAX_WORKERS=1 limits work,
    # not identity/ambiguity checks (never silently pick the first business window).
    refs = legacy.discover_sap_sessions(allow_other_transactions=navigate, application=app, limit_workers=False)
    candidates = []
    for ref in refs:
        reader = ApqpDiscovery(legacy, ref, app, stop.is_set)
        if args.session_id and reader.identity[0] != args.session_id:
            continue
        reader.guard(allow_home=True, allow_navigation=navigate)
        if args.mode == 'inspect-grid' and reader.optional(legacy.ID_RESULT_GRID) is not None:
            candidates.append(reader)
        elif args.mode == 'inspect-detail' and any(reader.optional(field['controlId']) is not None
                                                  for field in reader.latest['fieldDefinitions']):
            candidates.append(reader)
        elif args.mode == 'discover' and (legacy.readable_transaction(reader.session) in HOME_TRANSACTIONS
                or reader.selection() is not None or reader.optional(legacy.ID_RESULT_GRID) is not None):
            candidates.append((0, reader))
        elif navigate:
            candidates.append((1, reader))
    if args.mode == 'discover' and candidates:
        # Prefer one idle/query/list window over unrelated business windows.
        # Never guess between equally eligible windows. Explicit navigation can
        # leave a clean detail; save/discard prompts are never auto-confirmed.
        priority = min(item[0] for item in candidates)
        candidates = [reader for rank, reader in candidates if rank == priority]
    if not candidates:
        raise ApqpDateIssue('SAP_SESSION_UNAVAILABLE',
            'Prepare the original matching signed-in SAP window. Handle any sign-in or save/discard dialog manually.',
            '请准备原系统已登录的 SAP 窗口，登录或保存/放弃弹窗需手动处理。')
    if len(candidates) > 1:
        raise ApqpDateIssue('SAP_SESSION_AMBIGUOUS', 'More than one matching APQP window is available. Keep one eligible window ready.',
                            '有多个匹配的 APQP 窗口，请仅保留一个可用工作窗口。')
    return candidates[0]
