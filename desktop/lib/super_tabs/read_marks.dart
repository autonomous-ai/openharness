/// Sends the reader's read marks to the server (backend `superTabs/readMarks.ts`), so a conversation, or a thread
/// ([K] names which), read on this device reads as read on every other one. One request per conversation or thread
/// at a time: a higher mark asked for while one is on its way goes after it, and a lower or equal one is never sent.
/// A failed send is forgotten, so the next mark asked for tries again; meanwhile this device's own mark keeps it
/// read here.
class SuperTabReadMarkSender<K> {
  /// With [retryAfter], a mark whose send failed is not sent again for that long, unless a higher one is asked for:
  /// a thread asks for its mark on every read while it is open, and a server without thread marks refuses each.
  SuperTabReadMarkSender(
    this._send, {
    this.retryAfter = Duration.zero,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final Duration retryAfter;
  final DateTime Function() _now;

  /// The last mark that failed, and when, by conversation.
  final _failed = <K, (int, DateTime)>{};

  /// Writes [sequence] as the mark of [conversationId]; completes once the server kept it, or throws.
  final Future<void> Function(K conversationId, int sequence) _send;

  /// The highest mark sent and kept, by conversation.
  final _sent = <K, int>{};

  /// The mark waiting for the one on its way, by conversation.
  final _next = <K, int>{};
  final _sending = <K>{};

  /// The mark on its way, by conversation: one asked for again meanwhile is not sent twice.
  final _inFlight = <K, int>{};
  bool _disposed = false;

  /// Asks for [sequence] to be [conversationId]'s mark on the server, unless [kept] (what the server already
  /// holds) or a mark sent from here is as high.
  void mark(K conversationId, int sequence, {int kept = 0}) {
    if (_disposed || sequence <= kept) return;
    if (sequence <= (_sent[conversationId] ?? 0)) return;
    if (sequence <= (_next[conversationId] ?? 0)) return;
    if (sequence <= (_inFlight[conversationId] ?? 0)) return;
    if (_failed[conversationId] case (final failed, final at)
        when sequence <= failed && _now().difference(at) < retryAfter) {
      return;
    }
    _next[conversationId] = sequence;
    if (_sending.add(conversationId)) _drain(conversationId);
  }

  Future<void> _drain(K conversationId) async {
    while (!_disposed) {
      final sequence = _next.remove(conversationId);
      if (sequence == null) break;
      _inFlight[conversationId] = sequence;
      try {
        await _send(conversationId, sequence);
        _failed.remove(conversationId);
        if (sequence > (_sent[conversationId] ?? 0)) {
          _sent[conversationId] = sequence;
        }
      } catch (_) {
        _failed[conversationId] = (sequence, _now());
        // Offline or refused: this device's mark stands, and the next one asked for is sent afresh.
      }
    }
    _inFlight.remove(conversationId);
    _sending.remove(conversationId);
  }

  void dispose() => _disposed = true;
}
