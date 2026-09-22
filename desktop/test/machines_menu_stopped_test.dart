import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';

/// A stopped harness in the Machines menu is a choice, not a dead row: its
/// conversation is saved, and choosing it resumes it the way ⌘P does. The
/// row says " · stopped" first, since a resume takes a moment where an attach
/// does not, and a refused resume answers with the same snackbar as the picker.
class _ResumeApp extends AppNotifier {
  _ResumeApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    hasNavigationRail = false;
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Test host',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..terminalCapabilityAvailable = true
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        const Agent(id: 'live', name: 'Live', terminalAvailable: true),
        const Agent(id: 'gone', name: 'Gone'),
        const Agent(id: 'old', name: 'Old', status: 'stopped'),
      ];
  }

  final resumed = <String>[];
  RestartAgentResult reply = const RestartAgentResult();

  @override
  Future<RestartAgentResult> resumeAgent(String machineId, String agentId) {
    resumed.add(agentId);
    return Future.value(reply);
  }
}

void main() {
  late _ResumeApp app;
  late List<MethodCall> messages;
  late SwarmProjectStore projects;
  const channel = MethodChannel('harness/swarm_tabs');

  setUp(() {
    app = _ResumeApp();
    messages = [];
    projects = SwarmProjectStore();
  });

  Future<void> mount(WidgetTester tester) async {
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      messages.add(call);
      return true;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    await tester.pump();
  }

  Future<void> finish(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    projects.dispose();
  }

  Future<void> choose(WidgetTester tester, String agentId) async {
    final reply = Completer<void>();
    tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        MethodCall('machineAgent', {'machineId': 'm', 'agentId': agentId}),
      ),
      (_) => reply.complete(),
    );
    await tester.pumpAndSettle();
    await reply.future;
  }

  testWidgets('the menu offers a stopped harness, and says it is stopped', (
    tester,
  ) async {
    await mount(tester);
    final snapshot =
        messages.lastWhere((c) => c.method == 'machinesState').arguments as Map;
    final rows =
        ((snapshot['machines'] as List).single as Map)['agents'] as List;
    Map row(String id) => rows.firstWhere((r) => r['id'] == id) as Map;
    expect(row('live'), containsPair('canOpen', true));
    expect(row('live'), containsPair('stopped', false));
    // No terminal and not stopped: nothing to attach to and nothing to resume.
    expect(row('gone'), containsPair('canOpen', false));
    expect(row('gone'), containsPair('stopped', false));
    expect(row('old'), containsPair('canOpen', true));
    expect(row('old'), containsPair('stopped', true));
    await finish(tester);
  });

  testWidgets('a harness stopping redraws the menu, as a rename does', (
    tester,
  ) async {
    await mount(tester);
    messages.clear();
    final machine = app.machineStates['m']!;
    // Same name, same engine, still no terminal: only `stopped` changed.
    machine.agents[1] = const Agent(
      id: 'gone',
      name: 'Gone',
      status: 'stopped',
    );
    app.notifyListeners();
    await tester.pump();
    final snapshot =
        messages.lastWhere((c) => c.method == 'machinesState').arguments as Map;
    final rows =
        ((snapshot['machines'] as List).single as Map)['agents'] as List;
    final gone = rows.firstWhere((r) => r['id'] == 'gone') as Map;
    expect(gone, containsPair('canOpen', true));
    expect(gone, containsPair('stopped', true));
    await finish(tester);
  });

  testWidgets('choosing a stopped harness resumes it into the tab', (
    tester,
  ) async {
    await mount(tester);
    await choose(tester, 'old');
    expect(app.resumed, ['old']);
    expect(app.panes.map((pane) => pane.agentId), contains('old'));
    expect(find.byType(SnackBar), findsNothing);
    await finish(tester);
  });

  testWidgets('a refused resume says why and offers a new conversation', (
    tester,
  ) async {
    app.reply = const RestartAgentResult(
      error: 'The saved conversation is gone.',
      retryable: false,
    );
    await mount(tester);
    await choose(tester, 'old');
    expect(app.resumed, ['old']);
    expect(app.panes.map((pane) => pane.agentId), isNot(contains('old')));
    expect(find.text('The saved conversation is gone.'), findsOneWidget);
    expect(find.text('Start New Conversation'), findsOneWidget);
    await finish(tester);
  });
}
