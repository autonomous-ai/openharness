import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/terminal_key_bar.dart';
import 'package:harness_mobile/terminal/key_hints.dart';
import 'package:xterm/xterm.dart';

void main() {
  late Terminal terminal;
  late List<String> outbound;
  late int dismissals;
  late int edits;

  setUp(() {
    terminal = Terminal(maxLines: 200, reflowEnabled: false)..resize(80, 12);
    outbound = [];
    dismissals = 0;
    edits = 0;
    terminal.onOutput = outbound.add;
  });

  Future<void> pumpBar(WidgetTester tester, {bool enabled = true}) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: TerminalKeyBar(
              terminal: terminal,
              enabled: enabled,
              onDismissKeyboard: () => dismissals++,
              onPromptEdited: () => edits++,
            ),
          ),
        ),
      ),
    );
  }

  Future<void> tapKey(WidgetTester tester, String name) async {
    await tester.tap(find.byKey(ValueKey('terminal-key-$name')));
    await tester.pump();
  }

  testWidgets('the keys a software keyboard cannot produce reach the pty', (
    tester,
  ) async {
    await pumpBar(tester);

    await tapKey(tester, 'esc');
    await tapKey(tester, 'Left');
    await tapKey(tester, 'Up');
    await tapKey(tester, 'Down');
    await tapKey(tester, 'Right');

    expect(outbound, ['\x1b', '\x1b[D', '\x1b[A', '\x1b[B', '\x1b[C']);
  });

  testWidgets('^C sends interrupt at one tap', (tester) async {
    await pumpBar(tester);
    await tapKey(tester, 'Control C');
    expect(outbound, ['\x03']);
  });

  testWidgets(
    'ctrl is the session\'s when it has one, so a typed letter can spend it',
    (tester) async {
      var armed = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) => TerminalKeyBar(
                terminal: terminal,
                enabled: true,
                onDismissKeyboard: () {},
                ctrlArmed: armed,
                onArmCtrl: (value) => setState(() => armed = value),
              ),
            ),
          ),
        ),
      );
      await tapKey(tester, 'ctrl');
      expect(armed, isTrue, reason: 'armed on the session, not the row alone');
      await tapKey(tester, 'Up');
      expect(armed, isFalse, reason: 'spent by the next key');
      expect(outbound.single, contains('1;5A'));
    },
  );

  testWidgets('tab reaches the pty and empties the keyboard buffer', (
    tester,
  ) async {
    await pumpBar(tester);

    await tapKey(tester, 'tab');

    expect(outbound, ['\t']);
    expect(edits, 1);
  });

  /// ⚠️ **The modifiers are the app's own, and they have to be.** A software
  /// keyboard never tells an app whether its Shift is down — it hands over the
  /// resulting character and keeps the state to itself — so a terminal on a
  /// phone cannot borrow it. These two are tapped, stay down, and are spent by
  /// the next key the bar sends.
  testWidgets('ctrl arms, modifies the next key, and puts itself down', (
    tester,
  ) async {
    await pumpBar(tester);

    await tapKey(tester, 'ctrl');
    await tapKey(tester, 'Right');
    // ⌃→ walks a word on every shell here; the plain arrow moves one column.
    expect(outbound, ['\x1b[1;5C']);

    // Spent: the arrow after it is a plain arrow again.
    await tapKey(tester, 'Right');
    expect(outbound, ['\x1b[1;5C', '\x1b[C']);
  });

  testWidgets('shift does the same, and either can be put down unspent', (
    tester,
  ) async {
    await pumpBar(tester);

    await tapKey(tester, 'shift');
    await tapKey(tester, 'Left');
    expect(outbound, ['\x1b[1;2D']);

    // Armed and tapped again: nothing is sent and nothing stays down.
    outbound.clear();
    await tapKey(tester, 'ctrl');
    await tapKey(tester, 'ctrl');
    await tapKey(tester, 'Up');
    expect(outbound, ['\x1b[A']);
  });

  testWidgets('the row holds no Enter or digits', (tester) async {
    await pumpBar(tester);

    for (final gone in ['Enter', '1', '0']) {
      expect(
        find.byKey(ValueKey('terminal-key-$gone')),
        findsNothing,
        reason: gone,
      );
    }
  });

  testWidgets('a stream that takes no input answers nothing — except the key '
      'that puts the keyboard away', (tester) async {
    await pumpBar(tester, enabled: false);

    await tapKey(tester, 'esc');
    await tapKey(tester, 'Up');
    expect(outbound, isEmpty);

    // Hiding the keyboard is this page's own business, not the pane's, and it
    // is the way back to a full screen of output — it works either way.
    await tapKey(tester, 'Hide keyboard');
    expect(dismissals, 1);
  });

  // Claude Code's footer offers it on every prompt.
  final cycle = parseKeyHints(['  ⏵⏵ auto mode on (shift+tab to cycle)']);
  // Codex's queue of async questions, over the composer.
  final queued = parseKeyHints(['  ? 1 question', '    shift+← to answer']);
  final esc = find.byKey(const ValueKey('terminal-key-esc'));
  final right = find.byKey(const ValueKey('terminal-key-Right'));

  /// The strip at a phone's width, offering [hints] as the pane would.
  Widget hintedBar(List<KeyHint> hints) => MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: SizedBox(
          width: 360,
          child: TerminalKeyBar(
            terminal: terminal,
            enabled: true,
            hints: hints,
            onDismissKeyboard: () => dismissals++,
            onPromptEdited: () => edits++,
          ),
        ),
      ),
    ),
  );

  ScrollController rowScroll(WidgetTester tester) => tester
      .widget<SingleChildScrollView>(find.byType(SingleChildScrollView).first)
      .controller!;

  testWidgets(
    'a queued question\'s key leads the strip as it opens — no swipe to find it',
    (tester) async {
      expect(queued.single.action, 'answer');
      await tester.pumpWidget(hintedBar(queued));
      await tester.pumpAndSettle();

      expect(rowScroll(tester).offset, 0);
      expect(find.text('answer').hitTestable(), findsOneWidget);
      // Ahead of the strip's own keys, which it pushes along rather than hides.
      expect(
        tester.getTopRight(find.text('answer')).dx,
        lessThan(tester.getTopLeft(esc).dx),
      );
      expect(esc.hitTestable(), findsOneWidget);

      await tester.tap(find.text('answer'));
      await tester.pump();
      expect(outbound, ['\x1b[1;2D']);
    },
  );

  testWidgets(
    'esc stays in view under cycle, which trails the strip; a question\'s keys '
    'lead it',
    (tester) async {
      expect(cycle.single.action, 'cycle');
      await tester.pumpWidget(hintedBar(cycle));
      await tester.pumpAndSettle();
      // Opened on its own keys: esc is where the thumb expects it, and cycle is
      // past the arrows.
      expect(rowScroll(tester).offset, 0);
      expect(esc.hitTestable(), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('cycle')).dx,
        greaterThan(tester.getTopRight(right).dx),
      );

      // A question's key the pane starts offering takes the head; cycle keeps
      // the tail.
      final more = parseKeyHints([
        '  ⏵⏵ auto mode on (shift+tab to cycle) · ctrl+] main prompt',
      ]);
      await tester.pumpWidget(hintedBar(more));
      await tester.pumpAndSettle();
      expect(rowScroll(tester).offset, 0);
      expect(find.text('main prompt').hitTestable(), findsOneWidget);
      expect(
        tester.getTopRight(find.text('main prompt')).dx,
        lessThan(tester.getTopLeft(esc).dx),
      );
      expect(
        tester.getTopLeft(find.text('cycle')).dx,
        greaterThan(tester.getTopRight(right).dx),
      );
    },
  );

  testWidgets(
    'keys that arrive while the strip is up are scrolled to — a question\'s '
    'back to the head, cycle on to the end, never away from a question',
    (tester) async {
      await tester.pumpWidget(hintedBar(cycle));
      await tester.pumpAndSettle();
      final scroll = rowScroll(tester);

      // Swiped along to cycle; then a queued question arrives.
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pump();
      expect(scroll.offset, greaterThan(0));
      await tester.pumpWidget(hintedBar(queued));
      await tester.pumpAndSettle();
      expect(scroll.offset, 0);
      expect(find.text('answer').hitTestable(), findsOneWidget);

      // cycle arriving beside it leaves the question's key in view.
      await tester.pumpWidget(hintedBar([...queued, ...cycle]));
      await tester.pumpAndSettle();
      expect(scroll.offset, 0);
      expect(find.text('answer').hitTestable(), findsOneWidget);

      // With no question on the pane, cycle arriving is brought into view.
      await tester.pumpWidget(hintedBar(const []));
      await tester.pumpWidget(hintedBar(cycle));
      await tester.pumpAndSettle();
      expect(scroll.offset, greaterThan(0));
      expect(scroll.offset, scroll.position.maxScrollExtent);
      expect(find.text('cycle').hitTestable(), findsOneWidget);
    },
  );
}
