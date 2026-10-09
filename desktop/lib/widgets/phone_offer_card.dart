import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/app_type.dart';
import '../theme/app_theme.dart';

/// Add Phone offered beside the work rather than over it
/// ([AppNotifier.phoneOfferShowing]), under the agents' banners in the window's
/// top-right ([AgentAlertBanners.footer]) and in their shape.
///
/// ```
/// ┌──────────────────────────────────────┐
/// │ ▯  Your agents in your pocket.    ×  │
/// │    When an agent needs you, answer   │
/// │    from anywhere.                    │
/// │    ( Add Phone )                     │
/// └──────────────────────────────────────┘
/// ```
///
/// The words are the Welcome Tour's phone slide (`setup_tour.dart`, "On the
/// go"), which a new computer has just shown. The button is named as the phone
/// names it — "Open Add Phone on your computer" (mobile `set_up_computer.dart`)
/// — so somebody the phone sent here finds the thing it told them about.
class PhoneOfferCard extends StatelessWidget {
  const PhoneOfferCard({
    super.key,
    required this.onAdd,
    required this.onDismiss,
  });

  /// Add Phone: the code a phone scans — or, for a guest, the sign-in first.
  final VoidCallback onAdd;

  /// Put away for good on this computer; Add Phone stays in the menu and the
  /// command palette.
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      key: const Key('phone-offer-card'),
      width: 288,
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: AppColors.border),
        boxShadow: const [
          BoxShadow(
            color: Color(0x40000000),
            blurRadius: 14,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(AppIcons.smartphone, size: 15, color: AppColors.text),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Your agents in your pocket.',
                  style: AppType.body(color: AppColors.text)
                      .copyWith(fontWeight: FontWeight.w600, fontSize: 13),
                ),
                const SizedBox(height: 1),
                Text(
                  'When an agent needs you, answer from anywhere.',
                  style: AppType.body(color: AppColors.mutedStrong)
                      .copyWith(fontSize: 12),
                ),
                const SizedBox(height: 10),
                FilledButton(
                  key: const Key('phone-offer-add'),
                  onPressed: onAdd,
                  child: const Text('Add Phone'),
                ),
              ],
            ),
          ),
          IconButton(
            key: const Key('phone-offer-dismiss'),
            icon: const Icon(AppIcons.close, size: 14),
            color: AppColors.mutedStrong,
            splashRadius: 14,
            visualDensity: VisualDensity.compact,
            tooltip: 'Dismiss',
            onPressed: onDismiss,
          ),
        ],
      ),
    );
  }
}
