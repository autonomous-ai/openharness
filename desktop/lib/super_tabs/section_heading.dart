import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';

/// Keeps resource headings aligned whether their add action is available or not.
class SuperTabSectionHeading extends StatelessWidget {
  const SuperTabSectionHeading(
    this.title, {
    super.key,
    this.onAdd,
    this.addTooltip,
    this.trailing,
  });

  final String title;
  final VoidCallback? onAdd;
  final String? addTooltip;

  /// Beside the title, before the add action: a status the heading carries, such as the Machines pill.
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 12, 4),
    child: ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 32),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: DesktopChrome.metadata().copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          if (trailing != null) ...[trailing!, const SizedBox(width: 4)],
          if (onAdd != null)
            AppIconButton(
              icon: AppIcons.plus,
              tooltip: addTooltip ?? title,
              onPressed: onAdd,
            ),
        ],
      ),
    ),
  );
}
