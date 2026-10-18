"""The page a phone unlocks a locked computer on, in its startup (root/usr/lib/harness-os/unlock/http),
against a stand-in for systemd's ask-password and systemd-reply-password."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HTTP = Path(__file__).resolve().parents[1] / 'root/usr/lib/harness-os/unlock/http'

# systemd-reply-password's stand-in: the right password opens the disk; a wrong one is asked again,
# in a new file, as systemd-cryptsetup does. What it was given is kept for the test to read.
REPLY = '''#!/bin/sh
read -r password
printf '%s' "$password" > "$ROOT/given"
rm -f "$ROOT"/ask/ask.*
if [ "$password" = 'right horse' ]; then
    touch "$ROOT/mapper/cryptroot"
else
    printf '[Ask]\\nId=cryptsetup:/dev/nvme0n1p3\\nSocket=%s/sock2\\n' "$ROOT" > "$ROOT/ask/ask.again$$"
fi
'''


class Unlock(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        for name in ('state', 'ask', 'mapper'):
            (self.root / name).mkdir()
        (self.root / 'mapper/control').touch()
        (self.root / 'state/name').write_text('Harness-BD19\n')
        reply = self.root / 'reply'
        reply.write_text(REPLY)
        reply.chmod(0o755)
        self.ask()
        self.env = dict(os.environ, ROOT=str(self.root), HARNESS_UNLOCK_STATE=str(self.root / 'state'),
                        HARNESS_UNLOCK_ASK=str(self.root / 'ask'), HARNESS_UNLOCK_REPLY=str(reply),
                        HARNESS_UNLOCK_MAPPER=str(self.root / 'mapper'), HARNESS_UNLOCK_OPENS='3')

    def ask(self):
        (self.root / 'ask/ask.first').write_text(
            f'[Ask]\nPID=1\nId=cryptsetup:/dev/nvme0n1p3\nSocket={self.root}/sock\n')

    def request(self, method, path, body=b''):
        head = f'{method} {path} HTTP/1.1\r\nHost: 10.42.0.1\r\nContent-Length: {len(body)}\r\n\r\n'.encode()
        done = subprocess.run([os.environ.get('UNLOCK_SHELL', '/bin/sh'), *os.environ.get('UNLOCK_SHELL_ARGS', '').split(), str(HTTP)], input=head + body, capture_output=True,
                              env=self.env, timeout=20)
        status, _, rest = done.stdout.partition(b'\r\n')
        headers, _, payload = rest.partition(b'\r\n\r\n')
        self.assertIn(f'Content-Length: {len(payload)}'.encode(), headers)
        return int(status.split()[1]), json.loads(payload)

    def test_the_phone_is_told_the_computer_is_locked(self):
        self.assertEqual(self.request('GET', '/setup'),
                         (200, dict(protocol=1, hotspot='Harness-BD19', locked=True, wait=0)))
        self.assertEqual(self.request('GET', '/elsewhere')[0], 404)

    def test_the_right_password_opens_the_disk(self):
        self.assertEqual(self.request('POST', '/setup/unlock', 'right horse'.encode()), (200, dict(state='unlocked')))
        self.assertEqual((self.root / 'given').read_text(), 'right horse')
        # Opened already: said so again, with nothing more sent.
        (self.root / 'given').unlink()
        self.assertEqual(self.request('POST', '/setup/unlock', b'anything')[0], 200)
        self.assertFalse((self.root / 'given').exists())

    def test_a_wrong_password_is_said_so_and_many_make_the_phone_wait(self):
        for attempt in range(5):
            status, body = self.request('POST', '/setup/unlock', b'wrong one')
            self.assertEqual((status, body['error']), (401, 'WRONG_PASSWORD'), attempt)
        status, body = self.request('POST', '/setup/unlock', b'right horse')
        self.assertEqual((status, body['error']), (429, 'WAIT'))
        self.assertGreater(body['wait'], 0)
        self.assertEqual(self.request('GET', '/setup')[1]['wait'], body['wait'])

    def test_nothing_is_sent_while_the_computer_is_not_asking(self):
        for file in (self.root / 'ask').iterdir():
            file.unlink()
        self.assertEqual(self.request('POST', '/setup/unlock', b'right horse')[1]['error'], 'NOT_ASKING')
        self.assertFalse((self.root / 'given').exists())

    def test_one_try_at_a_time_and_no_empty_password(self):
        (self.root / 'state/busy').mkdir()
        self.assertEqual(self.request('POST', '/setup/unlock', b'right horse')[1]['error'], 'BUSY')
        (self.root / 'state/busy').rmdir()
        self.assertEqual(self.request('POST', '/setup/unlock')[0], 400)

    def test_a_password_with_quotes_and_spaces_arrives_as_typed(self):
        (self.root / 'reply').write_text(REPLY.replace("'right horse'", '"$password"'))
        typed = 'a "b" \'c\' $d \\e  f'
        self.assertEqual(self.request('POST', '/setup/unlock', typed.encode())[0], 200)
        self.assertEqual((self.root / 'given').read_text(), typed)


if __name__ == '__main__':
    unittest.main()
