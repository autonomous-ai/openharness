import 'dart:async';

import 'package:flutter/foundation.dart';

import '../notify/system_notices.dart';
import 'swarm_activity_feed.dart';
import 'swarm_chat_notify.dart';
import 'swarm_inbox.dart';
import 'swarm_reader.dart';

/// The notice that tells the person about [need]: who asks, and in which
/// project.
///
/// A notice can be read on a locked phone, and neither platform lets this app
/// hide one part of it there for sure: so what is asked, and the conversation
/// it is in, are read in the app only (Lead, 2026-10-27). The one place to
/// change if notices may say more.
SwarmNoticeMessage swarmNotice(SwarmNeed need, {bool quiet = false}) {
  final (title, project, body) = switch (need) {
    SwarmDecisionNeed(:final decision) => (
      '${decision.askerName} asks you',
      decision.projectName,
      'Open Harness to answer.',
    ),
    SwarmMentionNeed(:final mention) => (
      '${mention.leadName} tagged you',
      mention.projectName,
      'Open Harness to read it.',
    ),
    SwarmWorkNeed(:final work) when work.atPrompt => (
      '${work.agentName} is waiting at a prompt',
      work.project.name,
      'Open Harness to answer it.',
    ),
    SwarmWorkNeed(:final work) when work.status == 'blocked' => (
      '${work.agentName} is stuck',
      work.project.name,
      'Open Harness to see why.',
    ),
    SwarmWorkNeed(:final work) => (
      '${work.agentName} needs you',
      work.project.name,
      'Open Harness to answer.',
    ),
  };
  return (
    key: switch (need) {
      // A task's decision, its "stuck" and its "needs you" are one
      // notification, the server's push for the decision too (task #3607).
      SwarmDecisionNeed() => swarmTaskSlot(need.swarmId, need.conversationId),
      SwarmWorkNeed(:final work) when !work.atPrompt => swarmTaskSlot(
        need.swarmId,
        need.conversationId,
      ),
      _ => need.key,
    },
    title: title,
    subtitle: project,
    body: body,
    target: (
      swarmId: need.swarmId,
      conversationId: need.conversationId,
      messageId: need is SwarmMentionNeed ? need.mention.messageId : null,
      decisionId: need is SwarmDecisionNeed ? need.decision.id : null,
      // A tag in a reply only in its thread opens that thread.
      threadId: need is SwarmMentionNeed ? need.mention.threadId : null,
    ),
    quiet: quiet,
  );
}

/// The notification one task's questions share (task #3607; backend
/// `push/notices.ts` taskSlot): a decision asked of the person, and the
/// task's "stuck" or "needs you". A later one replaces the earlier quietly.
String swarmTaskSlot(String swarmId, String conversationId) =>
    'task:$swarmId:$conversationId';

/// The notification a thread's replies share, the server's push for them too
/// (task #3248; backend `push/notices.ts` threadSlot): a newer reply replaces
/// the one shown.
String threadSlot(String swarmId, String conversationId, String threadId) =>
    'thread:$swarmId:$conversationId:$threadId';

/// Posts a notice for each need that arrives ([SwarmInbox.onArrived]) unless
/// the person is already looking at it ([quiet]), and takes it down once the
/// need is gone: answered on the desktop, done, or no longer waiting — missing
/// from two reads of its Swarm in a row ([swarmRead]), as one read may miss
/// it and the next have it again. One whose Swarm can no longer be read goes
/// at once ([settle]).
///
/// The app icon counts the needs, as the drawer's waiting badge does, on each
/// read and whether or not a notice was posted; it is set only when the count
/// changes, and the first read sets it even at zero, over what an earlier run
/// left there.
class SwarmAnnouncer {
  SwarmAnnouncer(
    this.notices, {
    required this.quiet,
    this.muted = _neverMuted,
    SwarmTold? told,
  }) : told = told ?? SwarmTold();

  final SwarmNotices notices;

  /// The person sees [need] where they are: no notice. Null asks for a
  /// chat's new messages ([announceChat]).
  final bool Function(SwarmNeed? need) quiet;

  /// The person muted [need]'s chat: a tag there posts nothing, as its push
  /// sends nothing (anh Dee, 2026-11-09).
  final bool Function(SwarmNeed need) muted;

  static bool _neverMuted(SwarmNeed need) => false;

  /// What this phone has told the account already: never told again.
  final SwarmTold told;

  /// The needs whose notice is posted and not yet taken down, by need key:
  /// each one's Swarm and the notification it shows in. Several needs of one
  /// task show in one ([swarmTaskSlot]), which stays until the last is gone.
  /// [viaPush]: the server's push shows it, and nothing was posted here; the
  /// need is followed so that answering it takes the push down.
  final _posted = <String, ({String swarmId, String slot, bool viaPush})>{};

  /// Posted notices whose need the last reads of its Swarm missed: how many
  /// in a row.
  final _missed = <String, int>{};

  /// The count on the app icon; null before the first read.
  int? _badge;

  /// Posts [need]'s notice, once: a need that left a read and came back
  /// (another way of reading answered without it, or the session was made
  /// again) is not news (Dee's iPhone, 2026-11-01: one notice every 5
  /// seconds).
  void announce(SwarmNeed need) {
    // An agent's tag that asks for no decision, a tag in a chat the person
    // muted, and work stuck or needing a person in a task they did not ask
    // for (anh Dee, 2026-11-09: one person owns many projects) are badge and
    // Activity only: the need still counts on the icon ([settle]), but
    // nothing is posted. An agent at a prompt tells whom the server chose.
    if (need is SwarmMentionNeed &&
        (need.mention.taggedByAgent || muted(need))) {
      return;
    }
    if (need is SwarmWorkNeed && !need.work.atPrompt && !need.work.requested) {
      return;
    }
    if (quiet(need)) return;
    final fresh = told.add(need.key);
    final slot = swarmNotice(need).key;
    // The server's push shows this notification already: nothing is posted,
    // but the need is followed, so that answering it takes the push down and
    // frees the slot for the task's next question (review of task #3607). The
    // push may be the one that told this need ([fresh] false).
    if (told.pushed(slot)) {
      _posted.putIfAbsent(
        need.key,
        () => (swarmId: need.swarmId, slot: slot, viaPush: true),
      );
      _missed.remove(need.key);
      return;
    }
    if (!fresh) return;
    // Another need of the task is up here: this one replaces it without a
    // sound. A followed push-only need is not: the person may have swiped it.
    final up = _posted.values.any(
      (posted) => posted.slot == slot && !posted.viaPush,
    );
    final notice = swarmNotice(need, quiet: up);
    _posted[need.key] = (
      swarmId: need.swarmId,
      slot: notice.key,
      viaPush: false,
    );
    _missed.remove(need.key);
    unawaited(notices.showSwarm(notice));
  }

  /// The needs as they are now ([needs]), counted on the app icon. A notice
  /// whose need is back is no longer missed; one whose Swarm is not among
  /// [readable] (off the account's list, or its access gone) is taken down at
  /// once. [readable] null: the list is not read yet, and nothing goes.
  void settle(List<SwarmNeed> needs, {Set<String>? readable}) {
    final open = {for (final need in needs) need.key};
    for (final MapEntry(key: key, value: posted) in _posted.entries.toList()) {
      if (open.contains(key)) {
        _missed.remove(key);
      } else if (readable != null && !readable.contains(posted.swarmId)) {
        _takeDown(key);
      }
    }
    if (readable != null) {
      for (final MapEntry(:key, :value) in _chats.entries.toList()) {
        if (!readable.contains(value.swarmId)) _takeDownChat(key);
      }
      for (final MapEntry(:key, :value) in _replies.entries.toList()) {
        if (!readable.contains(value.swarmId)) _takeDownReply(key);
      }
    }
    if (needs.length != _badge) {
      _badge = needs.length;
      unawaited(notices.setSwarmBadge(needs.length));
    }
  }

  /// Swarm [swarmId] was read, and [needs] are what waits now: a notice of
  /// its whose need this read missed, as the one before did, is taken down.
  void swarmRead(String swarmId, List<SwarmNeed> needs) {
    final open = {for (final need in needs) need.key};
    for (final MapEntry(key: key, value: posted) in _posted.entries.toList()) {
      if (posted.swarmId != swarmId) continue;
      if (open.contains(key)) {
        _missed.remove(key);
        continue;
      }
      final missed = (_missed[key] ?? 0) + 1;
      if (missed >= 2) {
        _takeDown(key);
      } else {
        _missed[key] = missed;
      }
    }
  }

  /// The notices of chats set to All new messages ([SwarmChatNotices]):
  /// each key's Swarm, chat and how far it went.
  final _chats = <String, ({String swarmId, String chatId, int sequence})>{};

  /// Posts or moves on chat [chatId]'s "New messages" notice: one per chat,
  /// which a newer message replaces, as nothing waits to be answered. Names
  /// the project only: a notice can be read on a locked phone, and the chat's
  /// name is read in the app ([swarmNotice]).
  void announceChat({
    required String swarmId,
    required String chatId,
    required String project,
    required int sequence,
  }) {
    if (quiet(null)) return;
    final key = 'chat:$swarmId:$chatId';
    // Sounds once until the person reads the chat; a newer message only
    // replaces it (task #3248).
    final up = _chats.containsKey(key);
    _chats[key] = (swarmId: swarmId, chatId: chatId, sequence: sequence);
    unawaited(
      notices.showSwarm((
        key: key,
        title: 'New messages',
        subtitle: project,
        body: 'Open Harness to read them.',
        target: (
          swarmId: swarmId,
          conversationId: chatId,
          messageId: null,
          decisionId: null,
          threadId: null,
        ),
        quiet: up,
      )),
    );
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

  /// The notifications of threads that rang the person, by [threadSlot]: each
  /// one's Swarm and the unread Activity rows it tells of.
  final _replies = <String, ({String swarmId, Set<String> rows})>{};

  /// Posts [entry]'s notice, once, when the server rang the person for it
  /// ([SwarmActivityEntry.rings]): a reply in a thread of Swarm [swarmId]'s
  /// project [project] ([SwarmActivityFeed.onReply]). Every other reply is
  /// the badge and Activity only (Tony's rule, 2026-11-09: a thread rings its
  /// starter once, for the first person's reply). Names who replied and the
  /// project only, as [swarmNotice] does.
  ///
  /// It shows in the thread's notification, which the server's push for the
  /// same reply shares (task #3248). A reply a push told already gets nothing
  /// here, but is followed, so that reading it takes the push down.
  void announceReply({
    required String swarmId,
    required SwarmActivityEntry entry,
    required String project,
  }) {
    if (!entry.rings) return;
    if (quiet(null)) return;
    final key = 'reply:$swarmId:${entry.id}';
    final fresh = told.add(key);
    final thread = entry.threadId;
    final slot = thread == null
        ? key
        : threadSlot(swarmId, entry.conversationId, thread);
    _replies[slot] = (
      swarmId: swarmId,
      rows: {...?_replies[slot]?.rows, entry.id},
    );
    if (!fresh || told.pushed(slot)) return;
    final who = entry.actorName.isEmpty ? 'Someone' : entry.actorName;
    unawaited(
      notices.showSwarm((
        key: slot,
        title: '$who replied in a thread',
        subtitle: project,
        body: 'Open Harness to read it.',
        target: (
          swarmId: swarmId,
          conversationId: entry.conversationId,
          messageId: entry.messageId,
          decisionId: null,
          // A reply only in its thread is found there, not in the chat.
          threadId: entry.threadId,
        ),
        quiet: false,
      )),
    );
  }

  /// Swarm [swarmId]'s Activity was read and lists [rows]: a thread's
  /// notification none of whose rows is unread now, or listed, is taken down,
  /// with the push it shares.
  void repliesRead(String swarmId, Iterable<SwarmActivityEntry> rows) {
    final unread = {
      for (final row in rows)
        if (!row.read) row.id,
    };
    for (final MapEntry(:key, :value) in _replies.entries.toList()) {
      if (value.swarmId != swarmId) continue;
      final left = value.rows.intersection(unread);
      if (left.isEmpty) {
        _takeDownReply(key);
      } else {
        _replies[key] = (swarmId: swarmId, rows: left);
      }
    }
  }

  void _takeDownReply(String key) {
    _replies.remove(key);
    told.pushGone(key);
    unawaited(notices.cancelSwarm(key));
  }

  void _takeDownChat(String key) {
    _chats.remove(key);
    unawaited(notices.cancelSwarm(key));
  }

  void _takeDown(String key) {
    final gone = _posted.remove(key);
    _missed.remove(key);
    if (gone == null) return;
    // The notification goes with the last need that showed in it, and a push
    // in it with it: the slot is free for the task's next question.
    if (_posted.values.any((posted) => posted.slot == gone.slot)) return;
    told.pushGone(gone.slot);
    unawaited(notices.cancelSwarm(gone.slot));
  }

  /// Takes every notice and the icon's count down: the account that saw them
  /// signed out, or Swarm was turned off.
  void clear() {
    for (final key in _posted.keys.toList()) {
      _takeDown(key);
    }
    for (final key in _chats.keys.toList()) {
      _takeDownChat(key);
    }
    for (final key in _replies.keys.toList()) {
      _takeDownReply(key);
    }
    settle(const []);
  }
}

/// The notices this phone has posted for one account, by their keys
/// ([SwarmNeed.key]: the decision's or tag's id, or the work's assignment and
/// status; a reply's Activity row id): what [SwarmAnnouncer] never posts twice, however often its need
/// leaves the reads and comes back. [SwarmHost] keeps one for the life of the
/// app, so a session made again for the same account remembers too.
///
/// In memory only, ids only, at most [limit] keys, the oldest let go first.
/// Another account starts it over ([account]).
class SwarmTold {
  SwarmTold({this.limit = 500});

  final int limit;

  /// Kept in the order told: a set literal is a [LinkedHashSet].
  final _keys = <String>{};
  String? _account;

  /// Records [key]; false when it was told already.
  bool add(String key) {
    if (!_keys.add(key)) return false;
    while (_keys.length > limit) {
      _keys.remove(_keys.first);
    }
    return true;
  }

  /// Records [keys] as told somewhere else: pushes already in the
  /// notification centre (task #2905).
  void addAll(Iterable<String> keys) => keys.forEach(add);

  /// The keys and notification slots of the pushes in the notification centre
  /// as the app last came back ([SwarmHost.toldElsewhere]).
  Set<String> _pushes = const {};

  /// The pushes in the notification centre now, by their keys and the slots
  /// they show in (task #3248: Android gives the slot alone). Each is told
  /// ([addAll]); [pushed] holds for each until the next call.
  void pushesShown(Iterable<String> keys) {
    final shown = {...keys};
    addAll(shown);
    _pushes = shown;
  }

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
    _keys.clear();
    _pushes = const {};
  }

  @visibleForTesting
  int get length => _keys.length;
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
/// Mentions only chats tell nothing here: their tags are told as needs.
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
      if (first) continue;
      final before = held.tops[group.id];
      if (before == null || top <= before) continue;
      if (reader.notifyOf(group.id) != SwarmNotify.all) continue;
      final read = reader.readMarks?.readThrough(group.id);
      // Marks not back yet: nothing says it is unread.
      if (read == null || top <= read) continue;
      announcer.announceChat(
        swarmId: swarmId,
        chatId: group.id,
        project: snapshot.projectById(group.projectId)?.name ?? '',
        sequence: top,
      );
    }
    _seen[swarmId] = (generation: reader.generation, tops: tops);
    announcer.chatsRead(swarmId, reader);
  }

  /// Only [swarms] are read now: the rest are forgotten.
  void keepOnly(Set<String> swarms) =>
      _seen.removeWhere((id, _) => !swarms.contains(id));
}
