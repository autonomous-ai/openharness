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
import 'swarm_drawer.dart';
import 'swarm_home_keeper.dart';
import 'swarm_home_list.dart';
import 'swarm_home_rows.dart';
import 'swarm_inbox.dart';
import 'swarm_needs_page.dart';
import 'swarm_profile_sheet.dart';
import 'swarm_project_page.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';
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

/// Swarm Home, direction B (Tony's prototype B1, 2026-10-29): what needs the
/// person ("Needs you", two of it and See all), then the projects they
/// pinned on this phone, then the others by their latest activity, those
/// quiet for a day folded under "Other projects" ([swarmHomeLists]). Every
/// Swarm's, or the one the drawer picked ([SwarmHomePrefs.swarmId]). Its
/// drawer ([SwarmDrawer]) is the way to everything else.
///
/// The phone's Home while Settings ▸ Experimental ▸ Swarm is on; pushed over
/// another page it has a back button instead of the drawer. Its top bar holds
/// the menu and its title in one line, as the approved prototype draws it.
/// Reads the account's [SwarmSession] from the shell; with none, says why.
class SwarmPage extends StatefulWidget {
  const SwarmPage({super.key, this.onSettings, this.now = DateTime.now});

  /// Settings over Swarm Home, from the drawer.
  final void Function(BuildContext context)? onSettings;

  /// What a project's last move is measured from.
  final DateTime Function() now;

  /// How many needs Home shows before See all.
  static const needsShown = 2;

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

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    final hidden = OutOfSight.of(context);
    if (session == _session && hidden == _hidden) return;
    if (!_hidden) _session?.leave();
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
      // Home's drawer; a Swarm page pushed over another page has its back
      // button instead. None out of sight: one closing as Harness took the
      // screen would stop there, its animation off, and be found half open.
      drawer: pushed || _hidden
          ? null
          : ListenableBuilder(
              listenable: listens ?? const _Nothing(),
              builder: (context, _) => SwarmDrawer(
                session: session,
                onSettings: widget.onSettings,
                onProfile: (swarmId) =>
                    unawaited(showSwarmProfile(context, swarmId: swarmId)),
              ),
            ),
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

  /// Home's top bar: the menu or back button and its title, with a quiet
  /// "Updating…" under it while it shows the Home kept ([_updating]).
  Widget _topBar(
    BuildContext context, {
    required bool pushed,
    bool updating = false,
  }) => SwarmTopBar(
    leading: pushed
        ? SwarmBackButton(onPressed: () => Navigator.of(context).maybePop())
        : const _MenuButton(),
    title: 'Swarm',
    subtitle: updating ? 'Updating…' : null,
  );

  /// The Swarms Home shows: the one the drawer picked while it is listed,
  /// else all of them.
  List<SwarmListing> _shown(SwarmSession session) {
    final swarms = session.inbox.swarms;
    final picked = session.home.swarmId;
    final one = swarms.where((swarm) => swarm.id == picked).toList();
    return one.isEmpty ? swarms : one;
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
    final first = notice == null;
    return [
      ?notice,
      if (error != null) _error(error, key: 'swarm-error'),
      ..._needs(context, session, shown, picked, now, first: first),
      ..._projects(context, session, shown, now),
    ];
  }

  /// Needs you: two of what waits on the person, newest asks first, each a
  /// row that opens it among the rest; See all for every one.
  List<Widget> _needs(
    BuildContext context,
    SwarmSession session,
    List<SwarmListing> shown,
    String? picked,
    DateTime now, {
    required bool first,
  }) {
    final inbox = session.inbox;
    final needs = swarmNeedsOf(inbox, picked);
    return [
      SwarmCaption('Needs you', count: needs.length, first: first),
      if (needs.isNotEmpty)
        SwarmGroup(
          children: [
            for (final need in needs.take(SwarmPage.needsShown))
              SwarmHomeNeedRow(
                key: ValueKey('swarm-home-need-${need.key}'),
                session: session,
                need: need,
                now: now,
                onTap: () =>
                    openSwarmNeeds(context, focus: need.key, swarmId: picked),
              ),
            if (needs.length > SwarmPage.needsShown)
              SwarmSeeAllRow(
                key: const ValueKey('swarm-needs-all'),
                count: needs.length,
                onTap: () => openSwarmNeeds(context, swarmId: picked),
              ),
          ],
        )
      else
        switch (_emptyNeeds(inbox, shown)) {
          _EmptyNeeds.reading => SwarmSkeletonRows(
            id: 'swarm-needs-loading',
            rows: 1,
          ),
          _EmptyNeeds.unread => _error(
            'Could not load what is waiting for you. Try again.',
            key: 'swarm-needs-unread',
            top: 0,
          ),
          _EmptyNeeds.none => Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
            child: SwarmRow.line(
              'Nothing needs you.',
              key: const ValueKey('swarm-needs-none'),
            ),
          ),
        },
    ];
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

  /// A long press on a project: Pin to top, or Unpin.
  Future<void> _pin(
    BuildContext context,
    SwarmSession session,
    SwarmHomeProject project,
  ) async {
    final pinned = session.home.pinned(project.swarmId, project.project.id);
    final tapped = await showSwarmPinSheet(
      context,
      name: project.project.name,
      pinned: pinned,
    );
    if (tapped != true || !mounted || _session != session) return;
    session.home.pin(project.swarmId, project.project.id, !pinned);
  }

  /// Home before the list answers: Needs you and the projects as rows on
  /// their way, in the order Home shows them; under a card, its first
  /// caption not [first].
  List<Widget> _reading({bool first = true}) => [
    SwarmCaption('Needs you', first: first),
    SwarmSkeletonRows(id: 'swarm-needs-loading', rows: 1),
    const SwarmCaption('Projects'),
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

/// Nothing to listen to: a drawer with no session.
class _Nothing implements Listenable {
  const _Nothing();

  @override
  void addListener(VoidCallback listener) {}

  @override
  void removeListener(VoidCallback listener) {}
}

/// Home shows the Home kept, not read again yet: the list not read, or a
/// Swarm on it holding only what was kept. Not while no computer answers:
/// the card says so then ([SwarmConnectionNotice]).
bool _updating(SwarmInbox inbox) =>
    inbox.swarms.isNotEmpty &&
    !inbox.noComputer &&
    (!inbox.loaded ||
        inbox.swarms.any((swarm) => swarmHomeKept(inbox.reader(swarm.id))));

/// Why Needs you is empty.
enum _EmptyNeeds {
  /// A Swarm, or what waits on the person in it, is still being read.
  reading,

  /// Something could not be read: "nothing" is not known.
  unread,

  /// Everything was read, and nothing needs the person.
  none,
}

/// Why [inbox]'s Needs you is empty: still reading while a Swarm [shown],
/// or what waits on the person in it since it was last read in full, is not
/// read yet.
_EmptyNeeds _emptyNeeds(SwarmInbox inbox, List<SwarmListing> shown) {
  var reading = false, unread = false;
  for (final swarm in shown) {
    switch (inbox.reader(swarm.id)) {
      case SwarmReader(snapshot: _?):
        if (inbox.asks(swarm.id) case final asks?) {
          if (asks.loading) {
            reading = true;
          } else if (asks.error != null) {
            unread = true;
          }
        }
      case SwarmReader(error: _?):
        unread = true;
      case _:
        reading = true;
    }
  }
  if (reading) return _EmptyNeeds.reading;
  return unread ? _EmptyNeeds.unread : _EmptyNeeds.none;
}

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

/// Opens Home's drawer: the top bar's 44-point box, the drawer's mark.
class _MenuButton extends StatelessWidget {
  const _MenuButton();

  @override
  Widget build(BuildContext context) => SwarmIconButton(
    key: const ValueKey('swarm-menu'),
    icon: LucideIcons.menu300,
    size: 24,
    label: 'Menu',
    onPressed: () => Scaffold.of(context).openDrawer(),
  );
}
