import 'package:flutter/widgets.dart';

import '../widgets/terminal_edit_actions.dart';

/// Pastes into whatever holds keyboard focus, as the physical ⌘V would: a
/// terminal pane through its own paste (images, remote panes, bracketed
/// paste), any text field through [PasteTextIntent] (with the field's own
/// paste overrides, such as a New Harness box attaching copied files).
///
/// For a ⌘V Flutter's keyboard never saw held. Dictation tools (Wispr Flow,
/// SuperWhisper), Raycast snippets and text expanders paste by posting ⌘V
/// with the Command flag on the key event alone, no Command press before it.
/// Flutter's `HardwareKeyboard` tracks modifiers from those presses, so it
/// reports Command up and the chord is dropped (flutter/flutter#184571). The
/// macOS runner recognises that shape (`MainFlutterWindow.swift`) and reports
/// `paste` over `harness/app_menu` instead.
void pasteIntoPrimaryFocus() {
  final focus = primaryFocus;
  final context = focus?.context;
  if (context == null) return;
  final terminal = TerminalEditActions.forFocus(focus);
  if (terminal != null) {
    terminal.paste();
    return;
  }
  Actions.maybeInvoke(
    context,
    const PasteTextIntent(SelectionChangedCause.keyboard),
  );
}
