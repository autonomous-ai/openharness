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
