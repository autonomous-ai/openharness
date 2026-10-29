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

import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_buddy_chat.dart';
import 'swarm_choices.dart';
import 'swarm_connection_notice.dart';
import 'swarm_conversation_page.dart';
import 'swarm_drawer.dart';
import 'swarm_home_keeper.dart';
import 'swarm_inbox.dart';
import 'swarm_profile_sheet.dart';
import 'swarm_need_rows.dart';
import 'swarm_project_page.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';
import 'swarm_team_line.dart';
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

/// Swarm Home: what every Swarm of the account asks of the person ("Needs
/// you"), one thing open at a time; Buddies, the person's Buddy chat in each
/// project; then the projects, each with its team in a line
/// ([swarmNeedsFirst] orders needs and the rest). Its drawer ([SwarmDrawer])
/// is the way to everything else.
///
/// The phone's Home while Settings ▸ Experimental ▸ Swarm is on; pushed over
/// another page it has a back button instead of the drawer. Its top bar holds
/// the menu and its title in one line, as the approved prototype draws it.
/// Reads the account's [SwarmSession] from the shell; with none, says why.
class SwarmPage extends StatefulWidget {
  const SwarmPage({super.key, this.onSettings});

  /// Settings over Swarm Home, from the drawer.
  final void Function(BuildContext context)? onSettings;

  @override
  State<SwarmPage> createState() => _SwarmPageState();
}

class _SwarmPageState extends State<SwarmPage> {
  SwarmSession? _session;

  /// Kept out of sight under Harness ([OutOfSight]), as it was left: it is no
  /// Swarm screen meanwhile — a notice still tells what arrives — and draws
  /// nothing new. Shown again, it reads the Swarms as on any return to Home.
  bool _hidden = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    final hidden = OutOfSight.of(context);
    if (session == _session && hidden == _hidden) return;
    if (!_hidden) _session?.leave();
    _session = session;
    _hidden = hidden;
    if (hidden || session == null) return;
    session.enter();
    unawaited(session.inbox.refresh());
  }

  @override
  void dispose() {
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

  /// The need open on Home, by its key; null opens the first.
  String? _focus;

  /// The Buddy chat being opened, as `swarmId/projectId`, and why the last
  /// one did not open.
  String? _buddyOpening;
  String? _buddyError;

  /// The person's Buddy chat in [projectId], opened on the server first when
  /// they have none yet. One at a time.
  Future<void> _openBuddy(String swarmId, String projectId) async {
    final reader = _session?.inbox.reader(swarmId);
    if (reader == null || _buddyOpening != null) return;
    setState(() {
      _buddyOpening = '$swarmId/$projectId';
      _buddyError = null;
    });
    final error = await openSwarmBuddy(context, reader, swarmId, projectId);
    if (!mounted) return;
    setState(() {
      _buddyOpening = null;
      _buddyError = error;
    });
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
    return Scaffold(
      backgroundColor: tty.ground,
      // Home's drawer; a Swarm page pushed over another page has its back
      // button instead. None out of sight: one closing as Harness took the
      // screen would stop there, its animation off, and be found half open.
      drawer: pushed || _hidden
          ? null
          : ListenableBuilder(
              listenable: Listenable.merge([?session, ?session?.inbox]),
              builder: (context, _) => SwarmDrawer(
                session: session,
                onProject: (swarmId, projectId) =>
                    _openProject(context, swarmId, projectId),
                onBuddy: (swarmId, projectId) =>
                    unawaited(_openBuddy(swarmId, projectId)),
                onChat: (swarmId, conversationId) =>
                    openSwarmConversation(context, swarmId, conversationId),
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
                listenable: Listenable.merge([session, session.inbox]),
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
                      listenable: Listenable.merge([session, session.inbox]),
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
                              children: _body(context, session, tty),
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

  List<Widget> _body(BuildContext context, SwarmSession session, Tty tty) {
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
    final several = inbox.swarms.length > 1;
    final empty = _emptyNeeds(inbox);
    List<Widget> needs({required bool first}) => [
      SwarmCaption('Needs you', count: inbox.needs.length, first: first),
      if (inbox.needs.isNotEmpty)
        SwarmGroup(children: _needs(context, session))
      else
        switch (empty) {
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
    // The person's Buddy chat in each project, there from the start (#2090);
    // a viewer, who starts no Buddy, sees only the chats they have.
    final buddies = [
      for (final swarm in inbox.swarms)
        if (inbox.reader(swarm.id) case final reader?)
          for (final project in reader.snapshot?.projects ?? const [])
            if (swarmBuddyChat(reader, project.id) != null ||
                swarmCanWrite(reader))
              SwarmRow(
                key: ValueKey('swarm-home-buddy-${swarm.id}-${project.id}'),
                leading: SwarmBuddyAvatar(
                  reader: reader,
                  projectId: project.id,
                ),
                title: swarmBuddyName(reader, project.id),
                detail: SwarmRow.line(
                  [
                    project.name,
                    if (several) swarm.name,
                    swarmBuddyNote(reader, project.id) ??
                        swarmBuddyEngineName(
                          swarmBuddy(reader, project.id)!.engine,
                        ),
                  ].join(' · '),
                ),
                trailing: _buddyOpening == '${swarm.id}/${project.id}'
                    ? SwarmRow.line('Opening…')
                    : null,
                chevron: null,
                onTap: () => unawaited(_openBuddy(swarm.id, project.id)),
              ),
    ];
    // Swarms listed and still to be read: their rows are on their way.
    final reading = [
      for (final swarm in inbox.swarms)
        if (_unread(inbox.reader(swarm.id))) swarm.id,
    ];
    List<Widget> swarms({required bool first}) => [
      if (buddies.isNotEmpty || reading.isNotEmpty) ...[
        SwarmCaption('Buddies', first: first),
        if (buddies.isNotEmpty) SwarmGroup(children: buddies),
        for (final (i, id) in reading.indexed) ...[
          if (buddies.isNotEmpty || i > 0) const SizedBox(height: 8),
          SwarmSkeletonRows(id: 'swarm-buddy-loading-$id', round: true),
        ],
      ],
      if (_buddyError case final error?)
        _error(error, key: 'swarm-buddy-error', top: 8),
      for (final (i, swarm) in inbox.swarms.indexed) ...[
        SwarmCaption(
          several ? swarm.name : 'Projects',
          first: first && buddies.isEmpty && reading.isEmpty && i == 0,
        ),
        switch (inbox.reader(swarm.id)) {
          SwarmReader(snapshot: final snapshot?) => SwarmGroup(
            children: _projects(context, swarm.id, snapshot),
          ),
          SwarmReader(error: final error?) => SwarmGroup(
            children: [
              SwarmRow(
                title: error,
                detail: SwarmRow.line('Pull down to try again.'),
                onTap: null,
              ),
            ],
          ),
          _ => SwarmSkeletonRows(id: 'swarm-projects-loading-${swarm.id}'),
        },
      ],
      if (inbox.swarms.isEmpty) ...[
        SwarmCaption('Your Swarms', first: first && buddies.isEmpty),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
          child: SwarmRow.line(
            'No Swarm yet. Start one on your computer.',
            lines: 2,
          ),
        ),
      ],
    ];
    final first = notice == null;
    return [
      ?notice,
      if (error != null) _error(error, key: 'swarm-error'),
      ...swarmNeedsFirst
          ? [...needs(first: first), ...swarms(first: false)]
          : [...swarms(first: first), ...needs(first: false)],
    ];
  }

  /// Home before the list answers: Needs you, Buddies and the projects
  /// as rows on their way, in the order Home shows them; under a card, its
  /// first caption not [first].
  List<Widget> _reading({bool first = true}) {
    List<Widget> needs({required bool first}) => [
      SwarmCaption('Needs you', first: first),
      SwarmSkeletonRows(id: 'swarm-needs-loading', rows: 1),
    ];
    List<Widget> swarms({required bool first}) => [
      SwarmCaption('Buddies', first: first),
      SwarmSkeletonRows(id: 'swarm-buddy-loading', round: true),
      const SwarmCaption('Projects'),
      SwarmSkeletonRows(id: 'swarm-projects-loading'),
    ];
    return swarmNeedsFirst
        ? [...needs(first: first), ...swarms(first: false)]
        : [...swarms(first: first), ...needs(first: false)];
  }

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

  /// Every need, one open with its options or Done, the others a line each
  /// that opens it in its place. The one open is the person's pick while it
  /// waits, else the first: answered or done, the next one opens.
  List<Widget> _needs(BuildContext context, SwarmSession session) {
    final needs = session.inbox.needs;
    final open = needs.firstWhere(
      (need) => need.key == _focus,
      orElse: () => needs.first,
    );
    return [
      for (final need in needs)
        if (need == open)
          SwarmNeedRow(
            session: session,
            need: need,
            onOpen: (swarmId, conversationId) =>
                openSwarmConversation(context, swarmId, conversationId),
          )
        else
          SwarmNeedLine(
            key: ValueKey('swarm-need-row-${need.key}'),
            session: session,
            need: need,
            onTap: () => setState(() => _focus = need.key),
          ),
    ];
  }

  List<Widget> _projects(
    BuildContext context,
    String swarmId,
    SuperTabSnapshot snapshot,
  ) {
    if (snapshot.projects.isEmpty) {
      return [const SwarmRow(title: 'No project yet', onTap: null)];
    }
    return [
      for (final project in snapshot.projects)
        SwarmRow(
          key: ValueKey('swarm-project-$swarmId-${project.id}'),
          leading: SwarmProjectTile(project.name),
          title: project.name,
          detail: SwarmTeamLine(
            swarmTeamGlance(snapshot, projectId: project.id),
            kept: swarmHomeKept(_session?.inbox.reader(swarmId)),
          ),
          onTap: () => _openProject(context, swarmId, project.id),
        ),
    ];
  }
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

/// A Swarm listed and still to be read: no snapshot yet, and no reason it
/// could not be read.
bool _unread(SwarmReader? reader) =>
    reader == null || (reader.snapshot == null && reader.error == null);

/// Why [inbox]'s Needs you is empty: still reading while a Swarm, or what
/// waits on the person in it since it was last read in full, is not read yet.
_EmptyNeeds _emptyNeeds(SwarmInbox inbox) {
  var reading = false, unread = false;
  for (final swarm in inbox.swarms) {
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
