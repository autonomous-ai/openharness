"""Verify and stage the small browser extension shipped by the OS package."""
import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import zipfile

HOST = 'ai.autonomous.harness_home'
CRX_TARGET = 'usr/share/harness-os/browser-home/home.crx'


def fields(raw):
    """Read only the length-delimited fields used by the CRX3 protobuf header."""
    position = 0

    def varint():
        nonlocal position
        value = 0
        for shift in range(0, 64, 7):
            if position >= len(raw):
                break
            byte = raw[position]
            position += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError('Invalid CRX header')

    result = {}
    while position < len(raw):
        tag = varint()
        if tag & 7 != 2 or tag >> 3 in result:
            raise ValueError('Unexpected CRX header field')
        length = varint()
        if position + length > len(raw):
            raise ValueError('Truncated CRX header')
        result[tag >> 3] = raw[position:position + length]
        position += length
    return result


def verify(folder):
    source = folder / 'extension'
    manifest = json.loads((source / 'manifest.json').read_text())
    public = base64.b64decode(manifest['key'], validate=True)
    identity = hashlib.sha256(public).digest()[:16]
    extension_id = ''.join(chr(97 + int(char, 16)) for char in identity.hex())
    raw = (folder / 'home.crx').read_bytes()
    if len(raw) > 128 * 1024 or raw[:8] != b'Cr24\x03\0\0\0':
        raise ValueError('Expected the small packaged CRX3 start page')
    size = struct.unpack('<I', raw[8:12])[0]
    header, archive = raw[12:12 + size], raw[12 + size:]
    data = fields(header)
    proof = fields(data[2])
    if (set(data) != {2, 10000} or set(proof) != {1, 2} or proof[1] != public or
            fields(data[10000]) != {1: identity}):
        raise ValueError('Browser extension identity changed')
    with tempfile.TemporaryDirectory(prefix='harness-home-verify-') as temporary:
        base = Path(temporary)
        (base / 'public.der').write_bytes(public)
        (base / 'signature').write_bytes(proof[2])
        (base / 'message').write_bytes(b'CRX3 SignedData\0' + struct.pack('<I', len(data[10000])) + data[10000] + archive)
        subprocess.run(['openssl', 'pkey', '-pubin', '-inform', 'DER', '-in', str(base / 'public.der'),
                        '-out', str(base / 'public.pem')], check=True, capture_output=True, timeout=10)
        subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(base / 'public.pem'),
                        '-signature', str(base / 'signature'), str(base / 'message')],
                       check=True, capture_output=True, timeout=10)
    expected = {str(p.relative_to(source)): p.read_bytes() for p in source.rglob('*') if p.is_file()}
    with zipfile.ZipFile(io.BytesIO(archive)) as packaged:
        if (len(packaged.namelist()) != len(expected) or set(packaged.namelist()) != set(expected) or
                any(packaged.read(name) != contents for name, contents in expected.items())):
            raise ValueError('Repack the start page: CRX differs from reviewed source')
    return extension_id, manifest['version']


def stage(source, destination):
    folder = source / 'os/browser-home'
    extension_id, version = verify(folder)
    target = destination / CRX_TARGET
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(folder / 'home.crx', target)
    target.chmod(0o644)
    # The distro's supported external-extension mechanism is removable and
    # remembers removal. Do not force-install it or edit profile preferences.
    records = {
        'usr/share/harness-os/browser-home/extension.json': {
            'extension_id': extension_id,
            'descriptor': {'external_crx': '/' + CRX_TARGET, 'external_version': version},
        },
        'etc/chromium/native-messaging-hosts/' + HOST + '.json': {
            'name': HOST, 'description': 'Open Harness Connections',
            'path': '/usr/lib/harness-os/browser_home.py', 'type': 'stdio',
            'allowed_origins': ['chrome-extension://' + extension_id + '/'],
        },
    }
    for name, data in records.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + '\n')
        path.chmod(0o644)
    host = destination / 'usr/lib/harness-os/browser_home.py'
    host.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / 'os/browser_home.py', host)
    host.chmod(0o755)
    prepare = destination / 'usr/lib/harness-os/browser_profile.py'
    shutil.copyfile(source / 'os/browser_profile.py', prepare)
    prepare.chmod(0o755)
    return {'extension_id': extension_id, 'version': version}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[2]
    result = stage(source, args.stage) if args.stage else verify(source / 'os/browser-home')
    print(json.dumps(result))
