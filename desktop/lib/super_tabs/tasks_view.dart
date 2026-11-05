import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/local_key_value_store.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/harness_activity.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'attention.dart';
import 'backlog.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'member_groups.dart';
import 'model.dart';
import 'task_card.dart';
import 'task_groups.dart';

/// A project's Tasks view (Dee, task #2569): every ask from proposal to
/// shipped, as a Board (the default), a List or by crew member (Members,
/// task #3400), with Mine and Search. It reads
/// only what the controller holds, and the shipped tasks it reads for the
/// window, so cards move as the work does.
class SuperTabTasksView extends StatefulWidget {
  const SuperTabTasksView({
    super.key,
    required this.controller,
    required this.project,
    required this.needsHuman,
    required this.onOpenTask,
    required this.onOpenProposal,
    this.selectedId,
    this.storage,
    this.now = DateTime.now,
  });

  final SuperTabController controller;
  final SuperTabProject project;

  /// Which tasks' agents asked the reader in their terminal (the sidebar's).
  final int Function(SuperTabConversation task) needsHuman;
  final ValueChanged<String> onOpenTask;

  /// Opens a proposal's thread in the project chat, by its message id.
  final ValueChanged<String> onOpenProposal;

  /// The task (or proposal, by its message id) the reader has open: its card
  /// shows selected (task #2948).
  final String? selectedId;

  /// Where Board, List or Members, and Mine, are kept for this reader on this Mac.
  final LocalKeyValueStore? storage;
  final DateTime Function() now;

  /// A Board column's width: about a card and a half of title per line, so
  /// five fit a wide window and a narrow one scrolls sideways (task #2948).
  static const columnWidth = 280.0;

  static String storageKey(String accountId) =>
      'super-tab-tasks-view/$accountId';

  @override
  State<SuperTabTasksView> createState() => _SuperTabTasksViewState();
}

/// How the Tasks view lays its cards out, kept by its name.
enum _Layout { board, list, members }

class _SuperTabTasksViewState extends State<SuperTabTasksView> {
  var _layout = _Layout.board;
  bool _mine = false;
  String _query = '';

  /// List's sections folded: Shipped starts so; not kept.
  final _folded = {SuperTabTaskColumn.shipped};

  /// Next up as the reader just ordered it, by task id, until the server
  /// answers; and why the last move was refused.
  List<String>? _moving;
  String? _moveError;

  /// Whether the last drag ended over Next up: a card dropped anywhere else
  /// goes back.
  bool _droppedOnNextUp = false;
  final _nextUpKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    unawaited(_restore());
    _readShipped();
  }

  @override
  void didUpdateWidget(SuperTabTasksView old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, widget.controller)) _readShipped();
  }

  void _readShipped() => unawaited(
    widget.controller.readClosedShipped(
      widget.now().subtract(superTabBacklogShippedWindow),
    ),
  );

  String get _key => SuperTabTasksView.storageKey(widget.controller.accountId);

  Future<void> _restore() async {
    final raw = await widget.storage?.read(_key);
    if (raw == null || !mounted) return;
    try {
      final saved = jsonDecode(raw);
      if (saved is! Map) return;
      setState(() {
        _layout =
            _Layout.values
                .where((l) => l.name == saved['layout'])
                .firstOrNull ??
            _Layout.board;
        _mine = saved['mine'] == true;
      });
    } on FormatException {
      // A copy this build cannot read: the defaults stand, and the next
      // choice replaces it.
    }
  }

  void _choose({_Layout? layout, bool? mine}) {
    setState(() {
      _layout = layout ?? _layout;
      _mine = mine ?? _mine;
    });
    unawaited(
      widget.storage?.write(
        _key,
        jsonEncode({'layout': _layout.name, 'mine': _mine}),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListenableBuilder(
      listenable: Listenable.merge([
        c,
        c.closedShippedChanged,
        SuperTabAttention.of(c),
      ]),
      builder: (context, _) => _build(context),
    );
  }

  String? _person(String? id) => id == null
      ? null
      : widget.controller.snapshot?.people
            .where((p) => p.id == id)
            .firstOrNull
            ?.shownName;

  bool _keeps(SuperTabTaskEntry entry) {
    final reader = widget.controller.accountId;
    final asker = entry.task?.requesterId ?? entry.proposal?.personId;
    final title = entry.task?.title ?? entry.proposal!.title;
    return (!_mine || asker == reader) &&
        (_query.isEmpty || title.toLowerCase().contains(_query.toLowerCase()));
  }

  Widget _build(BuildContext context) {
    grid.AppTheme.watch(context);
    final c = widget.controller;
    final project =
        c.snapshot?.projects
            .where((p) => p.id == widget.project.id)
            .firstOrNull ??
        widget.project;
    final now = widget.now();
    // After the frame: a build changes nothing outside itself.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(c.readProposals(project.id));
    });
    final board = superTabProjectBoard(
      c,
      project,
      now: now,
      needsHuman: widget.needsHuman,
    );
    final shown = {
      for (final MapEntry(:key, :value) in board.entries)
        key: value.where(_keeps).toList(),
    };
    final empty = board.values.every((entries) => entries.isEmpty);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _bar(context),
        Expanded(
          // Members draws the crew, free or not, though no task is open.
          child: _layout == _Layout.members
              ? _membersView(project, shown, now)
              : empty
              ? Center(
                  child: Text(
                    'No tasks yet',
                    style: DesktopChrome.control(color: DesktopChrome.muted),
                  ),
                )
              : _layout == _Layout.list
              ? _listView(shown, now)
              : _boardView(shown, now),
        ),
      ],
    );
  }

  /// The view's own bar: Board, List or Members, Mine and Search, nothing
  /// else.
  Widget _bar(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      grid.AppDesktop.groupGap,
      grid.AppDesktop.controlGap,
      grid.AppDesktop.groupGap,
      grid.AppDesktop.controlGap,
    ),
    child: Row(
      children: [
        Text('Tasks', style: DesktopChrome.text(medium: true)),
        if (_moveError case final error?) ...[
          const SizedBox(width: grid.AppDesktop.groupGap),
          Flexible(
            child: Text(
              error,
              key: const ValueKey('super-tasks-move-error'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(),
            ),
          ),
        ],
        const Spacer(),
        DesktopPill(
          key: const ValueKey('super-tasks-layout-board'),
          label: 'Board',
          selected: _layout == _Layout.board,
          onPressed: () => _choose(layout: _Layout.board),
        ),
        const SizedBox(width: grid.AppDesktop.listRowGap),
        DesktopPill(
          key: const ValueKey('super-tasks-layout-list'),
          label: 'List',
          selected: _layout == _Layout.list,
          onPressed: () => _choose(layout: _Layout.list),
        ),
        const SizedBox(width: grid.AppDesktop.listRowGap),
        DesktopPill(
          key: const ValueKey('super-tasks-layout-members'),
          label: 'Members',
          selected: _layout == _Layout.members,
          tooltip: 'Tasks by crew member',
          onPressed: () => _choose(layout: _Layout.members),
        ),
        const SizedBox(width: grid.AppDesktop.groupGap),
        DesktopPill(
          key: const ValueKey('super-tasks-mine'),
          label: 'Mine',
          selected: _mine,
          tooltip: 'Only the tasks you asked for',
          onPressed: () => _choose(mine: !_mine),
        ),
        const SizedBox(width: grid.AppDesktop.controlGap),
        SizedBox(
          width: _searchWidth,
          child: TextField(
            key: const ValueKey('super-tasks-search'),
            onChanged: (query) => setState(() => _query = query.trim()),
            textInputAction: TextInputAction.search,
            style: grid.kFieldTextStyle,
            decoration: InputDecoration(
              hintText: 'Search',
              isDense: true,
              prefixIcon: Icon(
                AppIcons.search,
                size: grid.kFieldIconSize,
                color: grid.AppPalette.textFaint,
              ),
            ),
          ),
        ),
      ],
    ),
  );

  static const _searchWidth = 220.0;
  static const _columnGap = grid.AppDesktop.groupGap;

  Widget _heading(SuperTabTaskColumn column, int count, {bool? folded}) {
    final style = DesktopChrome.control(medium: true);
    final row = Row(
      children: [
        if (folded != null)
          Icon(
            folded ? AppIcons.chevronRight : AppIcons.chevronDown,
            size: AppIcons.inlineSize,
            color: DesktopChrome.muted,
          ),
        if (folded != null) const SizedBox(width: grid.AppDesktop.menuInset),
        Text(column.label, style: style),
        const SizedBox(width: grid.AppDesktop.controlGap),
        Text('$count', style: DesktopChrome.metadata()),
      ],
    );
    final key = ValueKey('super-tasks-heading-${column.name}');
    final padded = Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.controlGap,
        vertical: grid.AppDesktop.menuInset,
      ),
      child: row,
    );
    if (folded == null) return KeyedSubtree(key: key, child: padded);
    return Semantics(
      button: true,
      expanded: !folded,
      child: InkWell(
        key: key,
        onTap: () => setState(() {
          if (!_folded.remove(column)) _folded.add(column);
        }),
        hoverColor: grid.AppSurface.hoverFill,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        child: padded,
      ),
    );
  }

  /// The caption under a card's title: who asked, the agent on it and its
  /// state, joined by middle dots; a proposal's says who asked and how long
  /// ago. No task numbers, machines or models.
  String _caption(SuperTabTaskEntry entry, DateTime now) {
    final snapshot = widget.controller.snapshot;
    if (entry.proposal case final proposal?) {
      return [
        ?_person(proposal.personId),
        superTabAgoShort(now.difference(proposal.at)),
      ].join(' · ');
    }
    final task = entry.task!;
    final agentId = task.assignment?['agentId'];
    final agent = agentId is String && snapshot != null
        ? snapshot.agentName(agentId, fallback: '')
        : '';
    final waitingOnReader =
        entry.needsYou &&
        !superTabTaskShipped(task) &&
        (task.assignment?['status'] == 'needs_human' ||
            task.liveness?['why'] == 'person');
    return [
      ?_person(task.requesterId),
      if (agentId is String && snapshot != null)
        if (agent.isNotEmpty)
          agent
        else if (!superTabTaskShipped(task))
          'Agent unavailable',
      if (entry.needsYou) 'Needs you',
      if (!waitingOnReader) ?entry.state,
    ].join(' · ');
  }

  HarnessActivity _activity(SuperTabTaskEntry entry) {
    if (entry.needsYou) return HarnessActivity.needsInput;
    final task = entry.task;
    if (task == null) return HarnessActivity.starting;
    if (superTabTaskShipped(task)) return HarnessActivity.done;
    final status = task.assignment?['status'];
    final state = task.liveness?['state'];
    final why = task.liveness?['why'];
    if (status == 'failed') return HarnessActivity.failed;
    if (status == 'blocked' ||
        status == 'lost' ||
        state == 'orphaned' ||
        state == 'quiet' ||
        state == 'waiting' && why == 'blocked') {
      return HarnessActivity.offline;
    }
    if (status == 'needs_human' ||
        status == 'review' ||
        status == 'done' ||
        state == 'waiting' &&
            (why == 'person' || why == 'review' || why == 'revision')) {
      return HarnessActivity.needsInput;
    }
    if (task.assignment?['agentId'] is! String ||
        state == 'waiting' && why == 'queued') {
      return HarnessActivity.starting;
    }
    return HarnessActivity.working;
  }

  /// [entry]'s card; [lane] leads its caption (Members' Unassigned).
  Widget _card(
    SuperTabTaskEntry entry,
    DateTime now, {
    required bool list,
    String? lane,
  }) {
    final task = entry.task;
    final id = task?.id ?? entry.proposal!.messageId;
    final caption = _caption(entry, now);
    return SuperTabTaskCard(
      key: ValueKey('super-task-card-$id'),
      // A legacy marker is the badge now: the title drops it.
      title: task == null
          ? entry.proposal!.title
          : superTabTitlePriority(task.title).title,
      caption: [?lane, if (caption.isNotEmpty) caption].join(' · '),
      priority: superTabEntryPriority(entry),
      needsYou: entry.needsYou,
      unread: task != null && widget.controller.unreadShown(task),
      activity: _activity(entry),
      titleLines: list ? 1 : 3,
      tile: !list,
      selected: id == widget.selectedId,
      onOpen: () =>
          task == null ? widget.onOpenProposal(id) : widget.onOpenTask(task.id),
    );
  }

  /// The Board: each column a neutral panel of a fixed width (Huy, task
  /// #2948), side by side in one row that scrolls sideways when the window is
  /// narrower than all five; each column scrolls its own cards.
  Widget _boardView(
    Map<SuperTabTaskColumn, List<SuperTabTaskEntry>> shown,
    DateTime now,
  ) => SingleChildScrollView(
    key: const ValueKey('super-tasks-board'),
    scrollDirection: Axis.horizontal,
    padding: const EdgeInsets.only(
      left: grid.AppDesktop.groupGap,
      right: grid.AppDesktop.groupGap,
      bottom: grid.AppDesktop.groupGap,
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final column in SuperTabTaskColumn.values) ...[
          if (column != SuperTabTaskColumn.values.first)
            const SizedBox(width: _columnGap),
          SizedBox(
            width: SuperTabTasksView.columnWidth,
            child: _panel(column, shown[column]!, now),
          ),
        ],
      ],
    ),
  );

  /// One column of the Board or of Members: card material with its hairline
  /// rim at the card radius, and no shadow, which is for floating content
  /// only; [heading] over [body], which fills the rest.
  Widget _framed(Key key, Widget heading, Widget body) => DecoratedBox(
    key: key,
    decoration: BoxDecoration(
      color: grid.AppCard.base,
      borderRadius: BorderRadius.circular(grid.AppCard.radius),
      border: Border.all(color: grid.AppCard.hair),
    ),
    child: Padding(
      padding: const EdgeInsets.all(grid.AppDesktop.controlGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          heading,
          const SizedBox(height: grid.AppDesktop.listRowGap),
          Expanded(child: body),
        ],
      ),
    ),
  );

  /// Said, not left blank: a column with nothing in it reads as one still
  /// loading (task #2948).
  static Widget _noTasks() => Padding(
    padding: const EdgeInsets.symmetric(vertical: grid.AppDesktop.groupGap),
    child: Text(
      'No tasks',
      textAlign: TextAlign.center,
      style: DesktopChrome.metadata(),
    ),
  );

  /// One column of the Board.
  Widget _panel(
    SuperTabTaskColumn column,
    List<SuperTabTaskEntry> entries,
    DateTime now,
  ) => _framed(
    ValueKey('super-tasks-column-${column.name}'),
    _heading(column, entries.length),
    entries.isEmpty
        ? _noTasks()
        : column == SuperTabTaskColumn.nextUp
        ? _nextUp(entries, now)
        : LaidOutListView.builder(
            itemCount: entries.length,
            itemBuilder: (context, i) => Padding(
              padding: const EdgeInsets.only(
                bottom: grid.AppDesktop.controlGap,
              ),
              child: _card(entries[i], now, list: false),
            ),
          ),
  );

  /// Members (task #3400): one muted line of the lanes' capacity, then a
  /// column per crew member, its name and lane over Working or Free, with
  /// the tasks in its hands and then those it handed over; and last,
  /// Unassigned, in the order the server hands work out, each card led by
  /// its lane. Columns as the Board's: side by side, scrolling sideways.
  Widget _membersView(
    SuperTabProject project,
    Map<SuperTabTaskColumn, List<SuperTabTaskEntry>> shown,
    DateTime now,
  ) {
    final snapshot = widget.controller.snapshot;
    final lanes = snapshot?.lanes[project.id] ?? const [];
    final groups = superTabMemberGroups(
      agents: snapshot?.agents ?? const [],
      projectId: project.id,
      entries: shown.values.expand((entries) => entries),
      lanes: lanes,
    );
    final capacity = superTabCapacityLine(lanes, now);
    Widget column(Key key, Widget heading, List<Widget> rows) => SizedBox(
      width: SuperTabTasksView.columnWidth,
      child: _framed(
        key,
        heading,
        LaidOutListView.builder(
          itemCount: rows.length,
          itemBuilder: (context, i) => rows[i],
        ),
      ),
    );
    Widget card(SuperTabTaskEntry entry, {String? lane}) => Padding(
      padding: const EdgeInsets.only(bottom: grid.AppDesktop.controlGap),
      child: _card(entry, now, list: false, lane: lane),
    );
    const inset = EdgeInsets.symmetric(
      horizontal: grid.AppDesktop.controlGap,
      vertical: grid.AppDesktop.menuInset,
    );
    final unassigned = groups.unassigned;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (capacity != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              grid.AppDesktop.groupGap,
              0,
              grid.AppDesktop.groupGap,
              grid.AppDesktop.controlGap,
            ),
            child: Text(
              capacity,
              key: const ValueKey('super-tasks-capacity'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(),
            ),
          ),
        Expanded(
          child: SingleChildScrollView(
            key: const ValueKey('super-tasks-members'),
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.only(
              left: grid.AppDesktop.groupGap,
              right: grid.AppDesktop.groupGap,
              bottom: grid.AppDesktop.groupGap,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final member in groups.members) ...[
                  column(
                    ValueKey('super-tasks-member-${member.agent.id}'),
                    Padding(
                      padding: inset,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            superTabMemberHeading(member.agent),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.control(medium: true),
                          ),
                          Text(
                            member.working ? 'Working' : 'Free',
                            style: DesktopChrome.metadata(),
                          ),
                        ],
                      ),
                    ),
                    [
                      for (final entry in member.inHand) card(entry),
                      if (member.handed.isNotEmpty)
                        Padding(
                          padding: inset,
                          child: Text(
                            'handed:',
                            style: DesktopChrome.metadata(),
                          ),
                        ),
                      for (final entry in member.handed) card(entry),
                    ],
                  ),
                  const SizedBox(width: _columnGap),
                ],
                column(
                  const ValueKey('super-tasks-unassigned'),
                  Padding(
                    padding: inset,
                    child: Row(
                      children: [
                        Text(
                          'Unassigned',
                          style: DesktopChrome.control(medium: true),
                        ),
                        const SizedBox(width: grid.AppDesktop.controlGap),
                        Text(
                          '${unassigned.length}',
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                    ),
                  ),
                  [
                    if (unassigned.isEmpty) _noTasks(),
                    for (final (:entry, :lane) in unassigned)
                      card(entry, lane: lane),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _listView(
    Map<SuperTabTaskColumn, List<SuperTabTaskEntry>> shown,
    DateTime now,
  ) {
    final rows = <Widget>[
      for (final column in SuperTabTaskColumn.values) ...[
        _heading(
          column,
          shown[column]!.length,
          folded: _folded.contains(column),
        ),
        if (!_folded.contains(column))
          for (final entry in shown[column]!) _card(entry, now, list: true),
      ],
    ];
    return LaidOutListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: grid.AppDesktop.groupGap),
      itemCount: rows.length,
      itemBuilder: (context, i) => rows[i],
    );
  }

  /// Next up in the order the reader just set, while the server has not
  /// answered yet.
  List<SuperTabTaskEntry> _inOrder(List<SuperTabTaskEntry> entries) {
    final moving = _moving;
    if (moving == null) return entries;
    final at = {for (final (i, id) in moving.indexed) id: i};
    return [...entries]..sort(
      (a, b) => (at[a.task!.id] ?? moving.length).compareTo(
        at[b.task!.id] ?? moving.length,
      ),
    );
  }

  /// Puts [ordered]'s card at [to] in place and tells the server, which keeps
  /// the order for everyone. Refused, the card goes back and the bar says why.
  /// A card moves only among those of its own priority (task #3117): one
  /// dropped past them stops at the edge of its band.
  Future<void> _move(List<SuperTabTaskEntry> ordered, int from, int to) async {
    if (to < 0 || to >= ordered.length) return;
    final priority = superTabEntryPriority(ordered[from]);
    final band = [
      for (final (i, e) in ordered.indexed)
        if (superTabEntryPriority(e) == priority) i,
    ];
    to = to.clamp(band.first, band.last);
    if (from == to) return;
    final ids = [for (final e in ordered) e.task!.id];
    final id = ids.removeAt(from);
    ids.insert(to, id);
    setState(() {
      _moving = ids;
      _moveError = null;
    });
    // The column lifts what needs the reader, and sorts by priority, so its
    // neighbours on screen are not its neighbours in the shared order: it
    // goes right before the first card of its priority under it that is not
    // lifted (reviews of #2883), or else right after the last of its priority
    // in the queue.
    final tasks = {for (final e in ordered) e.task!.id: e.task!};
    final queue = [
      for (final task in superTabQueueOrder(tasks.values))
        if (task.id != id) task.id,
    ];
    bool peer(String other) => superTabTaskPriority(tasks[other]!) == priority;
    final lifted = {
      for (final e in ordered)
        if (e.needsYou) e.task!.id,
    };
    final below = ids
        .skip(to + 1)
        .where((other) => peer(other) && !lifted.contains(other))
        .firstOrNull;
    final at = below != null
        ? queue.indexOf(below)
        : switch (queue.lastIndexWhere(peer)) {
            -1 => queue.length,
            final last => last + 1,
          };
    final refused = await widget.controller.queueTask(
      id,
      after: at == 0 ? null : queue[at - 1],
    );
    if (!mounted) return;
    setState(() {
      _moving = null;
      _moveError = refused;
    });
  }

  /// Next up, the one column a card is dragged in (or moved with ⌥↑ and ⌥↓):
  /// its order is the project's shared queue.
  Widget _nextUp(List<SuperTabTaskEntry> entries, DateTime now) {
    final ordered = _inOrder(entries);
    return Listener(
      key: _nextUpKey,
      onPointerUp: (event) {
        final box = _nextUpKey.currentContext?.findRenderObject() as RenderBox?;
        _droppedOnNextUp =
            box != null &&
            (Offset.zero & box.size).contains(event.localPosition);
      },
      child: ReorderableListView.builder(
        buildDefaultDragHandles: false,
        itemCount: ordered.length,
        onReorderItem: (from, to) {
          if (_droppedOnNextUp) unawaited(_move(ordered, from, to));
        },
        itemBuilder: (context, i) {
          final id = ordered[i].task!.id;
          return ReorderableDragStartListener(
            key: ValueKey('super-task-drag-$id'),
            index: i,
            child: Padding(
              padding: const EdgeInsets.only(
                bottom: grid.AppDesktop.controlGap,
              ),
              child: CallbackShortcuts(
                bindings: {
                  const SingleActivator(
                    LogicalKeyboardKey.arrowUp,
                    alt: true,
                  ): () =>
                      unawaited(_move(ordered, i, i - 1)),
                  const SingleActivator(
                    LogicalKeyboardKey.arrowDown,
                    alt: true,
                  ): () =>
                      unawaited(_move(ordered, i, i + 1)),
                },
                child: _card(ordered[i], now, list: false),
              ),
            ),
          );
        },
      ),
    );
  }
}
