import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_conversation_page.dart';
import 'swarm_inbox.dart';
import 'swarm_pm_chat.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_team_line.dart';
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

/// The conversations of [swarmId] whose work waits on the person: those of
/// its Needs you ([SwarmInbox.needs]), so one rule says what waits.
Set<String> swarmWaitingOnYou(SwarmInbox inbox, String swarmId) => {
  for (final need in inbox.needs)
    if (need is SwarmWorkNeed && need.swarmId == swarmId) need.conversationId,
};

/// One project, as the approved prototype draws it: its name in the top bar;
/// its team as avatars and a line ([swarmTeamLine]), each agent in a sheet;
/// Chat with PM as its one main button; the project chat (its Product
/// Manager and everyone); then its work — what waits on the person, then
/// what the team is working on, by latest activity — and older work folded
/// under "Older", read from the Swarm's closed work when opened, as no first
/// load has it ([SwarmReader.loadDormant]).
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
    final error = await openSwarmPm(
      context,
      reader,
      widget.swarmId,
      widget.projectId,
    );
    if (!mounted) return;
    setState(() {
      _openingPm = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = _session;
    final reader = session?.inbox.reader(widget.swarmId);
    final back = SwarmBackButton(
      onPressed: () => Navigator.of(context).maybePop(),
    );
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: session == null || reader == null
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [SwarmTopBar(leading: back, title: '')],
              )
            : ListenableBuilder(
                listenable: Listenable.merge([session.inbox, reader]),
                builder: (context, _) {
                  final snapshot = reader.snapshot;
                  final project = snapshot?.projects
                      .where((p) => p.id == widget.projectId)
                      .firstOrNull;
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SwarmTopBar(
                        leading: back,
                        title: project?.name ?? '',
                        // With one Swarm, its name would say nothing new.
                        subtitle: session.inbox.swarms.length > 1
                            ? snapshot?.name
                            : null,
                      ),
                      Expanded(
                        child: ListView(
                          padding: EdgeInsets.fromLTRB(
                            12,
                            0,
                            12,
                            MediaQuery.paddingOf(context).bottom + 28,
                          ),
                          children: snapshot == null || project == null
                              ? [
                                  Padding(
                                    padding: const EdgeInsets.fromLTRB(
                                      4,
                                      8,
                                      4,
                                      0,
                                    ),
                                    child: SwarmRow.line(
                                      reader.error ??
                                          'This project is no longer in the '
                                              'Swarm.',
                                      lines: 3,
                                    ),
                                  ),
                                ]
                              : _body(context, session, snapshot, project),
                        ),
                      ),
                    ],
                  );
                },
              ),
      ),
    );
  }

  List<Widget> _body(
    BuildContext context,
    SwarmSession session,
    SuperTabSnapshot snapshot,
    SuperTabProject project,
  ) {
    final reader = session.inbox.reader(widget.swarmId)!;
    final glance = swarmTeamGlance(snapshot, projectId: project.id);
    final pm = swarmPmChat(reader, project.id);
    final lead = snapshot.conversation(project.leadConversationId);
    final work = swarmProjectWork(
      snapshot,
      project,
      session.accountId,
      pmChatId: pm?.id,
    );
    final waits = swarmWaitingOnYou(session.inbox, widget.swarmId);
    final waiting = [
      for (final g in work.active)
        if (waits.contains(g.id)) g,
    ];
    final working = [
      for (final g in work.active)
        if (!waits.contains(g.id)) g,
    ];
    final olderRead = reader.dormantLoaded(project.id);
    final olderReading = reader.dormantLoading(project.id);
    SwarmRow row(SuperTabConversation g) {
      final agentId = g.assignment?['agentId'] as String?;
      return SwarmRow(
        key: ValueKey('swarm-conversation-${g.id}'),
        // Nobody holds it: its number still lines up with the others'.
        leading: agentId == null
            ? const SizedBox(width: 24)
            : SwarmAvatar(
                id: agentId,
                name: snapshot.agentName(agentId),
                size: 24,
              ),
        number: g.number == null ? null : '#${g.number}',
        title: g.title,
        detail: switch (_status(snapshot, g)) {
          final status? => SwarmRow.line(status),
          null => null,
        },
        onTap: () => _open(g.id),
      );
    }

    return [
      if (swarmTeamLine) ...[
        const SizedBox(height: 6),
        _TeamButton(
          glance: glance,
          pmId: lead?.leadId,
          onTap: () => showSwarmTeam(
            context,
            swarmId: widget.swarmId,
            projectId: project.id,
          ),
        ),
      ],
      const SizedBox(height: 12),
      SwarmButton(
        key: const ValueKey('swarm-pm-chat'),
        icon: LucideIcons.messageSquare300,
        label: 'Chat with PM',
        style: SwarmButtonStyle.fill,
        wide: true,
        busy: _openingPm,
        busyLabel: 'Opening…',
        onPressed: () => unawaited(_openPm()),
      ),
      if (_error case final error?) ...[
        const SizedBox(height: 8),
        SwarmRow.line(
          error,
          key: const ValueKey('swarm-pm-error'),
          lines: 3,
          color: AppColors.danger,
        ),
      ],
      if (lead != null) ...[
        const SizedBox(height: 8),
        SwarmGroup(
          children: [
            SwarmRow(
              key: const ValueKey('swarm-lead-chat'),
              leading: switch (lead.leadId) {
                final id? => SwarmAvatar(
                  id: id,
                  name: snapshot.agentName(id),
                  size: 24,
                ),
                null => null,
              },
              title: 'Project chat',
              detail: SwarmRow.line(switch (lead.leadId) {
                final id? => '${snapshot.agentName(id)} and everyone',
                null => 'Everyone in the project',
              }),
              onTap: () => _open(lead.id),
            ),
          ],
        ),
      ],
      if (waiting.isNotEmpty) ...[
        const SwarmCaption('Waiting on you'),
        SwarmGroup(children: [for (final g in waiting) row(g)]),
      ],
      const SwarmCaption('Working on'),
      if (working.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: SwarmRow.line('No work going on.'),
        )
      else
        SwarmGroup(children: [for (final g in working) row(g)]),
      const SizedBox(height: 32),
      SwarmGroup(
        children: [
          SwarmRow(
            key: const ValueKey('swarm-older'),
            title: _older
                ? 'Hide older'
                : olderRead
                ? 'Older (${work.older.length})'
                : 'Older',
            trailing: olderReading ? SwarmRow.line('Loading…') : null,
            chevron: _older
                ? LucideIcons.chevronDown300
                : LucideIcons.chevronRight300,
            onTap: _toggleOlder,
          ),
          if (_older) ...[
            for (final g in work.older) row(g),
            if (reader.hasEarlierDormant(project.id))
              SwarmRow(
                key: const ValueKey('swarm-older-earlier'),
                title: 'Show earlier',
                trailing: olderReading ? SwarmRow.line('Loading…') : null,
                onTap: olderReading
                    ? null
                    : () => unawaited(_readOlder(earlier: true)),
              ),
          ],
        ],
      ),
      if (_older && _olderError != null) ...[
        const SizedBox(height: 8),
        SwarmRow.line(_olderError!, lines: 2, color: AppColors.danger),
      ] else if (_older && olderRead && work.older.isEmpty) ...[
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: SwarmRow.line('No older work.'),
        ),
      ],
    ];
  }

  /// "Nova · Needs you"-like, from the work it holds; null when nobody holds
  /// it.
  static String? _status(SuperTabSnapshot snapshot, SuperTabConversation g) {
    final assignment = g.assignment;
    final status = assignment?['status'];
    if (assignment == null || status is! String) return null;
    final agent = snapshot.agentName(assignment['agentId'] as String? ?? '');
    final label = superTabWorkStatusLabel(status);
    return label.isEmpty
        ? agent
        : '$agent · ${label[0].toUpperCase()}${label.substring(1)}';
  }
}

/// The team with its Product Manager first, as the prototype lists it; the
/// rest as [swarmTeamGlance] orders them, who needs the person first.
List<SwarmAgentGlance> _pmFirst(SwarmTeamGlance glance, String? pmId) => [
  ...glance.agents.where((a) => a.agent.id == pmId),
  ...glance.agents.where((a) => a.agent.id != pmId),
];

/// The team in one card: its avatars overlapping, its line, a chevron.
class _TeamButton extends StatelessWidget {
  const _TeamButton({
    required this.glance,
    required this.pmId,
    required this.onTap,
  });

  final SwarmTeamGlance glance;
  final String? pmId;
  final VoidCallback onTap;

  /// Avatars past this many would crowd out the line.
  static const _most = 5;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final agents = _pmFirst(glance, pmId).take(_most).toList();
    return Material(
      key: const ValueKey('swarm-team-line'),
      color: AppGlass.rowFill,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: SwarmRow.height),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                if (agents.isNotEmpty) ...[
                  SizedBox(
                    width: 24 + 17.0 * (agents.length - 1),
                    height: 24,
                    child: Stack(
                      children: [
                        for (final (i, a) in agents.indexed)
                          Positioned(
                            left: 17.0 * i,
                            child: SwarmAvatar(
                              id: a.agent.id,
                              name: a.name,
                              size: 24,
                              ring: AppGlass.rowFill,
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                ],
                Expanded(child: SwarmTeamLine(glance, size: 14, spread: true)),
                const SizedBox(width: 12),
                Icon(
                  LucideIcons.chevronRight300,
                  size: 18,
                  color: AppPalette.textFaint,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The team of one project in a sheet over its page: each agent with its
/// avatar, its name and its role in a tag (PM, Dev or Rev), and its state in
/// a word with the work it holds; the Product Manager first, then who needs
/// a person.
Future<void> showSwarmTeam(
  BuildContext context, {
  required String swarmId,
  required String projectId,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  backgroundColor: AppGlass.rowFill,
  barrierColor: Colors.black.withValues(alpha: .55),
  shape: const RoundedRectangleBorder(
    borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
  ),
  // On the page's own navigator, under the shell's [SwarmScope].
  builder: (_) => SwarmTeamSheet(swarmId: swarmId, projectId: projectId),
);

/// What [showSwarmTeam] shows.
class SwarmTeamSheet extends StatelessWidget {
  const SwarmTeamSheet({
    super.key,
    required this.swarmId,
    required this.projectId,
  });

  final String swarmId, projectId;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final reader = SwarmScope.of(context)?.inbox.reader(swarmId);
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .82,
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 16),
          child: reader == null
              ? const SizedBox.shrink()
              : ListenableBuilder(
                  listenable: reader,
                  builder: (context, _) {
                    final snapshot = reader.snapshot;
                    final project = snapshot?.projects
                        .where((p) => p.id == projectId)
                        .firstOrNull;
                    final glance = snapshot == null
                        ? null
                        : swarmTeamGlance(snapshot, projectId: projectId);
                    final pmId = snapshot == null || project == null
                        ? null
                        : swarmPmId(snapshot, project);
                    final agents = glance == null
                        ? const <SwarmAgentGlance>[]
                        : _pmFirst(glance, pmId);
                    return Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Center(
                          child: Container(
                            width: 36,
                            height: 5,
                            margin: const EdgeInsets.only(bottom: 8),
                            decoration: BoxDecoration(
                              color: AppGlass.hair,
                              borderRadius: BorderRadius.circular(3),
                            ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.fromLTRB(4, 0, 2, 6),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  project?.name ?? 'Team',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: AppPalette.textPrimary,
                                    fontSize: 18,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                              SwarmIconButton(
                                key: const ValueKey('swarm-team-close'),
                                icon: LucideIcons.x300,
                                label: 'Close',
                                onPressed: () => Navigator.of(context).pop(),
                              ),
                            ],
                          ),
                        ),
                        if (glance != null && glance.agents.isEmpty)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
                            child: SwarmRow.line(glance.line),
                          ),
                        if (glance != null && glance.agents.isNotEmpty)
                          Flexible(
                            child: ListView.separated(
                              shrinkWrap: true,
                              itemCount: agents.length,
                              separatorBuilder: (_, _) => Divider(
                                height: 1,
                                thickness: 1,
                                color: AppGlass.hair,
                              ),
                              itemBuilder: (context, i) => _Mate(
                                glance: agents[i],
                                role: agents[i].agent.id == pmId
                                    ? 'PM'
                                    : agents[i].agent.isReviewer
                                    ? 'Rev'
                                    : 'Dev',
                              ),
                            ),
                          ),
                      ],
                    );
                  },
                ),
        ),
      ),
    );
  }
}

/// One agent of the team sheet.
class _Mate extends StatelessWidget {
  const _Mate({required this.glance, required this.role});

  final SwarmAgentGlance glance;

  /// Its role in a tag: PM, Dev (a Builder) or Rev (a Reviewer).
  final String role;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final down = glance.state == SwarmAgentState.down;
    return Padding(
      key: ValueKey('swarm-agent-${glance.agent.id}'),
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 12),
      child: Row(
        children: [
          SwarmAvatar(id: glance.agent.id, name: glance.name),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        glance.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppPalette.textPrimary,
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    DecoratedBox(
                      decoration: BoxDecoration(
                        border: Border.all(color: AppGlass.hair),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Text(
                          role,
                          style: tty
                              .style(
                                size: 11,
                                weight: FontWeight.w600,
                                color: AppPalette.textSecondary,
                              )
                              .copyWith(height: 16 / 11),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '●\u00A0',
                        style: TextStyle(color: swarmStateColor(glance.state)),
                      ),
                      TextSpan(
                        text: glance.label,
                        style: down
                            ? TextStyle(color: swarmStateColor(glance.state))
                            : null,
                      ),
                      if (glance.task case final task?)
                        TextSpan(text: ' · ${task.label}'),
                    ],
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: 13.5,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
