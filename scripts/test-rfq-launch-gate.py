"""Launch gate tests only. No SAP, COM or business engine is loaded."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources' / 'rpa'))
from rfq_runtime import wait_for_hub_ready


class LaunchGateTests(unittest.TestCase):
    def test_standalone_unchanged(self):
        wait_for_hub_ready(SimpleNamespace(hub_ready_file=''))

    def test_exact_run_and_actual_pid_required(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'ready.json'
            args = SimpleNamespace(hub_ready_file=str(path), run_id='mock-run')
            path.write_text(json.dumps({'runId': args.run_id, 'pid': os.getpid()}), encoding='utf-8')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                wait_for_hub_ready(args)
            self.assertIn('ENGINE_READY', output.getvalue())
            for marker in [{'runId': 'stale', 'pid': os.getpid()}, {'runId': args.run_id, 'pid': -1}]:
                path.write_text(json.dumps(marker), encoding='utf-8')
                with patch('rfq_runtime.time.monotonic', side_effect=[0, 1, 16]), patch('rfq_runtime.time.sleep'), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(RuntimeError, 'SAP launch was blocked'):
                        wait_for_hub_ready(args)


if __name__ == '__main__':
    unittest.main()
