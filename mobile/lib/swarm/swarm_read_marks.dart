import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'model.dart';
import 'swarm_reader.dart';

/// Sends the reader's read marks to the server (backend `superTabs/readMarks.ts`, #2131), so a chat read on this phone
/// reads as read on every other device. The desktop's `SuperTabReadMarkSender`: one request per chat at a time; a
/// higher mark asked for while one is on its way goes after it, and a lower or equal one is never sent. A failed send
/// is forgotten, so the next mark asked for tries again; meanwhile this phone's own mark keeps the chat read here.
class SwarmReadMarkSender {
  SwarmReadMarkSender(this._send);

  /// Writes [sequence] as the mark of [conversationId]; completes once the server kept it, or throws.
  final Future<void> Function(String conversationId, int sequence) _send;

  /// The highest mark sent and kept, by chat.
  final _sent = <String, int>{};

  /// The mark waiting for the one on its way, by chat.
  final _next = <String, int>{};
  final _sending = <String>{};
  bool _disposed = false;

  /// Asks for [sequence] to be [conversationId]'s mark on the server, unless [kept] (what the server already holds)
  /// or a mark sent from here is as high.
  void mark(String conversationId, int sequence, {int kept = 0}) {
    if (_disposed || sequence <= kept) return;
    if (sequence <= (_sent[conversationId] ?? 0)) return;
    if (sequence <= (_next[conversationId] ?? 0)) return;
    _next[conversationId] = sequence;
    if (_sending.add(conversationId)) unawaited(_drain(conversationId));
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
        // Offline, or a server without read marks: this phone's mark stands,
        // and the next one asked for is sent afresh.
      }
    }
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
    _sender = SwarmReadMarkSender(
      (id, sequence) => reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}'
            '/conversations/${Uri.encodeComponent(id)}/read',
        body: {'sequence': sequence},
      ),
    );
    reader.addListener(_swarmChanged);
    reader.reads.addListener(_swarmChanged);
    unawaited(_load());
  }

  /// The most chats whose marks the phone keeps per Swarm; the marks of chats
  /// the Swarm's read no longer has go first.
  static const kept = 1000;

  final SwarmReader reader;

  /// How long marks wait to be written: at once by default, after what moved
  /// them together (a first read's, a chat read on), which is written once.
  final Duration saveAfter;

  /// Where the phone keeps its marks; null keeps them in memory only.
  final LocalKeyValueStore? store;
  late final SwarmReadMarkSender _sender;

  /// The phone's own marks, by chat.
  final _marks = <String, int>{};

  /// The marks were read back from the phone (or there is no store).
  bool _loaded = false;

  /// The marks count: read back from the phone, or started by a first read.
  bool _started = false;
  Timer? _save;
  bool _disposed = false;

  String get _key => 'swarm_read_marks.${reader.accountId}.${reader.tabId}';

  /// Whether [group] has messages in its main stream past what the person
  /// has read.
  bool unread(SuperTabConversation group) {
    if (!_loaded || !_started) return false;
    final server = reader.snapshot?.readMarks[group.id] ?? 0;
    return group.mainSequence > max(server, _marks[group.id] ?? 0);
  }

  /// How far the person has read [conversationId]: the higher of the
  /// server's mark and the phone's. Null until the marks count, and once
  /// access is lost.
  int? markOf(String conversationId) {
    if (!_loaded || !_started || reader.accessRevoked) return null;
    final server = reader.snapshot?.readMarks[conversationId] ?? 0;
    return max(server, _marks[conversationId] ?? 0);
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
    var found = false;
    try {
      if (await store?.read(_key) case final raw?) {
        if (jsonDecode(raw) case {'marks': final Map marks}) {
          for (final MapEntry(:key, :value) in marks.entries) {
            if (key is String && value is num) held[key] = value.toInt();
          }
          found = true;
        }
      }
    } catch (_) {
      // An unreadable value is no marks: the next first read starts afresh.
    }
    if (_disposed || reader.accessRevoked) return;
    final marked = _marks.isNotEmpty;
    for (final MapEntry(:key, :value) in held.entries) {
      if (value > (_marks[key] ?? 0)) _marks[key] = value;
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
    final had = _marks.isNotEmpty || _started;
    _marks.clear();
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
    final value = jsonEncode({'marks': _marks});
    unawaited(store?.write(_key, value).catchError((Object _) {}));
  }

  /// At most [kept] marks: those of chats the Swarm's read no longer has go
  /// first, then the oldest kept.
  void _trim() {
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
    super.dispose();
  }
}
