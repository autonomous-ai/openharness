import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_resize_test.dart' show mountWide;
import 'swarm_screen_test.dart' show mount, terminal;
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
    if (type == 'engines_probe') {
      return Future.value({
        'engines': [
          {'engine': 'claude', 'installed': true},
        ],
      });
    }
    return type == 'agent_create' ? reply.future : Future.value({});
  }

  void complete() => reply.complete({
    'agent': {'id': 'created', 'name': 'Created', 'engine': 'claude'},
  });
}

void main() {
  for (final axis in PaneResizeAxis.values) {
    final direction = axis == PaneResizeAxis.x ? 'right' : 'down';
    final title = axis == PaneResizeAxis.x
        ? 'New Pane to the Right'
        : 'New Pane Below';
    testWidgets('five-pane side tile can split $direction with scrolling', (
      tester,
    ) async {
      final store = MemoryStore();
      final app = createApp(store: store);
      final machine = app.machineStates['m']!;
      machine.nodeOnline = true;
      machine.localOnly = true;
      machine.agents[5] = const Agent(
        id: 'a5',
        name: 'Sixth helper',
        engine: 'codex',
        terminalAvailable: true,
      );
      final frames = <TerminalBinaryFrame>[];
      final original = [
        for (var i = 0; i < 5; i++)
          app.adoptSessionForTest(terminal('a$i', frames)),
      ];
      final swarm = app.activeSwarm;
      app.setPreset(5, PanePreset.middleMain);
      app.newSwarm();
      final helper = app.adoptSessionForTest(terminal('a5', frames));
      app.selectSwarm(swarm.id);
      final target = original[3];
      app.focusPane(target.id);
      await mount(tester, app);
      final view = find.descendant(
        of: find.byKey(target.cellKey),
        matching: find.byType(TerminalView),
      );
      final retained = tester.element(view);
      final button = find.descendant(
        of: find.byKey(target.cellKey),
        matching: find.byKey(ValueKey('pane-split-$direction')),
      );
      expect(tester.widget<IconButton>(button).onPressed, isNotNull);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      final targetRect = tester.getRect(find.byKey(target.cellKey));
      await mouse.addPointer(location: targetRect.center);
      await mouse.moveTo(
        axis == PaneResizeAxis.x
            ? Offset(targetRect.right - 2, targetRect.center.dy)
            : Offset(targetRect.center.dx, targetRect.bottom - 2),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 120));
      expect(button.hitTestable(), findsOneWidget);
      await tester.tap(button);
      await tester.pump();
      expect(find.text(title), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(app.panes, original);
      await chord(
        tester,
        axis == PaneResizeAxis.x
            ? LogicalKeyboardKey.keyR
            : LogicalKeyboardKey.keyD,
      );
      final search = find.byKey(const ValueKey('swarm-search-input'));
      expect(search, findsOneWidget);
      await tester.enterText(search, 'Sixth helper');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.panes, [...original.take(4), helper, original.last]);
      expect(tester.element(view), same(retained));
      final before = tester.getRect(find.byKey(target.cellKey));
      final after = tester.getRect(find.byKey(helper.cellKey));
      if (axis == PaneResizeAxis.x) {
        expect(after.left, greaterThan(before.right));
        expect(after.top, before.top);
      } else {
        expect(after.top, greaterThan(before.bottom));
        expect(after.left, before.left);
      }
      final viewport = tester.view.physicalSize;
      expect(after.left, greaterThanOrEqualTo(0));
      expect(after.top, greaterThanOrEqualTo(0));
      expect(after.right, lessThanOrEqualTo(viewport.width));
      expect(after.bottom, lessThanOrEqualTo(viewport.height));
      final canvasScrolls = tester
          .widgetList<SingleChildScrollView>(find.byType(SingleChildScrollView))
          .where((widget) => widget.controller != null);
      final scroll = canvasScrolls
          .singleWhere(
            (widget) =>
                widget.scrollDirection ==
                (axis == PaneResizeAxis.x ? Axis.horizontal : Axis.vertical),
          )
          .controller!;
      expect(scroll.position.maxScrollExtent, greaterThan(0));
      // Directional focus also reveals an existing pane outside the viewport.
      app.focusPane(original[2].id);
      await chord(tester, LogicalKeyboardKey.arrowDown);
      await tester.pump();
      expect(app.focusedPaneId, original.last.id);
      expect(
        tester.getRect(find.byKey(original.last.cellKey)).right,
        lessThanOrEqualTo(viewport.width + .001),
      );
      app.focusPane(original.last.id);
      await chord(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump();
      expect(app.focusedPaneId, original[1].id);
      final focused = tester.getRect(find.byKey(original[1].cellKey));
      expect(focused.left, greaterThanOrEqualTo(0));
      expect(focused.right, lessThanOrEqualTo(viewport.width + .001));
      app.focusPane(helper.id, reveal: true);
      await tester.pump();
      expect(frames, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 10));
      expect(frames.single.streamId, helper.session!.streamId);
      final savedTiles = app.activeSwarm.manualLayout!.tiles;
      final savedExtent = scroll.position.maxScrollExtent;
      await app.flushPaneLayout();
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      final restored = createApp(store: store);
      await restored.restorePaneLayoutForTest();
      await mount(tester, restored);
      expect(restored.activeSwarm.manualLayout!.tiles, savedTiles);
      final restoredScroll = tester
          .widgetList<SingleChildScrollView>(find.byType(SingleChildScrollView))
          .where((view) => view.controller != null)
          .singleWhere(
            (view) =>
                view.scrollDirection ==
                (axis == PaneResizeAxis.x ? Axis.horizontal : Axis.vertical),
          )
          .controller!;
      expect(
        restoredScroll.position.maxScrollExtent,
        closeTo(savedExtent, .001),
      );
      await tester.pumpWidget(const SizedBox());
      restored.dispose();
    });

    for (final trigger in ['shortcut', 'palette', 'native menu']) {
      testWidgets('$trigger splits the focused pane $direction', (
        tester,
      ) async {
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
        const channel = MethodChannel('harness/swarm_tabs');
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (_) async => true);
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        await mount(tester, app, nativeTabs: trigger == 'native menu');
        tester.view.physicalSize = const Size(2000, 1200);
        await tester.pump();
        switch (trigger) {
          case 'shortcut':
            await chord(
              tester,
              axis == PaneResizeAxis.x
                  ? LogicalKeyboardKey.keyR
                  : LogicalKeyboardKey.keyD,
            );
          case 'palette':
            await chord(tester, LogicalKeyboardKey.keyP, shift: true);
            await tester.enterText(
              find.byKey(const ValueKey('swarm-search-input')),
              '> split $direction',
            );
            await tester.pump();
            await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          case 'native menu':
            messenger.handlePlatformMessage(
              channel.name,
              const StandardMethodCodec().encodeMethodCall(
                MethodCall(
                  axis == PaneResizeAxis.x ? 'splitRight' : 'splitDown',
                ),
              ),
              (_) {},
            );
        }
        await tester.pump();
        final search = find.byKey(const ValueKey('swarm-search-input'));
        expect(search, findsOneWidget);
        expect(find.text(title), findsOneWidget);
        expect(app.panes, [first]);
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
      });
    }

    testWidgets(
      'edge + $direction targets that pane without disturbing its neighbor',
      (tester) async {
        final app = createApp();
        final machine = app.machineStates['m']!;
        machine.nodeOnline = true;
        machine.localOnly = true;
        machine.agents[2] = const Agent(
          id: 'a2',
          name: 'Existing helper',
          engine: 'codex',
          terminalAvailable: true,
        );
        final frames = <TerminalBinaryFrame>[];
        final first = app.adoptSessionForTest(terminal('a0', frames));
        final neighbor = app.adoptSessionForTest(terminal('a1', frames));
        final original = app.activeSwarmId;
        app.newSwarm();
        final helper = app.adoptSessionForTest(terminal('a2', frames));
        app.selectSwarm(original);
        app.focusPane(neighbor.id);
        await mountWide(tester, app);
        tester.view.physicalSize = const Size(3000, 1800);
        await tester.pump();
        final target = find.byKey(first.cellKey);
        final rect = tester.getRect(target);
        final neighborRect = tester.getRect(find.byKey(neighbor.cellKey));
        final view = find.descendant(
          of: target,
          matching: find.byType(TerminalView),
        );
        final retained = tester.element(view);
        final previousFocus = FocusManager.instance.primaryFocus;
        final button = find.descendant(
          of: target,
          matching: find.byKey(ValueKey('pane-split-$direction')),
        );
        expect(button.hitTestable(), findsNothing);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: rect.center);
        await mouse.moveTo(
          axis == PaneResizeAxis.x
              ? Offset(rect.right - 2, rect.center.dy)
              : Offset(rect.center.dx, rect.bottom - 2),
        );
        await tester.pump(const Duration(milliseconds: 120));
        expect(button.hitTestable(), findsOneWidget);
        expect(app.focusedPaneId, neighbor.id);
        expect(FocusManager.instance.primaryFocus, same(previousFocus));
        expect(tester.element(view), same(retained));
        expect(tester.getRect(target), rect);
        expect(frames, isEmpty);

        // Moving from the border onto the inset button must keep it visible.
        await mouse.moveTo(tester.getCenter(button));
        await tester.pump();
        expect(button.hitTestable(), findsOneWidget);
        await mouse.down(tester.getCenter(button));
        await mouse.up();
        await tester.pump();
        final search = find.byKey(const ValueKey('swarm-search-input'));
        expect(search, findsOneWidget);
        expect(find.text(title), findsOneWidget);
        expect(app.focusedPaneId, first.id);
        await tester.enterText(search, 'Existing helper');
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(search, findsNothing);
        expect(app.panes, [first, helper, neighbor]);
        expect(tester.element(view), same(retained));
        expect(tester.getRect(find.byKey(neighbor.cellKey)), neighborRect);
        final splitRect = tester.getRect(target);
        final addedRect = tester.getRect(find.byKey(helper.cellKey));
        if (axis == PaneResizeAxis.x) {
          expect(addedRect.left, greaterThan(splitRect.right));
          expect(addedRect.top, splitRect.top);
          expect(addedRect.height, splitRect.height);
        } else {
          expect(addedRect.top, greaterThan(splitRect.bottom));
          expect(addedRect.left, splitRect.left);
          expect(addedRect.width, splitRect.width);
        }
        expect(frames, isEmpty);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
        await tester.pump(const Duration(milliseconds: 10));
        expect(frames.single.streamId, helper.session!.streamId);
        expect(frames.single.bytes, [27, 91, 67]);
        await mouse.removePointer();
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );

    testWidgets('split $direction creates through the same picker as Cmd-P', (
      tester,
    ) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final connection = _Creation();
      final app = createApp(connectionForTest: (_) => connection);
      final machine = app.machineStates['m']!;
      machine.nodeOnline = true;
      machine.localOnly = true;
      machine.agents[0] = const Agent(
        id: 'a0',
        name: 'Checkout',
        engine: 'claude',
        project: AgentProject(name: 'work', cwd: '/work/checkout'),
      );
      final frames = <TerminalBinaryFrame>[];
      final pane = app.adoptSessionForTest(terminal('a0', frames));
      final original = app.activeSwarmId;
      await mountWide(tester, app);
      final rect = tester.getRect(find.byKey(pane.cellKey));
      final shortcut = axis == PaneResizeAxis.x
          ? LogicalKeyboardKey.keyR
          : LogicalKeyboardKey.keyD;
      await chord(tester, shortcut);
      expect(find.text(title), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(app.panes, [pane]);
      expect(tester.getRect(find.byKey(pane.cellKey)), rect);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 10));
      expect(frames.single.bytes, [27, 91, 67]);
      frames.clear();

      // Empty search selects creation, just as New Pane does.
      await chord(tester, shortcut);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      final box = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      expect(box.split?.axis, axis);
      expect(box.split?.paneId, pane.id);
      expect(box.engine, 'claude');
      expect(box.machineId, 'm');
      expect(box.project.folder, '/work/checkout');
      expect(app.panes, [pane]);
      expect(connection.calls, isNot(contains('agent_create')));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(
        connection.calls.where((call) => call == 'agent_create'),
        hasLength(1),
      );
      expect(app.panes, [pane]);
      connection.complete();
      await tester.pump();
      // The fake connection never attaches the new terminal, whose loading
      // indicator keeps animating after creation has already completed.
      await tester.pump(const Duration(milliseconds: 200));
      expect(app.activeSwarmId, original);
      expect(app.panes.map((pane) => pane.agentId), ['a0', 'created']);
      final before = tester.getRect(find.byKey(pane.cellKey));
      final after = tester.getRect(find.byKey(app.panes.last.cellKey));
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
      expect(app.preparePaneSplit(PaneResizeAxis.x), isNotNull);
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
          change == 'switch' || change == 'window'
              ? ['a0', 'a1', 'created']
              : ['a0', 'a1'],
        );
        expect(
          original.manualLayout != null,
          change == 'switch' || change == 'window',
        );
        expect(
          app.machineStates['m']!.agents.any((a) => a.id == 'created'),
          isTrue,
        );
        if (change != 'switch' && change != 'window') {
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
    expect(find.text('New Pane to the Right'), findsOneWidget);
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
