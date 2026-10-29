import 'model.dart';

/// One row the catch-up card links to (backend catchUp.ts): who wrote it and
/// what it says, shortened by the server.
class SuperTabCatchUpItem {
  const SuperTabCatchUpItem({
    required this.messageId,
    required this.author,
    required this.text,
  });

  factory SuperTabCatchUpItem.fromJson(Map<String, dynamic> row) =>
      SuperTabCatchUpItem(
        messageId: row['messageId'] as String? ?? '',
        author: row['author'] as String? ?? '',
        text: row['text'] as String? ?? '',
      );

  final String messageId, author, text;
}

/// One list of the card: its newest items, and how many there are in all.
class SuperTabCatchUpList {
  const SuperTabCatchUpList({this.total = 0, this.items = const []});

  /// A list missing from the answer, or a row that is not one, reads as
  /// nothing, never a failed read.
  factory SuperTabCatchUpList.fromJson(Object? value) {
    final row = value is Map ? superTabMap(value) : const <String, dynamic>{};
    final items = [
      for (final item in row['items'] as List? ?? const [])
        if (item is Map) SuperTabCatchUpItem.fromJson(superTabMap(item)),
    ].where((item) => item.messageId.isNotEmpty).toList();
    final total = (row['total'] as num?)?.toInt() ?? items.length;
    return SuperTabCatchUpList(
      total: total < items.length ? items.length : total,
      items: List.unmodifiable(items),
    );
  }

  final int total;
  final List<SuperTabCatchUpItem> items;

  /// The items counted but not shown.
  int get more => total - items.length;
}

/// "While you were away": what the reader missed in one conversation since
/// their read mark, as the backend summarizes it from the rows they may read
/// (catchUp.ts).
class SuperTabCatchUp {
  const SuperTabCatchUp({
    this.unread = 0,
    this.decisions = 0,
    this.landed = const SuperTabCatchUpList(),
    this.blocked = const SuperTabCatchUpList(),
    this.needsYou = const SuperTabCatchUpList(),
  });

  factory SuperTabCatchUp.fromJson(Map<String, dynamic> row) => SuperTabCatchUp(
    unread: (row['unread'] as num?)?.toInt() ?? 0,
    decisions: (row['decisions'] as num?)?.toInt() ?? 0,
    landed: SuperTabCatchUpList.fromJson(row['landed']),
    blocked: SuperTabCatchUpList.fromJson(row['blocked']),
    needsYou: SuperTabCatchUpList.fromJson(row['needsYou']),
  );

  final int unread, decisions;
  final SuperTabCatchUpList landed, blocked, needsYou;

  /// Nothing landed, is blocked or needs the reader: no card, since a count
  /// of new messages alone is what the New messages line already says.
  bool get isEmpty =>
      decisions == 0 &&
      landed.items.isEmpty &&
      blocked.items.isEmpty &&
      needsYou.items.isEmpty;
}

/// Each conversation's catch-up card for this visit: read once, when its New
/// messages line is placed, and gone with the line (Esc, leaving the
/// conversation) or when closed. A read that fails or comes back empty shows
/// no card; the line is unchanged either way.
class SuperTabCatchUps {
  final _shown = <String, SuperTabCatchUp>{};

  /// The read under way or done this visit, by conversation: a reply to an
  /// earlier visit's read is never shown in this one.
  final _asked = <String, Object>{};

  /// [id]'s card, or null.
  SuperTabCatchUp? of(String id) => _shown[id];

  /// Reads [id]'s summary with [read], once a visit; true when a card is now
  /// shown.
  Future<bool> load(String id, Future<SuperTabCatchUp> Function() read) async {
    if (_asked.containsKey(id)) return false;
    final visit = _asked[id] = Object();
    try {
      final summary = await read();
      if (!identical(_asked[id], visit) || summary.isEmpty) return false;
      _shown[id] = summary;
      return true;
    } catch (_) {
      // Offline, or an older backend: the New messages line says enough.
      return false;
    }
  }

  /// Closed by the reader, or read with Esc: not read again this visit.
  void dismiss(String id) => _shown.remove(id);

  /// [id] was left: the next visit reads again.
  void forget(String? id) {
    _asked.remove(id);
    _shown.remove(id);
  }

  void reset() {
    _asked.clear();
    _shown.clear();
  }
}
