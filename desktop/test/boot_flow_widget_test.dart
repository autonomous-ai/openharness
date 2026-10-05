import 'support/resource_picker.dart';
import 'support/workspace_tools.dart';
import 'swarm_interactions_test.dart' show chord;

import 'package:flutter/services.dart';

import 'dart:async';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/config_store.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/update/desktop_updater.dart';
import 'package:harness/update/manual_update_check.dart';
import 'package:harness/widgets/update_notice.dart';
import 'package:harness/widgets/bootstrapping_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// Builds an AppNotifier without touching persisted state or the network:
/// status is set directly, so bootstrap/login (which call platform
/// channels and the network) never run.
AppNotifier makeNotifier(AppStatus status) {
  final app = _GuestApp(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    cliLogin: _FakeCliLogin(),
  );
  app.status = status;
  app.currentUser = const CurrentUserProfile(
    id: 'user-1',
    name: 'Sam',
    email: 'sam@example.com',
  );
  return app;
}

/// A window that never reaches for a real daemon.
///
/// A signed-out boot used to stop at the login wall before the daemon mattered;
/// it now lands on the desk as a GUEST, which is past the daemon gate — and a
/// unit test must not shell out for one. Everything else is the real notifier.
class _GuestApp extends AppNotifier {
  _GuestApp({
    required super.config,
    required super.authSession,
    super.configStore,
    super.cliLogin,
    super.environmentProvisioner,
    super.localManualFixture,
  });

  @override
  Future<void> ensureCliDaemonReady() async {}

  @override
  Future<bool> refreshMachines() async => true;
}

/// bootstrap() now asks the CLI (not AuthSession) whether this computer is signed in — this fake
/// avoids ever shelling out to a real `harness` binary from a unit test.
class _FakeCliLogin extends CliLogin {
  final bool loggedIn;
  _FakeCliLogin({this.loggedIn = false});

  @override
  Future<void> logout() async {}

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: loggedIn);
}

class _ControlledCliLogin extends CliLogin {
  final Completer<CliAuthStatus> status = Completer<CliAuthStatus>();

  @override
  Future<CliAuthStatus> checkStatus() => status.future;
}

class _BrokenConfigStore extends ConfigStore {
  var resetCalls = 0;

  @override
  Future<AppConfig> load() async => throw StateError('state file unavailable');

  @override
  Future<void> reset() async {
    resetCalls++;
  }
}

class _ReadyEnvironmentProvisioner extends EnvironmentProvisioner {
  bool called = false;
  _ReadyEnvironmentProvisioner() : super(isMacOS: true);

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    called = true;
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.ready,
    );
    onProgress(ready);
    return ready;
  }
}

/// Returns one scripted [EnvironmentReadiness] per call to `ensureReady`, and records the
/// `resumeFrom` each call was given — lets a test assert `recheckEnvironmentStep` passed the
/// current stuck state back in, and that a step already `ready` is never handed a fresh probe.
class _ScriptedEnvironmentProvisioner extends EnvironmentProvisioner {
  final List<EnvironmentReadiness> results;
  final List<List<EnvironmentReadiness>> progress;
  final List<EnvironmentReadiness?> resumeFromCalls = [];
  final List<bool> installCalls = [];
  var callCount = 0;
  _ScriptedEnvironmentProvisioner(this.results, {this.progress = const []})
    : super(isMacOS: true);

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    resumeFromCalls.add(resumeFrom);
    installCalls.add(install);
    final index = callCount < results.length ? callCount : results.length - 1;
    final result = results[index];
    if (index < progress.length) {
      for (final value in progress[index]) {
        onProgress(value);
      }
    }
    callCount++;
    onProgress(result);
    return result;
  }
}

class _FakeKeyValueStore implements LocalKeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The Harness menu prints the running version. Without this the plugin
  // channel throws and the row renders a placeholder, which would make the
  // assertion below pass for the wrong reason.
  PackageInfo.setMockInitialValues(
    appName: 'Harness',
    packageName: 'ai.autonomous.harness',
    version: '1.0.0',
    buildNumber: '1',
    buildSignature: '',
  );

  test('local manual fixture boots without SSO or persisted state', () async {
    final app = _GuestApp(
      config: const AppConfig(apiBaseUrl: 'http://127.0.0.1:12345'),
      authSession: AuthSession(),
      localManualFixture: const LocalManualFixture(
        apiBaseUrl: 'http://127.0.0.1:12345',
        apiKey:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        machineId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        machineName: 'local-manual',
      ),
    );

    await app.bootstrap();

    expect(app.status, AppStatus.authenticated);
    expect(app.config.apiBaseUrl, 'http://127.0.0.1:12345');
    expect(app.machines, hasLength(1));
    expect(app.machines.single.displayName, 'local-manual');
    expect(app.machines.single.authMode, MachineAuthMode.remote);
    expect(app.currentUser?.displayName, 'Local session');
  });

  test(
    'config-store failure falls back without resetting auth preferences',
    () async {
      final store = _BrokenConfigStore();
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: store,
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: _ReadyEnvironmentProvisioner(),
      );

      await app.bootstrap();

      // A signed-out DESKTOP window lands on the desk as a guest: everything on this
      // computer is served by the daemon over the loopback, and the sign-in is a sheet
      // raised when the person reaches for another machine.
      expect(app.status, AppStatus.authenticated);
      expect(app.isGuest, isTrue);
      expect(app.config.apiBaseUrl, ConfigStore.defaultBaseUrl);
      expect(app.autonomousEnv, 'prod');
      expect(store.resetCalls, 0);
    },
  );

  test(
    'a legacy setup version never bypasses the live readiness probe',
    () async {
      final storage = _FakeKeyValueStore()
        ..values['environment_setup_version'] = '3';
      final provisioner = _ReadyEnvironmentProvisioner();
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: storage),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();

      expect(provisioner.called, isTrue);
      expect(app.environmentReadiness.isReady, isTrue);
      // Reached the login check rather than getting stuck on preparingEnvironment.
      // A signed-out DESKTOP window lands on the desk as a guest: everything on this
      // computer is served by the daemon over the loopback, and the sign-in is a sheet
      // raised when the person reaches for another machine.
      expect(app.status, AppStatus.authenticated);
      expect(app.isGuest, isTrue);
    },
  );

  test(
    'a successful readiness probe does not persist a setup version',
    () async {
      final storage = _FakeKeyValueStore();
      final provisioner = _ReadyEnvironmentProvisioner();
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: storage),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();

      expect(provisioner.called, isTrue);
      expect(storage.values['environment_setup_version'], isNull);
    },
  );

  test('boot installs an in-app plan without asking', () async {
    final missing = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.review,
      message: 'Review what Harness will install before continuing.',
      plan: [EnvironmentPlanItem.harnessCli],
    );
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.ready,
      mode: EnvironmentSetupMode.automatic,
    );
    final provisioner = _ScriptedEnvironmentProvisioner([missing, ready]);
    final app = _GuestApp(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: ConfigStore(storage: _FakeKeyValueStore()),
      cliLogin: _FakeCliLogin(loggedIn: false),
      environmentProvisioner: provisioner,
    );
    final painted = <(AppStatus, EnvironmentSetupPhase)>[];
    app.addListener(
      () => painted.add((app.status, app.environmentReadiness.phase)),
    );

    await app.bootstrap();

    // The launch probe is still read-only; the install follows it unasked.
    expect(provisioner.installCalls, [isFalse, isTrue]);
    // The install resumes from the progress screen, not from the review: no
    // review copy and no red "Missing" on the row being installed.
    final resumed = provisioner.resumeFromCalls.last!;
    expect(resumed.phase, EnvironmentSetupPhase.installing);
    expect(resumed.message, isNot(missing.message));
    expect(
      resumed.steps[EnvironmentStep.harness],
      EnvironmentStepStatus.running,
    );
    expect(resumed.steps[EnvironmentStep.tmux], EnvironmentStepStatus.ready);
    expect(app.environmentInstallRequested, isTrue);
    // A signed-out DESKTOP window lands on the desk as a guest: everything on this
    // computer is served by the daemon over the loopback, and the sign-in is a sheet
    // raised when the person reaches for another machine.
    expect(app.status, AppStatus.authenticated);
    expect(app.isGuest, isTrue);
    expect(app.environmentReadiness.phase, EnvironmentSetupPhase.ready);
    // The review — the screen with the Install button — is never painted.
    expect(
      painted,
      isNot(
        contains((
          AppStatus.preparingEnvironment,
          EnvironmentSetupPhase.review,
        )),
      ),
    );
    expect(
      painted,
      isNot(
        contains((AppStatus.preparingEnvironment, EnvironmentSetupPhase.ready)),
      ),
    );
    app.dispose();
  });

  test(
    'boot waits for the Install action when the plan needs Terminal',
    () async {
      final linuxReview = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.failed,
        },
        phase: EnvironmentSetupPhase.review,
        plan: [
          EnvironmentPlanItem(
            step: EnvironmentStep.tmux,
            title: 'Linux host dependencies',
            detail: 'tmux · one apt transaction',
            command: 'sudo apt-get install -y tmux',
            requiresTerminal: true,
            packages: ['tmux'],
          ),
          EnvironmentPlanItem.harnessCli,
        ],
      );
      final provisioner = _ScriptedEnvironmentProvisioner([linuxReview]);
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();

      expect(provisioner.installCalls, [isFalse]);
      expect(app.environmentInstallRequested, isFalse);
      expect(app.status, AppStatus.preparingEnvironment);
      expect(app.environmentReadiness.phase, EnvironmentSetupPhase.review);
      app.dispose();
    },
  );

  test('a failed unattended install stops on the failure screen', () async {
    final missing = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.review,
      plan: [EnvironmentPlanItem.harnessCli],
    );
    final failed = missing.copyWith(
      phase: EnvironmentSetupPhase.failed,
      mode: EnvironmentSetupMode.automatic,
      failure: const EnvironmentFailure(
        step: EnvironmentStep.harness,
        title: 'Could not install Harness',
        detail: 'Check your connection, then retry setup.',
      ),
    );
    final provisioner = _ScriptedEnvironmentProvisioner([missing, failed]);
    final app = _GuestApp(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: ConfigStore(storage: _FakeKeyValueStore()),
      cliLogin: _FakeCliLogin(loggedIn: false),
      environmentProvisioner: provisioner,
    );

    await app.bootstrap();

    expect(provisioner.installCalls, [isFalse, isTrue]);
    expect(app.status, AppStatus.preparingEnvironment);
    expect(app.environmentReadiness.phase, EnvironmentSetupPhase.failed);
    expect(app.environmentInstallRequested, isTrue);
    expect(app.environmentSetupInFlight, isFalse);
    // No automatic retry loop: the next install waits for Retry.
    expect(app.environmentRecheckPending, isFalse);
    app.dispose();
  });

  test('Check again in manual setup never installs', () async {
    final manualReview = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.review,
      mode: EnvironmentSetupMode.manual,
      plan: [EnvironmentPlanItem.harnessCli],
    );
    final provisioner = _ScriptedEnvironmentProvisioner([manualReview]);
    final app = _GuestApp(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: ConfigStore(storage: _FakeKeyValueStore()),
      cliLogin: _FakeCliLogin(loggedIn: false),
      environmentProvisioner: provisioner,
    )..status = AppStatus.preparingEnvironment;
    app.environmentReadiness = manualReview;

    await app.retryEnvironmentSetup();

    expect(provisioner.installCalls, [isFalse]);
    expect(app.environmentInstallRequested, isFalse);
    expect(app.status, AppStatus.preparingEnvironment);
    expect(app.environmentReadiness.phase, EnvironmentSetupPhase.review);
    app.dispose();
  });

  test(
    'recheckEnvironmentStep succeeds and continues past environment setup',
    () async {
      final stuck = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.ready,
          EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
        },
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
      );
      final ready = EnvironmentReadiness(
        steps: {
          for (final step in EnvironmentStep.values)
            step: EnvironmentStepStatus.ready,
        },
        phase: EnvironmentSetupPhase.ready,
      );
      final storage = _FakeKeyValueStore();
      final provisioner = _ScriptedEnvironmentProvisioner([stuck, ready]);
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: storage),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();
      expect(
        app.environmentReadiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.needsTerminal,
      );
      expect(app.status, AppStatus.preparingEnvironment);

      await app.recheckEnvironmentStep(EnvironmentStep.tmux);

      // The user's current (stuck) readiness was handed back in, not a fresh `initial()` — this is
      // what lets the provisioner skip the already-`ready` harness step during the recheck.
      expect(provisioner.resumeFromCalls.last, same(stuck));
      expect(app.environmentReadiness.isReady, isTrue);
      // A signed-out DESKTOP window lands on the desk as a guest: everything on this
      // computer is served by the daemon over the loopback, and the sign-in is a sheet
      // raised when the person reaches for another machine.
      expect(app.status, AppStatus.authenticated);
      expect(app.isGuest, isTrue);
      expect(storage.values['environment_setup_version'], isNull);
      expect(app.environmentRecheckPending, isFalse);
      app.dispose();
    },
  );

  test(
    'recheckEnvironmentStep still stuck keeps polling instead of advancing',
    () async {
      final stuck = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.ready,
          EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
        },
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
      );
      final storage = _FakeKeyValueStore();
      final provisioner = _ScriptedEnvironmentProvisioner([stuck, stuck]);
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: storage),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();
      // Launch checks are read-only and do not start an install/poll loop.
      expect(app.environmentRecheckPending, isFalse);

      await app.recheckEnvironmentStep(EnvironmentStep.tmux);

      expect(app.status, AppStatus.preparingEnvironment);
      expect(app.environmentReadiness.isReady, isFalse);
      expect(storage.values['environment_setup_version'], isNull);
      // Rescheduled rather than given up on.
      expect(app.environmentRecheckPending, isTrue);
      app.dispose();
    },
  );

  test(
    'automatic Terminal polling keeps the waiting UI phase stable',
    () async {
      final waiting = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
        },
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
      );
      final probing = waiting.copyWith(phase: EnvironmentSetupPhase.preflight);
      final reviewed = waiting.copyWith(
        phase: EnvironmentSetupPhase.review,
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.failed,
        },
      );
      final provisioner = _ScriptedEnvironmentProvisioner(
        [waiting, reviewed],
        progress: [
          const [],
          [probing, reviewed],
        ],
      );
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );
      await app.bootstrap();
      final paintedPhases = <EnvironmentSetupPhase>[];
      app.addListener(() => paintedPhases.add(app.environmentReadiness.phase));

      await app.recheckEnvironmentStep(EnvironmentStep.tmux);

      expect(paintedPhases, isNot(contains(EnvironmentSetupPhase.preflight)));
      expect(paintedPhases, isNot(contains(EnvironmentSetupPhase.review)));
      expect(
        app.environmentReadiness.phase,
        EnvironmentSetupPhase.waitingForTerminal,
      );
      expect(
        app.environmentReadiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.needsTerminal,
      );
      app.dispose();
    },
  );

  test(
    'Linux system-only Terminal waiting polls without starting another install',
    () async {
      final waiting = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.ready,
        },
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
        terminalSetup: EnvironmentTerminalSetup.linuxHost,
        plan: [
          EnvironmentPlanItem(
            step: EnvironmentStep.harness,
            title: 'Linux host dependencies',
            detail: 'curl · one apt transaction',
            command: 'sudo apt-get install -y curl',
            requiresTerminal: true,
            packages: ['curl'],
          ),
          EnvironmentPlanItem.harnessCli,
        ],
      );
      final provisioner = _ScriptedEnvironmentProvisioner([waiting, waiting]);
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );
      await app.bootstrap();

      await app.recheckEnvironmentStep(EnvironmentStep.tmux);

      expect(provisioner.installCalls, [false, false]);
      expect(
        app.environmentReadiness.terminalSetup,
        EnvironmentTerminalSetup.linuxHost,
      );
      expect(
        app.environmentReadiness.phase,
        EnvironmentSetupPhase.waitingForTerminal,
      );
      expect(app.environmentRecheckPending, isTrue);
      app.dispose();
    },
  );

  testWidgets('boot -> unauthenticated shows LoginScreen', (tester) async {
    final app = makeNotifier(AppStatus.unauthenticated);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    // `pump`, not `pumpAndSettle`: the sign-in screen's diagram and aurora
    // animate forever by design, so settling never arrives. See
    // `login_screen_test.dart` for the full note.
    await tester.pump(const Duration(milliseconds: 200));

    // The card leads with what the app does for you, not with its own name —
    // the wordmark left when the screen stopped being a logo over a button.
    expect(find.text('Your agents, wherever they run'), findsOneWidget);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.text('Continue with Apple'), findsOneWidget);
  });

  testWidgets('bootstrapping shows branded startup screen (pre-login)', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.bootstrapping);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pump();

    // RootShell renders the designed startup bridge while bootstrapping, not
    // LoginScreen. Keep this on the real RootShell so notifier wiring remains
    // covered as well as the standalone screen's presentation tests.
    expect(find.byType(BootstrappingScreen), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Opening your workspace'), findsOneWidget);
    expect(find.text('Opening Harness…'), findsOneWidget);
    expect(find.text('Continue with Google'), findsNothing);
  });

  testWidgets('live pre-flight has its own quiet screen', (tester) async {
    final app = makeNotifier(AppStatus.checkingEnvironment);
    app.environmentReadiness = EnvironmentReadiness.initial();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pump();

    expect(find.text('Checking this computer'), findsOneWidget);
    expect(find.text("This check doesn't install anything."), findsOneWidget);
    expect(find.text('ENVIRONMENT SETUP'), findsNothing);
    expect(find.text('Pre-flight check'), findsNothing);
  });

  testWidgets(
    'ready pre-flight is visible while auth resolves, then opens login',
    (tester) async {
      final cliLogin = _ControlledCliLogin();
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: cliLogin,
        environmentProvisioner: _ReadyEnvironmentProvisioner(),
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: _swarm),
        ),
      );

      final bootstrap = app.bootstrap();
      await tester.pump();
      await tester.pump();

      expect(app.status, AppStatus.checkingEnvironment);
      expect(
        find.text('All checks passed. Opening your workspace…'),
        findsOneWidget,
      );
      expect(find.text('Continue to sign in'), findsNothing);
      expect(find.text('ENVIRONMENT SETUP'), findsNothing);

      cliLogin.status.complete(const CliAuthStatus(loggedIn: false));
      await bootstrap;
      await tester.pump();

      // A signed-out DESKTOP window lands on the desk as a guest: everything on this
      // computer is served by the daemon over the loopback, and the sign-in is a sheet
      // raised when the person reaches for another machine.
      expect(app.status, AppStatus.authenticated);
      expect(app.isGuest, isTrue);
      // …and the desk is what is on screen, not the sign-in.
      expect(find.text('Continue with Google'), findsNothing);
      app.dispose();
    },
  );

  testWidgets(
    'environment setup exposes per-step guidance and a scoped recheck',
    (tester) async {
      final app = makeNotifier(AppStatus.preparingEnvironment);
      app.environmentReadiness = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.ready,
          EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
        },
        message:
            'Complete the setup in the terminal window, then click Recheck.',
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: _swarm),
        ),
      );
      await tester.pump();

      expect(find.text('Finish setup in Terminal'), findsOneWidget);
      expect(find.text('Managed Node 20+ & Harness CLI'), findsOneWidget);
      expect(find.text('Recheck now'), findsOneWidget);
      expect(find.text('Harness cannot see your password'), findsOneWidget);
    },
  );

  testWidgets('setup review exposes the install action and a manual path', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.preparingEnvironment);
    app.environmentReadiness = EnvironmentReadiness(
      steps: {
        EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.review,
      plan: [EnvironmentPlanItem.harnessCli],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pump();

    expect(find.text('Get this computer ready'), findsOneWidget);
    expect(find.text('Install 1 tool'), findsOneWidget);
    expect(find.text('Continue'), findsNothing);
    expect(find.text('tmux'), findsNothing);
    expect(find.text('Apple developer tools'), findsNothing);

    expect(find.text('Use automatic setup'), findsNothing);
    expect(find.text('Manual setup'), findsOneWidget);
    expect(find.text('Admin prompts stay in Terminal'), findsNothing);
    await tester.tap(find.text('Manual setup'));
    await tester.pump();

    expect(find.textContaining('/bin/sh -s -- --desktop'), findsOneWidget);
    expect(find.text('Check again'), findsOneWidget);
  });

  testWidgets(
    'one explicit install action reaches sign-in without an extra review',
    (tester) async {
      final provisioner = _ScriptedEnvironmentProvisioner([
        EnvironmentReadiness(
          steps: {
            for (final step in EnvironmentStep.values)
              step: EnvironmentStepStatus.ready,
          },
          phase: EnvironmentSetupPhase.ready,
        ),
      ]);
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: _FakeCliLogin(),
        environmentProvisioner: provisioner,
      )..status = AppStatus.preparingEnvironment;
      app.environmentReadiness = const EnvironmentReadiness(
        steps: {
          EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.ready,
        },
        phase: EnvironmentSetupPhase.review,
        plan: [EnvironmentPlanItem.harnessCli],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: _swarm),
        ),
      );
      await tester.pump();
      expect(provisioner.installCalls, isEmpty);
      await tester.tap(find.text('Install 1 tool'));
      await tester.pump();
      expect(provisioner.installCalls, [true]);
      // A signed-out DESKTOP window lands on the desk as a guest: everything on this
      // computer is served by the daemon over the loopback, and the sign-in is a sheet
      // raised when the person reaches for another machine.
      expect(app.status, AppStatus.authenticated);
      expect(app.isGuest, isTrue);
      // …on the desk, not in front of it.
      expect(find.text('Continue with Google'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('install plan and manual commands show only missing tools', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.preparingEnvironment);
    app.environmentReadiness = const EnvironmentReadiness(
      steps: {
        EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
        EnvironmentStep.harness: EnvironmentStepStatus.ready,
        EnvironmentStep.tmux: EnvironmentStepStatus.failed,
      },
      phase: EnvironmentSetupPhase.chooseMethod,
      mode: EnvironmentSetupMode.automatic,
      plan: [EnvironmentPlanItem.tmuxManaged],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pump();

    expect(find.text('tmux'), findsOneWidget);
    expect(find.text('Managed Node 20+ & Harness CLI'), findsNothing);
    expect(find.text('Install 1 tool'), findsOneWidget);
    // Nothing on macOS needs a password any more: no Terminal notice.
    expect(find.text('Admin prompts stay in Terminal'), findsNothing);

    await tester.tap(find.text('Manual setup'));
    await tester.pump();

    expect(find.text('1 · tmux'), findsOneWidget);
    expect(
      find.textContaining('install.sh | /bin/sh -s -- --host'),
      findsOneWidget,
    );
    expect(find.textContaining('Homebrew/install/HEAD'), findsNothing);
  });

  testWidgets('CLI-only install plan does not warn about admin prompts', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.preparingEnvironment);
    app.environmentReadiness = const EnvironmentReadiness(
      steps: {
        EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.chooseMethod,
      mode: EnvironmentSetupMode.automatic,
      plan: [EnvironmentPlanItem.harnessCli],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pump();

    expect(find.text('Managed Node 20+ & Harness CLI'), findsOneWidget);
    expect(find.text('Homebrew'), findsNothing);
    expect(find.text('tmux'), findsNothing);
    expect(find.text('Install 1 tool'), findsOneWidget);
    expect(find.text('Admin prompts stay in Terminal'), findsNothing);
  });

  testWidgets(
    'review shows tmux and the CLI as two in-app steps on a bare Mac',
    (tester) async {
      // No tmux, no Homebrew, no Harness: still nothing that needs Terminal.
      final app = makeNotifier(AppStatus.preparingEnvironment);
      app.environmentReadiness = const EnvironmentReadiness(
        steps: {
          EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.failed,
        },
        phase: EnvironmentSetupPhase.review,
        plan: [EnvironmentPlanItem.tmuxManaged, EnvironmentPlanItem.harnessCli],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: _swarm),
        ),
      );
      await tester.pump();

      expect(find.text('tmux'), findsOneWidget);
      expect(find.text('Managed Node 20+ & Harness CLI'), findsOneWidget);
      expect(find.text('Install 2 tools'), findsOneWidget);
      expect(find.text('Admin prompts stay in Terminal'), findsNothing);
      expect(find.text('Apple developer tools'), findsNothing);
      expect(find.text('Homebrew'), findsNothing);
      expect(
        tester.getTopLeft(find.text('tmux')).dy,
        lessThan(
          tester.getTopLeft(find.text('Managed Node 20+ & Harness CLI')).dy,
        ),
      );
    },
  );

  testWidgets('RootShell rebuilds to LoginScreen when status flips after boot', (
    tester,
  ) async {
    // Regression: RootShell must listen to the AppNotifier, otherwise a status
    // change after the first build (e.g. bootstrap -> unauthenticated) never
    // rebuilds and the app sticks on the boot spinner.
    final app = makeNotifier(AppStatus.bootstrapping);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pump();
    expect(find.byType(BootstrappingScreen), findsOneWidget);
    expect(find.text('Continue with Google'), findsNothing);

    app.status = AppStatus.unauthenticated;
    app.notifyListeners();
    await tester.pump();

    expect(find.byType(BootstrappingScreen), findsNothing);
    expect(find.text('Continue with Google'), findsOneWidget);
  });

  testWidgets(
    'authenticated with no machines starts idle and New opens linking',
    (tester) async {
      final app = makeNotifier(AppStatus.authenticated);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: _swarm),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('New Pane'), findsWidgets);
      expect(
        tester
            .widget<TextField>(
              find.byKey(const ValueKey('harness-start-search')),
            )
            .focusNode!
            .hasFocus,
        isTrue,
      );
      expect(
        find.byKey(const ValueKey('harness-start-new-tab')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('harness-start-new-pane')));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pumpAndSettle();
      // Creation without a machine opens the same picker as Cmd-M.
      expect(resourceScope('@'), findsOneWidget);
      expect(resourceSearch(tester).rows.last.title, 'Add machine');
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Add machine · App'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(app.panes, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('Settings exposes the signed-in account and sign-out', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.authenticated);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pumpAndSettle();
    await chord(tester, LogicalKeyboardKey.comma);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Account'));
    await tester.pumpAndSettle();
    expect(find.text('Sam'), findsOneWidget);
    expect(find.text('sam@example.com'), findsOneWidget);
    await tester.tap(find.byKey(const Key('settings-sign-out-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    // Signing out leaves the account, not this computer: the window stays on the
    // desk as a guest and the daemon goes on serving the agents that are running.
    // Settings closes with the tap, as it did.
    expect(app.signedIn, isFalse);
    expect(find.text('Account'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('available update is shown above the login screen', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.unauthenticated);
    app.availableUpdate = const UpdateInfo(
      version: '1.2.3',
      url: 'https://example.test/Harness-macos.zip',
      sha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      size: 1,
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    // Endless animation on the sign-in screen underneath; pump instead.
    await tester.pump(const Duration(milliseconds: 200));

    expect(find.text('Harness 1.2.3 is available'), findsOneWidget);
    expect(find.byKey(const Key('install-update-button')), findsOneWidget);
    expect(find.byKey(const Key('skip-update-button')), findsOneWidget);
  });

  testWidgets('manual update dialog can close without skipping the version', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.authenticated);
    await tester.pumpWidget(const MaterialApp(home: Placeholder()));

    final dialog = showUpdateCheckDialog(
      tester.element(find.byType(Placeholder)),
      app,
      const ManualUpdateCheck(
        check: DesktopUpdateCheck.available(
          UpdateInfo(
            version: '1.2.3',
            url: 'https://example.test/Harness-macos.zip',
            sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            size: 1,
          ),
        ),
        isSkipped: true,
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('close-update-dialog-button')), findsOneWidget);
    expect(find.text('Close'), findsOneWidget);

    await tester.tap(find.byKey(const Key('close-update-dialog-button')));
    await tester.pumpAndSettle();
    await dialog;

    expect(find.byKey(const Key('close-update-dialog-button')), findsNothing);
    app.dispose();
  });

  testWidgets(
    'offline selected agent retains its Tab view with an offline message',
    (tester) async {
      final app = makeNotifier(AppStatus.authenticated);
      const machine = Machine(
        machineId: 'offline-machine',
        apiKey: '',
        authMode: MachineAuthMode.remote,
        name: 'offline-mac',
        status: 'offline',
      );
      final state = MachineState(machine)
        ..localOnly = true
        ..nodeOnline = false
        ..activeAgentId = 'offline-agent'
        ..pendingOfflineAgentId = 'offline-agent'
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          Agent.fromJson({
            'id': 'offline-agent',
            'name': 'claude-session',
            'engine': 'claude',
            'terminal': {
              'runtimes': [
                {'backend': 'tmux', 'paneId': '%1'},
              ],
            },
          }),
        ];
      app.machines = [machine];
      app.machineStates[machine.machineId] = state;
      app.expandedMachines.add(machine.machineId);
      app.selectedMachineId = machine.machineId;
      await app.selectAgent(machine.machineId, 'offline-agent');

      // Tall enough for the full guide: a pane beside others needs 546px of
      // body, which the default 600px window no longer leaves once the
      // workspace gutter is taken out.
      await tester.binding.setSurfaceSize(const Size(800, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: _swarm),
        ),
      );
      await tester.pump();

      expect(find.text('Harness is offline'), findsOneWidget);
      expect(app.panes.single.agentId, 'offline-agent');
      await tester.binding.setSurfaceSize(const Size(800, 560));
      await tester.pump();
      expect(
        find.text('Harness is not running on this computer.'),
        findsOneWidget,
      );
      expect(app.panes.single.agentId, 'offline-agent');
      app.dispose();
    },
  );

  testWidgets(
    'offline unlinked remote with a pending agent opens machine recovery',
    (tester) async {
      final app = makeNotifier(AppStatus.authenticated);
      const machine = Machine(
        machineId: 'unlinked-machine',
        apiKey: '',
        authMode: MachineAuthMode.remote,
        name: 'remote-mac',
        status: 'online',
      );
      final state = MachineState(machine)
        ..nodeOnline = false
        ..needsLink = true
        ..activeAgentId = 'previous-agent'
        ..pendingOfflineAgentId = 'previous-agent'
        ..agentLoadStatus = AgentLoadStatus.needsLink
        ..agents = [
          Agent.fromJson({
            'id': 'previous-agent',
            'name': 'previous-session',
            'engine': 'claude',
            'terminal': {
              'runtimes': [
                {'backend': 'tmux', 'paneId': '%1'},
              ],
            },
          }),
        ];
      app.machines = [machine];
      app.machineStates[machine.machineId] = state;
      app.expandedMachines.add(machine.machineId);
      app.selectedMachineId = machine.machineId;
      await app.selectAgent(machine.machineId, 'previous-agent');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: _swarm),
        ),
      );
      // The panel and its password field receive focus after the first frame.
      await tester.pumpAndSettle();

      expect(resourceScope('@'), findsOneWidget);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is TextField &&
              widget.decoration?.hintText == 'Harness password',
        ),
        findsNothing,
      );
      expect(resourceSearch(tester).selected?.machineId, machine.machineId);
      expect(find.text('Offline'), findsWidgets);
      expect(find.text('Harness is offline'), findsNothing);
      expect(find.text('harness start'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('clicking the link-required prompt opens the link screen', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.authenticated);
    const otherMachine = Machine(
      machineId: 'other-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'other-mac',
      status: 'online',
    );
    const machine = Machine(
      machineId: 'link-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'link-mac',
      status: 'online',
    );
    final state = MachineState(machine)
      ..nodeOnline = true
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink;
    final otherState = MachineState(otherMachine)
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
    app.machines = [otherMachine, machine];
    app.machineStates[otherMachine.machineId] = otherState;
    app.machineStates[machine.machineId] = state;
    app.expandedMachines.add(otherMachine.machineId);
    app.expandedMachines.add(machine.machineId);
    app.selectedMachineId = otherMachine.machineId;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('machines-panel')), findsNothing);

    await openWorkspaceManagement(tester, 'machines');
    await tester.pumpAndSettle();
    await selectResource(tester, 'machine:link-machine');
    await tester.tap(
      find.byKey(const ValueKey('resource-action:picker.resource_connect')),
    );
    // Same popup-transition reasoning as above.
    await tester.pumpAndSettle();

    expect(resourceScope('@'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('remote-password-connect-field')),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('clicking link-required while another terminal is focused opens '
      'the popup without opening a new pane', (tester) async {
    final app = makeNotifier(AppStatus.authenticated);
    const otherMachine = Machine(
      machineId: 'other-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'other-mac',
      status: 'online',
    );
    const machine = Machine(
      machineId: 'link-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'link-mac',
      status: 'online',
    );
    final otherState = MachineState(otherMachine)
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
    final state = MachineState(machine)
      ..nodeOnline = true
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink;
    app.machines = [otherMachine, machine];
    app.machineStates[otherMachine.machineId] = otherState;
    app.machineStates[machine.machineId] = state;
    app.expandedMachines.add(otherMachine.machineId);
    app.expandedMachines.add(machine.machineId);

    // A terminal already open and FOCUSED on the other machine — this is what made
    // activeMachineState (which prefers focusedPane's session) resolve to the wrong
    // machine and made showMachinePane open a second, redundant "not linked" pane.
    final otherPane =
        TerminalPane(
            id: 1,
            machineId: otherMachine.machineId,
            agentId: 'other-agent',
          )
          ..session = TerminalSession(
            machineId: otherMachine.machineId,
            agentId: 'other-agent',
            agentName: 'other-agent',
            engineId: null,
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          );
    app.panes.add(otherPane);
    app.focusedPaneId = otherPane.id;
    app.selectedMachineId = otherMachine.machineId;
    final originalSwarm = app.activeSwarm;
    app.newSwarm();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: HarnessApp(authenticatedScreen: _swarm),
      ),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('machines-panel')), findsNothing);

    await openWorkspaceManagement(tester, 'machines');
    await tester.pumpAndSettle();
    await selectResource(tester, 'machine:link-machine');
    await tester.tap(
      find.byKey(const ValueKey('resource-action:picker.resource_connect')),
    );
    await tester.pumpAndSettle();

    expect(resourceScope('@'), findsOneWidget);
    // No second pane was opened for the popup — just the one terminal pane that was
    // already there.
    expect(app.allPanes, hasLength(1));
    expect(originalSwarm.panes.single, same(otherPane));
    expect(app.panes, isEmpty);
    expect(
      find.text('link-mac is not linked to this computer yet.'),
      findsNothing,
    );
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'a failed install at launch leaves Retry and Switch to Manual usable',
    (tester) async {
      final missing = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.ready,
        },
        phase: EnvironmentSetupPhase.review,
        plan: [EnvironmentPlanItem.harnessCli],
      );
      final failed = missing.copyWith(
        phase: EnvironmentSetupPhase.failed,
        mode: EnvironmentSetupMode.automatic,
        failure: const EnvironmentFailure(
          step: EnvironmentStep.harness,
          title: 'Setup could not finish',
          detail: 'Check your connection, then retry setup.',
        ),
      );
      final provisioner = _ScriptedEnvironmentProvisioner([missing, failed]);
      final app = _GuestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: _swarm),
        ),
      );
      await tester.pump();

      await app.bootstrap();
      await tester.pump();

      // The window was mounted while the launch install ran; once it fails the
      // person must be able to act on the failure without anything else
      // nudging a rebuild.
      expect(find.text('Install 1 tool'), findsNothing);
      expect(find.text('Setup could not finish'), findsOneWidget);
      final retry = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Retry'),
      );
      expect(retry.onPressed, isNotNull);
      final manual = tester.widget<TextButton>(
        find.widgetWithText(TextButton, 'Switch to Manual'),
      );
      expect(manual.onPressed, isNotNull);

      // One click is one more install, and nothing runs on its own after it.
      await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 6));
      expect(provisioner.installCalls, [false, true, true]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  test('nothing re-enters setup while the launch install is running', () async {
    final missing = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.review,
      plan: [EnvironmentPlanItem.harnessCli],
    );
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.ready,
      mode: EnvironmentSetupMode.automatic,
    );
    final gate = Completer<void>();
    final provisioner = _GatedInstallProvisioner(missing, ready, gate);
    final app = _GuestApp(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: ConfigStore(storage: _FakeKeyValueStore()),
      cliLogin: _FakeCliLogin(loggedIn: false),
      environmentProvisioner: provisioner,
    );

    final boot = app.bootstrap();
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    // Mid-install: the progress screen, owned by the launch run.
    expect(provisioner.installCalls, [false, true]);
    expect(app.status, AppStatus.preparingEnvironment);
    expect(app.environmentReadiness.phase, EnvironmentSetupPhase.installing);
    expect(app.environmentSetupInFlight, isTrue);
    expect(app.environmentInstallRequested, isTrue);

    await app.startEnvironmentSetup();
    await app.retryEnvironmentSetup();
    await app.recheckEnvironmentStep(EnvironmentStep.harness);
    expect(provisioner.installCalls, [false, true]);

    gate.complete();
    await boot;
    expect(provisioner.installCalls, [false, true]);
    expect(app.status, AppStatus.authenticated);
    expect(app.environmentSetupInFlight, isFalse);
    app.dispose();
  });

  test('a Terminal plan stays on the review through Retry', () async {
    final linuxReview = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.failed,
      },
      phase: EnvironmentSetupPhase.review,
      plan: [
        EnvironmentPlanItem(
          step: EnvironmentStep.tmux,
          title: 'Linux host dependencies',
          detail: 'tmux · one apt transaction',
          command: 'sudo apt-get install -y tmux',
          requiresTerminal: true,
          packages: ['tmux'],
        ),
        EnvironmentPlanItem.harnessCli,
      ],
    );
    final provisioner = _ScriptedEnvironmentProvisioner([linuxReview]);
    final app = _GuestApp(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: ConfigStore(storage: _FakeKeyValueStore()),
      cliLogin: _FakeCliLogin(loggedIn: false),
      environmentProvisioner: provisioner,
    )..status = AppStatus.preparingEnvironment;
    app.environmentReadiness = linuxReview.copyWith(
      phase: EnvironmentSetupPhase.failed,
      mode: EnvironmentSetupMode.automatic,
    );

    await app.retryEnvironmentSetup();

    // Retry in automatic mode probes, finds a password-gated plan, and stops.
    expect(provisioner.installCalls, [false]);
    expect(app.environmentReadiness.phase, EnvironmentSetupPhase.review);
    expect(app.status, AppStatus.preparingEnvironment);
    expect(app.environmentSetupInFlight, isFalse);
    app.dispose();
  });

  test('a failed launch check never starts an install', () async {
    final probeFailed = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.failed,
      plan: [EnvironmentPlanItem.harnessCli],
      failure: const EnvironmentFailure(
        title: 'Checking this computer took too long',
        detail: 'A required tool did not respond.',
      ),
    );
    final provisioner = _ScriptedEnvironmentProvisioner([probeFailed]);
    final app = _GuestApp(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: ConfigStore(storage: _FakeKeyValueStore()),
      cliLogin: _FakeCliLogin(loggedIn: false),
      environmentProvisioner: provisioner,
    );

    await app.bootstrap();

    // Only a review of what is missing is installed; a check that did not
    // finish waits for Retry.
    expect(provisioner.installCalls, [isFalse]);
    expect(app.environmentInstallRequested, isFalse);
    expect(app.status, AppStatus.preparingEnvironment);
    expect(app.environmentReadiness.phase, EnvironmentSetupPhase.failed);
    expect(app.environmentSetupInFlight, isFalse);
    app.dispose();
  });

  test('an unattended install that ends waiting for Terminal polls, then carries on', () async {
    final missing = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.review,
      plan: [EnvironmentPlanItem.harnessCli],
    );
    final waiting = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
      },
      phase: EnvironmentSetupPhase.waitingForTerminal,
      mode: EnvironmentSetupMode.automatic,
    );
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.ready,
      mode: EnvironmentSetupMode.automatic,
    );
    final provisioner = _ScriptedEnvironmentProvisioner([
      missing,
      waiting,
      ready,
    ]);
    final app = _GuestApp(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: ConfigStore(storage: _FakeKeyValueStore()),
      cliLogin: _FakeCliLogin(loggedIn: false),
      environmentProvisioner: provisioner,
    );

    await app.bootstrap();

    // The install the app started hands off to Terminal like one the person
    // started: it stays on the waiting screen and keeps polling.
    expect(provisioner.installCalls, [isFalse, isTrue]);
    expect(app.status, AppStatus.preparingEnvironment);
    expect(
      app.environmentReadiness.phase,
      EnvironmentSetupPhase.waitingForTerminal,
    );
    expect(app.environmentInstallRequested, isTrue);
    expect(app.environmentRecheckPending, isTrue);
    expect(app.environmentSetupInFlight, isFalse);

    await app.recheckEnvironmentStep(EnvironmentStep.tmux);

    expect(provisioner.installCalls, [isFalse, isTrue, isFalse]);
    expect(app.status, AppStatus.authenticated);
    expect(app.environmentRecheckPending, isFalse);
    app.dispose();
  });
}

/// Probe answers [probed] at once; the install blocks on [gate] and then answers [done].
class _GatedInstallProvisioner extends EnvironmentProvisioner {
  _GatedInstallProvisioner(this.probed, this.done, this.gate)
    : super(isMacOS: true);
  final EnvironmentReadiness probed;
  final EnvironmentReadiness done;
  final Completer<void> gate;
  final installCalls = <bool>[];

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    installCalls.add(install);
    if (!install) {
      onProgress(probed);
      return probed;
    }
    onProgress(
      (resumeFrom ?? probed).copyWith(phase: EnvironmentSetupPhase.installing),
    );
    await gate.future;
    onProgress(done);
    return done;
  }
}

/// The screen the desktop app mounts once signed in — the argument `HarnessApp`
/// now takes, so the shell itself does not have to know about either app.
Widget _swarm(AppNotifier app) => SwarmScreen(notifier: app);
