import 'dart:async';
import 'dart:math';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/swarm_layout.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/skeleton.dart';
import '../logging/app_log.dart';
import '../state/app_state.dart' show AppNotifier;
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'controller.dart';
import 'github_issues.dart';
import 'github_pulls.dart';
import 'identity.dart';
import 'model.dart';
import 'personal_projects.dart' show PersonalProjects;
import 'pull_chip.dart';
import 'swarm_type.dart';
import 'visible_tick.dart';

/// A project's tasks (Swarm v4, anh Dee 2026-11-09): its repository's open GitHub issues, read with `gh` on this computer
/// as its person ([SwarmGitHub]), as a board of three columns, newest activity first: To do (nobody has it), Assigned (its
/// `builder:<name>` label names an agent) and On it (`status:taken`). A card holds what github.com's list shows: the number,
/// the title, the labels in their colours, who opened it and when, and how many comments it has, and beside its number where
/// its pull request stands ([SwarmPullChip]). Tapping one opens the issue.
class SwarmTaskBoard extends StatefulWidget {
  const SwarmTaskBoard({
    super.key,
    required this.controller,
    required this.conversationId,
    required this.github,
    required this.onOpen,
    required this.onClose,
    this.app,
    this.openNumber,
    this.refreshEvery = const Duration(minutes: 1),
    this.now = DateTime.now,
  });

  final SuperTabController controller;

  /// The project's channel, whose project names the repository.
  final String conversationId;
  final SwarmGitHub github;

  /// Opens an issue of the repository (`owner/name`).
  final void Function(String repository, SwarmIssue issue) onOpen;
  final VoidCallback onClose;

  /// The person's app: a Personal project's repository is known only on their own Desktop ([repositoryOf]).
  final AppNotifier? app;

  /// The issue open beside the channel: its card shows selected.
  final int? openNumber;

  /// How often the board is read again while it shows; null reads it once.
  final Duration? refreshEvery;
  final DateTime Function() now;

  /// The least a column is wide: a narrower pane scrolls sideways. Three of them fit beside the channel in the window the
  /// app opens in (1280 wide: a pane of 490, 147 a column), so On it, the column people look for, is never out of sight.
  static const columnMinWidth = 140.0;

  /// The project's repository as `owner/name`, or null when it has none on GitHub: its record's, else, in the person's
  /// Personal Swarm, the repo its panes work in, read on [app]'s Desktop (personal_projects.dart).
  static String? repositoryOf(
    SuperTabController controller,
    String conversationId, {
    AppNotifier? app,
  }) {
    final project = controller.snapshot?.projectFor(conversationId);
    if (project == null) return null;
    final url = project.repository?['repositoryUrl'];
    return SwarmGitHub.repositoryOf(
      url is String
          ? url
          : app == null
          ? null
          : PersonalProjects.of(app).repositoryOf(controller, project.id),
    );
  }

  /// The three columns of [issues], each newest activity first: To do, Assigned, On it.
  static List<(String, List<SwarmIssue>)> columnsOf(List<SwarmIssue> issues) =>
      [
        (
          'To do',
          [
            for (final i in issues)
              if (!i.taken && i.agent == null) i,
          ],
        ),
        (
          'Assigned',
          [
            for (final i in issues)
              if (!i.taken && i.agent != null) i,
          ],
        ),
        (
          'On it',
          [
            for (final i in issues)
              if (i.taken) i,
          ],
        ),
      ];

  @override
  State<SwarmTaskBoard> createState() => _SwarmTaskBoardState();
}

class _SwarmTaskBoardState extends State<SwarmTaskBoard>
    with WidgetsBindingObserver, VisibleTick<SwarmTaskBoard> {
  List<SwarmIssue>? _issues;

  /// The open pull requests by the task each is for, as last read.
  Map<int, SwarmPull>? _pulls;
  String? _error;
  String? _repository;

  /// When the last read started: back in sight, the board reads only once its clock would have by now.
  DateTime? _readAt;

  /// The repository being read now: a refresh that comes while its read is still going waits for the next.
  String? _reading;

  /// A Personal project's repository becomes known on this Desktop after the board may have opened: read it then.
  void _personalMoved() {
    final repository = SwarmTaskBoard.repositoryOf(
      widget.controller,
      widget.conversationId,
      app: widget.app,
    );
    if (repository != _repository) _read();
  }

  @override
  void initState() {
    super.initState();
    if (widget.app case final app?) {
      PersonalProjects.of(app).addListener(_personalMoved);
    }
    _read();
    // Its clock runs only while it shows: hidden, it would spend the person's GitHub rate limit on nobody.
    if (widget.refreshEvery case final every?) visibleTick(every);
  }

  @override
  void onTick() => _read();

  @override
  void onScreenChanged(bool onScreen) {
    final (every, readAt) = (widget.refreshEvery, _readAt);
    if (onScreen &&
        every != null &&
        (readAt == null || clock.now().difference(readAt) >= every)) {
      _read();
    }
  }

  @override
  void didUpdateWidget(SwarmTaskBoard old) {
    super.didUpdateWidget(old);
    if (old.conversationId != widget.conversationId) {
      _issues = null;
      _pulls = null;
      _error = null;
      _read();
    }
  }

  @override
  void dispose() {
    if (widget.app case final app?) {
      PersonalProjects.of(app).removeListener(_personalMoved);
    }
    super.dispose();
  }

  Future<void> _read() async {
    final repository = SwarmTaskBoard.repositoryOf(
      widget.controller,
      widget.conversationId,
      app: widget.app,
    );
    if (repository != _repository) setState(() => _repository = repository);
    if (repository == null || _reading == repository) return;
    _reading = repository;
    _readAt = clock.now();
    // What was read last shows at once; the read below only brings what changed.
    final kept = _issues == null ? widget.github.kept(repository) : null;
    if (kept != null) {
      setState(() {
        _issues = kept;
        _pulls = widget.github.keptPulls(repository);
      });
    }
    // The first hundred show while the rest are read, only where nothing shows yet: a list already shown is whole, and
    // its first hundred would drop the rest from the board until the last page lands.
    final partial = _issues == null;
    try {
      final issues = await widget.github.issues(
        repository,
        onPage: (sofar) {
          if (!partial || !mounted || repository != _repository) return;
          setState(() {
            _issues = sofar;
            _error = null;
          });
        },
      );
      if (!mounted || repository != _repository) return;
      setState(() {
        _issues = issues;
        _error = null;
      });
      // Their pull requests after them: the cards show first, and a read of these that fails keeps the last chips.
      try {
        final pulls = await widget.github.pulls(
          repository,
          team: SwarmPull.teamOf(widget.controller.snapshot, repository),
        );
        if (mounted && repository == _repository) {
          setState(() => _pulls = pulls);
        }
      } on SwarmGitHubError catch (error) {
        appLog.warn(
          'super-tabs',
          'GitHub pull requests not read: ${error.message}',
        );
      }
      // Their threads are read now, so a card opens at once.
      unawaited(widget.github.prefetch(repository, issues));
    } on SwarmGitHubError catch (error) {
      if (!mounted || repository != _repository) return;
      setState(() => _error = error.message);
    } finally {
      if (_reading == repository) _reading = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // A read that failed while the cards from the last one show: said beside them, not left as if they were current.
    final stale = _issues != null ? _error : null;
    return ColoredBox(
      color: DesktopChrome.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(
              horizontal: SwarmLayout.barSide,
            ),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Row(
              children: [
                Text('Tasks', style: DesktopChrome.text(medium: true)),
                const Spacer(),
                if (stale != null) ...[
                  Flexible(
                    child: Text(
                      stale,
                      key: const ValueKey('swarm-tasks-stale'),
                      // Two lines: at the 1280 window the bar has about 175 px for it, and what to do is its end.
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(),
                    ),
                  ),
                  AppIconButton(
                    key: const ValueKey('swarm-tasks-retry'),
                    icon: AppIcons.refreshCw,
                    tooltip: 'Try again',
                    onPressed: _read,
                  ),
                ],
                AppIconButton(
                  key: const ValueKey('swarm-tasks-close'),
                  icon: AppIcons.close,
                  tooltip: 'Close',
                  onPressed: widget.onClose,
                ),
              ],
            ),
          ),
          Expanded(child: _body(context)),
        ],
      ),
    );
  }

  Widget _body(BuildContext context) {
    final repository = _repository;
    if (repository == null) {
      return _line(
        'This project has no GitHub repository.',
        key: 'swarm-tasks-no-repository',
      );
    }
    final issues = _issues;
    final error = _error;
    if (issues == null && error != null) {
      return Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _line(error, key: 'swarm-tasks-error'),
          const SizedBox(height: 8),
          AppIconButton(
            key: const ValueKey('swarm-tasks-retry'),
            icon: AppIcons.refreshCw,
            tooltip: 'Try again',
            onPressed: _read,
          ),
        ],
      );
    }
    if (issues == null) {
      // Waiting in the shape of its answer: the board's columns of cards.
      return const _BoardSkeleton(key: ValueKey('swarm-tasks-loading'));
    }
    final columns = SwarmTaskBoard.columnsOf(issues);
    return LayoutBuilder(
      builder: (context, box) {
        const pad = grid.AppDesktop.groupGap;
        const gap = grid.AppDesktop.controlGap;
        final width = max(
          SwarmTaskBoard.columnMinWidth,
          (box.maxWidth - 2 * pad - (columns.length - 1) * gap) /
              columns.length,
        );
        return SingleChildScrollView(
          key: const ValueKey('swarm-task-board'),
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: pad),
          child: SizedBox(
            height: box.maxHeight,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final (i, (name, column)) in columns.indexed)
                  Padding(
                    padding: EdgeInsets.only(left: i == 0 ? 0 : gap),
                    child: SizedBox(
                      width: width,
                      child: _column(context, repository, name, column),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _column(
    BuildContext context,
    String repository,
    String name,
    List<SwarmIssue> issues,
  ) {
    return Column(
      key: ValueKey('swarm-task-column-$name'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: SwarmLayout.columnHeadPadding,
          child: Row(
            children: [
              // A column at its least (140) with a larger text size: the name gives way, never the count.
              Flexible(
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.text(medium: true),
                ),
              ),
              const SizedBox(width: 8),
              Text('${issues.length}', style: DesktopChrome.metadata()),
            ],
          ),
        ),
        // Its cards are kept laid out off screen, so a hovered one never breaks hit testing (laid_out_list.dart).
        Expanded(
          child: LaidOutListView.builder(
            padding: const EdgeInsets.only(bottom: grid.AppDesktop.groupGap),
            itemCount: issues.length,
            itemBuilder: (context, i) => Padding(
              padding: EdgeInsets.only(
                top: i == 0 ? 0 : grid.AppDesktop.controlGap,
              ),
              child: _card(context, repository, issues[i]),
            ),
          ),
        ),
      ],
    );
  }

  Widget _line(String text, {required String key}) => Center(
    child: Padding(
      padding: const EdgeInsets.all(grid.AppDesktop.panelPadding),
      child: Text(
        text,
        key: ValueKey(key),
        textAlign: TextAlign.center,
        style: DesktopChrome.metadata(),
      ),
    ),
  );

  Widget _card(BuildContext context, String repository, SwarmIssue issue) {
    final agent = issue.agent;
    final selected = widget.openNumber == issue.number;
    final pull = _pulls?[issue.number];
    return Material(
      color: selected ? grid.AppSurface.recess : grid.AppPalette.cardBg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SwarmLayout.cardRadius),
        side: BorderSide(color: DesktopChrome.rim),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: ValueKey('swarm-task-${issue.number}'),
        onTap: () => widget.onOpen(repository, issue),
        child: Padding(
          padding: SwarmLayout.cardPadding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: SwarmLayout.capsuleGap),
                // The pull request sits at the top right, or under the task's number when the column has no room for both
                // whole: a chip cut to "#7…" said neither which pull request nor where it stands.
                child: Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    Container(
                      padding: SwarmLayout.capsulePadding,
                      decoration: BoxDecoration(
                        color: grid.AppSurface.recess,
                        borderRadius: BorderRadius.circular(
                          SwarmLayout.capsuleRadius,
                        ),
                      ),
                      child: Text(
                        '#${issue.number}',
                        style: DesktopChrome.metadata(),
                      ),
                    ),
                    ?(pull == null ? null : SwarmPullChip(pull: pull)),
                  ],
                ),
              ),
              Text(
                issue.title,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: SwarmType.body(context)
                    .copyWith(fontWeight: FontWeight.w600),
              ),
              if (issue.labels.isNotEmpty) ...[
                const SizedBox(height: 8),
                SwarmLabelChips(issue: issue),
              ],
              const SizedBox(height: 10),
              Row(
                children: [
                  // What opened it takes what the comment count leaves, so the count always sits at the right edge.
                  Expanded(
                    child: Row(
                      children: [
                        if (agent != null) ...[
                          swarmAgentFace(widget.controller, agent, size: 18),
                          const SizedBox(width: 6),
                        ],
                        Flexible(
                          child: Text(
                            [
                              ?issue.author,
                              if (issue.createdAt case final at?)
                                swarmAgo(at, widget.now()),
                            ].join(' · '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.metadata(),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (issue.comments > 0) ...[
                    const SizedBox(width: 8),
                    Icon(
                      AppIcons.messageSquare,
                      size: 13,
                      color: DesktopChrome.hint,
                    ),
                    const SizedBox(width: 3),
                    Text(
                      key: ValueKey('swarm-task-comments-${issue.number}'),
                      '${issue.comments}',
                      style: DesktopChrome.metadata(),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// An issue's labels as github.com draws them: a chip each in the label's own colour, the first [limit] and a "+N" for the rest.
class SwarmLabelChips extends StatelessWidget {
  const SwarmLabelChips({super.key, required this.issue, this.limit = 4});

  final SwarmIssue issue;
  final int limit;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final shown = issue.labels.take(limit).toList();
    final more = issue.labels.length - shown.length;
    return Wrap(
      spacing: 4,
      runSpacing: 4,
      children: [
        for (final name in shown) _chip(name, issue.labelColors[name]),
        if (more > 0) _chip('+$more', null),
      ],
    );
  }

  Widget _chip(String name, String? hex) {
    final base = _labelColor(hex) ?? DesktopChrome.hint;
    // GitHub's dark mode tints the label's colour behind lighter text; its light mode draws the colour's own darker shade.
    final hsl = HSLColor.fromColor(base);
    final text = hsl
        .withLightness(
          grid.AppTheme.isDark
              ? max(hsl.lightness, 0.68)
              : min(hsl.lightness, 0.30),
        )
        .toColor();
    return Container(
      key: ValueKey('swarm-label-$name'),
      padding: SwarmLayout.chipPadding,
      decoration: BoxDecoration(
        color: base.withValues(alpha: 0.18),
        border: Border.all(color: base.withValues(alpha: 0.45)),
        borderRadius: BorderRadius.circular(SwarmLayout.chipRadius),
      ),
      child: Text(
        name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: DesktopChrome.metadata(color: text),
      ),
    );
  }
}

/// A label's colour from the six hex digits GitHub gives it, or null when they are not hex.
Color? _labelColor(String? hex) {
  if (hex == null || !RegExp(r'^[0-9a-fA-F]{6}$').hasMatch(hex)) return null;
  final rgb = int.parse(hex, radix: 16);
  return Color.fromARGB(255, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
}

/// The board while it is first read: its three columns of quiet cards.
class _BoardSkeleton extends StatelessWidget {
  const _BoardSkeleton({super.key});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: grid.AppDesktop.groupGap),
    child: Row(
      children: [
        for (var i = 0; i < 3; i++) ...[
          if (i > 0) const SizedBox(width: grid.AppDesktop.controlGap),
          const Expanded(
            child: SkeletonList(
              rows: 4,
              padding: EdgeInsets.only(top: grid.AppDesktop.groupGap),
            ),
          ),
        ],
      ],
    ),
  );
}

/// The agent of this Swarm named [name] (a `builder:<name>` label, or the name a comment is signed with), by [swarmSameKey]:
/// "First builder" is `builder:first-builder`. Null when the Swarm has no such agent.
SuperTabAgent? swarmAgentNamed(SuperTabController controller, String name) {
  final snapshot = controller.snapshot;
  if (snapshot == null) return null;
  // Keyed once per snapshot: a board draws a face on every card and comment.
  final byKey = _agentsByKey[snapshot] ??= {
    for (final agent in snapshot.agents.reversed)
      // Its name as its label is made from it (cli githubMentions.ts): the first of its two names that is not blank.
      swarmSameKey(
        (agent.displayName?.trim().isNotEmpty ?? false)
            ? agent.displayName!
            : agent.name,
      ): agent,
  };
  return byKey[swarmSameKey(name)];
}

final _agentsByKey = Expando<Map<String, SuperTabAgent>>();

/// The face of the agent named [name] in this Swarm ([swarmAgentNamed]); a face drawn from the name when the Swarm has no such
/// agent, the same for every way of writing it.
Widget swarmAgentFace(
  SuperTabController controller,
  String name, {
  double size = 22,
}) {
  final agent = swarmAgentNamed(controller, name);
  if (agent != null) {
    return SuperTabAvatar.agent(agent, size: size, engineBadge: false);
  }
  return SuperTabAvatar(
    identity: 'agent:${swarmSameKey(name)}',
    name: name,
    size: size,
    face: true,
  );
}

/// When an issue was opened, as its header says it: `opened now`, `opened 5m ago`.
String swarmOpened(DateTime at, DateTime now) {
  final ago = swarmAgo(at, now);
  return ago == 'now' ? 'opened now' : 'opened $ago ago';
}

/// How long ago [at] was, in the fewest characters: now, 5m, 3h, 2d.
String swarmAgo(DateTime at, DateTime now) {
  final gone = now.difference(at);
  if (gone.inMinutes < 1) return 'now';
  if (gone.inHours < 1) return '${gone.inMinutes}m';
  if (gone.inDays < 1) return '${gone.inHours}h';
  return '${gone.inDays}d';
}
