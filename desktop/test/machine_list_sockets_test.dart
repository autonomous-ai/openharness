import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

/// Roadmap Phase 1.1 (2026-10-28): a machine that left the account kept its
/// socket, and anything that asked for a machine id the list no longer names
/// built one, each selecting a machine the backend refuses.

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  List<Machine> listed = const [];

  @override
  Future<Map<String, dynamic>?> me() async => null;
  @override
  Future<Map<String, dynamic>?> desk() async => null;
  @override
  Future<Map<String, dynamic>?> daemonDevices() async => null;
  @override
  Future<List<Machine>> machines() async => listed;
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => 'aabbccddeeff0011';
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      LocalCliEndpoint(
        computerId: 'aabbccddeeff0011',
        wsUri: Uri.parse('ws://127.0.0.1:18473/ws'),
        protocolVersion: localWsProtocolVersion,
        terminalProtocolVersion: 1,
        machineId: 'local-machine',
        backendOnline: true,
      );
}

class _Connection extends WsConn {
  _Connection(String machineId)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  bool closed = false;
  @override
  Future<void> close() async => closed = true;
  @override
  void wake(String reason) {}
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {'agents': []};
}

class _App extends AppNotifier {
  _App(_Api api, this.built)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        localCliDiscovery: _Discovery(),
        connectionForTest: (id) {
          built.add(id);
          return _Connection(id);
        },
      ) {
    this.api = api;
  }
  final List<String> built;
  @override
  Future<void> ensureCliDaemonReady() async {}
}

const _studio = Machine(
  machineId: 'studio',
  authMode: MachineAuthMode.remote,
  name: 'Studio',
);
const _laptop = Machine(
  machineId: 'laptop',
  authMode: MachineAuthMode.remote,
  name: 'Laptop',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _App app;
  late _Api api;
  final built = <String>[];
  setUp(() {
    built.clear();
    api = _Api()..listed = const [_studio, _laptop];
    app = _App(api, built)..status = AppStatus.authenticated;
  });
  tearDown(() => app.dispose());

  test('a machine that leaves the list has its socket closed', () async {
    await app.refreshMachines();
    final socket = _Connection('laptop');
    app.adoptPoolConnectionForTest('laptop', socket);

    api.listed = const [_studio];
    await app.refreshMachines();

    expect(app.stateOf('laptop'), isNull);
    expect(socket.closed, isTrue);
  });

  test(
    'no socket is built for a machine id the loaded list does not name',
    () async {
      api.listed = const [_studio];
      await app.refreshMachines();
      built.clear();

      await expectLater(
        app.superTabMachineRequest('laptop', {'action': 'renewNative'}),
        throwsA(anything),
      );
      expect(built, isNot(contains('laptop')));

      // A listed machine still gets one.
      await app.superTabMachineRequest('studio', {'action': 'renewNative'});
      expect(built, contains('studio'));
    },
  );
}
