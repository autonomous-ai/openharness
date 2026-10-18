#!/usr/bin/env python3
"""Set up a Harness with no screen from a phone: a setup hotspot, the Wi-Fi this computer sees,
the person's Wi-Fi and password, and a sign-in ticket for the phone's account.

The phone (mobile/lib/phone/add_device/) asks the backend for a ticket while it still has the
Internet, joins the open hotspot `Harness-XXXX` (the person picks it from a list), and talks to
http://10.42.0.1/setup. This computer then leaves the hotspot, joins the chosen Wi-Fi, checks the
Internet and signs in with `harness login --ticket`. When the Wi-Fi fails, the hotspot comes back
with the reason (wrong password, out of reach, no address, no Internet), for the phone to read when
it rejoins, and the person tries again.

The hotspot comes up by itself only while there is no network: at once on a computer not signed in
yet (just installed or reset), screen or not, beside the screen's own Wi-Fi page; on one signed in,
only with no screen and after a long outage (a new router). While nobody is on it, saved Wi-Fi is
tried again every few minutes, so a router that was only off brings the computer back by itself.
Its name ends in the Wi-Fi card's own address, the same however often the computer is flashed.

The hotspot has no password, for setup to be one tap: whoever is in range of a computer in setup
can choose its Wi-Fi, and the Wi-Fi password crosses an open network. Nothing here runs a command
the phone names, and a computer already signed in keeps its account (`login --ticket` refuses).
"""
import argparse
import array
import fcntl
import http.server
import importlib.util
import json
from pathlib import Path
import pwd
import queue
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid

STATE = Path('/var/lib/harness-os')
RESULT = STATE / 'setup-result.json'
NOW = Path('/run/harness-os/setup-now')
# What the radio saw before hosting the hotspot, for the screen's Wi-Fi page (network.py SETUP_NETWORKS).
SCREEN_NETWORKS = Path('/run/harness-os/setup-networks.json')
# Signed in from a phone: its first workspace is OpenCode alone, not with two terminals (onboarding.py).
FROM_PHONE = STATE / 'set-up-from-phone'
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
# Not signed in, with saved Wi-Fi: this long for it to come back as the computer starts.
SAVED_GRACE = 15
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
    print(f'harness-setup: {message}', flush=True)



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
    """Leave the hotspot for the person's Wi-Fi. Returns the result the phone reads."""
    ssid, password, ticket = request['ssid'], request.get('password') or '', request.get('ticket')
    seen = next((row for row in networks if row['ssid'] == ssid), None)
    security = seen['security'] if seen else ('WPA2' if password else '')
    log(f'joining "{ssid}"')
    started = time.monotonic()
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


def check_request(body):
    if not isinstance(body, dict):
        return 'Send a JSON object.'
    ssid, password, ticket = body.get('ssid'), body.get('password'), body.get('ticket')
    if not isinstance(ssid, str) or not ssid or len(ssid.encode()) > 32:
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
        return dict(protocol=PROTOCOL, name=socket.gethostname(), hotspot=self.name, run=self.run,
                    computerId=computer_id(), signedIn=signed_in(), result=read_result())

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
                problem = check_request(body)
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
    """Hotspot until the phone sends a Wi-Fi that works, or saved Wi-Fi comes back.

    Saved Wi-Fi is tried again only for a computer signed in that lost its network (a router that
    was off). One not signed in still needs the phone, and one [asked] for setup by hand was taken
    off its Wi-Fi on purpose: both keep the hotspot until somebody uses it."""
    may_leave = not asked and signed_in()
    name = hotspot_name(device)
    networks = visible_networks(name)
    try:
        while True:
            if not start_hotspot(device, name):
                return False
            # The screen's Wi-Fi page lists these while the radio hosts the hotspot (network.py).
            show_networks(networks, device)
            run = int(read_result().get('run') or 0)
            log(f'hotspot "{name}" is up with {len(networks)} networks to offer')
            setup = Setup(name, networks, run)
            try:
                server = serve(setup)
            except OSError as error:
                log(f'could not answer on {ADDRESS}:{PORT}: {error}')
                stop_hotspot()
                return False
            request, idle_since, elsewhere = None, time.monotonic(), None
            while request is None:
                try:
                    request = setup.requests.get(timeout=5)
                except queue.Empty:
                    # Someone at the screen took the radio for a Wi-Fi (network.py): joined, or not.
                    if not hotspot_up():
                        elsewhere = online()
                        break
                    # Online another way meanwhile (a cable plugged in): the hotspot has no use.
                    if online():
                        elsewhere = True
                        break
                    if phones_on(device):
                        idle_since = time.monotonic()
                    elif may_leave and time.monotonic() - idle_since >= RETRY_SAVED and saved_wifi():
                        break
            if request is not None:
                run += 1
                write_result(state='connecting', ssid=request['ssid'], run=run)
                # Let the phone read its answer before the hotspot goes.
                time.sleep(2)
            server.shutdown()
            server.server_close()
            stop_hotspot()
            if elsewhere is not None:
                if elsewhere or wait_online(SAVED_JOIN):
                    log('joined a Wi-Fi from the screen')
                    return True
                # Their Wi-Fi failed: the hotspot comes back for the phone.
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
    finally:
        SCREEN_NETWORKS.unlink(missing_ok=True)


def hotspot_up():
    return any(len(row) == 1 and row[0] == HOTSPOT for row in rows('-f', 'NAME', 'connection', 'show', '--active'))


def wait_online(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if online():
            return True
        time.sleep(3)
    return online()


def show_networks(networks, device):
    """For the screen's Wi-Fi page (network.py), which cannot scan while the radio hosts the hotspot."""
    try:
        SCREEN_NETWORKS.parent.mkdir(parents=True, exist_ok=True)
        SCREEN_NETWORKS.write_text(json.dumps([dict(row, device=device) for row in networks]))
    except OSError:
        pass


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


def offline_wait(now, started):
    """How long this computer must be offline before its hotspot opens; None: never by itself.

    Not signed in (just installed, or reset), screen or not: at once, for setup from a phone beside
    the screen's own Wi-Fi page, which lists the Wi-Fi seen before the hotspot and takes the radio
    back for one chosen there. Saved Wi-Fi gets a moment to come back first, as it does at boot.
    Signed in: a computer with no screen after a long outage (a new router); one with a screen keeps
    its Wi-Fi page, as a laptop away from its network should."""
    if not signed_in():
        return SAVED_GRACE if saved_wifi() and now - started < SAVED_GRACE + 5 else 0
    if not headless():
        return None
    return OFFLINE_AT_START if now - started < OFFLINE_AT_START + 5 else OFFLINE_LATER


def watch():
    started, offline_since = time.monotonic(), None
    while True:
        now = time.monotonic()
        forced = asked_now()
        wait = None if forced else offline_wait(now, started)
        if (online() or wait is None) and not forced:
            offline_since = None
        else:
            offline_since = offline_since or now
            device = wifi_device()
            if device and (forced or now - offline_since >= wait):
                if forced:
                    # Asked for by hand: leave the current Wi-Fi so the radio can host the hotspot.
                    nmcli('device', 'disconnect', device)
                setup_mode(device, asked=forced)
                offline_since = None
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
RESET_UNIT = 'harness-factory-reset'


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


def factory_reset(keep_wifi=False):
    """This computer as it was just flashed: no account, no harnesses, the first workspace still to come,
    and (unless [keep_wifi]) no Wi-Fi, so it opens its setup hotspot for a phone. It stays the same
    computer: its id and its device key are kept, as a new key for the same computer is refused by the
    account until the old one is removed. The engines' own sign-ins and ~/projects are the person's.
    For the reset button and `harness factory-reset`."""
    log('factory reset')
    # Its windows first, while still signed in: the account keeps the tabs (the desk, the same on
    # every computer), and one left there comes back at the next sign-in in the first workspace's place.
    windows = as_user(HN, 'list-windows', '-F', '#{window_index}')
    for index in sorted((int(n) for n in (windows.stdout.split() if windows else []) if n.isdigit()), reverse=True):
        as_user(HN, 'kill-window', '-t', f':{index}')
    as_user('/usr/bin/harness', 'logout', timeout=60)
    # Every harness and terminal: the daemon, then the tmux server its panes run in.
    as_user('systemctl', '--user', 'stop', 'harness-daemon', timeout=60)
    as_user('tmux', 'kill-server')
    harness = HOME / '.harness'
    wipe(harness, {'computer-id': True, 'cli': {'data': {'e2e': True}}})
    (HOME / '.local/state/harness-os/onboarded').unlink(missing_ok=True)
    for path in (RESULT, FROM_PHONE):
        path.unlink(missing_ok=True)
    as_user('systemctl', '--user', 'start', 'harness-daemon', timeout=60)
    # hn again from its sign-in page. Its server outlives the screen unit (KillMode=process).
    as_user(HN, 'kill-server')
    subprocess.run(['/usr/bin/pkill', '-u', USER, '-x', 'harness-tui'], capture_output=True)
    as_user('systemctl', '--user', 'restart', 'hn-screen', timeout=60)
    if not keep_wifi:
        for row in rows('-f', 'UUID,TYPE', 'connection', 'show'):
            if len(row) == 2 and row[1] == '802-11-wireless':
                nmcli('connection', 'delete', 'uuid', row[0])
    # The watcher opens the hotspot for a phone (headless or not: asked for).
    NOW.parent.mkdir(parents=True, exist_ok=True)
    NOW.touch()
    log('factory reset done')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('command', nargs='?', choices=['watch', 'now', 'name', 'join', 'reset'], default='watch')
    parser.add_argument('--keep-wifi', action='store_true', help='reset: keep the saved Wi-Fi')
    parser.add_argument('--here', action='store_true', help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if arguments.command == 'reset':
        if arguments.here:
            factory_reset(keep_wifi=arguments.keep_wifi)
            return
        # In a unit of its own: the computer leaves its Wi-Fi, and whatever asked (an SSH session, the
        # button's handler) may go with it before the reset is done. `journalctl -u harness-factory-reset`.
        command = ['/usr/bin/systemd-run', f'--unit={RESET_UNIT}', '--collect', '--quiet',
                   '/usr/bin/python3', str(Path(__file__).resolve()), 'reset', '--here']
        if arguments.keep_wifi:
            command.append('--keep-wifi')
        started = subprocess.run(command, capture_output=True, text=True)
        if started.returncode:
            raise SystemExit('Could not start the reset: ' + (started.stderr.strip() or 'systemd-run failed'))
        print('Resetting this computer. It signs out, closes every harness'
              + ('' if arguments.keep_wifi else ', forgets its Wi-Fi')
              + ' and opens its setup hotspot for a phone in about a minute.')
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
    log(f'watching; hotspot "{hotspot_name()}" when there is no network')
    watch()


if __name__ == '__main__':
    main()
