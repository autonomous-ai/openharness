import 'dart:async';

import 'package:clock/clock.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/phone_sign_in.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// When the sign-in step shows, and what its controls do to the app: a
/// desktop without an account must sign in between setup and its workspace
/// (`widgets/sign_in_step.dart`). Nothing here draws;
/// `sign_in_step_test.dart` has the page and `boot_flow_widget_test.dart` the
/// window it stands in.
class _Login extends CliLogin {
  _Login({this.loggedIn = false, this.offline = false});

  /// What `harness auth status` says.
  bool loggedIn;
  final bool offline;
  final started = <SignInProvider?>[];
  var cancels = 0;
  Completer<void>? pending;
  bool fail = false;

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: loggedIn, offline: offline);

  @override
  Future<void> logout() async => loggedIn = false;

  /// Each phone scan or code sign-in begun: what it shows, the account question, and its end.
  final approvals = <_Approval>[];

  @override
  void cancel() {
    cancels++;
    // What the real one does to the attempt it stops: its process is killed and its wait throws.
    for (final approval in approvals) {
      if (!approval.done.isCompleted) {
        approval.done.completeError(StateError('Sign-in was cancelled.'));
      }
    }
  }

  @override
  Future<void> loginWithPhone({
    required void Function(String link, int expiresIn) onQr,
    required Future<bool> Function(String email) onConfirm,
  }) => _approve(ApprovalSignIn.phone, onQr, onConfirm);

  @override
  Future<void> loginWithCode({
    required void Function(String code, int expiresIn) onCode,
    required Future<bool> Function(String email) onConfirm,
  }) => _approve(ApprovalSignIn.code, onCode, onConfirm);

  Future<void> _approve(
    ApprovalSignIn method,
    void Function(String, int) show,
    Future<bool> Function(String) confirm,
  ) async {
    final approval = _Approval(method, show, confirm);
    approvals.add(approval);
    await approval.done.future;
    loggedIn = true;
  }

  @override
  Future<void> login({
    required void Function(String) onAuthorizeUrl,
    SignInProvider? provider,
  }) async {
    started.add(provider);
    final wait = pending = Completer<void>();
    await wait.future;
    if (fail) throw StateError('The sign-in page could not be reached.');
    loggedIn = true;
  }
}

/// One phone scan or code sign-in as the CLI runs it: [show] is its QR link or code (again each time
/// it is kept alive), [confirm] asks whose account approved it, [done] is how it ends.
class _Approval {
  _Approval(this.method, this.show, this.confirm);
  final ApprovalSignIn method;
  final void Function(String shown, int expiresIn) show;
  final Future<bool> Function(String email) confirm;
  final done = Completer<void>();
}

class _Api extends ApiClient {
  _Api()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<Map<String, dynamic>?> desk() async => null;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async => null;
}

final _missing = EnvironmentReadiness(
  steps: {
    EnvironmentStep.harness: EnvironmentStepStatus.failed,
    EnvironmentStep.tmux: EnvironmentStepStatus.ready,
  },
  phase: EnvironmentSetupPhase.review,
  plan: [EnvironmentPlanItem.harnessCli],
);

final _ready = EnvironmentReadiness(
  steps: {
    for (final step in EnvironmentStep.values)
      step: EnvironmentStepStatus.ready,
  },
  phase: EnvironmentSetupPhase.ready,
  mode: EnvironmentSetupMode.automatic,
);

/// A computer whose probe finds no Harness CLI, and whose install puts it in.
/// [installed] is a computer that needs nothing.
class _Setup extends EnvironmentProvisioner {
  _Setup({this.installed = false}) : super(isMacOS: true);

  final bool installed;

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final result = install || installed ? _ready : _missing;
    onProgress(result);
    return result;
  }
}

class _Desktop extends AppNotifier {
  _Desktop(this.cli, {bool installed = false})
    : super(
        config: AppConfig.dev,
        configStore: null,
        authSession: AuthSession(storage: MemoryStore()),
        cliLogin: cli,
        environmentProvisioner: _Setup(installed: installed),
      ) {
    api = _Api();
  }

  final _Login cli;

  @override
  Future<void> ensureCliDaemonReady() async {}

  @override
  Future<bool> refreshMachines() async => true;
}

/// Lets a sign-in that has been released run to its end.
Future<void> _settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test('a computer new to Harness must sign in after the tour', () async {
    final app = _Desktop(_Login());
    addTearDown(app.dispose);
    await app.bootstrap();

    expect(app.status, AppStatus.authenticated);
    expect(app.isGuest, isTrue);
    // The tour first; the step is next, and says so for the tour's last line.
    expect(app.setupTourShowing, isTrue);
    expect(app.signInStepNext, isTrue);
    expect(app.signInStepShowing, isFalse);

    app.finishSetupTour();
    expect(app.signInStepShowing, isTrue);

    await _settle();
    expect(app.signInStepShowing, isTrue);
    expect(app.signInStepNext, isTrue);
    expect(app.status, AppStatus.authenticated);
    expect(app.isGuest, isTrue);
    expect(app.cli.started, isEmpty);
  });

  test('signing in from the step opens Harness signed in, and the page stays '
      'up until the account has arrived', () async {
    final app = _Desktop(_Login());
    addTearDown(app.dispose);
    await app.bootstrap();
    app.finishSetupTour();

    final signIn = app.signInFromStep(SignInProvider.google);
    await _settle();
    expect(app.cli.started, [SignInProvider.google]);
    // The browser is open: the page stays, whatever the status says meanwhile.
    expect(app.status, AppStatus.bootstrapping);
    expect(app.signInStepShowing, isTrue);

    app.cli.pending!.complete();
    await signIn;
    expect(app.signedIn, isTrue);
    expect(app.status, AppStatus.authenticated);
    expect(app.signInStepShowing, isFalse);
    // Complete for this account; explicit sign-out requires it again.
    expect(app.signInStepNext, isFalse);
  });

  test('every way in stays live while the browser is open', () async {
    final app = _Desktop(_Login());
    addTearDown(app.dispose);
    await app.bootstrap();
    app.finishSetupTour();

    unawaited(app.signInFromStep(SignInProvider.google));
    await _settle();
    // The same one again is its page again, not a second sign-in.
    await app.signInFromStep(SignInProvider.google);
    await _settle();
    expect(app.cli.started, [SignInProvider.google]);
    expect(app.cli.cancels, 0);

    // Another one ends the first and begins its own. No provider is the
    // sign-in page's own chooser: Continue with email.
    unawaited(app.signInFromStep(SignInProvider.apple));
    await _settle();
    unawaited(app.signInFromStep());
    await _settle();
    expect(app.cli.started, [
      SignInProvider.google,
      SignInProvider.apple,
      null,
    ]);
    expect(app.cli.cancels, 2);
    expect(app.signInStepShowing, isTrue);

    // Cancelling the browser flow keeps the required page in place.
    app.cancelLogin();
    expect(app.cli.cancels, 3);
    expect(app.signingIn, isFalse);
    expect(app.signInStepShowing, isTrue);
    expect(app.status, AppStatus.authenticated);
    expect(app.isGuest, isTrue);
  });

  test('a sign-in that fails leaves the page up, with why', () async {
    final app = _Desktop(_Login()..fail = true);
    addTearDown(app.dispose);
    await app.bootstrap();
    app.finishSetupTour();

    final signIn = app.signInFromStep(SignInProvider.apple);
    await _settle();
    app.cli.pending!.complete();
    await signIn;
    expect(app.signedIn, isFalse);
    expect(app.status, AppStatus.authenticated);
    expect(app.signInStepShowing, isTrue);
    expect(app.lastError, contains('could not be reached'));
  });

  test('a new computer that is signed in already is not asked', () async {
    final app = _Desktop(_Login(loggedIn: true));
    addTearDown(app.dispose);
    await app.bootstrap();
    await _settle();

    expect(app.status, AppStatus.authenticated);
    expect(app.signedIn, isTrue);
    expect(app.setupTourShowing, isTrue);
    // The tour's last line promises Harness itself, and keeps the promise.
    expect(app.signInStepNext, isFalse);
    app.finishSetupTour();
    expect(app.signInStepShowing, isFalse);
  });

  test('an existing signed-out installation must sign in too', () async {
    final app = _Desktop(_Login(), installed: true);
    addTearDown(app.dispose);
    await app.bootstrap();

    expect(app.status, AppStatus.authenticated);
    expect(app.isGuest, isTrue);
    expect(app.setupTourShowing, isFalse);
    expect(app.signInStepNext, isTrue);
    expect(app.signInStepShowing, isTrue);
  });

  test('a repaired CLI skips the tour but still requires sign-in', () async {
    final app = _Desktop(_Login())..harnessInstalledBefore = () => true;
    addTearDown(app.dispose);
    await app.bootstrap();

    expect(app.status, AppStatus.authenticated);
    expect(app.setupTourShowing, isFalse);
    expect(app.signInStepShowing, isTrue);
  });

  test('relaunching after setup cannot bypass sign-in', () async {
    final cli = _Login();
    final first = _Desktop(cli);
    await first.bootstrap();
    first.finishSetupTour();
    expect(first.signInStepShowing, isTrue);
    first.dispose();

    final reopened = _Desktop(cli, installed: true);
    addTearDown(reopened.dispose);
    await reopened.bootstrap();
    expect(reopened.setupTourShowing, isFalse);
    expect(reopened.signInStepShowing, isTrue);
  });

  test('first arrival waits for an account before starting agents', () async {
    final app = _Desktop(_Login())..firstArrivalBehindTour = true;
    addTearDown(app.dispose);
    await app.bootstrap();
    await _settle();
    expect(app.firstArrival.pending, isTrue);
    expect(app.firstArrival.running, isFalse);
    app.finishSetupTour();
    await _settle();
    expect(app.signInStepShowing, isTrue);
    expect(app.firstArrival.pending, isTrue);
    expect(app.firstArrival.running, isFalse);
  });

  test(
    'a cancelled sign-in cannot open the workspace with a late reply',
    () async {
      final app = _Desktop(_Login(), installed: true);
      addTearDown(app.dispose);
      await app.bootstrap();
      final signIn = app.signInFromStep(SignInProvider.google);
      await _settle();
      app.cancelLogin();
      app.cli.pending!.complete();
      await signIn;
      expect(app.signedIn, isFalse);
      expect(app.signInStepShowing, isTrue);
    },
  );

  test('explicit sign-out requires sign-in again', () async {
    final app = _Desktop(_Login(loggedIn: true), installed: true);
    addTearDown(app.dispose);
    await app.bootstrap();
    expect(app.signInStepShowing, isFalse);
    await app.logout();
    await _settle();
    expect(app.signedIn, isFalse);
    expect(app.signInStepShowing, isTrue);
  });

  test('a signed-in offline launch opens the workspace', () async {
    final app = _Desktop(
      _Login(loggedIn: true, offline: true),
      installed: true,
    );
    addTearDown(app.dispose);
    await app.bootstrap();
    expect(app.signedIn, isTrue);
    expect(app.status, AppStatus.authenticated);
    expect(app.signInStepShowing, isFalse);
    expect(app.cli.started, isEmpty);
  });

  test(
    'runtime expiry requires sign-in again while restoring saved local work',
    () async {
      final app = _Desktop(_Login(loggedIn: true), installed: true);
      addTearDown(app.dispose);
      await app.bootstrap();
      app.expireSessionForTest('Sign in again to reach your other machines.');
      await _settle();
      expect(app.signedIn, isFalse);
      expect(app.sessionExpired, isTrue);
      expect(app.status, AppStatus.authenticated);
      expect(app.signInStepShowing, isTrue);
    },
  );

  test('without a tour — setup that needed the person — the step follows '
      'setup', () async {
    final app = _Desktop(_Login());
    addTearDown(app.dispose);
    await app.bootstrap();
    // Manual setup is the setup screen's, not the tour's.
    app.selectEnvironmentSetupMode(EnvironmentSetupMode.manual);
    expect(app.setupTourShowing, isFalse);
    expect(app.signInStepShowing, isTrue);
  });

  group('Sign in on another device and Scan with your phone', () {
    test('the code shows, another device approves it, and the person here '
        'says whose account it is', () async {
      final app = _Desktop(_Login());
      addTearDown(app.dispose);
      await app.bootstrap();
      app.finishSetupTour();

      final signIn = app.approveFromStep(ApprovalSignIn.code);
      await _settle();
      final attempt = app.cli.approvals.single;
      expect(attempt.method, ApprovalSignIn.code);
      expect(app.approvalSignIn, ApprovalSignIn.code);
      // Nothing to show until the CLI has its code.
      expect(app.pendingSignInCode, isNull);
      expect(app.signInStepShowing, isTrue);

      attempt.show('12345678', 120);
      expect(app.pendingSignInCode, '12345678');
      expect(app.pendingQrLink, isNull);
      expect(app.signInStepShowing, isTrue);

      // Machines ▸ Approve a device on a signed-in computer (faked): the CLI asks whose account.
      final answer = attempt.confirm('dee@example.com');
      expect(app.pendingConfirmEmail, 'dee@example.com');
      app.confirmPhoneSignIn(true);
      expect(await answer, isTrue);
      attempt.done.complete();
      await signIn;
      expect(app.signedIn, isTrue);
      expect(app.signInStepShowing, isFalse);
      expect(app.pendingSignInCode, isNull);
      expect(app.approvalSignIn, isNull);
    });

    test('Scan with your phone shows the QR on the same page', () async {
      final app = _Desktop(_Login());
      addTearDown(app.dispose);
      await app.bootstrap();
      app.finishSetupTour();

      unawaited(app.approveFromStep(ApprovalSignIn.phone));
      await _settle();
      app.cli.approvals.single.show(
        'https://harness.autonomous.ai/signin#k=hnq_x',
        120,
      );
      expect(app.approvalSignIn, ApprovalSignIn.phone);
      expect(app.pendingQrLink, 'https://harness.autonomous.ai/signin#k=hnq_x');
      expect(app.pendingSignInCode, isNull);
      expect(app.signInStepShowing, isTrue);

      // Back: the ways in again, and nothing left running.
      app.cancelLogin();
      expect(app.signingIn, isFalse);
      expect(app.approvalSignIn, isNull);
      expect(app.pendingQrLink, isNull);
      expect(app.signInStepShowing, isTrue);
      expect(app.isGuest, isTrue);
    });

    test('another way in ends the one under way, browser or code', () async {
      final app = _Desktop(_Login());
      addTearDown(app.dispose);
      await app.bootstrap();
      app.finishSetupTour();

      unawaited(app.signInFromStep(SignInProvider.google));
      await _settle();
      unawaited(app.approveFromStep(ApprovalSignIn.code));
      await _settle();
      expect(app.cli.cancels, 1);
      expect(app.cli.approvals.single.method, ApprovalSignIn.code);
      app.cli.approvals.single.show('12345678', 120);

      unawaited(app.approveFromStep(ApprovalSignIn.phone));
      await _settle();
      expect(app.cli.cancels, 2);
      expect(app.cli.approvals.map((a) => a.method), [
        ApprovalSignIn.code,
        ApprovalSignIn.phone,
      ]);
      // The old code is gone with its attempt, and a late one cannot come back.
      expect(app.pendingSignInCode, isNull);
      app.cli.approvals.first.show('99999999', 120);
      expect(app.pendingSignInCode, isNull);
      expect(app.approvalSignIn, ApprovalSignIn.phone);
    });
  });

  group('the code and QR never run out on screen', () {
    /// A desktop on the sign-in step, in fake time.
    _Desktop onStep(FakeAsync async) {
      final app = _Desktop(_Login());
      unawaited(app.bootstrap());
      async.flushMicrotasks();
      app.finishSetupTour();
      return app;
    }

    test(
      "a new code takes the old one's place shortly before its life ends",
      () {
        fakeAsync((async) {
          final app = onStep(async);
          unawaited(app.approveFromStep(ApprovalSignIn.code));
          async.flushMicrotasks();
          final started = clock.now();
          app.cli.approvals.single.show('11111111', 120);
          expect(
            app.approvalRefreshAt,
            started.add(
              AppNotifier.approvalCodeLife - AppNotifier.approvalRefreshLead,
            ),
          );
          // The CLI keeps the same code alive meanwhile.
          for (var i = 1; i <= 4; i++) {
            async.elapse(const Duration(seconds: 90));
            app.cli.approvals.single.show('11111111', 120);
          }
          async.elapse(const Duration(minutes: 3, seconds: 44));
          expect(app.cli.approvals, hasLength(1));
          expect(app.pendingSignInCode, '11111111');

          async.elapse(const Duration(seconds: 1));
          async.flushMicrotasks();
          expect(app.cli.approvals, hasLength(2));
          expect(app.cli.approvals.first.done.isCompleted, isTrue);
          expect(app.cli.approvals.last.method, ApprovalSignIn.code);
          // Still signing in on the same page; the old code is not shown while the next one comes.
          expect(app.signingIn, isTrue);
          expect(app.signInStepShowing, isTrue);
          expect(app.pendingSignInCode, isNull);
          expect(app.lastError, isNull);
          app.cli.approvals.last.show('22222222', 120);
          expect(app.pendingSignInCode, '22222222');
          // A late word from the replaced attempt changes nothing.
          app.cli.approvals.first.show('11111111', 120);
          expect(app.pendingSignInCode, '22222222');
          app.dispose();
        });
      },
    );

    test('a code reported with less than its usual time is near its end: '
        'replaced before then', () {
      fakeAsync((async) {
        final app = onStep(async);
        unawaited(app.approveFromStep(ApprovalSignIn.phone));
        async.flushMicrotasks();
        app.cli.approvals.single.show(
          'https://harness.autonomous.ai/signin#k=a',
          120,
        );
        async.elapse(const Duration(minutes: 2));
        // The backend has less life left than a full extension.
        app.cli.approvals.single.show(
          'https://harness.autonomous.ai/signin#k=a',
          40,
        );
        expect(
          app.approvalRefreshAt,
          clock.now().add(
            const Duration(seconds: 40) - AppNotifier.approvalRefreshLead,
          ),
        );
        async.elapse(const Duration(seconds: 25));
        async.flushMicrotasks();
        expect(app.cli.approvals, hasLength(2));
        expect(app.cli.approvals.last.method, ApprovalSignIn.phone);
        expect(app.pendingQrLink, isNull);
        app.dispose();
      });
    });

    test('no new code while the person is answering whose account it is', () {
      fakeAsync((async) {
        final app = onStep(async);
        unawaited(app.approveFromStep(ApprovalSignIn.code));
        async.flushMicrotasks();
        final attempt = app.cli.approvals.single;
        attempt.show('11111111', 120);
        unawaited(attempt.confirm('dee@example.com'));
        async.elapse(AppNotifier.approvalCodeLife);
        async.flushMicrotasks();
        expect(app.cli.approvals, hasLength(1));
        expect(app.pendingConfirmEmail, 'dee@example.com');
        app.dispose();
      });
    });

    test('a code the CLI says ran out is replaced at once, a bounded number '
        'of times, then the page says so and shows no code', () {
      fakeAsync((async) {
        final app = onStep(async);
        unawaited(app.approveFromStep(ApprovalSignIn.code));
        async.flushMicrotasks();
        for (var i = 0; i <= AppNotifier.maxApprovalRefreshes; i++) {
          expect(app.cli.approvals, hasLength(i + 1));
          app.cli.approvals.last.show('$i' * 8, 120);
          app.cli.approvals.last.done.completeError(
            const PhoneSignInException('EXPIRED', 'The code expired.'),
          );
          async.flushMicrotasks();
        }
        // One person's first try plus the bounded refreshes; then it stops asking.
        expect(
          app.cli.approvals,
          hasLength(AppNotifier.maxApprovalRefreshes + 1),
        );
        async.elapse(const Duration(hours: 1));
        expect(
          app.cli.approvals,
          hasLength(AppNotifier.maxApprovalRefreshes + 1),
        );
        expect(app.signingIn, isFalse);
        expect(app.pendingSignInCode, isNull);
        expect(app.approvalSignIn, isNull);
        expect(app.lastError, contains('ran out'));
        expect(app.signInStepShowing, isTrue);

        // Asked again by hand: a fresh run of codes.
        unawaited(app.approveFromStep(ApprovalSignIn.code));
        async.flushMicrotasks();
        expect(
          app.cli.approvals,
          hasLength(AppNotifier.maxApprovalRefreshes + 2),
        );
        expect(app.lastError, isNull);
        app.dispose();
      });
    });

    test('Cancel, sign-out and closing the app stop the refresh', () {
      fakeAsync((async) {
        final app = onStep(async);
        unawaited(app.approveFromStep(ApprovalSignIn.code));
        async.flushMicrotasks();
        app.cli.approvals.single.show('11111111', 120);
        app.cancelLogin();
        async.elapse(const Duration(minutes: 30));
        expect(app.cli.approvals, hasLength(1));
        expect(app.approvalRefreshAt, isNull);

        unawaited(app.approveFromStep(ApprovalSignIn.code));
        async.flushMicrotasks();
        app.cli.approvals.last.show('22222222', 120);
        unawaited(app.logout());
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 30));
        expect(app.cli.approvals, hasLength(2));
        expect(app.pendingSignInCode, isNull);

        unawaited(app.approveFromStep(ApprovalSignIn.code));
        async.flushMicrotasks();
        app.cli.approvals.last.show('33333333', 120);
        app.dispose();
        async.elapse(const Duration(minutes: 30));
        expect(app.cli.approvals, hasLength(3));
      });
    });
  });
}
