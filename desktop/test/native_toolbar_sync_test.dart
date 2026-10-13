import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/swarm_catalog.dart';

import 'support/agent_messages_api.dart';
import 'swarm_screen_test.dart' show mount;

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) => throw StateError('No test transport'),
      ) {
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Fixture',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        const Agent(id: 'a', name: 'Before', terminalAvailable: true),
      ];
    rememberOpenedHarness('m', 'a');
    renameSwarm(activeSwarmId, 'Before');
  }

  int historyReads = 0;
  final historyCallers = <String>[];
  bool traceHistory = false;

  @override
  List<ClosedWork> get closedHistory {
    historyReads++;
    if (traceHistory) historyCallers.add(StackTrace.current.toString());
    return super.closedHistory;
  }

  void announce() => notifyListeners();
}

void main() {
  const channel = MethodChannel('harness/swarm_tabs');
  late List<MethodCall> calls;
  List<Map> updates() => [
    for (final call in calls)
      if (call.method == 'update') call.arguments as Map,
  ];

  setUp(() {
    calls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return null;
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets(
    'notification burst publishes the latest toolbar and inventory before a frame',
    (tester) async {
      final app = _App();
      addTearDown(app.dispose);
      await mount(tester, app, nativeTabs: true);
      await tester.pumpAndSettle();
      calls.clear();
      app.historyReads = 0;
      app.traceHistory = true;

      app.renameSwarm(app.activeSwarmId, 'Intermediate');
      app.machineStates['m']!.agents = [
        const Agent(id: 'a', name: 'After', status: 'stopped'),
      ];
      app.renameSwarm(app.activeSwarmId, 'Final');
      for (var i = 0; i < 6; i++) {
        app.announce();
      }
      expect(app.historyReads, 0);
      await tester.idle();
      expect(app.historyReads, 1);
      // The benchmark's history counter measures payload construction, not a
      // Flutter build or an unrelated listener's history access.
      expect(app.historyCallers.single, contains('_flushNative'));
      expect(updates(), hasLength(1));
      expect(updates().single['runningSessions'], 0);
      expect(
        (updates().single['harnessMonitor'] as Map)['text'],
        'Harnesses 0',
      );
      expect((updates().single['tabs'] as List).single['name'], 'Final');
      final machines = calls.singleWhere((c) => c.method == 'machinesState');
      final machine = ((machines.arguments as Map)['machines'] as List).single;
      expect((machine['agents'] as List).single['title'], 'After');
      expect((machine['agents'] as List).single['stopped'], isTrue);

      calls.clear();
      app.historyReads = 0;
      app.renameSwarm(app.activeSwarmId, 'Next turn');
      await tester.idle();
      expect(app.historyReads, 1);
      expect((updates().single['tabs'] as List).single['name'], 'Next turn');
      expect(calls.where((c) => c.method == 'machinesState'), isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'unchanged bursts do one construction and send no native payload',
    (tester) async {
      final app = _App();
      addTearDown(app.dispose);
      await mount(tester, app, nativeTabs: true);
      await tester.pumpAndSettle();
      calls.clear();
      app.historyReads = 0;
      for (var i = 0; i < 16; i++) {
        app.announce();
      }
      await tester.idle();
      expect(app.historyReads, 1);
      expect(calls, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a queued update cannot repopulate a disposed toolbar', (
    tester,
  ) async {
    final app = _App();
    addTearDown(app.dispose);
    final shown = ValueNotifier(true);
    final projects = SwarmProjectStore();
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: ValueListenableBuilder(
          valueListenable: shown,
          builder: (context, visible, child) {
            if (!visible) {
              // Queue from the parent's build, immediately before its existing
              // workspace is removed in this same frame.
              app.announce();
              return const SizedBox();
            }
            return SwarmScreen(
              notifier: app,
              nativeTabs: true,
              projectStore: projects,
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    calls.clear();
    shown.value = false;
    await tester.pump();
    await tester.idle();
    expect(updates(), [
      {'tabs': [], 'enabled': false},
    ]);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    shown.dispose();
    projects.dispose();
  });

  testWidgets(
    'covered routes keep native actions disabled through inventory changes',
    (tester) async {
      final app = _App();
      addTearDown(app.dispose);
      await mount(tester, app, nativeTabs: true);
      await tester.pumpAndSettle();
      final navigator = Navigator.of(tester.element(find.byType(SwarmScreen)));
      navigator.push<void>(
        MaterialPageRoute(
          builder: (_) => const Scaffold(body: Text('Covered')),
        ),
      );
      await tester.pumpAndSettle();
      expect(updates().last['enabled'], isFalse);
      calls.clear();
      app.renameSwarm(app.activeSwarmId, 'Changed while covered');
      app.announce();
      await tester.idle();
      expect(updates().single['enabled'], isFalse);
      expect(
        (updates().single['tabs'] as List).single['name'],
        'Changed while covered',
      );
      navigator.pop();
      await tester.pumpAndSettle();
      expect(updates().last['enabled'], isTrue);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('tabs carry Agent Messages, and its actions reach the tab', (
    tester,
  ) async {
    final app = _App();
    addTearDown(app.dispose);
    final api = await joinAgentMessagesDesk(app);
    await mount(tester, app, nativeTabs: true);
    await tester.pumpAndSettle();
    final tab = app.activeSwarmId;
    Map row() => (updates().last['tabs'] as List).single as Map;

    // Traffic alone rebuilds no workspace; it reaches the tab only while on,
    // since a tab that is off says nothing about agents messaging.
    app.agentMessages.handleEvent({'tabId': tab, 'messageId': 'm0000001'});
    await tester.idle();
    expect(row()['agentMessages'], isFalse);
    expect(row()['agentMessagesFlowing'], isFalse);
    expect(updates().last['activeAgentMessages'], isFalse);

    Future<void> native(String method) =>
        tester.binding.defaultBinaryMessenger.handlePlatformMessage(
          'harness/swarm_tabs',
          const StandardMethodCodec().encodeMethodCall(
            MethodCall(method, {'id': tab}),
          ),
          (_) {},
        );
    // 💬 or the tab's menu turns it on for that tab.
    unawaited(native('toggleAgentMessages'));
    await tester.pumpAndSettle();
    expect(api.writes, [(tab, true)]);
    expect(row()['agentMessages'], isTrue);
    expect(row()['agentMessagesFlowing'], isTrue);
    expect(updates().last['activeAgentMessages'], isTrue);

    // A refused turn off goes back, and says so where the click was.
    api.writeError = StateError('offline');
    unawaited(native('toggleAgentMessages'));
    await tester.pumpAndSettle();
    expect(app.agentMessages.isOn(tab), isTrue);
    expect(row()['agentMessages'], isTrue);
    expect(find.textContaining('could not be turned off'), findsOneWidget);
    api.writeError = null;

    // Show Agent Messages opens the tab's log.
    unawaited(native('showAgentMessages'));
    await tester.pumpAndSettle();
    expect(find.text('Before · Agent Messages'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Before · Agent Messages'), findsNothing);

    await tester.pump(const Duration(seconds: 61));
    await tester.idle();
    expect(row()['agentMessagesFlowing'], isFalse);

    // An older CLI or backend: no 💬, no menu row.
    api.unsupported = true;
    await app.agentMessages.refresh();
    await tester.idle();
    expect(row().containsKey('agentMessages'), isFalse);
    expect(updates().last['activeAgentMessages'], isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a tab off the desk has no Agent Messages', (tester) async {
    final app = _App();
    addTearDown(app.dispose);
    await mount(tester, app, nativeTabs: true);
    await tester.pumpAndSettle();
    expect(app.agentMessagesOffered(app.activeSwarmId), isFalse);
    final row = (updates().last['tabs'] as List).single as Map;
    expect(row.containsKey('agentMessages'), isFalse);
    expect(updates().last['activeAgentMessages'], isNull);
    unawaited(
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'harness/swarm_tabs',
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('showAgentMessages'),
        ),
        (_) {},
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Agent Messages'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
