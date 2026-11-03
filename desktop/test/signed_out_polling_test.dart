/// A signed-out computer stays quiet.
///
/// Without an account the app still prepares this computer's workspace behind
/// the sign-in page (a guest window), and that used to arm the same background
/// re-reads a signed-in window keeps: the agent list every minute and the
/// machine list every five, for as long as nobody signed in. An unattended
/// computer left on the sign-in page never went idle (Scholes's end-to-end
/// test of Desktop 1.3.44, finding 4).
///
/// These pin that a guest asks nothing on a timer, that signing in starts the
/// re-reads, and that signing out stops them again. The local service itself
/// keeps running: supervision and the first read are not polls.
library;

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore;

const _computerId = 'aabbccddeeff0011';

const _thisComputer = Machine(
  machineId: 'local-machine',
  name: 'Studio',
  computerId: _computerId,
  authMode: MachineAuthMode.remote,
  status: 'online',
);

/// What the app asks, counted: the machine list (through the CLI to the
/// backend) and every request on this computer's socket.
class _Asked {
  int machineReads = 0;
  int agentReads = 0;
}

class _Api extends ApiClient {
  _Api(this.asked)
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  final _Asked asked;

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<Map<String, dynamic>?> desk() async => null;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async => null;

  @override
  Future<List<Machine>> machines() async {
    asked.machineReads++;
    return const [_thisComputer];
  }
}

class _Login extends CliLogin {
  _Login({this.loggedIn = false});
  bool loggedIn;
  Completer<void>? pending;

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: loggedIn);

  // Never the real CLI: this Mac stays signed in whatever a test does.
  @override
  Future<void> logout() async => loggedIn = false;

  @override
  Future<void> login({
    required void Function(String) onAuthorizeUrl,
    SignInProvider? provider,
  }) async {
    final wait = pending = Completer<void>();
    await wait.future;
    loggedIn = true;
  }
}

class _Setup extends EnvironmentProvisioner {
  _Setup() : super(isMacOS: true);

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.ready,
      mode: EnvironmentSetupMode.automatic,
    );
    onProgress(ready);
    return ready;
  }
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => _computerId;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      LocalCliEndpoint(
        computerId: _computerId,
        wsUri: Uri.parse('ws://127.0.0.1:18473/ws'),
        protocolVersion: localWsProtocolVersion,
        terminalProtocolVersion: 1,
        machineId: 'local-machine',
        backendOnline: true,
      );
}

class _Connection extends WsConn {
  _Connection(this.asked)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'local-machine',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final _Asked asked;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agents_list') asked.agentReads++;
    return const {'agents': []};
  }
}

class _Desktop extends AppNotifier {
  _Desktop(this.cli, this.asked)
    : super(
        config: AppConfig.dev,
        configStore: null,
        authSession: AuthSession(storage: MemoryStore()),
        cliLogin: cli,
        environmentProvisioner: _Setup(),
        localCliDiscovery: _Discovery(),
        connectionForTest: (_) => _Connection(asked),
      ) {
    api = _Api(asked);
  }

  final _Login cli;
  final _Asked asked;

  @override
  Future<void> ensureCliDaemonReady() async {}
}

/// Boots [app] and connects this computer, as a launch does.
void _launch(FakeAsync async, _Desktop app) {
  unawaited(app.bootstrap());
  async.flushMicrotasks();
  async.elapse(const Duration(seconds: 1));
  // The socket's own connect: what starts a signed-in window's agent sync.
  app.onMachineConnectedForTest('local-machine');
  async.elapse(const Duration(seconds: 1));
}

void main() {
  test('a signed-out computer asks nothing on a timer', () {
    fakeAsync((async) {
      final asked = _Asked();
      final app = _Desktop(_Login(), asked);
      _launch(async, app);
      expect(app.isGuest, isTrue);
      expect(app.signInStepShowing, isTrue);

      final machines = asked.machineReads;
      final agents = asked.agentReads;
      // Far past both intervals: the minute's agent sync and the five-minute
      // machine safety net would each have fired many times.
      async.elapse(const Duration(minutes: 30));
      expect(
        asked.agentReads,
        agents,
        reason: 'no agent sync while signed out',
      );
      expect(
        asked.machineReads,
        machines,
        reason: 'no machine re-read while signed out',
      );
      app.dispose();
      async.flushMicrotasks();
    });
  });

  test('signing in starts the background re-reads', () {
    fakeAsync((async) {
      final asked = _Asked();
      final cli = _Login();
      final app = _Desktop(cli, asked);
      _launch(async, app);
      expect(app.isGuest, isTrue);

      unawaited(app.signInFromStep(SignInProvider.google));
      async.flushMicrotasks();
      cli.pending!.complete();
      async.elapse(const Duration(seconds: 1));
      expect(app.signedIn, isTrue);
      expect(app.signInStepShowing, isFalse);

      final machines = asked.machineReads;
      final agents = asked.agentReads;
      async.elapse(AppNotifier.agentSyncInterval);
      async.flushMicrotasks();
      expect(
        asked.agentReads,
        greaterThan(agents),
        reason: 'the minute agent sync runs once signed in',
      );
      async.elapse(AppNotifier.machineListSafetyNetInterval);
      async.flushMicrotasks();
      expect(
        asked.machineReads,
        greaterThan(machines),
        reason: 'the machine safety net runs once signed in',
      );
      app.dispose();
      async.flushMicrotasks();
    });
  });

  test('signing out stops them again', () {
    fakeAsync((async) {
      final asked = _Asked();
      final app = _Desktop(_Login(loggedIn: true), asked);
      _launch(async, app);
      expect(app.isGuest, isFalse);

      // Signed in: both run.
      final before = asked.agentReads;
      async.elapse(AppNotifier.agentSyncInterval);
      async.flushMicrotasks();
      expect(asked.agentReads, greaterThan(before));

      unawaited(app.logout());
      async.elapse(const Duration(seconds: 5));
      expect(app.isGuest, isTrue);
      // The guest's own socket connects again on the computer id.
      app.onMachineConnectedForTest('local-machine');
      async.elapse(const Duration(seconds: 1));

      final machines = asked.machineReads;
      final agents = asked.agentReads;
      async.elapse(const Duration(minutes: 30));
      expect(asked.agentReads, agents, reason: 'no agent sync after sign-out');
      expect(
        asked.machineReads,
        machines,
        reason: 'no machine re-read after sign-out',
      );
      app.dispose();
      async.flushMicrotasks();
    });
  });
}
