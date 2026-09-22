import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_search_controller.dart';

/// The line between the field and the results: what is being searched, and how
/// much of it the query has left.
///
/// The desktop's box title and its `4/7`. The count is the quickest answer to
/// "did that narrow it, or is it just not here?", and on the phone the title is
/// also the only thing that says a mode is open at all — there is no box chrome
/// around the list to carry it.
///
/// Absent on a plain empty query, where the list IS the answer and a header over
/// it would cost a row.
class PhoneSearchScopeBar extends StatelessWidget {
  const PhoneSearchScopeBar({super.key, required this.search});

  final PhoneSearchController search;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: search,
    builder: (context, _) {
      AppTheme.watch(context);
      final scoped = search.canGoBack;
      final typed = search.matchQuery.trim().isNotEmpty;
      if (!scoped && !typed && search.title == 'Search') {
        return const SizedBox.shrink();
      }
      final faint = TextStyle(color: AppPalette.textFaint, fontSize: 12);
      return Padding(
        padding: const EdgeInsets.fromLTRB(26, 6, 26, 6),
        child: Row(
          children: [
            if (scoped) ...[
              Icon(
                LucideIcons.cornerDownRight300,
                size: 13,
                color: AppPalette.textFaint,
              ),
              const SizedBox(width: 6),
            ],
            Flexible(
              child: Text(
                search.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: faint.copyWith(
                  color: AppPalette.textSecondary,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const Spacer(),
            Text(
              // Only once the query has actually excluded something: `7/7`
              // over an untouched list is noise dressed as information.
              search.matchCount == search.total
                  ? '${search.total}'
                  : '${search.matchCount}/${search.total}',
              style: faint.copyWith(fontFeatures: AppFont.tabularFigures),
            ),
          ],
        ),
      );
    },
  );
}
