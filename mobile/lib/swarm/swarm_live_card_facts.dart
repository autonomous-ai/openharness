import 'package:flutter/foundation.dart';

import 'model.dart';
import 'review_verdict.dart';

/// A task's state in a few words, from its assignment's status: the desktop's
/// `superTabCardStatus` (live_card.dart), word for word.
String swarmCardStatus(Map<String, dynamic>? assignment) =>
    switch (assignment?['status']) {
      'planned' => 'Planned',
      'working' => 'Working',
      'needs_human' => 'Waiting on a person',
      'blocked' => 'Blocked',
      'review' => 'In review',
      'done' => 'Done',
      'stopped' || 'lost' => 'Stopped',
      'cancelled' => 'Cancelled',
      'reconciling' => 'Checking its agent',
      _ => 'Not started',
    };

/// "Reviewer: Ivy · Ready: no on 050bab807", as the desktop's
/// `SuperTabController.reviewLine` reads it: the newest review chat's recorded
/// verdict for [group] (its result or check evidence), else the newest
/// `Ready:` line a reviewer posted in [messages]. Only review chats of
/// [group]'s own project count. Null without a reviewer.
String? swarmReviewLine(
  SuperTabSnapshot snapshot,
  SuperTabConversation group,
  List<SuperTabMessage> messages,
) {
  final reviews =
      snapshot.conversations
          .where(
            (c) => c.reviewOf == group.id && c.projectId == group.projectId,
          )
          .toList()
        ..sort((a, b) => (b.number ?? 0).compareTo(a.number ?? 0));
  final reviewers = {
    for (final r in [
      ...snapshot.reviewers(group),
      for (final review in reviews) ...snapshot.reviewers(review),
    ])
      r.id: r,
  }.values;
  if (reviewers.isEmpty) return null;
  final ids = {for (final r in reviewers) r.id};
  final recorded = reviews
      .expand(
        (review) => [
          review.assignment?['result'],
          for (final check in review.checks) check['evidence'],
        ],
      )
      .whereType<String>();
  final posted = messages.reversed
      .where((m) => m.fromAgent && ids.contains(m.authorId))
      .map((m) => m.text);
  final verdict = [
    ...recorded,
    ...posted,
  ].map(parseSuperTabVerdict).nonNulls.firstOrNull;
  final names = reviewers.map((r) => snapshot.agentName(r.id)).join(', ');
  return 'Reviewer: $names · ${verdict?.label ?? 'No verdict yet'}';
}

/// One pull request on a card: its link and whether the Swarm recorded its
/// merge.
typedef SwarmCardPull = ({Uri url, bool merged});

/// What a live card shows (backend superTabs/cards.ts): the Swarm's own facts
/// of its group, which only a reader of the group has. The phone reads no
/// GitHub (Lead, 10-29), so no title or CI of a PR. Equal facts draw the
/// same card: the chat keeps the row as it was.
@immutable
class SwarmCardFacts {
  const SwarmCardFacts({
    required this.task,
    required this.pulls,
    required this.review,
  });

  /// The task's title and its state line, for a task card.
  final ({String title, String line})? task;
  final List<SwarmCardPull> pulls;
  final String? review;

  /// The card message [messageId] is in [group], or null for a plain message.
  /// A task card lists every PR its group linked; a PR card its own.
  static SwarmCardFacts? of(
    SuperTabSnapshot snapshot,
    SuperTabConversation group,
    String messageId,
    List<SuperTabMessage> messages,
  ) {
    final card = group.cards.of(messageId);
    if (card == null) return null;
    final merged = {
      for (final c in group.cards.pullRequests)
        if (c.merged) c.url,
    };
    final urls = card.task
        ? group.pullRequestUrls
        : [for (final c in card.pullRequests) c.url];
    final checks = group.checks;
    final passed = checks.where((c) => c['evidence'] != null).length;
    return SwarmCardFacts(
      task: card.task
          ? (
              title: group.label,
              line: [
                swarmCardStatus(group.assignment),
                if (checks.isNotEmpty)
                  '$passed of ${checks.length} checks passed',
              ].join(' · '),
            )
          : null,
      pulls: [
        for (final url in urls)
          if (Uri.tryParse(url) case final uri?
              when uri.pathSegments.length == 4)
            (url: uri, merged: merged.contains(url)),
      ],
      review: swarmReviewLine(snapshot, group, messages),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is SwarmCardFacts &&
      other.task == task &&
      other.review == review &&
      listEquals(other.pulls, pulls);

  @override
  int get hashCode => Object.hash(task, review, Object.hashAll(pulls));
}
