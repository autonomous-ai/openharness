/// A hidden window asks nothing on a timer (task #2953, roadmap Phase 3 item 2).
///
/// A signed-in window keeps two background re-reads: each connected machine's
/// agent list every minute, and the machine list (with the desk) every five.
/// While the window is hidden — minimised, behind other windows, closed to the
/// menu bar, a browser tab in the background — they used to keep going. These
/// pin that they stop while it is hidden, and that coming back reads once at
/// once (only what came due while away), then goes on as before.
///
/// Fixtures as in signed_out_polling_test.dart: the real app model, a fake
/// CLI that never signs this Mac out, a memory store.
library;

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/widgets.dart';
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
  int deskReads = 0;

  /// What an `agents_list` answers: the agents on this computer.
  List<Map<String, dynamic>> agents = const [];
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
  Future<Map<String, dynamic>?> desk() async {
    asked.deskReads++;
    return null;
  }

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
    return {'agents': asked.agents};
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
  TestWidgetsFlutterBinding.ensureInitialized();
  const minute = AppNotifier.agentSyncInterval;
  const safetyNet = AppNotifier.machineListSafetyNetInterval;

  /// A signed-in Desktop with this computer connected and its first reads done.
  _Desktop signedIn(FakeAsync async, _Asked asked) {
    final app = _Desktop(_Login(loggedIn: true), asked);
    app.appLifecycleChanged(AppLifecycleState.resumed);
    _launch(async, app);
    expect(app.isGuest, isFalse);
    return app;
  }

  void hide(_Desktop app) {
    app.appLifecycleChanged(AppLifecycleState.inactive);
    app.appLifecycleChanged(AppLifecycleState.hidden);
  }

  void show(_Desktop app) {
    app.appLifecycleChanged(AppLifecycleState.inactive);
    app.appLifecycleChanged(AppLifecycleState.resumed);
  }

  void done(FakeAsync async, _Desktop app) {
    app.dispose();
    async.flushMicrotasks();
  }

  test('hidden: no agent list for five minutes; shown: one at once, then '
      'every minute', () {
    fakeAsync((async) {
      final asked = _Asked();
      final app = signedIn(async, asked);
      // Shown, the minute's sync runs.
      var before = asked.agentReads;
      async.elapse(minute);
      async.flushMicrotasks();
      expect(asked.agentReads, before + 1, reason: 'shown: every minute');

      hide(app);
      before = asked.agentReads;
      async.elapse(minute * 5);
      async.flushMicrotasks();
      expect(asked.agentReads, before, reason: 'no agent sync while hidden');

      show(app);
      async.flushMicrotasks();
      expect(asked.agentReads, before + 1, reason: 'one read on return');
      async.elapse(minute);
      async.flushMicrotasks();
      expect(asked.agentReads, before + 2, reason: 'then every minute again');
      done(async, app);
    });
  });

  test('an unfocused window still in sight keeps its agent sync', () {
    fakeAsync((async) {
      final asked = _Asked();
      final app = signedIn(async, asked);
      app.appLifecycleChanged(AppLifecycleState.inactive);
      final before = asked.agentReads;
      async.elapse(minute * 3);
      async.flushMicrotasks();
      expect(asked.agentReads, before + 3);
      done(async, app);
    });
  });

  test('hidden: the safety net reads no machine list or desk; shown: one of '
      'each', () {
    fakeAsync((async) {
      final asked = _Asked();
      final app = signedIn(async, asked);
      hide(app);
      final machines = asked.machineReads, desk = asked.deskReads;
      async.elapse(safetyNet * 3);
      async.flushMicrotasks();
      expect(asked.machineReads, machines, reason: 'no list while hidden');
      expect(asked.deskReads, desk, reason: 'no desk while hidden');

      show(app);
      async.elapse(const Duration(seconds: 1));
      expect(asked.machineReads, machines + 1, reason: 'one list on return');
      expect(asked.deskReads, desk + 1, reason: 'one desk on return');
      async.elapse(safetyNet);
      async.flushMicrotasks();
      expect(
        asked.machineReads,
        machines + 2,
        reason: 'then every five minutes again',
      );
      done(async, app);
    });
  });

  test('hidden for less than an interval: nothing read on return, and still '
      'one timer', () {
    fakeAsync((async) {
      final asked = _Asked();
      final app = signedIn(async, asked);
      final agents = asked.agentReads, machines = asked.machineReads;
      // Hide, show, hide, show within a few seconds: a glance at another app.
      for (var i = 0; i < 3; i++) {
        hide(app);
        async.elapse(const Duration(seconds: 2));
        show(app);
        async.elapse(const Duration(seconds: 2));
      }
      expect(asked.agentReads, agents, reason: 'nothing came due');
      expect(asked.machineReads, machines, reason: 'nothing came due');
      async.elapse(minute);
      async.flushMicrotasks();
      expect(asked.agentReads, agents + 1, reason: 'one timer, not four');
      done(async, app);
    });
  });

  test('a machine connecting while hidden reads its list once, and starts '
      'its minute only when shown', () {
    fakeAsync((async) {
      final asked = _Asked();
      final app = signedIn(async, asked);
      hide(app);
      // The socket drops and comes back while nobody looks.
      app.onMachineConnectedForTest('local-machine');
      async.elapse(const Duration(seconds: 1));
      final before = asked.agentReads;
      async.elapse(minute * 4);
      async.flushMicrotasks();
      expect(asked.agentReads, before, reason: 'no minute sync while hidden');
      show(app);
      async.flushMicrotasks();
      expect(asked.agentReads, before + 1);
      done(async, app);
    });
  });

  test('a held agent is not re-read while hidden', () {
    fakeAsync((async) {
      final asked = _Asked()
        ..agents = const [
          {
            'id': 'a1',
            'name': 'held one',
            'engine': 'claude',
            'terminal': {'available': true},
            'launch': {'state': 'held', 'service': 'search'},
          },
        ];
      final app = signedIn(async, asked);
      app.heldLaunchSyncInterval = const Duration(seconds: 3);
      unawaited(
        app.handleEventForTest('local-machine', {
          'type': 'agent_synced',
          'payload': {'agent': asked.agents.single},
        }),
      );
      async.flushMicrotasks();
      hide(app);
      final before = asked.agentReads;
      async.elapse(minute * 2);
      async.flushMicrotasks();
      expect(asked.agentReads, before, reason: 'held: no re-read while hidden');
      show(app);
      async.elapse(const Duration(seconds: 1));
      expect(asked.agentReads, greaterThan(before));
      done(async, app);
    });
  });
}
