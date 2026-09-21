/// Where the agent CLIs keep the tokens their usage endpoints want.
///
/// This app reads them; it never writes them and never refreshes them. One
/// sign-in per machine, owned by the CLI that made it. A second copy here
/// would be a second thing to expire and to disagree about.
///
/// **Nothing in this file may be logged.** Every value it returns is a bearer
/// token; the CLI transcript exists precisely so secrets stay out of argv, and
/// a `print` here would undo that. Callers get the token and nothing else —
/// no wrapper carrying it into an error message.
library;

import 'dart:convert';
import 'dart:io';

import 'package:cryptography/dart.dart';

/// A token, and when it stops working.
class UsageToken {
  const UsageToken({required this.accessToken, this.expiresAt});

  final String accessToken;

  /// When the token expires, when the store said so. Null means unknown, which
  /// is treated as "try it" rather than "assume dead" — the endpoint answering
  /// 401 is a better authority than a clock we may be reading wrong.
  final DateTime? expiresAt;

  /// Already dead, so the request can be skipped and reported as a sign-in
  /// rather than spent as a round trip that will fail.
  bool get isExpired {
    final at = expiresAt;
    return at != null && at.isBefore(DateTime.now());
  }
}

/// Reads the tokens the usage endpoints need, from wherever each CLI put them.
class UsageCredentials {
  const UsageCredentials({this.home, this.runProcess, this.environment});

  /// Overridden by tests. Null means this machine's real home.
  final String? home;

  /// Overridden by tests. Null means this process's real environment — the same one Claude Code
  /// reads `USER` and `CLAUDE_CONFIG_DIR` from when it names its Keychain item.
  final Map<String, String>? environment;

  /// Overridden by tests so nothing shells out to the real `security`.
  final Future<ProcessResult> Function(String, List<String>)? runProcess;

  String? get _home => home ?? Platform.environment['HOME'];
  Map<String, String> get _env => environment ?? Platform.environment;

  /// The Keychain SERVICE Claude Code writes its OAuth token under — its own rule, read off
  /// Claude Code 2.1.272: `Claude Code-credentials`, plus `-<sha256(configDir)[0..8]>` when
  /// `CLAUDE_CONFIG_DIR` is set, so profiles kept in different directories get different items.
  /// (`CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides the directory that is hashed; empty means the
  /// plain name even with a config dir set.)
  static String keychainService(Map<String, String> env) {
    final secure = env['CLAUDE_SECURESTORAGE_CONFIG_DIR'];
    final configDir = env['CLAUDE_CONFIG_DIR'];
    final plain = secure != null
        ? secure.isEmpty
        : configDir == null || configDir.isEmpty;
    if (plain) return _claudeKeychainService;
    final hashed = secure ?? configDir!;
    final digest = const DartSha256().hashSync(utf8.encode(hashed)).bytes;
    final prefix = digest
        .take(4)
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    return '$_claudeKeychainService-$prefix';
  }

  /// The Keychain ACCOUNT Claude Code writes under — again its own rule: `USER`, else the OS
  /// username, and a fixed placeholder when that is not a plain account name.
  ///
  /// ⚠️ This is the half that was missing. `security find-generic-password -s <service>` alone
  /// returns whichever item matches the service FIRST, and a Keychain that has seen more than one
  /// account (a stale item under another user name, say) answered with the stale one — an expired
  /// token, so the menu said "Not signed in" beside a Claude Code that was signed in and working.
  static String keychainAccount(
    Map<String, String> env, {
    required String username,
  }) {
    final name = env['USER'] ?? username;
    return _claudeAccountPattern.hasMatch(name) ? name : 'claude-code-user';
  }

  static const _claudeKeychainService = 'Claude Code-credentials';
  static final _claudeAccountPattern = RegExp(r'^[a-zA-Z0-9._-]+$');

  /// Claude Code's OAuth token.
  ///
  /// macOS keeps it in the login Keychain and Linux in a file, so both are
  /// tried in that order — and the file is tried on macOS too, because a
  /// Keychain that will not answer (a locked login chain, a Finder launch with
  /// no authorization) is a state, not the end of the road.
  Future<UsageToken?> claude() async {
    final fromKeychain = await _readKeychain();
    final token =
        _parseClaude(fromKeychain) ??
        _parseClaude(_readFile('.claude/.credentials.json'));
    return token;
  }

  /// Codex's OAuth token, written by `codex login`.
  Future<UsageToken?> codex() async {
    final raw = _readFile('.codex/auth.json');
    if (raw == null) return null;
    final decoded = _decode(raw);
    final tokens = decoded?['tokens'];
    if (tokens is! Map) return null;
    final access = tokens['access_token'];
    if (access is! String || access.isEmpty) return null;
    return UsageToken(accessToken: access);
  }

  /// The account id Codex's backend scopes the reading to.
  Future<String?> codexAccountId() async {
    final decoded = _decode(_readFile('.codex/auth.json'));
    final tokens = decoded?['tokens'];
    if (tokens is! Map) return null;
    final id = tokens['account_id'];
    return id is String && id.isNotEmpty ? id : null;
  }

  /// The account Claude Code is signed in as: `oauthAccount.accountUuid` in
  /// `~/.claude.json`, which is where it records who it is on every platform.
  /// The token store — Keychain or `.credentials.json` — does not carry it.
  Future<String?> claudeAccountId() async {
    final profile = _decode(_readFile('.claude.json'))?['oauthAccount'];
    if (profile is! Map) return null;
    final id = profile['accountUuid'];
    return id is String && id.isNotEmpty ? id : null;
  }

  UsageToken? _parseClaude(String? raw) {
    if (raw == null) return null;
    final oauth = _decode(raw)?['claudeAiOauth'];
    if (oauth is! Map) return null;
    final access = oauth['accessToken'];
    if (access is! String || access.isEmpty) return null;
    final expires = oauth['expiresAt'];
    return UsageToken(
      accessToken: access,
      expiresAt: expires is num
          ? DateTime.fromMillisecondsSinceEpoch(expires.round())
          : null,
    );
  }

  Map<String, Object?>? _decode(String? raw) {
    if (raw == null) return null;
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map<String, Object?> ? decoded : null;
    } on FormatException {
      // A half-written credentials file is not news: the CLI that owns it is
      // mid-refresh, and the next poll a minute from now will read it whole.
      return null;
    }
  }

  String? _readFile(String relative) {
    final home = _home;
    if (home == null) return null;
    final file = File('$home${Platform.pathSeparator}$relative');
    if (!file.existsSync()) return null;
    try {
      return file.readAsStringSync();
    } on FileSystemException {
      return null;
    }
  }

  /// The macOS Keychain item Claude Code writes — looked up by service AND account, exactly the
  /// way Claude Code reads it back ([keychainService], [keychainAccount]), so this app and the
  /// CLI that signed in cannot be reading two different items.
  ///
  /// `security` is used rather than a plugin because the item is a plain
  /// generic password and this is one read on a timer — a native channel would
  /// be a second thing to keep in step across two platforms for it.
  Future<String?> _readKeychain() async {
    if (!Platform.isMacOS && runProcess == null) return null;
    final run = runProcess ?? Process.run;
    final env = _env;
    try {
      final result = await run('security', [
        'find-generic-password',
        '-a',
        // Claude Code falls back to `os.userInfo().username`; the nearest thing here is LOGNAME.
        keychainAccount(env, username: env['LOGNAME'] ?? 'claude-code-user'),
        '-s',
        keychainService(env),
        '-w',
      ]);
      if (result.exitCode != 0) return null;
      final out = result.stdout;
      return out is String && out.trim().isNotEmpty ? out.trim() : null;
    } on ProcessException {
      return null;
    }
  }
}
