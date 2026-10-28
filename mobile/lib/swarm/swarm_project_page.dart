import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_conversation_page.dart';
import 'swarm_inbox.dart';
import 'swarm_pm_chat.dart';
import 'swarm_reader.dart';
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

  /// What the page shows of the inbox ([_inboxChanged]): its Swarm's
  /// reader, whether there are several Swarms, why the list was not read.
  SwarmReader? _reader;
  bool _several = false;
  String? _listError;

  /// A read of the Swarm since the page opened has finished ([_readOnOpen]).
  /// Until then, a project the Swarm did not have may be one just made.
  bool _read = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.inbox.removeListener(_inboxChanged);
    _session?.leave();
    _session = session?..enter();
    session?.inbox.addListener(_inboxChanged);
    _seeInbox();
    _readOnOpen();
  }

  @override
  void dispose() {
    _session?.inbox.removeListener(_inboxChanged);
    _session?.leave();
    super.dispose();
  }

  /// The inbox tells of every change of every Swarm, and again when what
  /// waits on the person is read after one; the page is built again only
  /// when what it shows of the inbox moved. Its Swarm's own changes come
  /// from its reader, and what waits in its chats is read off the inbox,
  /// which has caught up by the time the page is built.
  void _inboxChanged() {
    final inbox = _session?.inbox;
    if (inbox == null) return;
    final seen = (
      inbox.reader(widget.swarmId),
      inbox.swarms.length > 1,
      inbox.error,
    );
    if (seen != (_reader, _several, _listError)) setState(_seeInbox);
  }

  void _seeInbox() {
    final inbox = _session?.inbox;
    _reader = inbox?.reader(widget.swarmId);
    _several = (inbox?.swarms.length ?? 0) > 1;
    _listError = inbox?.error;
  }

  /// Reads the Swarm as the page opens: what Home read may be 15 seconds
  /// old, or from before the project was made. Not listed yet, the list is
  /// read with it.
  void _readOnOpen() {
    final session = _session;
    _read = false;
    if (session == null) return;
    final read = _reader?.refresh() ?? session.inbox.refresh();
    unawaited(
      read.whenComplete(() {
        if (mounted && _session == session) setState(() => _read = true);
      }),
    );
  }

  /// A pull: one read of the Swarm, joining one under way.
  Future<void> _pull() =>
      _reader?.refresh() ?? _session?.inbox.refresh() ?? Future.value();

  void _open(String conversationId) =>
      openSwarmConversation(context, widget.swarmId, conversationId);

  void _toggleOlder() {
    setState(() => _older = !_older);
    if (_older) unawaited(_readOlder());
  }

  /// The project's closed work: its first page, or [earlier] the next.
  Future<void> _readOlder({bool earlier = false}) async {
    final reader = _reader;
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
    final reader = _reader;
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
    final reader = _reader;
    final back = SwarmBackButton(
      onPressed: () => Navigator.of(context).maybePop(),
    );
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: session == null
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [SwarmTopBar(leading: back, title: '')],
              )
            : ListenableBuilder(
                // Not listed yet: the inbox tells when it is ([_inboxChanged]).
                listenable: reader ?? Listenable.merge(const []),
                builder: (context, _) {
                  final snapshot = reader?.snapshot;
                  final project = snapshot?.projects
                      .where((p) => p.id == widget.projectId)
                      .firstOrNull;
                  if (snapshot != null && project != null) {
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        SwarmTopBar(
                          leading: back,
                          title: project.name,
                          // With one Swarm, its name would say nothing new.
                          subtitle: _several ? snapshot.name : null,
                        ),
                        Expanded(
                          child: RefreshIndicator(
                            onRefresh: _pull,
                            child: CustomScrollView(
                              physics: const AlwaysScrollableScrollPhysics(),
                              slivers: _body(
                                context,
                                session,
                                reader!,
                                snapshot,
                                project,
                              ),
                            ),
                          ),
                        ),
                      ],
                    );
                  }
                  // Why there is no project to show: still reading, or a read
                  // that failed or finished without it.
                  final why = switch (reader) {
                    null => _listError ?? (_read ? _gone : null),
                    // Taken away: nothing of it stays, and none is read.
                    SwarmReader(accessRevoked: true) => reader.error ?? _gone,
                    SwarmReader(snapshot: null) => reader.error,
                    _ => _read ? reader.error ?? _gone : null,
                  };
                  if (why == null) {
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _LoadingTopBar(leading: back),
                        const Expanded(child: _Loading()),
                      ],
                    );
                  }
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SwarmTopBar(leading: back, title: ''),
                      Expanded(
                        child: RefreshIndicator(
                          onRefresh: _pull,
                          child: ListView(
                            physics: const AlwaysScrollableScrollPhysics(),
                            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                            children: [SwarmRow.line(why, lines: 3)],
                          ),
                        ),
                      ),
                    ],
                  );
                },
              ),
      ),
    );
  }

  static const _gone = 'This project is no longer in the Swarm.';

  /// The page's slivers: the team, Chat with PM and the project chat at
  /// once; then its work, built row by row as it comes into view.
  List<Widget> _body(
    BuildContext context,
    SwarmSession session,
    SwarmReader reader,
    SuperTabSnapshot snapshot,
    SuperTabProject project,
  ) {
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
    final older = _older ? work.older : const <SuperTabConversation>[];
    final earlier = _older && reader.hasEarlierDormant(project.id);
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
                picture: snapshot.agent(agentId)?.avatar,
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

    Widget box(Widget child) => _Gutter(SliverToBoxAdapter(child: child));
    // A card whose rows are built only as they come into view.
    Widget card(int count, Widget Function(int i) build) => _Gutter(
      SliverList.builder(
        itemCount: count,
        itemBuilder: (context, i) =>
            _CardRow(first: i == 0, last: i == count - 1, child: build(i)),
      ),
    );

    return [
      _Gutter(
        SliverList.list(
          children: [
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
                        picture: snapshot.agent(id)?.avatar,
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
          ],
        ),
      ),
      if (waiting.isNotEmpty) ...[
        box(const SwarmCaption('Waiting on you')),
        card(waiting.length, (i) => row(waiting[i])),
      ],
      box(const SwarmCaption('Working on')),
      if (working.isEmpty)
        box(
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: SwarmRow.line('No work going on.'),
          ),
        )
      else
        card(working.length, (i) => row(working[i])),
      box(const SizedBox(height: 32)),
      card(1 + older.length + (earlier ? 1 : 0), (i) {
        if (i == 0) {
          return SwarmRow(
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
          );
        }
        if (i <= older.length) return row(older[i - 1]);
        return SwarmRow(
          key: const ValueKey('swarm-older-earlier'),
          title: 'Show earlier',
          trailing: olderReading ? SwarmRow.line('Loading…') : null,
          onTap: olderReading
              ? null
              : () => unawaited(_readOlder(earlier: true)),
        );
      }),
      if (_older && _olderError != null)
        box(
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SwarmRow.line(
              _olderError!,
              lines: 2,
              color: AppColors.danger,
            ),
          ),
        )
      else if (_older && olderRead && work.older.isEmpty)
        box(
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
            child: SwarmRow.line('No older work.'),
          ),
        ),
      SliverToBoxAdapter(
        child: SizedBox(height: MediaQuery.paddingOf(context).bottom + 28),
      ),
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

/// A sliver with the page's side margins.
class _Gutter extends StatelessWidget {
  const _Gutter(this.sliver);

  final Widget sliver;

  @override
  Widget build(BuildContext context) => SliverPadding(
    padding: const EdgeInsets.symmetric(horizontal: 12),
    sliver: sliver,
  );
}

/// One row of a card built row by row: a [SwarmGroup] drawn a row at a time,
/// its corners rounded at its [first] and [last] row and a hairline above
/// every row but the first.
class _CardRow extends StatelessWidget {
  const _CardRow({
    required this.first,
    required this.last,
    required this.child,
  });

  final bool first, last;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ClipRRect(
      borderRadius: BorderRadius.vertical(
        top: Radius.circular(first ? 14 : 0),
        bottom: Radius.circular(last ? 14 : 0),
      ),
      child: ColoredBox(
        color: AppGlass.rowFill,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!first) Divider(height: 1, thickness: 1, color: AppGlass.hair),
            child,
          ],
        ),
      ),
    );
  }
}

/// The top bar while the project is read: its back, and its name on its way
/// in the title's place, the height of [SwarmTopBar].
class _LoadingTopBar extends StatelessWidget {
  const _LoadingTopBar({required this.leading});

  final Widget leading;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(4, 2, 8, 2),
        child: Row(
          children: [
            leading,
            const SizedBox(width: 4),
            Expanded(
              child: Align(
                alignment: Alignment.centerLeft,
                child: SkeletonText(
                  key: const ValueKey('swarm-project-title-loading'),
                  style: Tty.of(context)
                      .style(size: 17, weight: FontWeight.w600)
                      .copyWith(height: 1.25),
                  width: 120,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The page on its way, each part the size of what replaces it: the team,
/// Chat with PM, the project chat, and three rows of work.
class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) => SkeletonBlock(
    key: const ValueKey('swarm-project-loading'),
    child: ListView(
      physics: const NeverScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: 12),
      children: [
        if (swarmTeamLine) ...[
          const SizedBox(height: 6),
          const SwarmGroup(children: [_SkeletonRow(team: true)]),
        ],
        const SizedBox(height: 12),
        const Skeleton(height: 52, radius: 10),
        const SizedBox(height: 8),
        const SwarmGroup(children: [_SkeletonRow()]),
        const SwarmCaption('Working on'),
        SwarmGroup(
          children: [
            for (var i = 0; i < 3; i++)
              Opacity(
                opacity: skeletonFade(i, 3, depth: .4),
                child: _SkeletonRow(
                  key: ValueKey('swarm-project-loading-work-$i'),
                  width: i.isEven ? .45 : .6,
                ),
              ),
          ],
        ),
      ],
    ),
  );
}

/// A row on its way, the shape of a [SwarmRow] with a 24-point avatar and a
/// line under its title; or of the team card ([team]): overlapping avatars
/// and the team's line.
class _SkeletonRow extends StatelessWidget {
  const _SkeletonRow({super.key, this.width = .45, this.team = false});

  final double width;
  final bool team;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(minHeight: SwarmRow.height),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Row(
        children: [
          Skeleton(width: team ? 24 + 17.0 * 2 : 24, height: 24, radius: 12),
          const SizedBox(width: 12),
          Expanded(
            child: team
                ? const SkeletonText(
                    style: TextStyle(fontSize: 14, height: 1.35),
                    widthFactor: .6,
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SkeletonText(
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                          height: 1.3,
                        ),
                        widthFactor: width,
                      ),
                      const SizedBox(height: 3),
                      SkeletonText(
                        style: const TextStyle(fontSize: 13.5, height: 1.35),
                        widthFactor: width + .25,
                      ),
                    ],
                  ),
          ),
        ],
      ),
    ),
  );
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
                              picture: a.agent.avatar,
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
    final inbox = SwarmScope.of(context)?.inbox;
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .82,
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 16),
          child: inbox == null
              ? const SizedBox.shrink()
              // Not listed yet, the inbox tells when it is; then the Swarm's
              // reader tells what changes.
              : ListenableBuilder(
                  listenable: inbox,
                  builder: (context, _) => switch (inbox.reader(swarmId)) {
                    final reader? => ListenableBuilder(
                      listenable: reader,
                      builder: (context, _) => _sheet(context, reader),
                    ),
                    null => _sheet(context, null),
                  },
                ),
        ),
      ),
    );
  }

  Widget _sheet(BuildContext context, SwarmReader? reader) {
    final snapshot = reader?.snapshot;
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
        if (snapshot == null)
          switch (reader?.error) {
            final error? => Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
              child: SwarmRow.line(error, lines: 3),
            ),
            null => const _MatesLoading(),
          },
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
              separatorBuilder: (_, _) =>
                  Divider(height: 1, thickness: 1, color: AppGlass.hair),
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
  }
}

/// The team sheet's agents on their way: three, the shape of [_Mate].
class _MatesLoading extends StatelessWidget {
  const _MatesLoading();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SkeletonBlock(
      key: const ValueKey('swarm-team-loading'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < 3; i++) ...[
            if (i > 0) Divider(height: 1, thickness: 1, color: AppGlass.hair),
            Opacity(
              opacity: skeletonFade(i, 3, depth: .4),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 4,
                  vertical: 12,
                ),
                child: Row(
                  children: [
                    const Skeleton(
                      width: 32,
                      height: 32,
                      shape: BoxShape.circle,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SkeletonText(
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w500,
                            ),
                            widthFactor: i.isEven ? .35 : .5,
                          ),
                          const SizedBox(height: 3),
                          const SkeletonText(
                            style: TextStyle(fontSize: 13.5, height: 1.4),
                            widthFactor: .7,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
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
          SwarmAvatar(
            id: glance.agent.id,
            name: glance.name,
            picture: glance.agent.avatar,
          ),
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
