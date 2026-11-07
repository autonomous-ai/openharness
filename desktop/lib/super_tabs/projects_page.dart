import 'dart:math' as math;

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../core/open_in_browser.dart';
import '../core/relative_time.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import '../widgets/swarm_search_field.dart';
import 'chip.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';
import 'project_activity.dart';
import 'project_github.dart';

/// How the Projects list is ordered (task #4662): newest activity first, by name, or by open work.
enum SuperTabProjectSort {
  recent('Recent'),
  name('Name'),
  work('Most work');

  const SuperTabProjectSort(this.label);
  final String label;
}

/// The Desktop's Projects in the middle, as GitHub lists an org's repositories (task #4662, anh Dee 11-07 21:15): the
/// title and its count with New project, Find a project and Sort, then one bordered list with a row per project. A row
/// opens its project's Board. At most 900 wide.
class SuperTabProjectsPage extends StatefulWidget {
  const SuperTabProjectsPage({
    super.key,
    required this.controller,
    required this.onOpen,
    this.onNewProject,
    this.onOpenRepository,
  });

  final SuperTabController controller;
  final ValueChanged<SuperTabProject> onOpen;

  /// Opens the New project form; without it the page offers none.
  final VoidCallback? onNewProject;

  /// Opens a repository's GitHub page; the browser when null.
  final ValueChanged<String>? onOpenRepository;

  static const maxWidth = 900.0;

  @override
  State<SuperTabProjectsPage> createState() => _SuperTabProjectsPageState();
}

class _SuperTabProjectsPageState extends State<SuperTabProjectsPage> {
  late final _activity = SuperTabProjectActivityReader(
    tabId: widget.controller.tabId,
    request: widget.controller.request,
  );
  var _query = '';
  var _sort = SuperTabProjectSort.recent;

  /// The project ids the activity was last read for: a new or removed project reads it again at once.
  String? _readIds;

  /// Each project's latest message when the activity was last read: a move reads it again, at most every
  /// [_activityEvery], so Updated, Recent and the sparkline follow the work while the page is open.
  String? _readMoves;
  DateTime? _readAt;
  static const _activityEvery = Duration(seconds: 30);

  @override
  void dispose() {
    _activity.dispose();
    super.dispose();
  }

  /// Reads the activity again when a project comes or goes, or when one's latest message moves and the last read is
  /// [_activityEvery] old. Driven by the Swarm's own pushes, so nothing polls; a move inside the wait is read on the
  /// next push after it.
  void _readActivity(List<SuperTabProject> projects) {
    if (projects.isEmpty) return;
    final ids = (projects.map((p) => p.id).toList()..sort()).join(',');
    final moves = [
      for (final project in projects)
        widget.controller
            .projectConversations(project.id)
            .fold(0, (at, g) => math.max(at, g.lastMessageSequence)),
    ].join(',');
    final now = clock.now();
    final due =
        ids != _readIds ||
        (moves != _readMoves &&
            (_readAt == null || now.difference(_readAt!) >= _activityEvery));
    if (!due) return;
    _readIds = ids;
    _readMoves = moves;
    _readAt = now;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _activity.refresh();
    });
  }

  void _openRepository(String url) {
    if (widget.onOpenRepository case final open?) return open(url);
    openInBrowser(Uri.parse(url));
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.controller, _activity]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final snapshot = widget.controller.snapshot;
      final recent = superTabProjectsByRecent(widget.controller);
      _readActivity(recent);
      final rows = superTabProjectsListed(
        recent,
        sort: _sort,
        query: _query,
        activity: _activity.byProject,
        work: (project) => _work(snapshot, project).total,
      );
      Widget column(Widget child) => Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            maxWidth: SuperTabProjectsPage.maxWidth,
          ),
          child: child,
        ),
      );
      return LaidOutListView(
        padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
        children: [
          column(_header(recent.length)),
          // Empty means empty (rule 7): the title and New project, which fills it.
          if (recent.isNotEmpty) ...[
            const SizedBox(height: grid.AppDesktop.groupGap),
            column(
              Row(
                children: [
                  Expanded(
                    child: SwarmSearchField(
                      hintText: 'Find a project',
                      onChanged: (query) => setState(() => _query = query),
                    ),
                  ),
                  const SizedBox(width: grid.AppDesktop.groupGap),
                  _SortMenu(
                    sort: _sort,
                    onSort: (sort) => setState(() => _sort = sort),
                  ),
                ],
              ),
            ),
            const SizedBox(height: grid.AppDesktop.groupGap),
            if (rows.isNotEmpty)
              column(
                DecoratedBox(
                  key: const ValueKey('super-projects-list'),
                  decoration: BoxDecoration(
                    border: Border.all(color: DesktopChrome.rim),
                    borderRadius: BorderRadius.circular(_listRadius),
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(_listRadius - 1),
                    child: Column(
                      children: [
                        for (final (index, project) in rows.indexed) ...[
                          if (index > 0)
                            Divider(
                              height: 1,
                              thickness: 1,
                              color: DesktopChrome.rim,
                            ),
                          _ProjectRow(
                            controller: widget.controller,
                            project: project,
                            work: _work(snapshot, project),
                            activity: _activity.byProject[project.id],
                            onTap: () => widget.onOpen(project),
                            onOpenRepository: _openRepository,
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ],
      );
    },
  );

  Widget _header(int count) => Row(
    crossAxisAlignment: CrossAxisAlignment.baseline,
    textBaseline: TextBaseline.alphabetic,
    children: [
      Text(
        'Projects',
        style: grid.AppType.title(color: grid.AppPalette.textPrimary),
      ),
      if (count > 0) ...[
        const SizedBox(width: grid.AppDesktop.controlGap),
        Text(
          '$count',
          key: const ValueKey('super-projects-count'),
          style: DesktopChrome.control(color: grid.AppPalette.textFaint),
        ),
      ],
      const Spacer(),
      if (widget.onNewProject case final onNewProject?)
        FilledButton.icon(
          onPressed: onNewProject,
          style: FilledButton.styleFrom(shape: const StadiumBorder()),
          icon: const Icon(AppIcons.plus, size: AppIcons.inlineSize),
          label: const Text('New project'),
        ),
    ],
  );
}

const _listRadius = 12.0;

/// A project's open work from its board pulse: agents working and tasks next up.
({int working, int toDo, int total}) _work(
  SuperTabSnapshot? snapshot,
  SuperTabProject project,
) {
  final pulse = snapshot?.pulseOf(project.id);
  final working = pulse?.working.count ?? 0, toDo = pulse?.nextUp.count ?? 0;
  return (working: working, toDo: toDo, total: working + toDo);
}

/// [recent] (newest message first, [superTabProjectsByRecent]) found by [query] in a name or purpose, then ordered by
/// [sort]: Recent by the server's last activity where it has one, Name, or Most work; ties keep [recent]'s order.
List<SuperTabProject> superTabProjectsListed(
  List<SuperTabProject> recent, {
  required SuperTabProjectSort sort,
  required String query,
  required Map<String, SuperTabProjectActivity> activity,
  required int Function(SuperTabProject project) work,
}) {
  final needle = query.trim().toLowerCase();
  final place = {for (final (i, p) in recent.indexed) p.id: i};
  int updated(SuperTabProject p) =>
      activity[p.id]?.updatedAt?.millisecondsSinceEpoch ?? -1;
  int compare(SuperTabProject a, SuperTabProject b) => switch (sort) {
    SuperTabProjectSort.recent => updated(b).compareTo(updated(a)),
    SuperTabProjectSort.name => a.name.toLowerCase().compareTo(
      b.name.toLowerCase(),
    ),
    SuperTabProjectSort.work => work(b).compareTo(work(a)),
  };
  return [
    for (final project in recent)
      if (needle.isEmpty ||
          project.name.toLowerCase().contains(needle) ||
          (project.about?.toLowerCase().contains(needle) ?? false))
        project,
  ]..sort(
    (a, b) => switch (compare(a, b)) {
      0 => place[a.id]!.compareTo(place[b.id]!),
      final order => order,
    },
  );
}

/// The Swarm's projects, the one with the latest message in its chat or its tasks first, then by name.
List<SuperTabProject> superTabProjectsByRecent(SuperTabController controller) {
  final projects = [...?controller.snapshot?.projects];
  int latest(SuperTabProject project) => controller
      .projectConversations(project.id)
      .fold(0, (at, g) => math.max(at, g.lastMessageSequence));
  final at = {for (final project in projects) project.id: latest(project)};
  return projects..sort(
    (a, b) => switch (at[b.id]!.compareTo(at[a.id]!)) {
      0 => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
      final order => order,
    },
  );
}

/// A project's GitHub repository: `owner/name` as GitHub lists it, and its page; null for none or another host.
({String path, String name, String url})? superTabProjectRepository(
  SuperTabProject project,
) {
  final address = project.repository?['repositoryUrl'];
  if (address is! String) return null;
  final match = RegExp(r'github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$')
      .firstMatch(address.trim());
  if (match == null) return null;
  final owner = match.group(1)!, name = match.group(2)!;
  return (
    path: '$owner/$name',
    name: name,
    url: 'https://github.com/$owner/$name',
  );
}

/// Sort: its value in quiet text, the chevron only on hover (Swarm rule 5); opens Recent, Name and Most work.
class _SortMenu extends StatefulWidget {
  const _SortMenu({required this.sort, required this.onSort});
  final SuperTabProjectSort sort;
  final ValueChanged<SuperTabProjectSort> onSort;

  @override
  State<_SortMenu> createState() => _SortMenuState();
}

class _SortMenuState extends State<_SortMenu> {
  final _menu = MenuController();
  var _hover = false;

  @override
  Widget build(BuildContext context) => AppDropdown(
    controller: _menu,
    width: 160,
    onOpen: () => setState(() {}),
    onClose: () => setState(() {}),
    children: [
      for (final sort in SuperTabProjectSort.values)
        AppMenuItem(
          key: ValueKey('super-projects-sort-${sort.name}'),
          label: sort.label,
          selected: sort == widget.sort,
          onPressed: () => widget.onSort(sort),
        ),
    ],
    builder: (context, menu, _) {
      final lit = _hover || menu.isOpen;
      void toggle() => menu.isOpen ? menu.close() : menu.open();
      return Semantics(
        button: true,
        label: 'Sort',
        value: widget.sort.label,
        excludeSemantics: true,
        onTap: toggle,
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          onEnter: (_) => setState(() => _hover = true),
          onExit: (_) => setState(() => _hover = false),
          child: GestureDetector(
            key: const ValueKey('super-projects-sort'),
            behavior: HitTestBehavior.opaque,
            onTap: toggle,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Sort: ${widget.sort.label}',
                  style: DesktopChrome.control(
                    color: lit
                        ? grid.AppPalette.textPrimary
                        : grid.AppPalette.textSecondary,
                  ),
                ),
                const SizedBox(width: grid.AppDesktop.listRowGap * 2),
                // Its room is kept at rest, so hover moves nothing.
                Opacity(
                  opacity: lit ? 1 : 0,
                  child: Icon(
                    AppIcons.chevronDown,
                    size: AppIcons.inlineSize,
                    color: DesktopChrome.muted,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

/// One project, in three lines and a sparkline: its name (16 semibold) and Public or Private; its purpose, at most two
/// lines; then one quiet 12 line of its Lead, members, open work, repository and last update. Empty values are left out.
class _ProjectRow extends StatelessWidget {
  const _ProjectRow({
    required this.controller,
    required this.project,
    required this.work,
    required this.activity,
    required this.onTap,
    required this.onOpenRepository,
  });

  final SuperTabController controller;
  final SuperTabProject project;
  final ({int working, int toDo, int total}) work;
  final SuperTabProjectActivity? activity;
  final VoidCallback onTap;
  final ValueChanged<String> onOpenRepository;

  static const _faceSize = 16.0;

  @override
  Widget build(BuildContext context) {
    final id = project.leadConversationId;
    final about = project.about;
    return Material(
      key: ValueKey('super-group-$id'),
      color: Colors.transparent,
      child: Semantics(
        button: true,
        label: [
          project.name,
          project.isPrivate ? 'Private' : 'Public',
          ?about,
        ].join(', '),
        child: InkWell(
          onTap: onTap,
          hoverColor: grid.AppSurface.hoverFill,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: grid.AppDesktop.groupGap,
              vertical: grid.AppDesktop.composerRowGap + 2,
            ),
            child: LayoutBuilder(
              builder: (context, box) =>
                  _row(context, box.maxWidth >= _sparklineFrom),
            ),
          ),
        ),
      ),
    );
  }

  /// The narrowest row that still draws its sparkline.
  static const _sparklineFrom = 560.0;

  Widget _row(BuildContext context, bool wide) {
    final id = project.leadConversationId;
    final about = project.about;
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      project.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.text(
                        color: grid.AppPalette.textPrimary,
                        size: 16,
                        height: 1.25,
                      ).copyWith(fontWeight: grid.AppFont.semibold),
                    ),
                  ),
                  const SizedBox(width: grid.AppDesktop.controlGap),
                  SuperTabChip(
                    text: project.isPrivate ? 'Private' : 'Public',
                    outlined: true,
                    capsule: true,
                  ),
                ],
              ),
              if (about != null) ...[
                const SizedBox(height: grid.AppDesktop.listRowGap * 2),
                Text(
                  about,
                  key: ValueKey('super-project-about-$id'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.text(
                    color: grid.AppPalette.textSecondary,
                    size: 13,
                    height: 1.45,
                  ),
                ),
              ],
              const SizedBox(height: grid.AppDesktop.controlGap - 2),
              _meta(context),
              // Teammates' agents cannot push to its repository yet: the one thing here to act on.
              ProjectGitHubLine(controller: controller, project: project),
            ],
          ),
        ),
        // A narrow row keeps its words: the sparkline shows only beside room for them.
        if (activity case final activity? when wide) ...[
          const SizedBox(width: grid.AppDesktop.panelPadding),
          SuperTabSparkline(
            values: activity.shipped,
            color: grid.AppPalette.textFaint,
          ),
        ],
      ],
    );
  }

  Widget _meta(BuildContext context) {
    final id = project.leadConversationId;
    final snapshot = controller.snapshot;
    final lead = snapshot?.leadOf(project.id);
    final members = [
      for (final agent in snapshot?.agents ?? const <SuperTabAgent>[])
        if (agent.projectId == project.id &&
            !agent.isBuddy &&
            agent.kind != 'buddy' &&
            agent.id != lead?.id)
          agent,
    ];
    final style = DesktopChrome.metadata(color: grid.AppPalette.textFaint);
    final workText = [
      if (work.working > 0) '${work.working} working',
      if (work.toDo > 0) '${work.toDo} to do',
    ].join(' · ');
    final repository = superTabProjectRepository(project);
    final updatedAt = activity?.updatedAt;
    Widget text(String value) => Text(
      value,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      softWrap: false,
      style: style,
    );
    final items = <Widget>[
      if (lead != null)
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SuperTabAvatar.agent(
              lead,
              key: ValueKey('super-project-lead-face-$id'),
              size: _faceSize,
              engineBadge: false,
              radius: 4,
              faceCorner: 4,
            ),
            const SizedBox(width: grid.AppDesktop.controlGap - 2),
            Flexible(child: text(lead.displayName ?? lead.name)),
          ],
        ),
      if (members.isNotEmpty)
        Row(
          key: ValueKey('super-project-member-faces-$id'),
          mainAxisSize: MainAxisSize.min,
          children: [
            _Faces(agents: members.take(4).toList(), size: _faceSize),
            if (members.length > 4) ...[
              const SizedBox(width: grid.AppDesktop.listRowGap * 2),
              Text('+${members.length - 4}', style: style),
            ],
          ],
        ),
      if (workText.isNotEmpty) text(workText),
      if (repository != null)
        Tooltip(
          message: repository.path,
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              key: ValueKey('super-project-repository-$id'),
              behavior: HitTestBehavior.opaque,
              onTap: () => onOpenRepository(repository.url),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SvgPicture.asset(
                    'assets/octicons/mark-github.svg',
                    width: 12,
                    height: 12,
                    colorFilter: ColorFilter.mode(
                      grid.AppPalette.textFaint,
                      BlendMode.srcIn,
                    ),
                    excludeFromSemantics: true,
                  ),
                  const SizedBox(width: grid.AppDesktop.listRowGap * 2),
                  Flexible(child: text(repository.name)),
                ],
              ),
            ),
          ),
        ),
      if (updatedAt != null)
        text('Updated ${relativeAgo(updatedAt, clock.now())}'),
    ];
    // One line: what does not fit wraps below it and is clipped, so the line drops its last items rather than
    // squeezing every one.
    return SizedBox(
      key: ValueKey('super-project-meta-$id'),
      height: _faceSize + 4,
      child: ClipRect(
        child: Wrap(
          spacing: grid.AppDesktop.groupGap,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: items,
        ),
      ),
    );
  }
}

/// Up to four member faces, each overlapping the last, ringed in the ground so they stay apart.
class _Faces extends StatelessWidget {
  const _Faces({required this.agents, required this.size});
  final List<SuperTabAgent> agents;
  final double size;

  @override
  Widget build(BuildContext context) {
    const ring = 1.5;
    final step = size - 3;
    return SizedBox(
      width: step * (agents.length - 1) + size + ring * 2,
      height: size + ring * 2,
      child: Stack(
        children: [
          for (final (i, agent) in agents.indexed)
            Positioned(
              left: step * i,
              child: Container(
                key: const ValueKey('super-project-member-face'),
                padding: const EdgeInsets.all(ring),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: grid.AppPalette.swarmField,
                ),
                child: SuperTabAvatar.agent(
                  agent,
                  size: size,
                  engineBadge: false,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A quiet line of [values], one point per day, oldest at the left; scaled to the busiest day. Grey: it shows a
/// rhythm, not a state (Swarm rule 1).
class SuperTabSparkline extends StatelessWidget {
  const SuperTabSparkline({
    super.key,
    required this.values,
    required this.color,
    this.size = const Size(120, 28),
  });

  final List<int> values;
  final Color color;
  final Size size;

  @override
  Widget build(BuildContext context) {
    final total = values.fold(0, (sum, day) => sum + day);
    return Semantics(
      label: '$total ${total == 1 ? 'task' : 'tasks'} shipped in 4 weeks',
      child: CustomPaint(
        size: size,
        painter: _SparklinePainter(values: values, color: color),
      ),
    );
  }
}

class _SparklinePainter extends CustomPainter {
  _SparklinePainter({required this.values, required this.color});
  final List<int> values;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.isEmpty) return;
    const stroke = 1.5;
    final top = values.reduce(math.max);
    final span = size.height - stroke * 2;
    final dx = values.length == 1 ? 0.0 : size.width / (values.length - 1);
    final path = Path();
    for (final (i, value) in values.indexed) {
      final y = size.height - stroke - (top == 0 ? 0 : value / top * span);
      i == 0 ? path.moveTo(0, y) : path.lineTo(dx * i, y);
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(_SparklinePainter old) =>
      old.color != color || !_same(old.values, values);

  static bool _same(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}
