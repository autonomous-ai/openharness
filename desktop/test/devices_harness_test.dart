import 'dart:async';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/devices/devices_harness_controller.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/ws/ws_conn.dart';

import 'experimental_features_test.dart' show AccountSettings;
import 'support/model_manager.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _DevicesConnection connection;
  late _DevicesTestApp app;
  late DevicesHarnessController devices;
  setUp(() async {
    connection = _DevicesConnection();
    app = _DevicesTestApp(connection);
    app.stateOf('m')!.engines.replace([
      const EngineAvailability(engine: 'codex', installed: true),
    ]);
    app.currentUser = const CurrentUserProfile(
      id: 'a',
      email: 'a@example.test',
    );
    app.experimentalFeatures.bind('a', transport: AccountSettings('a'));
    await app.experimentalFeatures.refresh();
    app.openDevices();
    devices = DevicesHarnessController(app);
  });
  tearDown(() {
    devices.dispose();
    app.dispose();
  });

  Future<({Swarm tab, SuperTabController controller})> embeddedDevices() async {
    const id = '0123456789abcdef01234567';
    connection.server.state['id'] = id;
    final tab = Swarm(id: 'embedded', name: 'Team', kind: 'superTab')
      ..superTabId = id;
    app.swarms.add(tab);
    app.selectSwarm(tab.id);
    final controller = await app.superTabs.open(id);
    await controller.refresh();
    controller.selectDevices();
    app.prepareSuperTabDevices(tab.id);
    return (tab: tab, controller: controller);
  }

  test(
    'missing bundle keeps chat at 30 percent and recovers in the same tab',
    () async {
      final tab = app.activeSwarm;
      connection.refusal = 'INVALID_DSH';
      await devices.open();
      expect(devices.error, contains('Update Harness'));
      expect(devices.error, isNot(contains('autonomous/devices')));
      expect(tab.panes, hasLength(2));
      expect(tab.panes.first.isDevices, isTrue);
      expect(tab.panes.last.agentId, isNull);
      expect(tab.manualLayout!.tiles.first.width, .7);
      connection.refusal = null;
      await devices.open();
      expect(devices.error, isNull);
      expect(app.activeSwarm, same(tab));
      expect(tab.panes, hasLength(2));
      expect(tab.panes.last.agentId, 'manager');
      expect(tab.manualLayout!.tiles.last.width, closeTo(.3, .001));
    },
  );

  test(
    'startup reserves chat and respects resizing while the launch is pending',
    () async {
      connection.holdCreation = Completer<void>();
      final opening = devices.open();
      expect(app.panes, hasLength(2));
      expect(app.activeSwarm.manualLayout!.tiles.first.width, .7);
      final resized = PaneArrangement(const [
        Rect.fromLTRB(0, 0, .6, 1),
        Rect.fromLTRB(.6, 0, 1, 1),
      ]);
      app.activeSwarm.savePaneSizes('2:manual', resized);
      connection.holdCreation!.complete();
      await opening;
      expect(app.panes, hasLength(2));
      expect(app.activeSwarm.manualLayout, same(resized));
      await devices.open();
      expect(app.activeSwarm.manualLayout, same(resized));
      expect(connection.creations, hasLength(1));
    },
  );

  test(
    'waits for the existing inventory before deciding to create a conversation',
    () async {
      final loading = Completer<void>();
      final owner = app.stateOf('m')!;
      owner.agentLoadStatus = AgentLoadStatus.loading;
      owner.agentsLoadInFlight = loading.future;
      final opening = devices.open();
      expect(connection.creations, isEmpty);
      owner.agents = [
        const Agent(
          id: 'previous',
          name: 'Devices',
          engine: 'codex',
          dsh: devicesHarnessId,
          terminalAvailable: true,
        ),
      ];
      owner.agentLoadStatus = AgentLoadStatus.loaded;
      loading.complete();
      await opening;
      expect(connection.creations, isEmpty);
      expect(app.panes.any((pane) => pane.agentId == 'previous'), isTrue);
    },
  );

  test(
    'opens the bundled DSH beside its dashboard and reuses its conversation',
    () async {
      await devices.open();
      expect(devices.error, isNull);
      expect(
        connection.creations.single,
        containsPair('dsh', devicesHarnessId),
      );
      expect(
        connection.creations.single,
        containsPair('bypassPermission', false),
      );
      expect(connection.creations.single['prompt'], isNull);
      expect(app.activeSwarm.name, 'Devices');
      expect(app.panes.where((pane) => pane.isDevices), hasLength(1));
      expect(
        app.panes.where((pane) => pane.agentId == 'manager'),
        hasLength(1),
      );
      await devices.open();
      expect(connection.creations, hasLength(1));
      expect(app.panes, hasLength(2));
    },
  );
  test(
    'concurrent opens and an ambiguous creation reuse one durable request',
    () async {
      connection.holdCreation = Completer<void>();
      connection.loseFirstReply = true;
      final first = devices.open();
      expect(identical(first, devices.open()), isTrue);
      connection.holdCreation!.complete();
      await first;
      expect(devices.error, isNotNull);
      await devices.open();
      expect(devices.error, isNull);
      expect(connection.creations, hasLength(1));
      expect(app.panes, hasLength(2));
    },
  );
  test('an account switch during creation cannot attach the old conversation', () async {
    connection.holdCreation = Completer<void>();
    final opening = devices.open();
    await Future<void>.delayed(Duration.zero);
    app.currentUser = const CurrentUserProfile(
      id: 'b',
      email: 'b@example.test',
    );
    connection.holdCreation!.complete();
    await opening;
    // Devices is not an account opt-in, so its tab may stay; the old account's
    // conversation must not be attached to it.
    expect(app.allPanes.where((pane) => pane.agentId == 'manager'), isEmpty);
    await devices.open();
    expect(connection.creations.length, lessThanOrEqualTo(1));
  });

  test(
    'an open requested for a new account while creation is pending completes '
    'without attaching the old receipt',
    () async {
      connection.uniqueAgentIds = true;
      connection.holdCreation = Completer<void>();
      final previousTab = app.activeSwarm;
      final first = devices.open();
      await Future<void>.delayed(Duration.zero);
      expect(connection.creations, hasLength(1));

      app.currentUser = const CurrentUserProfile(
        id: 'b',
        email: 'b@example.test',
      );
      // A newly signed-in computer has its own inventory. The old in-flight
      // creation is still waiting on its original MachineState and receipt.
      final previousMachine = app.stateOf('m')!;
      app.machineStates['m'] = MachineState(previousMachine.machine)
        ..localOnly = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..engines.replace([
          const EngineAvailability(engine: 'codex', installed: true),
        ]);
      final second = devices.open(swarmId: previousTab.id);
      connection.holdCreation!.complete();
      await Future.wait([first, second]);

      expect(devices.error, isNull);
      expect(devices.opening, isFalse);
      expect(connection.creations, hasLength(2));
      expect(
        connection.creations.map((request) => request['creationId']).toSet(),
        hasLength(2),
      );
      expect(app.attachments, [
        (account: 'b', workspace: previousTab.id, agent: 'manager-2'),
      ]);
      expect(previousTab.panes.last.agentId, 'manager-2');
      expect(
        app.allPanes.where((pane) => pane.agentId == 'manager-1'),
        isEmpty,
      );
    },
  );

  test('embedded Devices ignores a launch already pending for standalone '
      'Devices without retargeting its receipt', () async {
    connection.holdCreation = Completer<void>();
    final previousTab = app.activeSwarm;
    final first = devices.open();
    await Future<void>.delayed(Duration.zero);
    expect(connection.creations, hasLength(1));
    final next = await embeddedDevices();
    var finished = false;
    final second = devices
        .open(swarmId: next.tab.id)
        .then((_) => finished = true);
    await Future<void>.delayed(Duration.zero);
    expect(finished, isTrue);
    connection.holdCreation!.complete();
    await Future.wait([first, second]);

    expect(devices.error, isNull);
    expect(connection.creations, hasLength(1));
    expect(app.attachments, [
      (account: 'a', workspace: previousTab.id, agent: 'manager'),
    ]);
    expect(previousTab.panes.last.agentId, 'manager');
    expect(next.tab.panes, hasLength(1));
    expect(next.tab.panes.single.isDevices, isTrue);
    expect(next.tab.panes.single.ownerAgentId, isNull);
    expect(app.activeSwarm, same(next.tab));
  });

  for (final existingConversation in [false, true]) {
    test('embedded Devices never probes, starts or reuses a conversation '
        '(existing standalone conversation: $existingConversation)', () async {
      final standalone = app.activeSwarm;
      if (existingConversation) await devices.open();
      final next = await embeddedDevices();
      connection.requests.clear();
      final before = app.attachments.toList();
      await devices.open(swarmId: next.tab.id);
      expect(connection.requests, isEmpty);
      expect(connection.creations, hasLength(existingConversation ? 1 : 0));
      expect(app.resumes, 0);
      expect(app.attachments, before);
      expect(next.tab.panes, hasLength(1));
      expect(next.tab.panes.single.isDevices, isTrue);
      expect(next.tab.panes.single.ownerAgentId, isNull);
      await app.showDevicesTerminal('m', 'manager', swarmId: next.tab.id);
      expect(next.tab.panes, hasLength(1));
      expect(next.tab.panes.single.agentId, isNull);
      expect(next.tab.panes.single.ownerAgentId, isNull);
      expect(standalone.panes, hasLength(2));
      expect(
        standalone.panes.last.agentId,
        existingConversation ? 'manager' : null,
      );
      expect(app.activeSwarm, same(next.tab));
    });
  }
}

class _DevicesTestApp extends ModelManagerTestApp {
  _DevicesTestApp(super.connection);

  @override
  final localStore = MemoryStore();

  final attachments = <({String? account, String? workspace, String agent})>[];

  @override
  Future<void> showDevicesTerminal(
    String machineId,
    String agentId, {
    String? swarmId,
  }) async {
    attachments.add((
      account: currentUser?.id,
      workspace: swarmId,
      agent: agentId,
    ));
    await super.showDevicesTerminal(machineId, agentId, swarmId: swarmId);
  }
}

class _DevicesConnection extends ModelManagerConnection {
  String? refusal;
  bool uniqueAgentIds = false;
  final requests = <String>[];
  final server = ConversationServer();

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add(type);
    if (type == 'agent_create' && refusal != null) {
      throw WsRequestFailure(
        responseType: 'agent_create_result',
        code: refusal!,
        detail: 'autonomous/devices is not installed on this machine',
      );
    }
    if (type == 'super_tabs') {
      return {
        'ok': true,
        'value': await server.request(
          payload['method'] as String,
          payload['path'] as String,
          body: payload['body'] as Map<String, dynamic>?,
        ),
      };
    }
    final reply = await super.request(type, payload: payload, timeout: timeout);
    if (uniqueAgentIds && reply['agent'] is Map) {
      final index = creations.indexWhere(
        (request) => request['creationId'] == payload['creationId'],
      );
      return {
        ...reply,
        'agent': {...reply['agent'] as Map, 'id': 'manager-${index + 1}'},
      };
    }
    return reply;
  }
}
