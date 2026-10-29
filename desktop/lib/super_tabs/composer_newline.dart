import 'package:flutter/services.dart';

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
