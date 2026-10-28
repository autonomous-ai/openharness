import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/phone_sign_in.dart';
import 'package:harness/auth/sign_in_client.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/config.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';

import 'support/memory_key_value_store.dart';

/// A sign-in the test ends by hand. Never runs the real CLI: a real `harness login` or `logout`
/// here would sign this computer's own CLI in or out.
class _Cli extends CliLogin {
  final attempts = <Completer<void>>[];

  @override
  Future<void> login({
    required void Function(String) onAuthorizeUrl,
    SignInProvider? provider,
  }) {
    final attempt = Completer<void>();
    attempts.add(attempt);
    return attempt.future;
  }

  @override
  Future<void> loginWithPhone({
    required void Function(String link, int expiresIn) onQr,
    required Future<bool> Function(String email) onConfirm,
  }) {
    final attempt = Completer<void>();
    attempts.add(attempt);
    return attempt.future;
  }

  /// What the real one does to the attempt it stops: the process is killed and its wait throws.
  @override
  void cancel() {
    for (final attempt in attempts) {
      if (!attempt.isCompleted) {
        attempt.completeError(StateError('Sign-in was cancelled.'));
      }
    }
  }
}

/// The sign-in flow's ends as they would be counted: the first outcome of each observation, and
/// each reason a sign-in that did not go through gave.
class _Recorder extends ProductMeasurement {
  _Recorder()
    : super(surface: 'desktop', automatic: false, sendSetup: (_) async => {});

  final ended = <String>[];
  final reasons = <SignInEndReason>[];

  @override
  void Function(ProductOutcome) begin(ProductFlow flow) {
    var done = false;
    return (outcome) {
      if (done || flow != ProductFlow.signIn) return;
      done = true;
      ended.add(outcome.name);
    };
  }

  @override
  void signInEnded(SignInEndReason reason) => reasons.add(reason);
}

/// Signed in, then the saved workspace cannot be read back.
class _UnreadableLayout extends MemoryKeyValueStore {
  @override
  Future<String?> read(String key) async => throw StateError('disk gone');
}

AppNotifier _bootstrapFails(_Cli cli, _Recorder usage) => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
  cliLogin: cli,
  productMeasurement: usage,
  paneLayoutStore: PaneLayoutStore(storage: _UnreadableLayout()),
)..status = AppStatus.unauthenticated;

AppNotifier _app(_Cli cli, _Recorder usage) => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
  cliLogin: cli,
  productMeasurement: usage,
)..status = AppStatus.unauthenticated;

Future<_Recorder> _browserSignInEnding(Object error) async {
  final cli = _Cli(), usage = _Recorder();
  final app = _app(cli, usage);
  final login = app.login(SignInProvider.google);
  await pumpEventQueue();
  cli.attempts.single.completeError(error);
  await login;
  app.dispose();
  return usage;
}

Future<_Recorder> _phoneSignInEnding(Object error) async {
  final cli = _Cli(), usage = _Recorder();
  final app = _app(cli, usage);
  final login = app.loginWithPhone();
  await pumpEventQueue();
  cli.attempts.single.completeError(error);
  await login;
  app.dispose();
  return usage;
}

void main() {
  test(
    'Cancel during a browser sign-in counts as cancelled, not failed',
    () async {
      final cli = _Cli(), usage = _Recorder();
      final app = _app(cli, usage);
      final login = app.login(SignInProvider.google);
      await pumpEventQueue();
      app.cancelLogin();
      await login;
      app.dispose();
      expect(usage.ended, ['cancelled']);
      expect(usage.reasons, [SignInEndReason.cancelled]);
    },
  );

  test(
    'switching to the other button cancels the first sign-in, not fails it',
    () async {
      final cli = _Cli(), usage = _Recorder();
      final app = _app(cli, usage);
      unawaited(app.signInFromStep(SignInProvider.google));
      await pumpEventQueue();
      unawaited(app.signInFromStep(SignInProvider.apple));
      await pumpEventQueue();
      expect(usage.ended, ['cancelled']);
      expect(cli.attempts, hasLength(2));
      app.cancelLogin();
      await pumpEventQueue();
      app.dispose();
    },
  );

  test(
    'a browser page that never came back is unknown, with its reason',
    () async {
      // The person may have left, or finished in the browser and the callback never arrived.
      final usage = await _browserSignInEnding(
        const SignInException('TIMEOUT', 'SSO login timed out'),
      );
      expect(usage.ended, ['unknown']);
      expect(usage.reasons, [SignInEndReason.timeout]);
    },
  );

  test('the CLI stopping a sign-in its app left counts as cancelled', () async {
    final usage = await _browserSignInEnding(
      const SignInException('CANCELLED', 'Sign-in was cancelled.'),
    );
    expect(usage.ended, ['cancelled']);
    expect(usage.reasons, [SignInEndReason.cancelled]);
  });

  final failures = {
    const SignInException('EXCHANGE_FAILED', 'invalid_grant'):
        SignInEndReason.exchangeFailed,
    const SignInException('CALLBACK_ERROR', 'SSO login failed: x'):
        SignInEndReason.callbackError,
    const SignInException('BACKEND_ERROR', 'down'):
        SignInEndReason.backendError,
    const SignInException('DAEMON_BUSY', 'busy'): SignInEndReason.daemonBusy,
    const SignInException('NO_RESULT', 'Sign-in did not complete.'):
        SignInEndReason.noResult,
    const SignInException('SOMETHING_NEW', 'new'): SignInEndReason.other,
    CliNotAvailableException('no harness'): SignInEndReason.cliUnavailable,
    StateError('anything else'): SignInEndReason.other,
  };
  failures.forEach((error, reason) {
    test(
      'a browser sign-in that broke ($error) counts as failed, by its reason',
      () async {
        final usage = await _browserSignInEnding(error);
        expect(usage.ended, ['failed']);
        expect(usage.reasons, [reason]);
      },
    );
  });

  test(
    'a sign-in that went through stays ok when opening the workspace fails',
    () async {
      final cli = _Cli(), usage = _Recorder();
      final app = _bootstrapFails(cli, usage);
      final login = app.login(SignInProvider.google);
      await pumpEventQueue();
      cli.attempts.single.complete();
      await login;
      app.dispose();
      expect(usage.ended, ['ok']);
      expect(usage.reasons, isEmpty);
    },
  );

  test('Cancel during a phone sign-in counts as cancelled', () async {
    final cli = _Cli(), usage = _Recorder();
    final app = _app(cli, usage);
    final login = app.loginWithPhone();
    await pumpEventQueue();
    app.cancelLogin();
    await login;
    app.dispose();
    expect(usage.ended, ['cancelled']);
    expect(usage.reasons, [SignInEndReason.cancelled]);
  });

  final phoneEnds = {
    'DENIED': ('cancelled', SignInEndReason.denied),
    'CANCELLED': ('cancelled', SignInEndReason.cancelled),
    'EXPIRED': ('unknown', SignInEndReason.expired),
    'BACKEND_ERROR': ('failed', SignInEndReason.backendError),
    'CLI_TOO_OLD': ('failed', SignInEndReason.cliTooOld),
  };
  phoneEnds.forEach((code, end) {
    test('a phone sign-in ended $code counts as ${end.$1}', () async {
      final usage = await _phoneSignInEnding(PhoneSignInException(code, 'x'));
      expect(usage.ended, [end.$1]);
      expect(usage.reasons, [end.$2]);
    });
  });
}
