// How the app finds Claude Code's OAuth token in the macOS Keychain — the same lookup Claude Code
// itself performs, or it reads a different item than the CLI that is signed in.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/usage_credentials.dart';

/// A Keychain holding several `Claude Code-credentials` items, the way a real one does after a
/// few years of use: the first item `security` returns for the bare service name is a stale one
/// under another account, and the live one is keyed by THIS user's account.
class _Keychain {
  _Keychain({required this.user});
  final String user;
  final calls = <List<String>>[];

  static String _item(int expiresAt) =>
      '{"claudeAiOauth":{"accessToken":"tok-$expiresAt","refreshToken":"r","expiresAt":$expiresAt}}';

  Future<ProcessResult> run(String executable, List<String> args) async {
    calls.add([executable, ...args]);
    if (executable != 'security') {
      return ProcessResult(0, 1, '', 'no such command');
    }
    final service = args[args.indexOf('-s') + 1];
    final account = args.contains('-a') ? args[args.indexOf('-a') + 1] : null;
    // Only the plain service, the way current Claude Code names it without CLAUDE_CONFIG_DIR.
    if (service != 'Claude Code-credentials') {
      return ProcessResult(0, 44, '', 'not found');
    }
    // The stale first match — what `security` answers for the bare service name.
    if (account == null) return ProcessResult(0, 0, _item(1000), '');
    // 2100-01-01: the live item, under this user's account.
    if (account == user) return ProcessResult(0, 0, _item(4102444800000), '');
    return ProcessResult(0, 44, '', 'not found');
  }
}

void main() {
  test(
    'reads the item Claude Code itself reads: service AND this user\'s account',
    () async {
      final keychain = _Keychain(user: 'macbookpro');
      final credentials = UsageCredentials(
        home: Directory.systemTemp.path,
        environment: const {'USER': 'macbookpro'},
        runProcess: keychain.run,
      );

      final token = await credentials.claude();

      expect(token?.accessToken, 'tok-4102444800000');
      expect(token?.isExpired, isFalse);
      final security = keychain.calls.singleWhere((c) => c.first == 'security');
      expect(security, containsAllInOrder(['-a', 'macbookpro']));
      expect(security, containsAllInOrder(['-s', 'Claude Code-credentials']));
    },
  );

  test('falls back to the OS username when USER is unset, and to Claude Code\'s placeholder when it is unusable', () {
    expect(
      UsageCredentials.keychainAccount(const {}, username: 'macbookpro'),
      'macbookpro',
    );
    // Claude Code refuses an account name outside `[a-zA-Z0-9._-]` and uses a fixed one instead,
    // so the same name has to be looked up here or the item is simply never found.
    expect(
      UsageCredentials.keychainAccount(const {
        'USER': 'mac book',
      }, username: 'ignored'),
      'claude-code-user',
    );
    expect(
      UsageCredentials.keychainAccount(const {
        'USER': 'kelvin.dev',
      }, username: 'ignored'),
      'kelvin.dev',
    );
  });

  test('names the per-profile item when CLAUDE_CONFIG_DIR is set, as Claude Code does', () {
    expect(
      UsageCredentials.keychainService(const {}),
      'Claude Code-credentials',
    );
    // sha256('/Users/macbookpro/.claude-work').substring(0, 8) — a worked example, not recomputed
    // here, so a drift in the hashing would be caught rather than mirrored.
    expect(
      UsageCredentials.keychainService(const {
        'CLAUDE_CONFIG_DIR': '/Users/macbookpro/.claude-work',
      }),
      'Claude Code-credentials-${_sha256Prefix('/Users/macbookpro/.claude-work')}',
    );
  });
}

/// The known-good prefix for the profile-dir example above, computed once with
/// `printf '%s' '/Users/macbookpro/.claude-work' | shasum -a 256 | cut -c1-8`.
String _sha256Prefix(String dir) {
  const known = {'/Users/macbookpro/.claude-work': '138c714b'};
  return known[dir]!;
}
