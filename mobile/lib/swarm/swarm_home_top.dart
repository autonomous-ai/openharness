import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/fzf.dart' show fzfAge;
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_inbox.dart';
import 'swarm_needs_page.dart';
import 'swarm_project_tasks.dart' show swarmProgressAt;
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';

/// The top of Swarm Home, direction C, as Tony's prototype C1 draws it
/// (2026-10-30): the Swarm switcher in its title ([showSwarmSwitcher]),
/// Jump to… under it ([SwarmJumpField]), and While you were away
/// ([SwarmAwayCard]).

/// What Home's title says: the one Swarm it shows, "All Swarms" over
/// several, "Swarm" before there is one.
String swarmHomeTitle(List<SwarmListing> swarms, String? picked) =>
    switch (swarms.where((swarm) => swarm.id == picked).firstOrNull) {
      final swarm? => swarm.name,
      null when swarms.length == 1 => swarms.single.name,
      null when swarms.isEmpty => 'Swarm',
      null => 'All Swarms',
    };

/// The Swarms Home can show, from its title: All Swarms over several, each
/// Swarm, the one shown ticked and what waits in each other one counted,
/// and Join or create a Swarm. A Swarm the account loses while it is open
/// leaves it, and a tap on it shows nothing.
Future<void> showSwarmSwitcher(BuildContext context, SwarmSession session) =>
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppGlass.rowFill,
      shape: AppControl.sheetShape,
      isScrollControlled: true,
      builder: (sheet) => _Switcher(
        session: session,
        onJoin: () {
          Navigator.of(sheet).pop();
          unawaited(showSwarmJoinOrCreate(context));
        },
      ),
    );

class _Switcher extends StatelessWidget {
  const _Switcher({required this.session, required this.onJoin});

  final SwarmSession session;
  final VoidCallback onJoin;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([session.inbox, session.home]),
    builder: (context, _) {
      final inbox = session.inbox;
      final swarms = inbox.swarms;
      final picked = swarms
          .where((swarm) => swarm.id == session.home.swarmId)
          .firstOrNull;
      final shown = picked ?? (swarms.length == 1 ? swarms.single : null);
      void show(String? swarmId) {
        // Taken away since the last frame: nothing to show.
        if (swarmId == null || inbox.swarms.any((s) => s.id == swarmId)) {
          session.home.show(swarmId);
        }
        Navigator.of(context).pop();
      }

      Widget tick(String label) => Semantics(
        label: label,
        excludeSemantics: true,
        child: Icon(
          LucideIcons.check300,
          size: 20,
          color: AppPalette.swarmAccent,
        ),
      );
      return SafeArea(
        top: false,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * .8,
          ),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(
              AppSpace.s,
              AppSpace.s,
              AppSpace.s,
              AppSpace.l,
            ),
            children: [
              const _Grabber(),
              if (swarms.length > 1)
                SwarmRow(
                  key: const ValueKey('swarm-switch-all'),
                  leading: const _Glyph(LucideIcons.layers300),
                  title: 'All Swarms',
                  trailing: picked == null ? tick('Shown on Swarm Home') : null,
                  chevron: null,
                  onTap: () => show(null),
                ),
              for (final swarm in swarms)
                SwarmRow(
                  key: ValueKey('swarm-switch-${swarm.id}'),
                  leading: SwarmProjectTile(swarm.name),
                  title: swarm.name,
                  trailing: swarm == shown
                      ? tick('Shown on Swarm Home')
                      // What waits in a Swarm Home does not show.
                      : switch (shown == null
                            ? 0
                            : swarmNeedsOf(inbox, swarm.id).length) {
                          0 => null,
                          final count => SwarmBadge(count, warn: true),
                        },
                  chevron: null,
                  onTap: () => show(swarm.id),
                ),
              SwarmRow(
                key: const ValueKey('swarm-switch-join'),
                leading: const _Glyph(LucideIcons.plus300),
                title: 'Join or create a Swarm',
                chevron: null,
                onTap: onJoin,
              ),
            ],
          ),
        ),
      );
    },
  );
}

/// A sheet's grabber: a capsule as wide as the two largest steps.
class _Grabber extends StatelessWidget {
  const _Grabber();

  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      width: AppSpace.xl + AppSpace.m,
      height: AppSpace.xs,
      margin: const EdgeInsets.only(bottom: AppSpace.s),
      decoration: ShapeDecoration(
        color: AppGlass.hair,
        shape: const StadiumBorder(),
      ),
    ),
  );
}

/// A row's glyph, in a tile's box so the titles line up.
class _Glyph extends StatelessWidget {
  const _Glyph(this.icon);

  final IconData icon;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 32,
    child: Icon(icon, size: 22, color: AppPalette.textSecondary),
  );
}

/// Jump to…: a search field's look over Home's list, a button that opens
/// the search ([onTap]).
class SwarmJumpField extends StatelessWidget {
  const SwarmJumpField({super.key, required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'Jump to',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: AppPalette.swarmSearchSurface,
        borderRadius: BorderRadius.circular(AppCard.radius),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppCard.radius),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minTouchTarget),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.m),
              child: Row(
                children: [
                  Icon(
                    LucideIcons.search300,
                    size: 20,
                    color: AppPalette.textFaint,
                  ),
                  const SizedBox(width: AppSpace.s),
                  Text(
                    'Jump to…',
                    style: AppType.body(color: AppPalette.textFaint),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// How many tasks of [snapshot] their agents said Done after [since]: work
/// done holds no time of its Done, which comes at or after its last
/// progress ([swarmProgressAt]), so what this counts is a floor, as Done
/// today's is.
int swarmDoneSince(SuperTabSnapshot snapshot, DateTime since) => snapshot
    .conversations
    .where(
      (g) =>
          g.assignment?['status'] == 'done' &&
          (swarmProgressAt(g)?.isAfter(since) ?? false),
    )
    .length;

/// While you were away, as C1 draws it: how long ago the person left the
/// app, then the work done since ([done], green) and what needs them now
/// ([needs], yellow), each a dash while it is not known. A tap opens what
/// needs them ([onTap]).
class SwarmAwayCard extends StatelessWidget {
  const SwarmAwayCard({
    super.key,
    required this.since,
    required this.now,
    required this.done,
    required this.needs,
    required this.onTap,
  });

  final DateTime since, now;
  final int? done, needs;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final age = fzfAge(since.toLocal(), now.toLocal());
    return Semantics(
      button: true,
      label:
          'While you were away, $age: ${done ?? 'not known how many'} done, '
          '${needs ?? 'not known how many'} need you',
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: AppGlass.rowFill,
        borderRadius: BorderRadius.circular(AppCard.radius),
        child: InkWell(
          borderRadius: BorderRadius.circular(AppCard.radius),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.l,
              AppSpace.m,
              AppSpace.m,
              AppSpace.m,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'While you were away',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.label(
                          color: AppPalette.textPrimary,
                          fontWeight: AppFont.semibold,
                        ),
                      ),
                    ),
                    Text(
                      age,
                      style: AppType.caption(color: AppPalette.textFaint),
                    ),
                    const SizedBox(width: AppSpace.xs),
                    Icon(
                      LucideIcons.chevronRight300,
                      size: 18,
                      color: AppPalette.textFaint,
                    ),
                  ],
                ),
                const SizedBox(height: AppSpace.s),
                Row(
                  children: [
                    Expanded(
                      child: _Stat(
                        key: const ValueKey('swarm-away-done'),
                        count: done,
                        label: 'done',
                        color: AppColors.success,
                      ),
                    ),
                    Expanded(
                      child: _Stat(
                        key: const ValueKey('swarm-away-needs'),
                        count: needs,
                        label: 'need you',
                        color: AppColors.warning,
                      ),
                    ),
                    // Where new threads goes, once the server can tell them.
                    const Spacer(),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One figure of While you were away: its count, large, over its words.
class _Stat extends StatelessWidget {
  const _Stat({
    super.key,
    required this.count,
    required this.label,
    required this.color,
  });

  /// Null while it is not known: a dash.
  final int? count;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        count?.toString() ?? '–',
        style: AppType.title(
          color: (count ?? 0) > 0 ? color : AppPalette.textSecondary,
          fontWeight: AppFont.semibold,
          height: 1.2,
        ),
      ),
      Text(label, style: AppType.caption(color: AppPalette.textSecondary)),
    ],
  );
}
