import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

/// Local echo (`TerminalView.predictsEcho`): what is typed is drawn faint at the
/// cursor before the machine echoes it back — but only where that echo will
/// land, only once the terminal has been seen to echo, and never into a prompt
/// that does not echo (a password). A key the screen cannot vouch for is simply
/// not drawn: drawing nothing is always safe, drawing the wrong thing is not.
void main() {
  /// The phone's terminal: delete detection on, local echo on, a prompt drawn.
  Future<({Terminal terminal, List<String> sent, _Keyboard keyboard})> open(
    WidgetTester tester,
  ) async {
    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final sent = <String>[];
    terminal.onOutput = sent.add;
    terminal.write('> ');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 400,
            height: 320,
            child: TerminalView(
              terminal,
              autofocus: true,
              deleteDetection: true,
              predictsEcho: true,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(tester.testTextInput.hasAnyClients, isTrue);
    return (terminal: terminal, sent: sent, keyboard: _Keyboard(tester));
  }

  String drawn(WidgetTester tester) =>
      tester.state<TerminalViewState>(find.byType(TerminalView)).debugPredictedText;

  /// The machine echoing [text] back, as a terminal does: written at the cursor.
  Future<void> echo(WidgetTester tester, Terminal terminal, String text) async {
    terminal.write(text);
    await tester.pump();
  }

  /// A terminal already seen echoing, with `ab` typed and echoed.
  Future<({Terminal terminal, List<String> sent, _Keyboard keyboard})> echoing(
    WidgetTester tester,
  ) async {
    final t = await open(tester);
    await t.keyboard.type('a');
    await echo(tester, t.terminal, 'a');
    await t.keyboard.type('b');
    await echo(tester, t.terminal, 'b');
    t.sent.clear();
    return t;
  }

  testWidgets(
    'draws nothing until the terminal is seen echoing, then draws each key ahead of its echo',
    (tester) async {
      final t = await open(tester);
      await t.keyboard.type('h');
      expect(t.sent, ['h']);
      expect(drawn(tester), '', reason: 'nothing seen echoing yet');
      await echo(tester, t.terminal, 'h');
      await t.keyboard.type('i');
      expect(drawn(tester), 'i');
      await echo(tester, t.terminal, 'i');
      expect(drawn(tester), '');
    },
  );

  testWidgets(
    'a guess whose echo never comes is taken down, and nothing more is guessed',
    (tester) async {
      // A password prompt that appeared in place: the typed key must not stay
      // on the screen, and the next one must not be drawn at all.
      final t = await echoing(tester);
      await t.keyboard.type('x');
      expect(drawn(tester), 'x');
      await tester.pump(const Duration(milliseconds: 450));
      expect(drawn(tester), '');
      await t.keyboard.type('y');
      expect(drawn(tester), '');
      await tester.pump(const Duration(seconds: 3));
    },
  );

  testWidgets(
    'output that is not what was typed turns guessing off until a key is seen echoed',
    (tester) async {
      // The cursor moving on is not an echo by itself: only the typed text
      // drawn back is.
      final t = await echoing(tester);
      await t.keyboard.type('q');
      await echo(tester, t.terminal, 'Z');
      expect(drawn(tester), '');
      await t.keyboard.type('r');
      expect(drawn(tester), '', reason: 'guessing is off');
      await echo(tester, t.terminal, 'r');
      await t.keyboard.type('s');
      expect(drawn(tester), 's');
      await tester.pump(const Duration(seconds: 3));
    },
  );

  testWidgets(
    'a space the program moves past instead of printing is still its echo',
    (tester) async {
      // A TUI may draw a typed blank by moving the cursor over it.
      final t = await echoing(tester);
      await t.keyboard.type(' ');
      await t.keyboard.type('x');
      await echo(tester, t.terminal, '\x1b[C');
      expect(drawn(tester), 'x');
      await echo(tester, t.terminal, 'x');
      expect(drawn(tester), '');
    },
  );

  group('password prompts', () {
    testWidgets('one that masks each key with * never has a key drawn', (
      tester,
    ) async {
      // `gh auth login`'s token, sudo with pwfeedback: keys typed faster than
      // the first * came back were drawn the moment it did (review, 2026-10-19).
      final t = await echoing(tester);
      await t.keyboard.enter();
      await echo(tester, t.terminal, '\r\nToken: ');
      await t.keyboard.type('s');
      await t.keyboard.type('e');
      await t.keyboard.type('c');
      expect(drawn(tester), '');
      await echo(tester, t.terminal, '*');
      expect(drawn(tester), '');
      await echo(tester, t.terminal, '**');
      expect(drawn(tester), '');
      // A delete there is no probe: the next key is not drawn at once either.
      await t.keyboard.backspace();
      await echo(tester, t.terminal, '\b \b');
      await t.keyboard.type('x');
      expect(drawn(tester), '');
      await echo(tester, t.terminal, '*');
      expect(drawn(tester), '');
      await tester.pump(const Duration(seconds: 3));
    });

    testWidgets(
      'output moving the cursor at one that does not echo draws nothing',
      (tester) async {
        final t = await echoing(tester);
        await t.keyboard.enter();
        await echo(tester, t.terminal, '\r\nPassword: ');
        for (final c in 'secret'.split('')) {
          await t.keyboard.type(c);
          await tester.pump(const Duration(milliseconds: 300));
        }
        await echo(tester, t.terminal, ' ');
        expect(drawn(tester), '');
        await tester.pump(const Duration(seconds: 3));
      },
    );

    testWidgets(
      'one that does not echo is found out while somebody keeps typing into it',
      (tester) async {
        // Each key used to restart the wait for an echo, so typing steadily
        // kept guessing on over the whole password — and one character of
        // output that happened to match its first key drew all the rest.
        final t = await echoing(tester);
        await t.keyboard.enter();
        await echo(tester, t.terminal, '\r\nPassword: ');
        for (var i = 0; i < 8; i++) {
          await t.keyboard.type('a');
          await tester.pump(const Duration(milliseconds: 300));
        }
        await echo(tester, t.terminal, 'a');
        expect(drawn(tester), '');
        await tester.pump(const Duration(seconds: 3));
      },
    );
  });

  testWidgets('a key typed while the cursor is elsewhere is not drawn', (
    tester,
  ) async {
    // Output streaming or a program redrawing moves the cursor about: a guess
    // drawn there would be drawn in the wrong place.
    final t = await echoing(tester);
    await echo(tester, t.terminal, '\x1b[6;10H');
    await t.keyboard.type('z');
    expect(drawn(tester), '');
    await tester.pump(const Duration(seconds: 3));
  });

  group('after a delete', () {
    testWidgets('the next key is drawn at once once the delete is echoed', (
      tester,
    ) async {
      // 12 of 52 keys not drawn came right after a delete (iPhone 14,
      // 2026-10-19): the input point was forgotten with it, and the next key had
      // to wait for its own echo.
      final t = await echoing(tester);
      await t.keyboard.backspace();
      expect(t.sent, ['\x7f']);
      await echo(tester, t.terminal, '\b \b');
      await t.keyboard.type('c');
      expect(drawn(tester), 'c');
    });

    testWidgets('a delete whose echo never comes leaves guessing on', (
      tester,
    ) async {
      // Nothing to delete: the program echoes nothing, and that is no reason to
      // stop drawing ahead.
      final t = await echoing(tester);
      await t.keyboard.backspace();
      await tester.pump(const Duration(seconds: 3));
      await t.keyboard.type('q');
      expect(drawn(tester), '', reason: 'where it lands is not known yet');
      await echo(tester, t.terminal, 'q');
      await t.keyboard.type('r');
      expect(drawn(tester), 'r');
    });

    /// `z中` typed and echoed, then two deletes sent before either echo came:
    /// the wide character's comes back first.
    Future<({Terminal terminal, List<String> sent, _Keyboard keyboard})>
    heldBackspace(WidgetTester tester) async {
      final t = await echoing(tester);
      await t.keyboard.type('z');
      await echo(tester, t.terminal, 'z');
      await t.keyboard.type('中');
      await echo(tester, t.terminal, '中');
      await t.keyboard.backspace();
      await t.keyboard.backspace();
      expect(t.sent.where((s) => s == '\x7f'), hasLength(2));
      return t;
    }

    testWidgets(
      'deletes sent faster than their echo are all waited for, wide ones too',
      (tester) async {
        // A held backspace: each delete used to start the probe over, which
        // ended at the first echo with the cursor still to step back (review,
        // 2026-10-19).
        final t = await heldBackspace(tester);
        await echo(tester, t.terminal, '\b\b  \b\b');
        await echo(tester, t.terminal, '\b \b');
        await t.keyboard.type('c');
        expect(drawn(tester), 'c');
        await echo(tester, t.terminal, 'c');
        expect(drawn(tester), '');
      },
    );

    testWidgets('a key typed before the last delete is echoed is not drawn', (
      tester,
    ) async {
      // Drawn after the first echo, it sat where the cursor would not be once
      // the second delete came back.
      final t = await heldBackspace(tester);
      await echo(tester, t.terminal, '\b\b  \b\b');
      await t.keyboard.type('c');
      expect(drawn(tester), '');
      await tester.pump(const Duration(seconds: 3));
    });

    testWidgets('a wide character deleted puts the input point two cells back', (
      tester,
    ) async {
      final t = await echoing(tester);
      await t.keyboard.type('中');
      await echo(tester, t.terminal, '中');
      await t.keyboard.backspace();
      await echo(tester, t.terminal, '\b\b  \b\b');
      await t.keyboard.type('c');
      expect(drawn(tester), 'c');
      await echo(tester, t.terminal, 'c');
      expect(drawn(tester), '');
    });

    testWidgets('a word retyped right after its deletes is never drawn ahead', (
      tester,
    ) async {
      // Telex turns `duoc` into `được` as three deletes and the letters
      // retyped, all at once: where they land depends on the deletes' echo.
      final t = await echoing(tester);
      await t.keyboard.type('duoc');
      for (final c in 'duoc'.split('')) {
        await echo(tester, t.terminal, c);
      }
      t.sent.clear();
      await t.keyboard.replaceTail(3, 'ược');
      expect(t.sent, ['\x7f', '\x7f', '\x7f', 'ược']);
      expect(drawn(tester), '');
      await echo(tester, t.terminal, '\b\b\bược');
      expect(drawn(tester), '');
      await tester.pump(const Duration(seconds: 3));
    });
  });

  group('after Enter', () {
    testWidgets(
      'keys typed before the first echo comes back are drawn as soon as it does',
      (tester) async {
        // 16 of 52 keys not drawn were typed faster than the first echo came
        // back after the input point was lost: each was a probe of its own, and
        // none was drawn even once one echo had shown where they land.
        final t = await echoing(tester);
        await t.keyboard.enter();
        await echo(tester, t.terminal, '\r\n> ');
        await t.keyboard.type('x');
        await t.keyboard.type('y');
        await t.keyboard.type('z');
        expect(drawn(tester), '');
        await echo(tester, t.terminal, 'x');
        expect(drawn(tester), 'yz');
        await echo(tester, t.terminal, 'yz');
        expect(drawn(tester), '');
      },
    );

    testWidgets(
      'an echo slow to come back with nothing drawn keeps guessing on',
      (tester) async {
        // Claude Code starting a turn echoes the first key late: 9 of 19 keys
        // not drawn because guessing had been turned off came right after Enter.
        final t = await echoing(tester);
        await t.keyboard.enter();
        await echo(tester, t.terminal, '\r\n> ');
        await t.keyboard.type('a');
        await t.keyboard.type('b');
        await tester.pump(const Duration(milliseconds: 600));
        await echo(tester, t.terminal, 'a');
        expect(drawn(tester), 'b');
        await echo(tester, t.terminal, 'b');
        await t.keyboard.type('c');
        expect(drawn(tester), 'c');
      },
    );

    testWidgets(
      'a key drawn once a slow first echo came is taken down at the short wait',
      (tester) async {
        // The longer wait is for an echo with nothing drawn ahead of it; a guess
        // on screen gets the short one, or a prompt that stopped echoing would
        // show it for 1.6s.
        final t = await echoing(tester);
        await t.keyboard.enter();
        await echo(tester, t.terminal, '\r\n> ');
        await t.keyboard.type('a');
        await t.keyboard.type('b');
        await tester.pump(const Duration(milliseconds: 600));
        await echo(tester, t.terminal, 'a');
        expect(drawn(tester), 'b');
        await tester.pump(const Duration(milliseconds: 450));
        expect(drawn(tester), '');
        await tester.pump(const Duration(seconds: 3));
      },
    );

    testWidgets(
      'a prompt that never echoes is never drawn into, however long it waits',
      (tester) async {
        // After Enter, a password prompt: nothing typed into it is ever drawn.
        final t = await echoing(tester);
        await t.keyboard.enter();
        await echo(tester, t.terminal, '\r\nPassword: ');
        for (final c in 'secret'.split('')) {
          await t.keyboard.type(c);
          expect(drawn(tester), '');
        }
        await tester.pump(const Duration(seconds: 3));
        await t.keyboard.type('!');
        expect(drawn(tester), '');
        await tester.pump(const Duration(seconds: 3));
      },
    );
  });
}

/// The software keyboard's own buffer, as UIKit holds it: the terminal's two
/// padding spaces, then what was typed on this line.
class _Keyboard {
  _Keyboard(this.tester);

  final WidgetTester tester;
  String _buffer = '  ';

  Future<void> type(String text) async {
    for (final rune in text.runes) {
      _buffer += String.fromCharCode(rune);
      await _send();
    }
  }

  /// Return: the terminal hands the keyboard back its padding a moment later
  /// (`resetEditingState`), and the keyboard's buffer starts over from it.
  Future<void> enter() async {
    await tester.testTextInput.receiveAction(TextInputAction.newline);
    await tester.pump(const Duration(milliseconds: 20));
    _buffer = '  ';
  }

  Future<void> backspace() async {
    _buffer = _buffer.substring(0, _buffer.length - 1);
    await _send();
  }

  /// The keyboard rewriting the last [count] characters of its buffer as
  /// [text] in one edit — what Telex does to a word.
  Future<void> replaceTail(int count, String text) async {
    _buffer = _buffer.substring(0, _buffer.length - count) + text;
    await _send();
  }

  Future<void> _send() async {
    tester.testTextInput.updateEditingValue(
      TextEditingValue(
        text: _buffer,
        selection: TextSelection.collapsed(offset: _buffer.length),
      ),
    );
    await tester.pump(const Duration(milliseconds: 20));
  }
}
