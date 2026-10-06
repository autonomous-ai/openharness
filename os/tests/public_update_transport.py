#!/usr/bin/env python3
"""Private HTTPS fixture for the stock OS updater's exact official URLs.

Install its CA only inside the disposable guest. No production URL, parser,
privilege policy or TLS verification is changed by this fixture.
"""
import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shutil
import ssl
import subprocess

ASSETS = '/autonomous-ai/openharness/releases/download/'
FEED = ASSETS + 'os-preview-updates/metadata.json'
HN = '/s3-autonomous-upgrade-3/harness/tui/metadata.json'
CLI = '/s3-autonomous-upgrade-3/harness/cli/metadata.json'
HOSTS = {'github.com', 'storage.googleapis.com'}


def file_identity(path):
    with path.open('rb') as handle:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(handle, 'sha256').hexdigest()}


def prepare(bundle, folder, baselines):
    folder.mkdir(parents=True, exist_ok=False)
    manifest_path = bundle / 'package-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    version = manifest['requires_os_version']
    package = manifest['package']
    if not re.fullmatch(r'\d+\.\d+\.\d+-preview\.\d+', version):
        raise ValueError('Expected a numbered OS preview')
    name = package['name']
    if not re.fullmatch(r'harness-os-[0-9A-Za-z.+_-]+-x86_64\.pkg\.tar\.gz', name):
        raise ValueError('Invalid package path')
    if file_identity(bundle / name) != {key: package[key] for key in ('bytes', 'sha256')}:
        raise ValueError('Package differs from its manifest')
    for item in (name, 'package-manifest.json'):
        shutil.copyfile(bundle / item, folder / item)
    prefix = ASSETS + 'os-v' + version + '/'

    def asset(item):
        return {'url': 'https://github.com' + prefix + item, **file_identity(folder / item)}

    metadata = {'schema': 1, 'channel': 'preview', 'architecture': 'x86_64',
                'manifest': asset('package-manifest.json'), 'package': asset(name)}
    unused = {'url': 'https://storage.googleapis.com/harness-public-test-no-payload',
              'sha256': '0' * 64, 'size': 1}
    for component in ('hn', 'cli'):
        if not re.fullmatch(r'\d+\.\d+\.\d+', baselines[component]['version']):
            raise ValueError('Invalid frozen baseline')
    hn = {'version': baselines['hn']['version'], 'builds': {'linux-x64': unused}}
    cli = {'cli': {'version': baselines['cli']['version'], 'cli': unused, 'notify': unused}}
    for item, data in [('metadata.json', metadata), ('hn.json', hn), ('cli.json', cli)]:
        (folder / item).write_text(json.dumps(data) + '\n')
    routes = [
        {'host': 'github.com', 'path': FEED, 'file': 'metadata.json'},
        {'host': 'github.com', 'path': prefix + 'package-manifest.json', 'file': 'package-manifest.json'},
        {'host': 'github.com', 'path': prefix + name, 'file': name},
        {'host': 'storage.googleapis.com', 'path': HN, 'file': 'hn.json'},
        {'host': 'storage.googleapis.com', 'path': CLI, 'file': 'cli.json'}]
    for route in routes:
        route.update(file_identity(folder / route['file']))
    (folder / 'routes.json').write_text(json.dumps(routes, indent=2) + '\n')
    return routes


def certificates(folder):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'leaf.ext').write_text('subjectAltName=DNS:github.com,DNS:storage.googleapis.com\n'
                                   'extendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n'
                                   'keyUsage=critical,digitalSignature,keyEncipherment\n'
                                   'subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
    commands = [
        ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
         '-subj', '/CN=Harness disposable VM test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
         '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
         '-keyout', 'ca.key', '-out', 'ca.crt'],
        ['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=github.com',
         '-keyout', 'leaf.key', '-out', 'leaf.csr'],
        ['openssl', 'x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
         '-CAcreateserial', '-days', '2', '-extfile', 'leaf.ext', '-out', 'leaf.crt']]
    for command in commands:
        subprocess.run(command, cwd=folder, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    for name in ('ca.key', 'leaf.key'):
        (folder / name).chmod(0o600)
    return {name: file_identity(folder / name) for name in ('ca.crt', 'leaf.crt')}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        host = self.headers.get('Host', '').lower()
        if host.endswith(':443'):
            host = host[:-4]
        route = self.server.routes.get((host, self.path))
        record = {'at': datetime.now(timezone.utc).isoformat(), 'host': host, 'path': self.path}
        if route is None:
            self.send_error(404)
            record.update(status=404, complete=True, bytes=0)
        else:
            digest = hashlib.sha256()
            count = 0
            try:
                self.send_response(200)
                self.send_header('Content-Length', str(route['bytes']))
                self.send_header('Content-Type', 'application/octet-stream')
                self.end_headers()
                with (self.server.folder / route['file']).open('rb') as handle:
                    while chunk := handle.read(128 * 1024):
                        self.wfile.write(chunk)
                        digest.update(chunk)
                        count += len(chunk)
                record.update(status=200, complete=(count == route['bytes'] and digest.hexdigest() == route['sha256']),
                              bytes=count, sha256=digest.hexdigest())
            except (OSError, ssl.SSLError) as error:
                record.update(status=200, complete=False, bytes=count, error=str(error))
        with (self.server.folder / 'requests.jsonl').open('a') as log:
            log.write(json.dumps(record) + '\n')


def server(folder, port=443):
    routes = json.loads((folder / 'routes.json').read_text())
    mapping = {}
    for row in routes:
        if (row['host'] not in HOSTS or not row['path'].startswith('/')
                or Path(row['file']).name != row['file'] or row['file'] in {'.', '..'}
                or (folder / row['file']).is_symlink()
                or file_identity(folder / row['file']) != {key: row[key] for key in ('bytes', 'sha256')}):
            raise ValueError('Invalid private HTTPS route')
        key = row['host'], row['path']
        if key in mapping:
            raise ValueError('Duplicate private HTTPS route')
        mapping[key] = row
    service = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    service.folder, service.routes = folder, mapping
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(folder / 'leaf.crt', folder / 'leaf.key')
    service.socket = context.wrap_socket(service.socket, server_side=True)
    return service


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    args = parser.parse_args()
    with server(args.folder) as instance:
        instance.serve_forever()
