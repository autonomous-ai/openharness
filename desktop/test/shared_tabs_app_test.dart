import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/agent_messages_api.dart' show agentMessagesSwitch;
import 'swarm_state_test.dart' show createApp, MemoryStore;

const _tab = 'aaaaaaaaaaaaaaaaaaaaaaaa';

Map<String, dynamic> _shares() => {
  'api': 2,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'm'},
  'rosters': [
    {
      'sharedTabId': _tab,
      'tabId': null,
      'version': 3,
      'name': 'app',
      'owner': {
        'accountId': 'alice',
        'email': 'alice@example.com',
        'machineId': 'ma',
        'machinePublicKey': 'k',
      },
      'leader': null,
      'members': [],
      'invites': [],
      'harnesses': [],
    },
  ],
  'invites': [],
  'alerts': [],
  'pending': [],
  'notices': [],
  'untrusted': [],
  'activity': [],
};

/// A daemon that answers `agent_messages` `shares` and counts the asks.
class _Daemon extends WsConn {
  _Daemon(String machineId)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  int shareReads = 0;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_messages' && payload['action'] == 'shares') {
      shareReads++;
      return _shares();
    }
    return const {};
  }
}

const _shared = Machine(
  machineId: 'ma',
  authMode: MachineAuthMode.remote,
  name: 'Alice',
  isShared: true,
);

AppNotifier _native(_Daemon daemon) {
  final app = createApp(
    store: MemoryStore(),
    connectionForTest: (_) => daemon,
    connected: true,
  );
  app.machineStates['m']!.localOnly = true;
  return app;
}

Agent _agent(String id) =>
    Agent(id: id, name: id, engine: 'claude', terminalAvailable: true);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('shared_tabs_changed from this computer reads shares again', () async {
    final daemon = _Daemon('m');
    final app = _native(daemon);
    addTearDown(app.dispose);
    await app.sharedTabs.refresh();
    final before = daemon.shareReads;
    await app.handleEventForTest('m', {
      'type': 'shared_tabs_changed',
      'payload': {'rev': 2},
    });
    await Future<void>.delayed(Duration.zero);
    expect(daemon.shareReads, before + 1);
  });

  test('shared_tabs_changed from another connection is ignored', () async {
    final daemon = _Daemon('m');
    final app = _native(daemon);
    addTearDown(app.dispose);
    app.machineStates['other'] = MachineState(
      const Machine(
        machineId: 'other',
        authMode: MachineAuthMode.remote,
        name: 'Other',
      ),
    );
    await app.sharedTabs.refresh();
    final before = daemon.shareReads;
    await app.handleEventForTest('other', {
      'type': 'shared_tabs_changed',
      'payload': {'rev': 2},
    });
    await Future<void>.delayed(Duration.zero);
    expect(daemon.shareReads, before);
  });

  test('a reconnect reads shares again, not 60 s later (Review Focus 3)', () async {
    final daemon = _Daemon('m');
    final app = _native(daemon);
    addTearDown(app.dispose);
    await app.sharedTabs.refresh();
    final before = daemon.shareReads;
    app.onMachineConnectedForTest('m');
    await Future<void>.delayed(Duration.zero);
    expect(daemon.shareReads, before + 1);
  });

  // The account default. Every daemon refuses `shares` then; asking was a
  // WARN every 60 s and on each reconnect.
  test('with the account\'s Agent Messages switch off, a reconnect or '
      'shared_tabs_changed asks nothing; turned on, shares are read', () async {
    final daemon = _Daemon('m');
    final app = _native(daemon);
    addTearDown(app.dispose);
    await agentMessagesSwitch(app, false);
    app.onMachineConnectedForTest('m');
    await app.handleEventForTest('m', {
      'type': 'shared_tabs_changed',
      'payload': {'rev': 2},
    });
    await app.sharedTabs.refresh();
    await Future<void>.delayed(Duration.zero);
    expect(daemon.shareReads, 0);
    expect(app.sharedTabs.state, SharedTabsState.off);
    await agentMessagesSwitch(app, true);
    await Future<void>.delayed(Duration.zero);
    expect(daemon.shareReads, 1);
    expect(app.sharedTabs.state, SharedTabsState.ready);
  });

  test('sign-out resets shared tabs', () async {
    final daemon = _Daemon('m');
    final app = _native(daemon)
      ..status = AppStatus.authenticated
      ..signedIn = true;
    addTearDown(app.dispose);
    await app.sharedTabs.refresh();
    expect(app.sharedTabs.snapshot.tabs, isNotEmpty);
    app.expireSessionForTest('Your sign-in expired.');
    expect(app.sharedTabs.snapshot.tabs, isEmpty);
    expect(app.sharedTabs.state, SharedTabsState.unknown);
  });

  test('the target is this computer natively', () {
    final app = _native(_Daemon('m'));
    addTearDown(app.dispose);
    expect(app.sharedTabsTarget?.machine.machineId, 'm');
  });

  group('shared_activity', () {
    late AppNotifier app;
    setUp(() {
      app = _native(_Daemon('m'));
      app.machines = [...app.machines, _shared];
      app.machineStates['ma'] = MachineState(_shared)
        ..nodeOnline = true
        ..agents = [_agent('a1')];
    });
    tearDown(() => app.dispose());

    Map<String, dynamic> frame(String state, {String machine = 'ma', String tab = _tab}) => {
      'type': 'shared_activity',
      'payload': {
        'sharedTabId': tab,
        'machineId': machine,
        'agentId': 'a1',
        'state': state,
        'validForMs': 30000,
      },
    };

    testWidgets("marks another account's harness working, and the lease runs out", (
      tester,
    ) async {
      await app.handleEventForTest('m', frame('working'));
      expect(app.machineStates['ma']!.processingAgentIds, contains('a1'));
      await tester.pump(const Duration(seconds: 31));
      expect(
        app.machineStates['ma']!.processingAgentIds,
        isNot(contains('a1')),
      );
    });

    testWidgets('idle clears it before the lease ends', (tester) async {
      await app.handleEventForTest('m', frame('working'));
      await app.handleEventForTest('m', frame('idle'));
      expect(
        app.machineStates['ma']!.processingAgentIds,
        isNot(contains('a1')),
      );
      await tester.pump(const Duration(seconds: 31));
    });

    testWidgets('one harness in two shared tabs keeps following the first after a frame from the second (final review of 1c, M2)', (tester) async {
      const other = 'bbbbbbbbbbbbbbbbbbbbbbbb';
      await app.handleEventForTest('m', frame('working'));
      await app.handleEventForTest('m', frame('working', tab: other));
      // The second tab's sender stops; the first's renews its lease.
      await tester.pump(const Duration(seconds: 25));
      await app.handleEventForTest('m', frame('working'));
      await tester.pump(const Duration(seconds: 10));
      expect(app.machineStates['ma']!.processingAgentIds, contains('a1'));
      // And its idle is taken too.
      await app.handleEventForTest('m', frame('idle'));
      expect(app.machineStates['ma']!.processingAgentIds, isNot(contains('a1')));
      await tester.pump(const Duration(seconds: 31));
    });

    testWidgets('for an own machine it is ignored', (tester) async {
      app.machineStates['m']!.agents = [_agent('a1')];
      await app.handleEventForTest('m', frame('working', machine: 'm'));
      expect(app.machineStates['m']!.processingAgentIds, isEmpty);
    });

    testWidgets('from another connection it is ignored', (tester) async {
      app.machineStates['m']!.localOnly = false;
      await app.handleEventForTest('ma', frame('working'));
      expect(app.machineStates['ma']!.processingAgentIds, isEmpty);
    });
  });

  test('on the web the target is an own online machine, never a shared one', () {
    final storage = MemoryStore();
    final session = AuthSession(storage: storage);
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: session,
        keys: ViewerKeyStore(storage: storage),
      ),
    );
    addTearDown(app.dispose);
    const own = Machine(
      machineId: 'own',
      authMode: MachineAuthMode.remote,
      name: 'Mine',
    );
    app.machines = [_shared, own];
    app.machineStates['ma'] = MachineState(_shared)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    expect(
      app.sharedTabsTarget,
      isNull,
      reason: 'only a shared machine is up: nobody to ask',
    );
    app.machineStates['own'] = MachineState(own)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    app.selectedMachineId = 'ma';
    expect(app.sharedTabsTarget?.machine.machineId, 'own');
  });

  test('on the web a machine another account shares whole is never the target', () {
    final storage = MemoryStore();
    final session = AuthSession(storage: storage);
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: session,
        keys: ViewerKeyStore(storage: storage),
      ),
    );
    addTearDown(app.dispose);
    const wholeShared = Machine(
      machineId: 'studio',
      authMode: MachineAuthMode.remote,
      name: 'Studio',
      machineShare: MachineShare(
        ownerName: 'Dee',
        ownerEmail: 'dee@acme.io',
        via: 'email',
        added: true,
      ),
    );
    const own = Machine(
      machineId: 'own',
      authMode: MachineAuthMode.remote,
      name: 'Mine',
    );
    app.machines = [wholeShared, own];
    app.machineStates['studio'] = MachineState(wholeShared)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    app.selectedMachineId = 'studio';
    expect(
      app.sharedTabsTarget,
      isNull,
      reason: 'its daemon would answer as its owner',
    );
    app.machineStates['own'] = MachineState(own)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    expect(app.sharedTabsTarget?.machine.machineId, 'own');
  });
}
