import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import '../../widgets/finger_target.dart';

/// The gap between a row's columns, and half of it: the spacing scale's 8
/// and 4.
const _gap = grid.AppDesktop.controlGap;
const _halfGap = _gap / 2;

/// One row of the left pane's People and Agents (Dee, 2026-10-29): the avatar
/// in one column for both, the name with [trailing] at the right of its line
/// (a person's points, an agent's status mark), and a quiet [detail] line
/// beneath that starts where the name does. [selected] fills the viewer's own
/// row.
class SuperTabMemberRow extends StatelessWidget {
  const SuperTabMemberRow({
    super.key,
    required this.rowKey,
    required this.avatar,
    required this.name,
    required this.onTap,
    this.detail,
    this.trailing,
    this.onLongPress,
    this.selected = false,
  });

  /// The key of the row's tappable surface, where tests and focus find it.
  final Key rowKey;
  final Widget avatar, name;
  final Widget? detail, trailing;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(DesktopChrome.rowRadius);
    final trailing = this.trailing, detail = this.detail;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: _gap),
      child: Material(
        color: selected ? grid.AppSurface.selectedFill : Colors.transparent,
        borderRadius: radius,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: rowKey,
          onTap: onTap,
          onLongPress: onLongPress,
          // Hover and focus keep their treatment over the viewer's own fill.
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          borderRadius: radius,
          child: ConstrainedBox(
            // A phone's row is a finger's height; a mouse keeps a field's.
            constraints: BoxConstraints(
              minHeight: fingerHeight(
                grid.AppControl.heightField,
                enabled: workspaceIsCompact(context),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: _gap,
                vertical: _halfGap,
              ),
              child: Row(
                children: [
                  avatar,
                  const SizedBox(width: _gap),
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(child: name),
                            if (trailing != null)
                              Padding(
                                padding: const EdgeInsets.only(left: _gap),
                                child: trailing,
                              ),
                          ],
                        ),
                        ?detail,
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
