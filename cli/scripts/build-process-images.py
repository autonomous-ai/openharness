#!/usr/bin/env python3
"""Build the read-only image helper and the /dev watch helper; no installation, downloads or release."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import subprocess
import tempfile


def command(argv):
    try:
        return subprocess.run(argv, check=True, capture_output=True, timeout=60)
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode('utf-8', errors='replace').strip()
        raise RuntimeError(f'{Path(argv[0]).name} failed: {detail}') from error


def universal(root, source, name, identifier):
    """Compile source for both Mac architectures into one ad-hoc signed binary, verified before use."""
    slices = []
    for arch, minimum in [('arm64', '11.0'), ('x86_64', '10.15')]:
        binary = root / f'{name}-{arch}'
        command(['/usr/bin/xcrun', '--sdk', 'macosx', 'clang', '-std=c11',
                 '-Wall', '-Wextra', '-Werror', '-O2', '-arch', arch,
                 f'-mmacosx-version-min={minimum}', str(source), '-o', str(binary)])
        slices.append(binary)
    binary = root / name
    command(['/usr/bin/lipo', '-create', *map(str, slices), '-output', str(binary)])
    command(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier',
             identifier, '--timestamp=none', str(binary)])
    command(['/usr/bin/codesign', '--verify', '--strict', '--all-architectures', str(binary)])
    architectures = command(['/usr/bin/lipo', str(binary), '-archs']).stdout.decode().split()
    if sorted(architectures) != ['arm64', 'x86_64']:
        raise RuntimeError(f'Unexpected helper architectures: {architectures}')
    return binary


def watch_starts_and_ends(binary):
    """Whether the host slice arms its watch and exits 0 once stdin ends, each within a deadline."""
    child = subprocess.Popen([str(binary), '--watch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env={})
    try:
        armed = (select.select([child.stdout], [], [], 5)[0]
                 and child.stdout.readline() == b'{"schema":1,"mode":"watch"}\n')
        child.stdin.close()
        return armed and child.wait(timeout=5) == 0
    except subprocess.TimeoutExpired:
        return False
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        child.stdout.close()


def build(output):
    if platform.system() != 'Darwin':
        raise RuntimeError('Build the universal helper on a macOS host with Xcode')
    output = output.resolve()
    if output.exists():
        raise RuntimeError('Use a fresh output path; existing artifacts are retained')
    native = Path(__file__).resolve().parents[1] / 'native'
    source = native / 'darwin-process-images.c'
    watch_source = native / 'darwin-dev-watch.c'
    with tempfile.TemporaryDirectory(prefix='harness-process-images-') as root:
        root = Path(root)
        images = universal(root, source, 'harness-process-images', 'ai.autonomous.harness.process-images')
        watch = universal(root, watch_source, 'harness-dev-watch', 'ai.autonomous.harness.dev-watch')
        # Execute the host slice and require a truthful record for this builder.
        records = [json.loads(line) for line in command(
            [str(images), '--paths', str(os.getpid())]).stdout.splitlines()]
        if (len(records) != 2 or records[0] != {'schema': 1, 'mode': 'paths'}
                or records[1].get('pid') != os.getpid() or not records[1].get('imageHex')):
            raise RuntimeError('The built helper failed its host-architecture smoke check')
        if not watch_starts_and_ends(watch):
            raise RuntimeError('The built /dev watch helper failed its host-architecture smoke check')
        data = images.read_bytes()
        watch_data = watch.read_bytes()
        artifact = {
            'schema': 1, 'platform': 'darwin', 'architectures': ['arm64', 'x86_64'],
            'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'builderSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data),
            'base64': base64.b64encode(data).decode('ascii'),
            'devWatch': {
                'sourceSha256': hashlib.sha256(watch_source.read_bytes()).hexdigest(),
                'sha256': hashlib.sha256(watch_data).hexdigest(), 'size': len(watch_data),
                'base64': base64.b64encode(watch_data).decode('ascii'),
            },
            'hostArchitecture': platform.machine(),
            'toolchain': command(['/usr/bin/xcrun', 'clang', '--version']).stdout.decode().strip(),
        }
        with output.open('x') as file:
            json.dump(artifact, file, separators=(',', ':'))
            file.write('\n')
        summary = {key: value for key, value in artifact.items() if key not in ['base64', 'toolchain']}
        summary['devWatch'] = {key: value for key, value in artifact['devWatch'].items() if key != 'base64'}
        print(json.dumps(summary))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    build(parser.parse_args().output)
