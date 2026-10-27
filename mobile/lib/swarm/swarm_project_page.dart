import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/settings_row.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_conversation_page.dart';
import 'swarm_request.dart';
import 'swarm_session.dart';
import 'team_glance.dart';

/// The conversations of one project the person may read, as the project page
/// lists them: its work by latest activity, and the quiet or archived work
/// behind "Older". The Lead's chat and the person's Chat with PM
/// ([pmChatId]) are pinned above, so they are not here; a private chat is
/// listed only to its people (the backend's rule, kept here too).
({List<SuperTabConversation> active, List<SuperTabConversation> older})
swarmProjectWork(
  SuperTabSnapshot snapshot,
  SuperTabProject project,
  String accountId, {
  String? pmChatId,
}) {
  final work =
      snapshot.conversations
          .where(
            (g) =>
                g.projectId == project.id &&
                g.id != project.leadConversationId &&
                g.id != pmChatId &&
                (g.audience?.contains(accountId) ?? true),
          )
          .toList()
        ..sort(
          (a, b) => b.lastMessageSequence.compareTo(a.lastMessageSequence),
        );
  return (
    active: [
      for (final g in work)
        if (!g.closed) g,
    ],
    older: [
      for (final g in work)
        if (g.closed) g,
    ],
  );
}

/// One project: its team in a line ([swarmTeamLine]), Chat with PM and the
/// Lead's chat pinned first, then its work by latest activity, older work
/// folded under "Older" — read from the Swarm's closed work when opened, as
/// no first load has it ([SwarmReader.loadDormant]).
class SwarmProjectPage extends StatefulWidget {
  const SwarmProjectPage({
    super.key,
    required this.swarmId,
    required this.projectId,
  });

  final String swarmId, projectId;

  @override
  State<SwarmProjectPage> createState() => _SwarmProjectPageState();
}

class _SwarmProjectPageState extends State<SwarmProjectPage> {
  SwarmSession? _session;
  bool _older = false, _openingPm = false;
  String? _error, _olderError;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.leave();
    _session = session?..enter();
  }

  @override
  void dispose() {
    _session?.leave();
    super.dispose();
  }

  void _open(String conversationId) =>
      openSwarmConversation(context, widget.swarmId, conversationId);

  void _toggleOlder() {
    setState(() => _older = !_older);
    if (_older) unawaited(_readOlder());
  }

  /// The project's closed work: its first page, or [earlier] the next.
  Future<void> _readOlder({bool earlier = false}) async {
    final reader = _session?.inbox.reader(widget.swarmId);
    if (reader == null) return;
    setState(() => _olderError = null);
    try {
      await reader.loadDormant(widget.projectId, earlier: earlier);
    } catch (_) {
      if (mounted) {
        setState(() => _olderError = 'Could not load older work. Try again.');
      }
    }
  }

  Future<void> _openPm() async {
    final reader = _session?.inbox.reader(widget.swarmId);
    if (reader == null || _openingPm) return;
    setState(() {
      _openingPm = true;
      _error = null;
    });
    String? id;
    try {
      id = await openSwarmPmChat(reader, widget.projectId);
      if (id == null) _error = 'Chat with PM is not ready yet. Try again.';
    } on SuperTabFailure catch (failure) {
      _error = failure.message;
    } catch (_) {
      _error = 'Could not open Chat with PM. Try again.';
    }
    if (!mounted) return;
    setState(() => _openingPm = false);
    if (id != null) _open(id);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = _session;
    final reader = session?.inbox.reader(widget.swarmId);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: session == null || reader == null
                  ? const SizedBox.shrink()
                  : ListenableBuilder(
                      listenable: Listenable.merge([session.inbox, reader]),
                      builder: (context, _) => ListView(
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
          ],
        ),
      ),
    );
  }

  List<Widget> _body(BuildContext context, SwarmSession session, Tty tty) {
    final reader = session.inbox.reader(widget.swarmId)!;
    final snapshot = reader.snapshot;
    final project = snapshot?.projects
        .where((p) => p.id == widget.projectId)
        .firstOrNull;
    if (snapshot == null || project == null) {
      return [
        Text(
          reader.error ?? 'This project is no longer in the Swarm.',
          style: tty.style(color: tty.dim),
        ),
      ];
    }
    final glance = swarmTeamGlance(snapshot, projectId: project.id);
    final pm = swarmPmChat(reader, project.id);
    final lead = snapshot.conversation(project.leadConversationId);
    final work = swarmProjectWork(
      snapshot,
      project,
      session.accountId,
      pmChatId: pm?.id,
    );
    final olderRead = reader.dormantLoaded(project.id);
    final olderReading = reader.dormantLoading(project.id);
    SettingsRow row(SuperTabConversation g) => SettingsRow(
      key: ValueKey('swarm-conversation-${g.id}'),
      title: g.label,
      detail: _status(snapshot, g),
      onTap: () => _open(g.id),
    );
    return [
      TtyText(project.name, size: TtySize.title, weight: FontWeight.w600),
      const SizedBox(height: 4),
      Text(snapshot.name, style: tty.style(color: tty.dim)),
      if (swarmTeamLine) ...[
        const SizedBox(height: 12),
        SettingsGroup(
          children: [
            SettingsRow(
              key: const ValueKey('swarm-team-line'),
              title: 'Team',
              detail: glance.line,
              onTap: () => Navigator.of(context).push(
                phoneRoute(
                  (_) => SwarmTeamPage(
                    swarmId: widget.swarmId,
                    projectId: project.id,
                  ),
                ),
              ),
            ),
          ],
        ),
      ],
      const SizedBox(height: 12),
      SettingsGroup(
        children: [
          SettingsRow(
            key: const ValueKey('swarm-pm-chat'),
            title: 'Chat with PM',
            detail: pm == null ? 'Just you and the Product Manager' : null,
            value: _openingPm ? 'Opening…' : null,
            onTap: _openingPm ? null : () => unawaited(_openPm()),
          ),
          if (lead != null)
            SettingsRow(
              key: const ValueKey('swarm-lead-chat'),
              title: 'Product Manager',
              detail: lead.leadId == null
                  ? 'With the whole project'
                  : '${snapshot.agentName(lead.leadId!)}, with the whole project',
              onTap: () => _open(lead.id),
            ),
        ],
      ),
      if (_error case final error?) ...[
        const SizedBox(height: 8),
        Text(error, style: tty.style(color: tty.red)),
      ],
      const SettingsCaption('Work'),
      if (work.active.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text('No work going on.', style: tty.style(color: tty.dim)),
        )
      else
        SettingsGroup(children: [for (final g in work.active) row(g)]),
      const SizedBox(height: 12),
      SettingsGroup(
        children: [
          SettingsRow(
            key: const ValueKey('swarm-older'),
            title: _older ? 'Hide older' : 'Older',
            value: olderReading
                ? 'Loading…'
                : olderRead
                ? '${work.older.length}'
                : null,
            onTap: _toggleOlder,
          ),
          if (_older) ...[
            for (final g in work.older) row(g),
            if (reader.hasEarlierDormant(project.id))
              SettingsRow(
                key: const ValueKey('swarm-older-earlier'),
                title: 'Show earlier',
                value: olderReading ? 'Loading…' : null,
                onTap: olderReading
                    ? null
                    : () => unawaited(_readOlder(earlier: true)),
              ),
          ],
        ],
      ),
      if (_older && _olderError != null) ...[
        const SizedBox(height: 8),
        Text(_olderError!, style: tty.style(color: tty.red)),
      ] else if (_older && olderRead && work.older.isEmpty) ...[
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text('No older work.', style: tty.style(color: tty.dim)),
        ),
      ],
    ];
  }

  /// "Nova · needs you", from the work it holds; null when nobody holds it.
  static String? _status(SuperTabSnapshot snapshot, SuperTabConversation g) {
    final assignment = g.assignment;
    final status = assignment?['status'];
    if (assignment == null || status is! String) return null;
    final agent = snapshot.agentName(assignment['agentId'] as String? ?? '');
    return '$agent · ${superTabWorkStatusLabel(status)}';
  }
}

/// The team of one project, each agent in a word, who needs a person first.
class SwarmTeamPage extends StatelessWidget {
  const SwarmTeamPage({
    super.key,
    required this.swarmId,
    required this.projectId,
  });

  final String swarmId, projectId;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final reader = SwarmScope.of(context)?.inbox.reader(swarmId);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: reader == null
                  ? const SizedBox.shrink()
                  : ListenableBuilder(
                      listenable: reader,
                      builder: (context, _) {
                        final snapshot = reader.snapshot;
                        final glance = snapshot == null
                            ? null
                            : swarmTeamGlance(snapshot, projectId: projectId);
                        return ListView(
                          padding: EdgeInsets.fromLTRB(
                            Tty.origin,
                            8,
                            Tty.origin,
                            MediaQuery.paddingOf(context).bottom + 24,
                          ),
                          children: [
                            const TtyText(
                              'Team',
                              size: TtySize.title,
                              weight: FontWeight.w600,
                            ),
                            if (glance != null) ...[
                              const SizedBox(height: 4),
                              Text(
                                glance.line,
                                style: tty.style(color: tty.dim),
                              ),
                              const SizedBox(height: 12),
                              if (glance.agents.isNotEmpty)
                                SettingsGroup(
                                  children: [
                                    for (final a in glance.agents)
                                      SettingsRow(
                                        key: ValueKey(
                                          'swarm-agent-${a.agent.id}',
                                        ),
                                        title: a.name,
                                        detail: a.task?.label,
                                        value: a.label,
                                      ),
                                  ],
                                ),
                            ],
                          ],
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
