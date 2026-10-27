import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_choices.dart';
import 'swarm_conversation_page.dart';
import 'swarm_drawer.dart';
import 'swarm_pm_chat.dart';
import 'swarm_need_rows.dart';
import 'swarm_project_page.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
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

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.leave();
    _session = session?..enter();
    if (session != null) unawaited(session.inbox.refresh());
  }

  @override
  void dispose() {
    _session?.leave();
    super.dispose();
  }

  void _openProject(BuildContext context, String swarmId, String projectId) =>
      unawaited(
        Navigator.of(context).push(
          phoneRoute(
            (_) => SwarmProjectPage(swarmId: swarmId, projectId: projectId),
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
    final pushed = Navigator.of(context).canPop();
    return Scaffold(
      backgroundColor: tty.ground,
      // Home's drawer; a Swarm page pushed over another page has its back
      // button instead.
      drawer: pushed
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
                  : ListenableBuilder(
                      listenable: Listenable.merge([session, session.inbox]),
                      builder: (context, _) => RefreshIndicator(
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
    final several = inbox.swarms.length > 1;
    List<Widget> needs({required bool first}) => [
      SwarmCaption('Needs you', count: inbox.needs.length, first: first),
      if (inbox.needs.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: SwarmRow.line(
            inbox.loaded ? 'Nothing needs you.' : 'Reading your Swarms…',
            key: const ValueKey('swarm-needs-none'),
          ),
        )
      else
        SwarmGroup(children: _needs(context, session)),
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
    List<Widget> swarms({required bool first}) => [
      if (pm.isNotEmpty) ...[
        SwarmCaption('Chat with PM', first: first),
        SwarmGroup(children: pm),
      ],
      if (_pmError case final error?)
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
          child: SwarmRow.line(
            error,
            key: const ValueKey('swarm-pm-error'),
            lines: 3,
            color: AppColors.danger,
          ),
        ),
      for (final (i, swarm) in inbox.swarms.indexed) ...[
        SwarmCaption(
          several ? swarm.name : 'Projects',
          first: first && pm.isEmpty && i == 0,
        ),
        SwarmGroup(children: _projects(context, session, swarm.id)),
      ],
      if (inbox.loaded && inbox.swarms.isEmpty) ...[
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
      if (inbox.error case final error?)
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
          child: SwarmRow.line(
            error,
            key: const ValueKey('swarm-error'),
            lines: 3,
            color: AppColors.danger,
          ),
        ),
      ...swarmNeedsFirst
          ? [...needs(first: true), ...swarms(first: false)]
          : [...swarms(first: true), ...needs(first: false)],
    ];
  }

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
    SwarmSession session,
    String swarmId,
  ) {
    final reader = session.inbox.reader(swarmId);
    final snapshot = reader?.snapshot;
    if (snapshot == null) {
      return [
        SwarmRow(
          title: reader?.error ?? 'Reading…',
          detail: reader?.error == null
              ? null
              : SwarmRow.line('Pull down to try again.'),
          onTap: null,
        ),
      ];
    }
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
