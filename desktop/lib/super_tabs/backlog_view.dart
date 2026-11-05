import 'dart:async';

import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/pull_request_icon.dart';
import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import '../widgets/swarm_search_field.dart';
import 'backlog.dart';
import 'chip.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'model.dart';
import 'pull_request_facts.dart';
import 'task_status.dart';
import 'visible_tick.dart';

/// How many shipped tasks show before "Show N more shipped" (Scholes's
/// mockup, task #2774).
const superTabBacklogShippedShown = 7;

/// The widest the Backlog's column grows, as the mockup centres it.
const _maxWidth = 1120.0;

/// What each group means, in one line beside its heading (task #2774).
String _meaning(SuperTabBacklogGroup group) => switch (group) {
  SuperTabBacklogGroup.waitingForMachine => 'No agent on it yet',
  SuperTabBacklogGroup.working => 'An agent is on it right now',
  SuperTabBacklogGroup.waitingOnSomeone => 'Waiting on a person’s answer',
  SuperTabBacklogGroup.inReview => 'Pull request open, waiting on a human',
  SuperTabBacklogGroup.readyToMerge => 'Passed review, waiting for its merge',
  SuperTabBacklogGroup.shipped => 'Merged in the last 7 days',
};

/// Each group's mark: its color on the heading's dot and the row's icon.
Color _tone(SuperTabBacklogGroup group) => switch (group) {
  SuperTabBacklogGroup.waitingForMachine => grid.AppPalette.offline,
  SuperTabBacklogGroup.working => grid.AppPalette.warn,
  SuperTabBacklogGroup.waitingOnSomeone => grid.AppPalette.usageLow,
  SuperTabBacklogGroup.inReview => _merged,
  SuperTabBacklogGroup.readyToMerge => grid.AppPalette.teal,
  SuperTabBacklogGroup.shipped => grid.AppPalette.online,
};

IconData _icon(SuperTabBacklogGroup group) => switch (group) {
  SuperTabBacklogGroup.waitingForMachine => AppIcons.hourglass,
  SuperTabBacklogGroup.working => AppIcons.loaderCircle,
  SuperTabBacklogGroup.waitingOnSomeone => AppIcons.hand,
  SuperTabBacklogGroup.inReview => AppIcons.gitPullRequest,
  SuperTabBacklogGroup.readyToMerge => AppIcons.circleDot,
  SuperTabBacklogGroup.shipped => AppIcons.circleCheck,
};

Brightness get _brightness =>
    grid.AppTheme.isDark ? Brightness.dark : Brightness.light;

/// GitHub's merged purple, as the pull request cards draw it.
Color get _merged =>
    pullRequestIconColor('Merged', null, brightness: _brightness);

/// Manage ▸ Backlog (Scholes, tasks #2355 and #2774): every task of the Swarm
/// the reader can read, across projects, in the groups of its state. Summary
/// cards count Working, In review and Shipped; search, Mine or Everyone and a
/// project narrow all of it. It reads only what the controller already holds;
/// the checks of open tasks' pull requests come from [facts], watched only
/// while it shows.
class SuperTabBacklogView extends StatefulWidget {
  const SuperTabBacklogView({
    super.key,
    required this.controller,
    required this.onOpenConversation,
    this.facts,
    this.now = DateTime.now,
  });

  final SuperTabController controller;
  final ValueChanged<String> onOpenConversation;
  final SuperTabPullRequestFacts? facts;
  final DateTime Function() now;

  @override
  State<SuperTabBacklogView> createState() => _SuperTabBacklogViewState();
}

class _SuperTabBacklogViewState extends State<SuperTabBacklogView>
    with WidgetsBindingObserver, VisibleTick<SuperTabBacklogView> {
  String? _project;
  bool _mine = false;
  String _query = '';
  bool _allShipped = false;
  final _folded = <SuperTabBacklogGroup>{};

  /// The pull requests watched for their checks: open tasks' alone.
  Set<String> _watched = const {};

  @override
  void initState() {
    super.initState();
    _readClosed();
  }

  @override
  void didUpdateWidget(SuperTabBacklogView old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, widget.controller)) _readClosed();
  }

  @override
  void dispose() {
    if (_watching) widget.facts?.unwatch(_watched);
    super.dispose();
  }

  /// Whether the rows' pull requests are watched: only while on screen, as live cards do, so a
  /// hidden window asks GitHub nothing for them (task #2953).
  bool _watching = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _hold(onScreen);
  }

  @override
  void onScreenChanged(bool onScreen) => _hold(onScreen);

  void _hold(bool onScreen) {
    if (onScreen == _watching) return;
    _watching = onScreen;
    final facts = widget.facts;
    if (facts == null) return;
    if (onScreen) {
      facts.watch(_watched);
    } else {
      facts.unwatch(_watched);
    }
  }

  void _readClosed() => unawaited(
    widget.controller.readClosedShipped(
      widget.now().subtract(superTabBacklogShippedWindow),
    ),
  );

  /// Opens [task]'s chat, reading it first when the controller does not hold it.
  Future<void> _open(SuperTabConversation task) async {
    if (await widget.controller.loadGroup(task.id) && mounted) {
      widget.onOpenConversation(task.id);
    }
  }

  void _watch(Iterable<SuperTabConversation> open) {
    final facts = widget.facts;
    if (facts == null) return;
    final next = {for (final task in open) ?_pullRequest(task)};
    if (const SetEquality<String>().equals(next, _watched)) return;
    if (_watching) {
      facts
        ..watch(next.difference(_watched))
        ..unwatch(_watched.difference(next));
    }
    _watched = next;
  }

  void _setMine(bool mine) => setState(() => _mine = mine);

  /// Whether [task] answers the search: its title, its number, or the name
  /// of the agent on it.
  bool _matches(SuperTabConversation task, String query) {
    if (query.isEmpty) return true;
    final number = query.startsWith('#') ? query.substring(1) : query;
    if (task.number != null && '${task.number}' == number) return true;
    if (task.title.toLowerCase().contains(query)) return true;
    final agentId = task.assignment?['agentId'];
    if (agentId is! String) return false;
    final name = widget.controller.snapshot?.agentName(agentId, fallback: '');
    return name != null && name.toLowerCase().contains(query);
  }

  // Rebuilt when GitHub's answer lands, as the live cards are, and when a page
  // of closed tasks does: Manage rebuilds only on the controller (review of
  // #2776), which a page does not tell.
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      widget.controller.closedShippedChanged,
      ?widget.facts,
    ]),
    builder: (context, _) => _build(context),
  );

  Widget _build(BuildContext context) {
    grid.AppTheme.watch(context);
    final c = widget.controller;
    final now = widget.now();
    final placed = [
      for (final task in superTabBacklogTasks(c, closed: c.closedShipped))
        if (superTabBacklogGroupOf(task, now) case final group?) (task, group),
    ];
    // Watched after the frame: a build changes nothing outside itself.
    final open = [
      for (final (task, group) in placed)
        if (group != SuperTabBacklogGroup.shipped) task,
    ];
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _watch(open);
    });
    final query = _query.trim().toLowerCase();
    final matching = [
      for (final (task, group) in placed)
        if ((_project == null || task.projectId == _project) &&
            (!_mine || task.requesterId == c.accountId) &&
            _matches(task, query))
          (task, group),
    ];
    // Shipped lists with nothing open too, as the mockup does (#2885): the
    // list is what the cards count.
    final byGroup = <SuperTabBacklogGroup, List<SuperTabConversation>>{
      for (final group in SuperTabBacklogGroup.values)
        group: [
          for (final (task, g) in matching)
            if (g == group) task,
        ],
    };
    // Shipped reads newest first: by when it shipped, not its number.
    mergeSort(
      byGroup[SuperTabBacklogGroup.shipped]!,
      compare: (a, b) =>
          (b.shippedAt ?? DateTime(0)).compareTo(a.shippedAt ?? DateTime(0)),
    );
    // P0 first in every group (task #3117); a stable sort keeps the order
    // above within a priority.
    for (final tasks in byGroup.values) {
      mergeSort(
        tasks,
        compare: (a, b) =>
            superTabTaskPriority(a).index
                .compareTo(superTabTaskPriority(b).index),
      );
    }
    final entries = <Object>[];
    for (final MapEntry(key: group, value: tasks) in byGroup.entries) {
      if (tasks.isEmpty) continue;
      final folded = _folded.contains(group);
      entries.add(_Heading(group: group, count: tasks.length, folded: folded));
      if (folded) continue;
      final cut =
          group == SuperTabBacklogGroup.shipped &&
              !_allShipped &&
              tasks.length > superTabBacklogShippedShown
          ? superTabBacklogShippedShown
          : tasks.length;
      for (final (i, task) in tasks.take(cut).indexed) {
        entries.add(
          _Place(
            task: task,
            group: group,
            first: i == 0,
            last: i == cut - 1 && cut == tasks.length,
          ),
        );
      }
      if (cut < tasks.length) entries.add(_More(tasks.length - cut));
    }
    // The cards count what the filters match.
    int count(SuperTabBacklogGroup group) =>
        matching.where((e) => e.$2 == group).length;
    final projects = c.snapshot?.projects ?? const <SuperTabProject>[];
    final muted = DesktopChrome.metadata(color: DesktopChrome.muted);
    final synced = c.syncedAt;
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _maxWidth),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: grid.AppDesktop.groupGap,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (synced != null)
                Padding(
                  padding: const EdgeInsets.only(
                    top: grid.AppDesktop.controlGap,
                  ),
                  child: Text(
                    _syncedText(now.difference(synced)),
                    key: const ValueKey('super-backlog-synced'),
                    textAlign: TextAlign.end,
                    style: muted,
                  ),
                ),
              const SizedBox(height: grid.AppDesktop.controlGap),
              Row(
                children: [
                  for (final (i, group) in const [
                    SuperTabBacklogGroup.working,
                    SuperTabBacklogGroup.inReview,
                    SuperTabBacklogGroup.shipped,
                  ].indexed) ...[
                    if (i > 0)
                      const SizedBox(width: grid.AppDesktop.controlGap),
                    Expanded(
                      child: _Summary(group: group, count: count(group)),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: grid.AppDesktop.groupGap),
              Row(
                children: [
                  Expanded(
                    child: KeyedSubtree(
                      key: const ValueKey('super-backlog-search'),
                      child: SwarmSearchField(
                        hintText: 'Search by title, number or agent',
                        onChanged: (value) => setState(() => _query = value),
                      ),
                    ),
                  ),
                  const SizedBox(width: grid.AppDesktop.controlGap),
                  // Mine or Everyone, one choice in one frame (the mockup).
                  Container(
                    padding: const EdgeInsets.all(grid.AppDesktop.badgeInset),
                    decoration: BoxDecoration(
                      color: grid.AppSurface.wellFill,
                      border: Border.all(color: grid.AppPalette.divider),
                      borderRadius: BorderRadius.circular(
                        DesktopChrome.controlRadius,
                      ),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        DesktopPill(
                          key: const ValueKey('super-backlog-mine'),
                          label: 'Mine',
                          selected: _mine,
                          capsule: false,
                          quiet: !_mine,
                          tooltip: 'Only the tasks you asked for',
                          onPressed: () => _setMine(true),
                        ),
                        const SizedBox(width: grid.AppDesktop.listRowGap),
                        DesktopPill(
                          key: const ValueKey('super-backlog-everyone'),
                          label: 'Everyone',
                          selected: !_mine,
                          capsule: false,
                          quiet: _mine,
                          onPressed: () => _setMine(false),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: grid.AppDesktop.controlGap),
                  AppSelectField<String?>(
                    key: const ValueKey('super-backlog-project'),
                    semanticLabel: 'Project',
                    width: AppSelectField.fitWidth(
                      context,
                      labels: [
                        'All projects',
                        for (final p in projects) p.name,
                      ],
                    ),
                    value: _project,
                    options: [
                      const SelectOption(value: null, label: 'All projects'),
                      for (final project in projects)
                        SelectOption(value: project.id, label: project.name),
                    ],
                    onChanged: (value) => setState(() => _project = value),
                  ),
                ],
              ),
              if (c.closedShippedFailed)
                Padding(
                  padding: const EdgeInsets.only(
                    top: grid.AppDesktop.controlGap,
                  ),
                  child: Row(
                    children: [
                      Text(
                        'Some shipped tasks could not be read.',
                        style: muted,
                      ),
                      const SizedBox(width: grid.AppDesktop.controlGap),
                      DesktopPill(
                        key: const ValueKey('super-backlog-shipped-retry'),
                        label: 'Try again',
                        quiet: true,
                        compact: true,
                        onPressed: _readClosed,
                      ),
                    ],
                  ),
                ),
              Expanded(
                child: entries.isEmpty
                    // Nothing open and nothing shipped.
                    ? Center(
                        child: Text(
                          query.isNotEmpty
                              ? 'No tasks match “${_query.trim()}”'
                              : _mine
                              ? 'No open tasks of yours'
                              : 'No tasks',
                          style: DesktopChrome.control(
                            color: DesktopChrome.muted,
                          ),
                        ),
                      )
                    : LaidOutListView.builder(
                        padding: const EdgeInsets.only(
                          bottom: grid.AppDesktop.groupGap,
                        ),
                        itemCount: entries.length,
                        itemBuilder: (context, i) => switch (entries[i]) {
                          final _Heading heading => _HeadingRow(
                            heading: heading,
                            onToggle: () => setState(() {
                              if (!_folded.remove(heading.group)) {
                                _folded.add(heading.group);
                              }
                            }),
                          ),
                          final _Place place => _Row(
                            place: place,
                            controller: c,
                            facts: widget.facts,
                            now: now,
                            onOpen: () => _open(place.task),
                          ),
                          final _More more => _MoreRow(
                            count: more.count,
                            onPressed: () => setState(() => _allShipped = true),
                          ),
                          _ => const SizedBox.shrink(),
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _syncedText(Duration age) => age.inSeconds < 60
    ? 'Synced just now'
    : 'Synced ${superTabAgoShort(age)} ago';

/// The task's pull request the row shows: the newest one it names.
String? _pullRequest(SuperTabConversation task) =>
    task.cards.pullRequests.lastOrNull?.url ?? task.pullRequestUrls.lastOrNull;

/// A group's heading in the list.
class _Heading {
  const _Heading({
    required this.group,
    required this.count,
    required this.folded,
  });
  final SuperTabBacklogGroup group;
  final int count;
  final bool folded;
}

/// A task's place in its group's card: the first and last round its corners.
class _Place {
  const _Place({
    required this.task,
    required this.group,
    required this.first,
    required this.last,
  });
  final SuperTabConversation task;
  final SuperTabBacklogGroup group;
  final bool first, last;
}

/// Shipped's foot: how many more it holds.
class _More {
  const _More(this.count);
  final int count;
}

/// The small round mark of a group's color.
class _Dot extends StatelessWidget {
  const _Dot(this.color);
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: grid.AppDesktop.controlGap,
    height: grid.AppDesktop.controlGap,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

/// The label a summary card and a heading share: the group's name in capitals.
TextStyle _label({Color? color}) =>
    DesktopChrome.metadata(color: color ?? DesktopChrome.muted)
        .copyWith(fontWeight: FontWeight.w600, letterSpacing: .6);

BoxDecoration _card({bool top = true, bool bottom = true}) => BoxDecoration(
  color: grid.AppPalette.cardBg,
  border: Border.all(color: grid.AppPalette.divider),
  borderRadius: BorderRadius.vertical(
    top: top ? const Radius.circular(DesktopChrome.rowRadius) : Radius.zero,
    bottom: bottom
        ? const Radius.circular(DesktopChrome.rowRadius)
        : Radius.zero,
  ),
);

/// One of the counts at the top: Working, In review or Shipped.
class _Summary extends StatelessWidget {
  const _Summary({required this.group, required this.count});
  final SuperTabBacklogGroup group;
  final int count;

  @override
  Widget build(BuildContext context) => Container(
    key: ValueKey('super-backlog-summary-${group.name}'),
    decoration: _card(),
    padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            _Dot(_tone(group)),
            const SizedBox(width: grid.AppDesktop.controlGap),
            Text(group.label.toUpperCase(), style: _label()),
          ],
        ),
        const SizedBox(height: grid.AppDesktop.menuInset),
        Text(
          '$count',
          key: ValueKey('super-backlog-summary-${group.name}-count'),
          style: DesktopChrome.text(size: 28, medium: true, height: 1.1),
        ),
      ],
    ),
  );
}

/// A group's heading: its fold, mark, name and count, and what it means.
class _HeadingRow extends StatelessWidget {
  const _HeadingRow({required this.heading, required this.onToggle});
  final _Heading heading;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final group = heading.group;
    return Padding(
      padding: const EdgeInsets.only(
        top: grid.AppDesktop.groupGap + grid.AppDesktop.controlGap,
        bottom: grid.AppDesktop.controlGap,
      ),
      child: Semantics(
        button: true,
        expanded: !heading.folded,
        child: InkWell(
          key: ValueKey('super-backlog-group-${group.name}'),
          onTap: onToggle,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: Row(
            children: [
              Icon(
                heading.folded ? AppIcons.chevronRight : AppIcons.chevronDown,
                size: grid.AppDesktop.iconSize,
                color: DesktopChrome.muted,
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              _Dot(_tone(group)),
              const SizedBox(width: grid.AppDesktop.controlGap),
              Text(
                group.label.toUpperCase(),
                style: _label(color: DesktopChrome.foreground),
              ),
              const SizedBox(width: grid.AppDesktop.controlGap),
              SuperTabChip(text: '${heading.count}'),
              const SizedBox(width: grid.AppDesktop.controlGap),
              Expanded(
                child: Text(
                  _meaning(group),
                  textAlign: TextAlign.end,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.metadata(color: DesktopChrome.muted),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One task as a card row (Scholes's mockup): its group's mark; its number,
/// priority and title; then agent, machine, state and project; at the right
/// how long since it changed, its pull request with its checks or merge, and
/// an approval.
class _Row extends StatelessWidget {
  const _Row({
    required this.place,
    required this.controller,
    required this.facts,
    required this.now,
    required this.onOpen,
  });

  final _Place place;
  final SuperTabController controller;
  final SuperTabPullRequestFacts? facts;
  final DateTime now;
  final VoidCallback onOpen;

  SuperTabConversation get task => place.task;

  String? _personName(String id) => controller.snapshot?.people
      .where((p) => p.id == id)
      .firstOrNull
      ?.shownName;

  /// The pull request chip: its number, then merged, its checks, or its
  /// state; colored as GitHub colors it.
  Widget? _pullRequestChip() {
    final url = _pullRequest(task);
    if (url == null) return null;
    final number = Uri.parse(url).pathSegments.elementAtOrNull(3) ?? '';
    final merged =
        task.cards.pullRequests.firstWhereOrNull((p) => p.url == url)?.merged ==
        true;
    final entry = facts?.of(url);
    final (state, words) = merged
        ? ('Merged', 'merged')
        : entry == null
        ? ('', '')
        : entry.finalState
        ? (entry.state, entry.state.toLowerCase())
        : (entry.state, entry.total > 0 ? entry.checksLabel : '');
    final color = switch (state) {
      'Merged' => _merged,
      _ when entry != null && entry.failed > 0 => grid.AppPalette.usageCritical,
      _ when entry != null && entry.total > 0 && entry.pending == 0 =>
        grid.AppPalette.online,
      _ => DesktopChrome.muted,
    };
    return KeyedSubtree(
      key: ValueKey('super-backlog-pr-${task.id}'),
      child: superTabTintedChip(
        ['PR $number', if (words.isNotEmpty) words].join(' · '),
        color,
        leading: SvgPicture.asset(
          pullRequestIconAsset(state.isEmpty ? 'Open' : state),
          width: grid.AppControl.iconSizeChip,
          height: grid.AppControl.iconSizeChip,
          colorFilter: ColorFilter.mode(color, BlendMode.srcIn),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot!;
    final assignment = task.assignment;
    final agentId = assignment?['agentId'];
    final execution = assignment?['execution'];
    final agent = agentId is String ? snapshot.agent(agentId) : null;
    final machineId = execution is Map && execution['machineId'] is String
        ? execution['machineId'] as String
        : agent?.machineId;
    final status = superTabTaskStatus(task, now, personName: _personName);
    final details = [
      if (agentId is! String)
        'No agent yet'
      else ...[
        snapshot.agentName(agentId, fallback: 'Agent unavailable'),
        if (machineId != null) ?controller.sessionMachineName(machineId),
      ],
      if (status != null) status.reason,
    ].join(' · ');
    final project = snapshot.projectById(task.projectId)?.name;
    final title = superTabTitlePriority(task.title).title;
    final url = _pullRequest(task);
    final approved = url != null && facts?.of(url)?.review == 'APPROVED';
    final pullRequest = _pullRequestChip();
    // Shipped reads how long since it shipped, as the mockup does; the rest
    // since it last changed. One read for the list alone is not held: when
    // it shipped stands in.
    final changed = place.group == SuperTabBacklogGroup.shipped
        ? task.shippedAt ?? controller.groupChangedAt(task.id)
        : controller.groupChangedAt(task.id) ?? task.shippedAt;
    final muted = DesktopChrome.metadata(color: DesktopChrome.muted);
    final group = place.group;
    final radius = BorderRadius.vertical(
      top: place.first
          ? const Radius.circular(DesktopChrome.rowRadius)
          : Radius.zero,
      bottom: place.last
          ? const Radius.circular(DesktopChrome.rowRadius)
          : Radius.zero,
    );
    return Container(
      decoration: BoxDecoration(
        color: grid.AppPalette.cardBg,
        borderRadius: radius,
        border: Border(
          left: BorderSide(color: grid.AppPalette.divider),
          right: BorderSide(color: grid.AppPalette.divider),
          top: BorderSide(color: grid.AppPalette.divider),
          bottom: place.last
              ? BorderSide(color: grid.AppPalette.divider)
              : BorderSide.none,
        ),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: ValueKey('super-backlog-row-${task.id}'),
          onTap: onOpen,
          hoverColor: grid.AppSurface.hoverFill,
          borderRadius: radius,
          child: Padding(
            padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  _icon(group),
                  size: grid.AppDesktop.iconSize + grid.AppDesktop.listRowGap,
                  color: _tone(group),
                ),
                const SizedBox(width: grid.AppDesktop.groupGap),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: grid.AppDesktop.controlGap,
                        runSpacing: grid.AppDesktop.listRowGap,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          if (task.number case final number?)
                            Text('#$number', style: muted),
                          SuperTabPriorityBadge(superTabTaskPriority(task)),
                          Text(
                            title,
                            style: DesktopChrome.control(medium: true),
                          ),
                        ],
                      ),
                      const SizedBox(height: grid.AppDesktop.menuInset),
                      Wrap(
                        spacing: grid.AppDesktop.controlGap,
                        runSpacing: grid.AppDesktop.listRowGap,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(details, style: muted),
                          if (project != null)
                            SuperTabChip(text: project, outlined: true),
                          if (approved)
                            superTabTintedChip(
                              'Approved',
                              grid.AppPalette.online,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: grid.AppDesktop.groupGap),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    if (changed != null)
                      Text(
                        superTabAgoShort(now.difference(changed)),
                        style: muted,
                      ),
                    if (pullRequest != null) ...[
                      const SizedBox(height: grid.AppDesktop.menuInset),
                      pullRequest,
                    ],
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Shipped's foot: "Show N more shipped", closing its card.
class _MoreRow extends StatelessWidget {
  const _MoreRow({required this.count, required this.onPressed});
  final int count;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Container(
    decoration: _card(top: false),
    padding: const EdgeInsets.all(grid.AppDesktop.controlGap),
    alignment: Alignment.center,
    child: TextButton(
      key: const ValueKey('super-backlog-shipped-more'),
      onPressed: onPressed,
      child: Text(
        'Show $count more shipped',
        style: DesktopChrome.control(color: DesktopChrome.accent),
      ),
    ),
  );
}
