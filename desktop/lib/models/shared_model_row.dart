import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart';
import '../theme/app_theme.dart';
import '../widgets/resting_model_words.dart';
import '../widgets/resting_section.dart';
import 'model_mark.dart';

/// One model a shared section of the Models panel serves: its mark, its id, and the computer
/// serving it.
///
/// A row every serving computer of which seems offline stays listed — the daemon labels such rows,
/// it never removes them — faded, with why under it. Every other row draws as it always did.
class SharedModelRow extends StatelessWidget {
  const SharedModelRow({super.key, required this.model});

  final GridModel model;

  @override
  Widget build(BuildContext context) {
    final offline = offlineRowNote(model);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 14, 6, 14),
      child: Row(
        children: [
          offline == null
              ? ModelMark(model: model.id)
              : Opacity(
                  opacity: kUnavailableOpacity,
                  child: ModelMark(model: model.id),
                ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  model.id,
                  style: AppType.label(
                    color: offline == null
                        ? AppPalette.textPrimary
                        : AppPalette.textFaint,
                    height: 1.3,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 6),
                Text(
                  model.node,
                  style: AppType.monoMeta(
                    color: offline == null
                        ? AppPalette.textSecondary
                        : AppPalette.textFaint,
                    height: 1.3,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (offline != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    offline,
                    style: AppType.body(color: AppColors.textSoft),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
