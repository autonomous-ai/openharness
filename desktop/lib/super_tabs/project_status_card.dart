import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'decisions.dart';
import 'message_text.dart';
import 'model.dart';

/// The status card at the top of a project's chat (Dee, 2026-10-31): what the
/// coordinator last reported, replaced in place by each report instead of a
/// post, and the decisions in this project waiting on the reader, each with
/// Answer. Hidden while there is neither; folded to its heading line by the
/// reader, remembered on this computer ([SuperTabController.statusFolded]).
///
/// It reads nothing of its own: the text comes with the Swarm read, the
/// decisions are the reader's own list ([SuperTabDecisions]).
class SuperTabProjectStatusCard extends StatelessWidget {
  const SuperTabProjectStatusCard({
    super.key,
    required this.controller,
    required this.projectId,
    this.now = DateTime.now,
  });

  final SuperTabController controller;
  final String projectId;
  final DateTime Function() now;

  /// The decisions [decisions] holds that wait on the reader in [projectId]:
  /// each asked in a conversation of that project the reader still reads, so
  /// one from another project, or whose conversation they lost, never shows.
  static List<SuperTabDecision> needsYou(
    SuperTabController c,
    SuperTabDecisions decisions,
    String projectId,
  ) {
    final snapshot = c.snapshot;
    if (snapshot == null || c.accessRevoked) return const [];
    return [
      for (final d in decisions.open)
        if (d.projectId == projectId &&
            snapshot.conversation(d.conversationId)?.projectId == projectId)
          d,
    ];
  }

  /// "16:52" today, "Oct 30, 16:52" before, in this computer's time.
  static String updatedAt(DateTime at, DateTime now) {
    final local = at.toLocal(), today = now.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    final clock = '${two(local.hour)}:${two(local.minute)}';
    if (local.year == today.year &&
        local.month == today.month &&
        local.day == today.day) {
      return clock;
    }
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', //
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    final year = local.year == today.year ? '' : ' ${local.year}';
    return '${months[local.month - 1]} ${local.day}$year, $clock';
  }

  @override
  Widget build(BuildContext context) {
    final decisions = SuperTabDecisions.of(controller);
    return ListenableBuilder(
      listenable: Listenable.merge([controller, decisions]),
      builder: (context, _) {
        grid.AppTheme.watch(context);
        final c = controller;
        final project = c.accessRevoked
            ? null
            : c.snapshot?.projectById(projectId);
        if (project == null) return const SizedBox.shrink();
        final status = project.status;
        final waiting = needsYou(c, decisions, projectId);
        if (status == null && waiting.isEmpty) return const SizedBox.shrink();
        final folded = c.statusFolded(projectId);
        return Padding(
          padding: const EdgeInsets.fromLTRB(
            grid.AppDesktop.panelPadding,
            grid.AppDesktop.controlGap,
            grid.AppDesktop.panelPadding,
            grid.AppDesktop.controlGap,
          ),
          child: Semantics(
            container: true,
            label: 'Project status',
            child: DecoratedBox(
              key: ValueKey('super-project-status-$projectId'),
              decoration: BoxDecoration(
                color: DesktopChrome.surface,
                border: Border.all(color: DesktopChrome.rim),
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
              ),
              child: Padding(
                padding: EdgeInsets.fromLTRB(
                  grid.AppDesktop.groupGap,
                  grid.AppDesktop.listRowGap,
                  grid.AppDesktop.controlGap,
                  folded
                      ? grid.AppDesktop.listRowGap
                      : grid.AppDesktop.groupGap,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _heading(status, waiting.length, folded),
                    if (!folded)
                      // A long report scrolls inside the card, so the chat
                      // keeps its room.
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxHeight: 240),
                        child: SingleChildScrollView(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              if (status != null) _StatusText(status.text),
                              for (final (i, d) in waiting.indexed)
                                _NeedsYouRow(
                                  decision: d,
                                  first: i == 0,
                                  reader: c.snapshot?.people
                                      .where((p) => p.id == c.accountId)
                                      .firstOrNull
                                      ?.username,
                                  onAnswer: () =>
                                      c.openNotice('decision', d.id),
                                ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _heading(SuperTabProjectStatus? status, int waiting, bool folded) {
    final at = status?.at;
    return Row(
      children: [
        Expanded(
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: 'Status',
                  style: DesktopChrome.control(medium: true),
                ),
                if (at != null)
                  TextSpan(
                    text: ' · updated ${updatedAt(at, now())}',
                    style: DesktopChrome.metadata(),
                  ),
                // Folded, the heading still says something waits.
                if (folded && waiting > 0)
                  TextSpan(
                    text: ' · $waiting ${waiting == 1 ? 'needs' : 'need'} you',
                    style: DesktopChrome.metadata(color: DesktopChrome.accent),
                  ),
              ],
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        AppIconButton(
          key: ValueKey('super-project-status-fold-$projectId'),
          tooltip: folded ? 'Show status' : 'Fold status',
          icon: folded ? AppIcons.chevronDown : AppIcons.chevronUp,
          onPressed: () =>
              controller.setStatusFolded(projectId, folded: !folded),
        ),
      ],
    );
  }
}

/// The report as the coordinator wrote it, line for line, with its web links
/// clickable. Not Markdown: the card is a glance, not a message.
class _StatusText extends StatefulWidget {
  const _StatusText(this.text);
  final String text;

  @override
  State<_StatusText> createState() => _StatusTextState();
}

class _StatusTextState extends State<_StatusText> {
  static final _link = RegExp(r'https?://[^\s<>()\[\]]+');

  /// The text cut into plain pieces and links, with one tap per link: made
  /// again only when the text changes, so a rebuild (a theme flip, a Swarm
  /// read) never drops a tap under the pointer.
  var _pieces = <(String, TapGestureRecognizer?)>[];

  @override
  void initState() {
    super.initState();
    _cut();
  }

  @override
  void didUpdateWidget(_StatusText old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text) _cut();
  }

  @override
  void dispose() {
    _release();
    super.dispose();
  }

  void _release() {
    for (final (_, tap) in _pieces) {
      tap?.dispose();
    }
  }

  void _cut() {
    _release();
    final text = widget.text.trimRight();
    final pieces = <(String, TapGestureRecognizer?)>[];
    var at = 0;
    for (final match in _link.allMatches(text)) {
      // A sentence's closing punctuation is not part of its link.
      var url = match[0]!;
      while (url.isNotEmpty && '.,;:!?\'"'.contains(url[url.length - 1])) {
        url = url.substring(0, url.length - 1);
      }
      final uri = SuperTabMessageText.webLink(url);
      if (uri == null) continue;
      if (match.start > at) pieces.add((text.substring(at, match.start), null));
      pieces.add((
        url,
        TapGestureRecognizer()..onTap = () => openInBrowser(uri),
      ));
      at = match.start + url.length;
    }
    if (at < text.length) pieces.add((text.substring(at), null));
    _pieces = pieces;
  }

  @override
  Widget build(BuildContext context) {
    final link = TextStyle(
      color: DesktopChrome.accent,
      decoration: TextDecoration.underline,
      decorationColor: DesktopChrome.accent,
    );
    return Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.listRowGap),
      child: Text.rich(
        key: const ValueKey('super-project-status-text'),
        TextSpan(
          style: DesktopChrome.text(),
          children: [
            for (final (text, tap) in _pieces)
              tap == null
                  ? TextSpan(text: text)
                  : TextSpan(
                      text: text,
                      style: link,
                      recognizer: tap,
                      mouseCursor: SystemMouseCursors.click,
                    ),
          ],
        ),
      ),
    );
  }
}

/// One decision waiting on the reader: who it waits on, the question, and
/// Answer, which opens it where Notifications answers it.
class _NeedsYouRow extends StatelessWidget {
  const _NeedsYouRow({
    required this.decision,
    required this.first,
    required this.reader,
    required this.onAnswer,
  });

  final SuperTabDecision decision;

  /// The first row carries the "Needs you" label; the rest line up under it.
  final bool first;
  final String? reader;
  final VoidCallback onAnswer;

  static const _labelWidth = 88.0;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: grid.AppDesktop.controlGap),
    child: Row(
      key: ValueKey('super-project-status-needs-${decision.id}'),
      children: [
        SizedBox(
          width: _labelWidth,
          child: first
              ? Text(
                  'Needs you',
                  style: DesktopChrome.metadata(color: DesktopChrome.accent)
                      .copyWith(fontWeight: grid.AppFont.semibold),
                )
              : null,
        ),
        Expanded(
          child: Text(
            reader == null
                ? decision.question
                : '$reader: ${decision.question}',
            style: DesktopChrome.text(),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: grid.AppDesktop.controlGap),
        OutlinedButton(
          key: ValueKey('super-project-status-answer-${decision.id}'),
          onPressed: onAnswer,
          child: const Text('Answer'),
        ),
      ],
    ),
  );
}
