#!/usr/bin/env python3
"""Assemble the shipped PTX for Turing, Ada and Blackwell; no GPU execution claim."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import time
from urllib.request import urlopen
import zipfile

URL = ('https://files.pythonhosted.org/packages/25/48/b54a06168a2190572a312bfe4ce443687773eb61367ced31e064953dd2f7/'
       'nvidia_cuda_nvcc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl')
SHA256 = '5d6a0d32fdc7ea39917c20065614ae93add6f577d840233237ff08e9a38f58f0'
BYTES = 40546229


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=False)
    # Test-host tooling only. Neither the compiler nor its outputs are included
    # in the OS payload. Select one exact archive member, never extract a wheel.
    tools = output.parent / ('ptx-tools-' + str(time.time_ns()))
    tools.mkdir()
    wheel = tools / 'nvcc.whl'
    with urlopen(URL, timeout=30) as response, wheel.open('wb') as handle:
        count = 0
        while chunk := response.read(128 * 1024):
            count += len(chunk)
            if count > BYTES:
                raise ValueError('Compiler wheel exceeds its pinned size')
            handle.write(chunk)
    if wheel.stat().st_size != BYTES or digest(wheel) != SHA256:
        raise ValueError('Compiler wheel checksum mismatch')
    with zipfile.ZipFile(wheel) as archive:
        compiler = tools / 'ptxas'
        compiler.write_bytes(archive.read('nvidia/cuda_nvcc/bin/ptxas'))
    compiler.chmod(0o755)
    source = Path(__file__).parents[1] / 'gpu_probe.py'
    spec = importlib.util.spec_from_file_location('probe', source)
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    ptx = output / 'harness.ptx'
    ptx.write_bytes(probe.PTX)
    version = subprocess.check_output([str(compiler), '--version'], text=True, timeout=10)
    record = dict(status='running', wheel={'url': URL, 'bytes': BYTES, 'sha256': SHA256},
                  compiler={'version': version, 'sha256': digest(compiler)},
                  probe_sha256=digest(source), ptx_sha256=digest(ptx), targets=[],
                  limits='Offline NVIDIA assembler only; device execution and driver JIT remain unverified.')
    for target in ['sm_75', 'sm_89', 'sm_120']:
        binary = output / (target + '.cubin')
        result = subprocess.run([str(compiler), '--gpu-name=' + target, str(ptx), '-o', str(binary)],
                                text=True, capture_output=True, timeout=30)
        (output / (target + '.log')).write_text(result.stdout + result.stderr)
        result.check_returncode()
        if binary.read_bytes()[:4] != b'\x7fELF':
            raise ValueError('Assembler did not produce a device binary')
        record['targets'].append({'target': target, 'bytes': binary.stat().st_size, 'sha256': digest(binary)})
    invalid = tools / 'invalid.ptx'
    invalid.write_bytes(probe.PTX.replace(b'mad.lo.u32 v, v, 3, 7;', b'not_a_ptx_instruction;'))
    rejected = subprocess.run([str(compiler), '--gpu-name=sm_89', str(invalid), '-o', str(tools / 'invalid.cubin')],
                              capture_output=True, text=True, timeout=30)
    if rejected.returncode == 0:
        raise ValueError('The compiler did not reject intentionally invalid PTX')
    record.update(status='passed', negative_control={'returncode': rejected.returncode, 'stderr': rejected.stderr})
    (output / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
