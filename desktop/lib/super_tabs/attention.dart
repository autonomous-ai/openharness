import 'dart:async';

import 'package:flutter/foundation.dart';

import 'controller.dart';
import 'decisions.dart';
import 'model.dart';
import 'notifications.dart';

/// One thread the reader follows, as the server lists it (backend
/// read/followedThreads.ts, or read/inbox.ts on a server before it): its
/// root's preview and its newest reply.
class SuperTabFollowedThread {
  SuperTabFollowedThread.fromJson(Map<String, dynamic> row)
    : conversationId = row['conversationId'] as String,
      rootId = row['rootId'] as String,
      root = superTabMap(row['root']),
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
}

/// What needs the reader in one Swarm, the way Slack shows it: which
/// conversations hold a tag of them (the red number), and which threads they
/// follow have replies they have not read (Activity's New replies). Tags and
/// decisions come from [SuperTabMentions] and [SuperTabDecisions]; threads
/// from the server's followed-threads read, read again when the Swarm moves,
/// at most every [quietGap] (every [openGap] while Activity is open).
/// One per controller.
class SuperTabAttention extends ChangeNotifier {
  SuperTabAttention._(this.controller, {DateTime Function()? now})
    : mentions = SuperTabMentions.of(controller),
      decisions = SuperTabDecisions.of(controller),
      _now = now ?? DateTime.now {
    controller.addListener(_changed);
    controller.onDispose(dispose);
    mentions.addListener(notifyListeners);
    decisions.addListener(notifyListeners);
    _changed();
  }

  /// For a test: an attention reader over [controller] with its own clock.
  @visibleForTesting
  factory SuperTabAttention.forTest(
    SuperTabController controller, {
    DateTime Function()? now,
  }) => SuperTabAttention._(controller, now: now);

  static final _all = Expando<SuperTabAttention>();
  static SuperTabAttention of(SuperTabController controller) =>
      _all[controller] ??= SuperTabAttention._(controller);

  final SuperTabController controller;
  final SuperTabMentions mentions;
  final SuperTabDecisions decisions;
  final DateTime Function() _now;

  static const quietGap = Duration(seconds: 15);
  static const openGap = Duration(seconds: 3);

  /// Followed threads with replies the reader has not read, newest reply
  /// first; and those read, newest reply first.
  List<SuperTabFollowedThread> unread = const [], read = const [];

  /// Whether a read has answered since the Swarm was opened or its audience
  /// last changed.
  bool loaded = false;
  String? error;

  /// The server keeps Follow and Unfollow; false on one before them, which
  /// lists only unread threads.
  bool followSupported = true;

  /// The server stopped short of everything (its bounds).
  bool more = false;

  /// Threads shown as new in this visit of Activity: they stay new
  /// until the view is left, though opening them marked them read.
  final Set<String> _newThisVisit = {};
  bool _open = false;

  /// Threads whose Follow is being sent.
  final Set<String> following = {};

  /// The new-reply count each thread showed when this visit first listed it
  /// as new: a thread read meanwhile comes back with none, and keeps saying
  /// what it had.
  final Map<String, int> _counts = {};

  /// A read for a change that came inside the gap, once the gap is over.
  Timer? _trailing;

  int? _epoch;
  int _lastChangedAt = -1;
  DateTime? _lastRead, _waitUntil;
  Future<void>? _loading;
  bool _dirty = false, _disposed = false;
  int _asked = 0, _shown = 0;

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}';

  /// Unread tags Activity shows under Needs you for [conversationId]. A tag
  /// in a followed thread that is new in this visit is represented by New
  /// replies instead; other unread thread tags need the reader and belong on
  /// the conversation row.
  int tagsIn(String conversationId) {
    if (controller.accessRevoked) return 0;
    // A muted chat never counts (Slack); its tags stay listed in Activity.
    if (controller.notifyOf(conversationId) == SuperTabNotify.muted) return 0;
    final newThreads = {
      for (final thread in shown)
        if (isNew(thread)) thread.key,
    };
    return mentions.waiting.where((m) {
      if (m.conversationId != conversationId) return false;
      final mark = m.threadId == null
          ? controller.readMark(conversationId)
          : controller.threadReadMark(m.threadId!);
      return (m.messageSequence ?? _unknown) > mark &&
          (m.threadId == null ||
              !newThreads.contains('$conversationId/${m.threadId}'));
    }).length;
  }

  /// Open decisions Activity shows as Needs you for [conversationId].
  int decisionsIn(String conversationId) {
    if (controller.accessRevoked ||
        controller.notifyOf(conversationId) == SuperTabNotify.muted) {
      return 0;
    }
    final asked = decisions.open
        .where((decision) => decision.conversationId == conversationId)
        .length;
    if (asked == 0) return 0;
    final group = controller.snapshot?.conversation(conversationId);
    return group != null && controller.unreadShown(group) ? asked : 0;
  }

  /// The red number of [conversationId]: tags and decisions Activity shows
  /// under Needs you for this conversation. Nothing counts once access is
  /// gone.
  int mentionsIn(String conversationId) =>
      tagsIn(conversationId) + decisionsIn(conversationId);

  /// Whether [threadId] contains an unread tag of the reader.
  bool hasUnreadTagInThread(String conversationId, String threadId) {
    if (controller.accessRevoked ||
        controller.notifyOf(conversationId) == SuperTabNotify.muted) {
      return false;
    }
    final mark = controller.threadReadMark(threadId);
    return mentions.waiting.any(
      (mention) =>
          mention.conversationId == conversationId &&
          mention.threadId == threadId &&
          (mention.messageSequence ?? _unknown) > mark,
    );
  }

  /// A tag from a server that does not say where it is: it counts until
  /// answered, past any read mark.
  static const _unknown = 9007199254740991;

  /// The number of tags of the reader inside threads they have
  /// not read past, in chats this Swarm still lists for them. A muted chat's
  /// threads never count, as its main stream does not ([mentionsIn]).
  ///
  /// Only threads Activity lists count ([unread] and [read]): the
  /// number promises something to open there. A tag in a thread the server
  /// left out (older than its bounds, unfollowed, a root the reader cannot
  /// read) stays in Activity, and counts nothing here. None until the list
  /// has been read.
  int get threadMentions {
    final snapshot = controller.snapshot;
    if (controller.accessRevoked || snapshot == null || !loaded) return 0;
    final chats = {for (final g in snapshot.conversations) g.id};
    final listed = {for (final t in unread) t.key, for (final t in read) t.key};
    return mentions.waiting
        .where(
          (m) =>
              m.threadId != null &&
              chats.contains(m.conversationId) &&
              listed.contains('${m.conversationId}/${m.threadId}') &&
              controller.notifyOf(m.conversationId) != SuperTabNotify.muted &&
              (m.messageSequence ?? _unknown) >
                  controller.threadReadMark(m.threadId!),
        )
        .length;
  }

  /// How many new replies [thread] shows: as many as it had when this visit
  /// first listed it new.
  int newCount(SuperTabFollowedThread thread) =>
      _counts[thread.key] ?? thread.unreadReplies;

  /// Whether a followed thread has replies the reader has not read: the
  /// Threads row is bold.
  bool get threadsUnread => unread.isNotEmpty;

  /// Whether [thread] shows as new in this visit.
  bool isNew(SuperTabFollowedThread thread) =>
      _newThisVisit.contains(thread.key) ||
      unread.any((t) => t.key == thread.key);

  /// The threads the view lists: new ones first, then the rest, each newest
  /// reply first; one read during this visit stays with the new ones.
  List<SuperTabFollowedThread> get shown {
    final fresh = <SuperTabFollowedThread>[
      ...unread,
      ...read.where((t) => _newThisVisit.contains(t.key)),
    ];
    final keys = fresh.map((t) => t.key).toSet();
    int newest(SuperTabFollowedThread a, SuperTabFollowedThread b) =>
        (b.lastReplyAt ?? DateTime(0)).compareTo(a.lastReplyAt ?? DateTime(0));
    return [
      ...fresh..sort(newest),
      ...read.where((t) => !keys.contains(t.key)),
    ];
  }

  /// The Threads view opened: reads now, and what is new stays new until
  /// [closed].
  void opened() {
    _open = true;
    _newThisVisit
      ..clear()
      ..addAll(unread.map((t) => t.key));
    _counts
      ..clear()
      ..addAll({for (final t in unread) t.key: t.unreadReplies});
    unawaited(load());
  }

  void closed() {
    _open = false;
    _trailing?.cancel();
    _trailing = null;
    _newThisVisit.clear();
    _counts.clear();
    if (!_disposed) notifyListeners();
  }

  void _clear() {
    unread = read = const [];
    loaded = false;
    error = null;
    more = false;
    _newThisVisit.clear();
    _counts.clear();
    _trailing?.cancel();
    _trailing = null;
  }

  void _changed() {
    if (_disposed) return;
    if (controller.accessRevoked) {
      if (loaded || unread.isNotEmpty || read.isNotEmpty) {
        _clear();
        // An answer on its way belongs to the access that is gone.
        _shown = ++_asked;
        notifyListeners();
      }
      return;
    }
    if (controller.snapshot == null) return;
    final epoch = controller.visibilityEpoch;
    if (epoch != null && epoch != _epoch) {
      final moved = _epoch != null;
      _epoch = epoch;
      if (moved) {
        // Who may read what changed: nothing read before shows until read
        // again.
        _clear();
        _shown = ++_asked;
        notifyListeners();
        _lastChangedAt = controller.lastChangedAt;
        unawaited(load());
        return;
      }
    }
    if (controller.lastChangedAt == _lastChangedAt && loaded) return;
    final now = _now();
    // Inside the gap, or waiting out a refusal: one read when it is over, so
    // the change is not lost.
    final until = [
      if (_waitUntil case final wait? when now.isBefore(wait)) wait,
      if (_lastRead case final last?) last.add(_open ? openGap : quietGap),
    ].fold<DateTime?>(null, (a, b) => a == null || b.isAfter(a) ? b : a);
    if (until != null && now.isBefore(until)) {
      // Only while something shows it (the sidebar, Activity).
      if (!hasListeners) return;
      _trailing ??= Timer(until.difference(now), () {
        _trailing = null;
        _changed();
      });
      return;
    }
    _trailing?.cancel();
    _trailing = null;
    _lastChangedAt = controller.lastChangedAt;
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
    if (controller.accessRevoked || controller.snapshot == null) return;
    final asked = ++_asked;
    final epoch = controller.visibilityEpoch;
    _lastRead = _now();
    bool current() =>
        !_disposed &&
        !controller.accessRevoked &&
        asked > _shown &&
        controller.visibilityEpoch == epoch;
    try {
      Map<String, dynamic>? answer;
      // A server before followed threads (it answered 404 once): its inbox
      // lists the unread ones, and nothing keeps Follow.
      var full = followSupported;
      if (full) {
        try {
          answer = await controller.request('GET', '$_path/threads');
        } on SuperTabFailure catch (failure) {
          if (failure.statusCode != 404) rethrow;
          full = false;
        }
      }
      answer ??= await controller.request('GET', '$_path/inbox');
      if (!current()) return;
      _shown = asked;
      final unreadRows = (full ? answer['unread'] : answer['threads']) as List;
      final readable = {
        for (final g in controller.snapshot?.conversations ?? const []) g.id,
      };
      List<SuperTabFollowedThread> rows(List list) => [
        for (final row in list)
          if (SuperTabFollowedThread.fromJson(superTabMap(row)) case final t
              // Only chats this reader still has; the server checked, and a
              // chat they lost since is not shown on its word alone.
              when readable.contains(t.conversationId))
            t,
      ];
      unread = rows(unreadRows);
      read = full ? rows(answer['read'] as List? ?? const []) : const [];
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
        _waitUntil = _now().add(const Duration(seconds: 5));
      }
      error = 'Could not load threads.';
      notifyListeners();
    }
  }

  /// Follows (true) or unfollows (false) [thread] on every device of the
  /// reader; false when the server did not keep it.
  Future<bool> setFollow(SuperTabFollowedThread thread, bool follow) async {
    if (_disposed ||
        controller.accessRevoked ||
        !followSupported ||
        !following.add(thread.key)) {
      return false;
    }
    notifyListeners();
    try {
      await controller.request(
        'POST',
        '$_path/conversations/${Uri.encodeComponent(thread.conversationId)}'
            '/threads/${Uri.encodeComponent(thread.rootId)}/follow',
        body: {'follow': follow},
      );
      if (_disposed) return false;
      _lastRead = null;
      unawaited(load());
      return true;
    } catch (_) {
      return false;
    } finally {
      following.remove(thread.key);
      if (!_disposed) notifyListeners();
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

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _trailing?.cancel();
    _trailing = null;
    controller.removeListener(_changed);
    mentions.removeListener(notifyListeners);
    decisions.removeListener(notifyListeners);
    super.dispose();
  }
}
