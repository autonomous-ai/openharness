import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';

/// Image/file transfer progress with a cancel action, kept in the pane's corner.
class TransferProgressBadge extends StatelessWidget {
  final String label;
  final double? fraction;
  final VoidCallback onCancel;
  const TransferProgressBadge({
    super.key,
    required this.label,
    required this.fraction,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final percentLabel = fraction == null
        ? ''
        : ' · ${(fraction! * 100).round()}%';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: grid.AppPalette.panelBg.withValues(alpha: 0.93),
        border: Border.all(color: AppColors.borderStrong),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '$label$percentLabel',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppColors.textSoft,
                    fontFamily: AppFonts.sans,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              InkWell(
                onTap: onCancel,
                child: Text(
                  'CANCEL',
                  style: TextStyle(
                    color: AppColors.textSoft,
                    fontFamily: AppFonts.sans,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              minHeight: 4,
              value: fraction,
              backgroundColor: AppColors.border,
              color: AppColors.accent,
            ),
          ),
        ],
      ),
    );
  }
}
