import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

/// The account's machine list, as `/api/machines` answers it now.
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
  _Connection(String machineId, {this.onWake})
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final void Function(String machineId)? onWake;
  @override
  void wake(String reason) => onWake?.call(machineId);
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {'agents': []};
}

/// Signed in, with this computer's daemon and its machine connections faked.
class _App extends AppNotifier {
  _App(_Api api, {void Function(String machineId)? onWake})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        localCliDiscovery: _Discovery(),
        connectionForTest: (id) => _Connection(id, onWake: onWake),
      ) {
    this.api = api;
  }
  @override
  Future<void> ensureCliDaemonReady() async {}
}

const _studio = Machine(
  machineId: 'studio',
  authMode: MachineAuthMode.remote,
  name: 'MacBook Pro',
  machineShare: MachineShare(
    ownerName: 'Dee',
    ownerEmail: 'dee@acme.io',
    via: 'email',
    added: true,
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppNotifier app;
  AppNotifier withMachine(Machine machine) {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    app.machines = [machine];
    app.machineStates[machine.machineId] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    return app;
  }

  tearDown(() => app.dispose());

  // Seen 2026-10-16: the owner stopped sharing, and the person's pane said
  // "Machine selection failed: NOT_YOUR_MACHINE" with a Retry that could never work.
  test('a machine its owner stopped sharing says who, offers no retry, and is remembered for its panes', () async {
    app = withMachine(
      const Machine(
        machineId: 'studio',
        authMode: MachineAuthMode.remote,
        name: 'MacBook Pro',
        machineShare: MachineShare(
          ownerName: 'Dee',
          ownerEmail: 'dee@acme.io',
          via: 'email',
          added: true,
        ),
      ),
    );
    await app.handleEventForTest('studio', {
      'type': 'machine_select_error',
      'payload': {'machineId': 'studio', 'error': 'NOT_YOUR_MACHINE'},
    });
    expect(app.lastError, 'Dee stopped sharing MacBook Pro with you.');
    expect(app.lastErrorRetryable, isFalse);
    expect(app.sharingEnded('studio'), (name: 'MacBook Pro', owner: 'Dee'));
    expect(
      app.stateOf('studio')!.connectionStatus,
      ConnectionStatus.disconnected,
    );
  });

  // Seen 2026-10-16: "Tuan at Autonomous stopped sharing Mac Auto with you." stayed up after Tuan
  // shared it again and the app was using it.
  test(
    'the stopped-sharing message comes down once the machine is shared again',
    () async {
      final api = _Api();
      app = _App(api)..status = AppStatus.authenticated;
      app.machines = [_studio];
      app.machineStates['studio'] = MachineState(_studio)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected;
      await app.handleEventForTest('studio', {
        'type': 'machine_select_error',
        'payload': {'machineId': 'studio', 'error': 'NOT_YOUR_MACHINE'},
      });
      expect(app.lastError, 'Dee stopped sharing MacBook Pro with you.');
      // Still not shared: the list leaves it out, and the message stays.
      await app.refreshMachines();
      expect(app.lastError, 'Dee stopped sharing MacBook Pro with you.');
      // Shared again.
      api.listed = const [_studio];
      await app.refreshMachines();
      expect(app.lastError, isNull);
      expect(app.sharingEnded('studio'), isNull);
    },
  );

  test('the account’s own machine refused is said in words, retryable only when retrying can help', () async {
    app = withMachine(
      const Machine(
        machineId: 'own',
        authMode: MachineAuthMode.remote,
        name: 'Studio',
      ),
    );
    await app.handleEventForTest('own', {
      'type': 'machine_select_error',
      'payload': {'machineId': 'own', 'error': 'NOT_YOUR_MACHINE'},
    });
    expect(app.lastError, 'Studio is no longer on your account.');
    expect(app.lastErrorRetryable, isFalse);
    expect(app.sharingEnded('own'), isNull);
    await app.handleEventForTest('own', {
      'type': 'machine_select_error',
      'payload': {'machineId': 'own', 'error': 'MACHINE_START_FAILED'},
    });
    expect(
      app.lastError,
      'Could not connect to Studio. Try again in a moment.',
    );
    expect(app.lastErrorRetryable, isTrue);
  });

  // Prod, 2026-10-28: a laptop removed from the account in September was still selected every few
  // seconds. Refused as not on the account, an own machine is read again from the account's list.
  for (final (how, refuse) in <(String, Future<void> Function(AppNotifier))>[
    (
      'the backend’s refusal',
      (app) => app.handleEventForTest('gone', {
        'type': 'machine_select_error',
        'payload': {'machineId': 'gone', 'error': 'NOT_YOUR_MACHINE'},
      }),
    ),
    (
      'the daemon relay’s close',
      (app) async => app.localFailureForTest('gone', 1011, 'NOT_YOUR_MACHINE'),
    ),
  ]) {
    test('an own machine refused by $how leaves the list', () async {
      const gone = Machine(
        machineId: 'gone',
        authMode: MachineAuthMode.remote,
        name: 'M1 Laptop',
      );
      const kept = Machine(
        machineId: 'kept',
        authMode: MachineAuthMode.remote,
        name: 'Studio',
      );
      final api = _Api()..listed = const [kept];
      app = _App(api)..status = AppStatus.authenticated;
      app.machines = [gone, kept];
      for (final machine in app.machines) {
        app.machineStates[machine.machineId] = MachineState(machine)
          ..nodeOnline = true
          ..connectionStatus = ConnectionStatus.connected;
      }
      await refuse(app);
      for (var i = 0; i < 20; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      final listed = app.machines.map((m) => m.machineId);
      expect(listed, contains('kept'));
      expect(listed, isNot(contains('gone')));
      expect(app.stateOf('gone'), isNull);
      expect(app.lastErrorRetryable, isFalse);
    });
  }

  // A relayed machine that was off waits parked (WsConn.isParked) until it is reported back: the
  // machine list's refresh saying it is online is that word.
  test('a machine the list reports online wakes its parked connection', () async {
    const studio = Machine(
      machineId: 'studio',
      authMode: MachineAuthMode.remote,
      name: 'Studio',
      status: 'online',
    );
    final api = _Api()..listed = const [studio];
    final woken = <String>[];
    app = _App(api, onWake: woken.add)..status = AppStatus.authenticated;
    await app.refreshMachines();
    expect(woken, contains('studio'));
  });

  test('every refusal code reads as a sentence', () {
    for (final code in [
      'NOT_YOUR_MACHINE',
      'MACHINE_ENV_MISMATCH',
      'MACHINE_PAYMENT_PENDING',
      'MACHINE_SUBSCRIPTION_REQUIRED',
      'SOMETHING_NEW',
    ]) {
      final text = machineSelectErrorText(code, 'Studio');
      expect(text, contains('Studio'));
      expect(text, isNot(contains('_')), reason: code);
    }
    app = withMachine(
      const Machine(machineId: 'x', authMode: MachineAuthMode.remote),
    );
  });
}
