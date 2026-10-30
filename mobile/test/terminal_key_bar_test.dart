import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/terminal_input_dock.dart';
import 'package:harness_mobile/phone/terminal_key_bar.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/terminal/key_hints.dart';
import 'package:harness_mobile/terminal/terminal_input.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
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

  group('↵ at an engine\'s prompt', () {
    late Terminal pane;

    setUp(() {
      // As `TerminalSession` builds a pane's terminal: the bytes ↵ sends are
      // the ones its input handler gives a hardware ⌥⏎.
      pane = Terminal(
        maxLines: 200,
        platform: TerminalTargetPlatform.macos,
        inputHandler: harnessInputHandler,
        reflowEnabled: false,
      )..resize(80, 12);
      pane.onOutput = outbound.add;
    });

    Future<void> pumpPrompt(
      WidgetTester tester, {
      double width = 375,
      bool enabled = true,
      bool enginePrompt = true,
      bool questionOpen = false,
      bool? ctrl,
      ValueChanged<bool>? armCtrl,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: SizedBox(
                width: width,
                child: TerminalKeyBar(
                  terminal: pane,
                  enabled: enabled,
                  enginePrompt: enginePrompt,
                  questionOpen: questionOpen,
                  onDismissKeyboard: () => dismissals++,
                  onPromptEdited: () => edits++,
                  // Every optional key the row can hold but `paste`, whose
                  // clipboard poll would outlive the test.
                  onClearPrompt: () {},
                  onPickImage: () {},
                  ctrlArmed: ctrl,
                  onArmCtrl: armCtrl,
                ),
              ),
            ),
          ),
        ),
      );
    }

    final newline = find.byKey(const ValueKey('terminal-key-Newline'));
    final enter = find.byKey(const ValueKey('terminal-key-Enter'));

    testWidgets('breaks the line as ⌥⏎ does, and does not submit', (
      tester,
    ) async {
      await pumpPrompt(tester);

      await tester.tap(newline);
      await tester.pump();

      expect(outbound, ['\x1b\r'], reason: 'ESC + Return, never a bare \\r');
      expect(edits, 1, reason: 'the keyboard lets go of the line just broken');
    });

    testWidgets('puts armed modifiers down rather than adding them', (
      tester,
    ) async {
      // The row's own: armed, spent by ↵ unchanged, and gone after it.
      await pumpPrompt(tester);
      await tester.tap(find.byKey(const ValueKey('terminal-key-ctrl')));
      await tester.tap(find.byKey(const ValueKey('terminal-key-shift')));
      await tester.pump();
      await tester.tap(newline);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('terminal-key-Up')));
      await tester.pump();
      expect(outbound, ['\x1b\r', '\x1b[A']);

      // The session's ctrl is put down too.
      final armed = <bool>[];
      outbound.clear();
      await pumpPrompt(tester, ctrl: true, armCtrl: armed.add);
      await tester.tap(newline);
      await tester.pump();
      expect(outbound, ['\x1b\r']);
      expect(armed, [false]);
    });

    testWidgets(
      'gives its slot to ⏎ during a question; no ↵ on a plain shell',
      (tester) async {
        await pumpPrompt(tester, questionOpen: true);
        expect(newline, findsNothing);
        expect(enter, findsOneWidget);

        await pumpPrompt(tester, enginePrompt: false);
        expect(newline, findsNothing);
        expect(enter, findsNothing);
      },
    );

    testWidgets('dims with the rest of the row while input is not taken', (
      tester,
    ) async {
      await pumpPrompt(tester, enabled: false);
      await tester.tap(newline);
      await tester.pump();
      expect(outbound, isEmpty);
    });

    testWidgets('the dock offers it to an agent and not to a plain shell', (
      tester,
    ) async {
      for (final (engine, offered) in [('claude', true), ('terminal', false)]) {
        final session = TerminalSession(
          machineId: 'm',
          agentId: 'a',
          agentName: 'a',
          engineId: engine,
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        );
        addTearDown(session.dispose);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: TerminalInputDock(
                session: session,
                keyboardUp: true,
                onDismiss: () {},
              ),
            ),
          ),
        );
        expect(
          newline,
          offered ? findsOneWidget : findsNothing,
          reason: engine,
        );
      }
    });

    for (final width in [320.0, 375.0]) {
      testWidgets('fits a ${width.round()}pt phone at the width a question '
          'already gives every key', (tester) async {
        final esc = find.byKey(const ValueKey('terminal-key-esc'));
        await pumpPrompt(tester, width: width, questionOpen: true);
        final asked = tester.getSize(esc);
        await pumpPrompt(tester, width: width);
        expect(tester.takeException(), isNull);
        expect(tester.getSize(esc), asked);
        // Inside the row, before the rule and the two keys past it.
        final image = find.byKey(const ValueKey('terminal-key-Send image'));
        expect(
          tester.getTopRight(newline).dx,
          lessThan(tester.getTopLeft(image).dx),
        );
        expect(newline.hitTestable(), findsOneWidget);
        expect(
          find
              .byKey(const ValueKey('terminal-key-Hide keyboard'))
              .hitTestable(),
          findsOneWidget,
        );
      });
    }
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

  group('keys are drawn as caps, as the system keyboard draws its own', () {
    Future<void> pumpCaps(WidgetTester tester, {bool enabled = true}) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: SizedBox(
                width: 375,
                child: TerminalKeyBar(
                  terminal: terminal,
                  enabled: enabled,
                  enginePrompt: true,
                  onDismissKeyboard: () => dismissals++,
                  onClearPrompt: () {},
                  onPickImage: () {},
                ),
              ),
            ),
          ),
        ),
      );
    }

    Finder keyNamed(String name) => find.byKey(ValueKey('terminal-key-$name'));

    Finder capOf(Finder key) =>
        find.descendant(of: key, matching: find.byType(DecoratedBox));

    BoxDecoration capDecoration(WidgetTester tester, Finder key) =>
        tester.widget<DecoratedBox>(capOf(key)).decoration as BoxDecoration;

    Tty ttyOf(WidgetTester tester) =>
        Tty.of(tester.element(find.byType(TerminalKeyBar)));

    const names = [
      'esc',
      'Control C',
      'tab',
      'Clear prompt',
      'shift',
      'ctrl',
      'Left',
      'Up',
      'Down',
      'Right',
      'Newline',
      'Send image',
      'Hide keyboard',
    ];

    testWidgets('every key sits in a rounded cap inside its cell, raised off '
        'the ground, on a 36pt strip', (tester) async {
      await pumpCaps(tester);
      final tty = ttyOf(tester);

      final bar = tester.getRect(find.byType(TerminalKeyBar));
      expect(bar.height, 36);
      for (final name in names) {
        final key = keyNamed(name);
        expect(capOf(key), findsOneWidget, reason: name);
        final cap = capDecoration(tester, key);
        expect(cap.borderRadius, isNotNull, reason: name);
        expect(cap.color, isNot(tty.ground), reason: '$name stands off it');
        expect(cap.boxShadow, isNotEmpty, reason: '$name has an edge');

        final cell = tester.getRect(key), drawn = tester.getRect(capOf(key));
        expect(drawn.height, lessThan(cell.height), reason: name);
        expect(drawn.top, greaterThan(cell.top), reason: name);
        expect(drawn.bottom, lessThan(cell.bottom), reason: name);
        expect(drawn.width, cell.width, reason: name);
        // A 26pt cap, 5pt from the strip's top and bottom; the tap still
        // lands anywhere in the taller cell.
        expect(drawn.height, closeTo(26, 0.01), reason: name);
        expect(cell.height, closeTo(32, 0.01), reason: name);
        expect(drawn.top - bar.top, closeTo(5, 0.01), reason: name);
        expect(bar.bottom - drawn.bottom, closeTo(5, 0.01), reason: name);
      }
    });

    testWidgets('caps are 4pt apart and from the strip\'s edges, and share the '
        'row by their parts', (tester) async {
      await pumpCaps(tester);
      final bar = tester.getRect(find.byType(TerminalKeyBar));
      final caps = [
        for (final name in names) tester.getRect(capOf(keyNamed(name))),
      ];

      expect(caps.first.left - bar.left, closeTo(4, 0.01));
      expect(bar.right - caps.last.right, closeTo(4, 0.01));
      for (var i = 1; i < caps.length; i++) {
        final gap = caps[i].left - caps[i - 1].right;
        // The rule's 6 + 1 + 6 sits before `Send image`.
        final expected = names[i] == 'Send image' ? 13.0 : 4.0;
        expect(gap, closeTo(expected, 0.01), reason: names[i]);
      }
      // 375pt less the edges, ten gaps, the rule and the gap past it, over
      // 9 keys × 3 parts, `clear` × 5, `img` × 3 and `▾` × 4.
      const part = (375 - 4 * 2 - 4 * 10 - 13 - 4) / 42;
      expect(caps.first.width, closeTo(part * 3, 0.01));
      expect(
        tester.getSize(capOf(keyNamed('Clear prompt'))).width,
        closeTo(part * 5, 0.01),
      );
      expect(
        tester.getSize(capOf(keyNamed('Hide keyboard'))).width,
        closeTo(part * 4, 0.01),
      );
    });

    testWidgets('▾ is a wider cap than the rest, and its glyph is drawn at its '
        'own scale rather than shrunk to fit the cap', (tester) async {
      await pumpCaps(tester);
      final tty = ttyOf(tester);
      final hide = keyNamed('Hide keyboard');
      final glyph = find.descendant(of: hide, matching: find.text('▾'));

      expect(
        tester.getSize(capOf(hide)).width,
        greaterThan(tester.getSize(capOf(keyNamed('Send image'))).width),
      );
      // How large the glyph is drawn: its type size, times whatever the
      // FittedBox shrank it by to fit the cap.
      final size = tester.widget<Text>(glyph).style!.fontSize!;
      final shrunk =
          tester.getRect(glyph).height / tester.getSize(glyph).height;
      expect(shrunk, closeTo(1, 0.01), reason: 'fits the cap as it is');
      expect(size * shrunk, closeTo(tty.fontSize * 1.8, 0.01));
      expect(
        tester.getRect(glyph).height,
        lessThanOrEqualTo(tester.getSize(capOf(hide)).height),
      );
    });

    testWidgets('a held key lightens on the way down and lets go on the way '
        'up; a finger that slides off sends nothing', (tester) async {
      await pumpCaps(tester);
      final esc = keyNamed('esc');
      final idle = capDecoration(tester, esc);

      final gesture = await tester.startGesture(tester.getCenter(esc));
      await tester.pump();
      final held = capDecoration(tester, esc);
      expect(held.color, isNot(idle.color));
      expect(held.boxShadow, isNull, reason: 'the key is down');

      await gesture.moveBy(const Offset(0, -200));
      await gesture.up();
      await tester.pump();
      expect(capDecoration(tester, esc).color, idle.color);
      expect(capDecoration(tester, esc).boxShadow, isNotEmpty);
      expect(outbound, isEmpty);

      await tapKey(tester, 'esc');
      expect(capDecoration(tester, esc).color, idle.color);
      expect(outbound, ['\x1b']);
    });

    testWidgets('an armed modifier is a reverse-video cap until it is spent', (
      tester,
    ) async {
      await pumpCaps(tester);
      final tty = ttyOf(tester);
      final ctrl = keyNamed('ctrl');
      final idle = capDecoration(tester, ctrl);

      await tapKey(tester, 'ctrl');
      final armed = capDecoration(tester, ctrl);
      expect(armed.color, tty.text);
      expect(armed.borderRadius, idle.borderRadius);
      expect(armed.boxShadow, isNull, reason: 'held down');
      expect(
        tester
            .widget<Text>(
              find.descendant(of: ctrl, matching: find.text('ctrl')),
            )
            .style
            ?.color,
        tty.ground,
      );

      await tapKey(tester, 'Up');
      expect(capDecoration(tester, ctrl).color, idle.color);
      expect(capDecoration(tester, ctrl).boxShadow, isNotEmpty);
    });

    testWidgets('while input is not taken the caps lie flat and fainter — but '
        'the key that hides the keyboard', (tester) async {
      await pumpCaps(tester);
      final live = capDecoration(tester, keyNamed('esc'));

      await pumpCaps(tester, enabled: false);
      final dead = capDecoration(tester, keyNamed('esc'));
      expect(dead.color, isNot(live.color));
      expect(dead.boxShadow, isNull);
      expect(dead.borderRadius, live.borderRadius, reason: 'still a key');
      final hide = capDecoration(tester, keyNamed('Hide keyboard'));
      expect(hide.color, live.color);
      expect(hide.boxShadow, isNotEmpty);
    });

    // Every palette, light ones included: the chrome takes the app's
    // brightness, so a light ground is a light palette.
    test('a light palette is among them', () {
      expect(HarnessPalette.values.where((p) => !p.isDark), isNotEmpty);
    });
    for (final palette in HarnessPalette.values) {
      testWidgets('the caps stand off ${palette.name}\'s ground', (
        tester,
      ) async {
        final (paletteBefore, brightnessBefore) = (
          AppTheme.palette.value,
          AppTheme.brightness.value,
        );
        addTearDown(() {
          AppTheme.palette.value = paletteBefore;
          AppTheme.brightness.value = brightnessBefore;
        });
        AppTheme.palette.value = palette;
        AppTheme.brightness.value = palette.brightness;
        await pumpCaps(tester);
        final tty = ttyOf(tester);
        expect(tty.isLight, !palette.isDark);

        final idle = capDecoration(tester, keyNamed('esc')).color!;
        expect(idle, isNot(tty.ground));
        final gesture = await tester.startGesture(
          tester.getCenter(keyNamed('esc')),
        );
        await tester.pump();
        final held = capDecoration(tester, keyNamed('esc')).color!;
        await gesture.up();
        await tester.pump();
        // Each state a further step from the ground than the one before.
        double distance(Color color) =>
            (color.computeLuminance() - tty.ground.computeLuminance()).abs();
        expect(distance(held), greaterThan(distance(idle)));
      });
    }

    testWidgets('the pane\'s own keys are caps too, as wide as their words', (
      tester,
    ) async {
      await tester.pumpWidget(hintedBar(cycle));
      await tester.pumpAndSettle();

      final cap = find
          .ancestor(of: find.text('cycle'), matching: find.byType(DecoratedBox))
          .first;
      final decoration =
          tester.widget<DecoratedBox>(cap).decoration as BoxDecoration;
      expect(decoration.borderRadius, isNotNull);
      expect(decoration.boxShadow, isNotEmpty);
      expect(
        tester.getRect(cap).contains(tester.getCenter(find.text('cycle'))),
        isTrue,
      );
      expect(
        tester.getSize(cap).width,
        isNot(tester.getSize(capOf(esc)).width),
      );
    });

    // What Codex offers, as 0.156.1 and 0.161.0 print it.
    const codex = <String, (List<String>, List<String>)>{
      'a queued question': (
        ['  ? 1 question', '    shift+← to answer'],
        ['answer'],
      ),
      'a queued question, 0.161.0': (
        ['  ? 1 question', '    ⇧← to answer'],
        ['answer'],
      ),
      'an open question\'s footer': (
        ['  ctrl+] skip · ⌥+↓ main prompt · enter to submit'],
        ['skip', 'main prompt'],
      ),
    };

    for (final MapEntry(key: screen, value: (lines, words)) in codex.entries) {
      testWidgets('Codex\'s keys for $screen are caps on the strip, ahead of '
          'its own keys, which keep their width', (tester) async {
        await pumpCaps(tester);
        final width = tester.getSize(keyNamed('esc')).width;

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: SizedBox(
                  width: 375,
                  child: TerminalKeyBar(
                    terminal: terminal,
                    enabled: true,
                    enginePrompt: true,
                    hints: parseKeyHints(lines),
                    onDismissKeyboard: () {},
                    onClearPrompt: () {},
                    onPickImage: () {},
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final bar = tester.getRect(find.byType(TerminalKeyBar));
        expect(bar.height, 36);
        for (final word in words) {
          final cap = find
              .ancestor(
                of: find.text(word),
                matching: find.byType(DecoratedBox),
              )
              .first;
          final decoration =
              tester.widget<DecoratedBox>(cap).decoration as BoxDecoration;
          expect(decoration.borderRadius, isNotNull, reason: word);
          expect(decoration.boxShadow, isNotEmpty, reason: word);
          final drawn = tester.getRect(cap);
          expect(drawn.height, closeTo(26, 0.01), reason: word);
          expect(drawn.top - bar.top, closeTo(5, 0.01), reason: word);
          expect(drawn.right, lessThan(tester.getRect(keyNamed('esc')).left));
        }
        expect(tester.getSize(keyNamed('esc')).width, width);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets(
      'a hint dims with the strip: flat, fainter, and sends nothing',
      (tester) async {
        Future<BoxDecoration> answerCap({required bool enabled}) async {
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: TerminalKeyBar(
                  terminal: terminal,
                  enabled: enabled,
                  hints: queued,
                  onDismissKeyboard: () {},
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          final cap = find
              .ancestor(
                of: find.text('answer'),
                matching: find.byType(DecoratedBox),
              )
              .first;
          return tester.widget<DecoratedBox>(cap).decoration as BoxDecoration;
        }

        final live = await answerCap(enabled: true);
        final dead = await answerCap(enabled: false);
        expect(dead.boxShadow, isNull);
        expect(dead.color, isNot(live.color));
        await tester.tap(find.text('answer'));
        await tester.pump();
        expect(outbound, isEmpty);
      },
    );
  });

  group('the pane\'s own keys, pressed', () {
    Widget bar({bool? ctrl, ValueChanged<bool>? armCtrl}) => MaterialApp(
      home: Scaffold(
        body: TerminalKeyBar(
          terminal: terminal,
          enabled: true,
          hints: queued,
          onDismissKeyboard: () {},
          onPromptEdited: () => edits++,
          ctrlArmed: ctrl,
          onArmCtrl: armCtrl,
        ),
      ),
    );

    testWidgets('a hint is the whole chord: armed modifiers are put down, '
        'never added', (tester) async {
      await tester.pumpWidget(bar());
      await tester.pumpAndSettle();
      await tapKey(tester, 'ctrl');
      await tapKey(tester, 'shift');

      await tester.tap(find.text('answer'));
      await tester.pump();
      expect(outbound, ['\x1b[1;2D'], reason: 'shift+←, not ctrl+shift+←');

      // Spent: the key after it is plain — tab, not shift+tab (`\x1b[Z`).
      // Not an arrow: the hint at the head has pushed those out of view.
      await tapKey(tester, 'tab');
      expect(outbound, ['\x1b[1;2D', '\t']);
    });

    testWidgets('the session\'s ctrl is put down too', (tester) async {
      final armed = <bool>[];
      await tester.pumpWidget(bar(ctrl: true, armCtrl: armed.add));
      await tester.pumpAndSettle();

      await tester.tap(find.text('answer'));
      await tester.pump();
      expect(armed, [false]);
      expect(outbound, ['\x1b[1;2D']);
    });

    testWidgets('a hint lets go of the keyboard\'s buffer, as tab does', (
      tester,
    ) async {
      await tester.pumpWidget(bar());
      await tester.pumpAndSettle();

      await tester.tap(find.text('answer'));
      await tester.pump();
      expect(edits, 1);
    });
  });

  group('img', () {
    Widget bar({VoidCallback? pick, VoidCallback? photo, VoidCallback? file}) =>
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: SizedBox(
                width: 375,
                child: TerminalKeyBar(
                  terminal: terminal,
                  enabled: true,
                  enginePrompt: true,
                  onDismissKeyboard: () {},
                  onPickImage: pick,
                  onTakePhoto: photo,
                  onPickFile: file,
                ),
              ),
            ),
          ),
        );
    final image = find.byKey(const ValueKey('terminal-key-Send image'));
    final newline = find.byKey(const ValueKey('terminal-key-Newline'));
    final hide = find.byKey(const ValueKey('terminal-key-Hide keyboard'));

    testWidgets('is not drawn for a CLI that cannot take a picture, and the '
        'rule goes with it', (tester) async {
      await tester.pumpWidget(bar());
      expect(image, findsNothing);
      expect(hide, findsOneWidget);
      // One gap where the rule stood: nothing left to set apart.
      expect(
        tester.getTopLeft(hide).dx - tester.getTopRight(newline).dx,
        closeTo(4, 0.01),
      );
      expect(
        find.byWidgetPredicate(
          (w) => w is Container && w.constraints?.maxWidth == 1,
        ),
        findsNothing,
      );
    });

    testWidgets('with both ways to send one, a sheet asks which', (
      tester,
    ) async {
      var picks = 0, photos = 0;
      await tester.pumpWidget(bar(pick: () => picks++, photo: () => photos++));
      await tester.tap(image);
      await tester.pumpAndSettle();
      expect(find.text('Choose from library'), findsOneWidget);
      expect(find.text('Take a photo'), findsOneWidget);

      await tester.tap(find.text('Take a photo'));
      await tester.pumpAndSettle();
      expect((picks, photos), (0, 1));
      expect(outbound, isEmpty, reason: 'nothing typed at the agent');
    });

    testWidgets('where a file can go too, it is one more row behind the same '
        'key', (tester) async {
      var picks = 0, photos = 0, files = 0;
      await tester.pumpWidget(
        bar(pick: () => picks++, photo: () => photos++, file: () => files++),
      );
      final key = find.byKey(const ValueKey('terminal-key-Send image or file'));
      expect(find.descendant(of: key, matching: find.text('img')), findsOne);
      await tester.tap(key);
      await tester.pumpAndSettle();
      expect(find.text('Send to this harness'), findsOneWidget);
      expect(find.text('Choose from library'), findsOneWidget);
      expect(find.text('Take a photo'), findsOneWidget);

      await tester.tap(find.text('Choose a file'));
      await tester.pumpAndSettle();
      expect((picks, photos, files), (0, 0, 1));
      expect(outbound, isEmpty, reason: 'nothing typed at the agent');
    });

    testWidgets('a picture alone keeps its own sheet title', (tester) async {
      await tester.pumpWidget(bar(pick: () {}, photo: () {}));
      await tester.tap(image);
      await tester.pumpAndSettle();
      expect(find.text('Send a picture to this harness'), findsOneWidget);
      expect(find.text('Choose a file'), findsNothing);
    });

    testWidgets('where only a file can go, the key says so and opens the '
        'picker at once', (tester) async {
      var files = 0;
      await tester.pumpWidget(bar(file: () => files++));
      expect(image, findsNothing);
      final key = find.byKey(const ValueKey('terminal-key-Send file'));
      expect(find.descendant(of: key, matching: find.text('file')), findsOne);

      await tester.tap(key);
      await tester.pumpAndSettle();
      expect(files, 1);
      expect(find.text('Choose a file'), findsNothing, reason: 'no sheet');
    });
  });

  group('paste comes and goes with the clipboard', () {
    // What `Clipboard.hasStrings` answers: null throws, as a platform that
    // cannot say.
    late bool? holdsText;
    late List<String> asked;

    setUp(() {
      holdsText = false;
      asked = [];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        asked.add(call.method);
        if (call.method != 'Clipboard.hasStrings') return null;
        final holds = holdsText;
        if (holds == null) throw PlatformException(code: 'unavailable');
        return {'value': holds};
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
    });

    final paste = find.byKey(const ValueKey('terminal-key-Paste'));
    final clear = find.byKey(const ValueKey('terminal-key-Clear prompt'));
    late int pastes;

    Future<void> pumpPaste(WidgetTester tester) async {
      pastes = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: SizedBox(
                width: 375,
                child: TerminalKeyBar(
                  terminal: terminal,
                  enabled: true,
                  onDismissKeyboard: () {},
                  onPromptEdited: () => edits++,
                  onClearPrompt: () {},
                  onPaste: () => pastes++,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
    }

    /// One turn of the strip's clipboard poll.
    Future<void> nextPoll(WidgetTester tester) async {
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
    }

    /// Takes the strip down, and its poll with it.
    Future<void> done(WidgetTester tester) =>
        tester.pumpWidget(const SizedBox());

    testWidgets('drawn only while the clipboard holds something, beside '
        'clear, and pressed it pastes', (tester) async {
      await pumpPaste(tester);
      expect(paste, findsNothing);

      holdsText = true;
      await nextPoll(tester);
      expect(paste, findsOneWidget);
      expect(
        tester.getTopLeft(paste).dx - tester.getTopRight(clear).dx,
        closeTo(4, 0.01),
      );
      expect(tester.getSize(paste).width, tester.getSize(clear).width);

      await tester.tap(paste);
      await tester.pump();
      expect(pastes, 1);
      expect(edits, 1, reason: 'the keyboard lets go of what it held');

      holdsText = false;
      await nextPoll(tester);
      expect(paste, findsNothing);
      // ⚠️ Asked, never read: a read would bring up iOS's "Allow Paste".
      expect(asked, isNot(contains('Clipboard.getData')));
      await done(tester);
    });

    testWidgets('a clipboard that cannot answer leaves the key as it was', (
      tester,
    ) async {
      holdsText = true;
      await pumpPaste(tester);
      expect(paste, findsOneWidget);

      holdsText = null;
      await nextPoll(tester);
      expect(paste, findsOneWidget, reason: 'no flicker on an error');
      expect(tester.takeException(), isNull);
      await done(tester);
    });

    testWidgets('not asked in the background; asked at once on the way back', (
      tester,
    ) async {
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      await pumpPaste(tester);
      expect(paste, findsNothing);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      asked.clear();
      holdsText = true;
      await nextPoll(tester);
      expect(asked, isEmpty, reason: 'Android hands a background app nothing');
      expect(paste, findsNothing);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump();
      expect(paste, findsOneWidget, reason: 'without waiting for the poll');
      await done(tester);
    });
  });
}
