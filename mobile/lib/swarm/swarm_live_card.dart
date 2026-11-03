import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'swarm_live_card_facts.dart';
import 'swarm_message_row.dart';

export 'swarm_live_card_facts.dart';

/// Like a Slack app's message that updates itself (backend superTabs/cards.ts,
/// the desktop's live_card.dart): a task or a pull request drawn as one card
/// under its message, changing in place as the Swarm's state does. On the
/// phone it shows the Swarm's own facts: the task, its checks, the verdict,
/// each PR's link and a recorded merge.
class SwarmLiveCard extends StatelessWidget {
  const SwarmLiveCard({super.key, required this.facts});

  final SwarmCardFacts facts;

  @override
  Widget build(BuildContext context) {
    final task = facts.task;
    final muted = swarmChatText(14, color: AppPalette.textSecondary);
    return Padding(
      padding: const EdgeInsets.only(top: AppSpace.s),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppPalette.cardBg,
          borderRadius: BorderRadius.circular(AppCard.radius),
          border: Border.all(color: AppGlass.hair),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(AppCard.radius),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // A colored edge, as a Slack attachment has.
                SizedBox(
                  width: AppSpace.xs,
                  child: ColoredBox(color: AppPalette.swarmAccent),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpace.m,
                      vertical: AppSpace.s,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (task != null) ...[
                          Text(
                            task.title,
                            style: swarmChatText(15.5, weight: FontWeight.w600),
                          ),
                          Text(task.line, style: muted),
                        ],
                        for (final pull in facts.pulls) _PullRow(pull),
                        if (facts.review case final review?)
                          Padding(
                            padding: const EdgeInsets.only(top: AppSpace.xs),
                            child: Text(review, style: muted),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One pull request on a card: its repository and number, and Merged once the
/// Swarm recorded it. Opens in the in-app browser.
class _PullRow extends StatelessWidget {
  const _PullRow(this.pull);

  final SwarmCardPull pull;

  @override
  Widget build(BuildContext context) {
    final url = pull.url;
    final label = '${url.pathSegments[1]} · PR #${url.pathSegments[3]}';
    return Semantics(
      button: true,
      link: true,
      label: pull.merged ? 'Open $label, merged' : 'Open $label',
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey('swarm-card-pr-$url'),
        onTap: () {
          HapticFeedback.selectionClick();
          unawaited(launchUrl(url, mode: LaunchMode.inAppBrowserView));
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Row(
            children: [
              Icon(
                pull.merged
                    ? LucideIcons.gitMerge300
                    : LucideIcons.gitPullRequest300,
                size: 16,
                color: pull.merged
                    ? AppPalette.swarmAccent
                    : AppPalette.textSecondary,
              ),
              const SizedBox(width: AppSpace.s),
              // Its words wrap together at large text, Merged after the name.
              Expanded(
                child: Wrap(
                  spacing: AppSpace.s,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(label, style: swarmChatText(15)),
                    if (pull.merged)
                      Text(
                        'Merged',
                        style: swarmChatText(14, color: AppPalette.swarmAccent),
                      ),
                    Icon(
                      LucideIcons.externalLink300,
                      size: 14,
                      color: AppPalette.textFaint,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
