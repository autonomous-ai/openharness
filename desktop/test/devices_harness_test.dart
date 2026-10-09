import 'dart:async';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/devices/devices_harness_controller.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/ws/ws_conn.dart';

import 'experimental_features_test.dart' show AccountSettings;
import 'support/model_manager.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _DevicesConnection connection;
  late ModelManagerTestApp app;
  late DevicesHarnessController devices;
  setUp(() async {
    connection = _DevicesConnection();
    app = ModelManagerTestApp(connection);
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
  test(
    'an account switch during creation cannot attach the old conversation',
    () async {
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
    },
  );
}

class _DevicesConnection extends ModelManagerConnection {
  String? refusal;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'agent_create' && refusal != null) {
      throw WsRequestFailure(
        responseType: 'agent_create_result',
        code: refusal!,
        detail: 'autonomous/devices is not installed on this machine',
      );
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}
