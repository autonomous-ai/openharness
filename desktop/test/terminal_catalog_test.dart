import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'keymap_host_test.dart' show key;
import 'support/mixed_agents.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets(
    'narrow search rows retain identity and selection through preview resizing',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      seedMixedAgents(app);
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      await key(tester, LogicalKeyboardKey.keyO, cmd: true);
      final input = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(input, 'login');
      await tester.pump();
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      // Existing matches follow the New Harness action from top to bottom.
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(search.selected!.isCreate, isFalse);
      final selected = search.selected!.id;
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pump();
      await tester.pump();
      for (final preview in [false, true, false]) {
        if (search.previewVisible != preview) {
          await key(tester, LogicalKeyboardKey.slash, ctrl: true);
          // The new viewport schedules the selected row's scroll position
          // after layout; render that position before inspecting the row.
          await tester.pump();
        }
        final row = find.byKey(ValueKey(selected));
        expect(
          row,
          findsOneWidget,
          reason: 'Selected row must remain visible with preview=$preview',
        );
        final bounds = tester.getRect(row);
        expect(
          find.descendant(of: row, matching: find.text(search.selected!.title)),
          findsOneWidget,
        );
        final viewport = tester.getRect(
          find.byKey(const ValueKey('swarm-search-result-list')),
        );
        expect(bounds.top, greaterThanOrEqualTo(viewport.top - .01));
        expect(bounds.bottom, lessThanOrEqualTo(viewport.bottom + .01));
        expect(search.selected!.id, selected);
        expect(tester.widget<TextField>(input).controller!.text, 'login');
        expect(
          tester.widget<TextField>(input).focusNode!.hasPrimaryFocus,
          isTrue,
        );
        expect(tester.takeException(), isNull);
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'find, close, reopen and navigate tabs and panes entirely by keyboard',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      seedMixedAgents(app);
      final codexInput = <TerminalBinaryFrame>[];
      final claudeInput = <TerminalBinaryFrame>[];
      final codex = terminal('a0', codexInput);
      final claude = terminal('a1', claudeInput);
      final firstPane = app.adoptSessionForTest(codex);
      final secondPane = app.adoptSessionForTest(claude);
      final source = app.activeSwarm;
      app.renameSwarm(source.id, 'Review');
      app.focusPane(firstPane.id);
      await mount(tester, app);
      final input = find.byKey(const ValueKey('swarm-search-input'));

      Future<void> command(String query) async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true);
        await tester.enterText(input, '> $query');
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pump(const Duration(milliseconds: 10));
      }

      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await key(tester, LogicalKeyboardKey.keyO, cmd: true);
      await tester.enterText(input, 'login claude M2');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      final sharedTab = app.activeSwarm;
      expect(sharedTab, isNot(same(source)));
      expect(sharedTab.name, 'Fix login redirect');
      expect(sharedTab.panes.single.session, same(claude));
      expect(source.panes, [firstPane, secondPane]);
      await key(tester, LogicalKeyboardKey.keyW, cmd: true);
      expect(app.activeSwarm, same(source));
      expect(secondPane.session, same(claude));
      await command('reopen tab');
      expect(app.activeSwarm.id, sharedTab.id);
      expect(app.focusedPane!.session, same(claude));
      await command('next tab');
      expect(app.activeSwarm, same(source));
      await key(tester, LogicalKeyboardKey.keyL, cmd: true);
      expect(app.focusedPane, same(secondPane));
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(app.zoomedPaneId, secondPane.id);
      await key(tester, LogicalKeyboardKey.keyH, cmd: true);
      expect(app.focusedPane, same(firstPane));
      expect(app.zoomedPaneId, firstPane.id);
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(app.zoomedPaneId, isNull);
      await key(tester, LogicalKeyboardKey.keyL, cmd: true);
      await key(tester, LogicalKeyboardKey.keyW, cmd: true, shift: true);
      expect(source.panes, [firstPane]);
      expect(
        app.swarms
            .singleWhere((tab) => tab.id == sharedTab.id)
            .panes
            .single
            .session,
        same(claude),
      );
      await command('reopen pane');
      expect(app.activeSwarm, same(source));
      expect(source.panes, [firstPane, secondPane]);
      expect(app.focusedPane!.session, same(claude));
      expect(codexInput, isEmpty);
      expect(claudeInput, isEmpty);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(claudeInput.single.bytes, [27, 91, 68]);
      expect(codexInput, isEmpty);
      // Reopening a pane changes its terminal size. Let the 50 ms resize
      // debounce complete before the widget-test timer invariant runs.
      await tester.pump(const Duration(milliseconds: 60));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'same-task results show identity in preview and remain searchable by metadata',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      seedMixedAgents(app);
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      await key(tester, LogicalKeyboardKey.keyO, cmd: true);
      final input = find.byKey(const ValueKey('swarm-search-input'));
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      for (final (id, engine) in [('a0', 'Codex'), ('a1', 'Claude')]) {
        await tester.enterText(input, 'login $engine M2');
        await tester.pump();
        expect(search.selected!.id, agentDestinationId('m', id));
        final preview = find.byKey(const ValueKey('swarm-search-preview'));
        expect(preview, findsOneWidget);
        expect(
          find.descendant(of: preview, matching: find.textContaining(engine)),
          findsWidgets,
        );
        expect(
          find.descendant(of: preview, matching: find.textContaining('M2')),
          findsWidgets,
        );
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  test(
    'a discovered agent display name is searchable alongside its domain',
    () {
      final app = createApp();
      addTearDown(app.dispose);
      seedMixedAgents(app);
      final rows = SwarmSearchCatalog().read(app, []);
      for (final query in ['Robot Studio', 'Robotics', 'studio/arm']) {
        expect(
          rankSwarmDestinations(
            rows,
            query,
          ).where((row) => row.agentId == 'a3'),
          hasLength(1),
          reason: query,
        );
      }
    },
  );
}
