import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// A composer choice on the send row (New session, Also send): the shared
/// compact pill, quiet and outlined when off, accent when on. Its hover hint
/// says what it does, or why it can't be chosen now ([onChanged] null).
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

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Semantics(
      toggled: on,
      child: DesktopPill(
        label: label,
        compact: true,
        choice: true,
        textSize: 12,
        selected: on,
        foregroundColor: on ? DesktopChrome.accent : null,
        tooltip: hint,
        onPressed: onChanged == null ? null : () => onChanged!(!on),
      ),
    );
  }
}
