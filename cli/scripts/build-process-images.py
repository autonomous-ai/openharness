#!/usr/bin/env python3
"""Build the read-only image helper; no installation, downloads or release."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile


def command(argv):
    try:
        return subprocess.run(argv, check=True, capture_output=True, timeout=60)
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode('utf-8', errors='replace').strip()
        raise RuntimeError(f'{Path(argv[0]).name} failed: {detail}') from error


def build(output):
    if platform.system() != 'Darwin':
        raise RuntimeError('Build the universal helper on a macOS host with Xcode')
    output = output.resolve()
    if output.exists():
        raise RuntimeError('Use a fresh output path; existing artifacts are retained')
    source = Path(__file__).resolve().parents[1] / 'native/darwin-process-images.c'
    with tempfile.TemporaryDirectory(prefix='harness-process-images-') as root:
        root = Path(root)
        slices = []
        for arch, minimum in [('arm64', '11.0'), ('x86_64', '10.15')]:
            binary = root / arch
            command(['/usr/bin/xcrun', '--sdk', 'macosx', 'clang', '-std=c11',
                     '-Wall', '-Wextra', '-Werror', '-O2', '-arch', arch,
                     f'-mmacosx-version-min={minimum}', str(source), '-o', str(binary)])
            slices.append(binary)
        universal = root / 'harness-process-images'
        command(['/usr/bin/lipo', '-create', *map(str, slices), '-output', str(universal)])
        command(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier',
                 'ai.autonomous.harness.process-images', '--timestamp=none', str(universal)])
        command(['/usr/bin/codesign', '--verify', '--strict', '--all-architectures', str(universal)])
        architectures = command(['/usr/bin/lipo', str(universal), '-archs']).stdout.decode().split()
        if sorted(architectures) != ['arm64', 'x86_64']:
            raise RuntimeError(f'Unexpected helper architectures: {architectures}')
        # Execute the host slice and require a truthful record for this builder.
        records = [json.loads(line) for line in command(
            [str(universal), '--paths', str(os.getpid())]).stdout.splitlines()]
        if (len(records) != 2 or records[0] != {'schema': 1, 'mode': 'paths'}
                or records[1].get('pid') != os.getpid() or not records[1].get('imageHex')):
            raise RuntimeError('The built helper failed its host-architecture smoke check')
        data = universal.read_bytes()
        artifact = {
            'schema': 1, 'platform': 'darwin', 'architectures': ['arm64', 'x86_64'],
            'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'builderSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data),
            'base64': base64.b64encode(data).decode('ascii'),
            'hostArchitecture': platform.machine(),
            'toolchain': command(['/usr/bin/xcrun', 'clang', '--version']).stdout.decode().strip(),
        }
        with output.open('x') as file:
            json.dump(artifact, file, separators=(',', ':'))
            file.write('\n')
        print(json.dumps({key: value for key, value in artifact.items()
                          if key not in ['base64', 'toolchain']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    build(parser.parse_args().output)
