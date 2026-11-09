import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'github_issues.dart';
import 'message_row.dart';
import 'message_text.dart';
import 'model.dart';
import 'swarm_type.dart';
import 'task_board.dart';

/// A task opened beside its project's channel (Swarm v4, anh Dee 2026-11-09): the GitHub issue, read with `gh` on this
/// computer as its person, its text and its comments as one conversation, each named by the agent that signed it. People
/// read it here; agents write on GitHub, and Open in GitHub goes there.
class SwarmIssuePanel extends StatefulWidget {
  const SwarmIssuePanel({
    super.key,
    required this.controller,
    required this.github,
    required this.repository,
    required this.number,
    required this.onClose,
    this.refreshEvery = const Duration(seconds: 30),
    this.now = DateTime.now,
    this.openUrl = _openUrl,
  });

  final SuperTabController controller;
  final SwarmGitHub github;

  /// `owner/name`.
  final String repository;
  final int number;
  final VoidCallback onClose;

  /// How often it is read again while it shows; null reads it once.
  final Duration? refreshEvery;
  final DateTime Function() now;
  final void Function(String url) openUrl;

  static void _openUrl(String url) => unawaited(
    launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
  );

  @override
  State<SwarmIssuePanel> createState() => _SwarmIssuePanelState();
}

class _SwarmIssuePanelState extends State<SwarmIssuePanel> {
  SwarmIssueThread? _thread;

  /// Every comment read so far, oldest first: the newest the thread brings, and the pages "Show" read before them. A comment
  /// that left the newest window since stays.
  List<SwarmIssueComment> _comments = const [];

  /// Where the comments before [_comments] start, or null when it holds them all.
  String? _earlier;
  bool _showing = false;
  String? _error;
  Timer? _refresh;

  @override
  void initState() {
    super.initState();
    _open();
    if (widget.refreshEvery case final every?) {
      _refresh = Timer.periodic(every, (_) => _read());
    }
  }

  @override
  void didUpdateWidget(SwarmIssuePanel old) {
    super.didUpdateWidget(old);
    if (old.number != widget.number || old.repository != widget.repository) {
      _thread = null;
      _comments = const [];
      _earlier = null;
      _error = null;
      _open();
    }
  }

  /// What was read last shows at once; the read brings what changed since.
  void _open() {
    final kept = widget.github.keptThread(widget.repository, widget.number);
    if (kept != null) _take(kept);
    _read();
  }

  void _take(SwarmIssueThread thread) {
    final first = _thread == null;
    _thread = thread;
    final byKey = {
      for (final c in [..._comments, ...thread.comments]) _key(c): c,
    };
    _comments = byKey.values.toList()
      ..sort(
        (a, b) =>
            (a.createdAt ?? DateTime(0)).compareTo(b.createdAt ?? DateTime(0)),
      );
    // The comments before the newest are found from the first read's cursor; a later read leaves it, for it still points there.
    if (first) _earlier = thread.earlier;
  }

  static String _key(SwarmIssueComment c) =>
      c.url ?? '${c.createdAt?.toIso8601String()}${c.author}${c.body.hashCode}';

  @override
  void dispose() {
    _refresh?.cancel();
    super.dispose();
  }

  Future<void> _read() async {
    final (repository, number) = (widget.repository, widget.number);
    try {
      final thread = await widget.github.thread(repository, number);
      if (!mounted ||
          repository != widget.repository ||
          number != widget.number)
        return;
      setState(() {
        _take(thread);
        _error = null;
      });
    } on SwarmGitHubError catch (error) {
      if (!mounted ||
          repository != widget.repository ||
          number != widget.number)
        return;
      setState(() => _error = error.message);
    }
  }

  /// Reads the page of comments before the ones shown and puts it above them.
  Future<void> _showEarlier() async {
    final (repository, number, cursor) = (
      widget.repository,
      widget.number,
      _earlier,
    );
    if (cursor == null || _showing) return;
    setState(() => _showing = true);
    try {
      final page = await widget.github.earlier(repository, number, cursor);
      if (!mounted ||
          repository != widget.repository ||
          number != widget.number)
        return;
      setState(() {
        _comments = [...page.comments, ..._comments];
        _earlier = page.earlier;
        _error = null;
      });
    } on SwarmGitHubError catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _showing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final url =
        _thread?.issue.url ??
        'https://github.com/${widget.repository}/issues/${widget.number}';
    return ColoredBox(
      key: const ValueKey('swarm-issue-panel'),
      color: DesktopChrome.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            // As high as the chat's header, so their rules meet.
            constraints: const BoxConstraints(minHeight: 51),
            alignment: Alignment.center,
            padding: const EdgeInsets.fromLTRB(
              SuperTabMessageRow.horizontalInset,
              0,
              grid.AppDesktop.controlGap,
              0,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Semantics(
                    header: true,
                    // A task is named by its number, as its card is.
                    child: Text(
                      '#${widget.number}',
                      style: SwarmType.name(context),
                    ),
                  ),
                ),
                AppIconButton(
                  key: const ValueKey('swarm-issue-github'),
                  icon: AppIcons.externalLink,
                  tooltip: 'Open in GitHub',
                  onPressed: () => widget.openUrl(url),
                ),
                AppIconButton(
                  key: const ValueKey('swarm-issue-close'),
                  icon: AppIcons.close,
                  tooltip: 'Close',
                  onPressed: widget.onClose,
                ),
              ],
            ),
          ),
          Divider(height: 1, thickness: 1, color: DesktopChrome.rim),
          Expanded(child: _body(context)),
          Container(
            key: const ValueKey('swarm-issue-agents-only'),
            margin: const EdgeInsets.fromLTRB(
              grid.AppDesktop.groupGap,
              0,
              grid.AppDesktop.groupGap,
              grid.AppDesktop.groupGap,
            ),
            height: 40,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: grid.AppSurface.recess,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              'Only agents post here.',
              style: DesktopChrome.metadata(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(BuildContext context) {
    final thread = _thread;
    final error = _error;
    if (thread == null && error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Text(
                error,
                key: const ValueKey('swarm-issue-error'),
                textAlign: TextAlign.center,
                style: DesktopChrome.metadata(),
              ),
            ),
            const SizedBox(height: 8),
            AppIconButton(
              key: const ValueKey('swarm-issue-retry'),
              icon: AppIcons.refreshCw,
              tooltip: 'Try again',
              onPressed: _read,
            ),
          ],
        ),
      );
    }
    if (thread == null) {
      return const SkeletonList(
        key: ValueKey('swarm-issue-loading'),
        rows: 4,
        padding: EdgeInsets.all(SuperTabMessageRow.horizontalInset),
      );
    }
    final issue = thread.issue;
    final agent = issue.agent;
    final agents = <String>[
      for (final a
          in widget.controller.snapshot?.agents ?? const <SuperTabAgent>[])
        a.displayName ?? a.name,
    ];
    return ListView(
      key: const ValueKey('swarm-issue-thread'),
      padding: const EdgeInsets.fromLTRB(
        SuperTabMessageRow.horizontalInset,
        16,
        SuperTabMessageRow.horizontalInset,
        16,
      ),
      children: [
        Text(
          issue.title,
          key: const ValueKey('swarm-issue-title'),
          style: SwarmType.body(context)
              .copyWith(fontWeight: FontWeight.w600, fontSize: 16),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            if (agent != null) ...[
              swarmAgentFace(widget.controller, agent),
              const SizedBox(width: 6),
              Text(agent, style: DesktopChrome.metadata()),
              Text(' · ', style: DesktopChrome.metadata()),
            ],
            Text(
              !thread.open
                  ? 'Closed'
                  : issue.taken
                  ? 'On it'
                  : 'Waiting',
              style: DesktopChrome.metadata(),
            ),
            if (issue.author != null || issue.createdAt != null)
              Flexible(
                child: Text(
                  [
                    '',
                    ?issue.author,
                    if (issue.createdAt case final at?)
                      'opened ${swarmAgo(at, widget.now())} ago',
                  ].join(' · '),
                  key: const ValueKey('swarm-issue-opened'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.metadata(),
                ),
              ),
          ],
        ),
        if (issue.labels.isNotEmpty) ...[
          const SizedBox(height: 8),
          SwarmLabelChips(issue: issue, limit: 12),
        ],
        const SizedBox(height: 16),
        _post(
          context,
          SwarmIssueComment(
            body: thread.body,
            author: issue.author,
            createdAt: thread.createdAt,
          ),
          agents,
        ),
        if (_earlier != null) ...[
          const SizedBox(height: 18),
          Row(
            key: const ValueKey('swarm-issue-earlier'),
            children: [
              Expanded(
                child: Text(
                  _earlierText(issue.comments - _comments.length),
                  style: DesktopChrome.metadata(),
                ),
              ),
              TextButton(
                key: const ValueKey('swarm-issue-show-earlier'),
                onPressed: _showing ? null : _showEarlier,
                child: Text(_showing ? 'Reading' : 'Show'),
              ),
            ],
          ),
        ],
        for (final comment in _comments) ...[
          const SizedBox(height: 18),
          _post(context, comment, agents),
        ],
      ],
    );
  }

  /// One post: the face and name it is signed with (else its GitHub login), its login and time, then its text.
  Widget _post(
    BuildContext context,
    SwarmIssueComment post,
    List<String> agents,
  ) {
    final name = post.signedBy ?? post.author ?? 'GitHub';
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        swarmAgentFace(widget.controller, name, size: 28),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: name, style: SwarmType.name(context)),
                    TextSpan(
                      text: [
                        if (post.author != null && post.author != name)
                          post.author!,
                        if (post.createdAt case final at?)
                          _when(at, widget.now()),
                      ].map((part) => ' · $part').join(),
                      style: DesktopChrome.metadata(),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 4),
              if (post.body.trim().isNotEmpty)
                SuperTabMessageText(post.body, agents: agents),
            ],
          ),
        ),
      ],
    );
  }
}

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// A post's time on this computer's clock: 09:11 today, else Nov 8, 09:11.
String _when(DateTime at, DateTime now) {
  final local = at.toLocal(), today = now.toLocal();
  final time =
      '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  final sameDay =
      local.year == today.year &&
      local.month == today.month &&
      local.day == today.day;
  return sameDay ? time : '${_months[local.month - 1]} ${local.day}, $time';
}

/// 1576 as 1,576.
String _formatCount(int n) => n.toString().replaceAllMapped(
  RegExp(r'(\d)(?=(\d{3})+$)'),
  (m) => '${m[1]},',
);

/// How many comments are before the ones shown: "1 earlier comment", "1,546 earlier comments".
String _earlierText(int n) =>
    '${_formatCount(n)} earlier comment${n == 1 ? '' : 's'}';
