import 'dart:async';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:xterm/xterm.dart';

import 'package:harness_mobile/clipboard/native_clipboard.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/key_hints.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import 'phone_sheet.dart';
import 'tty.dart';

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
/// esc ^C tab clear paste ⇧ ctrl ← ↑ ↓ →  │  img ▾
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
/// nowhere else (`shift+← to answer`, `ctrl+] skip`, `⌥+↓ main prompt`), so
/// they LEAD the same row and push the fixed keys along it, and the row
/// scrolls sideways while they are there. At the head, not the tail: past a
/// row the fixed keys already fill, a queued question's `shift+← answer` sat
/// off the edge with nothing on screen to say it was there. Claude Code's
/// `shift+tab to cycle` is the one that follows the arrows instead — see
/// [KeyHint.trails]. Never a line of their own: a second row cost the terminal
/// a line of output, and a strip of buttons floating over the pane covered the
/// very hints it was read off. The fixed keys keep their size either way —
/// only where along the row they sit changes.
class TerminalKeyBar extends StatefulWidget {
  const TerminalKeyBar({
    super.key,
    required this.terminal,
    required this.enabled,
    required this.onDismissKeyboard,
    this.onPromptEdited,
    this.onClearPrompt,
    this.onPaste,
    this.onPickImage,
    this.onTakePhoto,
    this.questionOpen = false,
    this.hints = const [],
    this.ctrlArmed,
    this.onArmCtrl,
  });

  final Terminal terminal;

  /// `ctrl` as the SESSION holds it, so an armed `ctrl` is spent by the next letter typed on the
  /// phone's own keyboard too (`TerminalSession.armControl`), not only by this row's keys. Null
  /// keeps the modifier on the row alone.
  final bool? ctrlArmed;
  final ValueChanged<bool>? onArmCtrl;

  /// An agent's question dialog is on the pane: `/` gives its slot to `⏎` —
  /// see the class docblock.
  final bool questionOpen;

  /// The keys the pane's chrome offers and a phone cannot press — see
  /// [parseKeyHints]. Each is drawn as the key and Codex's own word for what
  /// it does, as the pane printed them, in the terminal's face — so it reads
  /// as the hint it was read off. Drawn before the row's own keys, but for the
  /// [KeyHint.trails] ones, after them. Empty leaves the row as it always was.
  final List<KeyHint> hints;

  /// Called after `tab` or `/` changed the prompt without the software
  /// keyboard knowing — so its buffer can be emptied before it edits words the
  /// prompt no longer holds.
  final VoidCallback? onPromptEdited;

  /// `clear`: empties the prompt being typed into. Null leaves the key out.
  final VoidCallback? onClearPrompt;

  /// `paste`: the phone's clipboard into the prompt, its image as well as its
  /// text. Null leaves the key out; so does a clipboard with nothing on it —
  /// the one key on the strip that comes and goes.
  final VoidCallback? onPaste;

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

class _TerminalKeyBarState extends State<TerminalKeyBar>
    with WidgetsBindingObserver {
  bool get _canSendImage =>
      widget.onPickImage != null || widget.onTakePhoto != null;

  /// Whether the phone's clipboard holds anything `paste` would send: text,
  /// or an image where this pane takes one. The key is drawn only then — a
  /// `paste` that answers "nothing on the clipboard" is a key that did
  /// nothing.
  bool _clipboardFull = false;
  bool _clipboardChecking = false;

  /// Asks again every [_clipboardEvery] while the strip is up. Neither phone
  /// says when its clipboard changes, and it does change under the strip: a
  /// reply copied off the pane, text copied in another app over this one.
  Timer? _clipboardPoll;
  static const _clipboardEvery = Duration(seconds: 1);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _watchClipboard();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from another app — where the copy usually happened.
    if (state == AppLifecycleState.resumed) unawaited(_checkClipboard());
  }

  /// Starts asking about the clipboard while there is a `paste` to show, and
  /// stops when there is not.
  void _watchClipboard() {
    if (widget.onPaste == null) {
      _clipboardPoll?.cancel();
      _clipboardPoll = null;
      return;
    }
    _clipboardPoll ??= Timer.periodic(
      _clipboardEvery,
      (_) => unawaited(_checkClipboard()),
    );
    unawaited(_checkClipboard());
  }

  /// ⚠️ **Asked, never read.** [Clipboard.hasStrings] and
  /// [NativeClipboard.hasImage] answer without iOS's "Allow Paste" prompt or
  /// Android's "pasted from your clipboard" toast; reading the clipboard every
  /// second would bring up one or the other each time.
  Future<void> _checkClipboard() async {
    if (_clipboardChecking || widget.onPaste == null) return;
    // Only while the app is in front: Android hands an app in the background
    // no clipboard at all, and the key would go away for nothing.
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (lifecycle != null && lifecycle != AppLifecycleState.resumed) return;
    _clipboardChecking = true;
    try {
      var full = await Clipboard.hasStrings();
      if (!full && _canSendImage) full = await NativeClipboard.hasImage();
      if (mounted && full != _clipboardFull) {
        setState(() => _clipboardFull = full);
      }
    } on PlatformException {
      // No answer: the key stays as it was rather than flickering.
    } finally {
      _clipboardChecking = false;
    }
  }

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

  bool get _ctrlLit => widget.ctrlArmed ?? _ctrl;

  void _toggleCtrl() {
    if (widget.onArmCtrl case final arm?) {
      arm(!_ctrlLit);
      return;
    }
    setState(() => _ctrl = !_ctrl);
  }

  /// Puts both modifiers down — the session's `ctrl` too.
  void _disarm() {
    if (_ctrlLit) widget.onArmCtrl?.call(false);
    if (_ctrl || _shift) setState(() => _ctrl = _shift = false);
  }

  void _toggleShift() => setState(() => _shift = !_shift);

  /// Sends [key] with whatever is armed, and puts the modifiers down.
  ///
  /// ⚠️ Cleared even when nothing was armed: this is the one path every key of
  /// the bar takes, so an armed modifier can never survive a keystroke and land
  /// on the one after it.
  void _sendKey(TerminalKey key, {bool edits = false}) {
    final ctrl = _ctrlLit, shift = _shift;
    _disarm();
    widget.terminal.keyInput(key, ctrl: ctrl, shift: shift);
    if (edits) widget.onPromptEdited?.call();
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
    _disarm();
    hint.chord.send(widget.terminal);
    widget.onPromptEdited?.call();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // What drives an engine and a phone keyboard lacks: leave a mode, walk
    // history, move through a menu.
    final keys = <_Slot>[
      _key(label: 'esc', onTap: () => _sendKey(TerminalKey.escape)),
      // The other key a terminal person reaches for without looking: stop, now.
      _key(
        label: '^C',
        semanticLabel: 'Control C',
        onTap: () {
          _disarm();
          widget.terminal.keyInput(TerminalKey.keyC, ctrl: true);
        },
      ),
      // Completes a path or a command, and moves through Claude Code's menus.
      _key(label: 'tab', onTap: () => _sendKey(TerminalKey.tab, edits: true)),
      // Empties what is typed: Ctrl+K, then Ctrl+U — not Ctrl+C, which on an
      // empty Claude Code prompt is the first half of quitting. See
      // `TerminalSession.clearPrompt`.
      if (widget.onClearPrompt case final clear?)
        _key(
          label: 'clear',
          semanticLabel: 'Clear prompt',
          wide: true,
          onTap: () {
            _disarm();
            clear();
          },
        ),
      // The phone's clipboard, text or image — iOS's keyboard has no paste
      // key. Beside `clear`: the two edit what is typed as a whole. Only while
      // the clipboard holds something to paste — see [_clipboardFull].
      if (widget.onPaste case final paste? when _clipboardFull)
        _key(
          label: 'paste',
          semanticLabel: 'Paste',
          wide: true,
          onTap: () {
            _disarm();
            paste();
            widget.onPromptEdited?.call();
          },
        ),
      // ⚠️ **The two modifiers stand together, before the keys they modify.**
      // Apart — one here, one at the far end of the row — they read as two
      // unrelated keys that happen to light up, and the pair a thumb reaches
      // for in sequence (`ctrl` then an arrow) crossed the whole strip. Side by
      // side and to the LEFT of the arrows, the row reads in the order it is
      // pressed.
      // The keyboard's own mark, so it fits a key at the size of the others.
      _key(
        label: '⇧',
        semanticLabel: 'shift',
        armed: _shift,
        onTap: _toggleShift,
      ),
      // `ctrl` in words: `⌃` reads as an up arrow beside the arrows.
      _key(label: 'ctrl', armed: _ctrlLit, onTap: _toggleCtrl),
      _key(
        label: '←',
        semanticLabel: 'Left',
        onTap: () => _sendKey(TerminalKey.arrowLeft),
      ),
      _key(
        label: '↑',
        semanticLabel: 'Up',
        onTap: () => _sendKey(TerminalKey.arrowUp),
      ),
      _key(
        label: '↓',
        semanticLabel: 'Down',
        onTap: () => _sendKey(TerminalKey.arrowDown),
      ),
      _key(
        label: '→',
        semanticLabel: 'Right',
        onTap: () => _sendKey(TerminalKey.arrowRight),
      ),
      // Last before the rule, and only while an agent's question is open —
      // after the arrows, which is the order a dialog is answered in.
      if (widget.questionOpen)
        _key(
          label: '⏎',
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
    final apart = <_Slot>[
      if (_canSendImage)
        _key(
          label: 'img',
          semanticLabel: 'Send image',
          onTap: () => _sendImage(context),
        ),
      // The way back to a full screen of output, which on a phone is the only
      // way to read one.
      _key(
        label: '▾',
        semanticLabel: 'Hide keyboard',
        // ⚠️ `▾` is a SMALL triangle: at the row's size it read as a speck in
        // the corner, on the key reached for most after typing.
        scale: 1.6,
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
          color: Tty.of(context).ground,
          border: Border(top: BorderSide(color: Tty.of(context).dim)),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
          // Held out of the app-wide text scale like the composer's own type:
          // at a large scale the keys stop fitting the row.
          child: MediaQuery.withNoTextScaling(
            // Every key the same width, the two apart ones included — they are
            // separated by the rule, not by being a different size. Only the
            // two five-letter words are wider: see [_wideParts].
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

  /// How many parts of the row a key takes: [_keyParts] for most,
  /// [_wideParts] for `clear` and `paste`.
  ///
  /// ⚠️ **A word as long as `clear` in a cell sized for `esc` is shrunk to half
  /// the size of the rest of the row.** The label scales down to fit rather
  /// than clip, so the two words came out a size nobody could read. Five parts
  /// to three gives them the room of the letters they have, and the row
  /// reads at one size.
  static const _keyParts = 3;
  static const _wideParts = 5;

  /// A run of keys for the strip's one [Row], each `Expanded` with its
  /// [_Slot.parts] as the flex — so every key on the strip, on either side of
  /// the rule, gets the same width but the wide two, and the row fills the
  /// phone rather than ending in a gap.
  List<Widget> _row(List<_Slot> keys) => [
    for (var index = 0; index < keys.length; index++) ...[
      if (index > 0) const SizedBox(width: 4),
      Expanded(flex: keys[index].parts, child: keys[index].key),
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

  /// The row while the pane offers its own keys: [TerminalKeyBar.hints] at its
  /// head, the fixed keys, then the [KeyHint.trails] ones, scrolling sideways
  /// together; the two apart keys stay pinned past the rule.
  ///
  /// ⚠️ **Every fixed key keeps exactly the width [_row] gives it.** The part
  /// is worked out the way the `Expanded` row divides [width] — the same keys,
  /// gaps and rule — so the keys do not shrink when a hint arrives: the hints
  /// at the head push them along, and the ones at the tail start where the
  /// visible part of the row ends. [_revealHints] scrolls to whichever arrived.
  Widget _rowWithHints(List<_Slot> keys, List<_Slot> apart, double width) {
    const gap = 4.0;
    final gaps =
        gap * (keys.length - 1) + _ruleWidth + gap * (apart.length - 1);
    final parts = [
      ...keys,
      ...apart,
    ].fold<int>(0, (sum, key) => sum + key.parts);
    final part = (width - gaps) / parts;
    if (!part.isFinite || part <= 0) {
      return Row(children: [..._row(keys), ..._rule(), ..._row(apart)]);
    }
    final (:lead, :trail) = _split(widget.hints);
    return Row(
      children: [
        Expanded(
          child: SingleChildScrollView(
            controller: _scroll,
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                if (lead.isNotEmpty) ...[..._hintRun(lead), ..._hintRule()],
                ..._cells(keys, part),
                if (trail.isNotEmpty) ...[..._hintRule(), ..._hintRun(trail)],
              ],
            ),
          ),
        ),
        ..._rule(),
        ..._cells(apart, part),
      ],
    );
  }

  /// [hints] by where the row draws them: before its own keys, and after —
  /// see [KeyHint.trails]. Each side keeps the order the pane printed them in.
  static ({List<KeyHint> lead, List<KeyHint> trail}) _split(
    List<KeyHint> hints,
  ) => (
    lead: [
      for (final hint in hints)
        if (!hint.trails) hint,
    ],
    trail: [
      for (final hint in hints)
        if (hint.trails) hint,
    ],
  );

  /// A run of the pane's keys, each as wide as its words.
  List<Widget> _hintRun(List<KeyHint> hints) => [
    for (var i = 0; i < hints.length; i++) ...[
      if (i > 0) const SizedBox(width: 4),
      _hint(hints[i]),
    ],
  ];

  /// The pane's keys are not the strip's: a hairline between them says so,
  /// the way [_rule] sets the phone's own two apart.
  List<Widget> _hintRule() => [
    const SizedBox(width: 6),
    Container(width: 1, height: 22, color: AppGlass.hair),
    const SizedBox(width: 6),
  ];

  /// A run of keys at a fixed width each, [part] times its [_Slot.parts] —
  /// [_row]'s layout, in a row that scrolls and so cannot divide itself with
  /// `Expanded`.
  List<Widget> _cells(List<_Slot> keys, double part) => [
    for (var index = 0; index < keys.length; index++) ...[
      if (index > 0) const SizedBox(width: 4),
      SizedBox(width: part * keys[index].parts, child: keys[index].key),
    ],
  ];

  /// Keeps the fixed keys and the hints on one row.
  final ScrollController _scroll = ScrollController();

  // ⚠️ **Not scrolled as the strip opens.** It was — to the end, where every
  // hint then sat — and Claude Code offers `shift+tab to cycle` on every prompt,
  // so every open slid esc and tab off the left edge while the pane's own line
  // said "esc to interrupt". It opens at its head, which is where a question's
  // keys are drawn ([KeyHint.trails]); `cycle` is a sideways swipe away. Hints
  // that ARRIVE while it is open are scrolled to, wherever they are drawn.

  @override
  void didUpdateWidget(TerminalKeyBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.hints.isNotEmpty && !listEquals(widget.hints, oldWidget.hints)) {
      final now = _split(widget.hints), before = _split(oldWidget.hints);
      if (now.lead.isNotEmpty && !listEquals(now.lead, before.lead)) {
        _revealHints(atHead: true);
      } else if (now.lead.isEmpty &&
          now.trail.isNotEmpty &&
          !listEquals(now.trail, before.trail)) {
        // ⚠️ Never away from a question's keys: with one at the head, a
        // `cycle` arriving at the tail stays a swipe away.
        _revealHints(atHead: false);
      }
    }
    // `paste` came or went, or an image stopped (or started) counting.
    final couldSendImage =
        oldWidget.onPickImage != null || oldWidget.onTakePhoto != null;
    if ((widget.onPaste == null) != (oldWidget.onPaste == null) ||
        _canSendImage != couldSendImage) {
      _watchClipboard();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _clipboardPoll?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  /// Scrolls the row to the hints that just arrived, once they are laid out:
  /// back to its head for the ones that lead it, on to its end for the ones
  /// that trail it.
  ///
  /// ⚠️ **Brought into view, not left past the edge.** The fixed keys fill the
  /// visible row by design, so hints at its end would start just out of sight
  /// and read as no hints at all — and a row already swiped along would leave
  /// a new one at its head out of sight the same way. Only a new set of hints
  /// moves the row; the same ones redrawn leave it wherever it was swiped to.
  void _revealHints({required bool atHead}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final position = _scroll.position;
      final target = atHead
          ? position.minScrollExtent
          : position.maxScrollExtent;
      if (position.pixels == target) return;
      _scroll.animateTo(
        target,
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

  _Slot _key({
    String? label,
    IconData? icon,
    String? semanticLabel,
    bool alwaysEnabled = false,
    bool armed = false,
    bool wide = false,
    double scale = 1,
    required VoidCallback onTap,
  }) {
    assert((label == null) != (icon == null), 'a key carries one of the two');
    final live = widget.enabled || alwaysEnabled;
    return (
      key: Semantics(
        button: true,
        label: semanticLabel ?? label,
        // Named so a test can reach the icon keys, which carry no text.
        key: ValueKey('terminal-key-${semanticLabel ?? label}'),
        child: _KeyCap(
          label: label,
          icon: icon,
          scale: scale,
          live: live,
          armed: armed,
          onTap: alwaysEnabled ? onTap : () => _send(onTap),
        ),
      ),
      parts: wide ? _wideParts : _keyParts,
    );
  }
}

/// One key of the strip, and how many parts of the row it takes — see
/// [_TerminalKeyBarState._wideParts].
typedef _Slot = ({Widget key, int parts});

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
    this.scale = 1,
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

  /// The [label]'s size against the terminal's — for a glyph drawn small by
  /// its font. Still shrinks to fit the key, like every label.
  final double scale;

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
    final tty = Tty.of(context);
    final hint = widget.hint;
    // A terminal's keys: plain words and the font's own arrows, no caps. Armed (ctrl, shift) is
    // reverse video, as a terminal marks a mode; pressed is fzf's selection ground, on the way
    // down — no fade.
    final armed = widget.armed && widget.live;
    final pressed = _down && widget.live;
    final foreground = armed
        ? tty.ground
        : widget.live
        ? tty.text
        : tty.dim;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      // ⚠️ The tap still fires from `onTap`, not from these: a finger that
      // slides off the key must light it and then leave without sending
      // anything, which is what `onTapCancel` is for.
      onTapDown: (_) => _set(true),
      onTapUp: (_) => _set(false),
      onTapCancel: () => _set(false),
      onTap: widget.onTap,
      child: Container(
        height: 40,
        alignment: Alignment.center,
        color: armed
            ? tty.text
            : pressed
            ? tty.selected
            : Colors.transparent,
        child: hint != null
            ? _hintFace(hint, foreground: foreground, lit: armed || pressed)
            // Shrinks rather than clips: ten keys share a phone's width.
            : Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2),
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(
                    widget.label ?? '',
                    maxLines: 1,
                    style: tty.style(
                      color: foreground,
                      size: tty.fontSize * widget.scale,
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
