import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/find_models.dart';
import 'package:harness_mobile/phone/find_row.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// A machine that serves two local models and records what it is asked.
class _Conn extends WsConn {
  _Conn(this.asked)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<(String, Map<String, dynamic>)> asked;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    asked.add((type, payload));
    if (type == 'grid_models_list') {
      return {
        'gridName': 'mine',
        'models': const [],
        'grids': [
          {
            'name': 'mine',
            'own': true,
            'models': [
              {'id': 'qwen3-coder-30b', 'node': 'studio'},
              {'id': 'gpt-oss-20b', 'node': 'studio'},
            ],
          },
        ],
      };
    }
    return {};
  }
}

/// Find's `:` — the desktop ⌘P's models mode, for the agent on screen.
void main() {
  /// Unmounts and lets the machine's timers run out — the search asks every machine for its
  /// agents as it opens, and those requests carry timeouts.
  Future<void> settle(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 30));
  }

  Future<List<(String, Map<String, dynamic>)>> pumpFind(
    WidgetTester tester, {
    String engine = 'claude',
  }) async {
    final asked = <(String, Map<String, dynamic>)>[];
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _Conn(asked),
    );
    addTearDown(app.dispose);
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'M2',
    );
    app.machines = [machine];
    app.machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        Agent(id: 'a', name: 'hn', engine: engine, terminalAvailable: true),
      ];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalSearchOverlay(
            notifier: app,
            animation: const AlwaysStoppedAnimation(1),
            showing: (machineId: 'm', agentId: 'a'),
            onClose: () {},
          ),
        ),
      ),
    );
    await tester.enterText(find.byType(TextField), ':');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return asked;
  }

  testWidgets(': lists the subscription and the machine\'s models', (
    tester,
  ) async {
    await pumpFind(tester);
    expect(find.byType(FindModels), findsOneWidget);
    // Each model is a Find row of its own — the same rows as every other mode of Find.
    expect(find.byType(FindRow), findsWidgets);
    expect(
      find.textContaining('qwen3-coder-30b', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.textContaining('gpt-oss-20b', findRichText: true),
      findsOneWidget,
    );
    await settle(tester);
  });

  testWidgets('typing after : narrows the models', (tester) async {
    await pumpFind(tester);
    await tester.enterText(find.byType(TextField), ':qwen');
    await tester.pump();
    expect(
      find.textContaining('qwen3-coder-30b', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.textContaining('gpt-oss-20b', findRichText: true),
      findsNothing,
    );
    await settle(tester);
  });

  testWidgets('a tap moves the agent onto the model', (tester) async {
    final asked = await pumpFind(tester);
    await tester.tap(
      find.textContaining('qwen3-coder-30b', findRichText: true),
    );
    await tester.pump();
    final retarget = asked.where((call) => call.$1 == 'agent_retarget');
    expect(retarget, hasLength(1));
    expect(retarget.single.$2['gridModel'], 'qwen3-coder-30b');
    await settle(tester);
  });

  testWidgets('an engine that cannot switch is told so in one line', (
    tester,
  ) async {
    await pumpFind(tester, engine: 'cursor');
    expect(
      find.textContaining('keeps its own model', findRichText: true),
      findsOneWidget,
    );
    await settle(tester);
  });
}
