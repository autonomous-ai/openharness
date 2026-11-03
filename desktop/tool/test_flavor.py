"""A pull request's Desktop and CLI, run as "Harness Test" beside the installed app.

    python3 desktop/tool/test_flavor.py start     # build this checkout's CLI and Desktop and start "Harness Test"
    python3 desktop/tool/test_flavor.py status    # its home, port, app and signed-in test account
    python3 desktop/tool/test_flavor.py stop      # quit it and remove everything it made
    python3 desktop/tool/test_flavor.py forget    # sign the test account out on this Mac

Design: docs/plans/2026-11-03-desktop-test-flavor-design.md. The test flavor runs with its own HOME, so everything
Desktop and the CLI keep under ~/.harness is its own. The few per-user resources HOME does not move (the daemon port,
the tmux server, Claude Code's Keychain item, Codex's home, the self-updater) are moved by flavor_env, and the copied
app gets its own bundle id and gives up the harness:// links.
"""
import base64
import binascii
import copy
import hashlib
import json
import os
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

TEST_ID = 'ai.autonomous.harness.test'
TEST_NAME = 'Harness Test'

CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

SAME_ACCOUNT = "The test copy signed in as this Mac's own account. Sign it in with the test account instead."


class Refused(Exception):
    """A step the test flavor will not take, in words for the Tester."""


class SameAccount(Refused):
    """The test copy is, or may be, signed in as the Mac owner's account."""


def flavor_env(base, test_home, shared, port):
    """The test flavor's environment: [base] with every per-user resource moved into [test_home].

    [shared] (~/.harness-test) keeps the test account's sign-in and this Mac's test computer id, reused across runs.
    """
    env = dict(base)
    claude = str(test_home / '.claude')
    env.update({
        'HOME': str(test_home),
        'PORT': str(port),
        'TMUX_TMPDIR': str(test_home / 'tmux'),
        # Claude Code names its Keychain item from these; the CLI's refresh write reads only the second
        # (cli/src/lib/agentCredentials.ts claudeKeychainService), so both are set.
        'CLAUDE_CONFIG_DIR': claude,
        'CLAUDE_SECURESTORAGE_CONFIG_DIR': claude,
        'CODEX_HOME': str(test_home / '.codex'),
        'HARNESS_AUTH_DIR': str(shared / 'auth'),
        'ADAPTER_COMPUTER_ID_FILE': str(shared / 'computer-id'),
        # The PR's CLI is what is being tested: it must never update itself into the released one.
        'ADAPTER_UPDATE_DISABLE': '1',
    })
    return env


def claude_keychain_service(env):
    """The Keychain service Claude Code and the CLI use under [env] (cli/src/lib/agentCredentials.ts)."""
    secure = env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')
    hashed = secure if secure is not None else env.get('CLAUDE_CONFIG_DIR')
    if not hashed:
        return CLAUDE_KEYCHAIN_SERVICE
    return f'{CLAUDE_KEYCHAIN_SERVICE}-{hashlib.sha256(hashed.encode()).hexdigest()[:8]}'


def patch_info(info):
    """A copy of the app's Info.plist with the test flavor's identity and no harness:// scheme."""
    patched = copy.deepcopy(info)
    patched['CFBundleIdentifier'] = TEST_ID
    patched['CFBundleName'] = TEST_NAME
    patched['CFBundleDisplayName'] = TEST_NAME
    patched['CFBundleExecutable'] = TEST_NAME
    patched.pop('CFBundleURLTypes', None)
    return patched


def install_cli(cli_dir, test_home, node):
    """The PR's own CLI, bundled into [test_home] where Desktop looks first (lib/core/harness_cli_runner.dart).

    `npm run bundle` writes one self-contained cli.js to BUNDLE_OUT_DIR. Desktop runs it with the Node that
    runtime/current-node names, which must sit inside runtime/, so [node] is linked there. Returns cli.js.
    """
    harness = test_home / '.harness'
    out = harness / 'cli'
    out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, BUNDLE_OUT_DIR=str(out), PATH=f'{node.parent}{os.pathsep}{os.environ.get("PATH", "")}')
    subprocess.run(['npm', 'run', '--silent', 'bundle'], cwd=cli_dir, env=env, check=True,
                   stdout=subprocess.DEVNULL)
    runtime = harness / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    linked = runtime / 'node'
    if linked.is_symlink() or linked.exists():
        linked.unlink()
    linked.symlink_to(node.resolve())
    (runtime / 'current-node').write_text(f'{linked}\n')
    cli = out / 'cli.js'
    if not cli.is_file():
        raise RuntimeError(f'the CLI bundle did not write {cli}')
    return cli


def session_account(path):
    """The account id a CLI session.json (cli/src/lib/authSession.ts) was signed in to, or None.

    `signInAcct` when the session has it; for an older one, the access token's subject, decoded here and never
    printed or returned. Missing or unreadable is None.
    """
    try:
        session = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(session, dict):
        return None
    account = session.get('signInAcct')
    if isinstance(account, str) and account:
        return account
    token = session.get('accessToken')
    if not isinstance(token, str) or token.count('.') != 2:
        return None
    payload = token.split('.')[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    except (ValueError, binascii.Error):
        return None
    subject = claims.get('sub') if isinstance(claims, dict) else None
    return subject if isinstance(subject, str) and subject else None


def check_not_owner(real, test):
    """Refuses a test sign-in that is the person's own account, or that cannot be told apart from it."""
    if test is None or test == real:
        raise SameAccount(SAME_ACCOUNT)


@dataclass(frozen=True)
class Paths:
    repo: Path
    shared: Path  # ~/.harness-test: the test account's sign-in and this Mac's test computer id
    person_home: Path  # ~: read only for the person's account id

    @property
    def build(self):
        return self.repo / 'desktop/build/test-flavor'

    @property
    def state(self):
        return self.build / 'state.json'

    @property
    def app(self):
        return self.build / f'{TEST_NAME}.app'

    @property
    def built_app(self):
        return self.repo / 'desktop/build/macos/Build/Products/Debug/Harness.app'

    @property
    def test_session(self):
        return self.shared / 'auth/session.json'

    @property
    def person_session(self):
        return self.person_home / '.harness/auth/session.json'


class Runner:
    """The processes the test flavor starts and stops: its own build, CLI, app and tmux server, never another's."""

    def run(self, argv, env=None, interactive=False, check=True):
        if interactive:
            return subprocess.run([str(a) for a in argv], env=env, check=check)
        return subprocess.run([str(a) for a in argv], env=env, check=check, capture_output=True, text=True)

    def launch(self, argv, env):
        return subprocess.Popen([str(a) for a in argv], env=env, start_new_session=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).pid

    def alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def terminate(self, pid):
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            if not self.alive(pid):
                return
            time.sleep(0.2)

    def port_free(self, port):
        with socket.socket() as s:
            try:
                s.bind(('127.0.0.1', port))
            except OSError:
                return False
        return True


def choose_port(runner, start=18474, end=18999):
    for port in range(start, end):
        if runner.port_free(port):
            return port
    raise Refused(f'No free port between {start} and {end} for the test daemon.')


def _cli(test_home):
    return test_home / '.harness/runtime/node', test_home / '.harness/cli/cli.js'


def _read_state(paths):
    try:
        return json.loads(paths.state.read_text())
    except (OSError, ValueError):
        return None


def _copy_app(runner, paths):
    if paths.app.exists():
        shutil.rmtree(paths.app)
    paths.build.mkdir(parents=True, exist_ok=True)
    runner.run(['ditto', paths.built_app, paths.app])
    info_path = paths.app / 'Contents/Info.plist'
    with info_path.open('rb') as source:
        info = plistlib.load(source)
    executable = paths.app / 'Contents/MacOS' / info.get('CFBundleExecutable', 'Harness')
    with info_path.open('wb') as out:
        plistlib.dump(patch_info(info), out)
    executable.rename(paths.app / 'Contents/MacOS' / TEST_NAME)
    runner.run(['codesign', '--force', '--sign', '-',
                '--preserve-metadata=entitlements,requirements,flags,runtime', paths.app])


def start(runner, paths, installer):
    if paths.state.exists():
        raise Refused('A test copy is already running; run stop first.')
    port = choose_port(runner)
    test_home = Path(tempfile.mkdtemp(prefix='harness-test-flavor.'))
    launched = False
    try:
        node = Path(shutil.which('node') or 'node')
        cli = installer(paths.repo / 'cli', test_home, node)
        env = flavor_env(dict(os.environ), test_home, paths.shared, port)
        if session_account(paths.test_session) is None:
            print('Sign the test copy in with the test account, in a private browser window:')
            runner.run([_cli(test_home)[0], cli, 'login', '--code'], env=env, interactive=True)
        try:
            check_not_owner(session_account(paths.person_session), session_account(paths.test_session))
        except SameAccount:
            runner.run([_cli(test_home)[0], cli, 'logout', '--from-sign-out-button'], env=env, check=False)
            shutil.rmtree(paths.shared / 'auth', ignore_errors=True)
            raise
        runner.run(['bash', paths.repo / 'desktop/scripts/build-macos-debug.sh', '--no-pub',
                    f'--dart-define=HARNESS_DAEMON_PORT={port}'])
        _copy_app(runner, paths)
        if not runner.port_free(port):
            raise Refused(f'Port {port} was taken; run start again.')
        pid = runner.launch([paths.app / 'Contents/MacOS' / TEST_NAME], env)
        launched = True
        paths.state.write_text(json.dumps({'testHome': str(test_home), 'port': port, 'appPid': pid,
                                           'app': str(paths.app)}))
    finally:
        if not launched:
            shutil.rmtree(test_home, ignore_errors=True)
            shutil.rmtree(paths.app, ignore_errors=True)
    print(f'{TEST_NAME} is running: home {test_home}, port {port}, test account {session_account(paths.test_session)}.')
    print('When the test is done: python3 desktop/tool/test_flavor.py stop')
    return 0


def status(runner, paths):
    state = _read_state(paths)
    if state is None:
        print('No test copy is running.')
        return 0
    print(f"home {state['testHome']}, port {state['port']}, app pid {state['appPid']} "
          f"({'running' if runner.alive(state['appPid']) else 'not running'})")
    try:
        check_not_owner(session_account(paths.person_session), session_account(paths.test_session))
    except SameAccount as refused:
        print(refused)
        return 1
    print(f'test account {session_account(paths.test_session)}')
    return 0


def stop(runner, paths):
    state = _read_state(paths)
    if state is None:
        print('No test copy is running.')
        return 0
    problems = []
    pid = state.get('appPid')
    if isinstance(pid, int) and runner.alive(pid):
        runner.terminate(pid)
    test_home = Path(state['testHome'])
    node, cli = _cli(test_home)
    env = flavor_env(dict(os.environ), test_home, paths.shared, state['port'])
    if cli.exists():
        if runner.run([node, cli, 'stop'], env=env, check=False).returncode != 0:
            problems.append('the test daemon did not stop cleanly')
    tmux_socket = test_home / 'tmux' / f'tmux-{os.getuid()}' / 'default'
    if tmux_socket.exists():
        runner.run(['tmux', '-S', tmux_socket, 'kill-server'], check=False)
    for path in (test_home, Path(state.get('app', paths.app))):
        shutil.rmtree(path, ignore_errors=True)
        if path.exists():
            problems.append(f'could not remove {path}')
    paths.state.unlink(missing_ok=True)
    for problem in problems:
        print(f'stop: {problem}')
    return 1 if problems else 0


def forget(runner, paths, installer):
    if paths.state.exists():
        raise Refused('A test copy is running; run stop first.')
    if session_account(paths.test_session) is not None:
        test_home = Path(tempfile.mkdtemp(prefix='harness-test-flavor.'))
        try:
            cli = installer(paths.repo / 'cli', test_home, Path(shutil.which('node') or 'node'))
            env = flavor_env(dict(os.environ), test_home, paths.shared, choose_port(runner))
            runner.run([_cli(test_home)[0], cli, 'logout', '--from-sign-out-button'], env=env, check=False)
        finally:
            shutil.rmtree(test_home, ignore_errors=True)
    shutil.rmtree(paths.shared, ignore_errors=True)
    print('The test account is signed out on this Mac. Its one test machine stays in the test account until removed '
          'from its Machines list.')
    return 0


def main(argv, runner=None, paths=None, installer=install_cli):
    if runner is None and sys.platform != 'darwin':
        raise Refused('The Desktop test flavor runs on macOS.')
    runner = runner or Runner()
    paths = paths or Paths(repo=Path(__file__).resolve().parents[2], shared=Path.home() / '.harness-test',
                           person_home=Path.home())
    command = argv[0] if argv else ''
    if command == 'start':
        return start(runner, paths, installer)
    if command == 'status':
        return status(runner, paths)
    if command == 'stop':
        return stop(runner, paths)
    if command == 'forget':
        return forget(runner, paths, installer)
    print(__doc__)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Refused as refused:
        print(refused, file=sys.stderr)
        sys.exit(1)
