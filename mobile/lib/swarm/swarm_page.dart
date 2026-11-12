import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart' show TtySize;
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

import 'model.dart';
import 'swarm_agent_state.dart';
import 'swarm_agents.dart';
import 'swarm_home_list.dart';
import 'swarm_home_rows.dart';
import 'swarm_home_top.dart';
import 'swarm_inbox.dart';
import 'swarm_mark_all.dart';
import 'swarm_new_project_sheet.dart';
import 'swarm_project_page.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_home_view_sheet.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';
import 'swarm_team.dart';
import 'swarm_unread.dart';
import 'swarm_you_page.dart' show SwarmYouButton;

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

/// Swarm Home, direction C (Tony's prototype C1, 2026-10-30) tuned as
/// Slack's (2026-11-03): its title the Swarm shown, with a
/// switcher to every Swarm, All Swarms and Join or create
/// ([showSwarmSwitcher]), then the person's avatar, which opens You
/// ([SwarmYouButton]); a pull down at the top reads the Swarms again; then
/// the projects they pinned on this phone, one line each, then the others by
/// their latest activity, those quiet for a day folded under "Other projects"
/// ([swarmHomeLists]), Sort and filter at the right of their first caption.
/// Every Swarm's, or the one picked ([SwarmHomePrefs.swarmId]).
///
/// Pushed over another page it has a back button instead of the switcher.
/// Reads the account's [SwarmSession] from the shell; with none, its skeleton
/// while the account is on its way ([SwarmScope.accountComingOf]), else says
/// why.
class SwarmPage extends StatefulWidget {
  const SwarmPage({super.key, this.now = DateTime.now});

  /// What a project's last move is measured from.
  final DateTime Function() now;

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
      openSwarmProject(context, swarmId: swarmId, projectId: projectId);

  /// The Swarms, by id, whose projects quiet for a day are listed under
  /// Other projects.
  final _quietOpen = <String>{};

  /// The Swarms, by id, whose Your Team shows every row, past "N more".
  final _teamOpen = <String>{};

  /// An agent's own chat with the person, from its row in Your Team.
  void _openChat(BuildContext context, String swarmId, String chatId) =>
      unawaited(
        Navigator.of(context)
            .push(swarmChatRoute(swarmId: swarmId, conversationId: chatId)),
      );

  /// Refresh, from Sort and filter, reads the Swarms, as a pull on Home does;
  /// with no computer answering, after looking for the computers, whatever
  /// that finds. A toast says it is on its way.
  Future<void> _refresh(BuildContext context, SwarmSession session) async {
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        const SnackBar(
          key: ValueKey('swarm-refresh-toast'),
          duration: Duration(seconds: 2),
          content: Text('Refreshing…'),
        ),
      );
    await _pulled(context, session);
  }

  /// Reads the Swarms; with no computer answering, after looking for the
  /// computers, whatever that finds.
  Future<void> _pulled(BuildContext context, SwarmSession session) async {
    final inbox = session.inbox;
    if (inbox.noComputer) {
      try {
        await SwarmScope.computersOf(context)?.recheck();
      } catch (failure) {
        appLog.warn('swarm', 'Computers not looked for', error: failure);
      }
    }
    await inbox.refreshAll();
  }

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
                builder: (context) => _topBar(context, pushed: pushed),
              ),
            Expanded(
              child: session == null
                  ? SwarmScope.accountComingOf(context)
                        ? ListView(
                            key: const ValueKey('swarm-account-coming'),
                            padding: _listPadding(context),
                            children: _reading(),
                          )
                        : const _Unavailable()
                  : ListenWhileInSight(
                      listenable: listens!,
                      // Before there is a Swarm to show, a start screen in
                      // place of the body, under the same top bar.
                      builder: (context) =>
                          swarmStartView(context, session) ??
                          _list(context, session, pushed: pushed),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  /// Home's list, pulled down at its top, reads the Swarms again; pushed,
  /// with no Sort and filter.
  Widget _list(
    BuildContext context,
    SwarmSession session, {
    required bool pushed,
  }) => RefreshIndicator(
    onRefresh: () => _pulled(context, session),
    child: ListView(
      key: const ValueKey('swarm-home-list'),
      physics: const AlwaysScrollableScrollPhysics(),
      padding: _listPadding(context),
      children: _body(context, session, pushed: pushed),
    ),
  );

  /// Around Home's rows: the last clears the phone's home indicator.
  EdgeInsets _listPadding(BuildContext context) => EdgeInsets.fromLTRB(
    AppSpace.m,
    0,
    AppSpace.m,
    MediaQuery.paddingOf(context).bottom + AppSpace.xl,
  );

  /// Home's top bar. At the root, the tab's title: the Swarm shown and a
  /// button to switch it; pushed over another page, back and "Swarm".
  Widget _topBar(BuildContext context, {required bool pushed}) {
    final session = _session;
    if (pushed) {
      return SwarmTopBar(
        leading: SwarmBackButton(
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: 'Swarm',
      );
    }
    if (session == null) {
      if (!SwarmScope.accountComingOf(context)) {
        return const SwarmTabHeader('Swarm', trailing: SwarmYouButton());
      }
      // Where the Swarm's name will be: its button has nothing to switch yet.
      return SwarmTabHeader(
        'Swarm',
        loading: true,
        leading: _loadingTile,
        titleLabel: 'Loading your Swarm',
        onTitle: () {},
        trailing: const SwarmYouButton(),
      );
    }
    final shown = _shown(session);
    final title = swarmHomeTitle(session.inbox, shown);
    // The one Swarm named has its tile; All Swarms has none.
    final named = swarmHomeNamed(session.inbox, shown);
    // A start screen in the body has no Swarm coming to name.
    final listing =
        swarmHomeListing(session.inbox) &&
        swarmStartView(context, session) == null;
    return SwarmTabHeader(
      title,
      trailing: const SwarmYouButton(),
      loading: listing,
      leading: listing
          ? _loadingTile
          : named == null
          ? null
          : SwarmProjectTile(named.name),
      titleLabel: listing
          ? 'Loading your Swarm. Switch Swarm'
          : 'Swarm: $title. Switch Swarm',
      onTitle: () => unawaited(
        showSwarmSwitcher(
          context,
          session,
          onView: () => _openView(context, session),
          agents: swarmAgentsOf(context),
          // For someone who may write in a Swarm shown: never a viewer.
          offersNewProject: () => _shown(session)
              .any((swarm) => swarmMayCreateProject(session.inbox, swarm.id)),
          onNewProject: () => unawaited(_newProject(session, _shown(session))),
        ),
      ),
    );
  }

  /// Sort and filter, from the Swarm switcher (anh Dee, 2026-11-04: no
  /// filter icon on Home; its row has the dot and the words). Mark all read
  /// and Refresh are in its sheet, Mark all read greyed with nothing unread
  /// in the Swarms shown.
  void _openView(BuildContext context, SwarmSession session) => unawaited(
    showSwarmHomeViewSheet(
      context,
      session,
      unread: () => swarmAnyUnread([
        for (final swarm in _shown(session)) ?session.inbox.reader(swarm.id),
      ]),
      onMarkAllRead: () => _markAllRead(context, session, _shown(session)),
      onRefresh: () => unawaited(_refresh(context, session)),
    ),
  );

  /// Mark all read over the Swarms [shown]: every chat read on this phone at
  /// once, with an Undo while the marks wait to be sent.
  void _markAllRead(
    BuildContext context,
    SwarmSession session,
    List<SwarmListing> shown,
  ) {
    final held = session.markAllRead([for (final swarm in shown) swarm.id]);
    if (held == null) return;
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          key: const ValueKey('swarm-mark-all-toast'),
          duration: session.markAllHold,
          // With its Undo it would stay until dismissed; it goes with the
          // marks ([SwarmMarkAllToast]), and after its time as a backstop.
          persist: false,
          content: SwarmMarkAllToast(held),
          action: SnackBarAction(label: 'Undo', onPressed: held.undo),
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

  /// Pushed over another page ([pushed]), its projects have no Sort and
  /// filter.
  List<Widget> _body(
    BuildContext context,
    SwarmSession session, {
    required bool pushed,
  }) {
    final inbox = session.inbox;
    // A list that could not be read, no computer answering included, says
    // nothing here: it is in the app's log and read again soon, Home as it
    // was until then. Only a server without the list says so, as no read will
    // ever bring its rows.
    if (!inbox.loaded && inbox.swarms.isEmpty) {
      return [
        if (inbox.error == swarmServerTooOld)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.s,
              AppSpace.xs,
              0,
            ),
            child: SwarmRow.line(
              swarmServerTooOld,
              key: const ValueKey('swarm-too-old'),
              lines: 3,
            ),
          )
        else
          ..._reading(),
      ];
    }
    return [
      if (!pushed) ..._invitations(context, inbox),
      ..._projects(
        context,
        session,
        _shown(session),
        widget.now(),
        first: pushed || inbox.invitations.isEmpty,
      ),
    ];
  }

  /// The invitations to a Swarm waiting on the person's answer, over the
  /// projects: Join, or Not now. None, nothing; nor on a Home pushed over
  /// another page. With no Swarm yet, the start screen has them
  /// ([swarmStartView]).
  List<Widget> _invitations(BuildContext context, SwarmInbox inbox) {
    if (inbox.invitations.isEmpty) return const [];
    final tty = Tty.of(context);
    return [
      const SizedBox(height: AppSpace.s),
      SwarmGroup(
        key: const ValueKey('swarm-home-invitations'),
        children: [
          for (final invitation in inbox.invitations)
            SwarmInvitationRow(
              key: ValueKey('swarm-invitation-${invitation.inviteId}'),
              invitation: invitation,
              joining: inbox.joining.contains(invitation.inviteId),
              onJoin: () => unawaited(inbox.join(invitation)),
              onLater: () => inbox.notNow(invitation),
            ),
        ],
      ),
      if (inbox.joinError case final error?)
        Padding(
          key: const ValueKey('swarm-invitation-error'),
          padding: const EdgeInsets.only(top: AppSpace.s),
          child: Text(
            error,
            style: tty.style(color: tty.red, size: TtySize.meta),
          ),
        ),
    ];
  }

  /// Every project of the Swarms shown, each Swarm's under one small heading,
  /// its name, where Home shows several, and none where it shows one: the
  /// title names it (anh Dee, 2026-11-04: in place of the name on every row,
  /// and of the Projects and Pinned headings). In each Swarm, as
  /// [swarmHomeLists] groups them: its pins first, then the rest, those
  /// quiet for a day folded. A Swarm still to be read has rows on their way
  /// under its heading, a failed read still trying too, as it is in the log;
  /// one no read will bring says so. A filter on says so first, with Show
  /// all, as Home has no filter icon to show it. [first]: nothing is over
  /// them on the screen.
  List<Widget> _projects(
    BuildContext context,
    SwarmSession session,
    List<SwarmListing> shown,
    DateTime now, {
    required bool first,
  }) {
    final inbox = session.inbox;
    const top = SizedBox(height: AppSpace.s);
    if (inbox.swarms.isEmpty) {
      return [
        top,
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
    final home = session.home;
    final filter = home.filter;
    final sections = <(SwarmListing, SwarmHomeLists)>[];
    // Each Swarm's Your Team under Home's filter, with the read it is from.
    final teams = <String, (SwarmReader, List<SwarmTeamMember>)>{};
    var anyTeam = false;
    final reading = <String>{};
    final failed = <String, String>{};
    final asking = <String>{};
    var any = false;
    for (final swarm in shown) {
      if (inbox.asks(swarm.id)?.loading ?? false) asking.add(swarm.id);
      switch (inbox.reader(swarm.id)) {
        case final SwarmReader reader when reader.snapshot != null:
          final snapshot = reader.snapshot!;
          final news = swarmProjectNews(reader, inbox.asks(swarm.id));
          final activity = swarmProjectActivity(snapshot, reader.buddies);
          final projects = [
            for (final project in snapshot.projects)
              SwarmHomeProject(
                swarmId: swarm.id,
                project: project,
                active: activity[project.id],
                news: news[project.id] ?? swarmNoProjectNews,
              ),
          ];
          any = any || projects.isNotEmpty;
          final team = swarmTeam(reader);
          anyTeam = anyTeam || team.isNotEmpty;
          teams[swarm.id] = (
            reader,
            switch (filter) {
              SwarmHomeFilter.all => team,
              SwarmHomeFilter.unread => [
                for (final member in team)
                  if (member.unread) member,
              ],
              // Tags are a project's: an agent's chat has none to list.
              SwarmHomeFilter.mentions => const [],
            },
          );
          sections.add((
            swarm,
            swarmHomeFiltered(
              swarmHomeLists(
                projects,
                pins: home.pins,
                now: now,
                sort: home.sort,
                unreadsFirst: home.unreadsFirst,
              ),
              filter,
            ),
          ));
        case final SwarmReader reader
            when _ended(reader) && reader.error != null:
          failed[swarm.id] = reader.error!;
        case _:
          reading.add(swarm.id);
      }
    }
    bool listsAny(SwarmHomeLists lists) =>
        lists.pinned.isNotEmpty ||
        lists.recent.isNotEmpty ||
        lists.quiet.isNotEmpty;
    bool teamAny(String swarmId) => teams[swarmId]?.$2.isNotEmpty ?? false;
    // Mentions come from their own read: until it answers, none listed says
    // nothing. A failed one is not none, and says so even over the mentions
    // another Swarm has listed.
    final mentionsOn = filter == SwarmHomeFilter.mentions;
    final mentionsComing = mentionsOn && asking.isNotEmpty;
    final mentionsFailed =
        mentionsOn &&
        shown.any((swarm) => inbox.asks(swarm.id)?.readFailed ?? false);
    // The filter on with nothing to list, and nothing still to come: it says
    // so, and offers them all.
    final nothingListed =
        filter != SwarmHomeFilter.all &&
        (any || anyTeam) &&
        reading.isEmpty &&
        !mentionsComing &&
        !sections.any(
          (section) => listsAny(section.$2) || teamAny(section.$1.id),
        );
    Widget row(SwarmHomeProject project) => SwarmHomeProjectRow(
      key: ValueKey('swarm-project-${project.swarmId}-${project.project.id}'),
      project: project,
      tagsLoading: asking.contains(project.swarmId),
      onTap: () => _openProject(context, project.swarmId, project.project.id),
      onLongPress: () => unawaited(_pin(context, session, project)),
    );
    // Your Team listed, Home is not empty: its projects come later.
    final empty = !any && !anyTeam && reading.isEmpty && failed.isEmpty;
    // Filtered with some listed: what is left out is said, never silent.
    final filterOn =
        filter != SwarmHomeFilter.all && !nothingListed && !mentionsFailed
        ? SwarmRow(
            key: const ValueKey('swarm-filter-on'),
            title: mentionsOn ? 'Mentions only' : 'Unread only',
            trailing: Text(
              'Show all',
              style: AppType.label(color: AppPalette.swarmAccent),
            ),
            onTap: () => home.setFilter(SwarmHomeFilter.all),
          )
        : null;
    final notices = [
      ?filterOn,
      if (empty) const SwarmRow(title: 'No project yet', onTap: null),
      if (mentionsFailed)
        const SwarmRow(
          key: ValueKey('swarm-mentions-failed'),
          title: 'Mentions could not be read.',
          onTap: null,
        )
      else if (nothingListed)
        SwarmRow(
          key: const ValueKey('swarm-filter-none'),
          title: mentionsOn ? 'No mentions.' : 'Nothing unread.',
          onTap: null,
        ),
      if (nothingListed)
        SwarmRow(
          key: const ValueKey('swarm-filter-show-all'),
          title: 'Show all',
          chevron: null,
          onTap: () => home.setFilter(SwarmHomeFilter.all),
        ),
    ];
    final listedBy = {for (final (swarm, lists) in sections) swarm.id: lists};
    bool shows(SwarmListing swarm) => switch (listedBy[swarm.id]) {
      final lists? => listsAny(lists) || teamAny(swarm.id),
      null => false,
    };
    bool drawn(SwarmListing swarm) =>
        shows(swarm) ||
        reading.contains(swarm.id) ||
        failed.containsKey(swarm.id);
    final firstDrawn = shown.where(drawn).firstOrNull;
    // Each Swarm's own: one heading over several, its rows in one card. A
    // Swarm whose read was taken away is not named: its line says so.
    List<Widget> section(SwarmListing swarm, List<Widget> body) => [
      if (several && !(inbox.reader(swarm.id)?.accessRevoked ?? false))
        SwarmCaption(
          swarm.name,
          key: ValueKey('swarm-heading-${swarm.id}'),
          first: first && notices.isEmpty && swarm == firstDrawn,
        )
      else if (notices.isNotEmpty)
        const SizedBox(height: AppSpace.s),
      ...body,
    ];
    // Your Team over the projects, each under its heading, as Desktop's left
    // pane has them (Swarm v4): the agents the person brought, each opening
    // its own chat with them. With no agents, the projects have no heading.
    List<Widget> team(SwarmListing swarm, {required bool projects}) {
      final (reader, team) = teams[swarm.id]!;
      final snapshot = reader.snapshot!;
      final open = _teamOpen.contains(swarm.id);
      final rows = swarmTeamRows(team, open: open);
      String key(String name) => several ? '$name-${swarm.id}' : name;
      // What each one does, as its computer says it: a row is drawn again
      // when that changes, not the whole of Home.
      final agents = swarmAgentsOf(context);
      Widget member(
        SuperTabAgent agent,
        SuperTabConversation? chat,
        bool unread,
      ) {
        SwarmTeamRow draw() => SwarmTeamRow(
          key: ValueKey('swarm-agent-${swarm.id}-${agent.id}'),
          agent: agent,
          name: snapshot.agentName(agent.id, fallback: agent.name),
          pm: swarmAgentIsPm(snapshot, agent),
          unread: unread,
          state: swarmAgentStateIn(reader, agent, agents),
          onTap: chat == null
              ? null
              : () => _openChat(context, swarm.id, chat.id),
          onLongPress: swarmMayPauseAgent(reader, agent.id)
              ? () => unawaited(showSwarmAgentMenu(context, reader, agent.id))
              : null,
        );
        return agents == null
            ? draw()
            : ListenableBuilder(listenable: agents, builder: (_, _) => draw());
      }

      return [
        SwarmCaption(
          'Your Team',
          key: ValueKey(key('swarm-team')),
          // Under its Swarm's name, or first on the screen: less room above.
          first: several || (first && notices.isEmpty && swarm == firstDrawn),
        ),
        SwarmGroup(
          children: [
            for (final i in rows.shown)
              if (team[i] case (:final agent, :final chat, :final unread))
                member(agent, chat, unread),
            if (team.length > swarmTeamShown + 1)
              SwarmTeamFoldRow(
                key: ValueKey(key('swarm-team-more')),
                hidden: rows.hidden,
                open: open,
                unread: rows.hiddenUnread,
                onTap: () => setState(
                  () => open
                      ? _teamOpen.remove(swarm.id)
                      : _teamOpen.add(swarm.id),
                ),
              ),
          ],
        ),
        if (projects)
          SwarmCaption('Projects', key: ValueKey(key('swarm-projects'))),
      ];
    }

    List<Widget> listed(SwarmListing swarm, SwarmHomeLists lists) {
      final open = _quietOpen.contains(swarm.id);
      final projects = listsAny(lists);
      return section(swarm, [
        if (teamAny(swarm.id)) ...team(swarm, projects: projects),
        if (projects)
          SwarmGroup(
            children: [
              for (final p in lists.pinned) row(p),
              for (final p in lists.recent) row(p),
              if (lists.quiet.isNotEmpty) ...[
                SwarmOtherProjectsRow(
                  key: ValueKey(
                    several
                        ? 'swarm-other-projects-${swarm.id}'
                        : 'swarm-other-projects',
                  ),
                  count: lists.quiet.length,
                  open: open,
                  onTap: () => setState(
                    () => open
                        ? _quietOpen.remove(swarm.id)
                        : _quietOpen.add(swarm.id),
                  ),
                ),
                if (open)
                  for (final p in lists.quiet) row(p),
              ],
            ],
          ),
      ]);
    }

    return [
      top,
      if (notices.isNotEmpty) SwarmGroup(children: notices),
      for (final swarm in shown)
        if (shows(swarm))
          ...listed(swarm, listedBy[swarm.id]!)
        else if (reading.contains(swarm.id))
          ...section(swarm, [
            SwarmSkeletonRows(
              id: 'swarm-projects-loading-${swarm.id}',
              nameOnly: true,
            ),
          ])
        else if (failed[swarm.id] case final error?)
          ...section(swarm, [
            SwarmGroup(
              key: ValueKey('swarm-projects-error-${swarm.id}'),
              children: [SwarmRow(title: error, onTap: null)],
            ),
          ]),
      // A Swarm still to be read has its skeleton: one is enough.
      if (mentionsComing && reading.isEmpty) ...[
        const SizedBox(height: AppSpace.s),
        SwarmSkeletonRows(id: 'swarm-mentions-loading', nameOnly: true),
      ],
    ];
  }

  /// New project, from the Swarm switcher: its sheet over Home, for every
  /// Swarm listed, opening on the one [shown] if Home shows one and it is
  /// not paused (Dee, 11-01); the PM's own chat its brief went to opens, as
  /// Desktop's does, unless Home or the account changed meanwhile, or the
  /// project is no longer Home's to list.
  Future<void> _newProject(
    SwarmSession session,
    List<SwarmListing> shown,
  ) async {
    final made = await showSwarmNewProjectSheet(
      context,
      session: session,
      swarmIds: [for (final swarm in session.inbox.swarms) swarm.id],
      openedFrom: shown.length == 1 ? shown.single.id : null,
      now: widget.now,
    );
    if (made == null || !mounted || _session != session) return;
    if (!swarmHomeListed(session.inbox, made.swarmId, made.projectId)) return;
    unawaited(
      Navigator.of(context).push(
        swarmChatRoute(swarmId: made.swarmId, conversationId: made.chatId),
      ),
    );
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

  /// Home before the list answers: the projects as rows on their way.
  List<Widget> _reading() => [
    const SizedBox(height: AppSpace.s),
    SwarmSkeletonRows(id: 'swarm-projects-loading', nameOnly: true),
  ];
}

/// A Swarm's tile on its way.
const _loadingTile = Skeleton(
  width: 32,
  height: 32,
  radius: AppCard.insetRadius,
);

/// Whether no read will bring this Swarm: the reader may no longer read it, or
/// the backend needs a newer build, with nothing read before then.
bool _ended(SwarmReader reader) =>
    reader.snapshot == null && (reader.accessRevoked || reader.updateRequired);

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

/// What Mark all read's toast says: how many chats it marked read. Once the
/// marks are sent — after the Undo window, or before it ends when the app
/// left the screen or closed, the account changed or a second Mark all read
/// began — it closes the toast in that same step: its Undo can do nothing
/// more. Built only while its toast is the one shown, and closing before the
/// next toast is shown, so it never closes another. Undo closes it itself.
class SwarmMarkAllToast extends StatefulWidget {
  const SwarmMarkAllToast(this.held, {super.key});

  final SwarmMarkAll held;

  @override
  State<SwarmMarkAllToast> createState() => _SwarmMarkAllToastState();
}

class _SwarmMarkAllToastState extends State<SwarmMarkAllToast> {
  @override
  void initState() {
    super.initState();
    unawaited(
      widget.held.settled.then((sent) {
        if (sent && mounted) {
          ScaffoldMessenger.maybeOf(context)?.hideCurrentSnackBar();
        }
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final count = widget.held.count;
    return Text(count == 1 ? 'Marked 1 chat read' : 'Marked $count chats read');
  }
}
