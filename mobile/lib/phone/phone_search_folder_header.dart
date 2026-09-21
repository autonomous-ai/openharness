import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_search_groups.dart';

/// The line over one folder's agents: the folder, the machine it is on, and how
/// many matched.
///
/// Carries the two things every row under it used to repeat, so each row's
/// second line is left for what actually tells its agents apart. A folder glyph
/// rather than an uppercase label, so it cannot be read as the same kind of
/// heading as the Machines section below it.
class PhoneSearchFolderHeader extends StatelessWidget {
  const PhoneSearchFolderHeader({super.key, required this.group});

  final PhoneSearchGroup group;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final faint = TextStyle(color: AppPalette.textFaint, fontSize: 12);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 14, 10, 4),
      child: Row(
        children: [
          Icon(LucideIcons.folder300, size: 14, color: AppPalette.textFaint),
          const SizedBox(width: 6),
          Flexible(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: group.folder.isEmpty ? 'No folder' : group.folder,
                    style: TextStyle(
                      color: AppPalette.textSecondary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  // The machine ellipses off first: it is the longest part and
                  // the one that is the same for most people's every group.
                  TextSpan(text: ' · ${group.machineName}'),
                ],
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: faint,
            ),
          ),
          const SizedBox(width: 7),
          Text(
            '${group.rows.length}',
            style: faint.copyWith(fontFeatures: AppFont.tabularFigures),
          ),
        ],
      ),
    );
  }
}
