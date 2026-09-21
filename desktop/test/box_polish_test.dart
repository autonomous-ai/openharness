import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/box_chrome.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'keymap_host_test.dart' show key;

class _PendingConnection extends WsConn {
  _PendingConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final creation = Completer<Map<String, dynamic>>();

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => switch (type) {
    'engines_probe' => {
      'engines': [
        {'engine': 'codex', 'installed': true},
      ],
    },
    'dsh_list' => {'dsh': []},
    'agent_create' => creation.future,
    _ => {},
  };
}

void main() {
  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);

  testWidgets(
    'dock stays aligned across search, creation, resizing and preview without changing pane geometry',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      final pane = app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      for (final size in [const Size(1280, 800), const Size(600, 540)]) {
        tester.view.physicalSize = size;
        await tester.pump();
        final before = tester.getRect(find.byKey(pane.cellKey));
        await chord(tester, LogicalKeyboardKey.keyP);
        void aligned(Finder panel) {
          final rect = tester.getRect(panel);
          expect(rect.left, before.left);
          expect(rect.right, before.right);
          expect(rect.bottom, before.bottom);
          expect(tester.getRect(find.byKey(pane.cellKey)), before);
          expect(tester.takeException(), isNull);
        }

        final search = find.byKey(const ValueKey('swarm-search-results'));
        aligned(search);
        final input = find.byKey(const ValueKey('swarm-search-input'));
        final y = tester.getRect(input).bottom;
        await tester.enterText(input, 'Agent 1');
        await tester.pump();
        aligned(search);
        expect(tester.getRect(input).bottom, closeTo(y, .001));
        await key(tester, LogicalKeyboardKey.slash, ctrl: true);
        aligned(search);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        await chord(tester, LogicalKeyboardKey.keyN);
        final create = find.byKey(const ValueKey('new-harness-box'));
        aligned(create);
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        aligned(create);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('all key hints stay visible as the prompt grows and wraps', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.adoptSessionForTest(terminal('a69', []));
    await mount(tester, app);
    tester.view.physicalSize = const Size(600, 800);
    tester.platformDispatcher.textScaleFactorTestValue = 1.7;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pump();
    await chord(tester, LogicalKeyboardKey.keyP);

    void checkGuide() {
      final guide = find.byType(BoxHintStrip);
      final bounds = tester.getRect(guide);
      final hints = find.descendant(of: guide, matching: find.byType(InkWell));
      expect(hints, findsWidgets);
      for (final hint in hints.evaluate()) {
        final rect = tester.getRect(find.byWidget(hint.widget));
        expect(bounds.contains(rect.topLeft), isTrue);
        expect(
          bounds.contains(rect.bottomRight - const Offset(.1, .1)),
          isTrue,
        );
      }
      expect(bounds.bottom, lessThan(800));
      expect(tester.takeException(), isNull);
    }

    checkGuide();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    checkGuide();
    final panel = find.byKey(const ValueKey('new-harness-box'));
    final creation = tester
        .widget<NewHarnessBox>(find.byType(NewHarnessBox))
        .controller;
    creation.focusField(NewHarnessField.task);
    await tester.pump();
    final originalHeight = tester.getSize(panel).height;
    await tester.enterText(
      find.byKey(const ValueKey('new-harness-input')),
      'Fix the login flow\nKeep the session alive\nAdd regression coverage',
    );
    await tester.pump();
    expect(tester.getSize(panel).height, greaterThan(originalHeight));
    checkGuide();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    checkGuide();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'preview toggles without losing the query and Ctrl-C returns to the terminal',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      final frames = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a69', frames));
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyP);
      final field = find.byKey(const ValueKey('swarm-search-input'));
      final preview = find.byKey(const ValueKey('swarm-search-preview'));
      await tester.enterText(field, 'Agent 1');
      await tester.pump();
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      final editor = tester.widget<TextField>(field);
      final value = editor.controller!.value;
      final selected = search.selected;
      expect(preview, findsOneWidget);
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      expect(preview, findsNothing);
      expect(editor.controller!.value, value);
      expect(search.selected, same(selected));
      expect(editor.focusNode!.hasPrimaryFocus, isTrue);
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      expect(preview, findsOneWidget);
      expect(search.selected, same(selected));
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      expect(preview, findsNothing);
      expect(search.selected, same(selected));
      // Without a preview, page keys navigate the result list, retaining input.
      final beforePage = search.cursor;
      await key(tester, LogicalKeyboardKey.pageUp);
      expect(search.cursor, greaterThan(beforePage));
      expect(editor.controller!.value, value);
      expect(editor.focusNode!.hasPrimaryFocus, isTrue);
      await key(tester, LogicalKeyboardKey.pageDown);
      expect(search.cursor, beforePage);
      await key(tester, LogicalKeyboardKey.keyC, ctrl: true);
      expect(field, findsNothing);
      expect(frames, isEmpty);
      await key(tester, LogicalKeyboardKey.keyC, ctrl: true);
      expect(frames.single.bytes, [3]);
      await tester.pumpWidget(const SizedBox());
    },
  );

  test('openable matches precede already-added exact matches', () async {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      for (final (id, name) in [
        ('a0', 'Auth'),
        ('a1', 'Auth service'),
        ('a2', 'Fix auth'),
      ])
        Agent(id: id, name: name, engine: 'codex', terminalAvailable: true),
    ];
    app.adoptSessionForTest(terminal('a0', []));
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      offersCreate: true,
    );
    addTearDown(search.dispose);
    search.setQuery('auth');
    expect(search.rows.map((row) => row.agentId), ['a1', 'a2', 'a0', null]);
    expect(search.selected?.agentId, 'a1');
    expect(search.submit()?.destination.agentId, 'a1');
    expect(search.matchCount, 3);

    // An explicitly highlighted unavailable row stays selected on app updates.
    search.move(2);
    app.dismissError();
    expect(search.selected?.agentId, 'a0');
    expect(search.submit(), isNull);
  });

  testWidgets('held Tab completes without committing or changing the project', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    final controller = tester
        .widget<NewHarnessBox>(find.byType(NewHarnessBox))
        .controller;
    controller.setFolder('/work/repo');
    controller.focusField(NewHarnessField.agent);
    await tester.pump();
    await tester.enterText(
      find.byKey(const ValueKey('new-harness-input')),
      'open',
    );
    await tester.sendKeyDownEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(controller.engine, 'codex');
    expect(controller.query, 'OpenCode');
    for (var i = 0; i < 12; i++) {
      await tester.sendKeyRepeatEvent(LogicalKeyboardKey.tab);
      await tester.pump();
    }
    await tester.sendKeyUpEvent(LogicalKeyboardKey.tab);
    expect(controller.engine, 'codex');
    expect(controller.query, 'OpenCode');
    expect(controller.machineId, 'm');
    expect(controller.project.folder, '/work/repo');
    expect(app.allPanes, hasLength(1));
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'box errors are announced, including the same error after editing',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      // Agent choices now offer the Store even when no agent matches. Use
      // the machine field to exercise an empty-choice error and announcement.
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      final input = find.byKey(const ValueKey('new-harness-input'));
      final controller = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      controller.focusField(NewHarnessField.machine);
      await tester.pump();
      for (var i = 0; i < 2; i++) {
        await tester.enterText(input, 'zzqq');
        await tester.pump();
        tester.takeAnnouncements();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(controller.error, contains('Nothing matches'));
        expect(
          tester.takeAnnouncements(),
          contains(isAccessibilityAnnouncement(controller.error!)),
        );
        await tester.enterText(input, 'zzqqx');
        await tester.pump();
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('creation status and a lost reply are announced', (tester) async {
    final connection = _PendingConnection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    final controller = tester
        .widget<NewHarnessBox>(find.byType(NewHarnessBox))
        .controller;
    controller.setFolder('/work/repo');
    await tester.pump();
    tester.takeAnnouncements();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(controller.busy, isTrue);
    expect(
      tester.takeAnnouncements(),
      contains(isAccessibilityAnnouncement('Starting harness…')),
    );
    connection.creation.completeError(const WsRequestTimeout('agent_create'));
    await tester.pump();
    expect(controller.checking, isTrue);
    expect(
      tester.takeAnnouncements(),
      contains(isAccessibilityAnnouncement(controller.error!)),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byType(NewHarnessBox), findsOneWidget);
    expect(
      tester.takeAnnouncements(),
      contains(isAccessibilityAnnouncement(controller.error!)),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpWidget(const SizedBox());
  });

  for (final (width, scale) in [(1280.0, 1.0), (760.0, 1.0), (600.0, 1.7)]) {
    testWidgets(
      'search ends on a whole row at width $width and text scale $scale',
      (tester) async {
        final app = createApp();
        addTearDown(app.dispose);
        app.adoptSessionForTest(terminal('a69', []));
        await mount(tester, app);
        tester.view.physicalSize = Size(width, 800);
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await tester.pump();
        await chord(tester, LogicalKeyboardKey.keyP);
        final list = find.byKey(const ValueKey('swarm-search-result-list'));
        final row = find
            .descendant(of: list, matching: find.byType(ListTile))
            .first;
        final padding = tester.widget<ListView>(list).padding! as EdgeInsets;
        final visibleRows =
            (tester.getSize(list).height - padding.vertical) /
            tester.getSize(row).height;
        expect(visibleRows, closeTo(visibleRows.roundToDouble(), .001));

        // Creation stays outside the scrolling results, directly above input.
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          'zzqq',
        );
        await tester.pump();
        final onlyRow = find.descendant(
          of: list,
          matching: find.byType(ListTile),
        );
        expect(onlyRow, findsNothing);
        final create = find.widgetWithText(ListTile, 'New Harness');
        expect(create, findsOneWidget);
        expect(
          tester.getRect(create).bottom,
          lessThanOrEqualTo(
            tester
                .getRect(find.byKey(const ValueKey('swarm-search-input')))
                .top,
          ),
        );
        expect(tester.takeException(), isNull);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
