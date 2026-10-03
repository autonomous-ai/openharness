import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:harness_mobile/phone/phone_search_catalog.dart'
    show phoneAgentId;

import 'external_session.dart';
import 'search_when.dart';

/// Where a machine's daemon marks each matched word in a snippet.
const kSnippetMarkOpen = '\u0002';
const kSnippetMarkClose = '\u0003';

/// One conversation that matched a search, as its machine's daemon found it
/// (`session_search`, cli/src/lib/sessionSearch/). The daemon has read every
/// turn of every session on that machine; the app only ever sees the hits.
@immutable
class SessionContentHit {
  const SessionContentHit({
    required this.machineId,
    required this.agentId,
    required this.sessionId,
    required this.field,
    required this.snippet,
    required this.together,
    required this.score,
    this.position = 0,
    this.turn = 0,
    this.at,
    this.lastAt,
    this.external,
  });

  final String machineId, agentId, sessionId;

  /// A conversation Harness did not start, whose [agentId] is empty.
  final ExternalSessionRef? external;

  /// When the session was last worked on.
  final DateTime? lastAt;

  /// `ask`, `answer`, `tools` or `name`: which part of the turn matched.
  final String field;

  /// The words around the match, each matched word between
  /// [kSnippetMarkOpen] and [kSnippetMarkClose].
  final String snippet;

  /// Every searched word in one turn, rather than spread across the session.
  final bool together;

  /// 0–1, higher is better: relevance blended with recency by the daemon.
  /// Relative to that machine's best hit, so not comparable across machines.
  final double score;

  /// Where the machine ranked it, from 0. Hits from several machines merge
  /// by this: each machine's first is as good as another's first.
  final int position;
  final int turn;

  /// When the matching turn happened, when the transcript says.
  final DateTime? at;

  String get destinationId => external == null
      ? phoneAgentId(machineId, agentId)
      : externalDestinationId(machineId, sessionId);

  /// The snippet as plain text, marks removed.
  String get plainSnippet => snippet
      .replaceAll(kSnippetMarkOpen, '')
      .replaceAll(kSnippetMarkClose, '');

  static SessionContentHit? fromJson(
    String machineId,
    Object? raw, {
    int position = 0,
  }) {
    if (raw is! Map) return null;
    final agentId = raw['agentId'];
    final sessionId = raw['sessionId'];
    final snippet = raw['snippet'];
    final external = _external(raw, sessionId);
    if (agentId is! String ||
        (agentId.isEmpty && external == null) ||
        sessionId is! String) {
      return null;
    }
    final score = raw['score'];
    final at = raw['at'];
    final lastAt = raw['lastAt'];
    final turn = raw['turn'];
    return SessionContentHit(
      machineId: machineId,
      agentId: agentId,
      sessionId: sessionId,
      field: raw['field'] is String ? raw['field'] as String : 'ask',
      snippet: snippet is String
          ? snippet.length > 600
                ? snippet.substring(0, 600)
                : snippet
          : '',
      together: raw['together'] == true,
      score: score is num ? score.toDouble().clamp(0, 1) : 0,
      position: position,
      turn: turn is int ? turn : 0,
      at: at is int ? DateTime.fromMillisecondsSinceEpoch(at) : null,
      lastAt: lastAt is int
          ? DateTime.fromMillisecondsSinceEpoch(lastAt)
          : null,
      external: agentId.isEmpty ? external : null,
    );
  }

  /// A hit on a conversation Harness did not start: the daemon says where it
  /// resumes and where it ran. Null when the hit is a harness's.
  static ExternalSessionRef? _external(Map raw, Object? sessionId) {
    final external = raw['external'];
    final engine = raw['engine'];
    if (external is! Map || sessionId is! String || engine is! String) {
      return null;
    }
    final cwd = external['cwd'];
    if (cwd is! String || !cwd.startsWith('/')) return null;
    final title = external['title'];
    final origin = external['origin'];
    return ExternalSessionRef(
      sessionId: sessionId,
      engine: engine,
      cwd: cwd,
      origin: origin is String ? origin : 'terminal',
      title: title is String ? title : '',
      open: external['open'] == true,
    );
  }

  /// A `session_search_result` payload, or an empty list for an error.
  static List<SessionContentHit> listFromReply(
    String machineId,
    Map<String, dynamic> reply,
  ) {
    final hits = reply['hits'];
    if (reply['error'] != null || hits is! List) return const [];
    return [
      for (final (position, raw) in hits.take(100).indexed)
        ?SessionContentHit.fromJson(machineId, raw, position: position),
    ];
  }
}

/// Asks one machine for [words], only in sessions worked on in [when] when
/// there is one.
typedef SessionSearchAsk = Future<List<SessionContentHit>?> Function(
  String machineId,
  String words,
  SearchWhen? when,
);

/// Asks every reachable machine what was said in its sessions, as the person
/// types in Find (the desktop's Cmd-P, `desktop/lib/state/session_content_search.dart`). Debounced so a burst of keys is one question; an answer to
/// an older question is dropped. Hits are keyed by the harness row they belong
/// to, and a machine that cannot answer (offline, or a CLI that predates
/// `session_search`) simply adds none.
class SessionContentSearch extends ChangeNotifier {
  SessionContentSearch({
    required this.machines,
    required this.ask,
    this.debounce = const Duration(milliseconds: 110),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// The machines to ask right now.
  final Iterable<String> Function() machines;
  final SessionSearchAsk ask;
  final Duration debounce;
  final DateTime Function() _now;

  /// What [query] asks for: its words, and when, if it says.
  ({String words, SearchWhen? when}) read(String query) =>
      parseSearchWhen(query.trim(), _now());

  Map<String, SessionContentHit> _hits = const {};
  Map<String, SessionContentHit> get hits => _hits;

  /// The hits that vouch for [query]. While its own answer is on the way, an
  /// earlier answer's hit counts only if its snippet shows every word of it:
  /// a hit found for "mob" says nothing about "mob swipe".
  Map<String, SessionContentHit> hitsFor(String query) {
    final wanted = query.trim();
    if (_answered == null || _hits.isEmpty) return const {};
    if (_answered == wanted) return _hits;
    // Read on every row's build: worked out once per query and answer.
    final cached = _vouched;
    if (cached != null &&
        cached.query == wanted &&
        identical(cached.hits, _hits)) {
      return cached.vouched;
    }
    final vouched = _vouch(wanted);
    _vouched = (query: wanted, hits: _hits, vouched: vouched);
    return vouched;
  }

  ({
    String query,
    Map<String, SessionContentHit> hits,
    Map<String, SessionContentHit> vouched,
  })?
  _vouched;

  Map<String, SessionContentHit> _vouch(String wanted) {
    // A hit found for another time says nothing about this one. Compared by
    // the phrase: "today" ends now, and now moves on every read.
    final now = read(wanted), then = read(_answered!);
    if (now.when?.phrase.toLowerCase() != then.when?.phrase.toLowerCase()) {
      return const {};
    }
    final words = now.words
        .toLowerCase()
        .split(RegExp(r'\s+'))
        .where((word) => word.isNotEmpty)
        .toList();
    return {
      for (final entry in _hits.entries)
        if (_shows(entry.value.plainSnippet.toLowerCase(), words))
          entry.key: entry.value,
    };
  }

  static final _wordStart = RegExp(r'[^\p{L}\p{N}]', unicode: true);

  static bool _shows(String text, List<String> words) => words.every((word) {
    for (
      var at = text.indexOf(word);
      at >= 0;
      at = text.indexOf(word, at + 1)
    ) {
      if (at == 0 || _wordStart.hasMatch(text[at - 1])) return true;
    }
    return false;
  });

  /// The query the current [hits] answer, or null while none have arrived.
  String? get answered => _answered;
  String? _answered;

  String _query = '';
  int _generation = 0;
  Timer? _timer;
  bool _disposed = false;

  /// Two letters at least: one matches too much of everything to mean anything.
  /// A time on its own ("yesterday") is a search too: what was worked on then.
  bool searchable(String query) {
    final read = this.read(query);
    return read.when != null || read.words.runes.length >= 2;
  }

  void search(String query) {
    final next = query.trim();
    if (next == _query) return;
    final previous = _query;
    _query = next;
    _timer?.cancel();
    final generation = ++_generation;
    // Typing more of the same words keeps the last answer on screen until the
    // new one lands; anything else would show rows for words no longer typed.
    if (!next.toLowerCase().startsWith(previous.toLowerCase()) ||
        !searchable(next)) {
      if (_hits.isNotEmpty || _answered != null) {
        _hits = const {};
        _answered = null;
        notifyListeners();
      }
    }
    // Nothing to ask while every machine is offline: no timer, no work.
    if (!searchable(next) || machines().isEmpty) return;
    final read = this.read(next);
    _timer = Timer(
      debounce,
      () => _run(next, read.words, read.when, generation),
    );
  }

  Future<void> _run(
    String query,
    String words,
    SearchWhen? when,
    int generation,
  ) async {
    final found = <String, SessionContentHit>{};
    var first = true;
    await Future.wait([
      for (final machineId in machines())
        ask(machineId, words, when).then((hits) {
          if (_disposed || generation != _generation) return;
          if (first) {
            // The first answer replaces what an earlier question found.
            first = false;
            _hits = const {};
          }
          for (final hit in hits ?? const <SessionContentHit>[]) {
            final id = hit.destinationId;
            final known = found[id];
            // One row per harness: its best conversation, earlier ones included.
            if (known == null ||
                (hit.together && !known.together) ||
                (hit.together == known.together &&
                    hit.position < known.position)) {
              found[id] = hit;
            }
          }
          _hits = Map.unmodifiable(found);
          _answered = query;
          notifyListeners();
        }, onError: (_) {}),
    ]);
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
