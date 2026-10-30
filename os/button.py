#!/usr/bin/env python3
"""A factory reset from the power button, for a computer with no screen or keyboard.

One press while the computer runs does nothing (logind.conf.d/20-harness-os.conf), so a touch by
accident does not turn it off; it is turned off from a phone. Five presses in a row ask for a factory
reset: the lights blink fast and a screen, if there is one, asks; one press more within CONFIRM
seconds starts the computer in its recovery (setup.py recover), which installs it again as it came:
everything of the person erased, a new disk key, the password 1234 — the same as a reset while its
disk waits for its password (unlock/button). Nothing more and it stays as it was.
Holding the button four seconds still forces the computer off: that is the hardware's.

Presses are read beside logind, from every input device with KEY_POWER. Firmware reports a press,
never how long it was held, and some reports one only once the button was held a moment (an MSI
laptop: about a second), so presses are counted, never timed.
"""
import fcntl
import os
from pathlib import Path
import pwd
import select
import signal
import struct
import subprocess
import sys
import threading
import time

INPUT = Path('/dev/input')
LEDS = Path('/sys/class/leds')
# The computer's own status lights, one /sys/class/leds name a line; without it, Caps Lock's.
STATUS_LEDS = Path('/etc/harness-os/status-leds')
SETUP = Path(__file__).with_name('setup.py')
USER = 'me'
EV_KEY = 1
KEY_POWER = 116
KEY_MAX = 0x2ff
# struct input_event on a 64-bit kernel: the time, then type, code and value.
EVENT = struct.Struct('llHHi')
PRESSES = 5
# A press further than this from the one before starts the count again.
PRESS_GAP = 3
# One press seen by two devices (ACPI's two power buttons, on some computers) is one press.
SAME_PRESS = 0.15
CONFIRM = 10
# The presses of a person still pressing as it asks are not the answer.
SETTLE = 1
BLINK = 0.1
# The console that asks while the session is locked, one with no getty; and the kernel's VT ioctls.
CONSOLE = 9
VT_GETSTATE = 0x5603
VT_ACTIVATE = 0x5606


def log(message):
    print(f'harness-button: {message}', file=sys.stderr, flush=True)


def has_power_key(fd):
    """Whether an input device reports KEY_POWER (EVIOCGBIT for EV_KEY)."""
    size = KEY_MAX // 8 + 1
    request = (2 << 30) | (size << 16) | (ord('E') << 8) | (0x20 + EV_KEY)
    try:
        bits = fcntl.ioctl(fd, request, bytes(size))
    except OSError:
        return False
    return bool(bits[KEY_POWER // 8] & (1 << KEY_POWER % 8))


def power_buttons():
    devices = []
    for path in sorted(INPUT.glob('event*')):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        except OSError:
            continue
        if has_power_key(fd):
            devices.append(fd)
        else:
            os.close(fd)
    return devices


def presses(fd):
    """The power-button presses waiting on [fd], as a count."""
    count = 0
    try:
        data = os.read(fd, EVENT.size * 64)
    except BlockingIOError:
        return 0
    for offset in range(0, len(data) - EVENT.size + 1, EVENT.size):
        _, _, kind, code, value = EVENT.unpack_from(data, offset)
        count += kind == EV_KEY and code == KEY_POWER and value == 1
    return count


class Count:
    """The presses so far: `press` says 'ask' at the fifth in a row, 'reset' at one more after it asks."""

    def __init__(self):
        self.times = []
        self.asked = None

    def press(self, now):
        if self.times and now - self.times[-1] < SAME_PRESS:
            return None
        if self.asked is not None:
            if now - self.asked < SETTLE:
                self.times.append(now)
                return None
            self.asked, self.times = None, []
            return 'reset'
        if self.times and now - self.times[-1] > PRESS_GAP:
            self.times = []
        self.times.append(now)
        if len(self.times) < PRESSES:
            return None
        self.times, self.asked = [now], now
        return 'ask'

    def expired(self, now):
        """Asked and not answered in time: back to nothing pressed."""
        if self.asked is None or now - self.asked < CONFIRM:
            return False
        self.asked, self.times = None, []
        return True


class Lights:
    """The status lights blinking fast, then as they were."""

    def __init__(self):
        self.stop = None

    @staticmethod
    def chosen():
        try:
            names = [line.strip() for line in STATUS_LEDS.read_text().splitlines() if line.strip()]
            return [LEDS / name for name in names if (LEDS / name).is_dir()]
        except OSError:
            return sorted(LEDS.glob('*::capslock'))

    def start(self):
        if self.stop:
            return
        leds = []
        for led in self.chosen():
            try:
                trigger = (led / 'trigger').read_text()
                current = trigger.split('[', 1)[1].split(']', 1)[0] if '[' in trigger else 'none'
                leds.append((led, current, (led / 'brightness').read_text().strip(),
                             (led / 'max_brightness').read_text().strip()))
                (led / 'trigger').write_text('none')
            except (OSError, IndexError):
                continue
        self.stop = threading.Event()
        threading.Thread(target=self.blink, args=(leds, self.stop), daemon=True).start()

    @staticmethod
    def blink(leds, stop):
        on = True
        while not stop.wait(BLINK):
            for led, _, _, brightest in leds:
                try:
                    (led / 'brightness').write_text(brightest if on else '0')
                except OSError:
                    pass
            on = not on
        for led, trigger, brightness, _ in leds:
            try:
                (led / 'brightness').write_text(brightness)
                (led / 'trigger').write_text(trigger)
            except OSError:
                pass

    def end(self):
        if self.stop:
            self.stop.set()
            self.stop = None


def locked(uid):
    """Whether the person's session lock (gtklock) runs."""
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if (process / 'comm').read_text().strip() == 'gtklock' and process.stat().st_uid == uid:
                return True
        except OSError:
            continue
    return False


class Screen:
    """The question on the screen: in a window of the person's session, or, while the session is locked
    (its lock covers every window) or there is none, on a console of its own, the screen switched to
    it and back after."""

    def __init__(self):
        self.window = None
        self.back = None

    def ask(self):
        try:
            account = pwd.getpwnam(USER)
        except KeyError:
            self.console()
            return
        runtime = Path(f'/run/user/{account.pw_uid}')
        display = next((path.name for path in sorted(runtime.glob('wayland-*')) if not path.name.endswith('.lock')), None)
        # The marker of /usr/lib/harness-os/lock, there while the session is locked, or its gtklock.
        if not display or (runtime / 'harness-os-locked').exists() or locked(account.pw_uid):
            self.console()
            return
        environment = dict(HOME=account.pw_dir, USER=USER, LOGNAME=USER, PATH='/usr/bin', XDG_RUNTIME_DIR=str(runtime),
                           WAYLAND_DISPLAY=display)
        try:
            self.window = subprocess.Popen(
                ['/usr/bin/runuser', '-u', USER, '--', '/usr/bin/foot', '--config=/usr/share/harness-os/foot.ini',
                 '--app-id=harness-reset', '--title=Factory reset', '--window-size-chars=76x6',
                 '/usr/bin/python3', str(Path(__file__).resolve()), 'ask'],
                env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError as error:
            log(f'could not ask on the screen ({error})')

    def console(self):
        try:
            with open('/dev/tty0', 'wb', buffering=0) as switch, open(f'/dev/tty{CONSOLE}', 'w') as console:
                active = struct.unpack('HHH', fcntl.ioctl(switch, VT_GETSTATE, bytes(6)))[0]
                # Cleared, the cursor hidden.
                console.write('\033[2J\033[H\033[?25l')
                console.flush()
                self.window = subprocess.Popen(['/usr/bin/python3', str(Path(__file__).resolve()), 'ask'],
                                               stdout=console, stderr=subprocess.DEVNULL, start_new_session=True)
                fcntl.ioctl(switch, VT_ACTIVATE, CONSOLE)
                self.back = active
        except OSError as error:
            log(f'could not ask on the console ({error})')

    def close(self):
        if self.window and self.window.poll() is None:
            try:
                os.killpg(self.window.pid, signal.SIGTERM)
            except OSError:
                pass
        self.window = None
        if self.back:
            try:
                with open('/dev/tty0', 'wb', buffering=0) as switch:
                    fcntl.ioctl(switch, VT_ACTIVATE, self.back)
            except OSError as error:
                log(f'could not switch the screen back ({error})')
            self.back = None


def question():
    """The window's text, counting down: shown by `button.py ask` inside foot. The same words as the
    startup's while the disk is locked (the Plymouth theme's show_reset)."""
    print('\n  Factory reset? Press the power button once more to erase this computer.\n'
          '  Do nothing to keep everything.\n')
    for left in range(CONFIRM, 0, -1):
        print(f'\r  {left} seconds left  ', end='', flush=True)
        time.sleep(1)
    print('\r  Kept as it was.     ', flush=True)
    time.sleep(1)


def reset():
    """setup.py recover, the lights blinking meanwhile: the computer starts again in its recovery, and
    comes back only if it could not."""
    log('factory reset from the power button')
    done = subprocess.run(['/usr/bin/python3', str(SETUP), 'recover'], capture_output=True, text=True)
    if done.returncode:
        log('the factory reset did not start: ' + (done.stderr.strip()[-300:] or 'setup.py failed'))


def listen(devices):
    count, lights, screen = Count(), Lights(), Screen()
    while True:
        ready, _, _ = select.select(devices, [], [], 1)
        now = time.monotonic()
        for fd in ready:
            for _ in range(presses(fd)):
                answer = count.press(now)
                if answer == 'ask':
                    log(f'{PRESSES} presses: asking for a factory reset')
                    lights.start()
                    screen.ask()
                elif answer == 'reset':
                    screen.close()
                    reset()
                    lights.end()
                    # Whatever was pressed while it reset counts for nothing.
                    for device in devices:
                        presses(device)
                    count = Count()
                    break
        if count.expired(time.monotonic()):
            log('no answer: nothing reset')
            screen.close()
            lights.end()


def main():
    if sys.argv[1:] == ['ask']:
        question()
        return
    devices = power_buttons()
    if not devices:
        log('no power button to listen to')
        return
    log(f'listening to {len(devices)} power button device(s)')
    listen(devices)


if __name__ == '__main__':
    main()
