#!/usr/bin/env python3
"""A full-page Wi-Fi step backed by NetworkManager, with no resident UI service."""
import argparse
import curses
import os
import subprocess
import time
import uuid
import unicodedata

WORDMARK = ('█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀', '█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█')


def nmcli(*args, secret=None, wait=8):
    # Secrets travel through stdin, never argv, shell text or diagnostic logs.
    return subprocess.run(['/usr/bin/nmcli', '--colors', 'no', '--wait', str(wait), *args],
                          input=secret, capture_output=True, text=True, timeout=wait + 3,
                          env=dict(os.environ, LC_ALL='C'))


def fields(line):
    values, value, escaped = [], '', False
    for character in line:
        if escaped:
            value += character
            escaped = False
        elif character == '\\':
            escaped = True
        elif character == ':':
            values.append(value)
            value = ''
        else:
            value += character
    if escaped:
        value += '\\'
    return [*values, value]


def connected():
    try:
        result = nmcli('-t', '-f', 'STATE', 'general', wait=2)
        return result.returncode == 0 and result.stdout.strip().startswith('connected')
    except (OSError, subprocess.TimeoutExpired):
        return False


def scan(rescan=None):
    # Opening the page should reuse a recent scan, especially just after a
    # reconnect. NetworkManager refreshes results older than 30 seconds in auto
    # mode. Force a scan only when the user chooses Rescan.
    mode = 'auto' if rescan is None else 'yes' if rescan else 'no'
    result = nmcli('-t', '-e', 'yes', '-f', 'SSID,SIGNAL,SECURITY,DEVICE,BSSID,IN-USE',
                   'device', 'wifi', 'list', '--rescan', mode, wait=10)
    if result.returncode:
        raise ValueError('Could not scan Wi-Fi. Check airplane mode, then choose Rescan.')
    networks = {}
    for line in result.stdout.splitlines():
        row = fields(line)
        if len(row) != 6 or not row[0] or not row[1].isdigit():
            continue
        ssid, signal, security, device, bssid, active = row
        item = dict(ssid=ssid, signal=int(signal), security=security, device=device,
                    bssid=bssid, active=active == '*')
        key = (ssid, device, security)
        if key not in networks or (item['active'], item['signal']) > (networks[key]['active'], networks[key]['signal']):
            networks[key] = item
    return sorted(networks.values(), key=lambda row: (not row['active'], -row['signal'], row['ssid']))


def wired_devices():
    result = nmcli('-t', '-e', 'yes', '-f', 'DEVICE,TYPE,STATE', 'device', 'status', wait=3)
    if result.returncode:
        return []
    # An unavailable Ethernet device can still recover through explicit
    # activation, including after networking was disabled across suspend.
    return [row for line in result.stdout.splitlines()
            if len(row := fields(line)) == 3 and row[1] == 'ethernet']


def connect_wired(device, state):
    if state == 'unavailable':
        # After a disabled boot and sleep, NM can leave the link down and its
        # available-profile list empty. Connecting then creates a new DHCP
        # profile, ignoring saved settings. Raise only the selected link and
        # let NM discover its profiles before requesting ordinary activation.
        link = subprocess.run(['/usr/bin/ip', 'link', 'set', 'dev', device, 'up'],
                              capture_output=True, text=True, timeout=3)
        if link.returncode:
            return False
        deadline = time.monotonic() + 10
        while True:
            status = nmcli('-g', 'GENERAL.STATE', 'device', 'show', device, wait=2)
            if status.returncode:
                return False
            value = status.stdout.strip().split(' ', 1)[0]
            if value == '100':
                return True
            if value == '30':
                break
            if time.monotonic() >= deadline:
                return False
            time.sleep(.2)
    return nmcli('device', 'connect', device, wait=30).returncode == 0


def still_connected(network):
    # The page can stay open through a lost connection or suspend. IN-USE is
    # current NetworkManager state even without a new radio scan; never trust
    # the Connected label captured when the page opened.
    try:
        return any(row['active'] and all(row[key] == network[key]
                   for key in ('ssid', 'device', 'security')) for row in scan(rescan=False))
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False


def saved_connection(network):
    result = nmcli('-t', '-f', 'UUID,TYPE', 'connection', 'show', wait=3)
    if result.returncode:
        return None
    for line in result.stdout.splitlines():
        row = fields(line)
        if len(row) != 2 or row[1] != '802-11-wireless':
            continue
        detail = nmcli('-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', row[0], wait=3)
        if detail.returncode == 0 and detail.stdout.rstrip('\n') == network['ssid']:
            return row[0]
    return None


def connect(network, password=None):
    saved = saved_connection(network) if password is None else None
    if saved:
        return nmcli('connection', 'up', 'uuid', saved, 'ifname', network['device'], wait=30).returncode == 0
    security = network['security']
    protected = bool(security and security != '--')
    if protected and password is None:
        return False
    if '802.1X' in security or 'WEP' in security:
        raise ValueError('This network needs advanced settings. Use nmcli in a terminal to configure it.')
    if password is not None and ('\n' in password or '\r' in password):
        raise ValueError('Enter the Wi-Fi password on one line.')
    identity = str(uuid.uuid4())
    arguments = ['connection', 'add', 'type', 'wifi', 'ifname', network['device'],
                 'con-name', network['ssid'], 'connection.uuid', identity,
                 'connection.autoconnect', 'no', 'ssid', network['ssid']]
    if protected:
        key = 'sae' if 'WPA3' in security and 'WPA2' not in security else 'wpa-psk'
        arguments += ['wifi-sec.key-mgmt', key, 'wifi-sec.psk-flags', '0']
    created = nmcli(*arguments)
    if created.returncode:
        raise ValueError('Could not configure Wi-Fi. Choose Rescan and try again.')
    succeeded = False
    try:
        arguments = ['connection', 'up', 'uuid', identity, 'ifname', network['device']]
        secret = None
        if protected:
            arguments += ['passwd-file', '/dev/stdin']
            secret = '802-11-wireless-security.psk:' + password + '\n'
        result = nmcli(*arguments, secret=secret, wait=35)
        if result.returncode:
            return False
        # Only a connected profile becomes eligible for automatic reconnection.
        result = nmcli('connection', 'modify', 'uuid', identity, 'connection.autoconnect', 'yes')
        if result.returncode:
            raise ValueError('Connected, but could not save automatic reconnection. Try again.')
        succeeded = True
        return True
    finally:
        if not succeeded:
            # Delete only the profile this attempt created, never an existing one.
            try:
                nmcli('connection', 'delete', 'uuid', identity)
            except (OSError, subprocess.TimeoutExpired):
                pass


def clean(text):
    return ''.join(character if character.isprintable() else ' ' for character in text)


def fit(text, width):
    result, used = '', 0
    for character in clean(text):
        cells = 0 if unicodedata.combining(character) else 2 if unicodedata.east_asian_width(character) in ('W', 'F') else 1
        if used + cells > width:
            break
        result += character
        used += cells
    return result + ' ' * (width - used)


class NetworkPage:
    def __init__(self, screen, first_use=False):
        self.screen, self.first_use = screen, first_use
        self.networks, self.wired, self.selected, self.message = [], [], 0, ''
        screen.keypad(True)
        screen.timeout(800)
        self.accent = curses.A_BOLD
        try:
            if curses.has_colors():
                curses.start_color()
                curses.use_default_colors()
                curses.init_pair(1, curses.COLOR_YELLOW, -1)
                self.accent = curses.color_pair(1) | curses.A_BOLD
        except curses.error:
            pass
        try:
            curses.curs_set(0)
        except curses.error:
            pass

    def line(self, row, text, selected=False, accent=False, offset=0, span=None):
        height, width = self.screen.getmaxyx()
        row += self.top
        length = self.width - offset if span is None else min(span, self.width - offset)
        if 0 <= row < height - 1 and width > 3 and length > 0:
            self.screen.addnstr(row, self.left + offset, fit(text, length), length,
                                curses.A_REVERSE if selected else self.accent if accent else curses.A_NORMAL)

    def button(self, row, text, selected=False):
        label = '[ ' + text + ' ]'
        self.line(row, label, selected, offset=max(0, (self.width - len(label)) // 2), span=len(label))

    def begin(self):
        self.screen.erase()
        height, width = self.screen.getmaxyx()
        self.width = max(1, min(50, width - 4))
        self.left = max(0, (width - self.width) // 2)
        # Leave generous space on a laptop display while retaining room for the
        # form on a 24-row terminal. All pages share this same text column.
        self.top = max(1, (height - 26) // 2)
        for row, text in enumerate(WORDMARK):
            self.line(row, text.center(self.width), accent=True)
        self.line(6, 'Connect to Wi-Fi')
        return height

    def refresh(self, rescan=None):
        self.begin()
        self.line(8, 'Finding Wi-Fi…')
        self.screen.refresh()
        self.message = ''
        self.networks, self.wired = [], []
        try:
            nmcli('radio', 'wifi', 'on', wait=3)
            self.networks = scan(rescan=rescan)
        except (OSError, subprocess.TimeoutExpired, ValueError) as error:
            self.message = str(error) if isinstance(error, ValueError) else 'Wi-Fi is unavailable. Choose Rescan to try again.'
        # A missing or unavailable Wi-Fi radio must not hide the wired path.
        try:
            self.wired = wired_devices()
        except (OSError, subprocess.TimeoutExpired):
            if not self.message:
                self.message = 'Could not check Ethernet. Choose Rescan to try again.'
        self.selected = 0

    def busy(self, name):
        self.begin()
        self.line(8, 'Connecting to ' + clean(name) + '…')
        self.screen.refresh()

    def password(self, network):
        value, error = '', ''
        while True:
            height = self.begin()
            self.line(8, 'Network     ' + clean(network['ssid']))
            self.line(10, 'Password', span=12)
            capacity = max(1, self.width - 14)
            self.line(10, '[' + ('*' * min(len(value), capacity)).ljust(capacity) + ']',
                      selected=True, offset=12)
            self.line(12, error)
            self.button(14, 'Connect')
            try:
                curses.curs_set(1)
                if height > self.top + 11:
                    self.screen.move(self.top + 10, self.left + min(13 + len(value), self.width - 2))
            except curses.error:
                pass
            self.screen.refresh()
            try:
                key = self.screen.get_wch()
            except curses.error:
                continue
            if key in ('\x1b', '\x03'):
                return False
            if key in ('\n', '\r', curses.KEY_ENTER):
                self.busy(network['ssid'])
                try:
                    if connect(network, value):
                        return True
                    error = 'Could not connect. Check the password and try again.'
                except (OSError, subprocess.TimeoutExpired, ValueError) as failure:
                    error = str(failure) if isinstance(failure, ValueError) else 'Connection timed out. Try again.'
                value = ''
            elif key in ('\x7f', '\b', curses.KEY_BACKSPACE):
                value = value[:-1]
            elif key == '\x15':
                value = ''
            elif isinstance(key, str) and key.isprintable() and len(value) < 256:
                value += key

    def run(self):
        if self.first_use and connected():
            return 0
        self.refresh()
        checked = time.monotonic()
        while True:
            if self.first_use and time.monotonic() - checked >= 2:
                if connected():
                    return 0
                checked = time.monotonic()
            rows = [('wifi', network) for network in self.networks] + [('rescan', None)]
            rows += [('wired', device) for device in self.wired]
            self.selected = min(self.selected, len(rows) - 1)
            height = self.begin()
            try:
                curses.curs_set(0)
            except curses.error:
                pass
            # Both entry points share the same layout. Super+t remains available
            # from the compositor when setup cannot finish without a terminal.
            visible = max(1, min(10, height - self.top - 14 - len(self.wired)))
            offset = max(0, min(self.selected, len(self.networks) - 1) - visible + 1)
            networks = self.networks[offset:offset + visible]
            for index, value in enumerate(networks, start=offset):
                signal = 'Connected' if value['active'] else f"{value['signal']}%"
                label = fit(value['ssid'], self.width - len(signal) - 2) + '  ' + signal
                self.line(8 + index - offset, label, index == self.selected)
            bottom = 9 + max(1, len(networks))
            self.button(bottom, 'Rescan', self.selected == len(self.networks))
            for index, device in enumerate(self.wired):
                self.line(bottom + 2 + index, 'Ethernet  ' + device[0],
                          self.selected == len(self.networks) + 1 + index)
            self.line(height - self.top - 2, self.message or ('' if self.networks else 'No Wi-Fi networks found. Rescan or use Ethernet.'))
            self.screen.refresh()
            try:
                key = self.screen.get_wch()
            except curses.error:
                continue
            if key in ('\x1b', '\x03') and not self.first_use:
                return 1
            if key in (curses.KEY_UP, curses.KEY_BTAB):
                self.selected = (self.selected - 1) % len(rows)
            elif key in (curses.KEY_DOWN, '\t'):
                self.selected = (self.selected + 1) % len(rows)
            elif key in ('r', 'R'):
                self.refresh(rescan=True)
            elif key in ('\n', '\r', curses.KEY_ENTER):
                kind, value = rows[self.selected]
                if kind == 'rescan':
                    self.refresh(rescan=True)
                    continue
                self.busy(value['ssid'] if kind == 'wifi' else 'Ethernet')
                try:
                    if kind == 'wired':
                        if connect_wired(value[0], value[2]):
                            return 0
                        self.message = 'Could not connect Ethernet. Check the cable and try again.'
                    elif (value['active'] and still_connected(value)) or connect(value):
                        return 0
                    elif value['security'] and value['security'] != '--':
                        if self.password(value):
                            return 0
                    else:
                        self.message = 'Could not connect. Choose Rescan and try again.'
                except (OSError, subprocess.TimeoutExpired, ValueError) as error:
                    self.message = str(error) if isinstance(error, ValueError) else 'Could not connect. Choose Rescan and try again.'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--first-use', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Open Wi-Fi through Harness.')
    curses.set_escdelay(25)
    def page(screen):
        # Treat Ctrl+C as a key, so first use cannot be killed into an empty
        # workspace. Ordinary Wi-Fi and the password field still handle it as
        # their existing Back action. wrapper restores the terminal on exit.
        curses.raw()
        return NetworkPage(screen, args.first_use).run()
    return curses.wrapper(page)


if __name__ == '__main__':
    raise SystemExit(main())
