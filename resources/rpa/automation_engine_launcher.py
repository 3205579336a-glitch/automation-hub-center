"""Single packaged entry point for the desktop automation engines.

The portable application ships one Python runtime instead of duplicating a full
runtime for every operation.  The first argument selects the engine; remaining
arguments are passed through unchanged (APQP uses ``--preview``).
"""

from __future__ import annotations

import importlib
import json
import sys


def configure_utf8_streams() -> None:
    """Keep packaged engines independent from the Windows console code page."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


# This must run before importing an engine because some engines print Unicode
# status text during import/startup. Corporate Chinese Windows often exposes a
# GBK console even though Electron expects UTF-8 from the child process.
configure_utf8_streams()


ENGINES = {
    "rfq": "rfq_engine",
    "me01": "me01_source_list",
    "me52n": "me52n_project_ref",
    "apqp": "apqp_plan_closure",
}


def load_engine(name: str):
    module_name = ENGINES.get(name.lower())
    if module_name is None:
        raise ValueError(f"Unknown automation engine: {name}")
    return importlib.import_module(module_name)


def self_test() -> int:
    loaded: list[str] = []
    for name in ENGINES:
        load_engine(name)
        loaded.append(name)
    print(json.dumps({"status": "ok", "engines": loaded}))
    return 0


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return self_test()
    if len(sys.argv) < 2:
        print("Usage: automation-engine.exe <rfq|me01|me52n|apqp> [arguments]", file=sys.stderr)
        return 2

    engine_name = sys.argv[1]
    module = load_engine(engine_name)
    sys.argv = [sys.argv[0], *sys.argv[2:]]
    result = module.main()
    return int(result) if isinstance(result, int) else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Automation engine failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
