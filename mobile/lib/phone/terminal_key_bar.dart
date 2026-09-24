import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:xterm/xterm.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_sheet.dart';

/// The keys a phone keyboard does not have, in a strip above the one it does.
///
/// A pane is driven by `esc` and the arrows far more than by anything the
/// alphabet offers — interrupting Claude Code, walking shell history, moving
/// through a menu. None of them exist on a software keyboard, so
/// until this strip a phone could type at an agent but could not DRIVE one.
///
/// It appears with the keyboard and goes away with it: the terminal is short
/// enough on a phone that chrome is worth its height only while someone is
/// actually typing.
///
/// ⚠️ **ONE row, fixed, and nothing scrolls.** It used to be two — `↵`, `⇧tab`,
/// `ctrl` and a row of digits beside what is here now — and the second row cost
/// the terminal a line of output for keys the system keyboard below already
/// types (the digits) or that were rarely reached for. What is left is what a
/// phone keyboard cannot produce, or buries, and a pane is driven by:
///
/// ```
/// esc tab clear ← ↑ ↓ → /  │  🖼 ⌄
/// ```
///
/// Every key stays in the same place every time; this strip is used while
/// looking at the TERMINAL, not at the strip.
///
/// ⚠️ **One exception: `/` becomes `⏎` while an agent is asking something.**
/// A question dialog is driven by the arrows and Enter, and Enter is the one
/// the strip did not have — the keyboard's own `return` sends it, but nothing
/// on screen says so, and on a dialog that reads "enter to submit answer" a
/// strip of every other key it names reads as "Enter is missing". `/` is the
/// slot to give up: a dialog has no prompt to start a command in.
class TerminalKeyBar extends StatefulWidget {
  const TerminalKeyBar({
    super.key,
    required this.terminal,
    required this.enabled,
    required this.onDismissKeyboard,
    this.onPromptEdited,
    this.onPickImage,
    this.onTakePhoto,
    this.questionOpen = false,
  });

  final Terminal terminal;

  /// An agent's question dialog is on the pane: `/` gives its slot to `⏎` —
  /// see the class docblock.
  final bool questionOpen;

  /// Called after `tab` or `/` changed the prompt without the software
  /// keyboard knowing — so its buffer can be emptied before it edits words the
  /// prompt no longer holds.
  final VoidCallback? onPromptEdited;

  /// False while the stream is not accepting input — the strip stays visible
  /// (it moves with the keyboard, and a row that vanished would take the
  /// keyboard's place with it) but dims and stops answering.
  final bool enabled;

  final VoidCallback onDismissKeyboard;

  /// Sending a picture. Null on a pane that cannot take one — an older CLI that
  /// never advertised `terminalImagePasteAvailable` — and the key is then not
  /// drawn at all rather than drawn dead: a key that does nothing is worse than
  /// one that was never offered.
  final VoidCallback? onPickImage;
  final VoidCallback? onTakePhoto;

  @override
  State<TerminalKeyBar> createState() => _TerminalKeyBarState();
}

class _TerminalKeyBarState extends State<TerminalKeyBar> {
  bool get _canSendImage =>
      widget.onPickImage != null || widget.onTakePhoto != null;

  void _send(void Function() action) {
    if (!widget.enabled) return;
    HapticFeedback.selectionClick();
    action();
  }

  /// The image key: asks WHICH picture, then hands off.
  ///
  /// The sheet only appears where there is a choice to make. A build with just
  /// one of the two wired goes straight there instead — a sheet with a single
  /// row is a tap spent on nothing.
  void _sendImage(BuildContext context) {
    final pick = widget.onPickImage;
    final photo = widget.onTakePhoto;
    if (pick == null) {
      photo?.call();
      return;
    }
    if (photo == null) {
      pick();
      return;
    }
    showPhoneSheet(
      context,
      title: 'Send a picture to this harness',
      actions: [
        PhoneSheetAction(
          icon: LucideIcons.image300,
          label: 'Choose from library',
          onTap: pick,
        ),
        PhoneSheetAction(
          icon: LucideIcons.camera300,
          label: 'Take a photo',
          onTap: photo,
        ),
      ],
    );
  }

  /// Armed modifiers, spent by the next key this bar sends.
  ///
  /// ⚠️ **They are the app's own, and they have to be: a software keyboard's
  /// Shift never reaches an app.** Gboard is a separate program that hands over
  /// the RESULT — a character — and keeps its own shift state to itself; there
  /// is no way to ask whether it is held. A hardware keyboard does report
  /// modifiers, which is why this is a phone problem and not a widget.terminal one.
  /// Every widget.terminal app on a phone solves it the same way, with a modifier row
  /// of its own.
  ///
  /// ⚠️ **Sticky, not held.** A thumb cannot hold one key and press another on
  /// a row this size, so `ctrl` is tapped, stays lit, and is spent by the next
  /// keystroke — or tapped again to put it down.
  bool _ctrl = false;
  bool _shift = false;

  void _toggleCtrl() => setState(() => _ctrl = !_ctrl);
  void _toggleShift() => setState(() => _shift = !_shift);

  /// Sends [key] with whatever is armed, and puts the modifiers down.
  ///
  /// ⚠️ Cleared even when nothing was armed: this is the one path every key of
  /// the bar takes, so an armed modifier can never survive a keystroke and land
  /// on the one after it.
  void _sendKey(TerminalKey key, {bool edits = false}) {
    widget.terminal.keyInput(key, ctrl: _ctrl, shift: _shift);
    if (edits) widget.onPromptEdited?.call();
    if (_ctrl || _shift) setState(() => _ctrl = _shift = false);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // What drives an engine and a phone keyboard lacks: leave a mode, walk
    // history, move through a menu.
    final keys = <Widget>[
      _key(label: 'esc', onTap: () => _sendKey(TerminalKey.escape)),
      // Completes a path or a command, and moves through Claude Code's menus.
      _key(label: 'tab', onTap: () => _sendKey(TerminalKey.tab, edits: true)),
      // ⚠️ **The two modifiers stand together, before the keys they modify.**
      // Apart — one here, one at the far end of the row — they read as two
      // unrelated keys that happen to light up, and the pair a thumb reaches
      // for in sequence (`ctrl` then an arrow) crossed the whole strip. Side by
      // side and to the LEFT of the arrows, the row reads in the order it is
      // pressed.
      _key(label: 'shift', armed: _shift, onTap: _toggleShift),
      _key(label: 'ctrl', armed: _ctrl, onTap: _toggleCtrl),
      _key(
        icon: LucideIcons.arrowLeft300,
        semanticLabel: 'Left',
        onTap: () => _sendKey(TerminalKey.arrowLeft),
      ),
      _key(
        icon: LucideIcons.arrowUp300,
        semanticLabel: 'Up',
        onTap: () => _sendKey(TerminalKey.arrowUp),
      ),
      _key(
        icon: LucideIcons.arrowDown300,
        semanticLabel: 'Down',
        onTap: () => _sendKey(TerminalKey.arrowDown),
      ),
      _key(
        icon: LucideIcons.arrowRight300,
        semanticLabel: 'Right',
        onTap: () => _sendKey(TerminalKey.arrowRight),
      ),
      // Last before the rule, and only while an agent's question is open —
      // after the arrows, which is the order a dialog is answered in.
      if (widget.questionOpen)
        _key(
          icon: LucideIcons.cornerDownLeft300,
          semanticLabel: 'Enter',
          // Sent as the key, not as text: the keyboard's buffer holds nothing
          // a dialog cares about, and Return is `\r` to every TUI here.
          onTap: () => _sendKey(TerminalKey.enter),
        ),
    ];
    // ⚠️ **Neither of these sends a byte anywhere**, and that is why they sit
    // apart from the grid rather than in it. Every key to the left of the rule
    // is a keystroke the pty receives; these two act on the PHONE — one opens an
    // OS picker, the other drops the keyboard. Sharing a row taught the eye they
    // were the same kind of thing, and an image button that looks like `esc`
    // reads as something that will be typed at the agent.
    final apart = <Widget>[
      if (_canSendImage)
        _key(
          icon: LucideIcons.image300,
          semanticLabel: 'Send image',
          onTap: () => _sendImage(context),
        ),
      // The way back to a full screen of output, which on a phone is the only
      // way to read one.
      _key(
        icon: LucideIcons.chevronDown300,
        semanticLabel: 'Hide keyboard',
        alwaysEnabled: true,
        onTap: widget.onDismissKeyboard,
      ),
    ];

    return ExcludeFocus(
      // ⚠️ Load-bearing. Every key here is a tap target inside a focus scope the
      // TERMINAL owns: a focusable one would take the focus on tap, the input
      // connection would close, and the keyboard this strip is attached to
      // would leave with it on the first `esc`.
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppPalette.panelBg,
          border: Border(top: BorderSide(color: AppGlass.hair)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(6),
          // Held out of the app-wide text scale like the composer's own type:
          // at a large scale the keys stop fitting the row.
          child: MediaQuery.withNoTextScaling(
            // Every key the same width, the two apart ones included — they are
            // separated by the rule, not by being a different size.
            child: Row(
              children: [
                ..._row(keys),
                // The rule earns its place only when there are two kinds of
                // thing to separate. Against an older CLI the image key is
                // absent and `⌄` is all that is left, so a rule drawn for it
                // alone would be marking a distinction that is no longer made.
                if (_canSendImage) ...[
                  const SizedBox(width: 8),
                  Container(width: 1, height: 22, color: AppGlass.hair),
                  const SizedBox(width: 8),
                ] else
                  const SizedBox(width: 4),
                ..._row(apart),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// A run of keys for the strip's one [Row], each `Expanded` with the same
  /// flex — so every key on the strip, on either side of the rule, gets the
  /// same width, and the row fills the phone rather than ending in a gap.
  List<Widget> _row(List<Widget> keys) => [
    for (var index = 0; index < keys.length; index++) ...[
      if (index > 0) const SizedBox(width: 4),
      Expanded(child: keys[index]),
    ],
  ];

  Widget _key({
    String? label,
    IconData? icon,
    String? semanticLabel,
    bool alwaysEnabled = false,
    bool armed = false,
    required VoidCallback onTap,
  }) {
    assert((label == null) != (icon == null), 'a key carries one of the two');
    final live = widget.enabled || alwaysEnabled;
    return Semantics(
      button: true,
      label: semanticLabel ?? label,
      // Named so a test can reach the icon keys, which carry no text.
      key: ValueKey('terminal-key-${semanticLabel ?? label}'),
      child: _KeyCap(
        label: label,
        icon: icon,
        live: live,
        armed: armed,
        onTap: alwaysEnabled ? onTap : () => _send(onTap),
      ),
    );
  }
}

/// One key of the bar, lit while a thumb is on it.
///
/// ⚠️ **The lift is not decoration: this row had no press state at all.** Every
/// other control on the phone answers a touch — a card sinks, a row fills — and
/// these keys did nothing, so the only proof a tap had landed was whatever the
/// agent did about it a moment later. On `esc` in a menu, or an arrow walking
/// history, that moment is long enough to tap again and overshoot.
///
/// ⚠️ Held from the DOWN, released on up or cancel. A key that lit on the way
/// up would light after the work was already done, which is the one moment the
/// feedback is worth nothing.
class _KeyCap extends StatefulWidget {
  const _KeyCap({
    required this.label,
    required this.icon,
    required this.live,
    required this.armed,
    required this.onTap,
  });

  final String? label;
  final IconData? icon;
  final bool live;

  /// A modifier that is DOWN, waiting for the key it belongs to.
  ///
  /// ⚠️ Drawn like a press that has not been let go, because that is what it
  /// is — the same lift a thumb makes, held. A modifier with its own look would
  /// be a third state to learn for a row of eight keys.
  final bool armed;
  final VoidCallback onTap;

  @override
  State<_KeyCap> createState() => _KeyCapState();
}

class _KeyCapState extends State<_KeyCap> {
  bool _down = false;

  void _set(bool down) {
    if (_down == down || !mounted) return;
    setState(() => _down = down);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final lit = (_down || widget.armed) && widget.live;
    final foreground = lit
        ? AppPalette.accentOnSurface
        : widget.live
        ? AppPalette.textPrimary
        : AppPalette.textFaint;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      // ⚠️ The tap still fires from `onTap`, not from these: a finger that
      // slides off the key must light it and then leave without sending
      // anything, which is what `onTapCancel` is for.
      onTapDown: (_) => _set(true),
      onTapUp: (_) => _set(false),
      onTapCancel: () => _set(false),
      onTap: widget.onTap,
      child: AnimatedContainer(
        // Quick enough to read as the key answering the finger rather than
        // fading after it.
        duration: const Duration(milliseconds: 90),
        curve: Curves.easeOut,
        height: 34,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: lit
              ? AppPalette.accent.withValues(alpha: 0.24)
              : AppGlass.surfaceFill,
          borderRadius: BorderRadius.circular(7),
          border: Border.all(
            color: lit ? AppPalette.accentOnSurface : AppGlass.lift,
          ),
        ),
        child: widget.icon != null
            ? Icon(widget.icon, size: 16, color: foreground)
            // Shrinks rather than clips: ten keys share a phone's width, and
            // `clear` is the widest word among them.
            : Padding(
                padding: const EdgeInsets.symmetric(horizontal: 3),
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(
                    widget.label!,
                    maxLines: 1,
                    style: TextStyle(
                      fontSize: 13,
                      height: 1,
                      color: foreground,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ),
      ),
    );
  }
}
