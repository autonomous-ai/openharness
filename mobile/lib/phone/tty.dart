import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_theme.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';

/// The phone's chrome, drawn as a terminal draws — the pieces every screen is built from.
///
/// ⚠️ **The rule: the app should look like the tools it sits beside — zsh, tmux, fzf, vim.** One
/// monospace face at the terminal's own size, the terminal's own sixteen colours and ground, square
/// edges, no cards, no shadows, no icons as decoration, reverse video for what is selected. The
/// agent's terminal is the product; around it, the phone draws what tmux and fzf would.
///
/// Colours come from the terminal's resolved theme ([terminalThemeFor]), so the chrome changes with
/// the terminal when its colours do.
class Tty {
  Tty._(this.theme, this.fontFamily, this.fontFallback, this.fontSize);

  /// The terminal theme and font in force, read at build time.
  factory Tty.of(BuildContext context) {
    AppTheme.watch(context);
    final font = terminalFontStore.value;
    return Tty._(
      terminalThemeFor(AppTheme.palette.value, terminalThemeStore.value),
      font.fontFamily,
      font.fontFamilyFallback,
      // The terminal's own size, exactly: chrome and output share one cell, so a status line or an
      // fzf row lands on the same columns as the agent's text beside it.
      font.fontSize,
    );
  }

  final TerminalTheme theme;
  final String fontFamily;
  final List<String> fontFallback;
  final double fontSize;

  Color get ground => theme.background;
  Color get text => theme.foreground;

  /// Rules, marks and the gutter — brightBlack, as a terminal draws its own furniture.
  Color get dim => theme.brightBlack;

  /// Secondary TEXT in the chrome: labels, details, hints. brightBlack on the ground is 3.1:1, too
  /// faint to read at a glance on a phone; this is the agent's own faint text, about 4.9:1.
  Color get faint =>
      Color.alphaBlend(theme.foreground.withValues(alpha: 0.52), theme.background);
  Color get green => theme.green;
  Color get yellow => theme.yellow;
  Color get red => theme.red;
  Color get cyan => theme.cyan;
  Color get magenta => theme.magenta;
  Color get blue => theme.blue;

  /// The row under the cursor — fzf's `bg+`: a step up from the ground, the text unchanged.
  Color get selected => Color.alphaBlend(
    theme.foreground.withValues(alpha: 0.12),
    theme.background,
  );

  /// One terminal row's height — the pane's line height (1.2) at its size. Every height in the
  /// chrome is a whole number of these.
  double get row => fontSize * 1.2;

  /// The shortest a tappable row may be drawn: whole rows, at least 44pt.
  double get tapRow => (44 / row).ceil() * row;

  /// One character cell's width — the grid every column in the chrome sits on.
  double get cell => _cellWidth(fontFamily, fontFallback, fontSize);

  /// Where the terminal's text starts: the pane's own left padding. Column 0 of the chrome.
  static const double origin = 12;

  /// The x of column [n].
  double col(int n) => origin + n * cell;

  static final _cells = <(String, double), double>{};
  static double _cellWidth(String family, List<String> fallback, double size) =>
      _cells.putIfAbsent((family, size), () {
        final painter = TextPainter(
          text: TextSpan(
            text: 'MMMMMMMMMM',
            style: TextStyle(
              fontFamily: family,
              fontFamilyFallback: fallback,
              fontSize: size,
            ),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        final width = painter.width / 10;
        painter.dispose();
        return width;
      });

  TextStyle style({
    Color? color,
    Color? background,
    FontWeight weight = FontWeight.w400,
    double? size,
  }) => TextStyle(
    fontFamily: fontFamily,
    fontFamilyFallback: fontFallback,
    fontSize: size ?? fontSize,
    // The terminal's own line height, so chrome rows and output rows keep one pitch.
    height: 1.2,
    color: color ?? text,
    backgroundColor: background,
    fontWeight: weight,
    // Tabular by construction, but ligatures would glue `->` and `!=` in paths and branch names.
    fontFeatures: const [FontFeature.disable('liga'), FontFeature.disable('calt')],
  );
}

/// A run of monospace text, one line, clipped at the edge like a terminal — no ellipsis dots a
/// terminal would never draw.
class TtyText extends StatelessWidget {
  const TtyText(
    this.text, {
    super.key,
    this.color,
    this.background,
    this.weight = FontWeight.w400,
    this.size,
  });

  final String text;
  final Color? color;
  final Color? background;
  final FontWeight weight;
  final double? size;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Text(
      text,
      maxLines: 1,
      softWrap: false,
      overflow: TextOverflow.clip,
      style: tty.style(
        color: color,
        background: background,
        weight: weight,
        size: size,
      ),
    );
  }
}

/// A tappable region with a full touch target and no ink — a terminal has no ripple. Pressed, it
/// shows fzf's selection ground at once, on the finger's way DOWN, which is what makes a tap feel
/// instant.
class TtyTap extends StatefulWidget {
  const TtyTap({
    super.key,
    required this.child,
    this.onTap,
    this.semanticsLabel,
    this.minHeight = 44,
  });

  final Widget child;
  final VoidCallback? onTap;
  final String? semanticsLabel;
  final double minHeight;

  @override
  State<TtyTap> createState() => _TtyTapState();
}

class _TtyTapState extends State<TtyTap> {
  bool _down = false;

  void _set(bool down) {
    if (_down != down) setState(() => _down = down);
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final enabled = widget.onTap != null;
    return Semantics(
      button: enabled,
      label: widget.semanticsLabel,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: enabled ? (_) => _set(true) : null,
        onTapCancel: enabled ? () => _set(false) : null,
        onTapUp: enabled ? (_) => _set(false) : null,
        onTap: widget.onTap,
        child: ColoredBox(
          color: _down ? tty.selected : Colors.transparent,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: widget.minHeight),
            child: Align(
              alignment: Alignment.centerLeft,
              widthFactor: 1,
              child: widget.child,
            ),
          ),
        ),
      ),
    );
  }
}
