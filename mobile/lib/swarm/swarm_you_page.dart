import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/settings_page.dart'
    show NotificationsSettingsRow;
import 'package:harness_mobile/phone/settings_row.dart' show SettingsSwarmLook;
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

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

/// Where You's Settings row goes, and the notice centre its Notifications
/// reads: the shell's, handed down by Swarm's tabs to whatever opens You from
/// under them ([openSwarmYou]); and the tabs told of each You opened over them
/// ([onOpened]), to take it with them when they go.
class SwarmYouSettings extends InheritedWidget {
  const SwarmYouSettings({
    super.key,
    required this.onSettings,
    this.notices,
    this.onOpened,
    required super.child,
  });

  final void Function(BuildContext context)? onSettings;

  /// The phone's notice centre, for You's Notifications; null where it has
  /// none to turn on (the sample).
  final SystemNotices? notices;

  /// A You opened over the tabs: it goes with them.
  final ValueChanged<Route<void>>? onOpened;

  @override
  bool updateShouldNotify(SwarmYouSettings oldWidget) =>
      onSettings != oldWidget.onSettings ||
      notices != oldWidget.notices ||
      onOpened != oldWidget.onOpened;
}

/// Opens You over [context]'s page, its Settings and notices the tabs'
/// ([SwarmYouSettings]), and tells the tabs, which take it with them when they
/// go.
void openSwarmYou(BuildContext context) {
  final scope = context.getInheritedWidgetOfExactType<SwarmYouSettings>();
  final route = phoneRoute(
    (_) => SwarmYouPage(onSettings: scope?.onSettings, notices: scope?.notices),
    listensForItself: true,
  );
  scope?.onOpened?.call(route);
  unawaited(Navigator.of(context).push(route));
}

/// Who the person is on You and on its avatar: in the Swarm Home shows alone,
/// else the first; nothing of them before that Swarm is read, or once the
/// read is taken away.
({SuperTabPerson? me, SwarmListing? swarm}) swarmYouOf(SwarmSession? session) {
  final inbox = session?.inbox;
  final swarms = inbox?.swarms ?? const <SwarmListing>[];
  final you =
      swarms.where((swarm) => swarm.id == session?.home.swarmId).firstOrNull ??
      swarms.firstOrNull;
  final reader = you == null ? null : inbox!.reader(you.id);
  final me = reader == null || reader.accessRevoked
      ? null
      : reader.snapshot?.person(reader.accountId);
  return (me: me, swarm: you);
}

/// The person's avatar at the end of Home's and Activity's top bars (Slack's
/// You, Tony 2026-11-03): their face with their status, "You" in their
/// initial before they are read. A tap opens You ([openSwarmYou]).
class SwarmYouButton extends StatelessWidget {
  const SwarmYouButton({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    Widget face() {
      final me = swarmYouOf(session).me;
      final name = me == null || me.email.isEmpty ? 'You' : me.shownName;
      final status = me?.statusAt(clock.now())?.label;
      return Semantics(
        button: true,
        label: status == null ? 'You' : 'You, $status',
        excludeSemantics: true,
        onTap: () => openSwarmYou(context),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: () => openSwarmYou(context),
          child: SizedBox.square(
            dimension: minTouchTarget,
            child: Center(
              child: SwarmAvatar(
                id: me?.id ?? 'you',
                name: name,
                picture: me?.avatar,
                size: 30,
                status: me?.status,
              ),
            ),
          ),
        ),
      );
    }

    return KeyedSubtree(
      key: const ValueKey('swarm-you-button'),
      child: session == null
          ? face()
          : ListenWhileInSight(
              listenable: Listenable.merge([session.inbox, session.home]),
              builder: (context) => face(),
            ),
    );
  }
}

/// You, as Tony's prototype C4 draws it (2026-10-30), opened from the avatar
/// on Home and Activity since it stopped being a tab (2026-11-03):
/// who they are in the Swarm Home shows — their face, their name and that
/// Swarm — which opens their profile, where name, username, picture and status
/// are set ([showSwarmProfile]); Your models, with how many of their own
/// machines' models the Swarms can use now, and Your devices, with how many of
/// their own computers are online; then Notifications and Theme, out of
/// Settings, and Settings. Only what is theirs counts: not a teammate's, not
/// one shared with them, not a Harness Team account's (#2253's review). Each
/// count comes from what Home already reads, and none shows before it is read.
///
/// Tony 2026-11-04: the Profile and Username rows under the header opened the
/// same sheet the header now does, so they went; Notifications and Theme came
/// up out of Settings, one tap nearer.
class SwarmYouPage extends StatelessWidget {
  const SwarmYouPage({
    super.key,
    this.onSettings,
    this.notices,
    this.appearance,
    this.now = DateTime.now,
  });

  /// The phone's Settings over the tabs.
  final void Function(BuildContext context)? onSettings;

  /// The phone's notice centre, for Notifications; none shows without it.
  final SystemNotices? notices;

  /// What Theme changes: [appearancePrefsStore] unless a test hands in its
  /// own, so a tap there never writes to the developer's own state file.
  final AppearancePrefsStore? appearance;

  /// What a model's reading is fresh against.
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    final computers = SwarmScope.computersOf(context);
    // Opened over a page, as the avatar opens it: back to it.
    final pushed = ModalRoute.isFirstOf(context) == false;
    return Scaffold(
      backgroundColor: Tty.of(context).ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (pushed)
              SwarmTopBar(
                leading: SwarmBackButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
                title: 'You',
              )
            else
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
    // Who you are: in the Swarm Home shows alone, else the first. A read
    // taken away keeps nothing of the person or the Swarm.
    final (:me, swarm: you) = swarmYouOf(session);
    final navigator = Navigator.of(context);
    void open(Widget page) => unawaited(
      navigator.push(phoneRoute((_) => page, listensForItself: true)),
    );
    final notices = this.notices;
    return [
      _Me(
        key: const ValueKey('swarm-you-me'),
        me: me,
        swarm: me == null ? null : you!.name,
        // Nothing to set before the Swarm is read, or once it is taken away.
        onTap: me == null
            ? null
            : () => unawaited(showSwarmProfile(context, swarmId: you!.id)),
      ),
      const SizedBox(height: AppSpace.l),
      SwarmGroup(
        children: [
          SwarmRow(
            key: const ValueKey('swarm-you-models'),
            leading: const SwarmRowGlyph(LucideIcons.cpu300),
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
            leading: const SwarmRowGlyph(LucideIcons.laptop300),
            title: 'Your devices',
            detail: switch (_devices(computers)) {
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
          // The terminal Settings' own row, drawn as Swarm's ([SettingsSwarmLook]).
          if (notices != null)
            SettingsSwarmLook(
              child: NotificationsSettingsRow(
                key: const ValueKey('swarm-you-notifications'),
                notices: notices,
              ),
            ),
          _Theme(
            key: const ValueKey('swarm-you-theme'),
            store: appearance ?? appearancePrefsStore,
          ),
          SwarmRow(
            key: const ValueKey('swarm-you-settings'),
            leading: const SwarmRowGlyph(LucideIcons.settings300),
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

  /// How many models every Swarm read can use now from the person's own
  /// machines; null while none is read with its models on.
  int? _models(SwarmInbox? inbox, List<SwarmListing> swarms) {
    int? count;
    for (final swarm in swarms) {
      final reader = inbox?.reader(swarm.id);
      final snapshot = reader == null || reader.accessRevoked
          ? null
          : reader.snapshot;
      if (snapshot == null) continue;
      final mine = swarmModelList(
        snapshot,
        now: now(),
        lentBy: reader!.accountId,
      );
      if (mine case final list?) {
        count =
            (count ?? 0) +
            list.apis.length +
            list.local.length +
            list.oneComputer.length;
      }
    }
    return count;
  }

  /// "2 online · 1 offline", of the person's own computers ([SwarmComputers.own]);
  /// null before the account's computers are read.
  static String? _devices(SwarmComputers? computers) {
    if (computers?.computers == null) return null;
    final own = computers!.own;
    if (own.isEmpty) return 'No computers yet';
    final away = own.where((computer) => computer.away).length;
    final online = own.length - away;
    return [
      if (online > 0) '$online online',
      if (away > 0) '$away offline',
    ].join(' · ');
  }
}

/// The person at the top of You: their face, their name and the Swarm it is
/// in; "You" alone before a Swarm is read with them in it. A tap ([onTap])
/// opens their profile, and a chevron says so; none before they are read.
class _Me extends StatelessWidget {
  const _Me({
    super.key,
    required this.me,
    required this.swarm,
    required this.onTap,
  });

  final SuperTabPerson? me;
  final String? swarm;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final me = this.me;
    final onTap = this.onTap;
    // A Home kept for a cold start holds no email.
    final name = me == null || me.email.isEmpty ? 'You' : me.shownName;
    final header = Padding(
      // On the right as far in as a card's rows, so its chevron stands over
      // theirs.
      padding: const EdgeInsets.fromLTRB(
        AppSpace.xs,
        AppSpace.s,
        AppSpace.l,
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
          if (onTap != null) ...[
            const SizedBox(width: AppSpace.m),
            Icon(
              LucideIcons.chevronRight300,
              size: 18,
              color: AppPalette.textFaint,
            ),
          ],
        ],
      ),
    );
    if (onTap == null) return header;
    return Semantics(
      button: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppCard.radius),
          onTap: onTap,
          child: header,
        ),
      ),
    );
  }
}

/// Light or dark: System | Dark | Light (#2920), on You since 2026-11-04,
/// out of Swarm's Settings.
///
/// One tap, and every screen turns at once — the page behind is the preview —
/// except the terminal's page, which keeps the dark side
/// ([AppearancePrefs.terminalPalette]). Dark and Light keep the palette the
/// terminal Settings' App colors chose while it is on their side, else
/// Graphite and Paper. System follows the phone as it turns. Until it is
/// touched, the control shows the side the palette is on, which is what that
/// answer would draw.
class _Theme extends StatelessWidget {
  const _Theme({super.key, required this.store});

  final AppearancePrefsStore store;

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<AppearancePrefs>(
    valueListenable: store,
    builder: (context, prefs, _) {
      AppTheme.watch(context);
      return SwarmRow(
        leading: const SwarmRowGlyph(LucideIcons.sunMoon300),
        title: 'Theme',
        // A little over half the row, so the title keeps its word at the
        // largest text size; past that the control shrinks rather than
        // pushing the row over its edge.
        trailing: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.sizeOf(context).width * .55,
          ),
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: SwarmSegments<AppThemeMode>(
              values: AppThemeMode.values,
              selected: prefs.shownThemeMode,
              label: (mode) => mode.label,
              onSelected: (mode) => unawaited(store.setThemeMode(mode)),
            ),
          ),
        ),
        onTap: null,
      );
    },
  );
}
