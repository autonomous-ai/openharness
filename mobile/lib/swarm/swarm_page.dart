import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_connection_notice.dart';
import 'swarm_home_keeper.dart';
import 'swarm_home_list.dart';
import 'swarm_home_rows.dart';
import 'swarm_home_top.dart';
import 'swarm_inbox.dart';
import 'swarm_jump_page.dart';
import 'swarm_needs_page.dart';
import 'swarm_project_page.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';
import 'swarm_tabs.dart';
import 'swarm_unread.dart';
import 'team_glance.dart';

/// Swarm Home from anywhere in the shell: every page closed and Swarm Home
/// the root again ([PhoneShellScope.onShowSwarm]). Without the shell — a
/// page pumped on its own — a Swarm page over [context]'s.
void openSwarmHome(BuildContext context) {
  if (PhoneShellScope.maybeOf(context)?.onShowSwarm case final show?) {
    show();
    return;
  }
  unawaited(Navigator.of(context).push(phoneRoute((_) => const SwarmPage())));
}

/// Whether Home still lists project [projectId] of Swarm [swarmId]: the
/// Swarm is still the account's, its read not taken away, and the project
/// still in it.
bool swarmHomeListed(SwarmInbox inbox, String swarmId, String projectId) {
  final reader = inbox.reader(swarmId);
  return reader != null &&
      !reader.accessRevoked &&
      inbox.swarms.any((swarm) => swarm.id == swarmId) &&
      (reader.snapshot?.projects.any((p) => p.id == projectId) ?? false);
}

/// Swarm Home, direction C (Tony's prototype C1, 2026-10-30), the Home tab:
/// its title the Swarm shown, a switcher to every Swarm, All Swarms and Join
/// or create ([showSwarmSwitcher]), and compose at its end; Jump to…; While
/// you were away, once the person has been gone a while ([SwarmAwayCard]);
/// then the projects they pinned on this phone, then the others by their
/// latest activity, those quiet for a day folded under "Other projects"
/// ([swarmHomeLists]). Every Swarm's, or the one picked
/// ([SwarmHomePrefs.swarmId]). What needs the person is the Activity tab's;
/// who they are, their models and devices, and Settings, the You tab's.
///
/// Threads, and While you were away's new threads, wait for a read of the
/// threads with new replies across a Swarm, which the server does not have
/// yet (Lead, 2026-10-30): the phone reads no chat by chat for them.
///
/// Pushed over another page it has a back button instead of the switcher.
/// Reads the account's [SwarmSession] from the shell; with none, says why.
class SwarmPage extends StatefulWidget {
  const SwarmPage({super.key, this.now = DateTime.now});

  /// What a project's last move, and the time away, is measured from.
  final DateTime Function() now;

  /// Gone for less is no time away: no card.
  static const awayAfter = Duration(minutes: 5);

  @override
  State<SwarmPage> createState() => _SwarmPageState();
}

class _SwarmPageState extends State<SwarmPage> {
  SwarmSession? _session;

  /// Kept out of sight under Harness ([OutOfSight]), as it was left: it is no
  /// Swarm screen meanwhile — a notice still tells what arrives — and draws
  /// nothing new. Shown again, it reads the Swarms as on any return to Home.
  bool _hidden = false;

  /// Each project's "2m" moves on with the clock: Home is drawn again every
  /// minute while it is in sight.
  Timer? _tick;

  /// When the person last left the app, as read when Home first drew and
  /// each time the app came back: what While you were away counts from.
  DateTime? _away;
  bool _awayRead = false;

  /// When the person came back: the app shown again, or Home opened for the
  /// account. Time away ends there, so using the app on never adds to it.
  DateTime? _back;

  /// The app leaving and coming back: the first is when the person left
  /// ([SwarmHomePrefs.seen]), the second when they came back, and reads
  /// when they left again.
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onHide: () => _session?.home.seen(widget.now()),
      onShow: () => setState(() {
        _awayRead = false;
        _back = widget.now();
      }),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    final hidden = OutOfSight.of(context);
    if (session == _session && hidden == _hidden) return;
    if (!_hidden) _session?.leave();
    // Another account's Home: its own time away, from now.
    if (session != _session) {
      _awayRead = false;
      _back = widget.now();
    }
    _session = session;
    _hidden = hidden;
    _tick?.cancel();
    _tick = null;
    if (hidden || session == null) return;
    session.enter();
    unawaited(session.inbox.refresh());
    _tick = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _tick?.cancel();
    if (!_hidden) _session?.leave();
    super.dispose();
  }

  void _openProject(BuildContext context, String swarmId, String projectId) =>
      unawaited(
        Navigator.of(context).push(
          phoneRoute(
            (_) => SwarmProjectPage(swarmId: swarmId, projectId: projectId),
            listensForItself: true,
          ),
        ),
      );

  /// The projects quiet for a day are listed under Other projects.
  bool _quietOpen = false;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = _session;
    // Pushed over another page: a page under Home's own route, never one over
    // it. Home builds while a page slides in over it (a Buddy chat opening),
    // and is not built again once that page goes, so the navigator's canPop
    // would leave the back button for good.
    final pushed = ModalRoute.isFirstOf(context) == false;
    final listens = session == null
        ? null
        : Listenable.merge([session, session.inbox, session.home]);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (session == null)
              _topBar(context, pushed: pushed)
            else
              ListenWhileInSight(
                listenable: listens!,
                builder: (context) => _topBar(
                  context,
                  pushed: pushed,
                  updating: _updating(session.inbox),
                ),
              ),
            Expanded(
              child: session == null
                  ? const _Unavailable()
                  : ListenWhileInSight(
                      listenable: listens!,
                      // Before there is a Swarm to show, a start screen in
                      // place of the body, under the same top bar.
                      builder: (context) =>
                          swarmStartView(context, session) ??
                          RefreshIndicator(
                            onRefresh: session.inbox.refresh,
                            child: ListView(
                              physics: const AlwaysScrollableScrollPhysics(),
                              padding: EdgeInsets.fromLTRB(
                                AppSpace.m,
                                0,
                                AppSpace.m,
                                MediaQuery.paddingOf(context).bottom +
                                    AppSpace.xl,
                              ),
                              children: _body(context, session),
                            ),
                          ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  /// Home's top bar. At the root, the tab's title: the Swarm shown, a button
  /// to switch it, and compose; pushed over another page, back and "Swarm".
  /// Either has a quiet "Updating…" under it while it shows the Home kept
  /// ([_updating]).
  Widget _topBar(
    BuildContext context, {
    required bool pushed,
    bool updating = false,
  }) {
    final session = _session;
    if (pushed) {
      return SwarmTopBar(
        leading: SwarmBackButton(
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: 'Swarm',
        subtitle: updating ? 'Updating…' : null,
      );
    }
    if (session == null) return const SwarmTabHeader('Swarm');
    final shown = _shown(session);
    final title = swarmHomeTitle(session.inbox, shown);
    // The one Swarm named has its tile; All Swarms has none.
    final named = swarmHomeNamed(session.inbox, shown);
    return SwarmTabHeader(
      title,
      leading: named == null ? null : SwarmProjectTile(named.name),
      titleLabel: 'Swarm: $title. Switch Swarm',
      subtitle: updating ? 'Updating…' : null,
      onTitle: () => unawaited(showSwarmSwitcher(context, session)),
      trailing: SwarmIconButton(
        key: const ValueKey('swarm-compose'),
        icon: LucideIcons.squarePen300,
        label: 'New message',
        onPressed: () => openSwarmJump(context, compose: true),
      ),
    );
  }

  /// The Swarms Home shows: the one the switcher picked while it is listed
  /// and its read not taken away, else all of them.
  List<SwarmListing> _shown(SwarmSession session) {
    final inbox = session.inbox;
    final picked = session.home.swarmId;
    if (picked == null || !swarmHomeOffers(inbox, picked)) return inbox.swarms;
    return [
      for (final swarm in inbox.swarms)
        if (swarm.id == picked) swarm,
    ];
  }

  List<Widget> _body(BuildContext context, SwarmSession session) {
    final inbox = session.inbox;
    // No computer answering: a card that says so over what Home has, never a
    // screen in its place, and no red line besides.
    final notice = inbox.noComputer
        ? SwarmConnectionNotice(
            inbox: inbox,
            computers: SwarmScope.computersOf(context),
          )
        : null;
    final error = notice == null ? inbox.error : null;
    // Before the list there is nothing to read, unless a Home was kept; a
    // list that could not be read says so alone, without rows on their way.
    if (!inbox.loaded && inbox.swarms.isEmpty) {
      return [
        ?notice,
        if (error != null)
          _error(error, key: 'swarm-error')
        else
          ..._reading(first: notice == null),
      ];
    }
    final shown = _shown(session);
    final picked = shown.length == 1 && inbox.swarms.length > 1
        ? shown.single.id
        : null;
    final now = widget.now();
    return [
      ?notice,
      if (error != null) _error(error, key: 'swarm-error'),
      Padding(
        padding: EdgeInsets.only(
          top: notice == null ? AppSpace.xs : AppSpace.m,
          bottom: AppSpace.xs,
        ),
        child: SwarmJumpField(
          key: const ValueKey('swarm-jump'),
          onTap: () => openSwarmJump(context),
        ),
      ),
      ?_awayCard(context, session, shown, picked, now),
      ..._projects(context, session, shown, now),
    ];
  }

  /// While you were away, once the person has been gone [SwarmPage.awayAfter]
  /// or more: the work done since in the Swarms shown and what needs them
  /// there now, each unknown while a Swarm, or what waits in it, is not read.
  /// A tap opens Activity.
  Widget? _awayCard(
    BuildContext context,
    SwarmSession session,
    List<SwarmListing> shown,
    String? picked,
    DateTime now,
  ) {
    final home = session.home;
    if (!_awayRead && home.loaded) {
      _away = home.seenAt;
      _awayRead = true;
    }
    final since = _away;
    // Decided at the return: time in the foreground is no time away.
    final back = _back ?? now;
    if (since == null || back.difference(since) < SwarmPage.awayAfter) {
      return null;
    }
    final inbox = session.inbox;
    // A Swarm not read, or out of reach, leaves the work done unknown.
    int? done = 0;
    for (final swarm in shown) {
      final reader = inbox.reader(swarm.id);
      final snapshot = reader == null || reader.accessRevoked
          ? null
          : reader.snapshot;
      done = snapshot == null ? null : done! + swarmDoneSince(snapshot, since);
      if (done == null) break;
    }
    final needs = swarmNeedsOf(inbox, picked).length;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpace.s),
      child: SwarmAwayCard(
        key: const ValueKey('swarm-away'),
        since: since,
        back: back,
        done: done,
        // None found is not none waiting until all of it is read.
        needs: needs > 0 || _needsRead(inbox, shown) ? needs : null,
        onTap: () {
          if (!showSwarmTab(context, SwarmTab.activity)) {
            openSwarmNeeds(context, swarmId: picked);
          }
        },
      ),
    );
  }

  /// Pinned, then Projects: every project of the Swarms shown, grouped by
  /// [swarmHomeLists]; a Swarm still to be read has rows on their way, one
  /// that could not be read says so.
  List<Widget> _projects(
    BuildContext context,
    SwarmSession session,
    List<SwarmListing> shown,
    DateTime now,
  ) {
    final inbox = session.inbox;
    if (inbox.swarms.isEmpty) {
      return [
        const SwarmCaption('Projects'),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
          child: SwarmRow.line(
            'No Swarm yet. Start one on your computer.',
            lines: 2,
          ),
        ),
      ];
    }
    final several = shown.length > 1;
    final projects = <SwarmHomeProject>[];
    final glances = <String, SwarmTeamGlance>{};
    final names = <String, String>{};
    final reading = <String>[];
    final failed = <(String, String)>[];
    for (final swarm in shown) {
      switch (inbox.reader(swarm.id)) {
        case final SwarmReader reader when reader.snapshot != null:
          final snapshot = reader.snapshot!;
          final news = swarmProjectNews(reader, inbox.asks(swarm.id));
          final activity = swarmProjectActivity(snapshot, reader.buddies);
          for (final project in snapshot.projects) {
            final row = SwarmHomeProject(
              swarmId: swarm.id,
              project: project,
              active: activity[project.id],
              news: news[project.id] ?? swarmNoNews,
            );
            projects.add(row);
            glances[row.key] = swarmTeamGlance(snapshot, projectId: project.id);
            names[row.key] = swarm.name;
          }
        case SwarmReader(error: final error?):
          failed.add((swarm.id, error));
        case _:
          reading.add(swarm.id);
      }
    }
    final lists = swarmHomeLists(projects, pins: session.home.pins, now: now);
    Widget row(SwarmHomeProject project) => SwarmHomeProjectRow(
      key: ValueKey('swarm-project-${project.swarmId}-${project.project.id}'),
      project: project,
      glance: glances[project.key]!,
      now: now,
      swarmName: several ? names[project.key] : null,
      onTap: () => _openProject(context, project.swarmId, project.project.id),
      onLongPress: () => unawaited(_pin(context, session, project)),
    );
    final quiet = lists.quiet;
    final empty = projects.isEmpty && reading.isEmpty && failed.isEmpty;
    return [
      if (lists.pinned.isNotEmpty) ...[
        const SwarmCaption('Pinned'),
        SwarmGroup(children: [for (final p in lists.pinned) row(p)]),
      ],
      if (lists.recent.isNotEmpty || quiet.isNotEmpty || empty) ...[
        const SwarmCaption('Projects'),
        SwarmGroup(
          children: [
            if (empty) const SwarmRow(title: 'No project yet', onTap: null),
            for (final p in lists.recent) row(p),
            if (quiet.isNotEmpty) ...[
              SwarmOtherProjectsRow(
                key: const ValueKey('swarm-other-projects'),
                count: quiet.length,
                open: _quietOpen,
                onTap: () => setState(() => _quietOpen = !_quietOpen),
              ),
              if (_quietOpen)
                for (final p in quiet) row(p),
            ],
          ],
        ),
      ] else if (reading.isNotEmpty || failed.isNotEmpty)
        const SwarmCaption('Projects'),
      for (final (i, id) in reading.indexed) ...[
        if (projects.isNotEmpty || i > 0) const SizedBox(height: 8),
        SwarmSkeletonRows(id: 'swarm-projects-loading-$id'),
      ],
      for (final (id, error) in failed) ...[
        const SizedBox(height: 8),
        SwarmGroup(
          key: ValueKey('swarm-projects-error-$id'),
          children: [
            SwarmRow(
              title: error,
              detail: SwarmRow.line('Pull down to try again.'),
              onTap: null,
            ),
          ],
        ),
      ],
    ];
  }

  /// A long press on a project: Pin to top, or Unpin. The project taken away
  /// meanwhile — its Swarm or itself — closes the sheet, and pins nothing.
  Future<void> _pin(
    BuildContext context,
    SwarmSession session,
    SwarmHomeProject project,
  ) async {
    final (swarmId, projectId) = (project.swarmId, project.project.id);
    final inbox = session.inbox;
    bool listed() => swarmHomeListed(inbox, swarmId, projectId);
    final pinned = session.home.pinned(swarmId, projectId);
    final tapped = await showSwarmPinSheet(
      context,
      name: project.project.name,
      pinned: pinned,
      // The read itself, as its revoke tells at once; the inbox for the list.
      watch: Listenable.merge([inbox, ?inbox.reader(swarmId)]),
      listed: listed,
    );
    if (tapped != true || !mounted || _session != session || !listed()) return;
    session.home.pin(swarmId, projectId, !pinned);
  }

  /// Home before the list answers: the projects as rows on their way; under
  /// a card, its caption not [first].
  List<Widget> _reading({bool first = true}) => [
    SwarmCaption('Projects', first: first),
    SwarmSkeletonRows(id: 'swarm-projects-loading'),
  ];

  /// What went wrong, in the danger colour, up to three lines.
  Widget _error(String text, {required String key, double top = 6}) => Padding(
    padding: EdgeInsets.fromLTRB(AppSpace.xs, top, AppSpace.xs, 0),
    child: SwarmRow.line(
      text,
      key: ValueKey(key),
      lines: 3,
      color: AppColors.danger,
    ),
  );
}

/// Home shows the Home kept, not read again yet: the list not read, or a
/// Swarm on it holding only what was kept. Not while no computer answers:
/// the card says so then ([SwarmConnectionNotice]).
bool _updating(SwarmInbox inbox) =>
    inbox.swarms.isNotEmpty &&
    !inbox.noComputer &&
    (!inbox.loaded ||
        inbox.swarms.any((swarm) => swarmHomeKept(inbox.reader(swarm.id))));

/// Whether what waits on the person in every Swarm [shown] is read: the
/// Swarm, and what waits in it since it was last read in full.
bool _needsRead(SwarmInbox inbox, List<SwarmListing> shown) => shown.every(
  (swarm) => switch (inbox.reader(swarm.id)) {
    SwarmReader(snapshot: _?, accessRevoked: false) => switch (inbox.asks(
      swarm.id,
    )) {
      null => true,
      final asks => !asks.loading && asks.error == null,
    },
    _ => false,
  },
);

/// No session: Swarm is off, or nobody is signed in on this phone.
class _Unavailable extends StatelessWidget {
  const _Unavailable();

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(
      AppSpace.screenInset,
      AppSpace.s,
      AppSpace.screenInset,
      AppSpace.xl,
    ),
    children: [
      Text(
        'Swarm is off on this phone, or you are signed out. '
        'Turn it on in Settings ▸ Experimental.',
        key: const ValueKey('swarm-unavailable'),
        style: AppType.body(color: AppPalette.textSecondary, height: 1.45),
      ),
    ],
  );
}
