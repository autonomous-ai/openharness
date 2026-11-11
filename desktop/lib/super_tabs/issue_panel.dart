import 'dart:async';
import 'dart:math' show max;

import 'package:clock/clock.dart';
import 'package:collection/collection.dart' show mergeSort;
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/swarm_layout.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../logging/app_log.dart';
import '../shared/widgets/skeleton.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/laid_out_list.dart';
import 'controller.dart';
import 'github_issues.dart';
import 'github_pulls.dart';
import 'message_row.dart';
import 'message_text.dart';
import 'model.dart';
import 'pull_chip.dart';
import 'swarm_type.dart';
import 'task_board.dart';
import 'visible_tick.dart';

/// A task opened beside its project's channel (Swarm v4, anh Dee 2026-11-09): the GitHub issue, read with `gh` on this
/// computer as its person, its text and its comments as one conversation, each named by the agent that signed it. People
/// read it here; agents write on GitHub, and Open in GitHub goes there.
///
/// A pull request opens the same way, as a chat of its own (anh Dee, 2026-11-10: "it has its own comments on PRs"): its text,
/// its comments, its reviews with their verdict and line comments with their place, and its merge, in time order.
class SwarmIssuePanel extends StatefulWidget {
  const SwarmIssuePanel({
    super.key,
    required this.controller,
    required this.github,
    required this.repository,
    required this.number,
    required this.onClose,
    this.pull = false,
    this.onOpenPull,
    this.refreshEvery = const Duration(seconds: 30),
    this.now = DateTime.now,
    this.openUrl = _openUrl,
  });

  /// It is pull request [number], not an issue.
  final bool pull;

  /// Opens a task's pull request in its place; null where nothing opens it.
  final ValueChanged<int>? onOpenPull;

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

class _SwarmIssuePanelState extends State<SwarmIssuePanel>
    with WidgetsBindingObserver, VisibleTick<SwarmIssuePanel> {
  SwarmIssueThread? _thread;

  /// The task's open pull request, as last read: shown under its title. A pull request's own, for its status.
  SwarmPull? _pull;

  /// Every comment read so far, oldest first, with none missing between them: the newest the thread brings, and the pages
  /// "Show" read before them.
  List<SwarmIssueComment> _comments = const [];

  /// Where the comments before [_comments] start, or null when it holds them all.
  String? _earlier;
  bool _showing = false;
  String? _error;

  /// When the last read started: back in sight, the task reads only once its clock would have by now.
  DateTime? _readAt;

  /// Reads still going: the clock's read waits for the next while one is.
  int _reads = 0;

  @override
  void initState() {
    super.initState();
    _open();
    // Its clock runs only while it shows: hidden, it would spend the person's GitHub rate limit on nobody.
    if (widget.refreshEvery case final every?) visibleTick(every);
  }

  @override
  void onTick() {
    if (_reads == 0) _read();
  }

  @override
  void onScreenChanged(bool onScreen) {
    final (every, readAt) = (widget.refreshEvery, _readAt);
    if (onScreen &&
        _reads == 0 &&
        every != null &&
        (readAt == null || clock.now().difference(readAt) >= every)) {
      _read();
    }
  }

  @override
  void didUpdateWidget(SwarmIssuePanel old) {
    super.didUpdateWidget(old);
    if (old.number != widget.number || old.repository != widget.repository) {
      _thread = null;
      _pull = null;
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
    _pull = _pullOf();
    _read();
  }

  /// Takes the newest comments a read brought. Those held before them stay while the newest window starts at one of the
  /// held (the comments are then one run, and the cursor before the first held still points before it). Past that (more than
  /// a window of comments came since the last read) what was held does not join the window, so the window stands alone with
  /// its own cursor: a gap would read as a thread with nothing missing.
  void _take(SwarmIssueThread thread) {
    _thread = thread;
    final window = thread.comments;
    final joins = window.isEmpty
        ? -1
        : _comments.indexWhere((c) => _key(c) == _key(window.first));
    if (joins >= 0) {
      _comments = [..._comments.take(joins), ...window];
    } else {
      _comments = window;
      _earlier = thread.earlier;
    }
  }

  /// The open pull request shown under the title, as last read: a task's, or a pull request's own.
  SwarmPull? _pullOf() => widget.pull
      ? widget.github
            .keptPullList(widget.repository)
            ?.where((p) => p.number == widget.number)
            .firstOrNull
      : widget.github.keptPulls(widget.repository)?[widget.number];

  static String _key(SwarmIssueComment c) =>
      c.url ?? '${c.createdAt?.toIso8601String()}${c.author}${c.body.hashCode}';

  Future<void> _read() async {
    _reads++;
    _readAt = clock.now();
    try {
      await _readThread();
    } finally {
      _reads--;
    }
  }

  Future<void> _readThread() async {
    final (repository, number) = (widget.repository, widget.number);
    try {
      final thread = await widget.github.thread(
        repository,
        number,
        pull: widget.pull,
      );
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
      return;
    }
    // Its pull request after its thread; a read of it that fails keeps the last one shown.
    try {
      await widget.github.pulls(
        repository,
        team: SwarmPull.teamOf(widget.controller.snapshot, repository),
      );
      if (mounted &&
          repository == widget.repository &&
          number == widget.number) {
        setState(() => _pull = _pullOf());
      }
    } on SwarmGitHubError catch (error) {
      appLog.warn(
        'super-tabs',
        'GitHub pull requests not read: ${error.message}',
      );
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
      final page = await widget.github.earlier(
        repository,
        number,
        cursor,
        pull: widget.pull,
      );
      // A newer read that did not join the held comments moved the cursor: this page is of a range no longer held.
      if (!mounted ||
          repository != widget.repository ||
          number != widget.number ||
          cursor != _earlier)
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
        'https://github.com/${widget.repository}/${widget.pull ? 'pull' : 'issues'}/${widget.number}';
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
              borderRadius: BorderRadius.circular(SwarmLayout.cardRadius),
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

  /// The task's pull request: where it stands, its title and its branch, and Open, which goes to it on GitHub. A tap on it
  /// opens its own chat in the task's place.
  Widget _pullRow(SwarmPull pull) => Material(
    color: grid.AppPalette.cardBg,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(SwarmLayout.cardRadius),
      side: BorderSide(color: DesktopChrome.rim),
    ),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      key: const ValueKey('swarm-issue-pull'),
      onTap: widget.onOpenPull == null
          ? null
          : () => widget.onOpenPull!(pull.number),
      child: Padding(
        padding: SwarmLayout.cardPadding,
        child: Row(
          children: [
            SwarmPullChip(pull: pull),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '${pull.title} · ${pull.branch}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata(),
              ),
            ),
            TextButton(
              key: const ValueKey('swarm-issue-pull-open'),
              onPressed: () => widget.openUrl(pull.url),
              child: const Text('Open'),
            ),
          ],
        ),
      ),
    ),
  );

  Widget _body(BuildContext context) {
    final thread = _thread;
    final error = _error;
    if (thread == null && error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: grid.AppDesktop.panelPadding,
              ),
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
    // Kept laid out off screen, as every Swarm list, so a hovered row never breaks hit testing (laid_out_list.dart).
    return LaidOutListView(
      key: const ValueKey('swarm-issue-thread'),
      padding: const EdgeInsets.fromLTRB(
        SuperTabMessageRow.horizontalInset,
        grid.AppDesktop.groupGap,
        SuperTabMessageRow.horizontalInset,
        grid.AppDesktop.groupGap,
      ),
      children: [
        Text(
          issue.title,
          key: const ValueKey('swarm-issue-title'),
          style: SwarmType.body(context).copyWith(
            fontWeight: FontWeight.w600,
            fontSize: SwarmLayout.titleSize,
          ),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            if (agent != null) ...[
              swarmAgentFace(widget.controller, agent),
              const SizedBox(width: 6),
              // The agent's own name, not its label's: "First builder", not first-builder.
              Text(switch (swarmAgentNamed(widget.controller, agent)) {
                final named? => named.displayName ?? named.name,
                null => agent,
              }, style: DesktopChrome.metadata()),
              Text(' · ', style: DesktopChrome.metadata()),
            ],
            if (widget.pull) ...[
              if (thread.branch case final branch?)
                Flexible(
                  child: Text(
                    '$branch · ',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(),
                  ),
                ),
              if (thread.open && _pull != null)
                SwarmPullChip(pull: _pull!)
              else
                Text(
                  thread.mergedAt != null
                      ? 'Merged'
                      : thread.open
                      ? 'Open'
                      : 'Closed',
                  style: DesktopChrome.metadata(),
                ),
            ] else
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
                      swarmOpened(at, widget.now()),
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
        if (_pull case final pull? when !widget.pull) ...[
          const SizedBox(height: 12),
          _pullRow(pull),
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
                  _earlierText(max(0, issue.comments - _comments.length)),
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
        for (final post in _talk(thread)) ...[
          const SizedBox(height: 18),
          if (post.talk == SwarmTalk.merged)
            _merged(post)
          else
            _post(context, post, agents),
        ],
      ],
    );
  }

  /// Its comments held, and a pull request's reviews, line comments and merge among them by time.
  List<SwarmIssueComment> _talk(SwarmIssueThread thread) {
    if (thread.reviews.isEmpty) return _comments;
    final epoch = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
    // Stable, so posts of one second keep the order they were read in.
    final talk = [..._comments, ...thread.reviews];
    mergeSort(
      talk,
      compare: (a, b) => (a.createdAt ?? epoch).compareTo(b.createdAt ?? epoch),
    );
    return talk;
  }

  /// When a pull request merged: one quiet centred line, as a chat's day line reads.
  Widget _merged(SwarmIssueComment merge) => Center(
    child: Text(
      [
        'Merged',
        if (merge.createdAt case final at?) _when(at, widget.now()),
      ].join(' · '),
      key: const ValueKey('swarm-issue-merged'),
      style: DesktopChrome.metadata(),
    ),
  );

  /// One post: the face and name it is signed with (else its GitHub login), its login, a review's verdict or a line comment's
  /// place, and its time, then its text.
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
                        if (post.talk == SwarmTalk.review)
                          switch (post.verdict) {
                            'APPROVED' => 'Approved',
                            'CHANGES_REQUESTED' => 'Changes requested',
                            _ => 'Review',
                          },
                        if (post.path case final path?)
                          post.line == null ? path : '$path, line ${post.line}',
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
