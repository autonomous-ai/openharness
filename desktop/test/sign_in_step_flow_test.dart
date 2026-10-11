import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// When the sign-in step shows, and what its controls do to the app: a
/// computer new to Harness that holds no account is asked once, between setup
/// and its first workspace (`widgets/sign_in_step.dart`). Nothing here draws;
/// `sign_in_step_test.dart` has the page and `boot_flow_widget_test.dart` the
/// window it stands in.
class _Login extends CliLogin {
  _Login({this.loggedIn = false});

  /// What `harness auth status` says.
  bool loggedIn;
  final started = <SignInProvider?>[];
  var cancels = 0;
  Completer<void>? pending;
  bool fail = false;

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: loggedIn);

  @override
  Future<void> logout() async {}

  @override
  void cancel() => cancels++;

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
  test('a computer new to Harness, not signed in, is asked after the tour and '
      'Skip opens Harness', () async {
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

    var notified = 0;
    app.addListener(() => notified++);
    app.skipSignInStep();
    expect(notified, greaterThan(0));
    expect(app.signInStepShowing, isFalse);
    expect(app.signInStepNext, isFalse);
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
    // Spent: a sign-out later in the same launch does not bring it back.
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

    // Skip leaves, and takes the sign-in still waiting with it.
    app.skipSignInStep();
    expect(app.cli.cancels, 3);
    expect(app.signingIn, isFalse);
    expect(app.signInStepShowing, isFalse);
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

  test('a computer that already has Harness is never asked', () async {
    // Setup has nothing to install here: someone who has used Harness without
    // an account keeps the desk they open on, and finds Sign in in the tab row.
    final app = _Desktop(_Login(), installed: true);
    addTearDown(app.dispose);
    await app.bootstrap();

    expect(app.status, AppStatus.authenticated);
    expect(app.isGuest, isTrue);
    expect(app.setupTourShowing, isFalse);
    expect(app.signInStepNext, isFalse);
    expect(app.signInStepShowing, isFalse);
  });

  test('a CLI that is only being repaired is not a new computer', () async {
    final app = _Desktop(_Login())..harnessInstalledBefore = () => true;
    addTearDown(app.dispose);
    await app.bootstrap();

    expect(app.status, AppStatus.authenticated);
    expect(app.setupTourShowing, isFalse);
    expect(app.signInStepShowing, isFalse);
  });

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
}
