import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:xterm/xterm.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/key_hints.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

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
///
/// ⚠️ **The other exception: the pane's own keys — [hints] — join the row, and
/// only then does it scroll.** They are what Codex offers on this screen and
/// nowhere else (`ctrl+] skip`, `⌥+↓ main prompt`), so they follow the arrows
/// on the SAME row, which scrolls sideways while they are there and brings
/// them into view as they arrive. Never a line of their own: a second row
/// cost the terminal a line of output, and a strip of buttons floating over
/// the pane covered the very hints it was read off. The fixed keys keep their
/// size either way — only how far along the row is scrolled changes.
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
    this.hints = const [],
  });

  final Terminal terminal;

  /// An agent's question dialog is on the pane: `/` gives its slot to `⏎` —
  /// see the class docblock.
  final bool questionOpen;

  /// The keys the pane's chrome offers and a phone cannot press — see
  /// [parseKeyHints]. Each is drawn as the key and Codex's own word for what
  /// it does, as the pane printed them, in the terminal's face — so it reads
  /// as the hint it was read off. Empty leaves the row as it always was.
  final List<KeyHint> hints;

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

  /// Presses the chord a hint named, as the pane printed it — nothing else:
  /// what the key does is the CLI's, and it redraws the screen to say so.
  ///
  /// ⚠️ **Armed modifiers are put down, never added.** A hint is already the
  /// whole chord, and a `ctrl` left lit would turn `shift+←` into a key the CLI
  /// never offered — so, like [_sendKey], nothing armed outlives the tap.
  ///
  /// The keyboard's buffer is emptied after it, as after `tab`: these keys move
  /// between a question and the prompt, and the buffer still holds words typed
  /// into the one just left.
  void _sendHint(KeyHint hint) {
    hint.chord.send(widget.terminal);
    widget.onPromptEdited?.call();
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
            child: widget.hints.isEmpty
                ? Row(children: [..._row(keys), ..._rule(), ..._row(apart)])
                : LayoutBuilder(
                    builder: (context, constraints) =>
                        _rowWithHints(keys, apart, constraints.maxWidth),
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

  /// The rule between the keys the pty receives and the two that act on the
  /// phone.
  ///
  /// It earns its place only when there are two kinds of thing to separate.
  /// Against an older CLI the image key is absent and `⌄` is all that is left,
  /// so a rule drawn for it alone would be marking a distinction that is no
  /// longer made.
  List<Widget> _rule() => _canSendImage
      ? [
          const SizedBox(width: 8),
          Container(width: 1, height: 22, color: AppGlass.hair),
          const SizedBox(width: 8),
        ]
      : [const SizedBox(width: 4)];

  /// How wide [_rule] is — `8 + 1 + 8`, or the single gap in its place.
  double get _ruleWidth => _canSendImage ? 17 : 4;

  /// The row while the pane offers its own keys: the fixed keys, then
  /// [TerminalKeyBar.hints], scrolling sideways together; the two apart keys
  /// stay pinned past the rule.
  ///
  /// ⚠️ **Every fixed key keeps exactly the width [_row] gives it.** The cell
  /// is worked out the way the `Expanded` row divides [width] — the same keys,
  /// gaps and rule — so the keys do not shrink or move when a hint arrives:
  /// they fill the visible part of the row as they always do, and the hints
  /// start where it ends. [_revealHints] then scrolls them into view.
  Widget _rowWithHints(List<Widget> keys, List<Widget> apart, double width) {
    const gap = 4.0;
    final gaps =
        gap * (keys.length - 1) + _ruleWidth + gap * (apart.length - 1);
    final cell = (width - gaps) / (keys.length + apart.length);
    if (!cell.isFinite || cell <= 0) {
      return Row(children: [..._row(keys), ..._rule(), ..._row(apart)]);
    }
    final hints = widget.hints;
    return Row(
      children: [
        Expanded(
          child: SingleChildScrollView(
            controller: _scroll,
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                ..._cells(keys, cell),
                // The pane's keys are not the strip's: a hairline says so,
                // the way the rule sets the phone's own two apart.
                const SizedBox(width: 6),
                Container(width: 1, height: 22, color: AppGlass.hair),
                const SizedBox(width: 6),
                for (var i = 0; i < hints.length; i++) ...[
                  if (i > 0) const SizedBox(width: gap),
                  _hint(hints[i]),
                ],
              ],
            ),
          ),
        ),
        ..._rule(),
        ..._cells(apart, cell),
      ],
    );
  }

  /// A run of keys at a fixed [width] each — [_row]'s layout, in a row that
  /// scrolls and so cannot divide itself with `Expanded`.
  List<Widget> _cells(List<Widget> keys, double width) => [
    for (var index = 0; index < keys.length; index++) ...[
      if (index > 0) const SizedBox(width: 4),
      SizedBox(width: width, child: keys[index]),
    ],
  ];

  /// Keeps the fixed keys and the hints on one row.
  final ScrollController _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    // The strip opens with the keyboard, and a pane already offering its keys
    // shows them as it does.
    if (widget.hints.isNotEmpty) _revealHints();
  }

  @override
  void didUpdateWidget(TerminalKeyBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.hints.isNotEmpty && !listEquals(widget.hints, oldWidget.hints)) {
      _revealHints();
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// Scrolls the row to its end, where the hints are, once they are laid out.
  ///
  /// ⚠️ **Brought into view, not left past the edge.** The fixed keys fill the
  /// visible row by design, so hints that simply joined it would start just
  /// out of sight and read as no hints at all. Only a new set of hints moves
  /// the row; the same ones redrawn leave it wherever it was swiped to.
  void _revealHints() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final end = _scroll.position.maxScrollExtent;
      if (_scroll.offset == end) return;
      _scroll.animateTo(
        end,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
    });
  }

  Widget _hint(KeyHint hint) => Semantics(
    button: true,
    label: '${hint.action}, ${hint.keyText}',
    child: _KeyCap(
      hint: hint,
      live: widget.enabled,
      armed: false,
      onTap: () => _send(() => _sendHint(hint)),
    ),
  );

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
    this.label,
    this.icon,
    this.hint,
    required this.live,
    required this.armed,
    required this.onTap,
  }) : assert(
         (label != null ? 1 : 0) +
                 (icon != null ? 1 : 0) +
                 (hint != null ? 1 : 0) ==
             1,
         'a key carries one of the three',
       );

  final String? label;
  final IconData? icon;

  /// One of the pane's own keys — see [TerminalKeyBar.hints]. As wide as its
  /// words, rather than one of the row's equal cells.
  final KeyHint? hint;

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
    final hint = widget.hint;
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
        child: hint != null
            ? _hintFace(hint, foreground: foreground, lit: lit)
            : widget.icon != null
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

  /// A [_KeyCap.hint]'s face: the key as the pane printed it, then the CLI's
  /// word for what it does, quieter — both in the terminal's own face,
  /// followed live, since Settings ▸ Terminal can change it while the row is
  /// up.
  Widget _hintFace(
    KeyHint hint, {
    required Color foreground,
    required bool lit,
  }) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 10),
    child: ValueListenableBuilder<TerminalStyle>(
      valueListenable: terminalFontStore,
      builder: (context, face, _) {
        TextStyle style(Color color, FontWeight weight) => TextStyle(
          fontFamily: face.fontFamily,
          fontFamilyFallback: face.fontFamilyFallback,
          fontSize: 12,
          height: 1,
          color: color,
          fontWeight: weight,
        );
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(hint.keyText, style: style(foreground, FontWeight.w600)),
            const SizedBox(width: 6),
            Text(
              hint.action,
              maxLines: 1,
              style: style(
                lit
                    ? foreground
                    : widget.live
                    ? AppPalette.textSecondary
                    : AppPalette.textFaint,
                FontWeight.w400,
              ),
            ),
          ],
        );
      },
    ),
  );
}
