import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/settings_row.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

/// A [SettingsRow] whose line under the title is a widget of its own — a
/// team line with its coloured dots ([SwarmTeamLine]) — in the same card, at
/// the same height and margins, with the same chevron.
class SwarmRow extends StatelessWidget {
  const SwarmRow({
    super.key,
    required this.title,
    this.detail,
    required this.onTap,
  });

  final String title;
  final Widget? detail;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final row = Container(
      constraints: const BoxConstraints(minHeight: kSettingsRowHeight),
      padding: const EdgeInsets.fromLTRB(13, 8, 13, 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppPalette.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                if (detail case final detail?) ...[
                  const SizedBox(height: 3),
                  detail,
                ],
              ],
            ),
          ),
          if (onTap != null)
            Padding(
              padding: const EdgeInsets.only(left: 4),
              child: Transform.translate(
                // The glyph's own trailing blank, as [SettingsRow] cancels it.
                offset: const Offset(kChevronInk, 0),
                child: Icon(
                  LucideIcons.chevronRight300,
                  size: 20,
                  color: AppPalette.textFaint,
                ),
              ),
            ),
        ],
      ),
    );
    if (onTap == null) return row;
    return Material(
      color: Colors.transparent,
      child: InkWell(onTap: onTap, child: row),
    );
  }
}
