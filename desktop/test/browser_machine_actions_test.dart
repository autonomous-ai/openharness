import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/api_connections_controller.dart';
import 'package:harness/models/model_manager_controller.dart';
import 'package:harness/orchestrator/orchestrator_launcher.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:harness/widgets/add_phone_dialog.dart';

import 'swarm_state_test.dart' show MemoryStore;

class _Connection extends WsConn {
  _Connection(String id)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: id,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  bool ready = true;
  Object? failure;
  final requests = <({String type, Map<String, dynamic> payload})>[];
  @override
  bool get isReady => ready;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type: type, payload: payload));
    if (failure != null) throw failure!;
    if (type == 'route_send') return {'ok': false, 'reason': 'fixture refused'};
    if (type == 'api_connections') return {'connections': [], 'presets': []};
    if (payload['action'] == 'list') return {'projects': []};
    return {'error': 'FIXTURE_STOP', 'detail': 'Fixture launch recorded'};
  }
}

void main() {
  // Initialize the generated icon library before entering the deep widget-build stack in DDC.
  setUpAll(() => expect(AppIcons.sparkles.codePoint, greaterThan(0)));
  late AppNotifier app;
  late Map<String, _Connection> connections;
  setUp(() {
    final storage = MemoryStore(),
        session = AuthSession(storage: MemoryStore());
    connections = {
      for (final id in ['a', 'b', 'shared']) id: _Connection(id),
    };
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      configStore: null,
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: session,
        keys: ViewerKeyStore(storage: storage),
      ),
      connectionForTest: (id) => connections[id]!,
    );
    for (final id in connections.keys) {
      app.machineStates[id] =
          MachineState(
              Machine(
                machineId: id,
                authMode: MachineAuthMode.remote,
                name: 'Computer $id',
                isShared: id == 'shared',
              ),
            )
            ..connectionStatus = ConnectionStatus.connected
            ..nodeOnline = true;
    }
    app.selectedMachineId = 'b';
  });
  tearDown(() async {
    app.dispose();
    for (final connection in connections.values) {
      await connection.close();
    }
  });

  test(
    'browser tools select a linked owner and exclude shared or offline hosts',
    () {
      expect(app.ownedActionMachine?.machine.machineId, 'b');
      app.machineStates['b']!.needsLink = true;
      expect(app.ownedActionMachine?.machine.machineId, 'a');
      app.machineStates['a']!.nodeOnline = false;
      app.selectedMachineId = 'shared';
      expect(app.ownedActionMachine, isNull);
    },
  );

  test('API edits and model controls keep their initial destination', () async {
    final apis = ApiConnectionsController(app);
    final models = ModelManagerController(app, poll: false);
    addTearDown(apis.dispose);
    addTearDown(models.dispose);
    expect(apis.hostLabel, 'Computer b');
    expect(models.machine?.machine.machineId, 'b');
    app.selectedMachineId = 'a';
    app.notifyListeners();
    expect(
      await apis.save({'provider': 'fal', 'apiKey': 'fixture-only'}),
      isTrue,
    );
    expect(models.machine?.machine.machineId, 'b');
    expect(connections['a']!.requests, isEmpty);
    expect(connections['b']!.requests.single.type, 'api_connections');
    app.machineStates['b']!.connectionStatus = ConnectionStatus.disconnected;
    app.notifyListeners();
    expect(await apis.save({'provider': 'fal', 'apiKey': 'not-sent'}), isFalse);
    expect(connections['b']!.requests, hasLength(1));
    expect(apis.hostLabel, 'Computer b');
  });

  test(
    'reopening models selects the current host without replacing API listeners',
    () {
      final models = ModelManagerController(app, poll: false);
      addTearDown(models.dispose);
      models.setPanelVisible(true);
      final apis = models.apis;
      app.selectedMachineId = 'a';
      models.setPanelVisible(true);
      expect(models.targetMachineId, 'b');
      models.setPanelVisible(false);
      models.setPanelVisible(true);
      expect(models.targetMachineId, 'a');
      expect(models.apis, same(apis));
      expect(apis.hostLabel, 'Computer a');
    },
  );

  test('API and orchestrator mutations are never queued on an unready or shared connection', () async {
    connections['b']!.ready = false;
    for (final id in ['b', 'shared']) {
      await expectLater(
        app.apiConnections(id, {'action': 'save'}),
        throwsStateError,
      );
      await expectLater(
        app.orchestratorRequest(id, {'action': 'start'}),
        throwsStateError,
      );
      expect(connections[id]!.requests, isEmpty);
    }
  });

  test('phone relay preserves protocol failures instead of reporting every reply as offline', () async {
    for (final code in [
      'NO_INTENT',
      'EXPIRED',
      'BUSY',
      'CODE_MISMATCH',
      'RATE_LIMITED',
      'TIMEOUT',
      'UNSUPPORTED',
    ]) {
      connections['b']!.failure = WsRequestFailure(
        responseType: 'phone_pair_result',
        code: code,
      );
      final answer = await phonePairOverRelay(app, 'b')(
        'ABCDEFGHJKMNPQRS',
        CancelToken(),
      );
      expect(
        answer.error,
        code == 'UNSUPPORTED' ? PhonePairAnswer.unavailable : code,
      );
    }
  });

  test('browser task delivery uses the linked host and never sends to a shared host', () async {
    expect(
      await app.sendRoutedTask('a', 'shared', 'not sent'),
      contains('Reconnect'),
    );
    expect(connections['shared']!.requests, isEmpty);
    expect(
      await app.sendRoutedTask('a', 'b', 'fixture'),
      contains('fixture refused'),
    );
    expect(connections['b']!.requests.last.type, 'route_send');
  });

  testWidgets('orchestrator launch keeps the host shown when it opened', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(home: OrchestratorLauncher(notifier: app)),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Computer b'), findsWidgets);
    app.selectedMachineId = 'a';
    app.notifyListeners();
    await tester.enterText(
      find.byKey(const ValueKey('orchestrator-prompt')),
      'Fixture project',
    );
    await tester.pump();
    if (kIsWeb) {
      await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    } else {
      await tester.tap(find.byKey(const ValueKey('orchestrator-start')));
    }
    await tester.pumpAndSettle();
    expect(connections['a']!.requests, isEmpty);
    expect(connections['b']!.requests.map((r) => r.payload['action']), [
      'list',
      'start',
    ]);
    expect(find.textContaining('Fixture launch recorded'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
