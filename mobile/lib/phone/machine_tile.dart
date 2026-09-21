import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_card.dart';
import 'phone_status.dart';
import 'status_pill.dart';

/// One machine on the phone's first screen: its name, its state, and — in the trailing glyph —
/// what a tap does. A padlock means the tap asks for this machine's own password.
class MachineTile extends StatelessWidget {
  const MachineTile({super.key, required this.machine, required this.onTap});

  final MachineState machine;

  /// Null for a row that does not open — an offline machine — which then has no trailing glyph.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final status = phoneMachineStatusOf(machine);
    final offline = status == PhoneMachineStatus.offline;
    return PhoneCard(
      onTap: onTap,
      child: Row(
        children: [
          PhoneCardGlyph(
            child: Icon(
              LucideIcons.laptopMinimal300,
              size: 22,
              color: offline ? AppPalette.textFaint : AppPalette.textSecondary,
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  machine.machine.displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppPalette.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 5),
                StatusPill(summary: phoneMachineSummary(machine)),
              ],
            ),
          ),
          if (onTap != null) ...[
            const SizedBox(width: 8),
            Icon(
              status == PhoneMachineStatus.needsPassword
                  ? LucideIcons.lockKeyhole300
                  : LucideIcons.chevronRight300,
              size: 22,
              color: AppPalette.textFaint,
            ),
          ],
        ],
      ),
    );
  }
}
