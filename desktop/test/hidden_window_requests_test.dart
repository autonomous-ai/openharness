/// What one idle, hidden Desktop window asks of the backend per minute (task #2953): the PR's
/// before/after measurement.
///
/// The window: signed in, this computer connected (its agent list relayed like any machine's), two
/// Swarms open with the server pushing, as a person leaves it at the end of a day. Then the window
/// is hidden — minimised, or closed to the menu bar — and ten simulated minutes pass. Every read
/// the app model and the Swarm client make is counted by kind; the test prints requests per minute
/// and asserts none was made on a clock. Run on main's code it prints the before.
///
/// Fixtures as in hidden_window_rereads_test.dart: the real app model and Swarm client, a fake CLI
/// that never signs this Mac out, a memory store.
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
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore;
import 'support/super_tab_fixture.dart';

/// Two Swarms behind the backend, every read counted.
class _Swarms {
  final servers = {'tab': ConversationServer(), 'other': ConversationServer()};
  final paths = <String>[];

  _Swarms() {
    servers['other']!.state['id'] = 'other';
  }

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    paths.add(path);
    if (Uri.parse(path).path == '/api/super-tabs/list') {
      return {
        'tabs': [
          {'id': 'tab', 'name': 'Pilot'},
          {'id': 'other', 'name': 'Other'},
        ],
        'next': null,
      };
    }
    final id = Uri.parse(path).pathSegments[2];
    return servers[id]!.request(method, path, body: body);
  }
}

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

  /// Every request on this computer's socket, by type.
  final socket = <String, int>{};

  /// The backend is down: the machine list answers 503, which recovery retries.
  bool down = false;

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
    if (asked.down) throw ApiException('Service unavailable', status: 503);
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
    asked.socket[type] = (asked.socket[type] ?? 0) + 1;
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

  test('an idle hidden window makes no periodic backend request', () {
    fakeAsync((async) {
      final asked = _Asked();
      final app = _Desktop(_Login(loggedIn: true), asked);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      _launch(async, app);
      expect(app.isGuest, isFalse);

      // The Swarm client as the workspace runs it (Desktop's reading, pushes heard).
      final swarms = _Swarms();
      final client = SuperTabClient(
        transport: swarms.call,
        storage: MemoryStore(),
        onTabs: (_, _) {},
        discoveryInterval: const Duration(seconds: 15),
      )..reading = SuperTabReading.desktop;
      client
        ..bind('owner')
        ..show('tab');
      client.open('tab');
      client.open('other');
      async.elapse(const Duration(seconds: 1));
      // The server's word that it pushes: on connect, then every 4 minutes (backend
      // lib/swarmClientPushes.ts PUSHES_REPEAT_MS).
      client.swarmChanged(const {});
      final repeat = Timer.periodic(
        const Duration(minutes: 4),
        (_) => client.swarmChanged(const {}),
      );
      async.elapse(const Duration(minutes: 1));

      // Hidden, as the workspace tells both (SuperTabWorkspace, SwarmScreen).
      app.appLifecycleChanged(AppLifecycleState.inactive);
      app.appLifecycleChanged(AppLifecycleState.hidden);
      client.pageVisible = false;
      async.elapse(const Duration(seconds: 2));

      final machines0 = asked.machineReads, desk0 = asked.deskReads;
      final socket0 = Map.of(asked.socket);
      swarms.paths.clear();
      const minutes = 10;
      for (var minute = 1; minute <= minutes; minute++) {
        async.elapse(const Duration(minutes: 1));
      }
      async.flushMicrotasks();

      final perKind = <String, int>{
        'GET /api/machines (+ /api/harness-shares)':
            asked.machineReads - machines0,
        'GET desk': asked.deskReads - desk0,
        for (final type in asked.socket.keys)
          'machine $type (relayed)': asked.socket[type]! - (socket0[type] ?? 0),
      };
      for (final path in swarms.paths) {
        final uri = Uri.parse(path);
        final kind = uri.pathSegments.length > 3
            ? 'Swarm ${uri.pathSegments[3]}'
            : 'Swarm ${uri.pathSegments.last}';
        perKind[kind] = (perKind[kind] ?? 0) + 1;
      }
      perKind.removeWhere((_, count) => count == 0);
      final total = perKind.values.fold(0, (sum, n) => sum + n);
      // ignore: avoid_print
      print(
        'hidden window, $minutes min: ${total / minutes} requests/min\n'
        '${[for (final e in perKind.entries) '  ${e.key}: ${e.value / minutes}/min'].join('\n')}',
      );
      expect(perKind, isEmpty, reason: 'no request on a clock while hidden');

      // Back in sight: each reads once.
      app.appLifecycleChanged(AppLifecycleState.inactive);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      client.pageVisible = true;
      async.elapse(const Duration(seconds: 2));
      expect(asked.socket['agents_list'], greaterThan(socket0['agents_list']!));
      expect(asked.machineReads, machines0 + 1);
      expect(swarms.paths, isNotEmpty);

      repeat.cancel();
      client.dispose();
      app.dispose();
      async.flushMicrotasks();
    });
  });
}
