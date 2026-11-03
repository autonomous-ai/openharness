import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

import 'swarm_activity.dart' show SwarmActivityFilter;
import 'swarm_agents.dart';
import 'swarm_conversation_page.dart' show openSwarmConversation;
import 'swarm_home_list.dart';
import 'swarm_home_rows.dart';
import 'swarm_home_search.dart';
import 'swarm_home_tiles.dart';
import 'swarm_home_top.dart';
import 'swarm_inbox.dart';
import 'swarm_mark_all.dart';
import 'swarm_needs_page.dart';
import 'swarm_new_message_sheet.dart';
import 'swarm_new_project_sheet.dart';
import 'swarm_project_page.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_home_view_sheet.dart';
import 'swarm_search_page.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';
import 'swarm_tabs.dart';
import 'swarm_threads.dart';
import 'swarm_threads_page.dart';
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
/// Slack's (2026-11-03), the Home tab: its title the Swarm shown, with a
/// switcher to every Swarm, All Swarms and Join or create
/// ([showSwarmSwitcher]), then Sort and filter and the person's avatar, which
/// opens You ([SwarmYouButton]); a search field that folds away as the list
/// scrolls ([SwarmSearchPill]), and a pull down at the top that opens Search
/// too ([SwarmPullToSearch]); a row of tiles ([SwarmHomeTiles]): While you
/// were away whenever there is a Swarm to report on, Threads, and the agents
/// on the person's computers; then the projects they pinned on this phone,
/// one line each, then the others by their latest activity, those quiet for
/// a day folded under "Other projects" ([swarmHomeLists]). Every Swarm's, or
/// the one picked ([SwarmHomePrefs.swarmId]). A round + floats at its bottom
/// right over them: New message (Tony, 10-30: Slack Mobile's;
/// [showSwarmNewMessage]). What needs the person, and the invitations to a
/// Swarm, are the Activity tab's.
///
/// The Threads tile ([SwarmThreadsTile]): the threads the person follows in
/// the Swarms shown, bright while one has new replies.
///
/// Pushed over another page it has a back button instead of the switcher.
/// Reads the account's [SwarmSession] from the shell; with none, its skeleton
/// while the account is on its way ([SwarmScope.accountComingOf]), else says
/// why.
class SwarmPage extends StatefulWidget {
  const SwarmPage({super.key, this.now = DateTime.now});

  /// What a project's last move, and the time away, is measured from.
  final DateTime Function() now;

  /// Gone for less, While you were away stays on the time away it was showing.
  static const awayAfter = Duration(minutes: 5);

  @override
  State<SwarmPage> createState() => _SwarmPageState();
}

class _SwarmPageState extends State<SwarmPage> {
  SwarmSession? _session;

  /// The Threads tile's threads, over the Swarms Home shows, while it is in
  /// sight: out of sight, it asks for none.
  SwarmThreadsMerge? _threads;

  /// Home's list is scrolled from its top: the search field folds away.
  final _scrolled = ValueNotifier(false);

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
        final now = widget.now();
        final left = _session?.home.seenAt;
        // A moment away ends nothing: a phone locked or an app glanced at must
        // not turn "2h, 9 done" into "now, 0 done" for someone still reading it.
        if (_awaySpansTime &&
            left != null &&
            now.difference(left) < SwarmPage.awayAfter) {
          return;
        }
        _awayRead = false;
        _back = now;
      }),
    );
  }

  /// Whether the time away read last was a real one ([SwarmPage.awayAfter]).
  bool get _awaySpansTime {
    final since = _away, back = _back;
    return _awayRead &&
        since != null &&
        back != null &&
        back.difference(since) >= SwarmPage.awayAfter;
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
    _threads?.dispose();
    _threads = null;
    if (hidden || session == null) return;
    _threads = swarmThreadsOf(
      session,
      shown: () => _shown(session),
      changed: session.home,
    );
    session.enter();
    unawaited(session.inbox.refresh());
    _tick = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _scrolled.dispose();
    _tick?.cancel();
    _threads?.dispose();
    if (!_hidden) _session?.leave();
    super.dispose();
  }

  void _openProject(BuildContext context, String swarmId, String projectId) =>
      openSwarmProject(context, swarmId: swarmId, projectId: projectId);

  /// The projects quiet for a day are listed under Other projects.
  bool _quietOpen = false;

  /// New message is open: a second tap on + opens no second one.
  bool _composing = false;

  /// New message over Home ([showSwarmNewMessage]), on the Swarms Home
  /// shows; once a message went, the chat it went to opens over Home. Home
  /// replaced or out of sight meanwhile opens nothing.
  Future<void> _newMessage(BuildContext context, SwarmSession session) async {
    if (_composing) return;
    _composing = true;
    final SwarmChatPick? sent;
    try {
      sent = await showSwarmNewMessage(
        context,
        session,
        shown: () => _shown(session),
      );
    } finally {
      _composing = false;
    }
    if (sent == null ||
        !mounted ||
        !context.mounted ||
        _session != session ||
        _hidden) {
      return;
    }
    openSwarmConversation(context, sent.swarmId, sent.chatId);
  }

  /// Refresh, from Sort and filter, reads the Swarms, as a pull on Home did;
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

  /// Whether Home offers New message: a Swarm to post in may be there, or
  /// is still being read.
  bool _offersNewMessage(BuildContext context, SwarmSession session) =>
      swarmStartView(context, session) == null &&
      !(session.inbox.loaded && session.inbox.swarms.isEmpty);

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
      // The tab's Home only, as its compose was: pushed over a page, Home
      // is a step on the way back.
      floatingActionButton: session == null || pushed
          ? null
          : ListenWhileInSight(
              listenable: listens!,
              builder: (context) => _offersNewMessage(context, session)
                  ? SwarmNewMessageButton(
                      key: const ValueKey('swarm-new-message'),
                      onPressed: () => unawaited(_newMessage(context, session)),
                    )
                  : const SizedBox.shrink(),
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
                builder: (context) => _topBar(context, pushed: pushed),
              ),
            Expanded(
              child: session == null
                  ? SwarmScope.accountComingOf(context)
                        ? ListView(
                            key: const ValueKey('swarm-account-coming'),
                            padding: _listPadding(context),
                            children: _reading(first: true),
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

  /// Home's list: at the root, under the search field, which folds away as
  /// it scrolls, and pulled down at its top, Search; pushed, the list alone.
  Widget _list(
    BuildContext context,
    SwarmSession session, {
    required bool pushed,
  }) {
    final list = ListView(
      key: const ValueKey('swarm-home-list'),
      physics: const AlwaysScrollableScrollPhysics(),
      padding: _listPadding(context),
      children: _body(context, session),
    );
    if (pushed) return list;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ValueListenableBuilder(
          valueListenable: _scrolled,
          builder: (context, scrolled, _) => SwarmSearchPill(
            collapsed: scrolled,
            onTap: () => openSwarmSearch(context),
          ),
        ),
        Expanded(
          child: NotificationListener<ScrollUpdateNotification>(
            onNotification: (note) {
              if (note.depth == 0 && note.metrics.axis == Axis.vertical) {
                _scrolled.value = note.metrics.pixels > _foldAfter;
              }
              return false;
            },
            child: SwarmPullToSearch(
              onPull: () => openSwarmSearch(context),
              child: list,
            ),
          ),
        ),
      ],
    );
  }

  /// Scrolled further, the search field folds away.
  static const _foldAfter = 12.0;

  /// Around Home's rows: the last clears the floating +.
  EdgeInsets _listPadding(BuildContext context) => EdgeInsets.fromLTRB(
    AppSpace.m,
    0,
    AppSpace.m,
    MediaQuery.paddingOf(context).bottom +
        SwarmNewMessageButton.size +
        AppSpace.l +
        AppSpace.xl,
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
      trailing: _trailing(
        context,
        session,
        shown,
        view: !listing && session.inbox.swarms.isNotEmpty,
      ),
      loading: listing,
      leading: listing
          ? _loadingTile
          : named == null
          ? null
          : SwarmProjectTile(named.name),
      titleLabel: listing
          ? 'Loading your Swarm. Switch Swarm'
          : 'Swarm: $title. Switch Swarm',
      onTitle: () => unawaited(showSwarmSwitcher(context, session)),
    );
  }

  /// Sort and filter, with a Swarm to sort ([view]), then the person's
  /// avatar, at the end of the top bar (Slack's two, Tony 2026-11-03): a dot
  /// on the first with anything but the defaults on. Mark all read and
  /// Refresh are in its sheet, Mark all read greyed with nothing unread in the
  /// Swarms [shown].
  Widget _trailing(
    BuildContext context,
    SwarmSession session,
    List<SwarmListing> shown, {
    required bool view,
  }) {
    final home = session.home;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (view)
          SwarmIconButton(
            key: const ValueKey('swarm-home-view'),
            icon: LucideIcons.listFilter300,
            label:
                'Sort and filter: ${swarmHomeSortLabel(home)}, '
                '${swarmHomeFilterLabel(home.filter)}',
            dot: home.viewChanged,
            onPressed: () => unawaited(
              showSwarmHomeViewSheet(
                context,
                session,
                unread: () => swarmAnyUnread([
                  for (final swarm in _shown(session))
                    ?session.inbox.reader(swarm.id),
                ]),
                onMarkAllRead: () =>
                    _markAllRead(context, session, _shown(session)),
                onRefresh: () => unawaited(_refresh(context, session)),
              ),
            ),
          ),
        const SwarmYouButton(),
      ],
    );
  }

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

  List<Widget> _body(BuildContext context, SwarmSession session) {
    final inbox = session.inbox;
    // A list that could not be read, no computer answering included, says
    // nothing here: it is in the app's log and read again soon, Home as it
    // was until then. Only a server without the list says so, as no read will
    // ever bring its rows.
    if (!inbox.loaded && inbox.swarms.isEmpty) {
      final away = swarmHomeListing(inbox)
          ? _tiles(context, session, const [], null, widget.now())
          : null;
      return [
        ?away,
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
          ..._reading(first: away == null),
      ];
    }
    final shown = _shown(session);
    final picked = shown.length == 1 && inbox.swarms.length > 1
        ? shown.single.id
        : null;
    final now = widget.now();
    final tiles = _tiles(context, session, shown, picked, now);
    return [
      ?tiles,
      ..._projects(context, session, shown, now, first: tiles == null),
    ];
  }

  /// The row of tiles over the projects: While you were away ([_awayTile]),
  /// Threads over the Swarms [shown], and the agents on the person's
  /// computers, where the app has them; none with none of the three.
  Widget? _tiles(
    BuildContext context,
    SwarmSession session,
    List<SwarmListing> shown,
    String? picked,
    DateTime now,
  ) {
    final away = _awayTile(context, session, shown, picked, now);
    final threads = _threads;
    final agents = swarmAgentsOf(context);
    final tiles = [
      ?away,
      if (threads != null && shown.isNotEmpty)
        SwarmThreadsTile(
          threads: threads,
          onTap: () => openSwarmThreads(context, swarmId: picked),
        ),
      if (agents != null)
        SwarmAgentsTile(agents: agents, onTap: () => agents.openList(context)),
    ];
    if (tiles.isEmpty) return null;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpace.xs),
      child: SwarmHomeTiles(children: tiles),
    );
  }

  /// While you were away: the work done in the Swarms shown since the person
  /// last left the app, or on a first open since it opened, and what needs them
  /// there now, each a skeleton while the Swarms, or what waits in them, are
  /// not read. Always there, unless no Swarm is left to report on. A tap opens
  /// Activity on Needs you.
  Widget? _awayTile(
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
    // Not known yet: drawn as "now" for a moment, it would then jump.
    if (!home.loaded) return null;
    // Decided at the return: time in the foreground is no time away.
    final back = _back ?? now;
    final since = _away ?? back;
    final inbox = session.inbox;
    final listing = swarmHomeListing(inbox);
    if (!listing && shown.isEmpty) return null;
    // A Swarm not read leaves the work done unknown; one no read will bring is
    // left out, or its skeleton would never end.
    int? done = listing ? null : 0;
    for (final swarm in listing ? const <SwarmListing>[] : shown) {
      final reader = inbox.reader(swarm.id);
      if (reader != null && _ended(reader)) continue;
      final snapshot = reader?.snapshot;
      done = snapshot == null ? null : done! + swarmDoneSince(snapshot, since);
      if (done == null) break;
    }
    final needs = swarmNeedsOf(inbox, picked).length;
    return SwarmAwayTile(
      since: since,
      back: back,
      done: done,
      // None found is not none waiting until all of it is read.
      needs: !listing && (needs > 0 || _needsRead(inbox, shown)) ? needs : null,
      onTap: () {
        if (!showSwarmTab(
          context,
          SwarmTab.activity,
          activity: SwarmActivityFilter.needsYou,
        )) {
          openSwarmNeeds(context, swarmId: picked);
        }
      },
    );
  }

  /// Pinned, then Projects: every project of the Swarms shown, grouped by
  /// [swarmHomeLists]; a Swarm still to be read has rows on their way, a
  /// failed read still trying too, as it is in the log. One no read will bring
  /// says so. The first caption is the screen's [first] thing, with nothing
  /// over it.
  List<Widget> _projects(
    BuildContext context,
    SwarmSession session,
    List<SwarmListing> shown,
    DateTime now, {
    required bool first,
  }) {
    final inbox = session.inbox;
    if (inbox.swarms.isEmpty) {
      return [
        SwarmCaption('Projects', first: first),
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
    final names = <String, String>{};
    final reading = <String>[];
    final failed = <(String, String)>[];
    final asking = <String>{};
    for (final swarm in shown) {
      if (inbox.asks(swarm.id)?.loading ?? false) asking.add(swarm.id);
      switch (inbox.reader(swarm.id)) {
        case final SwarmReader reader when reader.snapshot != null:
          final snapshot = reader.snapshot!;
          final news = swarmProjectNews(reader, inbox.asks(swarm.id));
          final activity = swarmProjectActivity(snapshot, reader.buddies);
          for (final project in snapshot.projects) {
            final projectNews = news[project.id];
            final row = SwarmHomeProject(
              swarmId: swarm.id,
              project: project,
              active: activity[project.id],
              news: projectNews ?? swarmNoProjectNews,
            );
            projects.add(row);
            names[row.key] = swarm.name;
          }
        case final SwarmReader reader
            when _ended(reader) && reader.error != null:
          failed.add((swarm.id, reader.error!));
        case _:
          reading.add(swarm.id);
      }
    }
    final home = session.home;
    final filter = home.filter;
    final lists = swarmHomeFiltered(
      swarmHomeLists(
        projects,
        pins: home.pins,
        now: now,
        sort: home.sort,
        unreadsFirst: home.unreadsFirst,
      ),
      filter,
    );
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
        projects.isNotEmpty &&
        reading.isEmpty &&
        !mentionsComing &&
        lists.pinned.isEmpty &&
        lists.recent.isEmpty &&
        lists.quiet.isEmpty;
    Widget row(SwarmHomeProject project) => SwarmHomeProjectRow(
      key: ValueKey('swarm-project-${project.swarmId}-${project.project.id}'),
      project: project,
      swarmName: several ? names[project.key] : null,
      tagsLoading: asking.contains(project.swarmId),
      onTap: () => _openProject(context, project.swarmId, project.project.id),
      onLongPress: () => unawaited(_pin(context, session, project)),
    );
    final quiet = lists.quiet;
    final empty = projects.isEmpty && reading.isEmpty && failed.isEmpty;
    // Last, for someone who may write in a Swarm shown: never a viewer.
    final create = shown.any((swarm) => swarmMayCreateProject(inbox, swarm.id))
        ? SwarmNewProjectRow(
            key: const ValueKey('swarm-new-project'),
            onTap: () => unawaited(_newProject(session, shown)),
          )
        : null;
    return [
      if (lists.pinned.isNotEmpty) ...[
        SwarmCaption('Pinned', first: first),
        SwarmGroup(children: [for (final p in lists.pinned) row(p)]),
      ],
      if (lists.recent.isNotEmpty ||
          quiet.isNotEmpty ||
          empty ||
          nothingListed ||
          mentionsFailed ||
          create != null) ...[
        SwarmCaption('Projects', first: first && lists.pinned.isEmpty),
        SwarmGroup(
          children: [
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
            ?create,
          ],
        ),
      ] else if (reading.isNotEmpty || failed.isNotEmpty)
        SwarmCaption('Projects', first: first && lists.pinned.isEmpty),
      // A Swarm still to be read has its skeleton below: one is enough.
      if (mentionsComing && reading.isEmpty) ...[
        const SizedBox(height: 8),
        SwarmSkeletonRows(id: 'swarm-mentions-loading', nameOnly: true),
      ],
      for (final (i, id) in reading.indexed) ...[
        if (projects.isNotEmpty || i > 0) const SizedBox(height: 8),
        SwarmSkeletonRows(id: 'swarm-projects-loading-$id', nameOnly: true),
      ],
      for (final (id, error) in failed) ...[
        const SizedBox(height: 8),
        SwarmGroup(
          key: ValueKey('swarm-projects-error-$id'),
          children: [SwarmRow(title: error, onTap: null)],
        ),
      ],
    ];
  }

  /// + New project: its sheet over Home, for every Swarm listed, opening on
  /// the one [shown] if Home shows one and it is not paused (Dee, 11-01);
  /// the project it made opens, unless Home or the account changed
  /// meanwhile, or the project is no longer Home's to list.
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
    _openProject(context, made.swarmId, made.projectId);
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
  List<Widget> _reading({required bool first}) => [
    SwarmCaption('Projects', first: first),
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

/// Whether what waits on the person in every Swarm [shown] is read: the
/// Swarm, and what waits in it since it was last read in full. One no read
/// will bring has nothing more to wait for.
bool _needsRead(SwarmInbox inbox, List<SwarmListing> shown) => shown.every(
  (swarm) => switch (inbox.reader(swarm.id)) {
    final reader? when _ended(reader) => true,
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
