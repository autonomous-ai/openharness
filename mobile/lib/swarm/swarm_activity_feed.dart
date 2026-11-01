import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// What a server Activity row is: a reply to the person's message, or a
/// reaction to it (backend superTabs/activity.ts).
enum SwarmActivityKind { reply, reaction }

/// One reply to the person's message, or one reaction to it, as the server
/// lists it: the desktop's `SuperTabActivityItem`.
class SwarmActivityEntry {
  SwarmActivityEntry.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      kind = row['kind'] == 'reaction'
          ? SwarmActivityKind.reaction
          : SwarmActivityKind.reply,
      conversationId = row['conversationId'] as String,
      messageId = row['messageId'] as String,
      threadId = row['threadId'] as String?,
      actorKind = switch (row['actor']) {
        {'kind': 'person'} => 'person',
        _ => 'agent',
      },
      actorId = switch (row['actor']) {
        {'id': final String id} => id,
        _ => '',
      },
      actorName = switch (row['actor']) {
        {'name': final String name} => name,
        _ => '',
      },
      emoji = row['emoji'] as String?,
      text = row['text'] as String? ?? '',
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? ''),
      read = row['read'] == true;

  SwarmActivityEntry._read(SwarmActivityEntry e)
    : id = e.id,
      kind = e.kind,
      conversationId = e.conversationId,
      messageId = e.messageId,
      threadId = e.threadId,
      actorKind = e.actorKind,
      actorId = e.actorId,
      actorName = e.actorName,
      emoji = e.emoji,
      text = e.text,
      createdAt = e.createdAt,
      read = true;

  final String id, conversationId, messageId;
  final SwarmActivityKind kind;

  /// The thread a reply that lives only there is in; null in the main stream.
  final String? threadId;

  /// Who replied or reacted: `person` or `agent`, its id, and the server's
  /// name for it — used only for an agent the Swarm no longer lists.
  final String actorKind, actorId, actorName;

  /// The reaction (`thumbs_up`, `check`, …); null for a reply.
  final String? emoji;

  /// The reply's text, or the reacted message's.
  final String text;
  final DateTime? createdAt;

  /// Read on some device ([SwarmActivityFeed.markShownRead]).
  final bool read;
}

/// One Swarm's replies and reactions to the person, read from the server
/// (`/activity`, #2453) as Desktop's `SuperTabActivity` reads them: when the
/// Swarm's Activity digest moves or Activity opens, never on a timer; marked
/// read on every device (`/activity/read`) once Activity is left.
///
/// A server before Activity sends no digest, or answers 404: [fromServer] is
/// false, and Activity builds this Swarm's rows on the phone as before.
///
/// Rows show only for chats [reader] holds: a chat the person lost since is
/// not shown on the server's word alone. A read asked before access moved
/// ([SwarmReader.generation]), before the person left, or before a newer
/// read answered changes nothing.
class SwarmActivityFeed extends ChangeNotifier {
  SwarmActivityFeed(this.reader) {
    reader.addListener(_changed);
    _changed();
  }

  final SwarmReader reader;

  /// Replies and reactions, newest first, in chats [reader] holds.
  List<SwarmActivityEntry> items = const [];

  /// Read once since access last moved; [error] says whether it failed.
  bool loaded = false;

  /// The server had older rows than it listed.
  bool more = false;
  String? error;

  /// The server answered 404 to the list: it has no Activity.
  bool _refused = false;

  /// Rows unread when Activity opened, or that came in while it was open:
  /// bold until it is left, though another device read them meanwhile.
  final _newThisVisit = <String>{};
  bool _open = false;

  String? _digest, _failedDigest;
  int? _generation;
  Future<void>? _loading;
  bool _dirty = false, _disposed = false;
  int _asked = 0, _shown = 0;
  DateTime? _waitUntil;
  Timer? _retry;

  /// How long a refused-for-load read waits before its one try more.
  static const busyWait = Duration(seconds: 5);

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/activity';

  /// This Swarm's replies and reactions come from the server: it sends an
  /// Activity digest and has not answered 404.
  bool get fromServer =>
      !_refused &&
      !reader.accessRevoked &&
      reader.snapshot?.activityDigest != null;

  /// Whether [entry] shows bold.
  bool isUnread(SwarmActivityEntry entry) =>
      !entry.read || _newThisVisit.contains(entry.id);

  /// Replies not read on any device: what the Activity badge adds.
  int get unreadReplies =>
      items.where((e) => e.kind == SwarmActivityKind.reply && !e.read).length;

  /// Activity is in sight: reads now; what is unread stays bold until
  /// [closed].
  void opened() {
    if (_disposed) return;
    _open = true;
    _newThisVisit
      ..clear()
      ..addAll(items.where((e) => !e.read).map((e) => e.id));
    if (fromServer) unawaited(load());
  }

  /// Activity was left: the rows of [shown] (ids) are read on every device,
  /// as far as no unread row it did not show comes before them.
  void closed(Set<String> shown) {
    if (!_open || _disposed) return;
    _open = false;
    _newThisVisit.clear();
    // The screen is going away while this runs (its dispose): what listens
    // is told after the frame's teardown, never during it.
    scheduleMicrotask(() {
      if (_disposed) return;
      unawaited(markShownRead(shown));
      notifyListeners();
    });
  }

  /// Marks read, on every device, the unread rows up to the newest moment
  /// before which every unread row is in [shown]: the server marks by time
  /// (`through`), and a row the person never had in front of them must not
  /// go read with the others.
  @visibleForTesting
  Future<void> markShownRead(Set<String> shown) async {
    if (!fromServer || _disposed) return;
    final unread = [
      for (final e in items)
        if (!e.read && e.createdAt != null) e,
    ]..sort((a, b) => a.createdAt!.compareTo(b.createdAt!));
    DateTime? through;
    for (var i = 0; i < unread.length; i++) {
      if (!shown.contains(unread[i].id)) break;
      final at = unread[i].createdAt!;
      // A row at the same moment that was not shown holds this one back too.
      final tie = unread.skip(i + 1).takeWhile((e) => e.createdAt == at);
      if (tie.any((e) => !shown.contains(e.id))) break;
      through = at;
    }
    // An undated row the server holds would go read with no time to say so.
    if (through == null) return;
    final generation = reader.generation;
    items = [
      for (final e in items)
        if (!e.read && e.createdAt != null && !e.createdAt!.isAfter(through))
          SwarmActivityEntry._read(e)
        else
          e,
    ];
    notifyListeners();
    try {
      await reader.request(
        'POST',
        '$_path/read',
        body: {'through': through.toUtc().toIso8601String()},
      );
    } catch (_) {
      // Unread again as the server still has it: read once more now.
      if (!_disposed && reader.generation == generation) {
        _digest = null;
        unawaited(load());
      }
    }
  }

  /// The person's Try again.
  void retry() {
    _failedDigest = null;
    _waitUntil = null;
    unawaited(load());
  }

  void _clear() {
    items = const [];
    loaded = false;
    more = false;
    error = null;
    _newThisVisit.clear();
    _retry?.cancel();
    _retry = null;
    // An answer on its way belongs to what was held before.
    _shown = ++_asked;
    _digest = _failedDigest = null;
  }

  void _changed() {
    if (_disposed) return;
    if (reader.accessRevoked) {
      if (loaded || items.isNotEmpty || error != null || _loading != null) {
        _clear();
        notifyListeners();
      }
      return;
    }
    final snapshot = reader.snapshot;
    if (snapshot == null) return;
    if (_generation != reader.generation) {
      final moved = _generation != null;
      _generation = reader.generation;
      // Read again from nothing: what was read before shows no more until
      // read again.
      if (moved && (loaded || items.isNotEmpty)) {
        _clear();
        notifyListeners();
      }
    }
    // Rows of a chat the reader no longer holds go at once.
    final held = items
        .where((e) => snapshot.conversation(e.conversationId) != null)
        .toList();
    if (held.length != items.length) {
      items = List.unmodifiable(held);
      notifyListeners();
    }
    final digest = snapshot.activityDigest;
    if (digest == null || _refused) return;
    if (digest == _digest && loaded) return;
    // A read that failed is tried again when the digest moves, or by the
    // person's Try again: not at every read of the Swarm.
    if (digest == _failedDigest) return;
    _digest = digest;
    unawaited(load());
  }

  /// Joins a read under way, and has it read once more when asked again.
  Future<void> load() {
    if (_disposed || _refused) return Future.value();
    if (_loading case final running?) {
      _dirty = true;
      return running;
    }
    return _loading = () async {
      do {
        _dirty = false;
        await _read();
      } while (_dirty && !_disposed);
    }().whenComplete(() => _loading = null);
  }

  Future<void> _read() async {
    if (reader.accessRevoked || reader.snapshot == null) return;
    if (_waitUntil case final wait? when DateTime.now().isBefore(wait)) {
      // Asked too often: one read when the wait is over, no more.
      _retry ??= Timer(wait.difference(DateTime.now()), () {
        _retry = null;
        unawaited(load());
      });
      return;
    }
    final asked = ++_asked;
    final generation = reader.generation;
    final digest = reader.snapshot?.activityDigest;
    bool current() =>
        !_disposed &&
        !reader.accessRevoked &&
        asked > _shown &&
        reader.generation == generation;
    try {
      final answer = superTabMap(await reader.request('GET', _path));
      if (!current()) return;
      _shown = asked;
      final snapshot = reader.snapshot;
      final read = <SwarmActivityEntry>[];
      for (final row in answer['items'] as List? ?? const []) {
        final SwarmActivityEntry entry;
        try {
          entry = SwarmActivityEntry.fromJson(superTabMap(row));
        } catch (_) {
          // A row this build cannot read is left out, not the list.
          continue;
        }
        // Only chats this reader holds; a chat lost since is not shown on
        // the server's word alone.
        if (snapshot?.conversation(entry.conversationId) == null) continue;
        read.add(entry);
      }
      items = List.unmodifiable(read);
      more = answer['more'] == true;
      loaded = true;
      error = null;
      _failedDigest = null;
      _waitUntil = null;
      if (_open) {
        _newThisVisit.addAll(items.where((e) => !e.read).map((e) => e.id));
      }
      notifyListeners();
    } catch (failure) {
      if (!current()) return;
      _shown = asked;
      if (failure is SuperTabFailure && failure.statusCode == 404) {
        // A server before Activity: the phone builds these rows itself.
        _refused = true;
        items = const [];
        loaded = true;
        error = null;
        notifyListeners();
        return;
      }
      if (failure is SuperTabFailure && failure.statusCode == 429) {
        _waitUntil = DateTime.now().add(busyWait);
        // One read when the wait is over.
        _retry ??= Timer(busyWait, () {
          _retry = null;
          unawaited(load());
        });
      }
      _digest = null;
      _failedDigest = digest;
      loaded = true;
      error = 'Could not load activity.';
      notifyListeners();
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _retry?.cancel();
    reader.removeListener(_changed);
    super.dispose();
  }
}
