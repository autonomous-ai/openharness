import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/settings_row.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'swarm_choices.dart';
import 'swarm_conversation_page.dart';
import 'swarm_need_rows.dart';
import 'swarm_project_page.dart';
import 'swarm_session.dart';
import 'team_glance.dart';

/// Swarm on the phone: what every Swarm of the account asks of the person
/// ("Needs you"), and the Swarms themselves, each project with its team in a
/// line ([swarmNeedsFirst] orders the two).
///
/// Reached from the Swarm command in Find and from Home's Swarm mark, both
/// offered only while Settings ▸ Experimental ▸ Swarm is on
/// ([PhoneExperiment.swarm]). Reads the account's [SwarmSession] from the
/// shell; with none, says why.
class SwarmPage extends StatefulWidget {
  const SwarmPage({super.key});

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

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = _session;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (Navigator.of(context).canPop())
              Align(
                alignment: Alignment.centerLeft,
                child: TtyBackButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
              ),
            Expanded(
              child: session == null
                  ? _Unavailable(tty: tty)
                  : ListenableBuilder(
                      listenable: Listenable.merge([session, session.inbox]),
                      builder: (context, _) => RefreshIndicator(
                        onRefresh: session.inbox.refresh,
                        child: ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: EdgeInsets.fromLTRB(
                            Tty.origin,
                            8,
                            Tty.origin,
                            MediaQuery.paddingOf(context).bottom + 24,
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
    final needs = [
      const SettingsCaption('Needs you'),
      if (inbox.needs.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            inbox.loaded ? 'Nothing needs you.' : 'Reading your Swarms…',
            key: const ValueKey('swarm-needs-none'),
            style: tty.style(color: tty.dim),
          ),
        )
      else
        SettingsGroup(
          children: [
            for (final need in inbox.needs)
              SwarmNeedRow(
                session: session,
                need: need,
                onOpen: (swarmId, conversationId) =>
                    openSwarmConversation(context, swarmId, conversationId),
              ),
          ],
        ),
    ];
    final swarms = [
      for (final swarm in inbox.swarms) ...[
        SettingsCaption(swarm.name),
        SettingsGroup(children: _projects(context, session, swarm.id)),
      ],
      if (inbox.loaded && inbox.swarms.isEmpty) ...[
        const SettingsCaption('Your Swarms'),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            'No Swarm yet. Start one on your computer.',
            style: tty.style(color: tty.dim),
          ),
        ),
      ],
    ];
    return [
      const TtyText('Swarm', size: TtySize.title, weight: FontWeight.w600),
      if (inbox.error case final error?) ...[
        const SizedBox(height: 8),
        Text(
          error,
          key: const ValueKey('swarm-error'),
          style: tty.style(color: tty.red),
        ),
      ],
      ...swarmNeedsFirst ? [...needs, ...swarms] : [...swarms, ...needs],
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
        SettingsRow(
          title: reader?.error ?? 'Reading…',
          destructive: reader?.error != null,
        ),
      ];
    }
    if (snapshot.projects.isEmpty) {
      return [const SettingsRow(title: 'No project yet')];
    }
    return [
      for (final project in snapshot.projects)
        SettingsRow(
          key: ValueKey('swarm-project-$swarmId-${project.id}'),
          title: project.name,
          detail: swarmTeamGlance(snapshot, projectId: project.id).line,
          onTap: () => Navigator.of(context).push(
            phoneRoute(
              (_) => SwarmProjectPage(swarmId: swarmId, projectId: project.id),
            ),
          ),
        ),
    ];
  }
}

/// No session: Swarm is off, or nobody is signed in on this phone.
class _Unavailable extends StatelessWidget {
  const _Unavailable({required this.tty});

  final Tty tty;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(Tty.origin, 8, Tty.origin, 24),
    children: [
      TtyText(
        PhoneExperiment.swarm.label,
        size: TtySize.title,
        weight: FontWeight.w600,
      ),
      const SizedBox(height: 16),
      Text(
        'Swarm is off on this phone, or you are signed out. '
        'Turn it on in Settings ▸ Experimental.',
        key: const ValueKey('swarm-unavailable'),
        style: tty.style(color: tty.faint, size: TtySize.row),
      ),
    ],
  );
}
