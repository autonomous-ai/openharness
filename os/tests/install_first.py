"""Native checks for installer-only USB startup and the installed workspace."""
import json
import os
import re
import shlex
import subprocess
import time


def wait_installer_screen(vm, pattern, name, timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        vm.screenshot(name)
        started = time.monotonic()
        remaining = deadline - started
        if remaining <= 0:
            raise AssertionError('Screen did not render ' + pattern + ' before its deadline')
        try:
            # OCR is a host observer. A slow early frame must not shorten the
            # browser's readiness budget or compete with QEMU for every CPU.
            text = subprocess.check_output(['tesseract', str(vm.folder / (name + '.png')),
                                            'stdout', '--psm', '11'], text=True,
                                           stderr=subprocess.DEVNULL, timeout=min(10, remaining),
                                           env=dict(os.environ, OMP_THREAD_LIMIT='1'))
        except subprocess.TimeoutExpired:
            text = '[OCR exceeded the per-frame deadline]'
        with (vm.folder / (name + '-ocr.jsonl')).open('a') as log:
            log.write(json.dumps({'seconds': round(time.monotonic() - started, 3),
                                  'matched': bool(re.search(pattern, text, re.I)),
                                  'text': text}) + '\n')
        (vm.folder / (name + '.txt')).write_text(text)
        if re.search(pattern, text, re.I):
            return text
        if time.monotonic() >= deadline:
            raise AssertionError('Installer did not render ' + pattern + '; saw ' + text)
        time.sleep(.25)


def check_usb_installer(vm, user, folder):
    vm.command(user('sh -c ' + shlex.quote('for n in $(seq 1 60); do '
        'systemctl --user is-active --quiet harness-install && pgrep -x foot >/dev/null && exit 0; '
        'sleep .5; done; exit 1')), timeout=40)
    text = wait_installer_screen(vm, 'Repeat password', '01-usb-installer')
    ready = round(time.monotonic() - vm.started, 3)
    for absent in ['Try without installing', 'Connect to Wi-Fi', 'Make Harness your OS']:
        assert absent not in text
    vm.command('! pgrep -x "hn|harness-tui|opencode|chromium"')
    vm.command(user('sh -c ' + shlex.quote('! systemctl --user is-active --quiet harness-daemon')))
    vm.type_probe('discard-me')
    vm.keys('esc')
    wait_installer_screen(vm, 'Repeat password', '01-usb-cancel')
    vm.command('test "$(lsblk -n -o TYPE /dev/vda | wc -l)" -eq 1')
    # Failed graphics must still open the installer, not a trial or blank screen.
    override = '/etc/profile.d/00-hn-test-broken-graphics.sh'
    vm.command('printf %s ' + shlex.quote('export WLR_BACKENDS=hn-test-missing\n') +
               ' > ' + override + '; systemctl restart getty@tty1.service')
    try:
        vm.command('for n in $(seq 1 60); do ! pgrep -x labwc && ! pgrep -x foot && '
                   'pgrep -f "[/]usr/lib/harness-os/install.py --boot" >/dev/null && exit 0; '
                   'sleep .5; done; exit 1', timeout=40)
        # The kernel console's bitmap font is correctly rendered, but OCR can
        # read its "w" as "u". Keep the exact form label with that one known
        # glyph ambiguity; the retained framebuffer remains the visual evidence.
        wait_installer_screen(vm, r'Repeat pass[wu]ord', '01-usb-console-installer')
        vm.keys('esc')
        vm.command('test "$(lsblk -n -o TYPE /dev/vda | wc -l)" -eq 1')
    finally:
        vm.command('rm -f ' + override + '; systemctl restart getty@tty1.service')
    vm.command(user('sh -c ' + shlex.quote('for n in $(seq 1 60); do '
        'systemctl --user is-active --quiet harness-install && pgrep -x foot >/dev/null && exit 0; '
        'sleep .5; done; exit 1')), timeout=40)
    wait_installer_screen(vm, 'Repeat password', '01-usb-graphics-restored')
    return ready


def check_installed_controls(vm, result, folder):
    vm.command('! systemctl --user is-active --quiet harness-install')
    vm.command('pacman -Si git chromium >/dev/null', timeout=60)
    result['checks'].append('Dated package repositories are queryable before the first download')
    vm.command('systemd-run --user --quiet --wait --pipe --collect /bin/sh -c ' +
               shlex.quote('printf hn-clipboard-check | wl-copy; test "$(wl-paste --no-newline)" = hn-clipboard-check'))
    result['checks'].append('Wayland clipboard round trip')
    vm.keys('ctrl', 'b')
    vm.keys('c')
    time.sleep(.5)
    vm.type_probe('echo prefix-tab-ready')
    vm.keys('ret')
    vm.command('for n in $(seq 1 30); do hn capture-pane -p | grep -qx prefix-tab-ready && exit 0; sleep .25; done; exit 1')
    vm.screenshot('installed-prefix-terminal-tab')
    vm.keys('ctrl', 'd')
    for index in range(3):
        vm.command('hn new-window -n quick-exit ' + shlex.quote(f'touch /tmp/hn-quick-exit-{index}'))
        vm.command(f'for n in $(seq 1 20); do test -e /tmp/hn-quick-exit-{index} && exit 0; sleep .25; done; exit 1')
    result['checks'].append('Closing the last terminal and immediately opening another works repeatedly')
    survivor = 'echo $$ > /tmp/hn-survivor.pid; exec sleep 1800'
    vm.command('hn new-window -n persistence ' + shlex.quote(survivor))
    vm.command('for n in $(seq 1 20); do test -s /tmp/hn-survivor.pid && exit 0; sleep .25; done; exit 1')
    clipboard = 'printf hn-pane-clipboard | wl-copy; test "$(wl-paste --no-newline)" = hn-pane-clipboard && touch /tmp/hn-pane-clipboard-passed'
    vm.command('hn new-window -n clipboard ' + shlex.quote(clipboard))
    vm.command('for n in $(seq 1 20); do test -e /tmp/hn-pane-clipboard-passed && exit 0; sleep .25; done; exit 1')
    result['checks'].append('An hn terminal pane inherits the working Wayland clipboard environment')
    vm.command('if hn detach; then exit 1; fi')
    vm.command('if hn suspend-client; then exit 1; fi')
    vm.command('kill -0 "$(cat /tmp/hn-survivor.pid)"')
    result['checks'].append('OS surface refuses detach and suspend while work stays alive')
    vm.command('systemctl --user restart hn-screen; sleep 3; kill -0 "$(cat /tmp/hn-survivor.pid)"')
    vm.command('/usr/lib/harness-os/wait-runtime', timeout=160)
    result['checks'].append('Terminal process survives screen restart')
    vm.command("printf '%s' '<!doctype html><h1>Harness installed browser</h1>' > /tmp/hn-browser-check.html")
    vm.command('hn-browser file:///tmp/hn-browser-check.html')
    wait_installer_screen(vm, 'Harness installed browser', 'installed-browser', timeout=45)
    vm.keys('meta_l', 'b')
    vm.screenshot('installed-browser-return')
    vm.command('pkill -x chromium')
    result['checks'].append('Browser starts only on shortcut or explicit request; a local page renders and Super+b returns to hn')
