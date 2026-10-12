"""Offline path ownership tests; never launch SAP or Excel."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'resources' / 'rpa'))
from hub_artifacts import artifact_directory, checkpoint_path


class ArtifactTests(unittest.TestCase):
    def test_native_backups_use_supplied_hub_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'logs' / 'run'
            with patch.dict(os.environ, HUB_ARTIFACT_DIR=str(root)):
                self.assertEqual(artifact_directory('apqp'), root.resolve())
                self.assertEqual(artifact_directory('me01'), root.resolve())
                self.assertEqual(artifact_directory('me52n'), root.resolve())
                self.assertTrue(root.is_dir())

    def test_standalone_fallback_is_local_app_logs_not_input_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ, HUB_ARTIFACT_DIR='', LOCALAPPDATA=folder):
                result = artifact_directory('me01')
                self.assertTrue(result.is_relative_to(Path(folder) / 'SAP Automation Toolbox' / '.local-data' / 'logs'))

    def test_pr_checkpoint_identity_survives_new_runs_and_separates_inputs(self):
        with tempfile.TemporaryDirectory() as folder:
            source = str(Path(folder) / 'user-excel' / 'input.xlsx')
            paths = []
            for run in ['run1', 'run2']:
                with patch.dict(os.environ, HUB_ARTIFACT_DIR=str(Path(folder) / 'logs' / 'automation-runs' / run)):
                    paths.append(checkpoint_path('me52n', source, 'checkpoint.xlsx'))
            self.assertEqual(*paths)
            self.assertFalse(paths[0].exists(), 'Path calculation does not create a file or directory')
            self.assertTrue(paths[0].is_relative_to(Path(folder) / 'logs'))
            with patch.dict(os.environ, HUB_ARTIFACT_DIR=str(Path(folder) / 'logs' / 'automation-runs' / 'run3')):
                self.assertNotEqual(paths[0], checkpoint_path('me52n', source + 'other.xlsx', 'checkpoint.xlsx'))


if __name__ == '__main__':
    unittest.main()
