import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../widgets/desktop_chrome.dart';
import 'chat/bubble.dart';
import 'chat/chat_card.dart';
import 'chat/chat_link.dart';
import 'message_row.dart';
import 'message_text.dart';
import 'model.dart';
import 'swarm_type.dart';

/// What GitHub said to a person's agent, in their chat with it (Swarm v4, anh Dee 2026-11-09): a comment, review or line
/// comment that names the agent or is on its own task or pull request, or a task newly labelled for it. Their Harness read
/// it with their own gh and relayed it (backend githubRelay.ts); the agent hears it as any message there. It is GitHub's
/// words, not the person's, so it is a card on the left: where it was and who wrote it, its first line, and Read for the
/// rest and the way to it on GitHub.
///
/// The same card, by an agent, is what a project's agents did on GitHub, in the project's channel ([SwarmChannelFeed]): there
/// it stands with the face and name of the agent, and what it is on is the card's label, not who wrote it (every agent of a
/// person writes under their one login). A tap on one that is on a task opens it ([onOpen]).
class SuperTabGitHubRow extends StatelessWidget {
  const SuperTabGitHubRow({
    super.key,
    required this.message,
    this.openUrl = _openUrl,
    this.agent,
    this.author,
    this.onOpen,
  });

  final SuperTabMessage message;
  final void Function(String url) openUrl;

  /// The agent a card in a channel is by, for its face; [author] is the name it shows under.
  final SuperTabAgent? agent;
  final String? author;

  /// Opens the task the card is on beside the channel; null for a card that opens nothing.
  final VoidCallback? onOpen;

  static void _openUrl(String url) => unawaited(
    launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
  );

  static bool shows(SuperTabMessage message) =>
      message.source['kind'] == 'github';

  String get _event => message.source['event'] as String? ?? 'comment';
  bool get _pull => message.source['on'] == 'pull';
  int? get _number => message.source['number'] as int?;
  String get _url => message.source['url'] as String? ?? '';
  String get _login => message.source['login'] as String? ?? '';

  /// Where it was and who wrote it: PR #4 · deehw, Issue #12 · deehw, Review · PR #4 · deehw, Line · PR #4 · deehw, and
  /// New task · #13 for a task. By an agent in the channel it says where alone, and what happened to a pull request: Opened ·
  /// PR #4, Merged · PR #4.
  String get label {
    final number = _number == null ? '' : '#$_number';
    final where = _pull ? 'PR $number' : 'Issue $number';
    final by = message.fromAgent ? '' : ' · $_login';
    return switch (_event) {
      'task' => 'New task · $number',
      'opened' => 'Opened · $where',
      'merged' => 'Merged · $where',
      'review' => 'Review · $where$by',
      'review-comment' => 'Line · $where$by',
      _ => '$where$by',
    };
  }

  /// The words GitHub said: the row's text between its first line (where it was) and its last (the link). A task's are its
  /// issue's title, on the first line after its number.
  String get words {
    final lines = message.text.split('\n');
    if (lines.isNotEmpty && lines.last.trim() == _url) lines.removeLast();
    if (_event == 'task') {
      final head = lines.isEmpty ? '' : lines.first;
      final at = _number == null ? -1 : head.indexOf('#$_number ');
      return at < 0 ? head : head.substring(at + '#$_number '.length).trim();
    }
    return lines.skip(1).join('\n').trim();
  }

  /// One plain line for the card's title: a review's verdict, else the words' first line without Markdown's marks.
  String get title {
    if (_event == 'review') {
      return switch (message.source['verdict']) {
        'APPROVED' => 'Approved',
        'CHANGES_REQUESTED' => 'Changes requested',
        _ => 'Commented',
      };
    }
    final first = words
        .split('\n')
        .map((line) => line.trim())
        .firstWhere((line) => line.isNotEmpty, orElse: () => '');
    return first.replaceAll(RegExp(r'[*_`]'), '');
  }

  @override
  Widget build(BuildContext context) {
    final path = message.source['path'] as String?;
    final line = message.source['line'] as int?;
    final named = message.fromAgent;
    Widget card(double room) {
      final card = SwarmChatCard(
        icon: _pull ? AppIcons.gitPullRequest : AppIcons.circleDot,
        label: label,
        title: title,
        action: 'Read',
        details: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (path != null)
              Padding(
                padding: const EdgeInsets.only(
                  bottom: SwarmLayout.chatCardLineGap,
                ),
                child: Text(
                  line == null ? path : '$path, line $line',
                  style: DesktopChrome.metadata(),
                ),
              ),
            if (words.isNotEmpty) SuperTabMessageText(words),
            if (_url.startsWith('https://github.com/')) ...[
              const SizedBox(height: SwarmLayout.chatCardLineGap),
              SwarmChatLink(
                key: const ValueKey('swarm-github-open'),
                label: 'Open in GitHub',
                onPressed: () => openUrl(_url),
              ),
            ],
          ],
        ),
      );
      return ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: room * SuperTabMessageRow.bubbleShare,
        ),
        child: onOpen == null
            ? card
            : InkWell(
                key: const ValueKey('swarm-github-card-open'),
                onTap: onOpen,
                borderRadius: const BorderRadius.all(SwarmBubble.radius),
                child: card,
              ),
      );
    }

    if (!named) {
      return Padding(
        key: const ValueKey('swarm-github-row'),
        padding: const EdgeInsets.fromLTRB(
          SuperTabMessageRow.bodyInset,
          SwarmLayout.chatCardTop,
          SuperTabMessageRow.horizontalInset,
          0,
        ),
        child: Align(
          alignment: Alignment.centerLeft,
          child: LayoutBuilder(builder: (context, room) => card(room.maxWidth)),
        ),
      );
    }
    // By an agent, in the channel: its face by the card and its name over it, as a post of its draws them.
    final name = author ?? message.authorName;
    return Padding(
      key: const ValueKey('swarm-github-row'),
      padding: const EdgeInsets.fromLTRB(
        SuperTabMessageRow.horizontalInset,
        grid.AppDesktop.groupGap,
        SuperTabMessageRow.horizontalInset,
        0,
      ),
      child: LayoutBuilder(
        builder: (context, room) => Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            SizedBox(
              width: SuperTabMessageRow.avatarSize,
              child: ExcludeSemantics(
                child: superTabMessageAvatar(
                  message,
                  author: name,
                  agent: agent,
                ),
              ),
            ),
            const SizedBox(width: SuperTabMessageRow.avatarGap),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: grid.AppDesktop.bubbleNamePadding,
                    child: Text(
                      name,
                      style: DesktopChrome.text(
                        size: SwarmType.nameSize,
                        height: SwarmType.bodyLine / SwarmType.nameSize,
                        color: DesktopChrome.muted,
                      ),
                    ),
                  ),
                  card(room.maxWidth),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
