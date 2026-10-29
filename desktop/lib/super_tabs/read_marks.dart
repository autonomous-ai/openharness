/// Sends the reader's read marks to the server (backend `superTabs/readMarks.ts`), so a conversation read on this
/// device reads as read on every other one. One request per conversation at a time: a higher mark asked for while
/// one is on its way goes after it, and a lower or equal one is never sent. A failed send is forgotten, so the next
/// mark asked for tries again; meanwhile this device's own mark keeps the conversation read here.
class SuperTabReadMarkSender {
  SuperTabReadMarkSender(this._send);

  /// Writes [sequence] as the mark of [conversationId]; completes once the server kept it, or throws.
  final Future<void> Function(String conversationId, int sequence) _send;

  /// The highest mark sent and kept, by conversation.
  final _sent = <String, int>{};

  /// The mark waiting for the one on its way, by conversation.
  final _next = <String, int>{};
  final _sending = <String>{};
  bool _disposed = false;

  /// Asks for [sequence] to be [conversationId]'s mark on the server, unless [kept] (what the server already
  /// holds) or a mark sent from here is as high.
  void mark(String conversationId, int sequence, {int kept = 0}) {
    if (_disposed || sequence <= kept) return;
    if (sequence <= (_sent[conversationId] ?? 0)) return;
    if (sequence <= (_next[conversationId] ?? 0)) return;
    _next[conversationId] = sequence;
    if (_sending.add(conversationId)) _drain(conversationId);
  }

  Future<void> _drain(String conversationId) async {
    while (!_disposed) {
      final sequence = _next.remove(conversationId);
      if (sequence == null) break;
      try {
        await _send(conversationId, sequence);
        if (sequence > (_sent[conversationId] ?? 0)) {
          _sent[conversationId] = sequence;
        }
      } catch (_) {
        // Offline or refused: this device's mark stands, and the next one asked for is sent afresh.
      }
    }
    _sending.remove(conversationId);
  }

  void dispose() => _disposed = true;
}
