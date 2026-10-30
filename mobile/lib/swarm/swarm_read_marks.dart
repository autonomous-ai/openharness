import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'model.dart';
import 'swarm_reader.dart';

/// Sends the reader's read marks to the server (backend `superTabs/readMarks.ts`, #2131), so a chat, or a thread
/// ([K] names which), read on this phone reads as read on every other device. The desktop's
/// `SuperTabReadMarkSender`: one request per chat or thread at a time; a higher mark asked for while one is on its way
/// goes after it, and a lower or equal one is never sent. A failed send is forgotten, so the next mark asked for tries
/// again (after [retryAfter] when it is no higher); meanwhile this phone's own mark keeps it read here.
class SwarmReadMarkSender<K> {
  SwarmReadMarkSender(
    this._send, {
    this.retryAfter = Duration.zero,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// Writes [sequence] as the mark of [conversationId]; completes once the server kept it, or throws.
  final Future<void> Function(K conversationId, int sequence) _send;

  /// How long a mark whose send failed waits before it is sent again: a
  /// thread asks for its mark on every change while it is open, and a server
  /// without thread marks refuses each.
  final Duration retryAfter;
  final DateTime Function() _now;

  /// The highest mark sent and kept, by chat.
  final _sent = <K, int>{};

  /// The mark waiting for the one on its way, by chat.
  final _next = <K, int>{};
  final _sending = <K>{};

  /// The mark on its way, by conversation: one asked for again meanwhile is not sent twice.
  final _inFlight = <K, int>{};

  /// The last mark that failed, and when, by chat.
  final _failed = <K, (int, DateTime)>{};
  bool _disposed = false;

  /// Asks for [sequence] to be [conversationId]'s mark on the server, unless [kept] (what the server already holds)
  /// or a mark sent from here is as high.
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
    if (_sending.add(conversationId)) unawaited(_drain(conversationId));
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
        // Offline, or a server without read marks: this phone's mark stands,
        // and the next one asked for is sent afresh.
      }
    }
    _inFlight.remove(conversationId);
    _sending.remove(conversationId);
  }

  void dispose() => _disposed = true;
}

/// How far the person has read each chat of one Swarm ([reader]), as the
/// desktop keeps it (`SuperTabController.unread`): a chat is unread while its
/// newest message in the main stream ([SuperTabConversation.mainSequence]; a
/// reply only in a thread is not) is past the higher of the server's mark
/// ([SuperTabSnapshot.readMarks], #2131) and this phone's own. Unread is drawn
/// as the chat's name in bold (design system: Unread).
///
/// The phone's own marks are what a server without read marks has, and what
/// keeps a chat read here while a send is on its way or failed. They are kept
/// on the phone ([store]) under the account and the Swarm: no message, only
/// each chat's id and a number. The first read of a Swarm on this phone, with
/// no mark yet from the phone or the server, counts what is already there as
/// read (Tony, 2026-10-29), so a new phone does not start with every chat in
/// bold; the Home kept from before is no read. Nothing is unread until the
/// marks are read back. Access lost takes them off the phone too.
class SwarmReadMarks extends ChangeNotifier {
  SwarmReadMarks(
    this.reader, {
    required this.store,
    this.saveAfter = Duration.zero,
  }) {
    _sender = SwarmReadMarkSender<String>(
      (id, sequence) => reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}'
            '/conversations/${Uri.encodeComponent(id)}/read',
        body: {'sequence': sequence},
      ),
    );
    _threadSender = SwarmReadMarkSender<(String, String)>(
      (thread, sequence) => reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}'
            '/conversations/${Uri.encodeComponent(thread.$1)}'
            '/threads/${Uri.encodeComponent(thread.$2)}/read',
        body: {'sequence': sequence},
      ),
      retryAfter: const Duration(minutes: 1),
    );
    reader.addListener(_swarmChanged);
    reader.reads.addListener(_swarmChanged);
    unawaited(_load());
  }

  /// The most chats whose marks the phone keeps per Swarm; the marks of chats
  /// the Swarm's read no longer has go first.
  static const kept = 1000;

  /// The most threads whose marks the phone keeps per Swarm, as the server
  /// does (backend readMarks.ts THREAD_MARK_CAP): those of chats the Swarm's
  /// read no longer has go first, then the oldest. A thread without one reads
  /// as far as the phone's other marks say (Activity's opened mark, the
  /// chat's).
  static const keptThreads = 500;

  final SwarmReader reader;

  /// How long marks wait to be written: at once by default, after what moved
  /// them together (a first read's, a chat read on), which is written once.
  final Duration saveAfter;

  /// Where the phone keeps its marks; null keeps them in memory only.
  final LocalKeyValueStore? store;
  late final SwarmReadMarkSender<String> _sender;
  late final SwarmReadMarkSender<(String, String)> _threadSender;

  /// The phone's own marks, by chat.
  final _marks = <String, int>{};

  /// The phone's own thread marks, by chat then thread root.
  final _threads = <String, Map<String, int>>{};

  /// The marks were read back from the phone (or there is no store).
  bool _loaded = false;

  /// The marks count: read back from the phone, or started by a first read.
  bool _started = false;
  Timer? _save;
  bool _disposed = false;

  String get _key => 'swarm_read_marks.${reader.accountId}.${reader.tabId}';

  /// The phone's marks were read back. Until then [readThrough] has none to
  /// give, which is not a chat with no mark: what waits on a mark waits on
  /// this, and is told when it moves.
  bool get loaded => _loaded;

  /// Whether [group] has messages in its main stream past what the person
  /// has read.
  bool unread(SuperTabConversation group) {
    if (!_loaded || !_started) return false;
    final server = reader.snapshot?.readMarks[group.id] ?? 0;
    return group.mainSequence > max(server, _marks[group.id] ?? 0);
  }

  /// How far the person has read [conversationId]: the higher of the
  /// server's mark and this phone's; null until the phone's are read back,
  /// and once access is lost.
  int? readThrough(String conversationId) => _loaded && !reader.accessRevoked
      ? max(
          reader.snapshot?.readMarks[conversationId] ?? 0,
          _marks[conversationId] ?? 0,
        )
      : null;

  /// How far the person has read [root]'s thread in [conversationId]: the
  /// higher of the server's thread mark, from any of their devices, and this
  /// phone's; null until the phone's are read back, and once access is lost.
  /// Zero for a thread with no mark: the chat's own mark is the caller's.
  int? threadThrough(String conversationId, String root) =>
      _loaded && !reader.accessRevoked
      ? max(
          reader.snapshot?.threadMarks[conversationId]?[root] ?? 0,
          _threads[conversationId]?[root] ?? 0,
        )
      : null;

  /// The person saw [root]'s thread in [conversationId] through [sequence]:
  /// sent to the server, and kept on the phone when it moves the phone's mark
  /// on.
  void markThreadRead(String conversationId, String root, int sequence) {
    if (_disposed || reader.accessRevoked || sequence <= 0) return;
    // A chat the Swarm's read no longer has is not the person's to mark.
    if (reader.snapshot?.conversation(conversationId) == null) return;
    _threadSender.mark(
      (conversationId, root),
      sequence,
      kept: reader.snapshot?.threadMarks[conversationId]?[root] ?? 0,
    );
    final held = _threads[conversationId] ??= {};
    if (sequence <= (held[root] ?? 0)) return;
    // Moved to the end: the newest are the ones a trim keeps.
    held.remove(root);
    held[root] = sequence;
    _saveSoon();
    notifyListeners();
  }

  /// The person saw [conversationId] through [sequence]: sent to the server,
  /// and kept on the phone when it moves the phone's mark on.
  void markRead(String conversationId, int sequence) {
    if (_disposed || reader.accessRevoked) return;
    _sender.mark(
      conversationId,
      sequence,
      kept: reader.snapshot?.readMarks[conversationId] ?? 0,
    );
    if (sequence <= (_marks[conversationId] ?? 0)) return;
    _marks[conversationId] = sequence;
    _saveSoon();
    notifyListeners();
  }

  Future<void> _load() async {
    final held = <String, int>{};
    final threads = <String, Map<String, int>>{};
    var found = false;
    try {
      if (await store?.read(_key) case final raw?) {
        final value = jsonDecode(raw);
        if (value case {'marks': final Map marks}) {
          for (final MapEntry(:key, :value) in marks.entries) {
            if (key is String && value is num) held[key] = value.toInt();
          }
          found = true;
        }
        // Absent from what a phone before thread marks wrote.
        if (value case {'threads': final Map kept}) {
          for (final MapEntry(key: id, value: roots) in kept.entries) {
            if (id is! String || roots is! Map) continue;
            for (final MapEntry(:key, :value) in roots.entries) {
              if (key is String && value is num) {
                (threads[id] ??= {})[key] = value.toInt();
              }
            }
          }
        }
      }
    } catch (_) {
      // An unreadable value is no marks: the next first read starts afresh.
    }
    if (_disposed || reader.accessRevoked) return;
    final marked = _marks.isNotEmpty || _threads.isNotEmpty;
    for (final MapEntry(:key, :value) in held.entries) {
      if (value > (_marks[key] ?? 0)) _marks[key] = value;
    }
    // A thread read before the marks were back keeps the higher of the two.
    for (final MapEntry(key: id, value: roots) in threads.entries) {
      final now = _threads[id] ??= {};
      for (final MapEntry(:key, :value) in roots.entries) {
        if (value > (now[key] ?? 0)) now[key] = value;
      }
    }
    _loaded = true;
    _started |= found;
    // A chat read before the marks were back is kept with them.
    if (marked) _saveSoon();
    _swarmChanged();
    notifyListeners();
  }

  /// The Swarm was read, changed or not: its first read on this phone starts
  /// the marks.
  void _swarmChanged() {
    if (_disposed) return;
    if (reader.accessRevoked) {
      _forget();
      return;
    }
    final snapshot = reader.snapshot;
    // The Home kept holds no first load ([SwarmReader.heldLoad]).
    if (!_loaded || _started || snapshot == null || reader.heldLoad == 0) {
      return;
    }
    _started = true;
    if (snapshot.readMarks.isEmpty) {
      for (final group in snapshot.conversations) {
        if (group.lastMessageSequence > (_marks[group.id] ?? 0)) {
          _marks[group.id] = group.lastMessageSequence;
        }
      }
    }
    _saveSoon();
    notifyListeners();
  }

  void _forget() {
    _save?.cancel();
    _save = null;
    final had = _marks.isNotEmpty || _threads.isNotEmpty || _started;
    _marks.clear();
    _threads.clear();
    _started = false;
    unawaited(store?.delete(_key).catchError((Object _) {}));
    if (had) notifyListeners();
  }

  void _saveSoon() {
    if (!_loaded || store == null || _disposed) return;
    _save?.cancel();
    _save = Timer(saveAfter, _write);
  }

  void _write() {
    _save = null;
    _trim();
    final value = jsonEncode({
      'marks': _marks,
      if (_threads.isNotEmpty) 'threads': _threads,
    });
    unawaited(store?.write(_key, value).catchError((Object _) {}));
  }

  /// At most [kept] marks: those of chats the Swarm's read no longer has go
  /// first, then the oldest kept.
  void _trim() {
    _trimThreads();
    if (_marks.length <= kept) return;
    final read = {
      for (final group in reader.snapshot?.conversations ?? const []) group.id,
    };
    for (final id in [
      for (final id in _marks.keys)
        if (!read.contains(id)) id,
    ]) {
      if (_marks.length <= kept) return;
      _marks.remove(id);
    }
    while (_marks.length > kept) {
      _marks.remove(_marks.keys.first);
    }
  }

  /// At most [keptThreads] thread marks: those of chats the Swarm's read no
  /// longer has go first, then the oldest kept.
  void _trimThreads() {
    int count() => _threads.values.fold(0, (n, roots) => n + roots.length);
    if (count() <= keptThreads) return;
    final read = {
      for (final group in reader.snapshot?.conversations ?? const []) group.id,
    };
    _threads.removeWhere((id, _) => !read.contains(id));
    // Then the oldest: each chat's first kept is its oldest.
    while (count() > keptThreads) {
      final id = _threads.keys.first;
      final roots = _threads[id]!..remove(_threads[id]!.keys.first);
      if (roots.isEmpty) _threads.remove(id);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    // What waited to be written is written now.
    if (_save case final save?) {
      save.cancel();
      _write();
    }
    reader.removeListener(_swarmChanged);
    reader.reads.removeListener(_swarmChanged);
    _sender.dispose();
    _threadSender.dispose();
    super.dispose();
  }
}
