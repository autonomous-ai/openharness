import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'identity.dart';
import 'swarm_devices_page.dart';
import 'swarm_face.dart';
import 'swarm_inbox.dart';
import 'swarm_models_page.dart';
import 'swarm_needs_page.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';

/// Swarm Home's drawer, from the left edge, slim as Tony's prototype B3
/// draws it (2026-10-29): its title and a close button; who you are; Swarm
/// Home, with what waits on the person; the Swarms, the one Home shows
/// ticked — a tap shows that Swarm alone, Swarm Home all of them again
/// ([SwarmHomePrefs.swarmId]) — then Join or create a Swarm; Your models and
/// Your devices; and Settings at its foot. The projects are on Home, their
/// chats, Buddy and leaderboard on each project's page. A row closes the
/// drawer before it opens anything.
class SwarmDrawer extends StatelessWidget {
  const SwarmDrawer({
    super.key,
    required this.session,
    this.onSettings,
    this.onProfile,
  });

  /// The account's Swarm; null while there is none to read.
  final SwarmSession? session;

  /// Settings over Swarm Home, opened from the context it is given.
  final void Function(BuildContext context)? onSettings;

  /// The person's own profile in a Swarm; null offers none.
  final void Function(String swarmId)? onProfile;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = this.session;
    final inbox = session?.inbox;
    final navigator = Navigator.of(context);
    void close() => Scaffold.of(context).closeDrawer();
    void then(VoidCallback action) {
      close();
      action();
    }

    final swarms = inbox?.swarms ?? const <SwarmListing>[];
    // The Swarm Home shows alone: the one picked while it is listed, or the
    // only one.
    final picked = swarms
        .where((swarm) => swarm.id == session?.home.swarmId)
        .firstOrNull;
    final shown = picked ?? (swarms.length == 1 ? swarms.single : null);
    final waiting = inbox?.needs.length ?? 0;
    // Who you are: in the Swarm shown, else the first.
    final you = shown ?? swarms.firstOrNull;
    return Drawer(
      width: MediaQuery.sizeOf(context).width * .86,
      backgroundColor: AppPalette.panelBg,
      shape: Border(right: BorderSide(color: AppGlass.hair)),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              // The title over the rows' words.
              padding: const EdgeInsets.fromLTRB(
                AppSpace.s + SwarmDrawerRow.inset,
                AppSpace.xs,
                AppSpace.s,
                AppSpace.s,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Swarm',
                      style: tty.style(size: 17, weight: FontWeight.w600),
                    ),
                  ),
                  SwarmIconButton(
                    key: const ValueKey('swarm-drawer-close'),
                    icon: LucideIcons.x300,
                    label: 'Close menu',
                    onPressed: close,
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(
                  AppSpace.s,
                  0,
                  AppSpace.s,
                  AppSpace.m,
                ),
                children: [
                  // Who you are, first: the way to your picture and status.
                  if ((onProfile, you) case (final onProfile?, final you?))
                    if (inbox!.reader(you.id) case final reader?) ...[
                      _You(
                        key: ValueKey('swarm-drawer-you-${you.id}'),
                        reader: reader,
                        onTap: () => then(() => onProfile(you.id)),
                      ),
                      const _Rule(),
                    ],
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-home'),
                    leading: const _Glyph(LucideIcons.house300),
                    title: 'Swarm Home',
                    selected: true,
                    badge: waiting > 0 ? SwarmBadge(waiting, warn: true) : null,
                    onTap: () => then(() => session?.home.show(null)),
                  ),
                  if (swarms.isNotEmpty) const _Caption('Swarms'),
                  for (final swarm in swarms)
                    SwarmDrawerRow(
                      key: ValueKey('swarm-drawer-swarm-${swarm.id}'),
                      leading: SwarmProjectTile(swarm.name),
                      title: swarm.name,
                      badge: swarm == shown
                          ? Semantics(
                              label: 'Shown on Swarm Home',
                              excludeSemantics: true,
                              child: Icon(
                                LucideIcons.check300,
                                size: 20,
                                color: AppPalette.swarmAccent,
                              ),
                            )
                          // What waits in a Swarm Home does not show.
                          : switch (shown == null
                                ? 0
                                : swarmNeedsOf(inbox!, swarm.id).length) {
                              0 => null,
                              final count => SwarmBadge(count, warn: true),
                            },
                      onTap: () => then(() => session?.home.show(swarm.id)),
                    ),
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-join'),
                    leading: const _Glyph(LucideIcons.plus300),
                    title: 'Join or create a Swarm',
                    quiet: true,
                    onTap: () =>
                        then(() => unawaited(showSwarmJoinOrCreate(context))),
                  ),
                  const _Rule(),
                  // The Swarm's models and the account's computers, read
                  // only.
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-models'),
                    leading: const _Glyph(LucideIcons.squareSquare300),
                    title: 'Your models',
                    onTap: () => then(
                      () => navigator.push(
                        phoneRoute(
                          (_) => const SwarmModelsPage(),
                          listensForItself: true,
                        ),
                      ),
                    ),
                  ),
                  // The account's computers, and each Swarm's machines.
                  SwarmDrawerRow(
                    key: const ValueKey('swarm-drawer-devices'),
                    leading: const _Glyph(LucideIcons.monitor300),
                    title: 'Your devices',
                    onTap: () => then(
                      () => navigator.push(
                        phoneRoute(
                          (_) => const SwarmDevicesPage(),
                          listensForItself: true,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (onSettings case final settings?)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpace.s,
                  vertical: AppSpace.s,
                ),
                child: SwarmDrawerRow(
                  key: const ValueKey('swarm-drawer-settings'),
                  leading: const _Glyph(LucideIcons.settings300),
                  title: 'Settings',
                  onTap: () => then(() => settings(context)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// A hairline between the drawer's runs of rows.
class _Rule extends StatelessWidget {
  const _Rule();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(
      horizontal: SwarmDrawerRow.inset,
      vertical: AppSpace.s,
    ),
    child: Divider(height: 1, thickness: 1, color: AppGlass.hair),
  );
}

/// The person as a Swarm shows them: their face, and their status while it
/// lasts; nothing until the Swarm is read with them in it.
class _You extends StatelessWidget {
  const _You({super.key, required this.reader, required this.onTap});

  final SwarmReader reader;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: reader,
    builder: (context, _) {
      final me = reader.snapshot?.person(reader.accountId);
      if (me == null) return const SizedBox.shrink();
      return SwarmUntil(
        until: me.status?.until,
        builder: (context) {
          final status = me.statusAt(clock.now());
          // A Home kept for a cold start holds no email.
          final name = me.email.isEmpty ? 'You' : superTabPersonName(me.email);
          return SwarmDrawerRow(
            leading: SwarmAvatar(
              id: me.id,
              name: name,
              picture: me.avatar,
              status: status,
            ),
            title: name,
            detail: Text(
              status?.label ?? 'Set a status',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppType.caption(
                color: status == null
                    ? AppPalette.textFaint
                    : AppPalette.textSecondary,
              ),
            ),
            onTap: onTap,
          );
        },
      );
    },
  );
}

/// A row's glyph, in a 32-point box so titles line up with a project's tile.
class _Glyph extends StatelessWidget {
  const _Glyph(this.icon);

  static const double width = 32;

  final IconData icon;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: width,
    child: Icon(icon, size: 22, color: AppPalette.textSecondary),
  );
}

/// A caption over a run of the drawer's rows; empty, a gap.
class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      SwarmDrawerRow.inset,
      AppSpace.l,
      SwarmDrawerRow.inset,
      AppSpace.s,
    ),
    child: Text(
      text,
      style: AppType.caption(
        color: Color.lerp(AppPalette.textFaint, AppPalette.textSecondary, .5),
        height: 1.2,
      ),
    ),
  );
}

/// One row of the drawer: a glyph or a tile, a title and maybe a line under
/// it, then a count or a mark ([badge]); selected, it sits on a rounded
/// fill. A [quiet] row's title is in the secondary ink: a way to something
/// that is not there yet.
class SwarmDrawerRow extends StatelessWidget {
  const SwarmDrawerRow({
    super.key,
    this.leading,
    required this.title,
    this.detail,
    this.badge,
    this.selected = false,
    this.quiet = false,
    required this.onTap,
  });

  final Widget? leading;
  final String title;
  final Widget? detail;
  final Widget? badge;
  final bool selected;
  final bool quiet;
  final VoidCallback? onTap;

  /// Every row clears this, for a thumb.
  static const double height = 52;

  /// From a row's edges to its words.
  static const double inset = AppSpace.m;

  /// Around a row's words.
  static const padding = EdgeInsets.symmetric(
    horizontal: inset,
    vertical: AppSpace.s,
  );

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Material(
      color: selected ? AppSurface.selectedFill : Colors.transparent,
      borderRadius: BorderRadius.circular(AppControl.rowRadius),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onTap!();
              },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: height),
          child: Padding(
            padding: padding,
            child: Row(
              children: [
                if (leading case final leading?) ...[
                  leading,
                  const SizedBox(width: AppSpace.m),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.label(
                          color: quiet
                              ? AppPalette.textSecondary
                              : AppPalette.textPrimary,
                          fontWeight: selected ? AppFont.semibold : null,
                        ),
                      ),
                      if (detail case final detail?) ...[
                        const SizedBox(height: 2),
                        detail,
                      ],
                    ],
                  ),
                ),
                if (badge case final badge?) ...[
                  const SizedBox(width: 12),
                  badge,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
