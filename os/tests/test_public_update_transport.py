import hashlib
import json
from pathlib import Path
import socket
import ssl
import tempfile
import threading
import unittest

import public_update_transport as transport


class PrivateTransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        self.name = 'harness-os-0.1.0pre15-1-x86_64.pkg.tar.gz'
        (self.bundle / self.name).write_bytes(b'exact candidate package')
        manifest = {'requires_os_version': '0.1.0-preview.15',
                    'package': {'name': self.name, **transport.file_identity(self.bundle / self.name)}}
        (self.bundle / 'package-manifest.json').write_text(json.dumps(manifest))
        self.folder = self.root / 'server'
        self.routes = transport.prepare(self.bundle, self.folder, {'hn': {'version': '0.1.12'}, 'cli': {'version': '0.3.58'}})

    def test_routes_offer_exact_os_assets_and_no_new_fast_runtime(self):
        self.assertEqual(len(self.routes), 5)
        metadata = json.loads((self.folder / 'metadata.json').read_text())
        for field, name in [('manifest', 'package-manifest.json'), ('package', self.name)]:
            self.assertEqual(metadata[field], {'url': 'https://github.com' + transport.ASSETS +
                                              'os-v0.1.0-preview.15/' + name,
                                              **transport.file_identity(self.bundle / name)})
        self.assertEqual(json.loads((self.folder / 'hn.json').read_text())['version'], '0.1.12')
        self.assertEqual(json.loads((self.folder / 'cli.json').read_text())['cli']['version'], '0.3.58')
        (self.bundle / self.name).write_bytes(b'changed candidate package')
        with self.assertRaisesRegex(ValueError, 'differs'):
            transport.prepare(self.bundle, self.root / 'corrupt', {'hn': {'version': '0.1.12'}, 'cli': {'version': '0.3.58'}})

    def test_real_tls_requires_trust_and_correct_hostname_and_exact_route(self):
        transport.certificates(self.folder)
        service = transport.server(self.folder, port=0)
        thread = threading.Thread(target=service.serve_forever, daemon=True)
        thread.start()
        try:
            def request(context, hostname='github.com', host='github.com', path=transport.FEED):
                with socket.create_connection(service.server_address, timeout=5) as raw:
                    with context.wrap_socket(raw, server_hostname=hostname) as connection:
                        connection.sendall(f'GET {path} HTTP/1.0\r\nHost: {host}\r\n\r\n'.encode())
                        chunks = []
                        while chunk := connection.recv(65536):
                            chunks.append(chunk)
                        return b''.join(chunks)

            with self.assertRaises(ssl.SSLCertVerificationError):
                request(ssl.create_default_context())
            trusted = ssl.create_default_context(cafile=self.folder / 'ca.crt')
            with self.assertRaises(ssl.SSLCertVerificationError):
                request(trusted, hostname='unrelated.example')
            valid = request(trusted)
            self.assertIn(b' 200 ', valid.split(b'\r\n', 1)[0])
            body = valid.split(b'\r\n\r\n', 1)[1]
            self.assertEqual(body, (self.folder / 'metadata.json').read_bytes())
            for host, path in [('github.com', '/ca.key'), ('github.com', transport.FEED + '?extra=1'),
                               ('github.com', '/../../package-manifest.json'), ('unrelated.example', transport.FEED)]:
                result = request(trusted, host=host, path=path)
                self.assertIn(b' 404 ', result.split(b'\r\n', 1)[0])
        finally:
            service.shutdown()
            service.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        records = [json.loads(line) for line in (self.folder / 'requests.jsonl').read_text().splitlines()]
        successful = [record for record in records if record['status'] == 200]
        self.assertEqual(len(successful), 1)
        self.assertTrue(successful[0]['complete'])
        self.assertEqual(successful[0]['sha256'], hashlib.sha256(body).hexdigest())
        self.assertEqual(sum(record['status'] == 404 for record in records), 4)

    def test_server_refuses_modified_asset(self):
        (self.folder / 'metadata.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'route'):
            transport.server(self.folder, port=0)


if __name__ == '__main__':
    unittest.main()
