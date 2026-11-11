import 'dart:async';

import 'package:flutter/foundation.dart';

import '../notify/system_notices.dart';
import 'swarm_chat_notify.dart';
import 'swarm_reader.dart';

/// Tells of new messages in chats ([SwarmChatNotices]) unless the person is
/// already looking at Swarm ([quiet]), and takes each notice down once what
/// it told is read, or its Swarm can no longer be read ([settle]).
///
/// The app icon's count is v1-v3's (what waited on the person): the first
/// read of a session takes off what an earlier run left there.
class SwarmAnnouncer {
  SwarmAnnouncer(
    this.notices, {
    required this.quiet,
    SwarmTold? told,
    DateTime Function()? now,
  }) : told = told ?? SwarmTold(),
       _now = now ?? DateTime.now;

  final SwarmNotices notices;

  /// How long an agent's 1:1 chat stays quiet once it sounded here, read or
  /// not, as its push does (backend push/rings.ts CHAT_RING_EVERY_MS; Tony,
  /// 2026-11-10: three or four agents rang at every read).
  static const chatCooldown = Duration(minutes: 5);

  final DateTime Function() _now;

  /// The person sees Swarm where they are: no notice.
  final bool Function() quiet;

  /// The server's pushes still shown, which a chat's notice follows.
  final SwarmTold told;

  /// The app icon's count was taken off this session.
  bool _badgeOff = false;

  /// A Swarm was read: the first read of the session takes the icon's count
  /// off.
  void swarmRead() {
    if (_badgeOff) return;
    _badgeOff = true;
    unawaited(notices.setSwarmBadge(0));
  }

  /// A chat notice whose Swarm is not among [readable] (off the account's
  /// list, or its access gone) is taken down.
  void settle(Set<String> readable) {
    for (final MapEntry(:key, :value) in _chats.entries.toList()) {
      if (!readable.contains(value.swarmId)) _takeDownChat(key);
    }
  }

  /// The notices of chats ([SwarmChatNotices]), posted here or a push's:
  /// each key's Swarm, chat and how far it went.
  final _chats = <String, ({String swarmId, String chatId, int sequence})>{};

  /// When each agent's 1:1 chat last sounded here ([chatCooldown]).
  final _chatRang = <String, DateTime>{};

  /// Posts or moves on chat [chatId]'s notice: one per chat, which a newer
  /// message replaces, as nothing waits to be answered. A chat set to All new
  /// messages names the project only: a notice can be read on a locked phone,
  /// and the chat's name is read in the app. An agent's 1:1
  /// chat names its [agent], with the words of its push (backend
  /// push/notices.ts chatNotices), in the push's notification.
  void announceChat({
    required String swarmId,
    required String chatId,
    required String project,
    required int sequence,
    String? agent,
  }) {
    if (quiet()) return;
    final key = 'chat:$swarmId:$chatId';
    final now = _now();
    final rang = _chatRang[key];
    // Sounds once until the person reads the chat; a newer message only
    // replaces it (task #3248). An agent's chat, once it sounded, also waits
    // [chatCooldown], read or not, as its push does.
    final up =
        _chats.containsKey(key) ||
        (agent != null && rang != null && now.difference(rang) < chatCooldown);
    if (agent != null && !up) {
      _chatRang
        ..removeWhere((_, at) => now.difference(at) >= chatCooldown)
        ..[key] = now;
    }
    _chats[key] = (swarmId: swarmId, chatId: chatId, sequence: sequence);
    unawaited(
      notices.showSwarm((
        key: key,
        title: agent == null ? 'New messages' : '$agent wrote to you',
        subtitle: agent == null ? project : '',
        body: agent == null
            ? 'Open Harness to read them.'
            : 'Open Harness to read it.',
        target: (
          swarmId: swarmId,
          conversationId: chatId,
          messageId: null,
          threadId: null,
        ),
        quiet: up,
      )),
    );
  }

  /// Chat [chatId]'s notification shows the server's push
  /// ([SwarmTold.pushed]), held to [sequence]: followed as one posted here, so
  /// reading the chat takes it down (anh Dee's finding 14, 2026-11-10), and
  /// the chat's next notice only replaces it.
  void chatPushed({
    required String swarmId,
    required String chatId,
    required int sequence,
  }) {
    final key = 'chat:$swarmId:$chatId';
    if (_chats.containsKey(key) || !told.pushed(key)) return;
    _chats[key] = (swarmId: swarmId, chatId: chatId, sequence: sequence);
  }

  /// Takes a chat's notice down once what it told is read, the chat is no
  /// longer in Swarm [swarmId] as [reader] reads it, or that can no longer
  /// be read at all.
  void chatsRead(String swarmId, SwarmReader reader) {
    for (final MapEntry(:key, :value) in _chats.entries.toList()) {
      if (value.swarmId != swarmId) continue;
      final read = reader.readMarks?.readThrough(value.chatId);
      if (reader.accessRevoked ||
          reader.snapshot?.conversation(value.chatId) == null ||
          (read != null && read >= value.sequence)) {
        _takeDownChat(key);
      }
    }
  }

  void _takeDownChat(String key) {
    _chats.remove(key);
    told.pushGone(key);
    unawaited(notices.cancelSwarm(key));
  }

  /// Takes every notice and the icon's count down: the account that saw them
  /// signed out, or Swarm was turned off.
  void clear() {
    for (final key in _chats.keys.toList()) {
      _takeDownChat(key);
    }
    _chatRang.clear();
    unawaited(notices.setSwarmBadge(0));
  }
}

/// The server's pushes in the notification centre for one account, by their
/// keys: a chat's notice follows one there instead of posting its own
/// ([SwarmAnnouncer.chatPushed]). [SwarmHost] keeps one for the life of the
/// app. In memory only, keys only. Another account starts it over
/// ([account]).
class SwarmTold {
  String? _account;

  /// The keys and notification slots of the pushes in the notification centre
  /// as the app last came back ([SwarmHost.toldElsewhere]).
  Set<String> _pushes = const {};

  /// The pushes in the notification centre now, by their keys and the slots
  /// they show in (task #3248: Android gives the slot alone); [pushed] holds
  /// for each until the next call.
  void pushesShown(Iterable<String> keys) => _pushes = {...keys};

  /// Whether a push still shows notification [slot].
  bool pushed(String slot) => _pushes.contains(slot);

  /// The app took notification [slot] down, and the push in it with it.
  void pushGone(String slot) {
    if (_pushes.contains(slot)) _pushes = {..._pushes}..remove(slot);
  }

  /// Whose notices these are: another account, or none (Swarm turned off),
  /// forgets every key.
  set account(String? id) {
    if (id == _account) return;
    _account = id;
    _pushes = const {};
  }
}

/// Takes the app icon's count off each time [app] finds nobody signed in
/// ([signedOut]), and at once if it already knows. A launch that starts
/// signed out never makes a Swarm session, whose end ([SwarmAnnouncer.clear])
/// would have taken the last account's count off. Lives as long as [app].
void swarmBadgeOffWhileSignedOut(
  Listenable app, {
  required bool Function() signedOut,
  required SwarmNotices notices,
}) {
  var off = false;
  void check() {
    final now = signedOut();
    if (now && !off) unawaited(notices.setSwarmBadge(0));
    off = now;
  }

  app.addListener(check);
  check();
}

/// What tells of each new message in a chat set to All new messages
/// ([SwarmNotify.all]), as the desktop's `SuperTabChatNotices`: after a read
/// of its Swarm, a chat whose newest main-stream message moved past what the
/// last read held, and past what the person has read. The first look at a
/// chat is not news; nor is a read under another hold of the Swarm (a first
/// load again, or access moved), which starts over telling nothing. Muted and
/// Mentions only chats tell nothing here.
///
/// An agent's 1:1 chat tells of its agent's words in Mentions only too, as
/// its push does (anh Dee, #3811: an agent reaches its person there), never
/// muted, nor of the person's own words. The read holds no author: a newest
/// message that is not a person's ([SuperTabConversation.lastPersonSequence])
/// is the agent's.
class SwarmChatNotices {
  SwarmChatNotices(this.announcer);

  final SwarmAnnouncer announcer;

  /// How far each chat went at the last read, by Swarm; with the hold
  /// ([SwarmReader.generation]) it was read under.
  final _seen = <String, ({int generation, Map<String, int> tops})>{};

  /// Swarm [swarmId] was read by [reader].
  void read(String swarmId, SwarmReader reader) {
    final snapshot = reader.snapshot;
    if (reader.accessRevoked || snapshot == null) {
      _seen.remove(swarmId);
      announcer.chatsRead(swarmId, reader);
      return;
    }
    final held = _seen[swarmId];
    final first = held == null || held.generation != reader.generation;
    final tops = <String, int>{};
    for (final group in snapshot.conversations) {
      final top = group.mainSequence;
      tops[group.id] = top;
      // A push of this chat in the notification centre goes once it is read.
      announcer.chatPushed(swarmId: swarmId, chatId: group.id, sequence: top);
      if (first) continue;
      final before = held.tops[group.id];
      if (before == null || top <= before) continue;
      final level = reader.notifyOf(group.id);
      final agentChat = group.isAgentChat;
      if (agentChat
          ? level == SwarmNotify.muted || top == group.lastPersonSequence
          : level != SwarmNotify.all) {
        continue;
      }
      final read = reader.readMarks?.readThrough(group.id);
      // Marks not back yet: nothing says it is unread.
      if (read == null || top <= read) continue;
      announcer.announceChat(
        swarmId: swarmId,
        chatId: group.id,
        project: snapshot.projectById(group.projectId)?.name ?? '',
        sequence: top,
        agent: agentChat
            ? snapshot.agentName(group.agentIds.firstOrNull ?? '')
            : null,
      );
    }
    _seen[swarmId] = (generation: reader.generation, tops: tops);
    announcer.chatsRead(swarmId, reader);
  }

  /// Only [swarms] are read now: the rest are forgotten.
  void keepOnly(Set<String> swarms) =>
      _seen.removeWhere((id, _) => !swarms.contains(id));
}
