"""A pull request's Desktop and CLI, run as "Harness Test" beside the installed app.

Design: docs/plans/2026-11-03-desktop-test-flavor-design.md. The test flavor runs with its own HOME, so everything
Desktop and the CLI keep under ~/.harness is its own. The few per-user resources HOME does not move (the daemon port,
the tmux server, Claude Code's Keychain item, Codex's home, the self-updater) are moved by flavor_env, and the copied
app gets its own bundle id and gives up the harness:// links.
"""
import copy
import hashlib
from pathlib import Path

TEST_ID = 'ai.autonomous.harness.test'
TEST_NAME = 'Harness Test'

CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'


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
