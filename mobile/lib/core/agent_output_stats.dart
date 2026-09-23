/// What a harness has produced, as its machine measured it — the desktop's `AgentOutputStats`.
///
/// Only counts confirmed by the harness's own tool receipts: lines its edits added and removed
/// (repeated edits included, so not the branch diff) and pull requests it created. Each half of the
/// edit pair is dropped without the other, so a row never shows `+12` with nothing beside it.
class AgentOutputStats {
  const AgentOutputStats({
    this.linesAdded,
    this.linesRemoved,
    this.pullRequestsCreated,
    this.updatedAt,
  });

  final int? linesAdded, linesRemoved, pullRequestsCreated;
  final DateTime? updatedAt;

  bool get hasEdits => linesAdded != null && linesRemoved != null;
  bool get isEmpty => !hasEdits && pullRequestsCreated == null;

  /// Null for anything that carries nothing worth drawing — an older daemon, or a harness that has
  /// not edited or opened anything yet.
  static AgentOutputStats? fromJson(Object? value) {
    if (value is! Map) return null;
    final added = wireCount(value['linesAdded']);
    final removed = wireCount(value['linesRemoved']);
    final stats = AgentOutputStats(
      linesAdded: removed == null ? null : added,
      linesRemoved: added == null ? null : removed,
      pullRequestsCreated: wireCount(value['pullRequestsCreated']),
      updatedAt: value['updatedAt'] is String
          ? DateTime.tryParse(value['updatedAt'] as String)
          : null,
    );
    return stats.isEmpty ? null : stats;
  }

  @override
  bool operator ==(Object other) =>
      other is AgentOutputStats &&
      linesAdded == other.linesAdded &&
      linesRemoved == other.linesRemoved &&
      pullRequestsCreated == other.pullRequestsCreated &&
      updatedAt == other.updatedAt;

  @override
  int get hashCode =>
      Object.hash(linesAdded, linesRemoved, pullRequestsCreated, updatedAt);
}

/// A count off the wire, or null for anything that is not a JavaScript-safe non-negative integer.
int? wireCount(Object? n) =>
    n is int && n >= 0 && n <= 9007199254740991 ? n : null;

/// `4.5M`, `12.3k`, `980` — the desktop's `formatTokens`, used for every count a row draws.
String formatCount(int count) {
  if (count >= 1000000000) return '${(count / 1000000000).toStringAsFixed(1)}B';
  if (count >= 1000000) return '${(count / 1000000).toStringAsFixed(1)}M';
  if (count >= 1000) return '${(count / 1000).toStringAsFixed(1)}k';
  return '$count';
}
