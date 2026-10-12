"""Generated backups/logs go to the Hub-owned run, never beside user Excel."""
import os
from hashlib import sha256
from pathlib import Path
from uuid import uuid4


def artifact_directory(operation, create=True):
    configured = os.environ.get('HUB_ARTIFACT_DIR', '').strip()
    directory = Path(configured) if configured else Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'SAP Automation Toolbox' / '.local-data' / 'logs' / operation / str(uuid4())
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory.resolve()


def checkpoint_path(operation, source, filename):
    # Durable skip/recovery state must retain its per-input identity across runs.
    # It is not an expiring backup or ordinary log.
    configured = os.environ.get('HUB_ARTIFACT_DIR', '').strip()
    root = Path(configured).parent if configured else Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'SAP Automation Toolbox' / '.local-data' / 'logs'
    key = sha256(os.path.normcase(os.path.abspath(source)).encode('utf-8')).hexdigest()
    return root / (operation + '-checkpoints') / key / filename
