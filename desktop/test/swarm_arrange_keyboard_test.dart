import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/pane_resize_handle.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show key;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

void main() {
  testWidgets(
    'many tabs reveal keyboard selection without undoing manual scrolling',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = List.generate(12, (_) => <TerminalBinaryFrame>[]);
      final tabs = <String>[];
      for (var i = 0; i < 12; i++) {
        if (i > 0) app.newSwarm();
        app.adoptSessionForTest(terminal('a$i', input[i]));
        app.renameSwarm(app.activeSwarmId, 'Feature ${i + 1}');
        tabs.add(app.activeSwarmId);
      }
      app.selectSwarm(tabs.first);
      await mount(tester, app);
      tester.view.physicalSize = const Size(600, 800);
      await tester.pump();
      final strip = find.byType(ReorderableListView);
      Future<void> visible() async {
        await tester.pump();
        final label = find.descendant(
          of: strip,
          matching: find.text(
            '${app.swarms.indexOf(app.activeSwarm) + 1}:${app.activeSwarm.name}',
          ),
        );
        expect(label, findsOneWidget);
        final viewport = tester.getRect(strip);
        final bounds = tester.getRect(label);
        expect(bounds.left, greaterThanOrEqualTo(viewport.left));
        expect(bounds.right, lessThanOrEqualTo(viewport.right));
      }

      await key(tester, LogicalKeyboardKey.digit9, cmd: true);
      expect(app.activeSwarmId, tabs[8]);
      await visible();
      for (var i = 0; i < 2; i++) {
        await key(tester, LogicalKeyboardKey.tab, ctrl: true);
        await visible();
      }
      expect(app.activeSwarmId, tabs[10]);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(input[10].single.bytes, [27, 91, 68]);
      expect(
        [
          for (var i = 0; i < 12; i++)
            if (i != 10) input[i],
        ].every((frames) => frames.isEmpty),
        isTrue,
      );
      await key(tester, LogicalKeyboardKey.keyW, cmd: true);
      await visible();
      app.reorderSwarm(app.activeSwarmId, 0);
      await tester.pump();
      await visible();
      tester.view.physicalSize = const Size(450, 800);
      await tester.pump();
      await visible();
      tester.view.physicalSize = const Size(600, 800);
      await tester.pump();
      await visible();
      await tester.sendEventToBinding(
        PointerScrollEvent(
          position: tester.getCenter(strip),
          scrollDelta: const Offset(850, 0),
        ),
      );
      await tester.pumpAndSettle();
      final scrolling = tester.state<ScrollableState>(
        find.descendant(of: strip, matching: find.byType(Scrollable)).first,
      );
      final manualOffset = scrolling.position.pixels;
      expect(manualOffset, greaterThan(400));
      app.notifyListeners();
      await tester.pump();
      await tester.pump();
      expect(
        scrolling.position.pixels,
        manualOffset,
        reason: 'Agent updates must not snap a manually scrolled strip back',
      );
      await key(tester, LogicalKeyboardKey.tab, ctrl: true);
      await visible();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('directional moves swap only neighbors and carry their pins', (
    tester,
  ) async {
    final store = MemoryStore();
    final app = createApp(store: store);
    app.machineStates['m']!.nodeOnline = true;
    final input = List.generate(4, (_) => <TerminalBinaryFrame>[]);
    final panes = List.generate(
      4,
      (i) => app.adoptSessionForTest(terminal('a$i', input[i])),
    );
    app.setPreset(4, PanePreset.quad);
    app.focusPane(panes.first.id);
    app.togglePinPane(panes[0].id);
    app.togglePinPane(panes[2].id);
    await mount(tester, app);
    tester.view.physicalSize = const Size(2000, 1200);
    await tester.pump();
    final before = [
      for (final pane in panes) tester.getRect(find.byKey(pane.cellKey)),
    ];
    final retained = tester.element(
      find.descendant(
        of: find.byKey(panes[0].cellKey),
        matching: find.byType(TerminalView),
      ),
    );
    await key(tester, LogicalKeyboardKey.arrowDown, cmd: true, shift: true);
    expect(app.panes, [panes[2], panes[1], panes[0], panes[3]]);
    expect(tester.getRect(find.byKey(panes[0].cellKey)), before[2]);
    expect(tester.getRect(find.byKey(panes[2].cellKey)), before[0]);
    expect(tester.getRect(find.byKey(panes[1].cellKey)), before[1]);
    expect(tester.getRect(find.byKey(panes[3].cellKey)), before[3]);
    expect(app.pinnedSlotFor(panes[0]), 2);
    expect(app.pinnedSlotFor(panes[2]), 0);
    expect(app.focusedPane, same(panes[0]));
    expect(
      tester.element(
        find.descendant(
          of: find.byKey(panes[0].cellKey),
          matching: find.byType(TerminalView),
        ),
      ),
      same(retained),
    );
    await app.flushPaneLayout();
    final saved = jsonDecode(store.values['swarm_layout_v1']!) as Map;
    final savedPanes =
        ((saved['swarms'] as List).first as Map)['panes'] as List;
    expect(savedPanes.map((p) => p['agentId']), ['a2', 'a1', 'a0', 'a3']);
    expect(savedPanes.map((p) => p['pinnedSlot']), [0, null, 2, null]);
    await app.closePane(panes[3].id);
    await tester.pump();
    expect(app.panes, [panes[2], panes[1], panes[0]]);
    expect(input.every((frames) => frames.isEmpty), isTrue);
    await key(tester, LogicalKeyboardKey.arrowLeft);
    await tester.pump(const Duration(milliseconds: 60));
    expect(input[0].single.bytes, [27, 91, 68]);
    expect(input.skip(1).every((frames) => frames.isEmpty), isTrue);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'moving a pane down a scrolling layout keeps its terminal visible',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final panes = List.generate(
        4,
        (i) => app.adoptSessionForTest(terminal('a$i', input)),
      );
      app.setPreset(4, PanePreset.rows);
      app.focusPane(panes.first.id);
      await mount(tester, app);
      final first = find.byKey(panes.first.cellKey);
      for (var move = 0; move < 3; move++) {
        await key(tester, LogicalKeyboardKey.arrowDown, cmd: true, shift: true);
        await tester.pump();
        final bounds = tester.getRect(first);
        expect(bounds.top, greaterThanOrEqualTo(52));
        expect(bounds.bottom, lessThanOrEqualTo(800));
        expect(app.focusedPane, same(panes.first));
      }
      await key(tester, LogicalKeyboardKey.arrowDown, cmd: true, shift: true);
      expect(
        app.panes.last,
        same(panes.first),
        reason: 'Moving stops at the edge',
      );
      expect(input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('keyboard resize cycles dividers and restores terminal input', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    for (var i = 0; i < 3; i++) {
      app.adoptSessionForTest(terminal('a$i', input));
    }
    app.setPreset(3, PanePreset.mainLeft);
    await mount(tester, app);
    tester.view.physicalSize = const Size(2000, 1200);
    await tester.pump();
    Future<void> command(String query) async {
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> $query',
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pump();
    }

    final original = app.activeSwarm.arranged!.toJson();
    final focus = app.focusedPane;
    await command('resize panes');
    final visited = <String>{};
    for (var i = 0; i < 4; i++) {
      final handle = FocusManager.instance.primaryFocus!.context!
          .findAncestorWidgetOfExactType<PaneResizeHandle>();
      expect(handle, isNotNull);
      visited.add(handle!.divider.id);
      final horizontal = handle.divider.axis.name == 'x';
      final before = app.activeSwarm.arranged!.toJson();
      await key(
        tester,
        horizontal
            ? LogicalKeyboardKey.arrowRight
            : LogicalKeyboardKey.arrowDown,
      );
      expect(app.activeSwarm.arranged!.toJson(), isNot(before));
      expect(find.byKey(const ValueKey('pane-resize-hint')), findsOneWidget);
      await key(tester, LogicalKeyboardKey.tab);
    }
    expect(visited, hasLength(2));
    await key(tester, LogicalKeyboardKey.escape);
    expect(find.byKey(const ValueKey('pane-resize-hint')), findsNothing);
    expect(app.focusedPane, same(focus));
    expect(input, isEmpty);
    await key(tester, LogicalKeyboardKey.arrowUp);
    await tester.pump(const Duration(milliseconds: 10));
    expect(input.single.bytes, [27, 91, 65]);
    await command('reset pane sizes');
    expect(app.activeSwarm.arranged!.toJson(), original);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
