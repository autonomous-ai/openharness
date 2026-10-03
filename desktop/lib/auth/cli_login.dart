import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../core/harness_cli_runner.dart';
import 'phone_sign_in.dart';
import 'sign_in_client.dart';
import 'sign_in_provider.dart';

class CliAuthStatus {
  final bool loggedIn;

  /// Signed in, but the CLI could not refresh the token just now (no network, SSO down). Still
  /// [loggedIn]: the session is on disk and the daemon runs on it; only the backend is out of reach.
  final bool offline;
  final String? computerId;
  final String? machineId;
  final String? autonomousEnv;

  const CliAuthStatus({
    required this.loggedIn,
    this.offline = false,
    this.computerId,
    this.machineId,
    this.autonomousEnv,
  });

  factory CliAuthStatus.fromJson(Map<String, dynamic> json) => CliAuthStatus(
    loggedIn: json['loggedIn'] == true,
    offline: json['offline'] == true,
    computerId: json['computerId'] as String?,
    machineId: json['machineId'] as String?,
    autonomousEnv: json['autonomousEnv'] as String?,
  );
}

/// Thrown when the `harness` CLI itself could not be run at all (the managed
/// runtime, installed launcher, and PATH are all unavailable) — distinct from
/// the CLI running fine and reporting "not signed in".
class CliNotAvailableException implements Exception {
  final String message;
  CliNotAvailableException(this.message);
  @override
  String toString() => message;
}

/// Talks to the local `harness` CLI for everything auth-related: whether this computer already has a
/// signed-in session, and driving `harness login --json`'s NDJSON event stream when it does not. The
/// CLI owns the SSO session end to end (`~/.harness/auth/session.json`) — this app never sees, stores,
/// or refreshes an access token itself.
class CliLogin implements SignInClient, PhoneSignInClient {
  final HarnessCliRunner _runner;
  Process? _activeProcess;
  int _loginRevision = 0;

  CliLogin({HarnessCliRunner? runner}) : _runner = runner ?? HarnessCliRunner();

  /// While a sign-in waits on something before it can start — another sign-in on this computer
  /// still holding the daemon spawn lock — what the CLI said about it (its `waiting` event); null
  /// otherwise. A wait the app shows nothing for reads as a sign-in that is broken.
  final ValueNotifier<String?> waitingNote = ValueNotifier(null);

  @override
  Future<CliAuthStatus> checkStatus() async {
    final result = await _run(['auth', 'status', '--json']);
    final line = _lastNonEmptyLine(result.stdout as String);
    if (line == null) {
      throw CliNotAvailableException(
        'Could not run the harness CLI (${(result.stderr as String).trim().isEmpty ? 'exit ${result.exitCode}' : (result.stderr as String).trim()}). '
        'Make sure it is installed and try again.',
      );
    }
    return CliAuthStatus.fromJson(jsonDecode(line) as Map<String, dynamic>);
  }

  /// Runs `harness login --force --json`. This is only ever reached from [LoginScreen], i.e. the app
  /// has already decided this computer is signed out — so a stale-but-present session file on disk
  /// must not short-circuit into a silent refresh attempt (`loginCommand`'s `readAuthSession() &&
  /// !force` branch), which just re-reports the same failure forever instead of opening a fresh SSO
  /// flow. Calls [onAuthorizeUrl] as soon as the CLI reports the SSO page to show, then resolves once
  /// the CLI's own loopback callback server completes the flow (or throws on failure/cancellation).
  /// The process is killed if [cancel] is called while this is in flight.
  ///
  /// [provider] is `--google` or `--apple`. One token, so a CLI that predates the flags ignores it
  /// like any unknown flag and opens the SSO page's own chooser.
  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInProvider? provider,
  }) => _login([
    if (provider != null) '--${provider.name}',
  ], onAuthorizeUrl: onAuthorizeUrl);

  /// `harness login --qr`: the QR arrives as an event, and so does the question of whose account
  /// approved it — answered with a `yes` or `no` line on the process's standard input.
  @override
  Future<void> loginWithPhone({
    required void Function(String link, int expiresIn) onQr,
    required Future<bool> Function(String email) onConfirm,
  }) => _login(const ['--qr'], onQr: onQr, onConfirm: onConfirm);

  Future<void> _login(
    List<String> extra, {
    void Function(String url)? onAuthorizeUrl,
    void Function(String link, int expiresIn)? onQr,
    Future<bool> Function(String email)? onConfirm,
  }) async {
    // A cancelled spawn can finish after a replacement login has started.
    // Each process owns only its attempt, including its eventual cleanup.
    final revision = ++_loginRevision;
    final Process process;
    try {
      // `--entry-point=desktop` tells login tracking this sign-in came from the app rather than a
      // terminal. One token, so a CLI that predates the flag ignores it like any unknown flag.
      process = await _runner.start([
        'login',
        '--force',
        '--json',
        ...extra,
        '--entry-point=desktop',
      ]);
    } catch (error) {
      throw CliNotAvailableException('Could not run the harness CLI: $error');
    }
    if (revision != _loginRevision) {
      unawaited(process.stdout.drain<void>());
      unawaited(process.stderr.drain<void>());
      process.kill();
      throw StateError('Sign-in was cancelled.');
    }
    _activeProcess = process;
    // Drained unconditionally: an unread stderr pipe can fill its OS buffer and block the child
    // process from writing more output at all, which would otherwise look exactly like a hang here.
    process.stderr.drain<void>();
    try {
      final lines = process.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter());
      var gotResult = false;
      var success = false;
      String? message;
      String? code;
      var tooOld = false;
      await for (final raw in lines) {
        if (revision != _loginRevision) continue;
        final line = raw.trim();
        if (line.isEmpty) continue;
        Map<String, dynamic> json;
        try {
          json = jsonDecode(line) as Map<String, dynamic>;
        } catch (_) {
          continue;
        }
        if (json['type'] != 'waiting') waitingNote.value = null;
        switch (json['type']) {
          case 'waiting':
            final note = json['message'];
            if (note is String && note.isNotEmpty) waitingNote.value = note;
          case 'authorize_url':
            // Asked for a QR and given a browser page: a CLI from before `--qr`, which ignores the
            // flag and starts SSO. Nothing would ever be shown — stop it and say why.
            if (onQr != null) {
              tooOld = true;
              process.kill();
              break;
            }
            final url = json['url'];
            if (url is String) onAuthorizeUrl?.call(url);
          case 'qr':
            final url = json['url'], expiresIn = json['expiresIn'];
            if (url is String) {
              onQr?.call(url, expiresIn is int ? expiresIn : 120);
            }
          case 'confirm':
            final email = json['email'];
            final yes =
                email is String && onConfirm != null && await onConfirm(email);
            if (revision != _loginRevision) break;
            process.stdin.writeln(yes ? 'yes' : 'no');
            await process.stdin.flush();
          case 'result':
            gotResult = true;
            success = json['status'] == 'success';
            message = json['message'] as String?;
            code = json['code'] as String?;
        }
      }
      final exitCode = await process.exitCode;
      if (revision != _loginRevision) {
        throw StateError('Sign-in was cancelled.');
      }
      if (tooOld) {
        throw const PhoneSignInException(
          'CLI_TOO_OLD',
          'This computer\'s Harness CLI is too old to sign in with a phone. Continue with Google or Apple, or update Harness.',
        );
      }
      if (!gotResult || !success) {
        final text =
            message ??
            (exitCode != 0
                ? 'Sign-in was cancelled.'
                : 'Sign-in did not complete.');
        // A phone sign-in says why it ended, so the screen can offer the right next step.
        if (onQr != null && code != null) {
          throw PhoneSignInException(code, text);
        }
        throw StateError(text);
      }
    } finally {
      if (identical(_activeProcess, process)) _activeProcess = null;
      if (revision == _loginRevision) waitingNote.value = null;
    }
  }

  /// Aborts this attempt even if its process has not finished starting yet —
  /// reached from the embedded sign-in webview's close button.
  @override
  void cancel() {
    ++_loginRevision;
    waitingNote.value = null;
    final process = _activeProcess;
    _activeProcess = null;
    process?.kill();
  }

  @override
  Future<void> logout() async {
    // Own a process handle: a timed-out logout must not remain alive and erase
    // the credentials saved by the user's next sign-in.
    final Process process;
    try {
      process = await _runner.start(['logout']);
    } catch (error) {
      throw CliNotAvailableException('Could not run the harness CLI: $error');
    }
    try {
      int? exitCode;
      await Future.wait<void>([
        process.stdout.drain<void>(),
        process.stderr.drain<void>(),
        process.exitCode.then((value) => exitCode = value),
      ]).timeout(_runner.runTimeout);
      if (exitCode != 0) {
        throw StateError('Could not finish signing out. Try again.');
      }
    } on TimeoutException {
      process.kill();
      try {
        await process.exitCode.timeout(const Duration(seconds: 1));
      } on TimeoutException {
        process.kill(ProcessSignal.sigkill);
        await process.exitCode;
      }
      throw StateError('Sign-out took too long. Try again.');
    }
  }

  Future<ProcessResult> _run(List<String> arguments) async {
    try {
      return await _runner.run(arguments);
    } catch (error) {
      throw CliNotAvailableException('Could not run the harness CLI: $error');
    }
  }

  String? _lastNonEmptyLine(String stdout) {
    final lines = stdout.trim().split('\n').where((l) => l.trim().isNotEmpty);
    return lines.isEmpty ? null : lines.last.trim();
  }
}
