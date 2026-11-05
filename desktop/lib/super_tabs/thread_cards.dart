import 'dart:async';

import 'package:flutter/foundation.dart';

import 'attention.dart';
import 'controller.dart';
import 'model.dart';

/// What one card of the Threads page draws: its root, its newest replies
/// (one page, oldest first), how many replies it has, and who wrote in it.
class SuperTabThreadCard {
  const SuperTabThreadCard({
    this.root,
    this.replies = const [],
    this.count = 0,
    this.people = const [],
    this.readThrough = -1,
    this.loading = false,
    this.error,
  });

  /// The root message; null until read, or when the server no longer has it.
  final SuperTabMessage? root;
  final List<SuperTabMessage> replies;

  /// How many replies the thread has, read or not.
  final int count;

  /// The root's author, then each replier, as their messages name them, in
  /// the order they first wrote; each once.
  final List<Map<String, dynamic>> people;

  /// The newest reply this card's read covers: read again only past it.
  final int readThrough;
  final bool loading;
  final String? error;

  SuperTabThreadCard _copy({bool? loading, String? error}) =>
      SuperTabThreadCard(
        root: root,
        replies: replies,
        count: count,
        people: people,
        readThrough: readThrough,
        loading: loading ?? this.loading,
        error: error,
      );
}

/// The Threads page's cards, one per followed thread it lists: each read once
/// from its thread's newest page, and again only when the followed-threads
/// read says its newest reply moved. Only cards built (near the screen) ask.
/// One per controller.
class SuperTabThreadCards extends ChangeNotifier {
  SuperTabThreadCards._(this.controller) {
    _epoch = controller.visibilityEpoch;
    controller.addListener(_changed);
    controller.onDispose(dispose);
  }

  static final _all = Expando<SuperTabThreadCards>();
  static SuperTabThreadCards of(SuperTabController controller) =>
      _all[controller] ??= SuperTabThreadCards._(controller);

  final SuperTabController controller;
  final _cards = <String, SuperTabThreadCard>{};
  final _loading = <String, Future<void>>{};
  int? _epoch;

  /// Moves on [clear], so an answer for a page that closed is not kept.
  int _generation = 0;
  bool _disposed = false;

  static const failed = 'Could not load this thread.';

  SuperTabThreadCard? card(SuperTabFollowedThread thread) => _cards[thread.key];

  /// Whether [thread]'s card needs a read: never read, failed, or its newest
  /// reply moved past what was read.
  bool stale(SuperTabFollowedThread thread) {
    final held = _cards[thread.key];
    return held == null ||
        held.error != null ||
        held.readThrough < thread.lastReplySequence;
  }

  /// Reads [thread]'s newest page, and its root when the page does not reach
  /// it; joins a read under way. Nothing when the card is current.
  Future<void> load(SuperTabFollowedThread thread) {
    if (_disposed || controller.accessRevoked) return Future.value();
    if (_loading[thread.key] case final running?) return running;
    if (!stale(thread)) return Future.value();
    final read = _read(thread).whenComplete(() => _loading.remove(thread.key));
    _loading[thread.key] = read;
    return read;
  }

  Future<void> _read(SuperTabFollowedThread thread) async {
    final key = thread.key;
    final generation = _generation, epoch = controller.visibilityEpoch;
    _cards[key] = (_cards[key] ?? const SuperTabThreadCard())._copy(
      loading: true,
    );
    notifyListeners();
    bool current() =>
        !_disposed &&
        !controller.accessRevoked &&
        generation == _generation &&
        epoch == controller.visibilityEpoch;
    final path =
        '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}'
        '/conversations/${Uri.encodeComponent(thread.conversationId)}/messages';
    List<SuperTabMessage> rowsOf(Map<String, dynamic> page) => [
      for (final row in page['messages'] as List? ?? const [])
        if (SuperTabMessage.fromJson(superTabMap(row)) case final m
            when m.conversationId == thread.conversationId &&
                m.thread == thread.rootId)
          m,
    ];
    try {
      final page = await controller.request(
        'GET',
        '$path?thread=${Uri.encodeQueryComponent(thread.rootId)}',
      );
      if (!current()) return;
      final rows = rowsOf(page)..sort(superTabMessageOrder);
      var root = rows.where((m) => m.id == thread.rootId).firstOrNull;
      if (root == null) {
        // A long thread's newest page starts after its root.
        final asked = await controller.request(
          'GET',
          '$path?messageId=${Uri.encodeQueryComponent(thread.rootId)}',
        );
        if (!current()) return;
        root = rowsOf(asked).where((m) => m.id == thread.rootId).firstOrNull;
      }
      final replies = [
        for (final m in rows)
          if (m.id != thread.rootId) m,
      ];
      final summary = [
        for (final row in page['threads'] as List? ?? const [])
          if (superTabMap(row)['id'] == thread.rootId) superTabMap(row),
      ].firstOrNull;
      final people = <String, Map<String, dynamic>>{};
      for (final m in [?root, ...replies]) {
        people.putIfAbsent(
          '${m.author['kind']}:${m.author['id']}',
          () => m.author,
        );
      }
      _cards[key] = SuperTabThreadCard(
        root: root,
        replies: List.unmodifiable(replies),
        count:
            (summary?['replies'] as num?)?.toInt() ??
            thread.replies ??
            replies.length,
        people: List.unmodifiable(people.values),
        readThrough: [
          thread.lastReplySequence,
          ...replies.map((m) => m.sequence),
        ].reduce((a, b) => a > b ? a : b),
      );
      notifyListeners();
    } catch (_) {
      if (!current()) return;
      _cards[key] = (_cards[key] ?? const SuperTabThreadCard())._copy(
        loading: false,
        error: failed,
      );
      notifyListeners();
    }
  }

  /// Keeps only the cards of [keys], the threads the page lists now.
  void retain(Iterable<String> keys) {
    final kept = keys.toSet();
    _cards.removeWhere((key, _) => !kept.contains(key));
  }

  /// The page closed: nothing is kept, and answers on their way are dropped.
  void clear() {
    _generation++;
    _cards.clear();
    _loading.clear();
  }

  void _changed() {
    if (_disposed) return;
    final epoch = controller.visibilityEpoch;
    if (controller.accessRevoked || epoch != _epoch) {
      // Who may read what changed: nothing read before shows.
      _epoch = epoch;
      if (_cards.isEmpty && _loading.isEmpty) return;
      clear();
      notifyListeners();
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    controller.removeListener(_changed);
    super.dispose();
  }
}
