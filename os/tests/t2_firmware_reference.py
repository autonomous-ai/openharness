#!/usr/bin/env python3
"""Compare synthetic firmware conversion against pinned, reviewed upstream code."""
import argparse
import hashlib
import json
import platform
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time

from test_t2_firmware import firmware, source_fixture


UPSTREAM_SHA = 'c1c1d8aa25bb5f089e46ccd0d9738fc13bfbd784f499aa924466c690f059961e'
UPSTREAM_COMMIT = '11fc0a8d8cfb61affd0cb9d1ac245c1b6c16d3cd'


def compare(upstream, output):
    started = time.time()
    source = upstream.read_bytes()
    if hashlib.sha256(source).hexdigest() != UPSTREAM_SHA:
        raise ValueError('The upstream source differs from the reviewed conversion script.')
    marker = b'python3 - "$@" <<\'EOF\'\n'
    if source.count(marker) != 1:
        raise ValueError('Unexpected upstream Python entry point.')
    python = source.split(marker, 1)[1].split(b'\nEOF\n', 1)[0]
    checks = []
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        reference = root / 'reference.py'
        reference.write_bytes(python)
        raw = root / 'source'
        source_fixture(raw)
        # Upstream also converts Apple Silicon Bluetooth. Our T2-only boundary
        # intentionally excludes it; compare only the shared supported inputs.
        (raw / 'bluetooth/BCM4378B1_PCIE_macOS_J314_MUR.bin').unlink()
        for scenario in ('distinct-calibration', 'shared-calibration', 'missing-bluetooth'):
            if scenario == 'shared-calibration':
                for path in (raw / 'wifi').glob('*/P-*.txt'):
                    path.write_bytes(b'boardrev =fixture\nvalue=1\n')
            if scenario == 'missing-bluetooth':
                for path in (raw / 'bluetooth').iterdir():
                    path.unlink()
                (raw / 'bluetooth').rmdir()
            archive = root / (scenario + '.tar')
            subprocess.run([sys.executable, str(reference), str(raw), str(archive)], check=True,
                           timeout=20, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            # Read the upstream hardlinks as archive data; never extract them.
            with tarfile.open(archive) as handle:
                expected = {entry.name: handle.extractfile(entry).read() for entry in handle}
            actual = firmware.names.convert(firmware.source_files(raw))
            if actual != expected:
                raise ValueError('Linux firmware filenames or bytes differ from upstream: ' + scenario)
            checks.append({'scenario': scenario, 'files': len(actual),
                           'bytes': sum(len(data) for data in actual.values())})
    receipt = {'status': 'passed', 'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
               'upstream_commit': UPSTREAM_COMMIT, 'upstream_sha256': UPSTREAM_SHA,
               'platform': platform.platform(), 'python': sys.version,
               'checks': checks, 'duration_seconds': round(time.time() - started, 3),
               'limits': ['Invented fixture bytes; no actual Apple firmware is read, downloaded or published.',
                          'No claim of radio loading, macOS IORegistry discovery, or physical T2 support.']}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    compare(args.upstream, args.output)
