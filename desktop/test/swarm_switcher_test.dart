import 'support/open_harness.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_runtime_test.dart' show native;
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

Finder get jumpField => find.byKey(const ValueKey('swarm-search-input'));
Finder get selectedRow =>
    find.byWidgetPredicate((w) => w is ListTile && w.selected);

void main() {
  for (final nativeTabs in [false, true]) {
    testWidgets(
      'New Tab offers Open Harness and preserves the selected runtime (native=$nativeTabs)',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (_) async => null,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final frames = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a0', frames));
        final original = app.activeSwarm;
        await mount(tester, app, nativeTabs: nativeTabs);
        expect(find.byKey(const ValueKey('swarm-search-button')), findsNothing);
        expect(
          harnessCommandById.containsKey('navigation.quick_open'),
          isFalse,
        );
        await openHarnessPicker(tester);
        expect(jumpField, findsOneWidget);
        expect(app.swarms, [original]);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(jumpField, findsNothing);
        if (nativeTabs) {
          await native(tester, 'jump');
          expect(jumpField, findsNothing);
          final opening = native(tester, 'new');
          await tester.pump();
          await opening;
        } else {
          await tester.tap(find.byKey(const ValueKey('swarm-new-tab-button')));
          await tester.pump();
        }
        final draft = app.activeSwarm;
        expect(draft, isNot(same(original)));
        expect(draft.isBlankNewTab, isTrue);
        expect(app.swarms, hasLength(2));
        expect(original.panes, [pane]);
        expect(find.byType(AlertDialog), findsNothing);
        final field = find.byKey(const ValueKey('swarm-search-input'));
        expect(field, findsNothing);
        await openHarnessPicker(tester);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        await tester.enterText(field, 'Agent 0');
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        final opened = app.activeSwarm;
        expect(opened, same(draft));
        expect(opened.panes, [pane]);
        expect(original.panes, [pane]);
        expect(app.focusedPane, same(pane));
        expect(frames, isEmpty);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
        await tester.pump(const Duration(milliseconds: 10));
        expect(frames.single.bytes, [27, 91, 68]);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  testWidgets('command prefix switches lists and can open New Harness', (
    tester,
  ) async {
    final app = createApp();
    final frames = <TerminalBinaryFrame>[];
    final pane = app.adoptSessionForTest(terminal('a0', frames));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyP, shift: true);
    final field = find.byKey(const ValueKey('swarm-search-input'));
    for (final query in ['> ', '> Agent 0', '>', '> new']) {
      await tester.enterText(field, query);
      await tester.pump();
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      expect(search.isCommandMode, isTrue);
      expect(search.rows.every((row) => row.isCommand), isTrue);
      expect(find.text('Navigate'), findsNothing);
      expect(
        find.byKey(const ValueKey('swarm-navigation-locations')),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('swarm-search-preview')), findsNothing);
    }
    await tester.enterText(field, '');
    await tester.pump();
    final agents = tester
        .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
        .search;
    expect(agents.isCommandMode, isFalse);
    expect(
      agents.rows
          .where((row) => !row.isCreate)
          .every((row) => row.agentId != null),
      isTrue,
    );
    expect(harnessCommandById['agent.new']!.label, 'New Harness');
    await chord(tester, LogicalKeyboardKey.keyP, shift: true);
    await tester.enterText(field, '> new');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('command:swarm.new')));
    await tester.pump();
    expect(app.activeSwarm.isBlankNewTab, isTrue);
    expect(app.panes, isEmpty);
    expect(app.swarms, hasLength(2));
    expect(app.allPanes, contains(pane));
    expect(jumpField, findsNothing);
    await openHarnessPicker(tester);
    expect(jumpField, findsOneWidget);
    final search = tester
        .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
        .search;
    expect(search.isCommandMode, isFalse);
    expect(search.selected, isNull);
    expect(search.rows.any((row) => row.isCreate), isFalse);
    expect(frames, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
