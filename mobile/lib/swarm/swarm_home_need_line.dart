import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

/// The top of Swarm Home: one line, "2 need you · 1 done", in place of the
/// three tiles While you were away, Threads and Agents (anh Dee, 2026-11-04:
/// "less is better"). Home draws it only while something needs the person.
/// How many need them ([needs], yellow), then the work done since they last
/// left the app ([done]), said only when some was. A tap opens what needs
/// them ([onTap]). Threads is in Activity's top bar now, and the agents in
/// the Swarm switcher and Search.
class SwarmNeedLine extends StatelessWidget {
  const SwarmNeedLine({
    super.key,
    required this.needs,
    required this.done,
    required this.onTap,
  });

  final int needs;
  final int? done;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final done = switch (this.done) {
      final n? when n > 0 => n,
      _ => null,
    };
    return Semantics(
      button: true,
      label: ['$needs need you', if (done != null) '$done done'].join(', '),
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        key: const ValueKey('swarm-need-line'),
        borderRadius: BorderRadius.circular(AppCard.radius),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: minTouchTarget),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.l),
            child: Row(
              children: [
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: '$needs',
                          style: TextStyle(color: AppColors.warning),
                        ),
                        const TextSpan(text: ' need you'),
                        if (done != null)
                          TextSpan(
                            text: ' · $done done',
                            style: TextStyle(
                              color: AppPalette.textSecondary,
                              fontWeight: AppFont.regular,
                            ),
                          ),
                      ],
                    ),
                    key: const ValueKey('swarm-need-line-text'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.label(
                      color: AppPalette.textPrimary,
                      fontWeight: AppFont.semibold,
                      height: 1.3,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpace.s),
                Icon(
                  LucideIcons.chevronRight300,
                  size: 18,
                  color: AppPalette.textFaint,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
