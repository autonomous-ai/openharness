import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'model.dart';
import 'swarm_agents.dart';
import 'swarm_home_view_sheet.dart';
import 'swarm_inbox.dart';
import 'swarm_needs_page.dart';
import 'swarm_project_tasks.dart' show swarmProgressAt;
import 'swarm_rename.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';

/// The top of Swarm Home, direction C, as Tony's prototype C1 draws it
/// (2026-10-30): the Swarm switcher in its title ([showSwarmSwitcher]). While
/// you were away is the need-you line since 2026-11-04 (`SwarmNeedLine`).

/// Whether the account's Swarms are still to come, a failed read still trying:
/// never from a server without the list, which no read will bring.
bool swarmHomeListing(SwarmInbox inbox) =>
    !inbox.loaded && inbox.swarms.isEmpty && inbox.error != swarmServerTooOld;

/// Whether Home offers Swarm [swarmId]: the account's, and its read not
/// taken away, though the list may still have it until it is read again.
bool swarmHomeOffers(SwarmInbox inbox, String swarmId) =>
    inbox.swarms.any((swarm) => swarm.id == swarmId) &&
    !(inbox.reader(swarmId)?.accessRevoked ?? false);

/// The one Swarm of those Home [shown] that its title names: never one whose
/// read is taken away.
SwarmListing? swarmHomeNamed(SwarmInbox inbox, List<SwarmListing> shown) =>
    switch (shown) {
      [final swarm] when swarmHomeOffers(inbox, swarm.id) => swarm,
      _ => null,
    };

/// What Home's title says over the Swarms it [shown]: the one it shows,
/// "All Swarms" over several, "Swarm" before there is one, or once the one
/// Swarm's read is taken away.
String swarmHomeTitle(SwarmInbox inbox, List<SwarmListing> shown) =>
    swarmHomeNamed(inbox, shown)?.name ??
    (shown.length > 1 ? 'All Swarms' : 'Swarm');

/// The Swarms Home can show, from its title: All Swarms over several, each
/// Swarm, the one shown ticked and what waits in each other one counted,
/// then Sort and filter ([onView]) and the agents on the person's computers
/// ([agents]), where Home has them — moved here from Home's filter icon and
/// Agents tile (anh Dee, 2026-11-04: less on Home) — then New project, for
/// someone who may write in a Swarm Home shows ([offersNewProject]; moved
/// from the foot of Home, River 2026-11-04: Home keeps one +, New
/// message's), and Join or create a Swarm. A Swarm the account loses, or whose read is taken away, while it
/// is open leaves it, and a tap on it shows nothing. A Swarm with a menu for
/// the person ([swarmHasMenu]) shows a ⋮ on its row; the ⋮, or holding the
/// row, closes it for that menu over Home ([showSwarmMenu]). Each of the
/// rows under the Swarms closes it, then opens what it names.
Future<void> showSwarmSwitcher(
  BuildContext context,
  SwarmSession session, {
  VoidCallback? onView,
  SwarmAgents? agents,
  bool Function()? offersNewProject,
  VoidCallback? onNewProject,
}) => showModalBottomSheet<void>(
  context: context,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  isScrollControlled: true,
  builder: (sheet) {
    VoidCallback then(VoidCallback open) => () {
      Navigator.of(sheet).pop();
      open();
    };
    return _Switcher(
      session: session,
      onJoin: then(() => unawaited(showSwarmJoinOrCreate(context))),
      onHold: (swarmId) => then(
        () => unawaited(showSwarmMenu(context, session.inbox, swarmId)),
      )(),
      onView: onView == null ? null : then(onView),
      agents: agents,
      onAgents: agents == null ? null : then(() => agents.openList(context)),
      offersNewProject: offersNewProject,
      onNewProject: onNewProject == null ? null : then(onNewProject),
    );
  },
);

class _Switcher extends StatelessWidget {
  const _Switcher({
    required this.session,
    required this.onJoin,
    required this.onHold,
    this.onView,
    this.agents,
    this.onAgents,
    this.offersNewProject,
    this.onNewProject,
  });

  final SwarmSession session;
  final VoidCallback onJoin;

  /// Sort and filter, and the agents' list: null, no row.
  final VoidCallback? onView, onAgents, onNewProject;
  final SwarmAgents? agents;

  /// Whether New project is offered now: read on each build, so a role
  /// taken away while it is open takes the row with it.
  final bool Function()? offersNewProject;

  /// A Swarm's menu asked for, from its row's ⋮ or by holding the row,
  /// with its id.
  final ValueChanged<String> onHold;

  /// A row's end: what it shows ([status]), then its ⋮ ([menu]).
  static Widget? _trailing(Widget? status, {Widget? menu}) => menu == null
      ? status
      : Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (status != null) ...[status, const SizedBox(width: AppSpace.s)],
            menu,
          ],
        );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([session.inbox, session.home, ?agents]),
    builder: (context, _) {
      final inbox = session.inbox;
      final home = session.home;
      final swarms = [
        for (final swarm in inbox.swarms)
          if (swarmHomeOffers(inbox, swarm.id)) swarm,
      ];
      final picked = swarms
          .where((swarm) => swarm.id == session.home.swarmId)
          .firstOrNull;
      final shown =
          picked ?? (inbox.swarms.length == 1 ? swarms.firstOrNull : null);
      void show(String? swarmId) {
        // Taken away since the last frame, or its read: nothing to show.
        if (swarmId == null || swarmHomeOffers(inbox, swarmId)) {
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
              if (swarmHomeListing(inbox))
                const SkeletonBlock(
                  child: SwarmSkeletonRow(
                    key: ValueKey('swarm-switch-loading'),
                    titleOnly: true,
                  ),
                ),
              if (inbox.swarms.length > 1)
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
                  trailing: _trailing(
                    swarm == shown
                        ? tick('Shown on Swarm Home')
                        // What waits in a Swarm Home does not show.
                        : switch (shown == null
                              ? 0
                              : swarmNeedsOf(inbox, swarm.id).length) {
                            0 => null,
                            final count => SwarmBadge(count, warn: true),
                          },
                    // Its menu, for someone with something in it to do,
                    // from a ⋮ as a chat's is.
                    menu: swarmHasMenu(inbox, swarm.id)
                        ? _SwarmMenuButton(
                            key: ValueKey('swarm-switch-menu-${swarm.id}'),
                            onTap: () => onHold(swarm.id),
                          )
                        : null,
                  ),
                  chevron: null,
                  onTap: () => show(swarm.id),
                  // Held, the same menu: a shortcut to the ⋮.
                  onLongPress: swarmHasMenu(inbox, swarm.id)
                      ? () => onHold(swarm.id)
                      : null,
                ),
              if (onView case final onView?)
                // Said in words too, as the dot is not heard.
                Semantics(
                  button: true,
                  label:
                      'Sort and filter: ${swarmHomeSortLabel(home)}, '
                      '${swarmHomeFilterLabel(home.filter)}',
                  excludeSemantics: true,
                  onTap: onView,
                  child: SwarmRow(
                    key: const ValueKey('swarm-switch-view'),
                    leading: const _Glyph(LucideIcons.listFilter300),
                    title: 'Sort and filter',
                    trailing: home.viewChanged
                        ? SizedBox.square(
                            key: const ValueKey('swarm-switch-view-dot'),
                            dimension: AppSpace.s,
                            child: DecoratedBox(
                              decoration: ShapeDecoration(
                                color: AppPalette.swarmAccent,
                                shape: const CircleBorder(),
                              ),
                            ),
                          )
                        : null,
                    chevron: null,
                    onTap: onView,
                  ),
                ),
              if ((agents, onAgents) case (final agents?, final onAgents?))
                SwarmRow(
                  key: const ValueKey('swarm-switch-agents'),
                  leading: const _Glyph(LucideIcons.squareTerminal300),
                  title: 'Agents',
                  trailing: switch (agents.working) {
                    final n? when n > 0 => Text(
                      '$n working',
                      style: AppType.caption(color: AppPalette.textSecondary),
                    ),
                    _ => null,
                  },
                  chevron: null,
                  onTap: onAgents,
                ),
              if ((offersNewProject, onNewProject)
                  case (final offers?, final onNewProject?) when offers())
                SwarmRow(
                  key: const ValueKey('swarm-switch-new-project'),
                  leading: const _Glyph(LucideIcons.squarePlus300),
                  title: 'New project',
                  chevron: null,
                  onTap: onNewProject,
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

/// A switcher row's ⋮: that Swarm's menu ([showSwarmMenu]), as a chat's ⋮
/// opens its own. A thumb's size, inside the row.
class _SwarmMenuButton extends StatelessWidget {
  const _SwarmMenuButton({super.key, required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    // Its own button for a screen reader, not merged into the row's.
    container: true,
    button: true,
    label: 'Swarm options',
    excludeSemantics: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () {
        HapticFeedback.selectionClick();
        onTap();
      },
      child: SizedBox.square(
        dimension: minTouchTarget,
        child: Align(
          alignment: AlignmentDirectional.centerEnd,
          child: Icon(
            LucideIcons.ellipsisVertical300,
            size: AppIconSize.standalone,
            color: AppPalette.textSecondary,
          ),
        ),
      ),
    ),
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
