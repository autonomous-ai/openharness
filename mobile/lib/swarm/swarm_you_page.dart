import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'identity.dart';
import 'model.dart';
import 'swarm_devices_page.dart';
import 'swarm_face.dart';
import 'swarm_inbox.dart';
import 'swarm_models_page.dart';
import 'swarm_profile_sheet.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';

/// You, the person's own tab, as Tony's prototype C4 draws it (2026-10-30):
/// who they are in the Swarm Home shows — their face, their name and that
/// Swarm — then their status, and Change for their profile, where it is set
/// ([showSwarmProfile]); Your models, with how many the Swarms can use now,
/// and Your devices, with how many of their computers are online; and
/// Settings. Each count comes from what Home already reads, and none shows
/// before it is read.
class SwarmYouPage extends StatelessWidget {
  const SwarmYouPage({super.key, this.onSettings, this.now = DateTime.now});

  /// The phone's Settings over the tabs.
  final void Function(BuildContext context)? onSettings;

  /// What a model's reading is fresh against.
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    final computers = SwarmScope.computersOf(context);
    return Scaffold(
      backgroundColor: Tty.of(context).ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SwarmTabHeader('You'),
            Expanded(
              child: ListenWhileInSight(
                listenable: Listenable.merge([
                  ?session,
                  ?session?.inbox,
                  ?session?.home,
                  ?computers,
                ]),
                builder: (context) => ListView(
                  padding: EdgeInsets.fromLTRB(
                    AppSpace.m,
                    0,
                    AppSpace.m,
                    MediaQuery.paddingOf(context).bottom + AppSpace.xl,
                  ),
                  children: _body(context, session, computers),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(
    BuildContext context,
    SwarmSession? session,
    SwarmComputers? computers,
  ) {
    final inbox = session?.inbox;
    final swarms = inbox?.swarms ?? const <SwarmListing>[];
    // Who you are: in the Swarm Home shows alone, else the first.
    final you =
        swarms
            .where((swarm) => swarm.id == session?.home.swarmId)
            .firstOrNull ??
        swarms.firstOrNull;
    final reader = you == null ? null : inbox!.reader(you.id);
    // A read taken away keeps nothing of the person or the Swarm.
    final me = reader == null || reader.accessRevoked
        ? null
        : reader.snapshot?.person(reader.accountId);
    final navigator = Navigator.of(context);
    void open(Widget page) => unawaited(
      navigator.push(phoneRoute((_) => page, listensForItself: true)),
    );
    return [
      _Me(
        key: const ValueKey('swarm-you-me'),
        me: me,
        swarm: me == null ? null : you!.name,
      ),
      const SwarmCaption('Status'),
      SwarmGroup(
        children: [
          _Status(
            key: const ValueKey('swarm-you-status'),
            me: me,
            onTap: me == null
                ? null
                : () => unawaited(showSwarmProfile(context, swarmId: you!.id)),
          ),
        ],
      ),
      const SizedBox(height: AppSpace.l),
      SwarmGroup(
        children: [
          SwarmRow(
            key: const ValueKey('swarm-you-models'),
            leading: const _Glyph(LucideIcons.cpu300),
            title: 'Your models',
            detail: switch (_models(inbox, swarms)) {
              null => null,
              0 => SwarmRow.line('None ready now'),
              final count => SwarmRow.line('$count ready now'),
            },
            onTap: () => open(const SwarmModelsPage()),
          ),
          SwarmRow(
            key: const ValueKey('swarm-you-devices'),
            leading: const _Glyph(LucideIcons.laptop300),
            title: 'Your devices',
            detail: switch (_devices(computers?.computers)) {
              null => null,
              final line => SwarmRow.line(line),
            },
            onTap: () => open(const SwarmDevicesPage()),
          ),
        ],
      ),
      const SizedBox(height: AppSpace.l),
      SwarmGroup(
        children: [
          SwarmRow(
            key: const ValueKey('swarm-you-settings'),
            leading: const _Glyph(LucideIcons.settings300),
            title: 'Settings',
            onTap: switch (onSettings) {
              final settings? => () => settings(context),
              null => null,
            },
          ),
        ],
      ),
    ];
  }

  /// How many models every Swarm read can use now; null while none is read
  /// with its models on.
  int? _models(SwarmInbox? inbox, List<SwarmListing> swarms) {
    int? count;
    for (final swarm in swarms) {
      final reader = inbox?.reader(swarm.id);
      final snapshot = reader == null || reader.accessRevoked
          ? null
          : reader.snapshot;
      if (snapshot == null) continue;
      if (swarmModelList(snapshot, now: now()) case final list?) {
        count =
            (count ?? 0) +
            list.apis.length +
            list.local.length +
            list.oneComputer.length;
      }
    }
    return count;
  }

  /// "2 online · 1 offline"; null before the computers are read.
  static String? _devices(List<SwarmComputer>? computers) {
    if (computers == null) return null;
    if (computers.isEmpty) return 'No computers yet';
    final away = computers.where((computer) => computer.away).length;
    final online = computers.length - away;
    return [
      if (online > 0) '$online online',
      if (away > 0) '$away offline',
    ].join(' · ');
  }
}

/// The person at the top of You: their face, their name and the Swarm it is
/// in; "You" alone before a Swarm is read with them in it.
class _Me extends StatelessWidget {
  const _Me({super.key, required this.me, required this.swarm});

  final SuperTabPerson? me;
  final String? swarm;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final me = this.me;
    // A Home kept for a cold start holds no email.
    final name = me == null || me.email.isEmpty
        ? 'You'
        : superTabPersonName(me.email);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpace.xs,
        AppSpace.s,
        AppSpace.xs,
        AppSpace.xs,
      ),
      child: Row(
        children: [
          SwarmAvatar(
            id: me?.id ?? 'you',
            name: name,
            picture: me?.avatar,
            size: 64,
          ),
          const SizedBox(width: AppSpace.l),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppType.title(
                    color: AppPalette.textPrimary,
                    fontWeight: AppFont.semibold,
                  ),
                ),
                if (swarm case final swarm?)
                  Text(
                    swarm,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.label(color: AppPalette.textSecondary),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The person's status, Active while none is set, and Change for their
/// profile; "Set a status" and no way in before they are read.
class _Status extends StatelessWidget {
  const _Status({super.key, required this.me, required this.onTap});

  final SuperTabPerson? me;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final me = this.me;
    Widget row(String title, {required bool known}) => SwarmRow(
      leading: SizedBox(
        width: _Glyph.width,
        child: Center(
          child: Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: known ? AppColors.success : AppPalette.textFaint,
            ),
          ),
        ),
      ),
      title: title,
      trailing: onTap == null
          ? null
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Change',
                  style: AppType.label(color: AppPalette.textSecondary),
                ),
                const SizedBox(width: AppSpace.xs),
                Icon(
                  LucideIcons.chevronRight300,
                  size: 18,
                  color: AppPalette.textFaint,
                ),
              ],
            ),
      onTap: onTap,
    );
    if (me == null) return row('Set a status', known: false);
    return SwarmUntil(
      until: me.status?.until,
      builder: (context) =>
          row(me.statusAt(clock.now())?.label ?? 'Active', known: true),
    );
  }
}

/// A row's glyph, in a 32-point box so the titles line up.
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
