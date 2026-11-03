import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_agents.dart';
import 'swarm_style.dart';
import 'swarm_threads.dart';

/// The tiles at the top of Swarm Home, Slack's tile bar (Tony, 2026-11-03):
/// While you were away, Threads and Agents side by side, scrolling sideways
/// when they do not fit. One row of tiles in place of two cards leaves the
/// screen to the projects.
class SwarmHomeTiles extends StatelessWidget {
  const SwarmHomeTiles({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    key: const ValueKey('swarm-home-tiles'),
    scrollDirection: Axis.horizontal,
    clipBehavior: Clip.none,
    child: IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, tile) in children.indexed) ...[
            if (i > 0) const SizedBox(width: AppSpace.s),
            tile,
          ],
        ],
      ),
    ),
  );
}

/// While you were away as a tile: how long the person was away, from leaving
/// the app ([since]) to coming back ([back]), over the work done since
/// ([done], green) and what needs them now ([needs], yellow), each a skeleton
/// until it is known. A tap opens what needs them ([onTap]).
class SwarmAwayTile extends StatelessWidget {
  const SwarmAwayTile({
    super.key,
    required this.since,
    required this.back,
    required this.done,
    required this.needs,
    required this.onTap,
  });

  final DateTime since, back;
  final int? done, needs;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final age = fzfAge(since.toLocal(), back.toLocal());
    final words = AppType.caption(color: AppPalette.textSecondary);
    // A figure and its words, as one: its count, or a skeleton as tall.
    Widget stat(Key key, int? value, String label, Color color) {
      final style = AppType.label(
        color: (value ?? 0) > 0 ? color : AppPalette.textSecondary,
        fontWeight: AppFont.semibold,
        height: 1.2,
      );
      return Row(
        key: key,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (value == null)
            SkeletonText(style: style, width: 20)
          else
            Text('$value', style: style),
          const SizedBox(width: AppSpace.xs),
          // Large type, or a long count, gives up the words first.
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: words,
            ),
          ),
        ],
      );
    }

    return _Tile(
      key: const ValueKey('swarm-away'),
      width: 214,
      icon: LucideIcons.clock300,
      title: 'While you were away',
      titleEnd: age,
      label:
          'While you were away, $age: ${done ?? 'not known how many'} done, '
          '${needs ?? 'not known how many'} need you',
      onTap: onTap,
      value: Row(
        children: [
          Flexible(
            child: stat(
              const ValueKey('swarm-away-done'),
              done,
              'done',
              AppColors.success,
            ),
          ),
          const SizedBox(width: AppSpace.m),
          Flexible(
            flex: 2,
            child: stat(
              const ValueKey('swarm-away-needs'),
              needs,
              'need you',
              AppColors.warning,
            ),
          ),
        ],
      ),
    );
  }
}

/// Threads as a tile: the threads the person follows ([threads]), the tags
/// of them in threads filled, else New replies while one has some. A tap
/// opens Threads ([onTap]).
class SwarmThreadsTile extends StatelessWidget {
  const SwarmThreadsTile({
    super.key,
    required this.threads,
    required this.onTap,
  });

  final SwarmThreadsMerge threads;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: threads,
    builder: (context, _) {
      AppTheme.watch(context);
      final unread = threads.unread, tags = threads.mentions;
      return _Tile(
        key: const ValueKey('swarm-threads-row'),
        width: 104,
        icon: LucideIcons.messagesSquare300,
        title: 'Threads',
        bright: unread || tags > 0,
        label: tags > 0
            ? 'Threads, $tags ${tags == 1 ? 'mention' : 'mentions'}'
            : unread
            ? 'Threads, new replies'
            : 'Threads',
        onTap: onTap,
        value: tags > 0
            ? Align(
                alignment: Alignment.centerLeft,
                child: SwarmTags(
                  tags,
                  key: const ValueKey('swarm-threads-tags'),
                  filled: true,
                ),
              )
            : Text(
                unread ? 'New replies' : 'No new replies',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: unread
                    ? AppType.label(
                        color: AppPalette.textPrimary,
                        fontWeight: AppFont.semibold,
                        height: 1.2,
                      )
                    : AppType.caption(color: AppPalette.textFaint),
              ),
      );
    },
  );
}

/// Agents as a tile: how many of the person's harnesses work now
/// ([SwarmAgents.working]), a skeleton until the computers answer. A tap
/// opens every agent, by computer ([onTap]): Swarm's way into Harness.
class SwarmAgentsTile extends StatelessWidget {
  const SwarmAgentsTile({super.key, required this.agents, required this.onTap});

  final SwarmAgents agents;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: agents,
    builder: (context, _) {
      AppTheme.watch(context);
      final working = agents.working;
      final style = AppType.label(
        color: AppPalette.textPrimary,
        fontWeight: AppFont.semibold,
        height: 1.2,
      );
      return _Tile(
        key: const ValueKey('swarm-agents-tile'),
        width: 104,
        icon: LucideIcons.squareTerminal300,
        title: 'Agents',
        label: switch (working) {
          null => 'Agents',
          0 => 'Agents, none working',
          final n => 'Agents, $n working',
        },
        onTap: onTap,
        value: switch (working) {
          null => SkeletonText(
            key: const ValueKey('swarm-agents-loading'),
            style: style,
            width: 60,
          ),
          0 => Text(
            'None working',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppType.caption(color: AppPalette.textFaint),
          ),
          final n => Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: AppColors.success,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  '$n working',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: style,
                ),
              ),
            ],
          ),
        },
      );
    },
  );
}

/// One tile: its glyph and [title] over its [value], heard as [label].
class _Tile extends StatelessWidget {
  const _Tile({
    super.key,
    required this.width,
    required this.icon,
    required this.title,
    required this.value,
    required this.label,
    required this.onTap,
    this.titleEnd,
    this.bright = false,
  });

  final double width;
  final IconData icon;
  final String title;

  /// Quiet words at the title's end: how long ago.
  final String? titleEnd;
  final Widget value;
  final String label;
  final VoidCallback onTap;

  /// Something new in it: its title in the main ink.
  final bool bright;

  @override
  Widget build(BuildContext context) {
    final ink = bright ? AppPalette.textPrimary : AppPalette.textSecondary;
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: AppGlass.rowFill,
        borderRadius: BorderRadius.circular(AppCard.radius),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppCard.radius),
          onTap: onTap,
          child: SizedBox(
            width: width,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpace.m,
                AppSpace.s + 2,
                AppSpace.s + 2,
                AppSpace.s + 2,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: [
                      Icon(icon, size: 16, color: ink),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppType.caption(
                            color: ink,
                            fontWeight: bright ? AppFont.semibold : null,
                          ),
                        ),
                      ),
                      if (titleEnd case final end?) ...[
                        const SizedBox(width: AppSpace.xs),
                        Text(
                          end,
                          style: AppType.caption(color: AppPalette.textFaint),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 6),
                  value,
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
