import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// What UIKit's `deleteBackward` does to the buffer it holds: one character
/// fewer, and NOTHING at all once the buffer is empty. Android's
/// `deleteSurroundingText` reaches Dart the same way, as an edited buffer.
///
/// One press at a person's pace. The terminal hands the keyboard its buffer
/// back a few milliseconds after the key, not inside it (`_pushSoon` in xterm's
/// `custom_text_edit.dart`), and `editingState` is only ever what it was last
/// handed — so the clock moves on past that before the next press reads it.
Future<void> deleteBackward(WidgetTester tester) async {
  final text = tester.testTextInput.editingState!['text'] as String;
  if (text.isEmpty) return;
  final left = text.substring(0, text.length - 1);
  tester.testTextInput.updateEditingValue(
    TextEditingValue(
      text: left,
      selection: TextSelection.collapsed(offset: left.length),
    ),
  );
  await tester.pump(_betweenPresses);
}

/// Well past the terminal's push to the keyboard, and well short of anyone's
/// next Backspace.
const _betweenPresses = Duration(milliseconds: 20);
