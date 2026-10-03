import 'dart:ui' show SemanticsAction;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
import 'package:xterm/src/ui/custom_text_edit.dart';

void main() {
  testWidgets(
    'native accessibility can insert text once into a writable terminal',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final terminal = Terminal(maxLines: 20)..resize(80, 4);
      final output = <String>[];
      terminal.onOutput = output.add;
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 800,
            height: 200,
            child: TerminalView(terminal, autofocus: true),
          ),
        ),
      );
      await tester.pump();
      final input = find.bySemanticsLabel('Terminal input');
      expect(input, findsOneWidget);
      final node = tester.getSemantics(input);
      expect(
        node.getSemanticsData().hasAction(SemanticsAction.setText),
        isTrue,
      );
      tester
          .renderObject(input)
          .owner!
          .semanticsOwner!
          .performAction(node.id, SemanticsAction.setText, 'Dictated text');
      await tester.pump();
      expect(output.join(), 'Dictated text');
      // The platform echo and subsequent typing must not repeat the dictated phrase.
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Dictated text',
          selection: TextSelection.collapsed(offset: 13),
        ),
      );
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Dictated text!',
          selection: TextSelection.collapsed(offset: 14),
        ),
      );
      await tester.pump();
      expect(output.join(), 'Dictated text!');
      await tester.pumpWidget(const SizedBox());
      semantics.dispose();
    },
    variant: TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  group('macOS "Add period with double-space"', () {
    Future<List<String>> mount(WidgetTester tester) async {
      final terminal = Terminal(maxLines: 20)..resize(80, 4);
      final output = <String>[];
      terminal.onOutput = output.add;
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 800,
            height: 200,
            child: TerminalView(terminal, autofocus: true),
          ),
        ),
      );
      await tester.pump();
      return output;
    }

    void native(WidgetTester tester, String text, {TextRange? composing}) {
      tester.testTextInput.updateEditingValue(
        TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(offset: text.length),
          composing: composing ?? TextRange.empty,
        ),
      );
    }

    // The second press never arrives as a space: macOS asks the input client to replace the
    // first one with ". ", which reached the pty as a Backspace and ". ". So the space bar is
    // typed straight into the terminal and never reaches the input method.
    testWidgets(
      'the space bar is typed directly, so two presses stay two spaces',
      (tester) async {
        final output = await mount(tester);
        native(tester, 'a');
        await tester.pump();
        for (var press = 0; press < 2; press++) {
          expect(
            await tester.sendKeyEvent(
              LogicalKeyboardKey.space,
              character: ' ',
              platform: 'macos',
            ),
            isTrue,
          );
        }
        // The native buffer follows, so the next letter the input method inserts diffs cleanly.
        expect(tester.testTextInput.editingState?['text'], 'a  ');
        native(tester, 'a  b');
        await tester.pump();
        expect(output.join(), 'a  b');
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'a space that commits a composition still goes to the input method',
      (tester) async {
        final output = await mount(tester);
        native(tester, 'ni', composing: const TextRange(start: 0, end: 2));
        await tester.pump();
        expect(
          await tester.sendKeyEvent(
            LogicalKeyboardKey.space,
            character: ' ',
            platform: 'macos',
          ),
          isFalse,
        );
        expect(output, isEmpty);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );

    testWidgets(
      'other platforms leave the space bar to the input method',
      (tester) async {
        final output = await mount(tester);
        expect(
          await tester.sendKeyEvent(
            LogicalKeyboardKey.space,
            character: ' ',
            platform: 'linux',
          ),
          isFalse,
        );
        expect(output, isEmpty);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.linux),
    );
  });

  testWidgets(
    'an observed terminal exposes no accessibility editing action',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final terminal = Terminal(maxLines: 20)..resize(80, 4);
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 800,
            height: 200,
            child: TerminalView(terminal, readOnly: true),
          ),
        ),
      );
      await tester.pump();
      expect(find.bySemanticsLabel('Terminal input'), findsNothing);
      final node = tester.getSemantics(
        find.bySemanticsLabel('Terminal output'),
      );
      expect(
        node.getSemanticsData().hasAction(SemanticsAction.setText),
        isFalse,
      );
      await tester.pumpWidget(const SizedBox());
      semantics.dispose();
    },
    variant: TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  test('does not turn an xterm keyboard command into text styling', () {
    final terminal = Terminal(maxLines: 20, reflowEnabled: false)
      ..resize(80, 4);
    terminal.buffer.clear();
    final cell = CellData.empty();

    // `CSI > 4 ; 2 m` configures xterm's modifyOtherKeys mode. It is not SGR
    // `CSI 4 ; 2 m`, which would mean underline + faint.
    terminal.write('\x1b[>4;2mtyped');

    expect(terminal.cursor.attrs, 0);
    terminal.buffer.currentLine.getCellData(4, cell);
    expect(cell.flags, 0);
  });

  test('keeps ordinary SGR styling intact', () {
    final terminal = Terminal(maxLines: 20, reflowEnabled: false)
      ..resize(80, 4);
    terminal.buffer.clear();
    final cell = CellData.empty();

    terminal.write('\x1b[4;2mstyled');

    expect(terminal.cursor.attrs, CellAttr.underline | CellAttr.faint);
    terminal.buffer.currentLine.getCellData(5, cell);
    expect(cell.flags, CellAttr.underline | CellAttr.faint);
  });

  test('SGR 22 clears bold and faint across live write chunks', () {
    final terminal = Terminal(maxLines: 20, reflowEnabled: false)
      ..resize(80, 4);
    terminal.buffer.clear();
    final cell = CellData.empty();

    // tmux control mode can deliver the reset in a later output frame than
    // the styled text. The parser must retain stream state across writes while
    // still applying SGR 22 exactly like a native terminal.
    terminal.write('\x1b[1;2mB');
    terminal.write('\x1b[22mN');

    terminal.buffer.currentLine.getCellData(0, cell);
    expect(cell.flags, CellAttr.bold | CellAttr.faint);
    terminal.buffer.currentLine.getCellData(1, cell);
    expect(cell.flags, 0);
    expect(terminal.cursor.attrs, 0);
  });

  testWidgets('commits IME text once and never forwards its pre-edit keys', (
    tester,
  ) async {
    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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
    expect(tester.testTextInput.hasAnyClients, isTrue);

    // The raw key that begins a Pinyin/Japanese/Vietnamese composition must
    // reach the native text input client, not the PTY.
    final handled = await tester.sendKeyDownEvent(
      LogicalKeyboardKey.keyN,
      character: 'n',
      platform: 'macos',
    );
    expect(handled, isFalse);
    expect(outbound, isEmpty);

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'ni',
        selection: TextSelection.collapsed(offset: 2),
        composing: TextRange(start: 0, end: 2),
      ),
    );
    await tester.pump();
    expect(outbound, isEmpty);

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'に',
        selection: TextSelection.collapsed(offset: 1),
      ),
    );
    await tester.pump();
    expect(outbound, ['に']);

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'にnihao',
        selection: TextSelection.collapsed(offset: 6),
        composing: TextRange(start: 1, end: 6),
      ),
    );
    await tester.pump();
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'に你好',
        selection: TextSelection.collapsed(offset: 3),
      ),
    );
    await tester.pump();
    expect(outbound, ['に', '你好']);

    // Cancelling a composition must not insert an empty or partial value.
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'に你好telex',
        selection: TextSelection.collapsed(offset: 8),
        composing: TextRange(start: 3, end: 8),
      ),
    );
    await tester.pump();
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'に你好',
        selection: TextSelection.collapsed(offset: 3),
      ),
    );
    await tester.pump();
    expect(outbound, ['に', '你好']);

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'に你好Tiếng Việt 日本語 中文',
        selection: TextSelection.collapsed(offset: 20),
      ),
    );
    await tester.pump();
    expect(outbound, ['に', '你好', 'Tiếng Việt 日本語 中文']);
  });

  testWidgets('rewrites Telex text without losing IME context', (tester) async {
    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'u',
        selection: TextSelection.collapsed(offset: 1),
      ),
    );
    await tester.pump();
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'ư',
        selection: TextSelection.collapsed(offset: 1),
      ),
    );
    await tester.pump();

    expect(outbound, ['u', '\x7f', 'ư']);

    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.enter,
      character: '\r',
      platform: 'macos',
    );
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'a',
        selection: TextSelection.collapsed(offset: 1),
      ),
    );
    await tester.pump();
    expect(outbound, ['u', '\x7f', 'ư', '\r', 'a']);
  });

  testWidgets('replays the suffix when native text replaces an earlier vowel', (
    tester,
  ) async {
    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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

    for (final value in const [
      TextEditingValue(
        text: 'o',
        selection: TextSelection.collapsed(offset: 1),
      ),
      TextEditingValue(
        text: 'ô',
        selection: TextSelection.collapsed(offset: 1),
      ),
      TextEditingValue(
        text: 'ôi',
        selection: TextSelection.collapsed(offset: 2),
      ),
      TextEditingValue(
        text: 'ối',
        selection: TextSelection.collapsed(offset: 2),
      ),
    ]) {
      tester.testTextInput.updateEditingValue(value);
      await tester.pump();
    }

    // The native input source owns `oois -> ối`. The terminal bridge only
    // applies the successive text states and contains no Telex conversion.
    expect(outbound, ['o', '\x7f', 'ô', 'i', '\x7f', '\x7f', 'ối']);
  });

  testWidgets('does not forward marked text before the IME commits it', (
    tester,
  ) async {
    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'ni',
        selection: TextSelection.collapsed(offset: 2),
        composing: TextRange(start: 0, end: 2),
      ),
    );
    await tester.pump();
    expect(outbound, isEmpty);

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: '你',
        selection: TextSelection.collapsed(offset: 1),
      ),
    );
    await tester.pump();

    expect(outbound, ['你']);
  });

  testWidgets('does not preview a marked buffer already mirrored to the PTY', (
    tester,
  ) async {
    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'xin chaf banj nha',
        selection: TextSelection.collapsed(offset: 17),
      ),
    );
    await tester.pump();
    expect(outbound, ['xin chaf banj nha']);

    // Some macOS input sources immediately mark the same full buffer again.
    // It is not new pre-edit text and must not leave a composing overlay.
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'xin chaf banj nha',
        selection: TextSelection.collapsed(offset: 17),
        composing: TextRange(start: 0, end: 17),
      ),
    );
    await tester.pump();

    expect(outbound, ['xin chaf banj nha']);
  });

  testWidgets(
    'clears an IME preview as soon as the remote terminal echoes it',
    (tester) async {
      final terminal = Terminal(maxLines: 200, reflowEnabled: false)
        ..resize(80, 12);
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

      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'sdfjkhs',
          selection: TextSelection.collapsed(offset: 7),
          composing: TextRange(start: 0, end: 7),
        ),
      );
      await tester.pump();
      final state = tester.state<TerminalViewState>(find.byType(TerminalView));
      expect(state.debugComposingText, 'sdfjkhs');

      // This is an incoming terminal write, not a local TextInput commit.
      terminal.write('> sdfjkhs');
      await tester.pump();

      expect(state.debugComposingText, isNull);
    },
  );

  testWidgets('clears native editing state when switching terminals', (
    tester,
  ) async {
    final first = Terminal(maxLines: 200, reflowEnabled: false)..resize(80, 12);
    final second = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final active = ValueNotifier<Terminal>(first);
    addTearDown(active.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 900,
            height: 260,
            child: ValueListenableBuilder<Terminal>(
              valueListenable: active,
              builder: (_, terminal, _) =>
                  TerminalView(terminal, autofocus: true),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'ni',
        selection: TextSelection.collapsed(offset: 2),
        composing: TextRange(start: 0, end: 2),
      ),
    );
    await tester.pump();

    active.value = second;
    await tester.pump();
    await tester.pump();

    expect(tester.testTextInput.editingState?['text'], isEmpty);
  });

  testWidgets('coalesces an IME replacement with its queued delete selector', (
    tester,
  ) async {
    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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

    final input = tester.state<CustomTextEditState>(
      find.byType(CustomTextEdit),
    );
    input.updateEditingValue(
      const TextEditingValue(
        text: 'u',
        selection: TextSelection.collapsed(offset: 1),
      ),
    );
    input.performSelector('deleteBackward:');
    input.updateEditingValue(
      const TextEditingValue(
        text: 'ư',
        selection: TextSelection.collapsed(offset: 1),
      ),
    );
    await tester.pump();

    expect(outbound, ['u', '\x7f', 'ư']);
  });

  /// Backspace, on the platform whose embedder answers for it.
  ///
  /// macOS is handed the key rather than sent bytes, so that an IME can use it
  /// internally (Telex types `ư` as `u` + backspace + `ư`). AppKit turns it
  /// into `deleteBackward:` and ships the selector back over
  /// `TextInputClient.performSelectors`, which is what this stands in for.
  testWidgets('on macOS, Backspace is left to the native text input client', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;

    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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

    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'u',
        selection: TextSelection.collapsed(offset: 1),
      ),
    );
    await tester.pump();

    final handled = await tester.sendKeyDownEvent(
      LogicalKeyboardKey.backspace,
      character: '\b',
      platform: 'macos',
    );

    // Nothing calls performSelector here on purpose: told the platform is
    // macOS, the test harness delivers `deleteBackward:` itself, the way
    // AppKit does. That IS the contract — the key is not answered by the
    // terminal, and the byte arrives by the selector route instead.
    await tester.pump(const Duration(milliseconds: 1));
    debugDefaultTargetPlatformOverride = null;

    expect(handled, isFalse, reason: 'the native client owns it on macOS');
    expect(outbound, ['u', '\x7f']);
  });

  /// The same key on a platform whose embedder does NOT answer for it.
  ///
  /// The GTK embedder has no `TextInputClient.performSelectors` method at all,
  /// and its key handler names `GDK_KEY_BackSpace` explicitly in order to do
  /// nothing with it — correct for an `EditableText`, wrong for xterm's bare
  /// `TextInputClient`. Deferring there sent the key nowhere: everything typed
  /// except Backspace. So off Apple the key must produce its byte from the key
  /// event ALONE — no `performSelector` call anywhere in this test.
  testWidgets('on Linux, Backspace sends DEL from the key event alone', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;

    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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

    final handled = await tester.sendKeyDownEvent(
      LogicalKeyboardKey.backspace,
      character: '\b',
      platform: 'linux',
    );
    await tester.pump(const Duration(milliseconds: 1));
    debugDefaultTargetPlatformOverride = null;

    expect(handled, isTrue, reason: 'the terminal has to own the key here');
    expect(outbound, ['\x7f']);
  });

  /// ⌘ is the app's modifier on every desktop, not just Apple's.
  ///
  /// Every shortcut in `lib/shortcuts/app_shortcuts.dart` is declared
  /// `meta: true`, which is the Super key on Linux. While this was gated on
  /// macOS/iOS a focused terminal answered Super+key itself — typing the bare
  /// letter at the shell and stopping the chord from ever reaching the app's
  /// Shortcuts, so every one of them was dead with a pane focused.
  testWidgets('on Linux, a Meta chord is left for the app, not typed', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;

    final terminal = Terminal(maxLines: 200, reflowEnabled: false)
      ..resize(80, 12);
    final outbound = <String>[];
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

    await tester.sendKeyDownEvent(LogicalKeyboardKey.meta, platform: 'linux');
    final handled = await tester.sendKeyDownEvent(
      LogicalKeyboardKey.keyN,
      platform: 'linux',
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.keyN, platform: 'linux');
    await tester.sendKeyUpEvent(LogicalKeyboardKey.meta, platform: 'linux');
    await tester.pump(const Duration(milliseconds: 1));
    debugDefaultTargetPlatformOverride = null;

    expect(handled, isFalse, reason: 'the chord belongs to the app above');
    expect(outbound, isEmpty, reason: 'and must not be typed at the shell');
  });

  testWidgets(
    'mouse wheel scrolls synthesized tmux history without PTY input',
    (tester) async {
      final terminal = Terminal(maxLines: 200, reflowEnabled: false)
        ..resize(80, 12);
      final outbound = <String>[];
      terminal.onOutput = outbound.add;
      final history = List.generate(
        80,
        (index) => '\x1b[${index.isEven ? 31 : 36}mhistory-$index\x1b[0m\r\n',
      ).join();
      final viewportPush = List.filled(12, '\r\n').join();
      terminal.write(
        '\x1bc\x1b[?25l\x1b[?7l\x1b[H\x1b[2J'
        '$history$viewportPush\x1b[H\x1b[2J'
        '\x1b[1;1Hcurrent-screen\x1b[0m'
        '\x1b[1;15H\x1b[?7h\x1b[?25h',
      );
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 900,
              height: 260,
              child: TerminalView(
                terminal,
                scrollController: scrollController,
                autofocus: true,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(scrollController.hasClients, isTrue);
      final bottom = scrollController.position.maxScrollExtent;
      expect(bottom, greaterThan(0));
      scrollController.jumpTo(bottom);

      final position = tester.getCenter(find.byType(TerminalView));
      await tester.sendEventToBinding(
        PointerScrollEvent(
          position: position,
          scrollDelta: const Offset(0, -120),
          kind: PointerDeviceKind.mouse,
        ),
      );
      await tester.pumpAndSettle();

      expect(scrollController.offset, lessThan(bottom));
      expect(terminal.buffer.getText(), contains('history-0'));
      expect(outbound, isEmpty);
    },
  );
}
