import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_resize_test.dart' show mountWide;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

class _Creation extends WsConn {
  _Creation()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final reply = Completer<Map<String, dynamic>>();
  final calls = <String>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    calls.add(type);
    return type == 'agent_create' ? reply.future : Future.value({});
  }

  void complete() => reply.complete({
    'agent': {'id': 'created', 'name': 'Created', 'engine': 'claude'},
  });
}

void main() {
  for (final axis in PaneResizeAxis.values) {
    final direction = axis == PaneResizeAxis.x ? 'right' : 'down';
    testWidgets(
      'the secondary palette command splits the focused pane $direction',
      (tester) async {
        final app = createApp();
        final machine = app.machineStates['m']!;
        machine.nodeOnline = true;
        machine.localOnly = true;
        machine.agents[2] = const Agent(
          id: 'a2',
          name: 'New split helper',
          engine: 'codex',
          terminalAvailable: true,
        );
        final frames = <TerminalBinaryFrame>[];
        final first = app.adoptSessionForTest(terminal('a0', frames));
        final original = app.activeSwarmId;
        app.newSwarm();
        final helper = app.adoptSessionForTest(terminal('a2', frames));
        app.selectSwarm(original);
        app.focusPane(first.id);
        await mountWide(tester, app);
        await chord(tester, LogicalKeyboardKey.keyP, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> split $direction',
        );
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        final search = find.byKey(const ValueKey('swarm-search-input'));
        expect(search, findsOneWidget);
        await tester.enterText(search, 'New split helper');
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(app.panes, [first, helper]);
        final before = tester.getRect(find.byKey(first.cellKey));
        final after = tester.getRect(find.byKey(helper.cellKey));
        if (axis == PaneResizeAxis.x) {
          expect(after.left, greaterThan(before.right));
          expect(after.top, before.top);
        } else {
          expect(after.top, greaterThan(before.bottom));
          expect(after.left, before.left);
        }
        expect(frames, isEmpty);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );

    testWidgets('pane edges no longer offer New/Open $direction', (
      tester,
    ) async {
      final app = createApp();
      app.adoptSessionForTest(terminal('a0', []));
      await mountWide(tester, app);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      final rect = tester.getRect(find.byKey(app.panes.single.cellKey));
      await mouse.addPointer(location: rect.center);
      await mouse.moveTo(
        axis == PaneResizeAxis.x
            ? Offset(rect.right - 2, rect.center.dy)
            : Offset(rect.center.dx, rect.bottom - 2),
      );
      await tester.pump(const Duration(milliseconds: 120));
      expect(find.byKey(ValueKey('pane-open-$direction')), findsNothing);
      expect(find.byKey(ValueKey('pane-new-$direction')), findsNothing);
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  testWidgets(
    'manual split keeps neighboring terminals and pins, restores offline and closes/reopens precisely',
    (tester) async {
      final store = MemoryStore();
      final app = createApp(store: store);
      app.machineStates['m']!.nodeOnline = true;
      app.machineStates['m']!.localOnly = true;
      final frames = <TerminalBinaryFrame>[];
      final first = app.adoptSessionForTest(terminal('a0', frames));
      final second = app.adoptSessionForTest(terminal('a1', frames));
      final third = app.adoptSessionForTest(terminal('a2', frames));
      final original = app.activeSwarmId;
      app.togglePinPane(second.id);
      app.newSwarm();
      final shared = app.adoptSessionForTest(terminal('a3', frames));
      app.selectSwarm(original);
      app.focusPane(first.id);
      await mountWide(tester, app);
      expect(app.preparePaneSplit(PaneResizeAxis.x), isNull);
      tester.view.physicalSize = const Size(3000, 1800);
      await tester.pump();
      final unchanged = [second, third];
      final rects = [
        for (final pane in unchanged) tester.getRect(find.byKey(pane.cellKey)),
      ];
      final retained = [
        for (final pane in [first, second, third])
          tester.element(
            find.descendant(
              of: find.byKey(pane.cellKey),
              matching: find.byType(TerminalView),
            ),
          ),
      ];
      final before = app.activeSwarm.arranged!;
      final split = app.preparePaneSplit(PaneResizeAxis.x)!;
      expect(app.machineStates['m']!.terminalCapabilityAvailable, isFalse);
      await app.assignAgentToPane(
        null,
        'm',
        'a3',
        swarmId: original,
        split: split,
      );
      await tester.pump();
      expect(app.panes, [first, shared, second, third]);
      expect(find.byKey(shared.cellKey), findsOneWidget);
      expect(tester.getRect(find.byKey(shared.cellKey)).width, greaterThan(0));
      expect(app.pinnedSlotFor(second), 2);
      for (var i = 0; i < unchanged.length; i++) {
        expect(tester.getRect(find.byKey(unchanged[i].cellKey)), rects[i]);
      }
      for (var i = 0; i < retained.length; i++) {
        expect(
          tester.element(
            find.descendant(
              of: find.byKey([first, second, third][i].cellKey),
              matching: find.byType(TerminalView),
            ),
          ),
          same(retained[i]),
        );
      }
      expect(app.activeSwarm.manualLayout!.tiles, split.after.tiles);
      await app.flushPaneLayout();
      final restored = createApp(store: store);
      await restored.restorePaneLayoutForTest();
      expect(restored.activeSwarm.manualLayout!.tiles, split.after.tiles);
      restored.dispose();
      await app.closePane(shared.id);
      await tester.pump();
      expect(app.activeSwarm.manualLayout!.tiles, before.tiles);
      expect(app.pinnedSlotFor(second), 1);
      expect(app.reopenClosed(), isTrue);
      await tester.pump();
      expect(app.activeSwarm.manualLayout!.tiles, split.after.tiles);
      expect(app.panes[1], same(shared));
      expect(app.pinnedSlotFor(second), 2);
      await app.closePane(shared.id);
      await tester.pump();
      final current = app.activeSwarm.manualLayout!;
      final resized = current.resize(
        current.dividers.firstWhere((d) => d.axis == PaneResizeAxis.x),
        .6,
        minimum: app.activeSwarm.arrangedMinimum!,
      );
      app.resizePanes(original, '3:manual', resized);
      await tester.pump();
      expect(app.reopenClosed(), isTrue);
      await tester.pump();
      expect(
        app.activeSwarm.manualLayout,
        isNull,
        reason: 'Reopening must not resurrect the old layout over newer sizing choices',
      );
      expect(app.activeSwarm.paneSizes['3:manual']!.tiles, resized.tiles);
      app.setPreset(4, PanePreset.quad);
      await tester.pump();
      expect(app.activeSwarm.manualLayout, isNull);
      expect(frames, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  for (final change in ['switch', 'layout', 'close', 'window']) {
    testWidgets(
      'a pending split respects its original destination after $change',
      (tester) async {
        final connection = _Creation();
        final app = createApp(connectionForTest: (_) => connection);
        app.adoptSessionForTest(terminal('a0', []));
        app.adoptSessionForTest(terminal('a1', []));
        await mountWide(tester, app);
        tester.view.physicalSize = const Size(3000, 1800);
        await tester.pump();
        final original = app.activeSwarm;
        final split = app.preparePaneSplit(PaneResizeAxis.x)!;
        final creating = app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          split: split,
        );
        expect(connection.calls, ['agent_create']);
        if (change == 'layout') app.setPreset(2, PanePreset.rows);
        if (change == 'window') {
          tester.view.physicalSize = const Size(1000, 800);
          await tester.pump();
        }
        app.newSwarm();
        if (change == 'close') await app.closeSwarm(original.id);
        connection.complete();
        expect(await creating, isNull);
        await tester.pump();
        expect(app.panes, isEmpty);
        expect(
          original.panes.map((p) => p.agentId),
          change == 'switch' ? ['a0', 'a1', 'created'] : ['a0', 'a1'],
        );
        expect(original.manualLayout != null, change == 'switch');
        expect(
          app.machineStates['m']!.agents.any((a) => a.id == 'created'),
          isTrue,
        );
        if (change != 'switch') {
          expect(app.lastError, contains('harness started'));
        }
        expect(connection.calls, isNot(contains('agent_delete')));
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  testWidgets('split creation dismissal restores terminal input immediately', (
    tester,
  ) async {
    final connection = _Creation();
    final app = createApp(connectionForTest: (_) => connection);
    final machine = app.machineStates['m']!;
    machine.nodeOnline = true;
    machine.agents[0] = const Agent(
      id: 'a0',
      name: 'Checkout',
      engine: 'claude',
      project: AgentProject(name: 'work', cwd: '/work/checkout'),
    );
    final frames = <TerminalBinaryFrame>[];
    final pane = app.adoptSessionForTest(terminal('a0', frames));
    await mountWide(tester, app);
    tester.view.physicalSize = const Size(3000, 1800);
    await tester.pump();
    await chord(tester, LogicalKeyboardKey.keyP, shift: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      '> split right',
    );
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(find.byKey(const ValueKey('harness-picker-new')), findsOneWidget);
    expect(find.byKey(const ValueKey('swarm-row-action')), findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pump();
    expect(find.text('New Harness to the right'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('new-agent-project-browse')),
        matching: find.text('checkout'),
      ),
      findsOneWidget,
    );
    expect(app.panes, [pane]);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump();
    expect(find.byType(AlertDialog), findsNothing);
    expect(app.panes, [pane]);
    expect(connection.calls, isNot(contains('agent_create')));
    expect(frames, isEmpty);
    expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump(const Duration(milliseconds: 10));
    expect(frames.single.bytes, [27, 91, 67]);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
