import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_asks.dart';
import 'swarm_chat_notify.dart';
import 'swarm_inbox.dart' show SwarmListing;
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// One thread the reader follows, as the server lists it (backend
/// read/followedThreads.ts, or read/inbox.ts on a server before it): its
/// root's preview and its newest reply. The desktop's `SuperTabFollowedThread`.
class SwarmFollowedThread {
  SwarmFollowedThread.fromJson(Map<String, dynamic> row)
    : conversationId = row['conversationId'] as String,
      rootId = row['rootId'] as String,
      root = superTabMap(row['root'] ?? const {}),
      lastReplyAt = DateTime.tryParse(row['lastReplyAt'] as String? ?? ''),
      lastReplySequence = (row['lastReplySequence'] as num?)?.toInt() ?? 0,
      lastReplier = row['lastReplier'] is Map
          ? superTabMap(row['lastReplier'])
          : null,
      unreadReplies = (row['unreadReplies'] as num?)?.toInt() ?? 0,
      replies = (row['replies'] as num?)?.toInt(),
      follow = row['follow'] as bool?;

  final String conversationId, rootId;

  /// The root's preview: `id`, `sequence`, `author`, `text` (cut by the
  /// server), `createdAt`.
  final Map<String, dynamic> root;
  final DateTime? lastReplyAt;
  final int lastReplySequence, unreadReplies;

  /// How many replies it has; null in an unread entry from an older server.
  final int? replies;

  /// The reader's own Follow (true) or Unfollow (false); null when it follows
  /// from taking part (started it, replied, tagged).
  final bool? follow;
  final Map<String, dynamic>? lastReplier;

  String get key => '$conversationId/$rootId';
  String get rootText => root['text'] as String? ?? '';
  Map<String, dynamic> get rootAuthor =>
      root['author'] is Map ? superTabMap(root['author']) : const {};
  DateTime? get rootAt => DateTime.tryParse(root['createdAt'] as String? ?? '');
}

/// The threads the reader follows in one Swarm ([reader]) and which have
/// replies they have not read, the desktop's `SuperTabAttention` threads
/// (#2434, #2455): the Threads row and page. Read from the server's
/// followed-threads route when the Swarm moves, at most every [quietGap]
/// (every [openGap] while the page is open), and only while something shows
/// it: a phone with every Swarm on Home asks for none it does not draw.
///
/// Rows of chats the Swarm's read does not list for the reader are never
/// shown, on the server's word alone. Access lost, or who may read what
/// changed ([SwarmReader.generation]), takes everything read away, and an
/// answer on its way then is dropped.
class SwarmThreads extends ChangeNotifier {
  SwarmThreads(this.reader, {this.asks, DateTime Function()? now})
    : _now = now ?? DateTime.now {
    reader.addListener(_changed);
    reader.reads.addListener(_changed);
    asks?.addListener(_told);
    reader.readMarks?.addListener(_told);
  }

  final SwarmReader reader;

  /// The reader's waiting tags here, for [threadMentions]; null counts none.
  final SwarmAsks? asks;
  final DateTime Function() _now;

  static const quietGap = Duration(seconds: 15);
  static const openGap = Duration(seconds: 3);

  /// Busy (429): the next read waits this long.
  static const busyWait = Duration(seconds: 5);

  /// How many replies show under a new thread's root, its newest.
  static const shownReplies = 5;

  /// Followed threads with replies the reader has not read, newest reply
  /// first; and those read, newest reply first.
  List<SwarmFollowedThread> unread = const [], read = const [];

  /// Whether a read has answered since the Swarm was opened or its audience
  /// last changed.
  bool loaded = false;
  String? error;

  /// The server keeps Follow and Unfollow; false on one before them (it
  /// answered 404), which lists only unread threads. Asked again at the next
  /// visit of the page.
  bool followSupported = true;

  /// The server stopped short of everything (its bounds).
  bool more = false;

  /// New replies under each unread thread's root, read when the page showed
  /// it; by [SwarmFollowedThread.key].
  final Map<String, List<SuperTabMessage>> newReplies = {};

  /// Threads whose Follow is being sent.
  final Set<String> following = {};

  /// Threads shown as new in this visit of the page: they stay new until the
  /// page is left, though opening them marked them read.
  final Set<String> _newThisVisit = {};

  /// The new-reply count each thread showed when this visit first listed it
  /// as new: a thread read meanwhile comes back with none, and keeps saying
  /// what it had.
  final Map<String, int> _counts = {};
  final Set<String> _readingReplies = {};

  /// Threads whose replies failed to read this visit: not asked again until
  /// the next one, so a failing read is not repeated on every redraw.
  final Set<String> _repliesFailed = {};

  bool _open = false;

  /// Moves each time the page opens or closes: replies read for one visit
  /// mark nothing once it is over.
  int _visit = 0;
  int? _generation;
  int _lastChangedAt = -1;
  DateTime? _lastRead, _waitUntil;
  Timer? _trailing;
  Future<void>? _loading;
  bool _dirty = false, _disposed = false;
  int _asked = 0, _shown = 0;

  String get _path => '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}';

  /// Whether a followed thread has replies the reader has not read: the
  /// Threads row is bold.
  bool get threadsUnread => unread.isNotEmpty;

  /// The Threads row's number: tags of the reader inside threads they have
  /// not read past, in chats this Swarm lists for them. A muted chat's
  /// threads never count (#2455). None until the phone's marks are back.
  ///
  /// Only threads the Threads page lists count ([unread] and [read]): the
  /// number promises something to open there. A tag in a thread the server
  /// left out (older than its bounds, unfollowed, a root the reader cannot
  /// read) stays in Activity and counts nothing here. None until the list
  /// has been read, and none once it is taken away (access lost).
  int get threadMentions {
    final snapshot = reader.snapshot;
    final marks = reader.readMarks;
    if (reader.accessRevoked || snapshot == null || marks == null || !loaded) {
      return 0;
    }
    final listed = {for (final t in unread) t.key, for (final t in read) t.key};
    var count = 0;
    for (final m in asks?.mentions ?? const <SuperTabMention>[]) {
      final root = m.threadId;
      if (root == null ||
          snapshot.conversation(m.conversationId) == null ||
          !listed.contains('${m.conversationId}/$root')) {
        continue;
      }
      if (reader.notifyOf(m.conversationId) == SwarmNotify.muted) continue;
      final through = marks.threadThrough(m.conversationId, root);
      if (through == null) return 0;
      if ((m.messageSequence ?? _unknown) > through) count++;
    }
    return count;
  }

  /// A tag from a server that does not say where it is: it counts until
  /// answered, past any read mark.
  static const _unknown = 1 << 52;

  /// How many new replies [thread] shows: as many as it had when this visit
  /// first listed it new.
  int newCount(SwarmFollowedThread thread) =>
      _counts[thread.key] ?? thread.unreadReplies;

  /// Whether [thread] shows as new in this visit.
  bool isNew(SwarmFollowedThread thread) =>
      _newThisVisit.contains(thread.key) ||
      unread.any((t) => t.key == thread.key);

  /// The threads the page lists: new ones first, then the rest, each newest
  /// reply first; one read during this visit stays with the new ones.
  List<SwarmFollowedThread> get shown {
    final fresh = <SwarmFollowedThread>[
      ...unread,
      ...read.where((t) => _newThisVisit.contains(t.key)),
    ];
    final keys = fresh.map((t) => t.key).toSet();
    int newest(SwarmFollowedThread a, SwarmFollowedThread b) =>
        (b.lastReplyAt ?? DateTime(0)).compareTo(a.lastReplyAt ?? DateTime(0));
    return [
      ...fresh..sort(newest),
      ...read.where((t) => !keys.contains(t.key)),
    ];
  }

  /// The page opened: reads now, and what is new stays new until [closed].
  void opened() {
    if (_disposed) return;
    _open = true;
    _visit++;
    // A server that answered 404 once may have been updated since.
    followSupported = true;
    _newThisVisit
      ..clear()
      ..addAll(unread.map((t) => t.key));
    _counts
      ..clear()
      ..addAll({for (final t in unread) t.key: t.unreadReplies});
    _repliesFailed.clear();
    _lastRead = null;
    // A read already under way (the row's) answers for the page too.
    if (_loading == null) unawaited(load());
  }

  void closed() {
    if (_disposed) return;
    _open = false;
    _visit++;
    _newThisVisit.clear();
    _counts.clear();
    newReplies.clear();
    _readingReplies.clear();
    _repliesFailed.clear();
    notifyListeners();
  }

  /// Something [threadMentions] reads moved.
  void _told() {
    if (!_disposed) notifyListeners();
  }

  void _clear() {
    unread = read = const [];
    loaded = false;
    error = null;
    more = false;
    _newThisVisit.clear();
    _counts.clear();
    newReplies.clear();
    _readingReplies.clear();
    _repliesFailed.clear();
    following.clear();
    _trailing?.cancel();
    _trailing = null;
    // An answer on its way belongs to what the reader could read before.
    _shown = ++_asked;
  }

  void _changed() {
    if (_disposed) return;
    if (reader.accessRevoked) {
      if (loaded || error != null || unread.isNotEmpty || read.isNotEmpty) {
        _clear();
        notifyListeners();
      } else {
        _shown = ++_asked;
      }
      return;
    }
    // The Home kept from before is no read ([SwarmReader.heldLoad]): nothing
    // is asked on its word.
    if (reader.snapshot == null || reader.heldLoad == 0) return;
    final generation = reader.generation;
    if (generation != _generation) {
      final moved = _generation != null;
      _generation = generation;
      if (moved) {
        // Who may read what changed: nothing read before shows until read
        // again.
        _clear();
        notifyListeners();
        if (!hasListeners) return;
        _lastChangedAt = reader.lastChangedAt;
        unawaited(load());
        return;
      }
    }
    // Read only while something shows it (the Threads row, the page).
    if (!hasListeners) return;
    if (reader.lastChangedAt == _lastChangedAt && loaded) return;
    final now = _now();
    // Inside the gap, or waiting out a refusal: one read when it is over, so
    // the change is not lost.
    final until = [
      if (_waitUntil case final wait? when now.isBefore(wait)) wait,
      if (_lastRead case final last?) last.add(_open ? openGap : quietGap),
    ].fold<DateTime?>(null, (a, b) => a == null || b.isAfter(a) ? b : a);
    if (until != null && now.isBefore(until)) {
      _trailing ??= Timer(until.difference(now), () {
        _trailing = null;
        _changed();
      });
      return;
    }
    _trailing?.cancel();
    _trailing = null;
    _lastChangedAt = reader.lastChangedAt;
    unawaited(load());
  }

  /// Joins a read under way, and has it read once more when asked again.
  Future<void> load() {
    if (_disposed) return Future.value();
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
    if (reader.accessRevoked ||
        reader.snapshot == null ||
        reader.heldLoad == 0) {
      return;
    }
    final asked = ++_asked;
    final generation = reader.generation;
    _lastRead = _now();
    bool current() =>
        !_disposed &&
        !reader.accessRevoked &&
        asked > _shown &&
        reader.generation == generation;
    try {
      Map<String, dynamic>? answer;
      // A server before followed threads (it answers 404): its inbox lists
      // the unread ones, and nothing keeps Follow.
      var full = followSupported;
      if (full) {
        try {
          answer = superTabMap(await reader.request('GET', '$_path/threads'));
        } on SuperTabFailure catch (failure) {
          if (failure.statusCode != 404) rethrow;
          full = false;
        }
      }
      if (!current()) return;
      answer ??= superTabMap(await reader.request('GET', '$_path/inbox'));
      if (!current()) return;
      _shown = asked;
      final readable = {
        for (final g in reader.snapshot?.conversations ?? const []) g.id,
      };
      List<SwarmFollowedThread> rows(Object? list) => [
        for (final row in list is List ? list : const [])
          if (row is Map)
            if (_parse(superTabMap(row)) case final t?
                // Only chats this reader still has; the server checked, and a
                // chat they lost since is not shown on its word alone.
                when readable.contains(t.conversationId))
              t,
      ];
      unread = rows(full ? answer['unread'] : answer['threads']);
      read = full ? rows(answer['read']) : const [];
      followSupported = full;
      more = answer['more'] == true;
      error = null;
      loaded = true;
      if (_open) {
        _newThisVisit.addAll(unread.map((t) => t.key));
        for (final t in unread) {
          _counts.putIfAbsent(t.key, () => t.unreadReplies);
        }
      }
      _waitUntil = null;
      notifyListeners();
    } catch (failure) {
      if (!current()) return;
      _shown = asked;
      if (failure is SuperTabFailure && failure.statusCode == 429) {
        // Asked too often: the next change after a pause reads again.
        _waitUntil = _now().add(busyWait);
      }
      error = 'Could not load threads.';
      notifyListeners();
    }
  }

  static SwarmFollowedThread? _parse(Map<String, dynamic> row) {
    try {
      return SwarmFollowedThread.fromJson(row);
    } catch (_) {
      // A row of another shape is no thread.
      return null;
    }
  }

  /// Reads the replies of [thread] the reader has not read, to show under its
  /// root, then marks the thread read: opening the page reads what it shows
  /// (the desktop's `showReplies`). A read that answers after the visit, or
  /// the reader's access, is over marks nothing.
  Future<void> showReplies(SwarmFollowedThread thread) async {
    if (_disposed ||
        !_open ||
        reader.accessRevoked ||
        newReplies.containsKey(thread.key) ||
        _repliesFailed.contains(thread.key) ||
        !_readingReplies.add(thread.key)) {
      return;
    }
    final generation = reader.generation;
    final visit = _visit;
    final seen =
        reader.readMarks?.threadThrough(thread.conversationId, thread.rootId) ??
        reader.snapshot?.threadMarks[thread.conversationId]?[thread.rootId] ??
        0;
    bool current() =>
        !_disposed &&
        !reader.accessRevoked &&
        reader.generation == generation &&
        _visit == visit &&
        _readingReplies.contains(thread.key);
    try {
      final answer = superTabMap(
        await reader.request(
          'GET',
          '$_path/conversations/${Uri.encodeComponent(thread.conversationId)}'
              '/messages?thread=${Uri.encodeQueryComponent(thread.rootId)}',
        ),
      );
      if (!current()) return;
      final replies = [
        for (final row in answer['messages'] as List? ?? const [])
          if (row is Map)
            if (SuperTabMessage.fromJson(superTabMap(row)) case final m
                when m.conversationId == thread.conversationId &&
                    m.thread == thread.rootId &&
                    m.threadReply &&
                    m.sequence > seen)
              m,
      ]..sort((a, b) => a.sequence.compareTo(b.sequence));
      newReplies[thread.key] = replies.length > shownReplies
          ? replies.sublist(replies.length - shownReplies)
          : replies;
      final through = max(
        thread.lastReplySequence,
        replies.lastOrNull?.sequence ?? 0,
      );
      reader.readMarks?.markThreadRead(
        thread.conversationId,
        thread.rootId,
        through,
      );
      notifyListeners();
    } catch (_) {
      // The thread stays unread and its root shows; the next visit tries
      // again.
      if (current()) _repliesFailed.add(thread.key);
    } finally {
      if (_visit == visit) _readingReplies.remove(thread.key);
    }
  }

  /// Follows (true) or unfollows (false) [thread] on every device of the
  /// reader; false when the server did not keep it.
  Future<bool> setFollow(SwarmFollowedThread thread, bool follow) async {
    if (_disposed ||
        reader.accessRevoked ||
        !followSupported ||
        !following.add(thread.key)) {
      return false;
    }
    final generation = reader.generation;
    notifyListeners();
    try {
      await reader.request(
        'POST',
        '$_path/conversations/${Uri.encodeComponent(thread.conversationId)}'
            '/threads/${Uri.encodeComponent(thread.rootId)}/follow',
        body: {'follow': follow},
      );
      if (_disposed || reader.accessRevoked) return false;
      if (reader.generation == generation) {
        _lastRead = null;
        unawaited(load());
      }
      return true;
    } catch (_) {
      return false;
    } finally {
      if (following.remove(thread.key) && !_disposed) notifyListeners();
    }
  }

  /// The last one showing it went: no read is waited for.
  @override
  void removeListener(VoidCallback listener) {
    super.removeListener(listener);
    if (_disposed || hasListeners) return;
    _trailing?.cancel();
    _trailing = null;
  }

  /// The first one showing it came: what moved while none did is read.
  @override
  void addListener(VoidCallback listener) {
    final first = !hasListeners;
    super.addListener(listener);
    if (first && !_disposed) _changed();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _trailing?.cancel();
    _trailing = null;
    reader.removeListener(_changed);
    reader.reads.removeListener(_changed);
    asks?.removeListener(_told);
    reader.readMarks?.removeListener(_told);
    super.dispose();
  }
}

/// One followed thread on the phone's Threads page, in the Swarm it is in.
typedef SwarmThreadEntry = ({
  String swarmId,
  String swarmName,
  SwarmFollowedThread thread,
});

/// The Threads row and page over the Swarms Home shows ([swarms]): each
/// Swarm's [SwarmThreads] ([source]) in one list, new first, then the rest,
/// each newest reply first; bold while any has new replies, its number the
/// sum of theirs. [changed] tells when the Swarms shown, or their sources,
/// may have changed (the inbox). A Swarm that leaves the list leaves the page
/// at once, with everything read of it.
class SwarmThreadsMerge extends ChangeNotifier {
  SwarmThreadsMerge({
    required this.source,
    required this.swarms,
    required this.changed,
  }) {
    changed.addListener(_sync);
    _sync();
  }

  /// [swarmId]'s threads, while it is listed.
  final SwarmThreads? Function(String swarmId) source;

  /// The Swarms shown, in Home's order.
  final List<SwarmListing> Function() swarms;
  final Listenable changed;

  /// Each Swarm shown with its threads, in Home's order.
  final _sources = <String, (SwarmListing, SwarmThreads)>{};
  bool _open = false, _disposed = false;

  /// How many new threads show their replies when the page opens, as many
  /// as the desktop's `kThreadsShowingReplies`.
  static const showingReplies = 10;

  /// More than one Swarm shown: each row names its Swarm.
  bool get manySwarms => _sources.length > 1;

  /// Every Swarm shown has answered since it was opened, or since who may
  /// read what in it changed; one that failed says so instead ([error]).
  bool get loaded =>
      _sources.values.every((s) => s.$2.loaded || s.$2.error != null);

  /// What the first Swarm that could not be read says; Retry reads those
  /// again ([retry]).
  String? get error =>
      [for (final (_, threads) in _sources.values) ?threads.error].firstOrNull;

  /// A followed thread has replies the person has not read: the row is bold.
  bool get unread => _sources.values.any((s) => s.$2.threadsUnread);

  /// The row's number: tags of the person in threads they have not read past.
  int get mentions =>
      _sources.values.fold(0, (n, s) => n + s.$2.threadMentions);

  /// A Swarm's server stopped short of everything.
  bool get more => _sources.values.any((s) => s.$2.more);

  SwarmThreads? _of(SwarmThreadEntry entry) => _sources[entry.swarmId]?.$2;

  List<SwarmThreadEntry> _entries(bool fresh) {
    final entries = [
      for (final (swarm, threads) in _sources.values)
        for (final thread in threads.shown)
          if (threads.isNew(thread) == fresh)
            (swarmId: swarm.id, swarmName: swarm.name, thread: thread),
    ];
    // One Swarm keeps its own order; several are put together by time.
    if (manySwarms) {
      entries.sort(
        (a, b) => (b.thread.lastReplyAt ?? DateTime(0)).compareTo(
          a.thread.lastReplyAt ?? DateTime(0),
        ),
      );
    }
    return entries;
  }

  /// Threads with new replies this visit, newest reply first.
  List<SwarmThreadEntry> get fresh => _entries(true);

  /// The rest, newest reply first.
  List<SwarmThreadEntry> get rest => _entries(false);

  int newCount(SwarmThreadEntry entry) =>
      _of(entry)?.newCount(entry.thread) ?? 0;

  /// [entry]'s new replies, once read; null until then.
  List<SuperTabMessage>? newReplies(SwarmThreadEntry entry) =>
      _of(entry)?.newReplies[entry.thread.key];

  /// Follow or Unfollow is offered: the server keeps it.
  bool followOffered(SwarmThreadEntry entry) =>
      _of(entry)?.followSupported ?? false;

  /// Follow or Unfollow of [entry] is on its way.
  bool following(SwarmThreadEntry entry) =>
      _of(entry)?.following.contains(entry.thread.key) ?? false;

  /// [entry]'s chat, while its Swarm lists it for the person.
  SuperTabConversation? chat(SwarmThreadEntry entry) =>
      _of(entry)?.reader.snapshot?.conversation(entry.thread.conversationId);

  Future<bool> setFollow(SwarmThreadEntry entry, bool follow) =>
      _of(entry)?.setFollow(entry.thread, follow) ?? Future.value(false);

  /// Reads again each Swarm that could not be read.
  void retry() {
    for (final (_, threads) in _sources.values) {
      if (threads.error != null) unawaited(threads.load());
    }
  }

  /// The page opened: each Swarm shown reads now, and what is new stays new
  /// until [closed].
  void opened() {
    if (_disposed || _open) return;
    _open = true;
    for (final (_, threads) in _sources.values) {
      threads.opened();
    }
  }

  void closed() {
    if (_disposed || !_open) return;
    _open = false;
    for (final (_, threads) in _sources.values) {
      threads.closed();
    }
  }

  /// The page shows its first new threads: their replies are read, and each
  /// is marked read once they are (the desktop's read on open).
  void showReplies() {
    if (_disposed) return;
    for (final entry in fresh.take(showingReplies)) {
      unawaited(_of(entry)?.showReplies(entry.thread));
    }
  }

  void _sync() {
    if (_disposed) return;
    final wanted = <String, (SwarmListing, SwarmThreads)>{
      for (final swarm in swarms())
        if (source(swarm.id) case final threads?) swarm.id: (swarm, threads),
    };
    var moved = wanted.length != _sources.length;
    for (final MapEntry(key: id, value: (_, threads)) in _sources.entries) {
      if (identical(wanted[id]?.$2, threads)) continue;
      moved = true;
      _detach(threads);
    }
    for (final MapEntry(key: id, value: (_, threads)) in wanted.entries) {
      if (identical(_sources[id]?.$2, threads)) continue;
      moved = true;
      threads.addListener(notifyListeners);
      if (_open) threads.opened();
    }
    _sources
      ..clear()
      ..addAll(wanted);
    if (moved) notifyListeners();
  }

  /// A Swarm dropped from the inbox has its threads disposed already: both
  /// are no-ops then.
  void _detach(SwarmThreads threads) {
    threads.removeListener(notifyListeners);
    if (_open) threads.closed();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    changed.removeListener(_sync);
    for (final (_, threads) in _sources.values) {
      _detach(threads);
    }
    _sources.clear();
    super.dispose();
  }
}
