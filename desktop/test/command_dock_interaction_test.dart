import 'support/open_harness.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'support/launch_menu.dart';
import 'support/mixed_agents.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);

  testWidgets('setup rows edit in place and only the launch action starts', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    final map = MemoryKeymap();
    addTearDown(app.dispose);
    addTearDown(map.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    await configured.mount(tester, app, map);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    final box = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    await openLaunchRow(tester, 'agent');
    await typeHarnessQuery(tester, 'Claude Code');
    await key(tester, LogicalKeyboardKey.enter);
    expect(box.engine, 'claude');
    expect(app.panes, hasLength(1));
    await openLaunchRow(tester, 'approvals');
    await typeHarnessQuery(tester, 'Ask first');
    await key(tester, LogicalKeyboardKey.enter);
    expect(box.mode, 'ask');
    expect(app.panes, hasLength(1));
    await key(tester, LogicalKeyboardKey.escape);
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'session rows show activity and searchable context lives in the preview',
    (tester) async {
      final app = createApp();
      final map = MemoryKeymap();
      addTearDown(app.dispose);
      addTearDown(map.dispose);
      seedMixedAgents(app);
      final previous = app.machineStates['m']!.agents.first;
      app.machineStates['m']!.agents = [
        Agent(
          id: previous.id,
          name: previous.name,
          engine: previous.engine,
          project: previous.project,
          terminalAvailable: true,
          lastActivityAt: DateTime.now().subtract(const Duration(minutes: 33)),
        ),
        ...app.machineStates['m']!.agents.skip(1),
      ];
      await configured.mount(tester, app, map);
      await openHarnessPicker(tester);
      final row = find.byKey(ValueKey(agentDestinationId('m', 'a0')));
      expect(
        find.descendant(of: row, matching: find.byType(EngineMark)),
        findsNothing,
      );
      expect(
        find.descendant(of: row, matching: find.text('33m')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.byType(SearchResultText)),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'feature/login-redirect',
      );
      await tester.pumpAndSettle();
      final detail = tester.widget<Text>(
        find.descendant(
          of: find.byKey(const ValueKey('swarm-search-preview')),
          matching: find.text('M2:openharness  (feature/login-redirect)'),
        ),
      );
      for (final label in ['M2', 'openharness', 'feature/login-redirect']) {
        expect(detail.data, contains(label));
      }
      expect(detail.style!.fontFamily, terminalFontStore.value.fontFamily);
      expect(detail.style!.fontSize, terminalFontStore.size);
      expect(detail.style!.height, terminalFontStore.value.height);
      final create = find.byKey(const ValueKey(kSwarmCreateRowId));
      expect(create, findsNothing);
      expect(find.text('Harness:'), findsNothing);
      expect(find.byKey(const ValueKey('swarm-search-hints')), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final size in [const Size(1280, 800), const Size(600, 700)]) {
    testWidgets(
      'Open Harness stays minimal and keeps its frame while filtering at $size',
      (tester) async {
        final app = createApp();
        final map = MemoryKeymap();
        addTearDown(app.dispose);
        addTearDown(map.dispose);
        final pane = app.adoptSessionForTest(terminal('a0', []));
        await configured.mount(tester, app, map);
        tester.view.physicalSize = size;
        await tester.pump();
        final paneBounds = tester.getRect(find.byKey(pane.cellKey));
        await openHarnessPicker(tester);
        final panel = find.byKey(const ValueKey('swarm-search-results'));
        final input = find.byKey(const ValueKey('swarm-search-input'));
        final count = find.byKey(const ValueKey('swarm-search-count'));
        final bounds = tester.getRect(panel);
        expect(tester.widget<TextField>(input).cursorWidth, 2);
        expect(find.byKey(const ValueKey('swarm-search-prompt')), findsNothing);
        expect(find.text('Harness:'), findsNothing);
        expect(find.text('[ New Harness ]'), findsNothing);
        expect(find.text('Select Item'), findsNothing);
        expect(find.byKey(const ValueKey('swarm-search-hints')), findsNothing);
        final search = tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search;
        expect(search.selected, isNull);
        expect(search.rows.any((row) => row.isCreate), isFalse);
        await key(tester, LogicalKeyboardKey.tab);
        expect(search.selected, search.rows.first);
        expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
        await tester.enterText(input, 'nothing-like-this');
        await tester.pump();
        expect(search.rows, isEmpty);
        expect(tester.getRect(panel), bounds);
        expect(count, findsNothing);
        expect(tester.getRect(find.byKey(pane.cellKey)), paneBounds);
        expect(find.text('New Harness'), findsNothing);
        await key(tester, LogicalKeyboardKey.enter);
        expect(tester.getRect(panel), bounds);
        await key(tester, LogicalKeyboardKey.escape);
        expect(panel, findsNothing);
        expect(tester.takeException(), isNull);
        // Let the terminal's resize debounce settle before disposing the fixture.
        await tester.pump(const Duration(milliseconds: 60));
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
