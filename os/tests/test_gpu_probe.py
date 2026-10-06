"""Exercise the real ctypes ABI and error/readback handling without claiming a GPU."""
import contextlib
import ctypes
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gpu_probe', Path(__file__).parents[1] / 'gpu_probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@unittest.skipUnless(shutil.which('cc'), 'A C compiler is required for the native ABI fixture')
class DriverABITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        output = Path(cls.temp.name) / 'fixture.so'
        subprocess.run(['cc', '-dynamiclib' if sys.platform == 'darwin' else '-shared', '-fPIC',
                        '-Wall', '-Wextra', '-Werror', str(Path(__file__).with_name('gpu_cuda_fixture.c')),
                        '-o', str(output)], check=True, capture_output=True, timeout=30)
        cls.library = ctypes.CDLL(str(output))
        cls.library.fixture_mode.argtypes = [ctypes.c_int]
        cls.library.fixture_live.restype = ctypes.c_int

    def run_probe(self, mode):
        self.library.fixture_mode(mode)
        checks = []
        with patch.object(probe.C, 'CDLL', return_value=self.library), contextlib.redirect_stdout(io.StringIO()):
            try:
                probe.compute('0000:01:00.0', checks)
            finally:
                self.assertEqual(self.library.fixture_live(), 0, 'The probe leaked a context, module or allocation')
        return checks

    def test_stable_64_bit_handles_and_kernel_parameter_pointer_survive_the_c_abi(self):
        checks = self.run_probe(0)
        self.assertEqual([row['test'] for row in checks], ['cuda.device', 'cuda.memory', 'cuda.compute'])
        self.assertEqual(checks[0]['total_memory_bytes'], 24 << 30)
        self.assertEqual(checks[1]['bytes'], 4096)
        self.assertEqual(checks[2]['elements'], 1024)

    def test_corrupt_copy_wrong_computation_async_error_and_wrong_gpu_are_rejected(self):
        for mode, operation in [(1, 'memory_round_trip'), (2, 'integer_vector'), (3, 'cuCtxSynchronize'), (4, 'cuDeviceGetPCIBusId')]:
            with self.subTest(mode=mode), self.assertRaises(probe.ProbeError) as caught:
                self.run_probe(mode)
            self.assertEqual(caught.exception.operation, operation)


if __name__ == '__main__':
    unittest.main()
