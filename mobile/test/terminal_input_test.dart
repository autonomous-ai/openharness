import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_input.dart';
import 'package:xterm/xterm.dart';

/// A hardware keyboard on a phone breaks a line in an engine's prompt exactly
/// as the desktop does: ⇧⏎ as CSI-u, ⌥⏎ as ESC + Return — never the keytab's
/// `\EOM` for ⇧⏎, and never a bare Return, which is the submit.
void main() {
  /// A pane's terminal, as `TerminalSession` builds it.
  Terminal pane(List<String> out) => Terminal(
    maxLines: 200,
    platform: TerminalTargetPlatform.macos,
    inputHandler: harnessInputHandler,
    reflowEnabled: false,
  )..onOutput = out.add;

  for (final key in [TerminalKey.enter, TerminalKey.numpadEnter]) {
    test('⇧$key leaves as CSI-u, LNM or not', () {
      final out = <String>[];
      final terminal = pane(out);

      terminal.keyInput(key, shift: true);
      terminal.write('\x1b[20h'); // LNM must not turn this into a submit.
      terminal.keyInput(key, shift: true);

      expect(out, ['\x1b[13;2u', '\x1b[13;2u']);
    });

    test('⌥$key leaves as ESC + Return, LNM\'s Return included', () {
      final out = <String>[];
      final terminal = pane(out);

      terminal.keyInput(key, alt: true);
      terminal.write('\x1b[20h');
      terminal.keyInput(key, alt: true);

      expect(out, ['\x1b\r', '\x1b\r\n']);
    });
  }

  test('⌥⇧⏎ is a Meta-prefixed Return, not a prefixed CSI-u', () {
    final out = <String>[];
    pane(out).keyInput(TerminalKey.enter, alt: true, shift: true);
    expect(out, ['\x1b\r']);
  });

  test('plain Return still submits, and ⌃⇧⏎ keeps the keytab\'s answer', () {
    final out = <String>[];
    final baseline = <String>[];
    final unmodified = Terminal(platform: TerminalTargetPlatform.macos)
      ..onOutput = baseline.add;
    final terminal = pane(out);

    terminal.keyInput(TerminalKey.enter);
    terminal.keyInput(TerminalKey.enter, ctrl: true, shift: true);
    unmodified.keyInput(TerminalKey.enter);
    unmodified.keyInput(TerminalKey.enter, ctrl: true, shift: true);

    expect(out, baseline);
    expect(out.first, '\r');
  });

  group('from a hardware keyboard on the phone', () {
    Future<List<String>> press(
      WidgetTester tester,
      LogicalKeyboardKey modifier,
    ) async {
      final out = <String>[];
      final terminal = pane(out)..resize(80, 12);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 400,
              height: 320,
              child: TerminalView(terminal, autofocus: true),
            ),
          ),
        ),
      );
      await tester.pump();
      final platform = switch (defaultTargetPlatform) {
        TargetPlatform.iOS => 'ios',
        _ => 'android',
      };
      await tester.sendKeyDownEvent(modifier, platform: platform);
      await tester.sendKeyDownEvent(
        LogicalKeyboardKey.enter,
        platform: platform,
      );
      await tester.sendKeyUpEvent(LogicalKeyboardKey.enter, platform: platform);
      await tester.sendKeyUpEvent(modifier, platform: platform);
      await tester.pump();
      return out;
    }

    final phones = TargetPlatformVariant({
      TargetPlatform.iOS,
      TargetPlatform.android,
    });

    testWidgets('⇧⏎ reaches the pty as CSI-u', (tester) async {
      expect(await press(tester, LogicalKeyboardKey.shiftLeft), ['\x1b[13;2u']);
    }, variant: phones);

    testWidgets('⌥⏎ reaches the pty as ESC + Return', (tester) async {
      expect(await press(tester, LogicalKeyboardKey.altLeft), ['\x1b\r']);
    }, variant: phones);
  });
}
