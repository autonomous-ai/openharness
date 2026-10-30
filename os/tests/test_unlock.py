"""The page a phone unlocks a locked computer on, in its startup (root/usr/lib/harness-os/unlock/http),
against a stand-in for systemd's ask-password and systemd-reply-password."""
import json
import os
from pathlib import Path
import subprocess
import sys
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


# cryptsetup's stand-in: `open --test-passphrase --key-file=- DISK` with the password on stdin, and
# what it was asked kept for the test to read. Only "right horse" is the disk's.
CRYPTSETUP = '''#!/bin/sh
printf '%s' "$*" > "$ROOT/tested-args"
password=$(cat)
printf '%s' "$password" > "$ROOT/tested"
[ "$password" = 'right horse' ]
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
        cryptsetup = self.root / 'cryptsetup'
        cryptsetup.write_text(CRYPTSETUP)
        cryptsetup.chmod(0o755)
        self.ask()
        self.env = dict(os.environ, ROOT=str(self.root), HARNESS_UNLOCK_STATE=str(self.root / 'state'),
                        HARNESS_UNLOCK_ASK=str(self.root / 'ask'), HARNESS_UNLOCK_REPLY=str(reply),
                        HARNESS_UNLOCK_MAPPER=str(self.root / 'mapper'), HARNESS_UNLOCK_OPENS='3',
                        HARNESS_UNLOCK_BY_PHONE=str(self.root / 'run/unlocked-by-phone'),
                        HARNESS_UNLOCK_SETUP=str(self.root / 'run/phone-setup.json'),
                        HARNESS_UNLOCK_CRYPTSETUP=str(cryptsetup))

    def ask(self):
        (self.root / 'ask/ask.first').write_text(
            f'[Ask]\nPID=1\nId=cryptsetup:/dev/nvme0n1p3\nSocket={self.root}/sock\n')

    def request(self, method, path, body=b'', setup=None):
        extra = ''
        if setup is not None:
            setup = json.dumps(setup).encode()
            extra = f'X-Harness-Setup-Length: {len(setup)}\r\n'
            body += setup
        head = f'{method} {path} HTTP/1.1\r\nHost: 10.42.0.1\r\n{extra}Content-Length: {len(body)}\r\n\r\n'.encode()
        done = subprocess.run([os.environ.get('UNLOCK_SHELL', '/bin/sh'), *os.environ.get('UNLOCK_SHELL_ARGS', '').split(), str(HTTP)], input=head + body, capture_output=True,
                              env=self.env, timeout=20)
        status, _, rest = done.stdout.partition(b'\r\n')
        headers, _, payload = rest.partition(b'\r\n\r\n')
        self.assertIn(f'Content-Length: {len(payload)}'.encode(), headers)
        return int(status.split()[1]), json.loads(payload)

    def test_the_phone_is_told_the_computer_is_locked(self):
        self.assertEqual(self.request('GET', '/setup'),
                         (200, dict(protocol=3, hotspot='Harness-BD19', locked=True, wait=0)))
        self.assertEqual(self.request('GET', '/elsewhere')[0], 404)

    def test_a_password_is_checked_first_and_nothing_opens(self):
        self.assertEqual(self.request('POST', '/setup/check', b'right horse'), (200, dict(state='right')))
        self.assertEqual((self.root / 'tested').read_text(), 'right horse')
        self.assertEqual((self.root / 'tested-args').read_text(),
                         'open --test-passphrase --key-file=- /dev/nvme0n1p3')
        # Only checked: the disk's question is not answered, and it is still asked.
        self.assertFalse((self.root / 'given').exists())
        self.assertFalse((self.root / 'mapper/cryptroot').exists())
        self.assertTrue((self.root / 'ask/ask.first').exists())

    def test_wrong_ones_may_be_checked_as_often_as_the_person_likes(self):
        for attempt in range(8):
            status, body = self.request('POST', '/setup/check', b'wrong one')
            self.assertEqual((status, body['error']), (401, 'WRONG_PASSWORD'), attempt)
        self.assertEqual(self.request('POST', '/setup/check', b'right horse'), (200, dict(state='right')))
        self.assertEqual(self.request('GET', '/setup')[1]['wait'], 0)

    def test_the_wifi_around_is_the_startups_scan(self):
        self.assertEqual(self.request('GET', '/setup/networks'), (200, dict(networks=[])))
        networks = dict(networks=[dict(ssid='Glinks', signal=80, security='WPA2')])
        (self.root / 'state/networks.json').write_text(json.dumps(networks))
        self.assertEqual(self.request('GET', '/setup/networks'), (200, networks))

    def test_the_rest_of_the_setup_comes_with_the_password_and_waits_in_run(self):
        setup = dict(ssid='Glinks', password='wifi pass 1', ticket='t-1', account='u-1')
        self.assertEqual(self.request('POST', '/setup/unlock', b'right horse', setup=setup),
                         (200, dict(state='unlocked')))
        # The computer's password alone went to the disk's question.
        self.assertEqual((self.root / 'given').read_text(), 'right horse')
        kept = self.root / 'run/phone-setup.json'
        self.assertEqual(json.loads(kept.read_text()), setup)
        self.assertEqual(kept.stat().st_mode & 0o777, 0o600)

    def test_a_wrong_password_keeps_none_of_the_setup(self):
        status, body = self.request('POST', '/setup/unlock', b'wrong one', setup=dict(ssid='Glinks'))
        self.assertEqual((status, body['error']), (401, 'WRONG_PASSWORD'))
        self.assertEqual((self.root / 'given').read_text(), 'wrong one')
        self.assertFalse((self.root / 'run/phone-setup.json').exists())

    def test_the_right_password_opens_the_disk(self):
        self.assertEqual(self.request('POST', '/setup/unlock', 'right horse'.encode()), (200, dict(state='unlocked')))
        self.assertEqual((self.root / 'given').read_text(), 'right horse')
        # Marked as opened from a phone, for the screen's Wi-Fi page to leave it the radio.
        self.assertTrue((self.root / 'run/unlocked-by-phone').is_file())
        # Opened already: said so again, with nothing more sent.
        (self.root / 'given').unlink()
        self.assertEqual(self.request('POST', '/setup/unlock', b'anything')[0], 200)
        self.assertFalse((self.root / 'given').exists())

    def test_a_wrong_password_is_said_so_and_many_make_the_phone_wait(self):
        for attempt in range(5):
            status, body = self.request('POST', '/setup/unlock', b'wrong one')
            self.assertEqual((status, body['error']), (401, 'WRONG_PASSWORD'), attempt)
        # Not opened: no mark of a phone.
        self.assertFalse((self.root / 'run/unlocked-by-phone').exists())
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


ENABLE = Path(__file__).resolve().parents[1] / 'root/usr/lib/harness-os/enable-unlock'


@unittest.skipUnless(sys.platform.startswith('linux'), 'GNU sed, as on Harness OS')
class EnableUnlock(unittest.TestCase):
    """An encrypted computer installed before the startup's hotspot gets it with the package."""

    def hooks_after(self, hooks):
        with tempfile.TemporaryDirectory() as temp:
            conf = Path(temp) / 'mkinitcpio.conf'
            conf.write_text(f'HOOKS=({hooks})\nCOMPRESSION="zstd"\n')
            subprocess.run(['sh', str(ENABLE)], check=True, capture_output=True,
                           env=dict(os.environ, HARNESS_MKINITCPIO_CONF=str(conf)))
            return conf.read_text().splitlines()[0]

    def test_it_goes_before_sd_encrypt_once_and_only_where_the_disk_is_encrypted(self):
        before = 'base systemd autodetect microcode modconf kms keyboard sd-vconsole plymouth block sd-encrypt filesystems fsck'
        after = before.replace('block sd-encrypt', 'block harness-unlock sd-encrypt')
        self.assertEqual(self.hooks_after(before), f'HOOKS=({after})')
        self.assertEqual(self.hooks_after(after), f'HOOKS=({after})')
        plain = 'base systemd autodetect microcode modconf kms keyboard sd-vconsole block filesystems fsck'
        self.assertEqual(self.hooks_after(plain), f'HOOKS=({plain})')


if __name__ == '__main__':
    unittest.main()
