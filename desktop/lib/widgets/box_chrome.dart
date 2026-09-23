import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';

const double kTerminalCornerRadius = 3;

/// One gutter around the workspace, between panes, and beside command docks.
const double kWorkspaceInset = 9.5;

/// The selected tab joins the workspace with the same small radius used at
/// its top corners. The bottom curves turn outward, like a browser tab.
class TerminalTabBorder extends ShapeBorder {
  const TerminalTabBorder({this.radius = kTerminalCornerRadius});
  final double radius;

  @override
  EdgeInsetsGeometry get dimensions => EdgeInsets.zero;

  @override
  ShapeBorder scale(double t) => TerminalTabBorder(radius: radius * t);

  @override
  Path getOuterPath(Rect rect, {TextDirection? textDirection}) {
    final r = radius.clamp(0.0, rect.shortestSide / 4);
    final c = r * .5522847498;
    final left = rect.left + r, right = rect.right - r;
    final top = rect.top, bottom = rect.bottom;
    return Path()
      ..moveTo(rect.left, bottom)
      ..cubicTo(rect.left + c, bottom, left, bottom - r + c, left, bottom - r)
      ..lineTo(left, top + r)
      ..cubicTo(left, top + r - c, left + r - c, top, left + r, top)
      ..lineTo(right - r, top)
      ..cubicTo(right - r + c, top, right, top + r - c, right, top + r)
      ..lineTo(right, bottom - r)
      ..cubicTo(
        right,
        bottom - r + c,
        rect.right - c,
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
  void paint(Canvas canvas, Rect rect, {TextDirection? textDirection}) {}
}

/// A temporary command area attached to the workspace's bottom edge. Its
/// overlay never changes the dimensions or scroll position of live terminals.
class CommandDock extends StatelessWidget {
  const CommandDock({
    super.key,
    required this.child,
    this.topClearance = 0,
    this.expanded = false,
  });
  final Widget child;
  final double topClearance;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final available =
            (constraints.maxHeight - topClearance - 2 * kWorkspaceInset).clamp(
              0.0,
              double.infinity,
            );
        final scale = grid.appTextScaleOf(context);
        // A panel in the middle of the workspace, the way a terminal's own
        // finder sits over what it is searching — not a drawer along an edge.
        // Wide enough for a path and a branch beside their labels, and no
        // wider: a line the eye crosses is a line nobody reads.
        final minimum = constraints.maxWidth < 800 * scale ? 320.0 : 280.0;
        final maxHeight =
            (expanded
                    ? 560.0 * scale
                    : (available * .5).clamp(minimum * scale, 440.0 * scale))
                .clamp(0.0, available);
        final room = (constraints.maxWidth - 2 * kWorkspaceInset).clamp(
          0.0,
          double.infinity,
        );
        final maxWidth = room.clamp(0.0, 820.0 * scale);
        return Align(
          // Above the middle, where the eye already is, as fzf and a command
          // palette sit.
          alignment: const Alignment(0, -0.15),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: kWorkspaceInset,
              vertical: kWorkspaceInset,
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                minWidth: maxWidth.clamp(0.0, 620.0 * scale),
                maxWidth: maxWidth,
                maxHeight: maxHeight,
              ),
              child: FocusScope(child: child),
            ),
          ),
        );
      },
    );
  }
}

/// Shared typography and frame for prompts that sit over the terminals: the
/// terminal's face at [grid.AppType.monoSize], which ⌘+ and ⌘− leave alone.
TextStyle boxMonoStyle({Color? color, FontWeight? weight}) => grid.AppType.mono(
  height: 1.35,
  color: color ?? Colors.white,
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
            ? Border(
                top: BorderSide(color: Colors.white.withValues(alpha: .24)),
              )
            : RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(kTerminalCornerRadius),
                side: BorderSide(color: Colors.white.withValues(alpha: .24)),
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
const kBoxFaint = Colors.white54;
TextStyle get kBoxFaintStyle => grid.AppType.monoMeta(color: kBoxFaint);

/// Keep the user's actual binding, printed like a terminal's local key guide.
String boxKeyLabel(String hint) => hint
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
      color: highlighted
          ? Colors.white.withValues(alpha: .10)
          : Colors.transparent,
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
                    color: isError ? Colors.orangeAccent : Colors.white70,
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
                            style: const TextStyle(color: Colors.white70),
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
        border: Border(
          top: BorderSide(color: Colors.white.withValues(alpha: .08)),
        ),
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
