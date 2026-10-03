import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

/// A phone's on-screen keyboard sends no Backspace key: it deletes from the
/// terminal's hidden input buffer, and the terminal turns that into DEL. The
/// buffer keeps a pad so the delete is seen even when nothing was typed —
/// which is how a pasted `[Image #1]` at an agent's prompt gets removed.
void main() {
  Future<(List<String>, _SoftKeyboard)> mount(WidgetTester tester) async {
    final output = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalView(
          Terminal(onOutput: output.add),
          autofocus: true,
          deleteDetection: true,
        ),
      ),
    );
    await tester.pump();
    return (output, _SoftKeyboard(tester));
  }

  testWidgets('every Backspace on an empty prompt reaches the terminal', (
    tester,
  ) async {
    final (output, keyboard) = await mount(tester);
    for (var i = 0; i < 5; i++) {
      await keyboard.backspace();
    }
    expect(output.join(), '\x7f' * 5);
  });

  testWidgets('typed text still deletes one character at a time', (
    tester,
  ) async {
    final (output, keyboard) = await mount(tester);
    await keyboard.type('ab');
    for (var i = 0; i < 4; i++) {
      await keyboard.backspace();
    }
    expect(output.join(), 'ab${'\x7f' * 4}');
  });

  // iOS Safari types into a <textarea>: Return reports the action, then the
  // textarea types its own newline onto the pad or the line just sent.
  for (final (race, newline) in [
    ('after the reset', (String line) => '  \n'),
    ('before the reset', (String line) => '  $line\n'),
  ]) {
    testWidgets('Return submits once when its newline lands $race', (
      tester,
    ) async {
      final (output, keyboard) = await mount(tester);
      await keyboard.type('ls');
      await tester.testTextInput.receiveAction(TextInputAction.newline);
      await keyboard._send(newline('ls'));
      await keyboard.type('a');
      expect(output.join(), 'ls\ra');
    });
  }
}

/// The on-screen keyboard's own copy of the buffer. `testTextInput` records
/// only what the app sets, so the keyboard keeps what it typed and adopts the
/// app's value whenever the app sets a new one.
class _SoftKeyboard {
  _SoftKeyboard(this.tester) {
    _adoptAppState();
  }

  final WidgetTester tester;
  String _text = '';
  int _seenSets = 0;

  int get _appSets => tester.testTextInput.log
      .where((call) => call.method == 'TextInput.setEditingState')
      .length;

  void _adoptAppState() {
    if (_appSets == _seenSets) return;
    _seenSets = _appSets;
    _text = tester.testTextInput.editingState!['text'] as String;
  }

  Future<void> _send(String text) async {
    _adoptAppState();
    _text = text;
    tester.testTextInput.updateEditingValue(
      TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      ),
    );
    await tester.pump();
    _adoptAppState();
  }

  Future<void> type(String typed) async {
    _adoptAppState();
    await _send('$_text$typed');
  }

  Future<void> backspace() async {
    _adoptAppState();
    await _send(_text.substring(0, _text.length - 1));
  }
}
