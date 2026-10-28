import 'package:clock/clock.dart';

/// The stand-up and recap cards dismissed from the top of a chat on this
/// computer today (review of #1763). Kept with the tab's other local state, so
/// a restart leaves them dismissed; a day's dismissals are dropped the next
/// day, whose cards (ids of their own) are pinned until dismissed in turn.
class SuperTabDismissedCards {
  SuperTabDismissedCards.restore(Object? saved) {
    if (saved is! Map || saved['on'] != _on) return;
    _ids.addAll((saved['ids'] as List? ?? const []).whereType<String>());
  }

  String _on = _today();
  final _ids = <String>{};

  bool contains(String messageId) => _ids.contains(messageId);

  void add(String messageId) {
    final today = _today();
    if (today != _on) {
      _on = today;
      _ids.clear();
    }
    _ids.add(messageId);
  }

  Map<String, Object> toJson() => {'on': _on, 'ids': _ids.toList()};

  /// The local date, as the card's pinned day is (view.dart).
  static String _today() {
    final now = clock.now();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${now.year}-${two(now.month)}-${two(now.day)}';
  }
}
