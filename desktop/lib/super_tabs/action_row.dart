import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../widgets/desktop_chrome.dart';

/// A full-width labeled action, aligned with the icon column that project and
/// machine rows share so every sidebar group reads as one list.
class SuperTabActionRow extends StatelessWidget {
  const SuperTabActionRow({
    super.key,
    required this.actionKey,
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final String actionKey;
  final IconData icon;
  final String label;
  final VoidCallback? onPressed;

  static const iconColumn = 32.0;
  static const _textGap = 4.0;

  @override
  Widget build(BuildContext context) => TextButton(
    key: ValueKey(actionKey),
    onPressed: onPressed,
    style:
        TextButton.styleFrom(
          foregroundColor: DesktopChrome.foreground,
          backgroundColor: Colors.transparent,
          disabledBackgroundColor: Colors.transparent,
          minimumSize: const Size(0, 36),
          padding: const EdgeInsets.symmetric(vertical: 8),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          alignment: Alignment.centerLeft,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          ),
          textStyle: DesktopChrome.control(),
        ).copyWith(
          side: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.focused)
                ? BorderSide(color: DesktopChrome.accent, width: 1.5)
                : BorderSide.none,
          ),
        ),
    child: Row(
      children: [
        SizedBox(
          width: iconColumn,
          child: Icon(icon, size: AppIcons.inlineSize),
        ),
        const SizedBox(width: _textGap),
        Expanded(child: Text(label)),
        const SizedBox(width: 12),
      ],
    ),
  );
}
