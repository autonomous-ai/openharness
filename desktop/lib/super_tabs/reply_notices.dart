import 'dart:async';

import 'activity.dart';
import 'controller.dart';
import 'model.dart';

/// One reply row of the reader's Activity (backend activity.ts): a reply in a
/// thread they are in.
class SuperTabReplyRow {
  SuperTabReplyRow.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      conversationId = row['conversationId'] as String,
      conversationTitle = row['conversationTitle'] as String? ?? '',
      projectName = row['projectName'] as String? ?? '',
      messageId = row['messageId'] as String,
      threadId = row['threadId'] as String?,
      actorName = (row['actor'] as Map?)?['name'] as String? ?? 'Someone',
      text = row['text'] as String? ?? '';
  final String id, conversationId, conversationTitle, projectName, messageId;
  final String actorName, text;

  /// The thread's root; null when the reply was also sent to the chat.
  final String? threadId;
}

/// A system notice for each new reply in a thread the reader is in, as the
/// server decides who is in it (task #2745): Activity is read when its digest
/// moves, and each unread reply row new since the first read is told once,
/// unless that thread, or for a reply also sent to the chat that chat, is open
/// and being read. One per controller.
class SuperTabReplyNotices {
  SuperTabReplyNotices._(this.controller) {
    controller.addListener(_changed);
    controller.onDispose(_dispose);
    _changed();
  }

  static final _all = Expando<SuperTabReplyNotices>();
  static SuperTabReplyNotices of(SuperTabController controller) =>
      _all[controller] ??= SuperTabReplyNotices._(controller);

  final SuperTabController controller;

  /// Told of each new reply row, oldest first.
  void Function(SuperTabReplyRow row)? onReply;

  String? _digest;
  int? _epoch;
  // The rows of the last read; null until the first, whose rows are not news.
  Set<String>? _seen;
  Future<void>? _loading;
  // The digest moved while a read was under way: read once more after it.
  bool _dirty = false;
  // A server before Activity: nothing to read for this Swarm's life.
  bool _missing = false, _disposed = false;

  void _changed() {
    final snapshot = controller.snapshot;
    if (_disposed || _missing || snapshot == null) return;
    if (controller.accessRevoked) {
      _seen = null;
      return;
    }
    if (controller.visibilityEpoch != _epoch) {
      // Who may read what changed: start over, telling nothing.
      _epoch = controller.visibilityEpoch;
      _seen = null;
    }
    final digest = snapshot.activityDigest;
    if (digest == null || digest == _digest) return;
    _digest = digest;
    if (_loading != null) {
      _dirty = true;
      return;
    }
    _loading = () async {
      do {
        _dirty = false;
        await _read();
      } while (_dirty && !_disposed && !_missing);
    }().whenComplete(() => _loading = null);
  }

  Future<void> _read() async {
    final epoch = _epoch;
    final List<Map<String, dynamic>> items;
    try {
      final answer = await controller.request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}/activity',
      );
      items = [for (final row in answer['items'] as List) superTabMap(row)];
    } on SuperTabFailure catch (failure) {
      if (failure.statusCode == 404) _missing = true;
      // Anything else is read again when the digest next moves.
      return;
    } catch (_) {
      return;
    }
    if (_disposed || controller.accessRevoked || epoch != _epoch) return;
    final seen = _seen;
    _seen = {for (final row in items) row['id'] as String};
    if (seen == null) return;
    for (final row in items.reversed) {
      if (row['kind'] != 'reply' || row['read'] == true) continue;
      if (seen.contains(row['id'])) continue;
      final reply = SuperTabReplyRow.fromJson(row);
      if (!_beingRead(reply)) onReply?.call(reply);
    }
  }

  /// Whether the reader is reading where [reply] is: its thread's pane on
  /// screen, or for a reply also sent to the chat, that chat.
  bool _beingRead(SuperTabReplyRow reply) {
    if (controller.selectedId != reply.conversationId) return false;
    return switch (reply.threadId) {
      final root? =>
        controller.threadOnScreen == root && controller.threadPaneOnScreen,
      null => SuperTabChatNotices.of(controller).openChatRead,
    };
  }

  void _dispose() {
    _disposed = true;
    controller.removeListener(_changed);
  }
}
