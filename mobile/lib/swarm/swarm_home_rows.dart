import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_need_rows.dart';
import 'swarm_home_list.dart';
import 'swarm_inbox.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'team_glance.dart';

/// The rows of Swarm Home, direction B, as Tony's prototype B1 draws them
/// (2026-10-29): what needs the person, each a line; a project with its
/// team in coloured dots and when it last moved; the projects quiet for a
/// day folded in one row.

/// A team in a line of coloured dots, as B1 draws it: "● 4 working ● 1
/// waiting", each dot in its state's colour ([swarmStateColor]), who is down
/// in red words too, and heard as words alone. With nobody counted, the
/// team's line in words ("No agents yet", "All idle").
class SwarmTeamDots extends StatelessWidget {
  const SwarmTeamDots(this.glance, {super.key, this.lead});

  final SwarmTeamGlance glance;

  /// Words before the dots: the Swarm, where Home shows several.
  final String? lead;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final quiet = AppType.caption(
      color: AppPalette.textSecondary,
      height: 1.35,
    );
    final parts = glance.parts;
    // Heard in words: "1 working · 1 waiting", never the dots.
    final heard = [?lead, glance.line].join(' · ');
    return Semantics(
      label: heard,
      excludeSemantics: true,
      child: Text.rich(
        TextSpan(
          children: [
            if (lead case final lead?) TextSpan(text: '$lead · '),
            if (parts.isEmpty) TextSpan(text: glance.line),
            for (final (i, part) in parts.indexed) ...[
              if (i > 0) const TextSpan(text: '  '),
              TextSpan(
                text: '● ',
                style: TextStyle(color: swarmStateColor(part.state)),
              ),
              TextSpan(
                text: part.text,
                style: part.state == SwarmAgentState.down
                    ? TextStyle(color: AppColors.danger)
                    : null,
              ),
            ],
          ],
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: quiet,
      ),
    );
  }
}

/// What a need asks, as its Home row's title: a decision's question, a tag's
/// words, the question work waits on (or the work itself).
String swarmNeedAsk(SwarmNeed need) => switch (need) {
  SwarmDecisionNeed(:final decision) => decision.question,
  SwarmMentionNeed(:final mention) =>
    mention.text.isNotEmpty ? mention.text : mention.conversationTitle,
  SwarmWorkNeed(:final work) => work.question ?? work.conversation.label,
};

/// Who asks a need, and where: its project, who asks, and how long ago.
String swarmNeedWhere(SwarmNeed need, DateTime now) {
  final (project, who, at) = switch (need) {
    SwarmDecisionNeed(:final decision) => (
      decision.projectName,
      decision.askerName,
      decision.createdAt,
    ),
    SwarmMentionNeed(:final mention) => (
      mention.projectName,
      mention.leadName,
      mention.createdAt,
    ),
    SwarmWorkNeed(:final work) => (
      work.project.name,
      work.agentName,
      work.conversation.changedAt,
    ),
  };
  return [
    project,
    who,
    if (at != null) fzfAge(at.toLocal(), now.toLocal()),
  ].where((part) => part.isNotEmpty).join(' · ');
}

/// One thing that needs the person, on Home: a yellow dot, what is asked in
/// bold, where and who under it, and a chevron; a tap opens it. A decision
/// whose answer is held for Undo says what is being sent.
class SwarmHomeNeedRow extends StatelessWidget {
  const SwarmHomeNeedRow({
    super.key,
    required this.session,
    required this.need,
    required this.now,
    required this.onTap,
  });

  final SwarmSession session;
  final SwarmNeed need;
  final DateTime now;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final held = switch (need) {
      final SwarmDecisionNeed decision => switch (session.held(decision)) {
        final choice? =>
          'Sending “${swarmOption(decision.decision.options, choice)}”',
        null => null,
      },
      _ => null,
    };
    return SwarmRow(
      leading: const _Dot(size: 8),
      title: swarmNeedAsk(need),
      news: (bold: true, tags: 0),
      detail: SwarmRow.line(held ?? swarmNeedWhere(need, now)),
      onTap: onTap,
    );
  }
}

/// The last row of Home's Needs you: "See all 4" and a chevron.
class SwarmSeeAllRow extends StatelessWidget {
  const SwarmSeeAllRow({super.key, required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return _Tap(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.l,
            vertical: AppSpace.s,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'See all $count',
                  style: AppType.label(color: AppPalette.textSecondary),
                ),
              ),
              Icon(
                LucideIcons.chevronRight300,
                size: 18,
                color: AppPalette.textFaint,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One project on Home, as B1 draws it: its tile, its name — bold and bright
/// with something new in it, quiet otherwise — its team in coloured dots
/// ([SwarmTeamDots]), and at its right how long ago it last moved, over the
/// tags waiting in it ("@2", filled) or, unread, a dot. A tap opens it; a
/// long press offers its pin ([onLongPress]).
class SwarmHomeProjectRow extends StatelessWidget {
  const SwarmHomeProjectRow({
    super.key,
    required this.project,
    required this.glance,
    required this.now,
    this.swarmName,
    required this.onTap,
    this.onLongPress,
  });

  final SwarmHomeProject project;
  final SwarmTeamGlance glance;
  final DateTime now;

  /// Its Swarm, where Home shows several.
  final String? swarmName;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final news = project.news;
    final bright = news.bold || news.tags > 0;
    final age = switch (project.active) {
      final at? => fzfAge(at.toLocal(), now.toLocal()),
      null => '',
    };
    return _Tap(
      onTap: onTap,
      onLongPress: onLongPress,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: SwarmRow.height),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.l,
            vertical: AppSpace.m,
          ),
          child: Row(
            children: [
              SwarmProjectTile(project.project.name),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Semantics(
                      label: bright && news.tags == 0
                          ? 'Unread messages'
                          : null,
                      child: Text(
                        project.project.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.label(
                          color: bright
                              ? AppPalette.textPrimary
                              : AppPalette.textSecondary,
                          height: 1.3,
                          fontWeight: bright ? AppFont.semibold : null,
                        ),
                      ),
                    ),
                    const SizedBox(height: 3),
                    SwarmTeamDots(glance, lead: swarmName),
                  ],
                ),
              ),
              if (age.isNotEmpty || bright) ...[
                const SizedBox(width: 12),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (age.isNotEmpty)
                      Text(
                        age,
                        style: AppType.caption(
                          color: AppPalette.textFaint,
                          height: 1.3,
                        ),
                      ),
                    if (news.tags > 0) ...[
                      const SizedBox(height: 4),
                      SwarmTags(news.tags, filled: true),
                    ] else if (news.bold) ...[
                      const SizedBox(height: 8),
                      ExcludeSemantics(
                        child: _Dot(size: 7, color: AppPalette.textPrimary),
                      ),
                    ],
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The projects quiet for a day, folded in one row at the foot of Projects:
/// "Other projects (9)", "Quiet for 24h" and a chevron that turns as they
/// open ([open]).
class SwarmOtherProjectsRow extends StatelessWidget {
  const SwarmOtherProjectsRow({
    super.key,
    required this.count,
    required this.open,
    required this.onTap,
  });

  final int count;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      expanded: open,
      child: _Tap(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: SwarmRow.height),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.l,
              vertical: AppSpace.m,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Other projects ($count)',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.label(color: AppPalette.textSecondary),
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  'Quiet for ${swarmQuietAfter.inHours}h',
                  style: AppType.caption(color: AppPalette.textFaint),
                ),
                const SizedBox(width: 8),
                Icon(
                  open ? LucideIcons.chevronUp300 : LucideIcons.chevronDown300,
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

/// A row's ink on a tap, with a click a thumb can feel.
class _Tap extends StatelessWidget {
  const _Tap({required this.onTap, this.onLongPress, required this.child});

  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final Widget child;

  @override
  Widget build(BuildContext context) => Material(
    color: Colors.transparent,
    child: InkWell(
      onTap: onTap,
      onLongPress: onLongPress == null
          ? null
          : () {
              HapticFeedback.mediumImpact();
              onLongPress!();
            },
      child: child,
    ),
  );
}

/// A small round mark: what waits on the person in the warning colour, or
/// [color].
class _Dot extends StatelessWidget {
  const _Dot({required this.size, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color ?? AppColors.warning,
      shape: BoxShape.circle,
    ),
  );
}

/// A project's pin, offered on a long press of its Home row: one row, Pin or
/// Unpin ([pinned]). Answers true when it was tapped, null when closed.
Future<bool?> showSwarmPinSheet(
  BuildContext context, {
  required String name,
  required bool pinned,
}) => showModalBottomSheet<bool>(
  context: context,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  builder: (context) => SafeArea(
    top: false,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpace.l,
        AppSpace.s,
        AppSpace.l,
        AppSpace.l,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // The grabber: a capsule as wide as the two largest steps.
          Center(
            child: Container(
              width: AppSpace.xl + AppSpace.m,
              height: AppSpace.xs,
              margin: const EdgeInsets.only(bottom: AppSpace.s),
              decoration: ShapeDecoration(
                color: AppGlass.hair,
                shape: const StadiumBorder(),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.m,
              AppSpace.xs,
              AppSpace.m,
              AppSpace.s,
            ),
            child: Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppType.caption(color: AppPalette.textSecondary),
            ),
          ),
          Semantics(
            button: true,
            child: InkWell(
              key: const ValueKey('swarm-pin'),
              borderRadius: BorderRadius.circular(AppControl.radius),
              onTap: () => Navigator.of(context).pop(true),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: minTouchTarget),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpace.m,
                    vertical: AppSpace.s,
                  ),
                  child: Row(
                    children: [
                      Icon(
                        pinned ? LucideIcons.pinOff300 : LucideIcons.pin300,
                        size: 20,
                        color: AppPalette.textPrimary,
                      ),
                      const SizedBox(width: AppSpace.m),
                      Text(
                        pinned ? 'Unpin' : 'Pin to top',
                        style: AppType.body(color: AppPalette.textPrimary),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  ),
);
