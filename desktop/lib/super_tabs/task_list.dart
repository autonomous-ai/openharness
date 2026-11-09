import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/swarm_layout.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'controller.dart';
import 'github_issues.dart';
import 'identity.dart';
import 'swarm_type.dart';

/// A project's tasks (Swarm v4, anh Dee 2026-11-09): its repository's open GitHub issues, read with `gh` on this
/// computer as its person ([SwarmGitHub]), newest activity first, as quiet cards beside the channel. A card names the
/// agent its `builder:<name>` label gives it and says On it when it is `status:taken`; tapping it opens the issue.
class SwarmTaskList extends StatefulWidget {
  const SwarmTaskList({
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

  /// How often the list is read again while it shows; null reads it once.
  final Duration? refreshEvery;
  final DateTime Function() now;

  /// The project's repository as `owner/name`, or null when it has none on GitHub.
  static String? repositoryOf(
    SuperTabController controller,
    String conversationId,
  ) {
    final project = controller.snapshot?.projectFor(conversationId);
    final url = project?.repository?['repositoryUrl'];
    return SwarmGitHub.repositoryOf(url is String ? url : null);
  }

  @override
  State<SwarmTaskList> createState() => _SwarmTaskListState();
}

class _SwarmTaskListState extends State<SwarmTaskList> {
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
  void didUpdateWidget(SwarmTaskList old) {
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
    final repository = SwarmTaskList.repositoryOf(
      widget.controller,
      widget.conversationId,
    );
    if (repository != _repository) setState(() => _repository = repository);
    if (repository == null) return;
    try {
      final issues = await widget.github.issues(repository);
      if (!mounted || repository != _repository) return;
      setState(() {
        _issues = issues;
        _error = null;
      });
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
      // Waiting in the shape of its answer: cards, as the list will be.
      return const SkeletonList(
        key: ValueKey('swarm-tasks-loading'),
        rows: 4,
        padding: EdgeInsets.all(grid.AppDesktop.groupGap),
      );
    }
    // Its cards are kept laid out off screen, so a hovered one never breaks hit testing (laid_out_list.dart).
    return LaidOutListView.builder(
      key: const ValueKey('swarm-task-list'),
      padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
      itemCount: issues.length,
      itemBuilder: (context, i) => Padding(
        padding: EdgeInsets.only(top: i == 0 ? 0 : grid.AppDesktop.controlGap),
        child: _card(context, repository, issues[i]),
      ),
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
                child: Container(
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
              ),
              Text(
                issue.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: SwarmType.body(context)
                    .copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  // The agent takes what the state at the end leaves, so the state always sits at the right edge.
                  Expanded(
                    child: Row(
                      children: [
                        if (agent != null) ...[
                          swarmAgentFace(widget.controller, agent),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(
                              agent,
                              overflow: TextOverflow.ellipsis,
                              style: DesktopChrome.metadata(),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    [
                      if (issue.taken) 'On it',
                      if (issue.updatedAt case final at?)
                        swarmAgo(at, widget.now()),
                    ].join(' · '),
                    style: DesktopChrome.metadata(),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
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
