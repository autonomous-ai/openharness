import 'dart:async';
import 'dart:math';

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
/// follow have replies they have not read (the Threads row and view). Tags and
/// decisions come from [SuperTabMentions] and [SuperTabDecisions]; threads
/// from the server's followed-threads read, read again when the Swarm moves,
/// at most every [quietGap] (every [openGap] while the Threads view is open).
/// One per controller.
class SuperTabAttention extends ChangeNotifier {
  SuperTabAttention._(this.controller, {DateTime Function()? now})
    : mentions = SuperTabMentions.of(controller),
      decisions = SuperTabDecisions.of(controller),
      _now = now ?? DateTime.now {
    controller.addListener(_changed);
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

  /// Threads shown as new in this visit of the Threads view: they stay new
  /// until the view is left, though opening them marked them read.
  final Set<String> _newThisVisit = {};
  bool _open = false;

  /// New replies under each unread thread's root, read when the view showed
  /// it; by [SuperTabFollowedThread.key].
  final Map<String, List<SuperTabMessage>> newReplies = {};
  final Set<String> _readingReplies = {};

  /// Threads whose replies failed to read this visit: not asked again until
  /// the next one, so a failing read is not repeated on every redraw.
  final Set<String> _repliesFailed = {};

  /// Threads whose Follow is being sent.
  final Set<String> following = {};

  int? _epoch;
  int _lastChangedAt = -1;
  DateTime? _lastRead, _waitUntil;
  Future<void>? _loading;
  bool _dirty = false, _disposed = false;
  int _asked = 0, _shown = 0;

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}';

  /// The red number of [conversationId]: tags of the reader in its main
  /// stream, and decisions asked of them there (an agent asking a person to
  /// decide tags them). A tag in a reply that lives only in its thread counts
  /// on Threads instead.
  int mentionsIn(String conversationId) =>
      mentions.waiting
          .where(
            (m) => m.conversationId == conversationId && m.threadId == null,
          )
          .length +
      decisions.open.where((d) => d.conversationId == conversationId).length;

  /// The Threads row's number: tags of the reader inside threads.
  int get threadMentions =>
      mentions.waiting.where((m) => m.threadId != null).length;

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
    unawaited(load());
  }

  void closed() {
    _open = false;
    _newThisVisit.clear();
    newReplies.clear();
    _repliesFailed.clear();
    notifyListeners();
  }

  void _clear() {
    unread = read = const [];
    loaded = false;
    error = null;
    more = false;
    _newThisVisit.clear();
    newReplies.clear();
    _readingReplies.clear();
    _repliesFailed.clear();
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
    if (_waitUntil case final until? when now.isBefore(until)) return;
    if (_lastRead case final last?
        when now.difference(last) < (_open ? openGap : quietGap)) {
      return;
    }
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
      if (_open) _newThisVisit.addAll(unread.map((t) => t.key));
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

  /// Reads the replies of [thread] the reader has not read, to show under its
  /// root, then marks the thread read: opening the view reads what it shows.
  Future<void> showReplies(SuperTabFollowedThread thread) async {
    if (_disposed ||
        controller.accessRevoked ||
        newReplies.containsKey(thread.key) ||
        _repliesFailed.contains(thread.key) ||
        !_readingReplies.add(thread.key)) {
      return;
    }
    final epoch = controller.visibilityEpoch;
    final seen = controller.threadReadMark(thread.rootId);
    try {
      final answer = await controller.request(
        'GET',
        '$_path/conversations/${Uri.encodeComponent(thread.conversationId)}'
            '/messages?thread=${Uri.encodeQueryComponent(thread.rootId)}',
      );
      if (_disposed ||
          controller.accessRevoked ||
          controller.visibilityEpoch != epoch ||
          !_readingReplies.contains(thread.key)) {
        return;
      }
      final replies = [
        for (final row in answer['messages'] as List? ?? const [])
          if (SuperTabMessage.fromJson(superTabMap(row)) case final m
              when m.conversationId == thread.conversationId &&
                  m.thread == thread.rootId &&
                  m.threadReply &&
                  m.sequence > seen)
            m,
      ]..sort(superTabMessageOrder);
      newReplies[thread.key] = replies.length > 5
          ? replies.sublist(replies.length - 5)
          : replies;
      final through = max(
        thread.lastReplySequence,
        replies.lastOrNull?.sequence ?? 0,
      );
      controller.markThreadRead(thread.conversationId, thread.rootId, through);
      notifyListeners();
    } catch (_) {
      // The thread stays unread and its root shows; the next visit tries again.
      _repliesFailed.add(thread.key);
    } finally {
      _readingReplies.remove(thread.key);
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

  @override
  void dispose() {
    _disposed = true;
    controller.removeListener(_changed);
    mentions.removeListener(notifyListeners);
    decisions.removeListener(notifyListeners);
    super.dispose();
  }
}
