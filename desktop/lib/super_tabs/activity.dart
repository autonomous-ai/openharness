import 'dart:async';

import 'package:flutter/foundation.dart';

import 'controller.dart';
import 'decisions.dart';
import 'model.dart';
import 'notifications.dart';

/// One reply to the reader's message, or one reaction to it, as the server
/// lists it (backend superTabs/activity.ts).
class SuperTabActivityItem {
  SuperTabActivityItem.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      kind = row['kind'] == 'reaction'
          ? SuperTabActivityKind.reaction
          : SuperTabActivityKind.reply,
      conversationId = row['conversationId'] as String,
      conversationTitle = row['conversationTitle'] as String? ?? '',
      projectName = row['projectName'] as String? ?? '',
      messageId = row['messageId'] as String,
      messageSequence = (row['messageSequence'] as num?)?.toInt() ?? 0,
      threadId = row['threadId'] as String?,
      actor = superTabMap(row['actor']),
      emoji = row['emoji'] as String?,
      text = row['text'] as String? ?? '',
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? ''),
      read = row['read'] == true;

  final String id, conversationId, conversationTitle, projectName, messageId;
  final SuperTabActivityKind kind;
  final int messageSequence;

  /// The thread a reply that lives only there is in; null in the main stream.
  final String? threadId;

  /// `kind` (person | agent), `id` and `name`, named by the server.
  final Map<String, dynamic> actor;

  /// The reaction (`thumbs_up`, `check`, …); null for a reply.
  final String? emoji;

  /// The reply's text, or the reacted message's.
  final String text;
  final DateTime? createdAt;
  final bool read;

  String get actorName => actor['name'] as String? ?? 'Someone';
  String? get actorId => actor['id'] as String?;
  bool get byAgent => actor['kind'] == 'agent';

  SuperTabActivityItem _asRead() =>
      SuperTabActivityItem.fromJson({..._json, 'read': true});

  Map<String, dynamic> get _json => {
    'id': id,
    'kind': kind.name,
    'conversationId': conversationId,
    'conversationTitle': conversationTitle,
    'projectName': projectName,
    'messageId': messageId,
    'messageSequence': messageSequence,
    'threadId': threadId,
    'actor': actor,
    'emoji': emoji,
    'text': text,
    'createdAt': createdAt?.toIso8601String(),
    'read': read,
  };
}

enum SuperTabActivityKind { reply, reaction }

/// What the Activity view lists, as Slack's tabs: everything, or one kind.
enum SuperTabActivityFilter { all, decisions, mentions, replies, reactions }

/// The reader's Activity in one Swarm (Slack's Activity): decisions asked of
/// them and their tags ([SuperTabDecisions], [SuperTabMentions]), with the
/// replies to their messages and the reactions to them, read from the server
/// when its digest moves or the view opens — never on a timer. Rows the view
/// showed are marked read on every device when it is left, as the Threads
/// view reads what it shows. One per controller.
class SuperTabActivity extends ChangeNotifier {
  SuperTabActivity._(this.controller)
    : mentions = SuperTabMentions.of(controller),
      decisions = SuperTabDecisions.of(controller) {
    controller.addListener(_changed);
    controller.onDispose(dispose);
    mentions.addListener(notifyListeners);
    decisions.addListener(notifyListeners);
    _changed();
  }

  @visibleForTesting
  factory SuperTabActivity.forTest(SuperTabController controller) =>
      SuperTabActivity._(controller);

  static final _all = Expando<SuperTabActivity>();
  static SuperTabActivity of(SuperTabController controller) =>
      _all[controller] ??= SuperTabActivity._(controller);

  final SuperTabController controller;
  final SuperTabMentions mentions;
  final SuperTabDecisions decisions;

  /// Replies and reactions, newest first, in chats this Swarm still lists.
  List<SuperTabActivityItem> items = const [];
  bool loaded = false, more = false;
  String? error;

  /// False on a server before Activity (it answered 404): replies and
  /// reactions are not listed, and nothing is asked again.
  bool supported = true;

  SuperTabActivityFilter filter = SuperTabActivityFilter.all;
  bool _open = false;

  /// Rows shown as unread in this visit: they stay bold until the view is
  /// left, though reading them on another device cleared them.
  final Set<String> _newThisVisit = {};

  String? _digest;
  int? _epoch;
  Future<void>? _loading;
  bool _dirty = false, _disposed = false;
  int _asked = 0, _shown = 0;
  DateTime? _waitUntil;
  Timer? _retry;

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}';

  /// Whether [item] shows bold.
  bool isUnread(SuperTabActivityItem item) =>
      !item.read || _newThisVisit.contains(item.id);

  /// Whether [mention] shows bold: waiting and not read past, as its chat's
  /// red number counts it (attention.dart).
  bool mentionUnread(SuperTabMention mention) =>
      mention.resolvedBy == null &&
      (mention.messageSequence ?? (1 << 52)) >
          (mention.threadId == null
              ? controller.readMark(mention.conversationId)
              : controller.threadReadMark(mention.threadId!));

  /// The Activity row's red number: what is the reader's own to answer, as
  /// Notifications counted it (their tags and decisions), and replies to them
  /// not yet seen. Reactions only make the row bold, as in Slack.
  int get count {
    final snapshot = controller.snapshot;
    if (controller.accessRevoked || snapshot == null) return 0;
    return snapshot.mentionsWaiting +
        snapshot.decisionsWaiting +
        items
            .where((i) => i.kind == SuperTabActivityKind.reply && !i.read)
            .length;
  }

  /// Whether the Activity row is bold: anything unread in it.
  bool get unread => count > 0 || items.any((i) => !i.read);

  /// The view opened: reads now; what is unread stays bold until [closed].
  void opened() {
    _open = true;
    _newThisVisit
      ..clear()
      ..addAll(items.where((i) => !i.read).map((i) => i.id));
    unawaited(load());
    unawaited(mentions.load());
  }

  /// The view was left: what it showed is read on every device.
  void closed() {
    if (!_open) return;
    _open = false;
    _newThisVisit.clear();
    // The view is going away while this runs (its dispose): what listens is
    // told after the frame's teardown, never during it.
    scheduleMicrotask(() {
      if (_disposed) return;
      unawaited(_markShownRead());
      notifyListeners();
    });
  }

  void setFilter(SuperTabActivityFilter value) {
    if (filter == value) return;
    filter = value;
    notifyListeners();
  }

  Future<void> _markShownRead() async {
    final newest = items
        .where((i) => !i.read)
        .map((i) => i.createdAt)
        .whereType<DateTime>()
        .fold<DateTime?>(null, (a, b) => a == null || b.isAfter(a) ? b : a);
    if (newest == null || !supported || controller.accessRevoked) return;
    final epoch = controller.visibilityEpoch;
    // Shown read at once; the server's answer is the next read's.
    items = [
      for (final i in items)
        if (!i.read && !i.createdAt!.isAfter(newest)) i._asRead() else i,
    ];
    notifyListeners();
    try {
      await controller.request(
        'POST',
        '$_path/activity/read',
        body: {'through': newest.toUtc().toIso8601String()},
      );
    } catch (_) {
      // Unread again on the next read; nothing else to do.
      if (!_disposed && controller.visibilityEpoch == epoch) {
        _digest = null;
      }
    }
  }

  void _clear() {
    items = const [];
    loaded = false;
    more = false;
    error = null;
    _newThisVisit.clear();
    _retry?.cancel();
    _retry = null;
  }

  void _changed() {
    if (_disposed) return;
    if (controller.accessRevoked) {
      if (loaded || items.isNotEmpty || error != null) {
        _clear();
        // An answer on its way belongs to the access that is gone.
        _shown = ++_asked;
        _digest = null;
        notifyListeners();
      }
      return;
    }
    final snapshot = controller.snapshot;
    if (snapshot == null) return;
    final epoch = controller.visibilityEpoch;
    if (epoch != null && epoch != _epoch) {
      final moved = _epoch != null;
      _epoch = epoch;
      if (moved) {
        // Who may read what changed: nothing read before shows until read
        // again.
        _clear();
        _shown = ++_asked;
        _digest = null;
        notifyListeners();
      }
    }
    // A server before Activity sends no digest: nothing to read.
    final digest = snapshot.activityDigest;
    if (digest == null || !supported) return;
    if (digest == _digest && loaded) return;
    _digest = digest;
    unawaited(load());
  }

  /// Joins a read under way, and has it read once more when asked again.
  Future<void> load() {
    if (_disposed || !supported) return Future.value();
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
    if (_waitUntil case final wait? when DateTime.now().isBefore(wait)) {
      // Asked too often: one read when the wait is over, no more.
      _retry ??= Timer(wait.difference(DateTime.now()), () {
        _retry = null;
        unawaited(load());
      });
      return;
    }
    final asked = ++_asked;
    final epoch = controller.visibilityEpoch;
    bool current() =>
        !_disposed &&
        !controller.accessRevoked &&
        asked > _shown &&
        controller.visibilityEpoch == epoch;
    try {
      final answer = await controller.request('GET', '$_path/activity');
      if (!current()) return;
      _shown = asked;
      final readable = {
        for (final g in controller.snapshot?.conversations ?? const []) g.id,
      };
      items = [
        for (final row in answer['items'] as List? ?? const [])
          if (SuperTabActivityItem.fromJson(superTabMap(row)) case final i
              // Only chats this reader still has; a chat lost since is not
              // shown on the server's word alone.
              when readable.contains(i.conversationId))
            i,
      ];
      more = answer['more'] == true;
      loaded = true;
      error = null;
      _waitUntil = null;
      if (_open) {
        _newThisVisit.addAll(items.where((i) => !i.read).map((i) => i.id));
      }
      notifyListeners();
    } catch (failure) {
      if (!current()) return;
      _shown = asked;
      if (failure is SuperTabFailure && failure.statusCode == 404) {
        // A server before Activity: tags and decisions still show.
        supported = false;
        loaded = true;
        error = null;
        notifyListeners();
        return;
      }
      if (failure is SuperTabFailure && failure.statusCode == 429) {
        _waitUntil = DateTime.now().add(const Duration(seconds: 5));
      }
      // The digest is read again on its next move, or by Retry.
      _digest = null;
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
    controller.removeListener(_changed);
    mentions.removeListener(notifyListeners);
    decisions.removeListener(notifyListeners);
    super.dispose();
  }
}

/// A system notice for each new message in a chat set to All new messages
/// ([SuperTabNotify.all]), as Slack's channel setting does: when the chat's
/// newest main-stream message moves past what the reader has read, and the
/// chat is not the one open. The first look at a chat is not news. One per
/// controller.
class SuperTabChatNotices {
  SuperTabChatNotices._(this.controller) {
    controller.addListener(_changed);
    controller.onDispose(_dispose);
    _changed();
  }

  static final _all = Expando<SuperTabChatNotices>();
  static SuperTabChatNotices of(SuperTabController controller) =>
      _all[controller] ??= SuperTabChatNotices._(controller);

  final SuperTabController controller;

  /// Told with the chat and how far it now goes.
  void Function(SuperTabConversation group, int sequence)? onMessage;

  final _seen = <String, int>{};
  int? _epoch;
  bool _disposed = false;

  void _changed() {
    if (_disposed) return;
    final snapshot = controller.snapshot;
    if (controller.accessRevoked || snapshot == null) {
      _seen.clear();
      return;
    }
    if (controller.visibilityEpoch != _epoch) {
      // Who may read what changed: start over, telling nothing.
      _epoch = controller.visibilityEpoch;
      _seen.clear();
    }
    for (final group in snapshot.conversations) {
      final top = group.lastMainSequence ?? group.lastMessageSequence;
      final before = _seen[group.id];
      _seen[group.id] = top;
      if (before == null || top <= before) continue;
      if (controller.notifyOf(group.id) != SuperTabNotify.all) continue;
      if (controller.selectedId == group.id) continue;
      if (top <= controller.readMark(group.id)) continue;
      onMessage?.call(group, top);
    }
  }

  void _dispose() {
    _disposed = true;
    controller.removeListener(_changed);
  }
}
