import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  test(
    'commands are opt-in, cannot add agents and recheck availability',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final command = SwarmDestination(
        id: 'command:swarm.new',
        title: 'New Harness',
        detail: 'Navigate',
        swarmId: null,
        current: false,
        commandId: 'swarm.new',
        shortcut: '⌘T',
      );
      var available = true;
      final search = SwarmSearchController(
        app,
        [],
        commands: () => available ? [command] : [],
      );
      addTearDown(search.dispose);
      search.setQuery('New Harness');
      expect(search.rows.any((row) => row.isCommand), isFalse);
      search.setQuery('> new');
      expect(search.selected, same(command));
      expect(command.isSwarm, isFalse);
      expect(search.addHere(), isNull);
      expect(search.submit()!.destination, same(command));
      expect(SwarmSearchController.action(command), 'Run command');
      expect(
        await activateSwarmDestination(
          app,
          command,
          destinationSwarmId: app.activeSwarmId,
        ),
        isFalse,
      );
      // Even without a notification between rendering and Enter, the stale
      // command cannot run. The screen also checks its execution guard.
      available = false;
      expect(search.submit(), isNull);
      search.setQuery('> unavailable');
      expect(search.rows, isEmpty);
      search.setQuery('Agent 12');
      expect(search.selected!.agentId, 'a12');
    },
  );

  testWidgets(
    'titlebar commands run the same action as a shortcut without agent input',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final frames = <TerminalBinaryFrame>[];
      final pane = app.adoptSessionForTest(terminal('a0', frames));
      final original = app.activeSwarm;
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyP);
      final input = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(input, '> pin');
      await tester.pump();
      expect(find.text('⌘⇧P'), findsNothing);
      expect(find.text('⇧⌘P'), findsNothing);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('swarm-search-results')),
          matching: find.text('Open Harness'),
        ),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('command:pane.pin')), findsOneWidget);
      expect(app.isPanePinned(pane), isFalse);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.isPanePinned(pane), isTrue);
      expect(app.activeSwarm, same(original));
      expect(frames, isEmpty);
      expect(find.byKey(const ValueKey('swarm-search-results')), findsNothing);
      expect(
        tester
            .widget<TerminalView>(find.byType(TerminalView))
            .focusNode!
            .hasFocus,
        isTrue,
      );
      // The approved command shortcut opens command mode and leaves pinning alone.
      await chord(tester, LogicalKeyboardKey.keyP);
      expect(app.isPanePinned(pane), isTrue);
      expect(tester.widget<TextField>(input).controller!.text, '>');
      await tester.enterText(input, '> unpin');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.isPanePinned(pane), isFalse);
      expect(frames, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'New Harness commands use the shared picker and hand focus to the chosen dialog',
    (tester) async {
      final app = createApp();
      await mount(tester, app);
      final input = find.byKey(const ValueKey('swarm-search-input'));
      await chord(tester, LogicalKeyboardKey.keyP);
      await tester.enterText(input, '> rename');
      await tester.pump();
      expect(
        find.byKey(const ValueKey('command:swarm.rename')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('swarm-search-results')),
        findsOneWidget,
      );
      final text = tester.widget<TextField>(input).controller!;
      text.value = text.value.copyWith(
        composing: const TextRange(start: 2, end: 8),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(find.byType(Dialog), findsNothing);
      text.clearComposing();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-search-results')), findsNothing);
      expect(find.byType(Dialog), findsOneWidget);
      final dialogInput = find.descendant(
        of: find.byType(Dialog),
        matching: find.byType(TextField),
      );
      final editable = tester.widget<EditableText>(
        find.descendant(of: dialogInput, matching: find.byType(EditableText)),
      );
      expect(editable.focusNode.hasFocus, isTrue);
      await tester.enterText(dialogInput, 'Morning');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(app.activeSwarm.name, 'Morning');
      expect(app.panes, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
