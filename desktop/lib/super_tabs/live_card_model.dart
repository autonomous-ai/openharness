/// One linked pull request's card: the message that is it, and whether the
/// Swarm recorded its merge (backend superTabs/cards.ts).
class SuperTabPullRequestCard {
  const SuperTabPullRequestCard(
    this.url,
    this.messageId, {
    this.merged = false,
  });
  final String url, messageId;
  final bool merged;
}

/// What one message is a card of: its group's task, its pull requests, or both.
typedef SuperTabCard = ({
  bool task,
  List<SuperTabPullRequestCard> pullRequests,
});

/// The messages a group shows as live cards (Slack parity): its task card and
/// one card per linked pull request. Each updates in place from the group
/// state the Swarm already sends, so only a reader of the group sees one.
class SuperTabCards {
  const SuperTabCards._(this.task, this.pullRequests);

  factory SuperTabCards.fromJson(Object? row) {
    if (row is! Map) return const SuperTabCards._(null, []);
    return SuperTabCards._(
      row['task'] is String ? row['task'] as String : null,
      [
        for (final card in row['pullRequests'] as List? ?? const [])
          if (card is Map &&
              card['messageId'] is String &&
              card['url'] is String &&
              _pullRequest(card['url'] as String))
            SuperTabPullRequestCard(
              card['url'] as String,
              card['messageId'] as String,
              merged: card['mergedAt'] is num,
            ),
      ],
    );
  }

  final String? task;
  final List<SuperTabPullRequestCard> pullRequests;

  /// The server binds only GitHub pull request links; anything else is not a
  /// card this app can draw.
  static bool _pullRequest(String url) {
    final uri = Uri.tryParse(url);
    return uri != null &&
        uri.scheme == 'https' &&
        uri.host == 'github.com' &&
        uri.pathSegments.length == 4 &&
        uri.pathSegments[2] == 'pull';
  }

  /// The card [messageId] is, or null for a plain message.
  SuperTabCard? of(String messageId) {
    final linked = [
      for (final card in pullRequests)
        if (card.messageId == messageId) card,
    ];
    if (task != messageId && linked.isEmpty) return null;
    return (task: task == messageId, pullRequests: linked);
  }
}
