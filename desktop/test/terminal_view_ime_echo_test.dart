import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/ime_echo_hold.dart';
import 'package:xterm/xterm.dart';

/// A remote terminal echoes a committed word a round trip later. These replay
/// Telex typing (`alo mayf` → "alo mày") with the echo arriving late.
void main() {
  late Terminal terminal;
  late List<String> outbound;

  Future<TerminalViewState> pumpView(WidgetTester tester) async {
    terminal = Terminal(maxLines: 200, reflowEnabled: false)..resize(80, 12);
    outbound = [];
    terminal.onOutput = outbound.add;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 900,
            height: 260,
            child: TerminalView(terminal, autofocus: true),
          ),
        ),
      ),
    );
    await tester.pump();
    return tester.state<TerminalViewState>(find.byType(TerminalView));
  }

  Future<void> type(
    WidgetTester tester,
    String text, {
    TextRange composing = TextRange.empty,
  }) async {
    tester.testTextInput.updateEditingValue(
      TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
        composing: composing,
      ),
    );
    await tester.pump();
  }

  testWidgets('keeps a committed word on screen until its echo lands', (
    tester,
  ) async {
    final view = await pumpView(tester);

    await type(tester, 'alo', composing: const TextRange(start: 0, end: 3));
    expect(view.debugComposingText, 'alo');

    await type(tester, 'alo ');
    expect(outbound, ['alo ']);
    expect(view.debugComposingText, 'alo ');

    // The next word composes after the held one, not over it.
    await type(tester, 'alo may', composing: const TextRange(start: 4, end: 7));
    expect(view.debugComposingText, 'alo may');

    terminal.write('alo ');
    await tester.pump();
    expect(view.debugComposingText, 'may');

    await type(tester, 'alo mày ');
    expect(outbound, ['alo ', 'mày ']);
    expect(view.debugComposingText, 'mày ');

    terminal.write('mày ');
    await tester.pump();
    expect(view.debugComposingText, isNull);
  });

  testWidgets('Return lets go of a held word', (tester) async {
    final view = await pumpView(tester);

    await type(tester, 'alo', composing: const TextRange(start: 0, end: 3));
    await type(tester, 'alo');
    expect(view.debugComposingText, 'alo');

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    expect(view.debugComposingText, isNull);
  });

  testWidgets('typing without an input method shows nothing extra', (
    tester,
  ) async {
    final view = await pumpView(tester);

    await type(tester, 'hunter2');

    expect(outbound, ['hunter2']);
    expect(view.debugComposingText, isNull);
  });

  group('the caret follows the preview', () {
    List<Rect> cursorBlocks(TerminalViewState view) {
      final blocks = <Rect>[];
      expect(
        view.renderTerminal,
        paints..everything((method, arguments) {
          if (method != #drawRect) return true;
          // Filled with focus, outlined without: either way, the cursor colour.
          final paint = arguments[1] as Paint;
          if (paint.color.toARGB32() ==
              TerminalThemes.defaultTheme.cursor.toARGB32()) {
            blocks.add(arguments[0] as Rect);
          }
          return true;
        }),
      );
      return blocks;
    }

    Future<void> expectCaretMovedBy(
      WidgetTester tester,
      String composing,
      int cells,
    ) async {
      final view = await pumpView(tester);
      terminal.write('› ');
      await tester.pump();
      final atCursor = cursorBlocks(view).single;

      await type(
        tester,
        composing,
        composing: TextRange(start: 0, end: composing.length),
      );

      final width = view.renderTerminal.cellSize.width;
      expect(
        cursorBlocks(view).single,
        atCursor.shift(Offset(cells * width, 0)),
      );
    }

    // A lone Telex `a` stays composing until the next key; under the block
    // it looked as if nothing had been typed.
    testWidgets('after a one-letter composition', (tester) async {
      await expectCaretMovedBy(tester, 'a', 1);
    });

    testWidgets('after a wide character', (tester) async {
      await expectCaretMovedBy(tester, '你', 2);
    });
  });

  testWidgets('a word the terminal never echoes lets go after a while', (
    tester,
  ) async {
    final view = await pumpView(tester);

    await type(tester, 'alo', composing: const TextRange(start: 0, end: 3));
    await type(tester, 'alo');
    expect(view.debugComposingText, 'alo');

    await tester.pump(ImeEchoHold.defaultTimeout);

    expect(view.debugComposingText, isNull);
  });
}
