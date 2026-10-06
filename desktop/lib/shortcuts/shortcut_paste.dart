import 'package:flutter/widgets.dart';

/// A paste whose ⌘V Flutter's keyboard never saw held.
///
/// Dictation tools (Wispr Flow, SuperWhisper), clipboard managers and text
/// expanders paste by posting ⌘V with the Command flag on the key event alone,
/// no Command press before it. Flutter's `HardwareKeyboard` tracks modifiers
/// from those presses, so it reports Command up and the chord is dropped —
/// nothing pastes (flutter/flutter#184571). The macOS runner recognises that
/// shape (`MainFlutterWindow.swift`) and reports `paste` over
/// `harness/app_menu` instead, which lands in [pasteIntoPrimaryFocus].
///
/// Its own intent rather than [PasteTextIntent]: xterm's `TerminalView`
/// answers that one closest to the focus with a text-only paste, skipping the
/// terminal pane's own (images, remote panes, bracketed paste).
class ShortcutPasteIntent extends Intent {
  const ShortcutPasteIntent();
}

/// Pastes into whatever holds keyboard focus, as the physical ⌘V would: a
/// terminal pane through its own paste, any text field through
/// [PasteTextIntent] (with the field's own paste overrides, such as a New
/// Harness box attaching copied files).
void pasteIntoPrimaryFocus() {
  final context = primaryFocus?.context;
  if (context == null) return;
  if (Actions.maybeFind<ShortcutPasteIntent>(context) != null) {
    Actions.invoke(context, const ShortcutPasteIntent());
    return;
  }
  Actions.maybeInvoke(
    context,
    const PasteTextIntent(SelectionChangedCause.keyboard),
  );
}
