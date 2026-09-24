import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

final _input = find.byKey(const ValueKey('swarm-search-input'));
final _results = find.byKey(const ValueKey('swarm-search-results'));
final _startInput = find.byKey(const ValueKey('harness-start-search'));

void main() {
  for (final expanded in [false, true]) {
    testWidgets(
      'inline command shortcut synchronizes input and results (expanded=$expanded)',
      (tester) async {
        final app = createApp();
        await mount(tester, app);
        if (expanded) {
          await tester.tap(_startInput);
        } else {
          // Keyboard traversal can focus the field before suggestions open.
          tester.widget<TextField>(_startInput).focusNode!.requestFocus();
        }
        await tester.pump();
        await chord(tester, LogicalKeyboardKey.keyP, shift: true);
        expect(tester.widget<TextField>(_input).controller!.text, '>');
        expect(
          find.textContaining('run command', findRichText: true),
          findsOneWidget,
        );
        expect(find.widgetWithText(ListTile, 'Agent 0'), findsNothing);
        expect(
          tester.widget<TextField>(_input).decoration!.hintText,
          'Search commands…',
        );
        expect(_results, findsOneWidget);
        await tester.enterText(_input, '> rename');
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(find.byType(Dialog), findsOneWidget);
        expect(
          find.byKey(const ValueKey('harness-start-results')),
          findsNothing,
        );
        expect(app.panes, isEmpty);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  testWidgets('start page accepts typing immediately, then arrows and Enter', (
    tester,
  ) async {
    final app = createApp();
    await mount(tester, app);
    expect(find.byKey(const ValueKey('harness-start-results')), findsNothing);
    expect(tester.widget<TextField>(_startInput).focusNode!.hasFocus, isTrue);
    tester.testTextInput.enterText('Agent 1');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    final selected = find.byWidgetPredicate(
      (widget) => widget is ListTile && widget.selected,
    );
    expect(
      find.descendant(of: selected, matching: find.text('Agent 10')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: selected, matching: find.text('Add to this tab')),
      findsOneWidget,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(app.panes.single.agentId, 'a10');
    expect(_startInput, findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  for (final native in [false, true]) {
    testWidgets('start page separates Open and New Harness (native=$native)', (
      tester,
    ) async {
      const channel = MethodChannel('harness/swarm_tabs');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        (_) async => true,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final app = createApp();
      await mount(tester, app, nativeTabs: native);
      final original = app.activeSwarmId;
      expect(_results, findsNothing);
      expect(_startInput, findsOneWidget);
      expect(find.byType(FloatingActionButton), findsNothing);
      expect(
        tester.getRect(_startInput).bottom,
        lessThan(
          tester
              .getRect(find.byKey(const ValueKey('harness-start-new-pane')))
              .top,
        ),
      );
      expect(
        tester.widget<TextField>(_startInput).decoration!.hintText,
        kHarnessPickerHint,
      );
      expect(tester.widget<TextField>(_startInput).focusNode!.hasFocus, isTrue);
      expect(find.byKey(const ValueKey('harness-device-link')), findsOneWidget);
      expect(find.byType(ListTile), findsNothing);
      await tester.tap(_startInput);
      await tester.pump();
      expect(
        find.byKey(const ValueKey('harness-start-results')),
        findsOneWidget,
      );
      await tester.enterText(_startInput, 'Agent 1');

      await tester.pump();
      expect(
        find.byKey(const ValueKey('harness-start-results')),
        findsOneWidget,
      );
      expect(_results, findsNothing);
      expect(tester.widget<TextField>(_startInput).controller!.text, 'Agent 1');
      expect(
        find.byKey(const ValueKey('swarm-search-new-agent')),
        findsNothing,
      );
      expect(find.text('> Commands'), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(_results, findsNothing);
      expect(_startInput, findsOneWidget);
      expect(find.byKey(const ValueKey('harness-start-results')), findsNothing);
      expect(
        tester.widget<TextField>(_startInput).focusNode!.hasFocus,
        isFalse,
      );
      expect(tester.widget<TextField>(_startInput).controller!.text, 'Agent 1');
      expect(app.activeSwarmId, original);
      app.renameSwarm(original, 'Background update');
      await tester.pump();
      expect(_results, findsNothing);
      await tester.tap(find.byKey(const ValueKey('harness-start-new-pane')));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byKey(const ValueKey('create-agent-submit')),
        ),
        findsOneWidget,
      );
      expect(find.text('Back to Search'), findsNothing);
      expect(find.text('Cancel'), findsNothing);
      expect(_results, findsNothing);
      await tester.tapAt(const Offset(20, 200));
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(AlertDialog), findsNothing);
      expect(_results, findsNothing);
      expect(_startInput, findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      expect(tester.takeException(), isNull);
    });

    for (final dismissal in ['outside', 'escape']) {
      testWidgets(
        'New Tab stays open after dismissing its picker with $dismissal (native=$native)',
        (tester) async {
          final app = createApp();
          final frames = <TerminalBinaryFrame>[];
          final pane = app.adoptSessionForTest(terminal('a0', frames));
          final original = app.activeSwarmId;
          await mount(tester, app, nativeTabs: native);
          await chord(tester, LogicalKeyboardKey.keyT);
          await tester.pump();
          expect(app.activeSwarmId, isNot(original));
          expect(app.activeSwarm.isNewTabPage, isTrue);
          final created = app.activeSwarmId;
          expect(_results, findsNothing);
          await chord(tester, LogicalKeyboardKey.keyP);
          expect(_results, findsOneWidget);
          expect(_startInput, findsNothing);
          if (dismissal == 'outside') {
            await tester.tapAt(const Offset(20, 200));
          } else {
            await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          }
          await tester.pump();
          expect(_results, findsNothing);
          expect(app.activeSwarmId, created);
          expect(app.swarms, hasLength(2));
          expect(app.closedHistory, isEmpty);
          app.selectSwarm(original);
          await tester.pump();
          expect(app.focusedPane, same(pane));
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
          await tester.pump();
          expect(frames.single.bytes, [27, 91, 66]);
          await tester.pumpWidget(const SizedBox());
          app.dispose();
        },
      );
    }
  }

  testWidgets(
    'discovery preserves search composition and Escape returns home',
    (tester) async {
      final app = createApp();
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyP);
      await tester.enterText(_input, 'Agent 12');
      await tester.pump();
      final text = tester.widget<TextField>(_input).controller!;
      final composing = text.value.copyWith(
        selection: const TextSelection.collapsed(offset: 7),
        composing: const TextRange(start: 6, end: 8),
      );
      text.value = composing;
      app.renameSwarm(app.activeSwarmId, 'Updated in the background');
      await tester.pump();
      expect(text.value, composing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(_results, findsOneWidget);
      text.clearComposing();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(_results, findsNothing);
      expect(_startInput, findsOneWidget);
      expect(tester.widget<TextField>(_startInput).focusNode!.hasFocus, isTrue);
      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      expect(tester.widget<TextField>(_input).controller!.text, '>');
      expect(
        tester.widget<TextField>(_input).decoration!.hintText,
        'Search commands…',
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('Open reuses a session and hands the terminal its next key', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final frames = <TerminalBinaryFrame>[];
    final pane = app.adoptSessionForTest(terminal('a0', frames));
    final original = app.activeSwarm;
    app.newSwarm();
    final destination = app.activeSwarmId;
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyP);
    await tester.enterText(_input, 'Agent 0');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(app.activeSwarmId, destination);
    expect(original.panes.single, same(pane));
    expect(app.panes.single, same(pane));
    expect(_results, findsNothing);
    expect(
      tester
          .widget<TerminalView>(find.byType(TerminalView))
          .focusNode!
          .hasFocus,
      isTrue,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump(const Duration(milliseconds: 10));
    expect(frames.single.bytes, [27, 91, 68]);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  test(
    'drafts are omitted from persistence and cancellation history',
    () async {
      final store = MemoryStore();
      final app = createApp(store: store);
      addTearDown(app.dispose);
      await app.addAgentToSwarm('m', 'a0');
      final original = app.activeSwarmId;
      app.newSwarm(draft: true);
      final draft = app.activeSwarmId;
      await app.flushPaneLayout();
      final restored = createApp(store: store);
      addTearDown(restored.dispose);
      await restored.restorePaneLayoutForTest();
      expect(restored.swarms, hasLength(1));
      expect(restored.activeSwarmId, original);
      expect(app.cancelSwarmDraft(draft), isTrue);
      expect(app.activeSwarmId, original);
      expect(app.closedHistory, isEmpty);

      app.newSwarm(draft: true);
      final committed = app.activeSwarmId;
      await app.addAgentToSwarm('m', 'a1');
      expect(app.cancelSwarmDraft(committed), isFalse);
      await app.closeSwarm(committed);
      expect(app.closedSwarms.single.id, committed);
    },
  );

  test('leaving a draft discards it, but a renamed workspace is kept', () {
    final app = createApp();
    addTearDown(app.dispose);
    final original = app.activeSwarmId;
    app.renameSwarm(original, 'Original work');
    app.newSwarm(draft: true);
    app.selectSwarm(original);
    expect(app.swarms, hasLength(1));
    expect(app.closedHistory, isEmpty);
    app.newSwarm(draft: true);
    final saved = app.activeSwarmId;
    app.renameSwarm(saved, 'Planned work');
    expect(app.cancelSwarmDraft(saved), isFalse);
    app.selectSwarm(original);
    expect(app.swarms, hasLength(2));
  });
}
