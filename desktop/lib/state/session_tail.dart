import 'dart:async';

import 'package:flutter/foundation.dart';

/// One row of a session's end as its machine's index holds it
/// (cli/src/lib/sessionSearch/store.ts `tail`): a turn, or the continuation of
/// a long one, which has no ask of its own.
@immutable
class SessionTailRow {
  const SessionTailRow({
    required this.turn,
    this.at,
    this.ask = '',
    this.answer = '',
    this.tools = const [],
  });

  final int turn;
  final DateTime? at;
  final String ask, answer;

  /// The tool calls, one per entry: the paths, commands and queries they named.
  final List<String> tools;

  static SessionTailRow? fromJson(Object? value) {
    if (value is! Map) return null;
    final turn = value['turn'];
    if (turn is! int) return null;
    final at = value['at'];
    final tools = value['tools'];
    return SessionTailRow(
      turn: turn,
      at: at is num ? DateTime.fromMillisecondsSinceEpoch(at.toInt()) : null,
      ask: value['ask'] is String ? value['ask'] as String : '',
      answer: value['answer'] is String ? value['answer'] as String : '',
      tools: tools is String
          ? [
              for (final line in tools.split('\n'))
                if (line.trim().isNotEmpty) line.trim(),
            ]
          : const [],
    );
  }
}

/// The end of one session: its latest rows, oldest first, and whether older
/// ones remain on the machine.
class SessionTail {
  SessionTail({
    required this.rows,
    required this.hasMore,
    required this.total,
    required this.fetchedAt,
    this.lastAsk,
    this.openElsewhere = false,
    this.openIn,
  });

  final List<SessionTailRow> rows;
  final bool hasMore;
  final int total;
  final DateTime fetchedAt;

  /// The latest row with an ask. After a long autonomous turn it is many
  /// rows up, and it is what the session is doing now.
  final SessionTailRow? lastAsk;

  /// For a conversation Harness did not start: open in a running process
  /// elsewhere, as its machine found when it answered.
  final bool openElsewhere;

  /// Where: `terminal`, which Harness can take it over from, or `app`.
  final String? openIn;

  static SessionTail? fromReply(Map<String, dynamic> reply, DateTime now) {
    final rows = reply['rows'];
    if (rows is! List) return null;
    return SessionTail(
      rows: [for (final row in rows) ?SessionTailRow.fromJson(row)],
      hasMore: reply['hasMore'] == true,
      total: reply['total'] is int ? reply['total'] as int : rows.length,
      fetchedAt: now,
      lastAsk: SessionTailRow.fromJson(reply['lastAsk']),
      openElsewhere:
          reply['external'] is Map &&
          (reply['external'] as Map)['open'] == true,
      openIn: switch (reply['external']) {
        {'openIn': final String where}
            when const {
              'terminal',
              'app',
              'harness',
              'maybe',
            }.contains(where) =>
          where,
        _ => null,
      },
    );
  }
}

typedef SessionTailKey = ({String machineId, String sessionId});

/// Asks [machineId] for the rows of [sessionId] before [beforeTurn] (its last
/// rows without one). Null when the machine cannot answer.
typedef SessionTailFetch = Future<Map<String, dynamic>?> Function(
  String machineId,
  String sessionId, {
  int? beforeTurn,
});

/// Cmd-P's preview of a session's end. Fetched once per Cmd-P opening, when
/// its row is selected: arrowing back to it reuses that copy, and nothing is
/// refreshed while Cmd-P stays open. Kept for the last [capacity] sessions and
/// paged up on demand.
class SessionTails extends ChangeNotifier {
  SessionTails(this._fetch, {DateTime Function()? now, this.capacity = 20})
    : _now = now ?? DateTime.now;

  final SessionTailFetch _fetch;
  final DateTime Function() _now;
  final int capacity;

  final _tails = <SessionTailKey, SessionTail>{};
  final _latest = <SessionTailKey, Future<void>>{};
  final _older = <SessionTailKey>{};
  final _unavailable = <SessionTailKey, DateTime>{};

  /// Sessions fetched since Cmd-P last opened.
  final _fetched = <SessionTailKey>{};
  bool _disposed = false;

  /// How long a machine that could not answer is left alone: a CLI that
  /// predates `session_tail` stays silent until its request times out.
  static const unavailableAge = Duration(minutes: 1);

  SessionTail? read(SessionTailKey key) {
    final tail = _tails.remove(key);
    if (tail != null) _tails[key] = tail;
    return tail;
  }

  /// Whether the machine could not answer for this session recently: an older
  /// CLI, or a session its index does not hold (a plain terminal).
  bool unavailable(SessionTailKey key) {
    final at = _unavailable[key];
    return at != null && _now().difference(at) < unavailableAge;
  }

  bool loadingOlder(SessionTailKey key) => _older.contains(key);

  /// Cmd-P opened: each session is fetched again the first time it is
  /// selected, so the preview shows it as it is now. Until then the copy it
  /// had is shown.
  void opened() => _fetched.clear();

  /// Fetches the session's last rows, once per Cmd-P opening. Older pages
  /// already loaded are kept beneath the new last page.
  Future<void> want(SessionTailKey key) {
    final pending = _latest[key];
    if (pending != null) return pending;
    if (_fetched.contains(key)) return Future.value();
    if (!_tails.containsKey(key) && unavailable(key)) return Future.value();
    _fetched.add(key);
    // A block, not an arrow: `remove` returns this very future, and
    // `whenComplete` would wait for it — for itself, forever.
    final future = _fetchLatest(key).whenComplete(() {
      _latest.remove(key);
    });
    _latest[key] = future;
    return future;
  }

  Future<void> _fetchLatest(SessionTailKey key) async {
    final reply = await _fetch(key.machineId, key.sessionId);
    if (_disposed) return;
    final page = reply == null ? null : SessionTail.fromReply(reply, _now());
    if (page == null) {
      _unavailable[key] = _now();
      notifyListeners();
      return;
    }
    _unavailable.remove(key);
    final cached = _tails[key];
    final first = page.rows.firstOrNull?.turn;
    // The last page replaces its own rows (the open turn grew, a continuation
    // began) and keeps what was paged in above it.
    final kept = cached == null || first == null
        ? const <SessionTailRow>[]
        : cached.rows.where((row) => row.turn < first).toList();
    _put(
      key,
      SessionTail(
        rows: [...kept, ...page.rows],
        hasMore: kept.isEmpty ? page.hasMore : cached!.hasMore,
        total: page.total,
        fetchedAt: page.fetchedAt,
        lastAsk: page.lastAsk,
        openElsewhere: page.openElsewhere,
        openIn: page.openIn,
      ),
    );
  }

  /// Fetches the page above the first loaded row.
  Future<void> older(SessionTailKey key) async {
    final cached = _tails[key];
    if (cached == null || !cached.hasMore || _older.contains(key)) return;
    final first = cached.rows.firstOrNull?.turn;
    if (first == null) return;
    _older.add(key);
    notifyListeners();
    try {
      final reply = await _fetch(
        key.machineId,
        key.sessionId,
        beforeTurn: first,
      );
      if (_disposed) return;
      final page = reply == null ? null : SessionTail.fromReply(reply, _now());
      final current = _tails[key];
      if (page == null || current == null) return;
      final firstNow = current.rows.firstOrNull?.turn ?? first;
      _put(
        key,
        SessionTail(
          rows: [
            ...page.rows.where((row) => row.turn < firstNow),
            ...current.rows,
          ],
          hasMore: page.hasMore,
          total: current.total,
          fetchedAt: current.fetchedAt,
          lastAsk: current.lastAsk,
          openElsewhere: current.openElsewhere,
          openIn: current.openIn,
        ),
      );
    } finally {
      _older.remove(key);
      if (!_disposed) notifyListeners();
    }
  }

  /// Forgets every tail: the account changed hands.
  void clear() {
    _tails.clear();
    _unavailable.clear();
    _fetched.clear();
    notifyListeners();
  }

  void _put(SessionTailKey key, SessionTail tail) {
    _tails.remove(key);
    _tails[key] = tail;
    while (_tails.length > capacity) {
      _tails.remove(_tails.keys.first);
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
