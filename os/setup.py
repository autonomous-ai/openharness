#!/usr/bin/env python3
"""Set up a Harness with no screen from a phone: a setup hotspot, the Wi-Fi this computer sees,
the person's Wi-Fi and password, and a sign-in ticket for the phone's account.

The phone (mobile/lib/phone/add_device/) asks the backend for a ticket while it still has the
Internet, joins the open hotspot `Harness-XXXX` (the person picks it from a list), and talks to
http://10.42.0.1/setup. This computer then leaves the hotspot, joins the chosen Wi-Fi, checks the
Internet and signs in with `harness login --ticket`. When the Wi-Fi fails, the hotspot comes back
with the reason (wrong password, out of reach, no address, no Internet), for the phone to read when
it rejoins, and the person tries again.

A computer not signed in yet (just installed, reset, or signed out) hosts the hotspot from the moment
it starts, screen or not, network or not: on Wi-Fi it leaves it for the hotspot, and on a cable the
two run side by side and the phone only signs it in. The hotspot goes once the computer is signed
in, from the phone or at the screen, and while someone who typed the computer's password at its
screen has its Wi-Fi page open (network.py SETUP_SCREEN). One signed in hosts it only with no screen
and after a long outage (a new router); while nobody is on it then, saved Wi-Fi is tried again every
few minutes, so a router that was only off brings the computer back by itself. Its name ends in the
Wi-Fi card's own address, the same however often the computer is flashed.

The hotspot has no password, for setup to be one tap: whoever is in range of a computer in setup
can choose its Wi-Fi, and the Wi-Fi password crosses an open network. Nothing here runs a command
the phone names, and a computer already signed in keeps its account (`login --ticket` refuses).
"""
import argparse
import array
import ctypes
import ctypes.util
import fcntl
import hmac
import http.server
import importlib.util
import json
from pathlib import Path
import pwd
import queue
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid

STATE = Path('/var/lib/harness-os')
RESULT = STATE / 'setup-result.json'
NOW = Path('/run/harness-os/setup-now')
# The screen's Wi-Fi page holds the radio while open (network.py SETUP_SCREEN): the pid of that page.
SCREEN = Path('/run/harness-os/setup-screen')
# Signed in from a phone: its first workspace is OpenCode alone, not with two terminals (onboarding.py).
FROM_PHONE = STATE / 'set-up-from-phone'
# A phone's Wi-Fi and sign-in, sent with the computer's password as it started (unlock/http): /run
# outlives the switch from its startup to the system, and nothing of it reaches the disk.
PHONE_SETUP = Path('/run/harness-os/phone-setup.json')
# How long the Wi-Fi card may take to appear in NetworkManager as the system starts.
DEVICE_WAIT = 30
HEADLESS = Path('/etc/harness-os/headless')
DRM = Path('/sys/class/drm')
USER = 'me'
HOME = Path('/home') / USER
SESSION = HOME / '.harness/auth/session.json'
COMPUTER_ID = HOME / '.harness/computer-id'
HOTSPOT = 'harness-setup'
ADDRESS = '10.42.0.1'
PORT = 80
PROTOCOL = 1
# Signed in with no screen: saved Wi-Fi gets this long to come back before the hotspot takes the radio.
OFFLINE_AT_START = 60
OFFLINE_LATER = 600
# With nobody on the hotspot, saved Wi-Fi is tried again this often, for this long.
RETRY_SAVED = 300
SAVED_JOIN = 45
JOIN = 45
INTERNET_WAIT = 30
# Refusals of the key before a join is called a wrong password, without waiting out JOIN.
WRONG_KEYS = 2
INTERNET = ('harness-api.autonomous.ai', 443)

MESSAGES = {
    'WRONG_PASSWORD': 'The password for "{ssid}" is not right. Passwords are case-sensitive.',
    'NOT_FOUND': '"{ssid}" is out of reach. Move the device closer to the router, or check the name.',
    'NO_ADDRESS': 'Joined "{ssid}", but the router gave no address. Restart the router and try again.',
    'TIMEOUT': 'Joining "{ssid}" took too long. Move the device closer to the router and try again.',
    'NO_INTERNET': 'Joined "{ssid}", but it does not reach the Internet. A sign-in page or a firewall may be in the way.',
    'NO_INTERNET_WIRED': 'This computer is on a cable, but it does not reach the Internet. Check the cable or choose a Wi-Fi.',
    'WIFI': 'Could not join "{ssid}". Try again.',
}


def load_network():
    spec = importlib.util.spec_from_file_location('harness_os_network', Path(__file__).with_name('network.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


network = load_network()
nmcli = network.nmcli


def log(message):
    # On stderr, the journal's as well: stdout is the answer the daemon reads (password, ssh).
    print(f'harness-setup: {message}', file=sys.stderr, flush=True)



def computer_id():
    for path in [COMPUTER_ID, Path('/etc/machine-id')]:
        try:
            value = path.read_text().strip()
            if value:
                return value
        except OSError:
            pass
    return ''


SIOCETHTOOL = 0x8946
ETHTOOL_GPERMADDR = 0x20


def permanent_mac(device):
    """The address burned into [device], not the one it shows now: NetworkManager gives a radio a
    random address while it scans, and the hotspot's name must be the same every time and on the
    label. ethtool's GPERMADDR, then the current address, then nothing."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            request = struct.pack('II', ETHTOOL_GPERMADDR, 32) + bytes(32)
            buffer = array.array('B', request)
            pointer = buffer.buffer_info()[0]
            ifreq = struct.pack('16sP', device.encode()[:15], pointer)
            fcntl.ioctl(sock.fileno(), SIOCETHTOOL, ifreq)
            size = struct.unpack_from('I', buffer, 4)[0]
            address = bytes(buffer[8:8 + size])
            if size == 6 and any(address):
                return ':'.join(f'{byte:02x}' for byte in address)
    except (OSError, ValueError, struct.error):
        pass
    try:
        return (Path('/sys/class/net') / device / 'address').read_text().strip()
    except OSError:
        return ''


def hotspot_name(device=None):
    """`Harness-` and the last four of the Wi-Fi card's own address: fixed for the computer however
    often it is flashed, so it can be printed on its label (the robots' own setup hotspots name
    themselves after their hardware the same way). The computer id without a Wi-Fi card."""
    device = device or wifi_device()
    source = permanent_mac(device) if device else ''
    if not source:
        source = computer_id()
    tail = ''.join(character for character in source if character.isalnum())[-4:].upper()
    return 'Harness-' + (tail or 'Setup')


def signed_in():
    return SESSION.is_file()


def rows(*args, wait=3):
    try:
        result = nmcli('-t', '-e', 'yes', *args, wait=wait)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [] if result.returncode else [network.fields(line) for line in result.stdout.splitlines()]


def wifi_device():
    return next((row[0] for row in rows('-f', 'DEVICE,TYPE', 'device', 'status') if len(row) == 2 and row[1] == 'wifi'), None)


def online():
    """A Wi-Fi or wired connection that is not the setup hotspot."""
    return any(len(row) == 2 and row[0] != HOTSPOT and row[1] in ('802-11-wireless', '802-3-ethernet')
               for row in rows('-f', 'NAME,TYPE', 'connection', 'show', '--active'))


def saved_wifi():
    return any(len(row) == 2 and row[0] != HOTSPOT and row[1] == '802-11-wireless'
               for row in rows('-f', 'NAME,TYPE', 'connection', 'show'))


def internet(wait=INTERNET_WAIT):
    deadline = time.monotonic() + wait
    while True:
        try:
            socket.create_connection(INTERNET, timeout=5).close()
            return True
        except OSError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(2)


def visible_networks(own):
    try:
        found = network.scan(rescan=True)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return []
    seen, networks = set(), []
    for row in found:
        if row['ssid'] == own or row['ssid'] in seen:
            continue
        seen.add(row['ssid'])
        security = row['security'] if row['security'] != '--' else ''
        networks.append(dict(ssid=row['ssid'], signal=row['signal'], security=security))
    return networks


def start_hotspot(device, name):
    nmcli('connection', 'delete', 'id', HOTSPOT)
    # Open: the person picks `Harness-XXXX` from a list and nothing more.
    created = nmcli('connection', 'add', 'type', 'wifi', 'ifname', device, 'con-name', HOTSPOT,
                    'connection.autoconnect', 'no', 'ssid', name, 'mode', 'ap',
                    # 2.4 GHz: every phone sees it, and it avoids radar channels a client cannot host.
                    '802-11-wireless.band', 'bg',
                    'ipv4.method', 'shared', 'ipv4.addresses', ADDRESS + '/24', 'ipv6.method', 'disabled')
    if created.returncode:
        log('could not create the hotspot: ' + created.stderr.strip())
        return False
    up = nmcli('connection', 'up', 'id', HOTSPOT, 'ifname', device, wait=30)
    if up.returncode:
        log('could not start the hotspot: ' + up.stderr.strip())
        nmcli('connection', 'delete', 'id', HOTSPOT)
        return False
    return True


def stop_hotspot():
    nmcli('connection', 'down', 'id', HOTSPOT)
    nmcli('connection', 'delete', 'id', HOTSPOT)


def phones_on(device):
    """Whether a phone is joined to the hotspot; unknown counts as yes, so nobody is cut off."""
    try:
        result = subprocess.run(['/usr/bin/iw', 'dev', device, 'station', 'dump'],
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return True
    return result.returncode != 0 or 'Station ' in result.stdout


def read_result():
    try:
        return json.loads(RESULT.read_text())
    except (OSError, ValueError):
        return {}


def write_result(**fields):
    STATE.mkdir(parents=True, exist_ok=True)
    fields['at'] = int(time.time())
    partial = RESULT.with_name(RESULT.name + '.partial')
    partial.write_text(json.dumps(fields) + '\n')
    partial.replace(RESULT)


def reason(output):
    """NetworkManager's activation failure, as one of MESSAGES."""
    text = output.lower()
    if 'secrets were required' in text or 'no-secrets' in text:
        return 'WRONG_PASSWORD'
    if 'could not be found' in text or 'no network with ssid' in text:
        return 'NOT_FOUND'
    if 'ip configuration' in text or 'dhcp' in text:
        return 'NO_ADDRESS'
    if 'timeout' in text or 'timed out' in text:
        return 'TIMEOUT'
    return 'WIFI'


def wrong_keys(since):
    """How many times the router refused the key since [since], by wpa_supplicant's own words."""
    try:
        result = subprocess.run(['/usr/bin/journalctl', '-t', 'wpa_supplicant', '-o', 'cat', '--no-pager',
                                 '--since', f'@{int(since)}'], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return 0
    # One `CTRL-EVENT-SSID-TEMP-DISABLED … reason=WRONG_KEY` per refusal.
    return result.stdout.count('reason=WRONG_KEY')


def connect(ssid, password, security, device):
    """Join one Wi-Fi with a new profile, kept only when it works. None, or the reason it failed."""
    identity = str(uuid.uuid4())
    arguments = ['connection', 'add', 'type', 'wifi', 'ifname', device, 'con-name', ssid,
                 'connection.uuid', identity, 'connection.autoconnect', 'no', 'ssid', ssid]
    if security:
        key = 'sae' if 'WPA3' in security and 'WPA2' not in security else 'wpa-psk'
        arguments += ['wifi-sec.key-mgmt', key, 'wifi-sec.psk-flags', '0']
    # A network missing from the scan may be hidden: ask for it by name.
    arguments += ['802-11-wireless.hidden', 'yes']
    created = nmcli(*arguments)
    if created.returncode:
        return 'WIFI'
    kept = False
    try:
        arguments = ['connection', 'up', 'uuid', identity, 'ifname', device]
        secret = None
        if security:
            arguments += ['passwd-file', '/dev/stdin']
            secret = '802-11-wireless-security.psk:' + password + '\n'
        # A wrong password does not fail NetworkManager: it hands the same key over again and again
        # until the wait runs out, and then says only "Timeout". wpa_supplicant says it at once
        # (WRONG_KEY): watched beside the attempt, two of those end it early.
        started = time.time()
        attempt = {}

        def up():
            try:
                attempt['result'] = nmcli(*arguments, secret=secret, wait=JOIN)
            except subprocess.TimeoutExpired:
                attempt['result'] = None

        worker = threading.Thread(target=up, daemon=True)
        worker.start()
        wrong = 0
        while worker.is_alive():
            worker.join(2)
            wrong = wrong_keys(started)
            if worker.is_alive() and wrong >= WRONG_KEYS:
                nmcli('connection', 'down', 'uuid', identity)
                worker.join(10)
                break
        if wrong >= WRONG_KEYS or (wrong and attempt.get('result') is None):
            return 'WRONG_PASSWORD'
        result = attempt.get('result')
        if result is None:
            return 'TIMEOUT'
        if result.returncode:
            log('NetworkManager: ' + (result.stderr or result.stdout).strip()[-300:])
            return 'WRONG_PASSWORD' if wrong_keys(started) else reason(result.stderr + result.stdout)
        if nmcli('connection', 'modify', 'uuid', identity, 'connection.autoconnect', 'yes').returncode:
            return 'WIFI'
        kept = True
        # An older profile for the same Wi-Fi holds the old password: it would win the next reconnect.
        for row in rows('-f', 'UUID,TYPE', 'connection', 'show'):
            if len(row) == 2 and row[0] != identity and row[1] == '802-11-wireless':
                named = nmcli('-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', row[0])
                if named.returncode == 0 and named.stdout.rstrip('\n') == ssid:
                    nmcli('connection', 'delete', 'uuid', row[0])
        return None
    finally:
        if not kept:
            nmcli('connection', 'down', 'uuid', identity)
            nmcli('connection', 'delete', 'uuid', identity)


def forget(ssid):
    """The profile this attempt saved, when it reached the Wi-Fi but not the Internet."""
    saved = network.saved_connection(dict(ssid=ssid))
    if saved:
        nmcli('connection', 'delete', 'uuid', saved)


def sign_in(ticket):
    if signed_in():
        return True, ''
    # Before the sign-in, not after: the screen's hn opens its first workspace the moment the
    # account is there, and reads this to open OpenCode alone (onboarding.py).
    try:
        FROM_PHONE.touch()
    except OSError:
        pass
    ok, message = run_sign_in(ticket)
    if not ok:
        FROM_PHONE.unlink(missing_ok=True)
        return ok, message
    # Online in the account only with its daemon running, and nobody may ever sign in at a screen
    # to start a session (one with no encryption asks for its password there first): started here.
    as_user('systemctl', '--user', 'start', 'harness-daemon', timeout=150)
    return ok, message


def run_sign_in(ticket):
    try:
        result = subprocess.run(['/usr/bin/runuser', '-u', USER, '--', '/usr/bin/harness', 'login', '--json',
                                 '--ticket=' + ticket],
                                capture_output=True, text=True, timeout=90,
                                env=dict(HOME=str(HOME), USER=USER, LOGNAME=USER,
                                         PATH='/usr/local/bin:/usr/bin:/bin',
                                         XDG_RUNTIME_DIR=f'/run/user/{pwd.getpwnam(USER).pw_uid}'))
    except (OSError, KeyError, subprocess.TimeoutExpired) as error:
        return False, str(error)
    if result.returncode == 0:
        return True, ''
    message = ''
    for line in result.stdout.splitlines():
        try:
            message = json.loads(line).get('message') or message
        except (ValueError, AttributeError):
            pass
    return False, message or result.stderr.strip()[-200:] or 'The sign-in failed.'


def join(request, networks, device):
    """Leave the hotspot for the person's Wi-Fi, or with no Wi-Fi named (on a cable), only sign in.
    Returns the result the phone reads."""
    ssid, password, ticket = request.get('ssid') or '', request.get('password') or '', request.get('ticket')
    started = time.monotonic()
    if not ssid:
        log('signing in on the cable')
        failed = None if internet() else 'NO_INTERNET_WIRED'
    else:
        seen = next((row for row in networks if row['ssid'] == ssid), None)
        security = seen['security'] if seen else ('WPA2' if password else '')
        log(f'joining "{ssid}"')
        failed = connect(ssid, password, security, device)
        if not failed and not internet():
            forget(ssid)
            failed = 'NO_INTERNET'
    if failed:
        log(f'"{ssid}" failed after {int(time.monotonic() - started)}s: {failed}')
        return dict(state='failed', error=failed, ssid=ssid, message=MESSAGES[failed].format(ssid=ssid))
    if ticket:
        ok, message = sign_in(ticket)
        if not ok:
            log('sign-in failed: ' + message)
            return dict(state='done', ssid=ssid, signedIn=False, error='SIGN_IN', message=message)
    log(f'on "{ssid}" after {int(time.monotonic() - started)}s')
    return dict(state='done', ssid=ssid, signedIn=signed_in())


def check_request(body, wired=False):
    """[wired]: on a cable already, so a ticket alone signs in without a Wi-Fi."""
    if not isinstance(body, dict):
        return 'Send a JSON object.'
    ssid, password, ticket = body.get('ssid'), body.get('password'), body.get('ticket')
    if wired and ssid in (None, '') and not password:
        if not ticket:
            return 'Sign in from the phone to set this computer up.'
    elif not isinstance(ssid, str) or not ssid or len(ssid.encode()) > 32:
        return 'Choose a Wi-Fi network.'
    if password not in (None, ''):
        if not isinstance(password, str) or '\n' in password or '\r' in password:
            return 'That Wi-Fi password cannot be used.'
        if not 8 <= len(password) <= 63:
            return 'A Wi-Fi password has 8 to 63 characters.'
    if ticket is not None and (not isinstance(ticket, str) or not ticket.isprintable() or len(ticket) > 256):
        return 'That sign-in ticket cannot be used.'
    return None


class Setup:
    """One stay on the hotspot: the page answering, until the phone sends a Wi-Fi."""

    def __init__(self, name, networks, run):
        self.name, self.networks, self.run = name, networks, run
        self.requests = queue.Queue()

    def info(self):
        # online: on a cable beside the hotspot (the radio hosts it), so the phone skips the Wi-Fi.
        return dict(protocol=PROTOCOL, name=socket.gethostname(), hotspot=self.name, run=self.run,
                    computerId=computer_id(), signedIn=signed_in(), online=online(), result=read_result())

    def handler(self):
        setup = self

        class Handler(http.server.BaseHTTPRequestHandler):
            server_version = 'HarnessSetup/1'

            def log_message(self, format, *args):
                pass

            def reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == '/setup':
                    return self.reply(200, setup.info())
                if self.path == '/setup/networks':
                    return self.reply(200, dict(networks=setup.networks))
                self.reply(404, dict(error='NOT_FOUND'))

            def do_POST(self):
                if self.path != '/setup/connect':
                    return self.reply(404, dict(error='NOT_FOUND'))
                try:
                    length = int(self.headers.get('Content-Length') or 0)
                    body = json.loads(self.rfile.read(min(length, 16384)) or b'{}')
                except ValueError:
                    return self.reply(400, dict(error='BAD_REQUEST', message='Send a JSON object.'))
                problem = check_request(body, wired=online())
                if problem:
                    return self.reply(400, dict(error='BAD_REQUEST', message=problem))
                if not setup.requests.empty():
                    return self.reply(409, dict(error='BUSY', message='Already joining a Wi-Fi.'))
                self.reply(202, dict(state='connecting', run=setup.run + 1))
                setup.requests.put(body)

        return Handler


def serve(setup):
    server = http.server.ThreadingHTTPServer((ADDRESS, PORT), setup.handler())
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def saved_comes_back(device):
    """Off the hotspot for a moment, each saved Wi-Fi tried in turn. `device connect` cannot do it:
    with no access point named, NetworkManager refuses ("A 'wireless' setting is required")."""
    # A device someone disconnected is barred from joining by itself until allowed again.
    nmcli('device', 'set', device, 'autoconnect', 'yes')
    for row in rows('-f', 'UUID,TYPE,NAME', 'connection', 'show'):
        if len(row) != 3 or row[1] != '802-11-wireless' or row[2] == HOTSPOT:
            continue
        try:
            nmcli('connection', 'up', 'uuid', row[0], 'ifname', device, wait=SAVED_JOIN)
        except subprocess.TimeoutExpired:
            pass
        if online():
            return True
    return False


def setup_mode(device, asked=False):
    """Hotspot until the phone sends a Wi-Fi that works (or, on a cable, signs the computer in), the
    computer is signed in at its screen, or someone at the screen opens its Wi-Fi page.

    Signed in, the computer lost its network (a router that was off): saved Wi-Fi is tried again,
    and a cable plugged in ends it. One not signed in still needs the phone, and one [asked] for
    setup by hand was taken off its Wi-Fi on purpose: both keep the hotspot until somebody uses it."""
    was_signed_in = signed_in()
    may_leave = not asked and was_signed_in
    name = hotspot_name(device)
    # Scanned before the radio becomes the hotspot: it cannot scan while hosting one.
    networks = visible_networks(name)
    while True:
        if screen_here():
            return False
        if not start_hotspot(device, name):
            return False
        run = int(read_result().get('run') or 0)
        log(f'hotspot "{name}" is up with {len(networks)} networks to offer')
        setup = Setup(name, networks, run)
        try:
            server = serve(setup)
        except OSError as error:
            log(f'could not answer on {ADDRESS}:{PORT}: {error}')
            stop_hotspot()
            return False
        request, idle_since, left = None, time.monotonic(), None
        while request is None:
            try:
                request = setup.requests.get(timeout=5)
            except queue.Empty:
                # Someone typed this computer's password at its screen and opened its Wi-Fi page
                # (network.py): the radio is theirs while it is open.
                if screen_here():
                    left = 'screen'
                    break
                # Signed in meanwhile at the screen (on a cable): nothing left to set up.
                if not was_signed_in and signed_in():
                    left = 'signed in'
                    break
                if not hotspot_up():
                    left = 'gone'
                    break
                # Signed in, online another way meanwhile (a cable plugged in): the hotspot has no
                # use. Not signed in, it stays for the phone, which signs in over that cable.
                if may_leave and online():
                    left = 'online'
                    break
                if phones_on(device):
                    idle_since = time.monotonic()
                elif may_leave and time.monotonic() - idle_since >= RETRY_SAVED and saved_wifi():
                    break
        if request is not None:
            run += 1
            write_result(state='connecting', ssid=request.get('ssid') or '', run=run)
            # Let the phone read its answer before the hotspot goes.
            time.sleep(2)
        server.shutdown()
        server.server_close()
        stop_hotspot()
        if left in ('signed in', 'online'):
            log(f'{left}; the hotspot goes')
            return True
        if left == 'screen':
            log('the screen took the radio for its Wi-Fi page')
            return online()
        if left == 'gone':
            # Taken down by something else: back up, unless that brought the network.
            if online() or wait_online(SAVED_JOIN):
                return True
            continue
        if request is None:
            log('nobody is on the hotspot; trying saved Wi-Fi')
            if saved_comes_back(device):
                log('saved Wi-Fi is back')
                return True
            networks = visible_networks(name) or networks
            continue
        result = join(request, networks, device)
        write_result(run=run, **result)
        if result['state'] == 'done':
            return True
        # Back to the hotspot with the reason; the list may have changed meanwhile.
        networks = visible_networks(name) or networks


def hotspot_up():
    return any(len(row) == 1 and row[0] == HOTSPOT for row in rows('-f', 'NAME', 'connection', 'show', '--active'))


def wait_online(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if online():
            return True
        time.sleep(3)
    return online()


def screen_here():
    """Whether someone at the screen holds the radio (network.py SETUP_SCREEN): they typed this
    computer's password there and opened its Wi-Fi page. Held until the computer is signed in, so
    the hotspot does not take the Wi-Fi chosen there while they sign in at the screen; the page
    lets it go when left alone a while, for a phone."""
    if not SCREEN.exists():
        return False
    if signed_in():
        SCREEN.unlink(missing_ok=True)
        return False
    return True


def asked_now():
    try:
        NOW.unlink()
        return True
    except OSError:
        return False


def headless():
    """No screen to set Wi-Fi on: marked so (a device, or a laptop standing in for one), or no
    display connected. A computer with a screen keeps its own Wi-Fi page and never loses its radio
    to the hotspot unless someone asks (`setup.py now`)."""
    if HEADLESS.exists():
        return True
    return not any(status.read_text().strip() == 'connected'
                   for status in DRM.glob('card*-*/status') if status.is_file())


def hotspot_wait(now, started):
    """How long this computer must stay as it is now before its hotspot opens; None: not now.

    Not signed in (just installed, reset or signed out), screen or not, network or not: at once,
    for setup from a phone; on Wi-Fi it leaves it for the hotspot. Not while someone at the screen
    has its Wi-Fi page open. Signed in: only offline, and only a computer with no screen, after a
    long outage (a new router); one with a screen keeps its Wi-Fi page, as a laptop away from its
    network should."""
    if screen_here():
        return None
    if not signed_in():
        return 0
    if online() or not headless():
        return None
    return OFFLINE_AT_START if now - started < OFFLINE_AT_START + 5 else OFFLINE_LATER


def signed_in_account():
    """The account this computer is signed in to: the session's `signInAcct` (cli recordSignInAccount)."""
    try:
        return json.loads(SESSION.read_text()).get('signInAcct')
    except (OSError, ValueError, AttributeError):
        return None


def set_up_as_unlocked():
    """The rest of a phone's setup, sent with the computer's password while its disk was locked
    (unlock/http, protocol 2): the Wi-Fi, its password, the sign-in ticket and the phone's account.
    Joined and signed in as the system starts — the phone never comes back to a second hotspot. Every
    time, set up before or not: the Wi-Fi given is joined, and an account other than the phone's is
    signed out for it. One that fails leaves its reason for the hotspot that follows (watch)."""
    try:
        request = json.loads(PHONE_SETUP.read_text())
    except (OSError, ValueError):
        return
    finally:
        PHONE_SETUP.unlink(missing_ok=True)
    run = int(read_result().get('run') or 0) + 1
    # The radio comes up a moment after NetworkManager.
    deadline = time.monotonic() + DEVICE_WAIT
    while not (device := wifi_device()) and time.monotonic() < deadline:
        time.sleep(1)
    ssid = request.get('ssid') if isinstance(request, dict) else None
    problem = check_request(request, wired=not ssid and online())
    if problem:
        log('the phone\'s setup at the unlock: ' + problem)
        write_result(run=run, state='failed', error='BAD_REQUEST', message=problem)
        return
    if ssid and not device:
        write_result(run=run, state='failed', error='WIFI', ssid=ssid, message='This computer has no Wi-Fi.')
        return
    account = request.get('account')
    if signed_in() and isinstance(account, str) and account and account != signed_in_account():
        # The phone's account, in place of the one it was signed in to: a sign-out, then its sign-in.
        log('signed in to another account than the phone\'s: signing out')
        as_user('/usr/bin/harness', 'logout', timeout=60)
    security = request.get('security')
    networks = [dict(ssid=ssid, security=security)] if ssid and isinstance(security, str) else []
    log('setting up as the phone asked at the unlock')
    write_result(run=run, **join(request, networks, device))


def watch():
    started, waiting_since = time.monotonic(), None
    while True:
        now = time.monotonic()
        forced = asked_now()
        wait = 0 if forced else hotspot_wait(now, started)
        if wait is None:
            waiting_since = None
        else:
            waiting_since = waiting_since or now
            device = wifi_device()
            if device and now - waiting_since >= wait:
                if forced:
                    # Asked for by hand: leave the current Wi-Fi so the radio can host the hotspot.
                    nmcli('device', 'disconnect', device)
                setup_mode(device, asked=forced)
                waiting_since = None
        time.sleep(5)


def active_wifi(device):
    """The saved profile this computer is on now, to come back to when a new Wi-Fi fails."""
    for row in rows('-f', 'UUID,TYPE,DEVICE', 'connection', 'show', '--active'):
        if len(row) == 3 and row[1] == '802-11-wireless' and row[2] == device:
            return row[0]
    return None


def change(request):
    """The phone asked, through the daemon while online (`os_device` `wifi_join`), for another Wi-Fi.
    Joined like setup's, but a failure goes back to the Wi-Fi it was on, so a wrong password from far
    away does not leave the computer off the network. The result is kept for the phone to read once
    the computer is back (`wifi_result`)."""
    problem = check_request(request)
    run = int(read_result().get('run') or 0) + 1
    if problem:
        write_result(run=run, state='failed', error='BAD_REQUEST', message=problem)
        return
    device = wifi_device()
    if not device:
        write_result(run=run, state='failed', error='WIFI', message='This computer has no Wi-Fi.')
        return
    ssid = request['ssid']
    write_result(run=run, state='connecting', ssid=ssid)
    before = active_wifi(device)
    networks = visible_networks(hotspot_name(device))
    result = join(dict(ssid=ssid, password=request.get('password') or ''), networks, device)
    if result['state'] != 'done' and before:
        # Back where it was: the phone reaches it again there and reads why.
        try:
            nmcli('connection', 'up', 'uuid', before, 'ifname', device, wait=SAVED_JOIN)
        except subprocess.TimeoutExpired:
            pass
        result['restored'] = online()
    write_result(run=run, **result)


HN = '/usr/lib/harness/harness-tui'
# The account's daemon on this computer (cli hookServer), for the desk.
DAEMON = 'http://127.0.0.1:18473'
RESET_UNIT = 'harness-factory-reset'
SIGN_OUT_UNIT = 'harness-sign-out'
# The password as installed (installer.py INITIAL_ACCOUNT): root's, inside the encrypted disk.
INITIAL_ACCOUNT = STATE / 'initial-account.json'
CMDLINE = Path('/proc/cmdline')
SSHD = 'sshd.service'
# The GitHub CLI and its package (packages.x86_64), put back by install-gh: a download of some 15 MB, each
# of its two tries bounded so both fit the daemon's wait (cli services/osDevice.ts GH_INSTALL_TIMEOUT_MS).
GH = Path('/usr/bin/gh')
GH_PACKAGE = 'github-cli'
GH_INSTALL_TIMEOUT = 120
# A phone sets this computer up next (network.py UNLOCKED_BY_PHONE): the screen's Wi-Fi page keeps
# off the radio the hotspot needs, until a key there.
PHONE_SETS_UP = Path('/run/harness-os/unlocked-by-phone')


def as_user(*command, timeout=30):
    """A command as the person, in their session: their hn, their daemon, their systemd units."""
    uid = pwd.getpwnam(USER).pw_uid
    runtime = f'/run/user/{uid}'
    try:
        return subprocess.run(['/usr/bin/runuser', '-u', USER, '--', *command], capture_output=True, text=True,
                              timeout=timeout, env=dict(HOME=str(HOME), USER=USER, LOGNAME=USER,
                                                        PATH='/usr/local/bin:/usr/bin:/bin', XDG_RUNTIME_DIR=runtime,
                                                        DBUS_SESSION_BUS_ADDRESS=f'unix:path={runtime}/bus'))
    except (OSError, subprocess.TimeoutExpired):
        return None


def wipe(folder, keep):
    """Everything in [folder] but the [keep] names; a kept name may be a folder wiped in turn."""
    for path in folder.iterdir() if folder.is_dir() else []:
        if path.name in keep:
            if isinstance(keep[path.name], dict):
                wipe(path, keep[path.name])
            continue
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


def desk_ops(ops=None):
    """The account's desk through the local daemon (its /api/desk proxy, signed in as this computer):
    read it, or with [ops] write them. The answer's tabs, or None."""
    request = urllib.request.Request(DAEMON + ('/api/desk/ops' if ops else '/api/desk'),
                                     data=json.dumps({'ops': ops}).encode() if ops else None,
                                     headers={'Content-Type': 'application/json', 'X-Adapter-Local': '1'},
                                     method='POST' if ops else 'GET')
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read())
    except (OSError, ValueError):
        return None
    body = body.get('data', body) if isinstance(body, dict) else None
    return body.get('tabs') if isinstance(body, dict) and isinstance(body.get('tabs'), list) else None


def forget_desk():
    """This computer's tabs and panes off the account's desk, which every computer shows: closing its
    windows alone was raced by the sign-out, and they came back at the next sign-in. A tab of its own
    goes; one shared with other computers keeps theirs."""
    machine = this_machine()
    tabs = desk_ops() if machine else None
    ops = []
    for tab in tabs or []:
        panes = [pane for pane in tab.get('panes') or [] if isinstance(pane, dict)]
        mine = [pane for pane in panes if pane.get('machineId') == machine]
        if mine and len(mine) == len(panes):
            ops.append({'op': 'tab.close', 'id': tab.get('id')})
        else:
            ops += [{'op': 'pane.remove', 'tabId': tab.get('id'), 'machineId': machine,
                     'agentId': pane.get('agentId')} for pane in mine]
    if ops and desk_ops(ops) is None:
        log('factory reset: the desk kept some tabs of this computer')


def this_machine():
    """This computer's machine in its account, while signed in."""
    status = as_user('/usr/bin/harness', 'auth', 'status', '--json')
    try:
        return json.loads(status.stdout).get('machineId') if status else None
    except ValueError:
        return None


def remove_from_account():
    """This computer off its account (the local daemon's DELETE /api/machines/<id>, as a phone's
    Remove from account), before it starts again as a new computer: none left behind there, offline."""
    machine = this_machine()
    if not machine:
        return
    request = urllib.request.Request(DAEMON + '/api/machines/' + urllib.parse.quote(machine, safe=''),
                                     headers={'X-Adapter-Local': '1'}, method='DELETE')
    try:
        with urllib.request.urlopen(request, timeout=20):
            log('removed from its account')
    except (OSError, ValueError) as error:
        log(f'factory reset: could not remove this computer from its account ({error})')


def forget_wifi():
    for row in rows('-f', 'UUID,TYPE', 'connection', 'show'):
        if len(row) == 2 and row[1] == '802-11-wireless':
            nmcli('connection', 'delete', 'uuid', row[0])


def open_hotspot():
    """The watcher opens the hotspot for a phone at once (headless or not: asked for), and the screen's
    Wi-Fi page, opening as the computer goes offline, leaves the radio to it until a key there."""
    NOW.parent.mkdir(parents=True, exist_ok=True)
    NOW.touch()
    PHONE_SETS_UP.touch()


def sign_out(keep_wifi=False):
    """Signed out for another account (a phone's Sign out): this computer forgets its Wi-Fi and opens
    its hotspot to be set up again — a phone on the other account sets it up as before. Its harnesses,
    projects and everything else of the person stay, as a sign-out and a sign-in at the screen keep them."""
    log('signing out; the harnesses and projects stay')
    as_user('/usr/bin/harness', 'logout', timeout=60)
    FROM_PHONE.unlink(missing_ok=True)
    if not keep_wifi:
        forget_wifi()
    open_hotspot()
    log('signed out')


def luks_device():
    """The encrypted disk this computer starts from (installer.py: rd.luks.name=<uuid>=cryptroot), or None."""
    match = re.search(r'(?:^|\s)rd\.luks\.name=([0-9A-Fa-f-]+)=', CMDLINE.read_text())
    return Path('/dev/disk/by-uuid') / match[1] if match else None


def opens_disk(device, secret):
    return subprocess.run(['cryptsetup', 'open', '--test-passphrase', '--key-file=-', str(device)],
                          input=secret.encode(), capture_output=True, timeout=120).returncode == 0


def opens_account(secret):
    """[secret] is the account's password, as its shadow entry hashes it (libxcrypt's crypt)."""
    shadow = next((line.split(':')[1] for line in Path('/etc/shadow').read_text().splitlines()
                   if line.split(':', 1)[0] == USER), '')
    if not shadow or shadow[0] in '!*':
        return False
    libcrypt = ctypes.CDLL(ctypes.util.find_library('crypt'))
    libcrypt.crypt.restype, libcrypt.crypt.argtypes = ctypes.c_char_p, [ctypes.c_char_p, ctypes.c_char_p]
    result = libcrypt.crypt(secret.encode(), shadow.encode())
    return result is not None and hmac.compare_digest(result, shadow.encode())


def replace_disk_key(device, old, new):
    """[new] among the disk's passphrases in place of [old]: added with [old], then [old] removed. The
    two only in /run, root's, for the moment cryptsetup reads them."""
    folder = Path(tempfile.mkdtemp(prefix='harness-key-', dir='/run'))
    try:
        old_file, new_file = folder / 'old', folder / 'new'
        old_file.write_bytes(old.encode())
        new_file.write_bytes(new.encode())
        subprocess.run(['cryptsetup', 'luksAddKey', '--batch-mode', '--key-file', str(old_file), str(device), str(new_file)],
                       check=True, capture_output=True, timeout=180)
        subprocess.run(['cryptsetup', 'luksRemoveKey', '--batch-mode', str(device), str(old_file)],
                       check=True, capture_output=True, timeout=180)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def account_record():
    try:
        record = json.loads(INITIAL_ACCOUNT.read_text())
    except (OSError, ValueError):
        return {}
    return record if isinstance(record, dict) else {}


def save_account_record(record):
    INITIAL_ACCOUNT.parent.mkdir(parents=True, exist_ok=True)
    partial = INITIAL_ACCOUNT.with_name(INITIAL_ACCOUNT.name + '.partial')
    partial.write_text(json.dumps(record) + '\n')
    partial.chmod(0o600)
    partial.replace(INITIAL_ACCOUNT)


def change_password(request):
    """From a phone (the daemon, through sudo; JSON on stdin): the computer's one password changed —
    the disk's, asked at every start where it is encrypted, and the account's (SSH, sudo, the lock
    screen) together, as the installer set them. The current one first, as the disk checks it."""
    current = request.get('current') if isinstance(request, dict) else None
    new = request.get('new') if isinstance(request, dict) else None
    if not isinstance(current, str) or not isinstance(new, str) or not new:
        return {'error': 'BAD_REQUEST', 'message': 'Enter the current password and a new one.'}
    if any(c in new for c in '\n\r\0') or len(new.encode()) > 512:
        return {'error': 'BAD_REQUEST', 'message': 'That password cannot be used.'}
    if new == current:
        return {'error': 'SAME', 'message': 'That is the password already.'}
    device = luks_device()
    if not (opens_disk(device, current) if device else opens_account(current)):
        return {'error': 'WRONG_PASSWORD', 'message': 'That is not the computer\'s password.'}
    if device:
        replace_disk_key(device, current, new)
        record = account_record()
        record['current'] = new
        save_account_record(record)
    subprocess.run(['chpasswd'], input=f'{USER}:{new}\n'.encode(), check=True, capture_output=True, timeout=60)
    log('the computer\'s password changed' + (', the disk\'s with it' if device else ''))
    return {'ok': True, 'disk': device is not None}


def restore_initial_password():
    """The password as installed (installer.py save_initial_password), account and disk. A computer
    installed before it was kept, or whose disk password changed outside a phone, keeps what it has."""
    record = account_record()
    if record.get('shadow'):
        subprocess.run(['usermod', '-p', record['shadow'], USER], capture_output=True, timeout=60)
    else:
        log('factory reset: no password from the installation; the current one stays')
    device, initial, current = luks_device(), record.get('initial'), record.get('current')
    if not device or not initial or current == initial:
        return
    if current and opens_disk(device, current):
        replace_disk_key(device, current, initial)
        record['current'] = initial
        save_account_record(record)
        log('factory reset: the disk password is the installation\'s again')
    elif not opens_disk(device, initial):
        log('factory reset: the disk password changed outside a phone; it stays')


def ssh(action='status'):
    """SSH for this computer's network, off as installed: on, off, or how it is, with the addresses
    it answers on (the private ones, for `ssh me@<address>`)."""
    if action in ('on', 'off'):
        subprocess.run(['systemctl', 'enable' if action == 'on' else 'disable', '--now', SSHD],
                       capture_output=True, timeout=60)
    def state(verb):
        return subprocess.run(['systemctl', verb, SSHD], capture_output=True, text=True, timeout=15).stdout.strip()
    try:
        links = json.loads(subprocess.run(['ip', '-4', '-j', 'addr', 'show', 'scope', 'global'],
                                          capture_output=True, text=True, timeout=15).stdout or '[]')
    except ValueError:
        links = []
    addresses = [{'interface': link.get('ifname'), 'address': info.get('local')}
                 for link in links if isinstance(link, dict) and link.get('ifname') != HOTSPOT
                 for info in link.get('addr_info') or [] if info.get('local') and info.get('local') != ADDRESS]
    return {'enabled': state('is-enabled') == 'enabled', 'active': state('is-active') == 'active',
            'user': USER, 'addresses': addresses}


def install_gh():
    """The GitHub CLI put back where it is gone: the package the image installs (packages.x86_64), from this
    computer's own pinned repositories, for the phone's Sign in to GitHub (cli services/osDevice.ts).
    Nothing else: no package named by the caller, no upgrade of anything installed."""
    if GH.exists():
        return {'installed': True}
    log('installing the GitHub CLI')
    # Its package databases first as they are, then refreshed: the repositories are one dated snapshot
    # (/etc/pacman.conf), so a refresh reads the same packages the computer was installed from.
    for refresh in ([], ['-y']):
        done = subprocess.run(['pacman', '-S', *refresh, '--needed', '--noconfirm', GH_PACKAGE],
                              capture_output=True, text=True, timeout=GH_INSTALL_TIMEOUT)
        if done.returncode == 0 and GH.exists():
            log('installed the GitHub CLI')
            return {'installed': True}
    reason = (done.stderr.strip() or done.stdout.strip()).splitlines()[-1:] or ['pacman failed']
    log(f'the GitHub CLI did not install: {reason[0]}')
    return {'installed': False, 'message': 'The GitHub CLI could not be installed: ' + reason[0][:200]}


def factory_reset(keep_wifi=False, keep_ssh=False):
    """This computer as just installed: off its account and a new computer to it (a new computer id and
    device key), everything of the person gone — /home/me as the installer made it, so its projects,
    the engines' sign-ins and the hn/CLI updates it downloaded too — its Wi-Fi forgotten, SSH off, the
    password as installed, and its setup hotspot open for a phone. The installed Harness OS stays.
    For `harness factory-reset` at the computer (and, later, its reset button). [keep_wifi], [keep_ssh]:
    for a test machine reached over them."""
    log('factory reset: everything of the person goes')
    # While signed in and its daemon up: off the account, then signed out.
    forget_desk()
    remove_from_account()
    as_user('/usr/bin/harness', 'logout', timeout=60)
    account = pwd.getpwnam(USER)
    # Every process of the person: the screen's session, the daemon, hn, tmux and its harnesses.
    subprocess.run(['loginctl', 'terminate-user', USER], capture_output=True, timeout=60)
    subprocess.run(['systemctl', 'stop', f'user@{account.pw_uid}.service'], capture_output=True, timeout=120)
    subprocess.run(['pkill', '-KILL', '-u', USER], capture_output=True)
    time.sleep(1)
    shutil.rmtree(f'/tmp/hn-{account.pw_uid}', ignore_errors=True)
    # Home as the installer made it: the skeleton and an empty ~/projects.
    wipe(HOME, {})
    subprocess.run(['cp', '-a', '/etc/skel/.', str(HOME)], check=True, timeout=120)
    (HOME / 'projects').mkdir(exist_ok=True)
    subprocess.run(['chown', '-R', f'{account.pw_uid}:{account.pw_gid}', str(HOME)], check=True, timeout=120)
    HOME.chmod(0o700)
    for path in (RESULT, FROM_PHONE, SCREEN):
        path.unlink(missing_ok=True)
    restore_initial_password()
    if not keep_ssh:
        subprocess.run(['systemctl', 'disable', '--now', SSHD], capture_output=True, timeout=60)
    if not keep_wifi:
        forget_wifi()
    # Started again as at boot: the person's daemon (lingering), and the screen's first use.
    subprocess.run(['systemctl', 'start', f'user@{account.pw_uid}.service'], capture_output=True, timeout=120)
    subprocess.run(['systemctl', 'restart', 'getty@tty1.service'], capture_output=True, timeout=60)
    open_hotspot()
    log('factory reset done')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('command', nargs='?', choices=['watch', 'now', 'name', 'join', 'reset', 'sign-out',
                                                       'password', 'ssh', 'install-gh'], default='watch')
    parser.add_argument('action', nargs='?', choices=['status', 'on', 'off'], help='ssh: status, on or off')
    parser.add_argument('--keep-wifi', action='store_true', help='reset, sign-out: keep the saved Wi-Fi')
    parser.add_argument('--keep-ssh', action='store_true', help='reset: leave SSH as it is')
    parser.add_argument('--here', action='store_true', help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if arguments.command in ('reset', 'sign-out'):
        reset = arguments.command == 'reset'
        if arguments.here:
            if reset:
                factory_reset(keep_wifi=arguments.keep_wifi, keep_ssh=arguments.keep_ssh)
            else:
                sign_out(keep_wifi=arguments.keep_wifi)
            return
        # In a unit of its own: the computer leaves its Wi-Fi, and whatever asked (an SSH session, the
        # daemon for a phone) may go with it before it is done. `journalctl -u harness-factory-reset`.
        command = ['/usr/bin/systemd-run', f'--unit={RESET_UNIT if reset else SIGN_OUT_UNIT}', '--collect', '--quiet',
                   '/usr/bin/python3', str(Path(__file__).resolve()), arguments.command, '--here']
        if arguments.keep_wifi:
            command.append('--keep-wifi')
        if arguments.keep_ssh:
            command.append('--keep-ssh')
        started = subprocess.run(command, capture_output=True, text=True)
        if started.returncode:
            raise SystemExit('Could not start: ' + (started.stderr.strip() or 'systemd-run failed'))
        if reset:
            print('Resetting this computer to as it was installed: it leaves its account, and everything in '
                  '/home/me goes — projects, sign-ins, harnesses, settings'
                  + ('' if arguments.keep_wifi else '; its Wi-Fi is forgotten')
                  + '. Its password is the installation\'s again, and its setup hotspot opens for a phone '
                  'in about a minute.')
        else:
            print('Signing out. Its harnesses and projects stay; it opens its setup hotspot to be set up again.')
        return
    if arguments.command == 'password':
        # From the daemon, through sudo: both passwords as JSON on stdin, never in argv; the answer on stdout.
        try:
            request = json.loads(sys.stdin.read(4096) or '{}')
        except ValueError:
            request = None
        try:
            print(json.dumps(change_password(request)))
        except (OSError, subprocess.SubprocessError) as error:
            log(f'the password did not change: {error}')
            print(json.dumps({'error': 'FAILED', 'message': 'The password could not be changed. Try again.'}))
        return
    if arguments.command == 'ssh':
        print(json.dumps(ssh(arguments.action or 'status')))
        return
    if arguments.command == 'install-gh':
        try:
            print(json.dumps(install_gh()))
        except (OSError, subprocess.SubprocessError) as error:
            log(f'the GitHub CLI did not install: {error}')
            print(json.dumps({'installed': False, 'message': 'The GitHub CLI could not be installed. Try again.'}))
        return
    if arguments.command == 'join':
        # From the daemon, through sudo: the Wi-Fi as JSON on stdin, never in argv.
        try:
            request = json.loads(sys.stdin.read(16384) or '{}')
        except ValueError:
            request = None
        change(request)
        return
    if arguments.command == 'now':
        # For a person at the computer, or a test: leave the current Wi-Fi for the hotspot now.
        NOW.parent.mkdir(parents=True, exist_ok=True)
        NOW.touch()
        return
    if arguments.command == 'name':
        print(hotspot_name())
        return
    set_up_as_unlocked()
    log(f'watching; hotspot "{hotspot_name()}" when there is no network')
    watch()


if __name__ == '__main__':
    main()
