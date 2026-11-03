import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// A composer choice (New session, Also send): a checkbox, an empty square
/// before its label when off and an accent checked square when on, with no
/// pill around it, so two of them read as independent options, never an
/// either-or choice (Scholes, 11-03; a circle in an outlined pill read as a
/// radio). Hover shades it as any quiet control. Its hover hint says what it
/// does, or why it can't be chosen now ([onChanged] null: greyed). A label too
/// long for its place ends in "…"; the square always shows.
class SuperTabComposerToggle extends StatelessWidget {
  const SuperTabComposerToggle({
    super.key,
    required this.label,
    required this.on,
    required this.hint,
    required this.onChanged,
  });

  final String label;
  final bool on;
  final String hint;
  final ValueChanged<bool>? onChanged;

  static const _textSize = 12.0;
  static const _iconSize = 12.0;
  static const _gap = 4.0;

  /// The width this choice takes with [label] in one line, as drawn in
  /// [context] (its text size included): what a send row measures to tell
  /// whether a label fits. Matches [DesktopPill]'s compact quiet control:
  /// side padding, the icon and its gap, and the reserved rim.
  static double widthOf(BuildContext context, String label) {
    final text = TextPainter(
      text: TextSpan(
        text: label,
        style: DesktopChrome.text(size: _textSize, height: 1.25),
      ),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = text.width;
    text.dispose();
    return 6 * 2 +
        grid.AppDesktop.focusWidth * 2 +
        _iconSize +
        _gap +
        width +
        1;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ink = on ? DesktopChrome.accent : DesktopChrome.foreground;
    return Semantics(
      toggled: on,
      child: DesktopPill(
        label: label,
        compact: true,
        quiet: true,
        textSize: _textSize,
        leadingGap: _gap,
        leading: Icon(
          on ? AppIcons.squareCheck : AppIcons.square,
          key: ValueKey(on ? 'composer-toggle-check' : 'composer-toggle-off'),
          size: _iconSize,
          color: onChanged == null ? ink.withValues(alpha: .38) : ink,
        ),
        tooltip: hint,
        onPressed: onChanged == null ? null : () => onChanged!(!on),
      ),
    );
  }
}
