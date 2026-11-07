import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'model.dart';
import 'swarm_board.dart';
import 'swarm_needs_page.dart';
import 'swarm_project_page.dart' show swarmProjectWork;
import 'swarm_project_tasks.dart' show swarmProjectTasks;
import 'swarm_reader.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_task_status.dart' show swarmTaskPersonName;

/// What an empty column says it holds.
const _empty = {
  SwarmBoardColumn.proposal: 'No proposal is waiting for the Product Manager.',
  SwarmBoardColumn.nextUp: 'Nothing is next up.',
  SwarmBoardColumn.working: 'Nothing is being worked on.',
  SwarmBoardColumn.done: 'Nothing is waiting to merge.',
  SwarmBoardColumn.merged: 'Nothing is waiting for a release.',
  SwarmBoardColumn.shipped: 'Nothing has shipped this week.',
};

/// A project's Board (task #3821): the Needs you bar over six columns as tabs,
/// one page each, and in a column a card for every task or proposal, as
/// Desktop's Tasks board places them ([swarmBoardOf]). A tap on a task's card
/// opens its chat ([onOpen]); on a proposal's, the project's chat
/// ([onOpenChat]), where it was made.
class SwarmBoardPage extends StatefulWidget {
  const SwarmBoardPage({
    super.key,
    required this.session,
    required this.reader,
    required this.projectId,
    required this.onOpen,
    required this.onOpenChat,
  });

  final SwarmSession session;
  final SwarmReader reader;
  final String projectId;

  /// Opens one of the project's chats, by id.
  final ValueChanged<String> onOpen;

  /// Shows the project's own chat.
  final VoidCallback onOpenChat;

  @override
  State<SwarmBoardPage> createState() => _SwarmBoardPageState();
}

class _SwarmBoardPageState extends State<SwarmBoardPage> {
  /// It opens on Working, where the live work is.
  static const _first = SwarmBoardColumn.working;
  late final _pages = PageController(initialPage: _first.index);
  final _tabs = {for (final c in SwarmBoardColumn.values) c: GlobalKey()};
  var _column = _first;

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_read);
    // After this frame: the reads tell their listeners at once, and a build
    // is no place to do that.
    Future.microtask(_read);
  }

  @override
  void dispose() {
    widget.reader.removeListener(_read);
    _pages.dispose();
    super.dispose();
  }

  /// The two reads the Board needs beyond the Swarm's state; each asks the
  /// backend only when it has to ([SwarmReader.readProposals], [SwarmReader.loadShipped]).
  void _read({bool retry = false}) {
    if (!mounted) return;
    unawaited(widget.reader.readProposals(widget.projectId, retry: retry));
    unawaited(
      widget.reader.loadShipped(
        widget.projectId,
        clock.now().subtract(swarmBoardShippedWindow),
        retry: retry,
      ),
    );
  }

  Future<void> _refresh() async {
    _read(retry: true);
    await widget.reader.refresh();
  }

  void _select(SwarmBoardColumn column) {
    unawaited(
      _pages.animateToPage(
        column.index,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      ),
    );
  }

  void _shown(int index) {
    final column = SwarmBoardColumn.values[index];
    setState(() => _column = column);
    // A swipe leaves the chip of the new column in view.
    final chip = _tabs[column]!.currentContext;
    if (chip != null) {
      unawaited(
        Scrollable.ensureVisible(
          chip,
          duration: const Duration(milliseconds: 180),
          alignment: 0.5,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = widget.session;
    final reader = widget.reader;
    return ListenableBuilder(
      // Needs move with the session and its inbox; the work with the read.
      listenable: Listenable.merge([session, session.inbox, reader]),
      builder: (context, _) {
        final snapshot = reader.snapshot;
        final project = snapshot?.projects
            .where((p) => p.id == widget.projectId)
            .firstOrNull;
        if (snapshot == null || project == null) {
          return const SizedBox.shrink();
        }
        final now = clock.now();
        final waiting = swarmProjectTasks(
          session.inbox,
          reader,
          widget.projectId,
          now,
        ).waiting;
        final work = swarmProjectWork(
          snapshot,
          project,
          buddies: reader.buddies,
        );
        final board = swarmBoardOf(
          [...work.active, ...work.older],
          proposals: reader.proposalsOf(widget.projectId),
          waiting: {for (final need in waiting) need.conversationId},
          now: now,
          personName: swarmTaskPersonName(snapshot),
        );
        return Column(
          key: const ValueKey('swarm-board'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (waiting.isNotEmpty)
              _NeedsYouBar(
                count: waiting.length,
                onTap: () => openSwarmNeeds(context, swarmId: reader.tabId),
              ),
            _ColumnTabs(
              board: board,
              selected: _column,
              keys: _tabs,
              onSelect: _select,
            ),
            Expanded(
              child: PageView(
                key: const ValueKey('swarm-board-pages'),
                controller: _pages,
                onPageChanged: _shown,
                children: [
                  for (final column in SwarmBoardColumn.values)
                    _ColumnPage(
                      column: column,
                      entries: board[column]!,
                      snapshot: snapshot,
                      failure: switch (column) {
                        SwarmBoardColumn.proposal
                            when reader.proposalsFailed(widget.projectId) =>
                          'Proposals could not be read. Pull down to try again.',
                        SwarmBoardColumn.done ||
                        SwarmBoardColumn.merged ||
                        SwarmBoardColumn.shipped
                            when reader.shippedFailed(widget.projectId) =>
                          'Closed work could not be read. Pull down to try again.',
                        _ => null,
                      },
                      onRefresh: _refresh,
                      onOpen: (entry) => entry.task == null
                          ? widget.onOpenChat()
                          : widget.onOpen(entry.task!.id),
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

/// "Needs you  N" over the columns: what waits on the reader in this project,
/// opening Activity where it is answered.
class _NeedsYouBar extends StatelessWidget {
  const _NeedsYouBar({required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return InkWell(
      key: const ValueKey('swarm-board-needs-you'),
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.l),
          child: Row(
            children: [
              Text(
                'Needs you',
                style: AppType.label(color: AppPalette.textPrimary),
              ),
              const SizedBox(width: AppSpace.s),
              DecoratedBox(
                decoration: BoxDecoration(
                  color: AppCard.accent,
                  borderRadius: BorderRadius.circular(AppControl.radius),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
                  child: Text(
                    '$count',
                    style: AppType.caption(color: AppInk.onFill),
                  ),
                ),
              ),
              const Spacer(),
              Icon(
                LucideIcons.chevronRight,
                size: 18,
                color: AppPalette.textFaint,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The six columns as a scrollable row of tabs, each with its count.
class _ColumnTabs extends StatelessWidget {
  const _ColumnTabs({
    required this.board,
    required this.selected,
    required this.keys,
    required this.onSelect,
  });

  final Map<SwarmBoardColumn, List<SwarmBoardEntry>> board;
  final SwarmBoardColumn selected;
  final Map<SwarmBoardColumn, GlobalKey> keys;
  final ValueChanged<SwarmBoardColumn> onSelect;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.m,
        vertical: AppSpace.xs,
      ),
      child: Row(
        children: [
          for (final column in SwarmBoardColumn.values)
            _ColumnTab(
              key: keys[column],
              column: column,
              count: board[column]!.length,
              selected: column == selected,
              onTap: () => onSelect(column),
            ),
        ],
      ),
    );
  }
}

class _ColumnTab extends StatelessWidget {
  const _ColumnTab({
    super.key,
    required this.column,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final SwarmBoardColumn column;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = selected ? AppPalette.textPrimary : AppPalette.textSecondary;
    return Semantics(
      button: true,
      selected: selected,
      child: GestureDetector(
        key: ValueKey('swarm-board-tab-${column.name}'),
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: selected ? AppGlass.rowFill : Colors.transparent,
                borderRadius: BorderRadius.circular(AppCard.radius),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpace.m,
                  vertical: AppSpace.s,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      column.label,
                      style: AppType.label(
                        color: ink,
                        fontWeight: selected ? AppFont.semibold : null,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '$count',
                      key: const ValueKey('swarm-board-count'),
                      style: AppType.caption(color: AppPalette.textFaint),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One column's page: its cards, or what it holds when none, and a line when
/// a read it depends on failed. Pulling down reads again.
class _ColumnPage extends StatelessWidget {
  const _ColumnPage({
    required this.column,
    required this.entries,
    required this.snapshot,
    required this.failure,
    required this.onRefresh,
    required this.onOpen,
  });

  final SwarmBoardColumn column;
  final List<SwarmBoardEntry> entries;
  final SuperTabSnapshot snapshot;
  final String? failure;
  final Future<void> Function() onRefresh;
  final ValueChanged<SwarmBoardEntry> onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final note = failure ?? (entries.isEmpty ? _empty[column] : null);
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.builder(
        key: ValueKey('swarm-board-list-${column.name}'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(
          AppSpace.l,
          AppSpace.s,
          AppSpace.l,
          AppSpace.xl,
        ),
        itemCount: entries.length + (note == null ? 0 : 1),
        itemBuilder: (context, i) {
          if (note != null && i == 0) {
            return Padding(
              padding: const EdgeInsets.only(bottom: AppSpace.m),
              child: Text(
                note,
                style: AppType.caption(color: AppPalette.textSecondary),
              ),
            );
          }
          final entry = entries[i - (note == null ? 0 : 1)];
          return Padding(
            padding: const EdgeInsets.only(bottom: AppSpace.s),
            child: _BoardCard(
              entry: entry,
              snapshot: snapshot,
              onTap: () => onOpen(entry),
            ),
          );
        },
      ),
    );
  }
}

/// A raised, rounded card with a thin lane strip: the title first and one
/// quiet line (priority, who, where it is), and a mark when it waits on the
/// reader.
class _BoardCard extends StatelessWidget {
  const _BoardCard({
    required this.entry,
    required this.snapshot,
    required this.onTap,
  });

  final SwarmBoardEntry entry;
  final SuperTabSnapshot snapshot;
  final VoidCallback onTap;

  /// Who the card is about: the agent at work on a task, else the person who
  /// asked for it; for a proposal, the person who made it.
  String? _who() {
    final name = swarmTaskPersonName(snapshot);
    if (entry.proposal case final proposal?) {
      final person = proposal.personId == null
          ? null
          : name(proposal.personId!);
      return person == null ? null : '$person proposed';
    }
    final task = entry.task!;
    final worker = task.assignment?['agentId'];
    if (worker is String && snapshot.agent(worker) != null) {
      return snapshot.agentName(worker);
    }
    return task.requesterId == null ? null : name(task.requesterId!);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final task = entry.task;
    final title = task?.label ?? entry.proposal!.title;
    final line = [
      task?.priority ?? entry.proposal?.priority ?? 'P2',
      _who(),
      entry.state,
    ].whereType<String>().where((part) => part.isNotEmpty).join(' · ');
    final id = task?.id ?? entry.proposal!.messageId;
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AppCard.radius),
        boxShadow: AppCard.shadow,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppCard.radius),
        child: Material(
          key: ValueKey('swarm-board-card-$id'),
          color: AppGlass.rowFill,
          child: InkWell(
            onTap: onTap,
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ColoredBox(
                    color: swarmAvatarColor(task?.handOutLane ?? id),
                    child: const SizedBox(width: 3),
                  ),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpace.m,
                        vertical: AppSpace.m,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title.isEmpty ? 'Proposal' : title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: AppType.label(
                              color: AppPalette.textPrimary,
                              height: 1.3,
                            ),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            line,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppType.caption(
                              color: AppPalette.textSecondary,
                              height: 1.35,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (entry.needsYou)
                    Padding(
                      key: const ValueKey('swarm-board-needs-you-mark'),
                      padding: const EdgeInsets.only(right: AppSpace.m),
                      child: Semantics(
                        label: 'Waiting on you',
                        child: Center(
                          child: DecoratedBox(
                            decoration: const BoxDecoration(
                              color: AppCard.accent,
                              shape: BoxShape.circle,
                            ),
                            child: const SizedBox(width: 8, height: 8),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
