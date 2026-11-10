import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// How far a sidebar or tab count goes: from here on it says "99+".
const kCountCap = 100;

/// A count as a badge shows it: "7", or "99+" from [kCountCap] on.
String countText(int count) =>
    count >= kCountCap ? '${kCountCap - 1}+' : '$count';

/// A sidebar count of what is for the reader, such as the tags waiting in
/// Notifications or in a conversation: Slack's red number, white on the
/// danger fill (5.4:1 or more in both themes, app_theme.dart dangerFill).
class SuperTabCountBadge extends StatelessWidget {
  const SuperTabCountBadge(this.count, {super.key, this.tooltip});
  final int count;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final badge = Container(
      constraints: const BoxConstraints(minWidth: 18),
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.badgeInset,
      ),
      decoration: ShapeDecoration(
        color: grid.AppPalette.dangerFill,
        shape: const StadiumBorder(),
      ),
      child: Text(
        countText(count),
        textAlign: TextAlign.center,
        style: DesktopChrome.metadata(color: grid.AppPalette.onDangerFill)
            .copyWith(fontWeight: grid.AppFont.semibold),
      ),
    );
    return tooltip == null ? badge : Tooltip(message: tooltip!, child: badge);
  }
}
