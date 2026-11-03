"""A pull request's Desktop and CLI, run as "Harness Test" beside the installed app.

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
import subprocess
from pathlib import Path

TEST_ID = 'ai.autonomous.harness.test'
TEST_NAME = 'Harness Test'

CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

SAME_ACCOUNT = "The test copy signed in as this Mac's own account. Sign it in with the test account instead."


class SameAccount(Exception):
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
