/// A hands-on request (collaboration protocol): physical steps, a sign-in or
/// an approval only the reader can do, and what the agent does next
/// (backend superTabs/decisions.ts, kind 'handsOn').
class SuperTabHandsOn {
  SuperTabHandsOn.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      projectId = row['projectId'] as String? ?? '',
      projectName = row['projectName'] as String? ?? '',
      conversationId = row['conversationId'] as String,
      conversationTitle = row['conversationTitle'] as String? ?? '',
      askerName = row['askerName'] as String? ?? 'Agent',
      request = row['request'] as String? ?? '',
      steps = List.unmodifiable([
        for (final step in row['steps'] as List? ?? const []) '$step',
      ]),
      next = row['next'] as String? ?? '',
      answer = SuperTabHandsOnAnswer.of(row['answer']),
      note = row['note'] as String?,
      until = DateTime.tryParse(row['until'] as String? ?? ''),
      remindedAt = DateTime.tryParse(row['remindedAt'] as String? ?? '');
  final String id, projectId, projectName, conversationId, conversationTitle;
  final String askerName, request, next;
  final List<String> steps;

  /// The reader's answer; null while the request is open.
  final SuperTabHandsOnAnswer? answer;
  final String? note;

  /// Until when the reader can't, with a "can't now" answer.
  final DateTime? until;

  /// When the backend reminded the reader of it; null until it did.
  final DateTime? remindedAt;
}

/// The three answers to a hands-on request, by their backend names.
enum SuperTabHandsOnAnswer {
  done('Done'),
  cant("Can't now"),
  note('Note');

  const SuperTabHandsOnAnswer(this.label);
  final String label;

  static SuperTabHandsOnAnswer? of(Object? name) =>
      values.where((a) => a.name == name).firstOrNull;
}
