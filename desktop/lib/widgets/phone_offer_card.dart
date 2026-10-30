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
class PhoneOfferCard extends StatefulWidget {
  const PhoneOfferCard({
    super.key,
    required this.onAdd,
    required this.onDismiss,
    this.onShown,
    this.away,
  });

  /// The card's words after time away ([AppNotifier.phoneOfferAway]): what a harness did while the
  /// person was gone, then what a phone would have done about it.
  ///
  /// ```
  /// ┌──────────────────────────────────────┐
  /// │ ▯  Codex waited 18 min for you.   ×  │
  /// │    Answer from your phone next time. │
  /// │    ( Add Phone )                     │
  /// └──────────────────────────────────────┘
  /// ```
  ///
  /// The minutes and "min" are held together by a no-break space: wrapped apart, the title read
  /// "finished 21" on one line and "min ago." on the next (owner, 2026-10-21).
  static ({String title, String detail}) awayWords({
    required String agent,
    required bool waited,
    required int minutes,
  }) => waited
      ? (
          title: '$agent waited $minutes\u00A0min for you.',
          detail: 'Answer from your phone next time.',
        )
      : (
          title: '$agent finished $minutes\u00A0min ago.',
          detail: 'Know the moment it’s done, on your phone.',
        );

  /// Offered after time away, the harness and what it did ([awayWords]); null for the usual words.
  final ({String agent, bool waited, int minutes})? away;

  /// Add Phone: the code a phone scans — or, for a guest, the sign-in first.
  final VoidCallback onAdd;

  /// Put away for good on this computer; Add Phone stays in the menu and the
  /// command palette.
  final VoidCallback onDismiss;

  /// After the card's first frame on screen ([AppNotifier.phoneOfferShown]),
  /// again each time it is built anew; the app counts one per offer.
  final VoidCallback? onShown;

  @override
  State<PhoneOfferCard> createState() => _PhoneOfferCardState();
}

class _PhoneOfferCardState extends State<PhoneOfferCard> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onShown?.call();
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final away = widget.away;
    final words = away == null
        ? (
            title: 'Your agents in your pocket.',
            detail: 'When an agent needs you, answer from anywhere.',
          )
        : PhoneOfferCard.awayWords(
            agent: away.agent,
            waited: away.waited,
            minutes: away.minutes,
          );
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
                  words.title,
                  key: const Key('phone-offer-title'),
                  // A harness with a long name keeps the card its size.
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.body(color: AppColors.text)
                      .copyWith(fontWeight: FontWeight.w600, fontSize: 13),
                ),
                const SizedBox(height: 1),
                Text(
                  words.detail,
                  style: AppType.body(color: AppColors.mutedStrong)
                      .copyWith(fontSize: 12),
                ),
                const SizedBox(height: 10),
                FilledButton(
                  key: const Key('phone-offer-add'),
                  onPressed: widget.onAdd,
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
            onPressed: widget.onDismiss,
          ),
        ],
      ),
    );
  }
}
