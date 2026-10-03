import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';

const double kTerminalCornerRadius = 3;

/// A stable rim for the terminal pane, independent of the desktop dialog frame.
BorderSide terminalPaneBorder({bool focused = false, bool remote = false}) =>
    BorderSide(
      color: !focused
          ? grid.AppPalette.divider
          : remote
          ? grid.AppPalette.remotePaneFocus
          : grid.AppPalette.accentOnSurface,
      width: 1,
    );

/// One gutter around the workspace, between panes, and beside command docks.
const double kWorkspaceInset = 9.5;

/// How solid the workspace's panes paint their own fill: below 1 while the
/// background shows through them (any Background but Blank). Only fills turn
/// translucent — text, colored cells, banners and the composer stay solid.
class PaneOpacity extends InheritedWidget {
  const PaneOpacity({super.key, required this.opacity, required super.child});
  final double opacity;

  /// 1 outside a workspace that set one.
  static double of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PaneOpacity>()?.opacity ?? 1;

  /// [color] at the pane opacity.
  static Color fill(BuildContext context, Color color) {
    final opacity = of(context);
    return opacity >= 1 ? color : color.withValues(alpha: color.a * opacity);
  }

  @override
  bool updateShouldNotify(PaneOpacity old) => old.opacity != opacity;
}

/// A desktop tab joins its workspace through two outward lower shoulders.
/// AppKit mirrors these geometry tokens in SwarmTitlebar.swift.
class DesktopTabBorder extends ShapeBorder {
  const DesktopTabBorder({
    this.radius = grid.AppDesktop.tabRadius,
    this.shoulder = grid.AppDesktop.tabShoulder,
    this.side = BorderSide.none,
  });
  final double radius;
  final double shoulder;
  final BorderSide side;

  @override
  EdgeInsetsGeometry get dimensions => EdgeInsets.zero;

  @override
  ShapeBorder scale(double t) => DesktopTabBorder(
    radius: radius * t,
    shoulder: shoulder * t,
    side: side.scale(t),
  );

  @override
  Path getOuterPath(Rect rect, {TextDirection? textDirection}) {
    final r = radius.clamp(0.0, rect.shortestSide / 2);
    final s = shoulder.clamp(0.0, rect.shortestSide / 2);
    final c = r * .5522847498;
    final sc = s * .5522847498;
    final left = rect.left + s, right = rect.right - s;
    final top = rect.top, bottom = rect.bottom;
    return Path()
      ..moveTo(rect.left, bottom)
      ..cubicTo(rect.left + sc, bottom, left, bottom - s + sc, left, bottom - s)
      ..lineTo(left, top + r)
      ..cubicTo(left, top + r - c, left + r - c, top, left + r, top)
      ..lineTo(right - r, top)
      ..cubicTo(right - r + c, top, right, top + r - c, right, top + r)
      ..lineTo(right, bottom - s)
      ..cubicTo(
        right,
        bottom - s + sc,
        rect.right - sc,
        bottom,
        rect.right,
        bottom,
      )
      ..close();
  }

  @override
  Path getInnerPath(Rect rect, {TextDirection? textDirection}) =>
      getOuterPath(rect, textDirection: textDirection);

  @override
  void paint(Canvas canvas, Rect rect, {TextDirection? textDirection}) {
    if (side.style == BorderStyle.none) return;
    canvas.drawPath(
      getOuterPath(rect.deflate(side.width / 2), textDirection: textDirection),
      side.toPaint(),
    );
  }
}

/// Box ink at [alpha] for rims, hairlines and washes: white on a dark palette,
/// the palette's own ink on a light one.
Color boxInk(double alpha) {
  final palette = grid.AppTheme.palette.value;
  return palette.isDark
      ? Colors.white.withValues(alpha: alpha)
      : palette.foreground.withValues(alpha: alpha);
}

/// Box ink at [alpha] for text and icons. White at 54% is 5.4:1 on Graphite's
/// workspace, but the same share of near-black is only 3.4:1 on Paper's, so a
/// light palette never drops below 68% (4.9:1 on its darkest field).
Color boxText(double alpha) =>
    boxInk(grid.AppTheme.palette.value.isDark || alpha > .68 ? alpha : .68);

/// Error text in a box: the pale orange reads on a dark field and vanishes on
/// a light one.
Color get boxErrorText =>
    grid.AppTheme.pick(grid.AppPalette.dangerFill, Colors.orangeAccent);

/// Fixed UI typography for shared dialogs. Setup screens opt into the
/// terminal's size explicitly so zoom does not resize unrelated controls.
TextStyle boxMonoStyle({Color? color, FontWeight? weight, double? height}) =>
    grid.AppType.mono(
      height: height ?? 1.35,
      color: color ?? boxText(1),
      fontWeight: weight,
    );

class TerminalBox extends StatelessWidget {
  const TerminalBox({super.key, required this.child, this.docked = false});
  final Widget child;
  final bool docked;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: terminalFontStore,
      builder: (context, _) => Material(
        elevation: 0,
        color: grid.AppPalette.swarmField,
        surfaceTintColor: Colors.transparent,
        shape: docked
            ? Border(top: BorderSide(color: boxInk(.24)))
            : RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(kTerminalCornerRadius),
                side: BorderSide(color: boxInk(.24)),
              ),
        clipBehavior: Clip.antiAlias,
        child: DefaultTextStyle.merge(style: boxMonoStyle(), child: child),
      ),
    );
  }
}

/// A compact text row that grows with the user's accessibility text size.
double boxRowHeight(TextScaler scale) =>
    (scale.scale(grid.AppType.monoSize) * 1.35 + 8).clamp(26, double.infinity);

/// Key hints, shortcut glyphs and counts: the box's meta line.
Color get kBoxFaint => boxText(.54);
TextStyle get kBoxFaintStyle => grid.AppType.monoMeta(color: kBoxFaint);

/// Linux spells its chords out (`spellsModifierKeys`); the box prints them in
/// its own lower-case, dash-joined form, as it does a Mac's glyphs.
String _unspelled(String hint) =>
    kIsWeb || defaultTargetPlatform != TargetPlatform.linux
    ? hint
    : hint
          .replaceAll('Ctrl+', 'ctrl-')
          .replaceAll('Alt+', 'alt-')
          .replaceAll('Shift+', 'shift-')
          .replaceAll('Super+', 'super-');

/// Keep the user's actual binding, printed like a terminal's local key guide.
String boxKeyLabel(String hint) =>
    _unspelled(hint)
        .replaceAll('⌃', 'ctrl-')
        .replaceAll('⌥', 'alt-')
        .replaceAll('⇧', 'shift-')
        .replaceAll('⌘', 'cmd-')
        .replaceAll('↵', 'enter')
        .replaceAll('⇥', 'tab')
        .replaceAll('Esc', 'esc');

/// The highlighted row: a bar at its left edge, fzf's `▌`, with a fill you can
/// see. A 5% wash on its own was about 1.15:1 — the keyboard's whole position
/// on screen, nearly invisible.
class BoxRowHighlight extends StatelessWidget {
  const BoxRowHighlight({
    super.key,
    required this.highlighted,
    required this.accent,
    required this.child,
    this.terminal = false,
  });
  final bool highlighted;
  final Color accent;
  final Widget child;
  final bool terminal;

  // A Material, not a coloured box: a ListTile paints its ink on the nearest
  // Material, and a plain fill between the two hides it (Flutter asserts so).
  @override
  Widget build(BuildContext context) {
    return Material(
      animationDuration: Duration.zero,
      color: highlighted ? boxInk(.10) : Colors.transparent,
      borderRadius: BorderRadius.circular(terminal ? 0 : 6),
      // No clip: nothing in a row overflows it, and an antialiased rounded clip
      // per row was paid again on every arrow key.
      child: Stack(
        children: [
          child,
          if (highlighted && !terminal)
            Positioned(
              left: 0,
              top: 7,
              bottom: 7,
              child: Container(
                width: 3,
                decoration: BoxDecoration(
                  color: accent,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// One entry of the bottom line: the key, what it does, and — because a key
/// nobody told you about is a key you never press, and not everybody has the
/// keys yet — a click that does the same thing.
@immutable
class BoxHint {
  const BoxHint(this.keys, this.label, {this.onTap, this.reserveLabel});
  final String keys, label;
  final VoidCallback? onTap;

  /// Keep a changing action from wrapping the guide and shifting its prompt.
  final String? reserveLabel;
}

/// The box's bottom line. Errors keep the available keys underneath them, so
/// recovery stays discoverable. An in-flight request shows only its status.
class BoxHintStrip extends StatelessWidget {
  const BoxHintStrip({
    super.key,
    required this.hints,
    this.message,
    this.isError = false,
    this.busy = false,
  });
  final List<BoxHint> hints;
  final String? message;
  final bool isError, busy;

  double _reservedWidth(BuildContext context, BoxHint hint) {
    if (hint.reserveLabel == null) return 0;
    final measure = TextPainter(
      text: TextSpan(
        text: '${boxKeyLabel(hint.keys)}  ${hint.reserveLabel}',
        style: DefaultTextStyle.of(context).style.merge(kBoxFaintStyle),
      ),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = measure.width;
    measure.dispose();
    return width;
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    Widget? notice;
    if (message case final message?) {
      notice = Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 7),
        child: Semantics(
          liveRegion: true,
          child: Row(
            children: [
              if (busy) ...[
                const SizedBox.square(
                  dimension: 11,
                  child: CircularProgressIndicator(strokeWidth: 1.5),
                ),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: SelectableText(
                  message,
                  maxLines: 3,
                  minLines: 1,
                  style: boxMonoStyle(
                    color: isError ? boxErrorText : boxText(.70),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }
    // Every available key stays in view. A horizontal scroll hid Escape and
    // advanced options exactly when larger text made them most useful.
    final guide = Wrap(
      children: [
        for (final hint in hints)
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: Semantics(
              button: hint.onTap != null,
              label: '${hint.label}, ${hint.keys}',
              excludeSemantics: true,
              child: InkWell(
                borderRadius: BorderRadius.circular(5),
                onTap: hint.onTap,
                child: Padding(
                  // Keep a useful pointer target even at the smallest font setting.
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 7,
                  ),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      minWidth: _reservedWidth(context, hint),
                    ),
                    child: Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: boxKeyLabel(hint.keys),
                            style: TextStyle(color: boxText(.70)),
                          ),
                          TextSpan(text: '  ${hint.label}'),
                        ],
                      ),
                      style: kBoxFaintStyle,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
    return Container(
      constraints: const BoxConstraints(minHeight: 32),
      alignment: Alignment.centerLeft,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: boxInk(.08))),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [?notice, if (!busy || notice == null) guide],
      ),
    );
  }
}

/// Says the highlighted row or current message to a screen reader. Focus stays in the input while
/// the arrows move a highlight the reader never visits, so without this the
/// list is silent. Coalesced: holding an arrow announces where it stopped.
class BoxAnnouncer {
  String? _last;
  // Clearing the message lets the same error be announced on a later attempt.
  void row(BuildContext context, String? text) {
    if (text == _last) return;
    _last = text;
    if (text == null) return;
    SemanticsService.sendAnnouncement(
      View.of(context),
      text,
      Directionality.of(context),
    );
  }
}

/// A row follows the pointer only when the pointer MOVED. `onEnter` also fires
/// when rows appear or scroll under a parked pointer — the box opening, the
/// list revealing the keyboard's selection — and that stole the highlight from
/// the keyboard with nobody touching the mouse.
class BoxPointerGate {
  Offset? _last;
  bool moved(PointerEvent event) {
    final was = _last;
    _last = event.position;
    return was != null && (was - event.position).distanceSquared > 1;
  }
}

/// readline in the box's line. macOS gives a text field ⌃A ⌃E ⌃F ⌃B and ⌥←/→;
/// the kill keys were nobody's, and they are the ones a shell's fingers reach
/// for: ⌃W (word — stopping at `/`, as a path wants), ⌃U (to this line's start),
/// ⌃H and ⌃D (a character each way), ⌃Y (put the last kill back).
class ReadlineKeys extends StatefulWidget {
  const ReadlineKeys({
    super.key,
    required this.controller,
    required this.onChanged,
    required this.child,
    this.enabled = true,
  });
  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final Widget child;
  final bool enabled;

  @override
  State<ReadlineKeys> createState() => _ReadlineKeysState();
}

class _ReadlineKeysState extends State<ReadlineKeys> {
  String _killed = '';

  bool get _composing {
    final composing = widget.controller.value.composing;
    return composing.isValid && !composing.isCollapsed;
  }

  void _edit(int start, int end, {String insert = '', bool kill = false}) {
    final value = widget.controller.value;
    if (!widget.enabled ||
        _composing ||
        start < 0 ||
        end > value.text.length ||
        start > end) {
      return;
    }
    if (start == end && insert.isEmpty) return;
    if (kill) _killed = value.text.substring(start, end);
    final text = value.text.replaceRange(start, end, insert);
    widget.controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: start + insert.length),
    );
    widget.onChanged(text);
  }

  (int, int) get _span {
    final value = widget.controller.value;
    final selection = value.selection;
    if (!selection.isValid) return (value.text.length, value.text.length);
    return (selection.start, selection.end);
  }

  void _killWord() {
    final (start, end) = _span;
    if (start != end) return _edit(start, end, kill: true);
    final text = widget.controller.text;
    var at = start;
    bool boundary(int i) => text[i] == '/' || text[i].trim().isEmpty;
    while (at > 0 && boundary(at - 1)) {
      at--;
    }
    while (at > 0 && !boundary(at - 1)) {
      at--;
    }
    _edit(at, start, kill: true);
  }

  void _killLine() {
    final (start, end) = _span;
    if (start != end) return _edit(start, end, kill: true);
    if (start == 0) return;
    final lineStart = widget.controller.text.lastIndexOf('\n', start - 1) + 1;
    _edit(lineStart, start, kill: true);
  }

  void _deleteCharacter({required bool backwards}) {
    final (start, end) = _span;
    if (start != end) return _edit(start, end);
    // Editing offsets are UTF-16 code units. Step over a whole visible
    // character, including combining accents, emoji modifiers and joiners.
    final range = CharacterBoundary(widget.controller.text)
        .getTextBoundaryAt(backwards ? start - 1 : start);
    if (range.isValid) _edit(range.start, range.end);
  }

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyW, control: true):
            _killWord,
        const SingleActivator(LogicalKeyboardKey.keyU, control: true):
            _killLine,
        const SingleActivator(LogicalKeyboardKey.keyH, control: true): () =>
            _deleteCharacter(backwards: true),
        const SingleActivator(LogicalKeyboardKey.keyD, control: true): () =>
            _deleteCharacter(backwards: false),
        const SingleActivator(LogicalKeyboardKey.keyY, control: true): () {
          final (start, end) = _span;
          if (_killed.isNotEmpty) _edit(start, end, insert: _killed);
        },
      },
      child: widget.child,
    );
  }
}
