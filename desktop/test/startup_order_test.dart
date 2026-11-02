import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/ws/local_cli_discovery.dart';

// Task #2169: what does not depend on each other starts together, so a slow step costs only itself.

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  @override
  Future<Map<String, dynamic>?> desk() async => null;
  @override
  Future<Map<String, dynamic>?> me() => Completer<Map<String, dynamic>?>().future;
  @override
  Future<List<Machine>> machines() async => const [];
}

class _Cli extends CliLogin {
  _Cli(this.answers);
  final List<Future<CliAuthStatus> Function()> answers;
  int asked = 0;
  @override
  Future<CliAuthStatus> checkStatus() => answers[asked++]();
  @override
  Future<void> login({void Function(String url)? onAuthorizeUrl, SignInProvider? provider}) async {}
  @override
  Future<void> logout() async {}
}

EnvironmentReadiness _ready() => EnvironmentReadiness(
  steps: {for (final step in EnvironmentStep.values) step: EnvironmentStepStatus.ready},
  phase: EnvironmentSetupPhase.ready,
);

class _Environment extends EnvironmentProvisioner {
  _Environment({this.held, this.first});
  final Completer<void>? held;
  final EnvironmentReadiness? first;
  final installs = <bool>[];
  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    installs.add(install);
    await held?.future;
    final result = installs.length == 1 && first != null ? first! : _ready();
    onProgress(result);
    return result;
  }
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async => null;
}

class _HeldStore implements LocalKeyValueStore {
  final held = Completer<void>();
  int reads = 0;
  @override
  Future<String?> read(String key) async {
    reads++;
    await held.future;
    return null;
  }

  @override
  Future<void> write(String key, String value) async {}
  @override
  Future<void> delete(String key) async {}
}

class _App extends AppNotifier {
  _App(_Cli cli, _Environment environment, {super.paneLayoutStore})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        cliLogin: cli,
        environmentProvisioner: environment,
        localCliDiscovery: _Discovery(),
      ) {
    api = _Api();
  }
  int daemonChecks = 0;
  Completer<void>? daemon;
  @override
  Future<void> ensureCliDaemonReady() async {
    daemonChecks++;
    await daemon?.future;
  }
}

Future<void> _ticks() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

const _in = CliAuthStatus(loggedIn: true);
const _out = CliAuthStatus(loggedIn: false);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final apps = <_App>[];
  _App make(_Cli cli, _Environment environment, {PaneLayoutStore? panes}) {
    final app = _App(cli, environment, paneLayoutStore: panes);
    apps.add(app);
    return app;
  }

  tearDown(() {
    for (final app in apps.splice()) {
      app.dispose();
    }
  });

  test('asks whether this computer is signed in while the tools are still being looked at, once', () async {
    final held = Completer<void>(), cli = _Cli([() async => _in]);
    final app = make(cli, _Environment(held: held));
    final boot = app.bootstrap();
    await _ticks();
    expect(cli.asked, 1);
    expect(app.status, isNot(AppStatus.authenticated));
    held.complete();
    await boot;
    expect(cli.asked, 1);
    expect(app.status, AppStatus.authenticated);
    expect(app.signedIn, isTrue);
  });

  test('a check that failed early, as with no CLI yet, is asked again once the tools are ready', () async {
    final cli = _Cli([() async => throw CliNotAvailableException('no CLI yet'), () async => _in]);
    final app = make(cli, _Environment());
    await app.bootstrap();
    expect(cli.asked, 2);
    expect(app.signedIn, isTrue);
  });

  test('a check from before an install is not trusted: it is asked again after', () async {
    final review = EnvironmentReadiness(
      steps: {for (final step in EnvironmentStep.values) step: EnvironmentStepStatus.pending},
      phase: EnvironmentSetupPhase.review,
      plan: const [EnvironmentPlanItem(step: EnvironmentStep.tmux, title: 'tmux', detail: 'tmux', command: 'tmux')],
    );
    final cli = _Cli([() async => _out, () async => _in]);
    final environment = _Environment(first: review);
    final app = make(cli, environment);
    await app.bootstrap();
    expect(environment.installs, contains(true));
    expect(cli.asked, 2);
    expect(app.signedIn, isTrue);
  });

  test('a check answered before a sign-out never signs the app back in', () async {
    final held = Completer<void>(), cli = _Cli([() async => _in, () async => _out]);
    final app = make(cli, _Environment(held: held));
    final boot = app.bootstrap();
    await _ticks();
    expect(cli.asked, 1);
    await app.logout();
    held.complete();
    await boot;
    await _ticks();
    expect(app.signedIn, isFalse);
    expect(app.currentUser, isNull);
  });

  test('checks the daemon while the saved tabs are still being read, and finishes only with both', () async {
    final store = _HeldStore(), daemon = Completer<void>();
    final app = make(_Cli([() async => _in]), _Environment(), panes: PaneLayoutStore(storage: store))..daemon = daemon;
    final boot = app.bootstrap();
    await _ticks();
    expect(store.reads, greaterThan(0));
    expect(app.daemonChecks, 1);
    daemon.complete();
    await _ticks();
    expect(app.status, isNot(AppStatus.authenticated));
    store.held.complete();
    await boot;
    expect(app.status, AppStatus.authenticated);
  });

  test('a daemon that fails still waits for the saved tabs, then opens with its error', () async {
    final store = _HeldStore();
    final app = _FailingDaemon(_Cli([() async => _in]), _Environment(), panes: PaneLayoutStore(storage: store));
    apps.add(app);
    final boot = app.bootstrap();
    await _ticks();
    expect(app.status, isNot(AppStatus.authenticated));
    store.held.complete();
    await boot;
    expect(app.status, AppStatus.authenticated);
    expect(app.lastError, contains('no daemon'));
  });

  test('keeps a stopwatch of the startup steps', () async {
    final app = make(_Cli([() async => _in]), _Environment());
    await app.bootstrap();
    expect(app.startupTimings.keys, containsAll(<String>['signed-in check', 'tools', 'saved tabs', 'daemon']));
  });
}

class _FailingDaemon extends _App {
  _FailingDaemon(super.cli, super.environment, {PaneLayoutStore? panes}) : super(paneLayoutStore: panes);
  @override
  Future<void> ensureCliDaemonReady() async => throw StateError('no daemon');
}

extension on List<_App> {
  List<_App> splice() {
    final out = [...this];
    clear();
    return out;
  }
}
