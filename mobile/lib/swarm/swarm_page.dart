import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_choices.dart';
import 'swarm_conversation_page.dart';
import 'swarm_drawer.dart';
import 'swarm_inbox.dart';
import 'swarm_pm_chat.dart';
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
/// you"), one thing open at a time; Chat with PM, one per project; then the
/// projects, each with its team in a line ([swarmNeedsFirst] orders needs and
/// the rest). Its drawer ([SwarmDrawer]) is the way to everything else.
///
/// The phone's Home while Settings ▸ Experimental ▸ Swarm is on; pushed over
/// another page it has a back button instead of the drawer. Its top bar holds
/// the menu and its title in one line, as the approved prototype draws it.
/// Reads the account's [SwarmSession] from the shell; with none, says why.
class SwarmPage extends StatefulWidget {
  const SwarmPage({super.key, this.onHarness, this.onSettings});

  /// Harness at the root of the stack, from the drawer ([SwarmDrawer]).
  final VoidCallback? onHarness;

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

  /// The Chat with PM being opened, as `swarmId/projectId`, and why the last
  /// one did not open.
  String? _pmOpening;
  String? _pmError;

  /// The person's Chat with PM of [projectId], created on first use.
  Future<void> _openPm(String swarmId, String projectId) async {
    final reader = _session?.inbox.reader(swarmId);
    if (reader == null || _pmOpening != null) return;
    setState(() {
      _pmOpening = '$swarmId/$projectId';
      _pmError = null;
    });
    final error = await openSwarmPm(context, reader, swarmId, projectId);
    if (!mounted) return;
    setState(() {
      _pmOpening = null;
      _pmError = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = _session;
    // Pushed over another page: a page under Home's own route, never one over
    // it. Home builds while a page slides in over it (Chat with PM opening),
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
                onPm: (swarmId, projectId) =>
                    unawaited(_openPm(swarmId, projectId)),
                onChat: (swarmId, conversationId) =>
                    openSwarmConversation(context, swarmId, conversationId),
                onHarness: widget.onHarness,
                onSettings: widget.onSettings,
              ),
            ),
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: pushed
                  ? SwarmBackButton(
                      onPressed: () => Navigator.of(context).maybePop(),
                    )
                  : const _MenuButton(),
              title: 'Swarm',
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
                                12,
                                0,
                                12,
                                MediaQuery.paddingOf(context).bottom + 28,
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

  List<Widget> _body(BuildContext context, SwarmSession session, Tty tty) {
    final inbox = session.inbox;
    // Before the list there is nothing to read, unless a Home was kept; a
    // list that could not be read says so alone, without rows on their way.
    if (!inbox.loaded && inbox.swarms.isEmpty) {
      return [
        if (inbox.error case final error?)
          _error(error, key: 'swarm-error')
        else
          ..._reading(),
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
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: SwarmRow.line(
              'Nothing needs you.',
              key: const ValueKey('swarm-needs-none'),
            ),
          ),
        },
    ];
    final pm = [
      for (final swarm in inbox.swarms)
        if (inbox.reader(swarm.id)?.snapshot case final snapshot?)
          for (final project in snapshot.projects)
            SwarmRow(
              key: ValueKey('swarm-home-pm-${swarm.id}-${project.id}'),
              leading: switch (swarmPmId(snapshot, project)) {
                final id? => SwarmAvatar(id: id, name: snapshot.agentName(id)),
                null => SwarmProjectTile(project.name),
              },
              title: project.name,
              detail: switch ([
                ?swarmPmName(snapshot, project),
                if (several) swarm.name,
              ]) {
                [] => null,
                final words => SwarmRow.line(words.join(' · ')),
              },
              trailing: _pmOpening == '${swarm.id}/${project.id}'
                  ? SwarmRow.line('Opening…')
                  : null,
              chevron: null,
              onTap: () => unawaited(_openPm(swarm.id, project.id)),
            ),
    ];
    // Swarms listed and still to be read: their rows are on their way.
    final reading = [
      for (final swarm in inbox.swarms)
        if (_unread(inbox.reader(swarm.id))) swarm.id,
    ];
    List<Widget> swarms({required bool first}) => [
      if (pm.isNotEmpty || reading.isNotEmpty) ...[
        SwarmCaption('Chat with PM', first: first),
        if (pm.isNotEmpty) SwarmGroup(children: pm),
        for (final (i, id) in reading.indexed) ...[
          if (pm.isNotEmpty || i > 0) const SizedBox(height: 8),
          SwarmSkeletonRows(id: 'swarm-pm-loading-$id', round: true),
        ],
      ],
      if (_pmError case final error?)
        _error(error, key: 'swarm-pm-error', top: 8),
      for (final (i, swarm) in inbox.swarms.indexed) ...[
        SwarmCaption(
          several ? swarm.name : 'Projects',
          first: first && pm.isEmpty && reading.isEmpty && i == 0,
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
        SwarmCaption('Your Swarms', first: first && pm.isEmpty),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: SwarmRow.line(
            'No Swarm yet. Start one on your computer.',
            lines: 2,
          ),
        ),
      ],
    ];
    return [
      if (inbox.error case final error?) _error(error, key: 'swarm-error'),
      ...swarmNeedsFirst
          ? [...needs(first: true), ...swarms(first: false)]
          : [...swarms(first: true), ...needs(first: false)],
    ];
  }

  /// Home before the list answers: Needs you, Chat with PM and the projects
  /// as rows on their way, in the order Home shows them.
  List<Widget> _reading() {
    List<Widget> needs({required bool first}) => [
      SwarmCaption('Needs you', first: first),
      SwarmSkeletonRows(id: 'swarm-needs-loading', rows: 1),
    ];
    List<Widget> swarms({required bool first}) => [
      SwarmCaption('Chat with PM', first: first),
      SwarmSkeletonRows(id: 'swarm-pm-loading', round: true),
      const SwarmCaption('Projects'),
      SwarmSkeletonRows(id: 'swarm-projects-loading'),
    ];
    return swarmNeedsFirst
        ? [...needs(first: true), ...swarms(first: false)]
        : [...swarms(first: true), ...needs(first: false)];
  }

  /// What went wrong, in the danger colour, up to three lines.
  Widget _error(String text, {required String key, double top = 6}) => Padding(
    padding: EdgeInsets.fromLTRB(4, top, 4, 0),
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
          ),
          onTap: () => _openProject(context, swarmId, project.id),
        ),
    ];
  }
}

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
    padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
    children: [
      Text(
        'Swarm is off on this phone, or you are signed out. '
        'Turn it on in Settings ▸ Experimental.',
        key: const ValueKey('swarm-unavailable'),
        style: TextStyle(
          color: AppPalette.textSecondary,
          fontSize: 16,
          height: 1.45,
        ),
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
