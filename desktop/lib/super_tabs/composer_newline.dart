import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// The most the Swarm chat box holds; the field's own limit and [withNewline]'s.
const kComposerMaxLength = 32000;

/// [value] with a line break at the cursor, replacing a selection.
///
/// Null when the box has no room for it: a value set from code skips the field's length limit,
/// so the limit is kept here.
TextEditingValue? withNewline(TextEditingValue value) {
  final selection = value.selection.isValid
      ? value.selection
      : TextSelection.collapsed(offset: value.text.length);
  final text =
      '${selection.textBefore(value.text)}\n${selection.textAfter(value.text)}';
  if (text.length > kComposerMaxLength) return null;
  return TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(offset: selection.start + 1),
  );
}

/// What a key does in a chat box.
enum ComposerEnter { ignore, newline, send }

/// What [event] does in a chat box holding [value] when [focused]: Enter sends,
/// Shift+Enter and Alt/Option+Enter write another line, Ctrl or Command with Enter and
/// every other key are left to the field, and nothing happens while an input method
/// is composing. The main chat and the thread pane both decide with this.
ComposerEnter composerEnter(
  KeyEvent event, {
  required bool focused,
  required TextEditingValue value,
}) {
  final composing = value.composing;
  if (!focused ||
      event is! KeyDownEvent ||
      event.logicalKey != LogicalKeyboardKey.enter ||
      (composing.isValid && !composing.isCollapsed)) {
    return ComposerEnter.ignore;
  }
  final keys = HardwareKeyboard.instance;
  if (keys.isControlPressed || keys.isMetaPressed) return ComposerEnter.ignore;
  // Shift+Enter and Alt+Enter write the line themselves: the platform gives
  // Option+Return none, and a handled key never reaches it.
  return keys.isShiftPressed || keys.isAltPressed
      ? ComposerEnter.newline
      : ComposerEnter.send;
}

/// Writes a line break into [composer] at the cursor and tells [edited] the new
/// text. The field only reports edits that come from the platform, so this reports
/// its own.
void insertComposerNewline(
  TextEditingController composer,
  ValueChanged<String> edited,
) {
  final value = withNewline(composer.value);
  if (value == null) return;
  composer.value = value;
  edited(value.text);
}
