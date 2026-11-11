import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/widgets.dart';

import '../notify/system_notifications.dart';
import 'controller.dart';
import 'model.dart';

/// What tells the person about a new message in a chat they set to All new
/// messages, or from one of their agents in its own chat with them: the
/// operating system, on Desktop only. The notice
/// names the chat, not its newest message, and a click opens that chat in its
/// Swarm [tabId] (Diego, 2026-11-03: it carried neither, so a click did nothing).
void Function(String tabId, SuperTabConversation group, int sequence)?
superTabChatNotice(SystemNotifications system, {bool web = kIsWeb}) => web
    ? null
    : (tabId, group, sequence) => system.postNotice(
        id: 'harness-chat:$tabId:${group.id}:$sequence',
        title: group.title,
        body: 'New messages',
        chat: (tabId: tabId, conversationId: group.id),
      );

/// A system notice for each new message in a chat set to All new messages
/// ([SuperTabNotify.all]), as Slack's channel setting does, and in an agent's
/// own chat with the reader unless it is muted: when the chat's
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

  /// Set by the view on screen: whether a person can see its chat now.
  bool Function()? chatShown;

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
      final level = controller.notifyOf(group.id);
      if (level == SuperTabNotify.muted) continue;
      // An agent's own chat with its person tells each new message: the agent asks them there (Swarm v4).
      if (level != SuperTabNotify.all && !group.isAgentChat) continue;
      if (controller.selectedId == group.id && openChatRead) continue;
      if (top <= controller.readMark(group.id)) continue;
      unawaited(_tell(group, before, top));
    }
  }

  /// Tells of [group] unless all it gained is the person's own, which the state doesn't say. By the
  /// time that's read, the person may have read the chat or lost it.
  Future<void> _tell(SuperTabConversation group, int before, int top) async {
    final epoch = _epoch;
    if (await controller.onlyOwnSince(group.id, before)) return;
    if (_disposed || controller.accessRevoked || _epoch != epoch) return;
    if (top <= controller.readMark(group.id)) return;
    onMessage?.call(group, top);
  }

  /// Whether the open chat is being read now. The view on screen knows; with none up, this falls
  /// back to the Swarm showing and the app in front.
  bool get openChatRead {
    if (chatShown case final shown?) return shown();
    final state = WidgetsBinding.instance.lifecycleState;
    return !controller.away &&
        (state == null || state == AppLifecycleState.resumed);
  }

  void _dispose() {
    _disposed = true;
    controller.removeListener(_changed);
  }
}
