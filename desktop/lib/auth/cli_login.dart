import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show immutable;

import 'dart:io';

import '../core/harness_cli_runner.dart';
import 'sign_in_client.dart';

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
class CliLogin implements SignInClient {
  final HarnessCliRunner _runner;
  Process? _activeProcess;
  int _loginRevision = 0;

  CliLogin({HarnessCliRunner? runner}) : _runner = runner ?? HarnessCliRunner();

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
  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInQrListener? qr,
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
        '--entry-point=desktop',
        // By phone: the CLI shows a QR instead of opening SSO, and once signed in links the phone
        // and joins its trust group in the same process.
        if (qr != null) '--qr',
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
      // A sign-in by phone is done at its `result`: the process stays on to link the phone and
      // join the trust group, reporting that through [SignInQrListener.onProgress] — the app does
      // not wait for it.
      final signedIn = Completer<void>();
      final reading = () async {
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
          switch (json['type']) {
            case 'authorize_url':
              final url = json['url'];
              if (url is String) onAuthorizeUrl(url);
            case 'qr':
              final url = json['url'], expires = json['expiresAt'];
              if (url is String && qr != null) {
                qr.onQr(
                  SignInQr(
                    url: url,
                    fingerprint: json['fingerprint'] as String?,
                    expiresAt: expires is int
                        ? DateTime.fromMillisecondsSinceEpoch(expires)
                        : null,
                  ),
                );
              }
            case 'result' when !gotResult:
              gotResult = true;
              success = json['status'] == 'success';
              message = json['message'] as String?;
              if (qr != null && success && !signedIn.isCompleted) {
                signedIn.complete();
              }
            case final String type:
              qr?.onProgress?.call(type, json);
          }
        }
      }();
      if (qr != null) {
        await Future.any([signedIn.future, reading]);
        if (signedIn.isCompleted) {
          // Signed in; the rest belongs to the process, not to this attempt.
          if (identical(_activeProcess, process)) _activeProcess = null;
          // The link leg's end is news too: a process that stops before `synced` did not link.
          unawaited(
            reading
                .catchError((Object _) {})
                .whenComplete(() => qr.onProgress?.call('ended', const {})),
          );
          return;
        }
      } else {
        await reading;
      }
      final exitCode = await process.exitCode;
      if (revision != _loginRevision) {
        throw StateError('Sign-in was cancelled.');
      }
      if (!gotResult || !success) {
        throw StateError(
          message ??
              (exitCode != 0
                  ? 'Sign-in was cancelled.'
                  : 'Sign-in did not complete.'),
        );
      }
    } finally {
      if (identical(_activeProcess, process)) _activeProcess = null;
    }
  }

  /// Aborts this attempt even if its process has not finished starting yet —
  /// reached from the embedded sign-in webview's close button.
  @override
  void cancel() {
    ++_loginRevision;
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

/// The QR a sign-in by phone shows (`harness login --qr --json`'s `qr` event).
@immutable
class SignInQr {
  const SignInQr({required this.url, this.fingerprint, this.expiresAt});

  /// The link the QR encodes (`…/pair#s=…&c=…&f=…&n=…`).
  final String url;

  /// This computer's E2EE fingerprint, for the phone to compare with.
  final String? fingerprint;
  final DateTime? expiresAt;
}

/// Asks [SignInClient.login] for a sign-in by phone rather than the browser: [onQr] gets each QR to
/// show (a fresh one replaces an expired one), [onProgress] the stages after it — `approved`, then,
/// once signed in and in the background, `waiting`, `linked`, `syncing`, `synced`, the link leg's
/// own `result`, and `ended` when the process is gone.
class SignInQrListener {
  const SignInQrListener({required this.onQr, this.onProgress});

  final void Function(SignInQr qr) onQr;
  final void Function(String stage, Map<String, dynamic> event)? onProgress;
}
