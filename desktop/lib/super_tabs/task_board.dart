import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'controller.dart';
import 'github_issues.dart';
import 'identity.dart';
import 'swarm_type.dart';

/// A project's tasks (Swarm v4, anh Dee 2026-11-09): its repository's open GitHub issues, read with `gh` on this computer
/// as its person ([SwarmGitHub]), as a board of three columns, newest activity first: To do (nobody has it), Assigned (its
/// `builder:<name>` label names an agent) and On it (`status:taken`). A card holds what github.com's list shows: the number,
/// the title, the labels in their colours, who opened it and when, and how many comments it has. Tapping one opens the issue.
class SwarmTaskBoard extends StatefulWidget {
  const SwarmTaskBoard({
    super.key,
    required this.controller,
    required this.conversationId,
    required this.github,
    required this.onOpen,
    required this.onClose,
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

  /// The issue open beside the channel: its card shows selected.
  final int? openNumber;

  /// How often the board is read again while it shows; null reads it once.
  final Duration? refreshEvery;
  final DateTime Function() now;

  /// The least a column is wide: a narrower pane scrolls sideways.
  static const columnMinWidth = 220.0;

  /// The project's repository as `owner/name`, or null when it has none on GitHub.
  static String? repositoryOf(
    SuperTabController controller,
    String conversationId,
  ) {
    final project = controller.snapshot?.projectFor(conversationId);
    final url = project?.repository?['repositoryUrl'];
    return SwarmGitHub.repositoryOf(url is String ? url : null);
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

class _SwarmTaskBoardState extends State<SwarmTaskBoard> {
  List<SwarmIssue>? _issues;
  String? _error;
  String? _repository;
  Timer? _refresh;

  @override
  void initState() {
    super.initState();
    _read();
    if (widget.refreshEvery case final every?) {
      _refresh = Timer.periodic(every, (_) => _read());
    }
  }

  @override
  void didUpdateWidget(SwarmTaskBoard old) {
    super.didUpdateWidget(old);
    if (old.conversationId != widget.conversationId) {
      _issues = null;
      _error = null;
      _read();
    }
  }

  @override
  void dispose() {
    _refresh?.cancel();
    super.dispose();
  }

  Future<void> _read() async {
    final repository = SwarmTaskBoard.repositoryOf(
      widget.controller,
      widget.conversationId,
    );
    if (repository != _repository) setState(() => _repository = repository);
    if (repository == null) return;
    // What was read last shows at once; the read below only brings what changed.
    final kept = _issues == null ? widget.github.kept(repository) : null;
    if (kept != null) setState(() => _issues = kept);
    try {
      final issues = await widget.github.issues(
        repository,
        // The first hundred, the newest, show while the rest are read.
        onPage: (sofar) {
          if (!mounted || repository != _repository) return;
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
      // Their threads are read now, so a card opens at once.
      unawaited(widget.github.prefetch(repository, issues));
    } on SwarmGitHubError catch (error) {
      if (!mounted || repository != _repository) return;
      setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ColoredBox(
      color: DesktopChrome.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Row(
              children: [
                Text('Tasks', style: DesktopChrome.text(medium: true)),
                const Spacer(),
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
          padding: const EdgeInsets.fromLTRB(
            4,
            grid.AppDesktop.groupGap,
            4,
            grid.AppDesktop.controlGap,
          ),
          child: Row(
            children: [
              Text(name, style: DesktopChrome.text(medium: true)),
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
      padding: const EdgeInsets.all(24),
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
    return Material(
      color: selected ? grid.AppSurface.recess : grid.AppPalette.cardBg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: DesktopChrome.rim),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: ValueKey('swarm-task-${issue.number}'),
        onTap: () => widget.onOpen(repository, issue),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: grid.AppSurface.recess,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    '#${issue.number}',
                    style: DesktopChrome.metadata(),
                  ),
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
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      decoration: BoxDecoration(
        color: base.withValues(alpha: 0.18),
        border: Border.all(color: base.withValues(alpha: 0.45)),
        borderRadius: BorderRadius.circular(999),
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
  return Color(0xFF000000 | int.parse(hex, radix: 16));
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

/// The face of the agent named [name] in this Swarm (a `builder:<name>` label, or the name a comment is signed with),
/// matched without case; a face drawn from the name when the Swarm has no such agent.
Widget swarmAgentFace(
  SuperTabController controller,
  String name, {
  double size = 22,
}) {
  final key = name.toLowerCase();
  final agent = controller.snapshot?.agents
      .where((a) => (a.displayName ?? a.name).toLowerCase() == key)
      .firstOrNull;
  if (agent != null)
    return SuperTabAvatar.agent(agent, size: size, engineBadge: false);
  return SuperTabAvatar(
    identity: 'agent:$key',
    name: name,
    size: size,
    face: true,
  );
}

/// How long ago [at] was, in the fewest characters: now, 5m, 3h, 2d.
String swarmAgo(DateTime at, DateTime now) {
  final gone = now.difference(at);
  if (gone.inMinutes < 1) return 'now';
  if (gone.inHours < 1) return '${gone.inMinutes}m';
  if (gone.inDays < 1) return '${gone.inHours}h';
  return '${gone.inDays}d';
}
