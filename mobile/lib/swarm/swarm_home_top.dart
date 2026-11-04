import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'model.dart';
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
/// and Join or create a Swarm. A Swarm the account loses, or whose read is
/// taken away, while it is open leaves it, and a tap on it shows nothing.
/// A Swarm with a menu for the person ([swarmHasMenu]) shows a ⋮ on its
/// row; the ⋮, or holding the row, closes it for that menu over Home
/// ([showSwarmMenu]).
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
        onHold: (swarmId) {
          Navigator.of(sheet).pop();
          unawaited(showSwarmMenu(context, session.inbox, swarmId));
        },
      ),
    );

class _Switcher extends StatelessWidget {
  const _Switcher({
    required this.session,
    required this.onJoin,
    required this.onHold,
  });

  final SwarmSession session;
  final VoidCallback onJoin;

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
    listenable: Listenable.merge([session.inbox, session.home]),
    builder: (context, _) {
      final inbox = session.inbox;
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
