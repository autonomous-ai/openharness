import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'box_chrome.dart';

/// The prompt these boxes hang off.
///
/// `$`, not the app's own `❯`: SF Mono has no glyph for U+276F, so the prompt
/// came out as a blank the width of a cell — a prompt nobody can see is worse
/// than a plain one everybody has typed at.
const String kBootPrompt = '\$';

/// A progress line the way a terminal draws one: a spinner, a bracketed bar,
/// and a figure — `- |████████        | 62%`.
///
/// The app opens on these before it can open a terminal, and they are the first
/// thing anybody sees. A headline and a spinning ring announce an application
/// launching; this announces something running in a terminal, which is what the
/// person opened (owner, 2026-09-23).
///
/// `#` on blanks between square brackets, the bar every installer has drawn
/// since the 1980s. Block glyphs (`█`, `░`) were the obvious try and are the
/// wrong one: a proportional face's block does not tile, so the bar came out
/// as a row of separate squares — the same reason the terminal renderer paints
/// Block Elements itself rather than asking the font for them.
///
/// [value] null is the honest state while nothing can be counted: a block
/// travels the bar instead of a fill growing, and no figure is printed. Under
/// Reduce Motion nothing moves — the line stays legible, it just stops being a
/// clock.
class TerminalProgressLine extends StatefulWidget {
  const TerminalProgressLine({
    super.key,
    this.value,
    this.cells = 28,
    this.color,
  });

  /// 0–1, or null while there is nothing to count.
  final double? value;

  /// How many glyphs the bar is wide. Fixed, so the line does not reflow as the
  /// fill grows — the whole point of drawing it in a monospaced face.
  final int cells;

  final Color? color;

  @override
  State<TerminalProgressLine> createState() => _TerminalProgressLineState();
}

class _TerminalProgressLineState extends State<TerminalProgressLine>
    with SingleTickerProviderStateMixin {
  /// One turn of the spinner, and one sweep of the travelling block.
  late final AnimationController _clock = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  /// The four frames every terminal spinner has used since the 1980s.
  static const _spinner = ['-', '\\', '|', '/'];
  static const _fill = '#';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Started here rather than in initState, and only when motion is allowed: a
    // controller left repeating under Reduce Motion keeps a frame scheduled
    // forever, which a `pumpAndSettle` never settles and a test can see.
    final still =
        MediaQuery.disableAnimationsOf(context) || widget.value != null;
    if (still && _clock.isAnimating) {
      _clock.stop();
    } else if (!still && !_clock.isAnimating) {
      _clock.repeat();
    }
  }

  @override
  void dispose() {
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final still = !_clock.isAnimating;
    final ink = widget.color ?? grid.AppPalette.textPrimary;
    final track = ink.withValues(alpha: .22);
    return AnimatedBuilder(
      animation: _clock,
      builder: (context, _) {
        final t = still ? 0.0 : _clock.value;
        final value = widget.value;
        final filled = value == null
            ? null
            : (value.clamp(0.0, 1.0) * widget.cells).round();
        // Where the travelling block sits while nothing can be counted.
        final head = (t * widget.cells).floor();
        final lit = <bool>[
          for (var i = 0; i < widget.cells; i++)
            filled != null ? i < filled : (i >= head - 3 && i <= head),
        ];
        // One span per run of like cells, so the bar is a handful of spans
        // rather than one per glyph.
        final spans = <TextSpan>[];
        var start = 0;
        for (var i = 1; i <= widget.cells; i++) {
          if (i == widget.cells || lit[i] != lit[start]) {
            spans.add(
              TextSpan(
                text: (lit[start] ? _fill : '·') * (i - start),
                style: TextStyle(color: lit[start] ? ink : track),
              ),
            );
            start = i;
          }
        }
        final frame = _spinner[(t * _spinner.length).floor() % _spinner.length];
        final figure = filled == null
            ? ''
            : '  ${(value!.clamp(0.0, 1.0) * 100).round()}%';
        return Text.rich(
          TextSpan(
            children: [
              TextSpan(text: '$frame ['),
              ...spans,
              TextSpan(text: ']$figure'),
            ],
          ),
          maxLines: 1,
          style: boxMonoStyle(color: ink),
        );
      },
    );
  }
}

/// The block that sits at the end of the last line, blinking the way a shell's
/// does — the one thing that says a terminal is waiting rather than stuck.
class TerminalCursor extends StatefulWidget {
  const TerminalCursor({super.key, this.color});

  final Color? color;

  @override
  State<TerminalCursor> createState() => _TerminalCursorState();
}

class _TerminalCursorState extends State<TerminalCursor>
    with SingleTickerProviderStateMixin {
  /// A shell's own rhythm: on for half of it, off for the other half.
  late final AnimationController _blink = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1060),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.disableAnimationsOf(context);
    if (still && _blink.isAnimating) {
      _blink.stop();
    } else if (!still && !_blink.isAnimating) {
      _blink.repeat();
    }
  }

  @override
  void dispose() {
    _blink.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _blink,
    builder: (context, _) => Opacity(
      // Held on when nothing may move: a cursor is where you are, and it must
      // not be the thing that disappeared.
      opacity: !_blink.isAnimating || _blink.value < .5 ? 1 : 0,
      child: Text(
        '▌',
        style: boxMonoStyle(color: widget.color ?? grid.AppPalette.textPrimary),
      ),
    ),
  );
}

/// One printed check: `tmux ................... ok`.
///
/// The leader is dots to the same column on every row, which is how a terminal
/// lines a list up without drawing a table.
class TerminalCheckLine extends StatelessWidget {
  const TerminalCheckLine({
    super.key,
    required this.label,
    required this.status,
    this.ink,
    this.columns = 34,
  });

  final String label;
  final String status;
  final Color? ink;

  /// The column the status starts in, counted in glyphs.
  final int columns;

  @override
  Widget build(BuildContext context) {
    final leader = '.' * (columns - label.length).clamp(1, columns);
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(text: '$label '),
          TextSpan(
            text: leader,
            style: TextStyle(
              color: grid.AppPalette.textPrimary.withValues(alpha: .22),
            ),
          ),
          TextSpan(
            text: ' $status',
            style: TextStyle(color: ink ?? grid.AppPalette.textPrimary),
          ),
        ],
      ),
      maxLines: 1,
      style: boxMonoStyle(color: kBoxFaint),
    );
  }
}
