import 'package:flutter/foundation.dart';

import 'model.dart';
import 'linked_tasks.dart';

/// A task's state in a few words, from its assignment's status: the desktop's
/// `superTabCardStatus` (live_card.dart), word for word.
String swarmCardStatus(Map<String, dynamic>? assignment) =>
    switch (assignment?['status']) {
      'planned' => 'Planned',
      'working' => 'Working',
      'needs_human' => 'Waiting on a person',
      'blocked' => 'Blocked',
      'review' => 'Waiting on others',
      'done' => 'Done',
      'stopped' || 'lost' => 'Stopped',
      'cancelled' => 'Cancelled',
      'reconciling' => 'Checking its agent',
      _ => 'Not started',
    };

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

  /// The group's linked tasks with their checks' results
  /// ([superTabLinkedLine]); null without any.
  final String? review;

  /// The card message [messageId] is in [group], or null for a plain message.
  /// A task card lists every PR its group linked; a PR card its own.
  static SwarmCardFacts? of(
    SuperTabSnapshot snapshot,
    SuperTabConversation group,
    String messageId,
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
    // A failed check keeps its evidence; only a pass names who passed it
    // (backend commands.ts `work.check`).
    final passed = checks.where((c) => c['passedBy'] != null).length;
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
      review: superTabLinkedLine(snapshot, group),
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
