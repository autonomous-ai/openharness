import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/local_key_value_store.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'attention.dart';
import 'backlog.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'model.dart';
import 'task_card.dart';
import 'task_groups.dart';

/// A project's Tasks view (Dee, task #2569): every ask from proposal to
/// shipped, as a Board (the default) or a List, with Mine and Search. It reads
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

  /// Where Board or List, and Mine, are kept for this reader on this Mac.
  final LocalKeyValueStore? storage;
  final DateTime Function() now;

  static String storageKey(String accountId) =>
      'super-tab-tasks-view/$accountId';

  @override
  State<SuperTabTasksView> createState() => _SuperTabTasksViewState();
}

class _SuperTabTasksViewState extends State<SuperTabTasksView> {
  bool _list = false, _mine = false;
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
        _list = saved['layout'] == 'list';
        _mine = saved['mine'] == true;
      });
    } on FormatException {
      // A copy this build cannot read: the defaults stand, and the next
      // choice replaces it.
    }
  }

  void _choose({bool? list, bool? mine}) {
    setState(() {
      _list = list ?? _list;
      _mine = mine ?? _mine;
    });
    unawaited(
      widget.storage?.write(
        _key,
        jsonEncode({'layout': _list ? 'list' : 'board', 'mine': _mine}),
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
          child: empty
              ? Center(
                  child: Text(
                    'No tasks yet',
                    style: DesktopChrome.control(color: DesktopChrome.muted),
                  ),
                )
              : _list
              ? _listView(shown, now)
              : _boardView(shown, now),
        ),
      ],
    );
  }

  /// The view's own bar: Board or List, Mine and Search, nothing else.
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
          selected: !_list,
          onPressed: () => _choose(list: false),
        ),
        const SizedBox(width: grid.AppDesktop.listRowGap),
        DesktopPill(
          key: const ValueKey('super-tasks-layout-list'),
          label: 'List',
          selected: _list,
          onPressed: () => _choose(list: true),
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
    return [
      ?_person(task.requesterId),
      if (agentId is String && snapshot != null)
        snapshot.agentName(agentId, fallback: 'Agent unavailable'),
      ?entry.state,
    ].join(' · ');
  }

  Widget _card(SuperTabTaskEntry entry, DateTime now, {required bool list}) {
    final task = entry.task;
    final id = task?.id ?? entry.proposal!.messageId;
    return SuperTabTaskCard(
      key: ValueKey('super-task-card-$id'),
      title: task?.title ?? entry.proposal!.title,
      caption: _caption(entry, now),
      needsYou: entry.needsYou,
      unread: task != null && widget.controller.unreadShown(task),
      titleLines: list ? 1 : 2,
      onOpen: () =>
          task == null ? widget.onOpenProposal(id) : widget.onOpenTask(task.id),
    );
  }

  Widget _boardView(
    Map<SuperTabTaskColumn, List<SuperTabTaskEntry>> shown,
    DateTime now,
  ) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: grid.AppDesktop.controlGap),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final column in SuperTabTaskColumn.values) ...[
          if (column != SuperTabTaskColumn.values.first)
            const SizedBox(width: _columnGap),
          Expanded(
            child: Column(
              key: ValueKey('super-tasks-column-${column.name}'),
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _heading(column, shown[column]!.length),
                Expanded(
                  child: column == SuperTabTaskColumn.nextUp
                      ? _nextUp(shown[column]!, now)
                      : LaidOutListView.builder(
                          itemCount: shown[column]!.length,
                          itemBuilder: (context, i) => Padding(
                            padding: const EdgeInsets.only(
                              bottom: grid.AppDesktop.listRowGap,
                            ),
                            child: _card(shown[column]![i], now, list: false),
                          ),
                        ),
                ),
              ],
            ),
          ),
        ],
      ],
    ),
  );

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

  /// Puts [ordered]'s card at [to] in place, right after the card now above
  /// it (none: the top), and tells the server, which keeps the order for
  /// everyone. Refused, the card goes back and the bar says why.
  Future<void> _move(List<SuperTabTaskEntry> ordered, int from, int to) async {
    if (from == to || to < 0 || to >= ordered.length) return;
    final ids = [for (final e in ordered) e.task!.id];
    final id = ids.removeAt(from);
    ids.insert(to, id);
    setState(() {
      _moving = ids;
      _moveError = null;
    });
    final refused = await widget.controller.queueTask(
      id,
      after: to == 0 ? null : ids[to - 1],
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
                bottom: grid.AppDesktop.listRowGap,
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
