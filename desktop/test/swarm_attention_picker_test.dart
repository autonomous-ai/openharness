import 'package:harness/core/models.dart';

import 'support/resource_picker.dart';
import 'keymap_host_test.dart' show key;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/widgets/swarm_attention.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'swarm_attention_test.dart' show waitingQuestion, announceQuestion;
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'swarm_switcher_test.dart' show selectedRow;

Finder get attentionField => resourceField;
Finder get selectedHarness => find.descendant(
  of: find.byKey(const ValueKey('swarm-search-result-list')),
  matching: find.byWidgetPredicate(
    (widget) => widget is Semantics && widget.properties.selected == true,
  ),
);

void main() {
  testWidgets(
    'large text keeps the question and keyboard selection inside a compact window',
    (tester) async {
      final app = createApp();
      for (var i = 0; i < 8; i++) {
        app.machineStates['m']!.blockedAgents['a$i'] = waitingQuestion(
          'a$i',
          prompt: 'Should I use the existing project folder or create a separate working folder for this change?',
          ageOrder: i,
        );
      }
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(880, 600);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () =>
                    showSwarmAttention(context, app, SwarmNavigationHistory()),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump();
      for (var i = 0; i < 5; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pump();
        final row = tester.getRect(selectedRow);
        final list = tester.getRect(find.byType(ListView));
        expect(row.top, greaterThanOrEqualTo(list.top));
        expect(row.bottom, lessThanOrEqualTo(list.bottom));
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'attention opens in one frame, owns typing, and returns to prior work through Cmd+P',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected;
      final firstInput = <TerminalBinaryFrame>[];
      final secondInput = <TerminalBinaryFrame>[];
      final firstPane = app.adoptSessionForTest(terminal('a0', firstInput));
      final first = app.activeSwarm;
      await mount(tester, app);
      app.newSwarm();
      final secondPane = app.adoptSessionForTest(terminal('a1', secondInput));
      final second = app.activeSwarm;
      await announceQuestion(app, 'a0', prompt: 'Choose the deployment region');
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shift);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyI);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shift);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
      await tester.pump();
      expect(attentionField, findsOneWidget);
      expect(
        tester.widget<TextField>(attentionField).focusNode!.hasFocus,
        isTrue,
      );
      expect(find.byType(BackdropFilter), findsNothing);
      expect(find.byType(Dialog), findsNothing);
      await chord(tester, LogicalKeyboardKey.keyI, shift: true);
      expect(resourceScope(''), findsOneWidget);
      await tester.enterText(attentionField, 'region host');
      await tester.pump();
      expect(find.text('Choose the deployment region'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.activeSwarmId, first.id);
      expect(app.focusedPaneId, firstPane.id);
      expect(firstInput, isEmpty);
      expect(secondInput, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(firstInput.single.bytes, [27, 91, 68]);
      expect(secondInput, isEmpty);
      await chord(tester, LogicalKeyboardKey.bracketLeft);
      expect(app.activeSwarmId, second.id);
      expect(app.focusedPaneId, secondPane.id);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 10));
      expect(secondInput.single.bytes, [27, 91, 67]);
      expect(firstInput, hasLength(1));
      expect(first.panes, [firstPane]);
      expect(second.panes, [secondPane]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'keyboard scroll retains selection through live questions and Escape preserves zoom',
    (tester) async {
      final app = createApp();
      app.adoptSessionForTest(terminal('a0', []));
      app.toggleZoomPane();
      final zoom = app.zoomedPaneId;
      final panes = [...app.panes];
      final machine = app.machineStates['m']!;
      for (var i = 0; i < 60; i++) {
        app.rememberOpenedHarness('m', 'a$i');
        machine.blockedAgents['a$i'] = waitingQuestion(
          'a$i',
          prompt: 'Question $i?',
          ageOrder: i,
        );
      }
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyI, shift: true);
      expect(
        find
            .byType(InkWell)
            .evaluate()
            .where((e) => (e.widget.key?.toString() ?? '').contains('agent:'))
            .length,
        lessThan(60),
      );
      for (var i = 0; i < 45; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pump();
        expect(selectedHarness, findsOneWidget);
        final row = tester.getRect(selectedHarness);
        final list = tester.getRect(
          find.byKey(const ValueKey('swarm-search-result-list')),
        );
        expect(row.top, greaterThanOrEqualTo(list.top));
        expect(row.bottom, lessThanOrEqualTo(list.bottom));
      }
      await tester.pump();
      final selection = resourceSearch(tester).selected!.id;
      expect(selection, agentDestinationId('m', 'a45'));
      final list = tester.getRect(
        find.byKey(const ValueKey('swarm-search-result-list')),
      );
      final row = tester.getRect(selectedHarness);
      expect(row.top, greaterThanOrEqualTo(list.top));
      expect(row.bottom, lessThanOrEqualTo(list.bottom));
      machine.blockedAgents['a65'] = waitingQuestion('a65', ageOrder: -1);
      app.dismissError();
      await tester.pump();
      await tester.pump();
      expect(resourceSearch(tester).selected!.id, selection);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
      expect(
        resourceSearch(tester).selected!.id,
        agentDestinationId('m', 'a46'),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.pump();
      expect(resourceSearch(tester).selected!.id, selection);
      machine.blockedAgents.remove('a45');
      app.dismissError();
      await tester.pump();
      expect(find.text('Question 45?'), findsNothing);
      expect(selectedHarness, findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(attentionField, findsNothing);
      expect(app.panes, panes);
      expect(app.zoomedPaneId, zoom);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'unavailable, filtered empty, and live empty states never submit a hidden destination',
    (tester) async {
      final app = createApp();
      final machine = app.machineStates['m']!;
      app.rememberOpenedHarness('m', 'missing');
      machine.blockedAgents['missing'] = waitingQuestion('missing');
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyI, shift: true);
      expect(find.textContaining('Offline', findRichText: true), findsWidgets);
      final unavailable = find.byKey(
        ValueKey(agentDestinationId('m', 'missing')),
      );
      expect(tester.widget<InkWell>(unavailable).onTap, isNull);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(attentionField, findsOneWidget);
      expect(app.panes, isEmpty);
      await tester.enterText(attentionField, 'not found');
      await tester.pump();
      expect(find.text('No matching harnesses'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(attentionField, findsOneWidget);
      await tester.enterText(attentionField, '');
      machine.blockedAgents.clear();
      app.dismissError();
      await tester.pump();
      expect(find.text('No harnesses need your input'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump();
      expect(app.panes, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
