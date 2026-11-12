// Hachi on Desktop, clicked through as a person does (docs/design/2026-11-12-hachi.md): the switch in
// Settings ▸ Experimental, ⇧⌘H, a goal typed to Hachi, its line about a started harness, the goal's
// notice, and the switch turned off again.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/desk_sync.dart' show hachiTabId;
import 'package:harness/state/swarm_catalog.dart' show SwarmProjectStore;
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart' show TerminalView;

import 'support/hachi.dart';
import 'swarm_interactions_test.dart' show chord;

void main() {
  late HachiTestApp app;

  /// Built in the test's own zone: the first read of the account's settings starts with it.
  Future<void> mount(WidgetTester tester) async {
    app = HachiTestApp(
      agentAlerts: AgentAlerts(
        store: ScreenAlertStore(storage: HachiMemory())..value = true,
      ),
    );
    addTearDown(app.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    await app.experimentalFeatures.refresh();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          nativeTabs: false,
          projectStore: SwarmProjectStore(),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }

  /// Settings ▸ Experimental, the Hachi switch pressed, and Settings closed.
  Future<void> pressSwitch(WidgetTester tester) async {
    await chord(tester, LogicalKeyboardKey.comma);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('settings-search-field')),
      'experimental',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    final toggle = find.byKey(const ValueKey('experimental-hachi'));
    await tester.ensureVisible(toggle);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
  }

  /// A terminal pane keeps drawing (its caret), so the workspace never settles: a few frames, each
  /// letting replies land.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  String screenOf(TerminalSession session) {
    final lines = session.terminal.buffer.lines;
    return [
      for (var i = 0; i < lines.length; i++) lines[i].toString(),
    ].join('\n');
  }

  testWidgets(
    'switch on, ⇧⌘H, a goal, the started line, the goal\'s notice, switch off',
    (tester) async {
      await mount(tester);
      final hachiTab = find.byKey(const ValueKey(hachiTabId));
      expect(hachiTab, findsNothing, reason: 'off, nothing of Hachi is drawn');

      // 1. The switch.
      await pressSwitch(tester);
      expect(app.measured.counted, ['ui_desktop_hachi_switch_on']);
      expect(hachiTab, findsNothing, reason: 'turning it on starts nothing');

      // 2. ⇧⌘H creates Hachi, in the first tab, with no ×.
      await chord(tester, LogicalKeyboardKey.keyH, shift: true);
      await settle(tester);
      final created = app.connections['m']!.creations.single;
      expect(created['dsh'], 'autonomous/hachi');
      expect(created['name'], 'Hachi');
      expect(created['prompt'], isNull, reason: 'it waits for the person');
      expect(app.swarms.first.id, hachiTabId);
      expect(app.activeSwarmId, hachiTabId);
      expect(hachiTab, findsOneWidget);
      expect(find.byKey(const ValueKey('tab-close:$hachiTabId')), findsNothing);
      expect(app.measured.counted.last, 'ui_desktop_hachi_open_shortcut');

      // 3. A goal, typed to Hachi as to any harness.
      final typed = <TerminalBinaryFrame>[];
      final session =
          TerminalSession(
              machineId: 'm',
              agentId: 'hachi-1',
              agentName: 'Hachi',
              engineId: 'claude',
              send: (_, _) async => true,
              sendBinary: (frame) async {
                if (frame.kind == TerminalBinaryKind.input) typed.add(frame);
                return true;
              },
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'stream-hachi';
      app.activeSwarm.panes.single.session = session;
      app.notifyListeners();
      await settle(tester);
      await tester.tap(find.byType(TerminalView));
      await settle(tester);
      tester.testTextInput.enterText('Fix the flaky login test in api');
      await tester.pump(const Duration(milliseconds: 10));
      expect(
        typed.map((frame) => utf8.decode(frame.bytes)).join(),
        'Fix the flaky login test in api',
      );

      // 4. Hachi's line about the harness it started, in its own pane.
      session.terminal.write('api-fix @studio: started.\r\n');
      await tester.pump();
      expect(screenOf(session), contains('api-fix @studio: started.'));

      // 5. The goal's notice, once, from `harness goal done`, while the person is in another tab.
      app.newSwarm(name: 'Elsewhere');
      await tester.pump();
      app.stateOf('m')!.agents = [
        const Agent(
          id: 'hachi-1',
          name: 'Hachi',
          engine: 'claude',
          dsh: 'autonomous/hachi',
        ),
        const Agent(
          id: 'api-fix',
          name: 'api-fix',
          engine: 'claude',
          parentAgentId: 'hachi-1',
        ),
      ];
      await app.handleMachineEventForTest('m', {
        'type': 'hachi_goal_done',
        'payload': {
          'agentId': 'hachi-1',
          'goalId': 'g1',
          'title': 'flaky login test',
        },
      });
      await tester.pump();
      expect(find.text('Hachi: flaky login test is done'), findsOneWidget);
      expect(app.measured.counted.last, 'hachi_notice_goal_done');
      app.agentAlerts.clear();
      await tester.pump();

      // 6. Off: the tab goes, and the window says once what kept running.
      await pressSwitch(tester);
      expect(app.measured.counted.last, 'ui_desktop_hachi_switch_off');
      expect(hachiTab, findsNothing);
      expect(app.swarms.any((tab) => tab.id == hachiTabId), isFalse);
      expect(
        find.text('Hachi is off. Its harness keeps running.'),
        findsOneWidget,
      );
      await chord(tester, LogicalKeyboardKey.keyH, shift: true);
      await settle(tester);
      expect(hachiTab, findsNothing, reason: 'off, ⇧⌘H is not bound');
      expect(app.connections['m']!.creations, hasLength(1));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 10));
    },
  );
}
