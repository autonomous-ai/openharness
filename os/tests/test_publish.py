import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('publish', Path(__file__).resolve().parents[1] / 'tools/publish.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


def archive(receipt):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as handle:
        handle.writestr('receipt.json', json.dumps(receipt))
    return data.getvalue()


class Evidence(unittest.TestCase):
    def test_a_job_run_again_is_read_from_its_newest_artifact(self):
        listing = {'artifacts': [
            {'id': 1, 'name': 'harness-os-hardware', 'created_at': '2026-10-22T09:02:56Z', 'expired': False},
            {'id': 2, 'name': 'harness-os-hardware', 'created_at': '2026-10-22T09:12:34Z', 'expired': False},
            {'id': 3, 'name': 'harness-os-hardware-x', 'created_at': '2026-10-22T09:20:00Z', 'expired': False},
        ]}
        zips = {1: archive({'status': 'failed'}), 2: archive({'status': 'passed'})}
        asked = []
        def check_output(command, **_):
            asked.append(command)
            return zips[int(command[2].split('/')[-2])]
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(publish, 'gh', return_value=json.dumps(listing)), \
             patch.object(publish.subprocess, 'check_output', side_effect=check_output):
            publish.download_latest('o/r', 7, 'harness-os-hardware', Path(folder) / 'hardware')
            self.assertEqual(json.loads((Path(folder) / 'hardware/receipt.json').read_text()), {'status': 'passed'})
        self.assertEqual(asked, [['gh', 'api', 'repos/o/r/actions/artifacts/2/zip']])

    def test_no_artifact_is_refused(self):
        with patch.object(publish, 'gh', return_value='{"artifacts": []}'), self.assertRaisesRegex(ValueError, 'no harness-os-hardware'):
            publish.download_latest('o/r', 7, 'harness-os-hardware', Path('/nonexistent'))


if __name__ == '__main__':
    unittest.main()
