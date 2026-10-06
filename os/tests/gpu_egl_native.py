#!/usr/bin/env python3
"""Real Mesa EGL ABI exercise; never evidence for NVIDIA hardware acceleration."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('probe', Path(__file__).parents[1] / 'gpu_probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def main():
    records = []
    # Hosted Linux has Mesa's headless software EGL device. Select it explicitly
    # for an API/cleanup/readback check; keep its true vendor and renderer in the
    # receipt. This does not add a software fallback to the product.
    with patch.object(probe, 'device_matches', return_value=True), contextlib.redirect_stdout(io.StringIO()):
        try:
            probe.graphics('0000:00:00.0', [])
        except probe.ProbeError as error:
            assert error.operation == 'graphics.renderer', str(error)
            records.append({'check': 'software-renderer-rejected', 'detail': error.detail})
        else:
            raise AssertionError('Software graphics incorrectly passed NVIDIA verification')
        results = []
        with patch.object(probe, 'accelerated_renderer', return_value=True):
            probe.graphics('0000:00:00.0', results)
        assert len(results) == 1 and results[0]['status'] == 'passed'
        assert not probe.accelerated_renderer(results[0]['vendor'], results[0]['renderer'])
        records.append({'check': 'real-egl-api-and-color-readback', 'device': results[0]})
    print(json.dumps({'status': 'passed', 'checks': records,
                      'limits': 'Software Mesa with explicit test-only device selection; NVIDIA hardware is unverified.'}, indent=2))


if __name__ == '__main__':
    main()
