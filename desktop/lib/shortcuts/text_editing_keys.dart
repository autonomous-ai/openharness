import 'package:flutter/widgets.dart';

import 'keymap.dart';

/// Whether a focused text field keeps [stroke] for editing, ahead of any app
/// shortcut. The window's keymap runs before the field does, so without this
/// ⌘← moved the pane focus instead of the caret and ⇧⌘← moved the pane itself.
///
/// [hasText] is whether the field holds any text. Only the ⌘-arrows depend on
/// it: in an empty box they have nothing to move, so they keep focusing and
/// moving panes. Every other key here is editing only.
///
/// macOS:  ⌥←/→ by word, ⌘←/→ to line start/end, ⌘↑/↓ to text start/end (⇧
///         selects); ⌥⌫ deletes a word, ⌘⌫ to line start; Ctrl+A/E. Ctrl+K
///         is [textFieldKillsLine]: Flutter has no shortcut for it.
/// Others: Ctrl+←/→ by word, Home/End (Ctrl for the text ends) with ⇧ selecting;
///         Ctrl+Backspace/Delete delete a word.
///
/// Pane focus on ⌘H/J/K/L and the tab keys on ⌥⌘-arrows are not here: a stroke
/// with ⌘ and ⌥ together, or ⌘ with a letter, is never an editing key.
bool textFieldKeepsStroke(
  KeyStroke? stroke, {
  required TargetPlatform platform,
  required bool hasText,
}) {
  if (stroke == null) return false;
  final key = stroke.key;
  final arrow = key == 'left' || key == 'right' || key == 'up' || key == 'down';
  final horizontal = key == 'left' || key == 'right';
  final deletes = key == 'backspace' || key == 'delete';
  final command = stroke.command, alt = stroke.alt, control = stroke.control;

  if (platform == TargetPlatform.macOS) {
    if (command && !alt && !control) {
      if (arrow) return hasText;
      return key == 'backspace' && !stroke.shift;
    }
    if (alt && !command && !control) return horizontal || deletes;
    if (control && !command && !alt && !stroke.shift) {
      return key == 'a' || key == 'e';
    }
    return false;
  }

  if (command || alt) return false;
  if (key == 'home' || key == 'end') return true;
  return control && (horizontal || deletes);
}

/// macOS Ctrl+K deletes to the end of the line. Flutter serves it only through
/// the system's `deleteToEndOfParagraph:` selector, which it does not map, so
/// the host runs [killLineIntent] itself for a field that holds the caret.
bool textFieldKillsLine(
  KeyStroke? stroke, {
  required TargetPlatform platform,
}) =>
    platform == TargetPlatform.macOS &&
    stroke != null &&
    stroke.key == 'k' &&
    stroke.control &&
    !stroke.command &&
    !stroke.alt &&
    !stroke.shift;

const killLineIntent = DeleteToLineBreakIntent(forward: true);
