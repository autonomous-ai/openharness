import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/widgets.dart';

import 'activity_rows.dart';
import 'attention.dart';
import 'controller.dart';
import 'decisions.dart';
import 'model.dart';
import 'notifications.dart';

/// What one row of Needs you is.
enum SuperTabNeedKind { decision, agent }

/// One row of Needs you: a decision asked of the reader, or an agent waiting
/// on them.
class SuperTabNeed {
  const SuperTabNeed({
    required this.kind,
    required this.id,
    required this.title,
    required this.conversationId,
    this.at,
    this.decision,
    this.question,
  });
  final SuperTabNeedKind kind;

  /// Stable across reads: `decision:<id>`, `agent:<group>`.
  final String id;

  /// What the row says: the question, or `<agent> is waiting on you`.
  final String title;
  final String conversationId;
  final DateTime? at;
  final SuperTabDecision? decision;

  /// What an agent row asks: the question the task is waiting on, else the
  /// task's title. Null for a decision, which has its own.
  final String? question;
}

/// The reader's Activity in one Swarm: the one place for everything new for
/// them (Quiet Swarm design, screens 6 and 11b). Three lists over what the
/// Swarm already holds, no feed of its own:
///
/// * Needs you: decisions asked of them and agents waiting on them. Its
///   length is Activity's number.
/// * Mentions: the tags of them, folded by author and chat.
/// * Threads: the followed threads with replies they have not read.
///
/// Leaving the view marks nothing read: it shows no reply or reaction row,
/// and a thread is read when it is opened. One per controller.
class SuperTabActivity extends ChangeNotifier {
  SuperTabActivity._(this.controller)
    : mentions = SuperTabMentions.of(controller),
      decisions = SuperTabDecisions.of(controller),
      attention = SuperTabAttention.of(controller) {
    controller.addListener(notifyListeners);
    controller.onDispose(dispose);
    mentions.addListener(notifyListeners);
    decisions.addListener(notifyListeners);
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
  final SuperTabAttention attention;
  bool _open = false, _disposed = false;

  SuperTabSnapshot? get _snapshot =>
      controller.accessRevoked ? null : controller.snapshot;

  /// Decisions asked of the reader, then agents that asked them by name; each
  /// newest first. Tags are not here: they are the Mentions list.
  List<SuperTabNeed> get needsYou {
    final snapshot = _snapshot;
    if (snapshot == null) return const [];
    final epoch = DateTime.fromMillisecondsSinceEpoch(0);
    return [
      for (final d in [
        ...decisions.open,
      ]..sort((a, b) => (b.createdAt ?? epoch).compareTo(a.createdAt ?? epoch)))
        SuperTabNeed(
          kind: SuperTabNeedKind.decision,
          id: 'decision:${d.id}',
          title: d.question,
          conversationId: d.conversationId,
          at: d.createdAt,
          decision: d,
        ),
      for (final group in _asking(snapshot))
        SuperTabNeed(
          kind: SuperTabNeedKind.agent,
          id: 'agent:${group.id}',
          title:
              '${_agentName(snapshot, group.assignment!['agentId'] as String)} is waiting on you',
          conversationId: group.id,
          question: _askedBy(group),
        ),
    ];
  }

  /// A tag from a server that does not say where it is: it counts until
  /// answered, past any read mark. Not `1 << 52`: a shift is 32 bits on the web.
  static const _unknown = 9007199254740991;

  /// The tags that are not read past (the number clears by reading). They are
  /// bold in Mentions but never counted: a tag asks for nothing.
  Iterable<SuperTabMention> get _tags {
    return mentions.waiting.where(mentionUnread);
  }

  /// The tasks whose agent asked the reader by name, newest chat first. Only
  /// once the decisions are loaded: that list says which of them is already
  /// a decision, and a task with one must not count twice.
  List<SuperTabConversation> _asking(SuperTabSnapshot snapshot) {
    if (!decisions.loaded) return const [];
    final decided = {for (final d in decisions.open) d.conversationId};
    return [
      for (final g in snapshot.conversations)
        if (_waiting(snapshot, g, decided)) g,
    ]..sort((a, b) => b.lastMessageSequence.compareTo(a.lastMessageSequence));
  }

  /// A task whose agent asked the reader by name and has not already asked it
  /// as a decision. A stuck task nobody was asked about stays with the PM.
  bool _waiting(
    SuperTabSnapshot snapshot,
    SuperTabConversation group,
    Set<String> decided,
  ) {
    final work = group.assignment;
    return work != null &&
        !group.closed &&
        !group.isBuddyChat &&
        !decided.contains(group.id) &&
        work['status'] == 'needs_human' &&
        work['askedOf'] == controller.accountId &&
        snapshot.agent(work['agentId'] as String? ?? '') != null;
  }

  /// The question a waiting task carries: its assignment's result text is the
  /// agent's ask (task_status.dart reads it the same way); the title when it
  /// has none.
  String _askedBy(SuperTabConversation group) {
    final asked = (group.assignment?['result'] as String?)?.trim();
    return asked == null || asked.isEmpty ? group.title : asked;
  }

  String _agentName(SuperTabSnapshot snapshot, String agentId) {
    final agent = snapshot.agent(agentId);
    return agent?.displayName ?? agent?.name ?? 'An agent';
  }

  /// Whether [mention] shows bold: not read past, as its chat's red number
  /// counts it (attention.dart).
  bool mentionUnread(SuperTabMention mention) =>
      mention.resolvedBy == null &&
      (mention.messageSequence ?? _unknown) >
          (mention.threadId == null
              ? controller.readMark(mention.conversationId)
              : controller.threadReadMark(mention.threadId!));

  /// The followed threads with replies the reader has not read, newest reply
  /// first; one read during this visit stays, bold, until the view is left.
  List<SuperTabFollowedThread> get newReplies => [
    for (final t in attention.shown)
      if (attention.isNew(t)) t,
  ];

  /// The Activity row's red number: what was asked of the reader and is
  /// unanswered. Tags, replies and stuck tasks nobody was asked about are in
  /// Activity but add nothing. Until the decisions are read the server's count
  /// stands in for them.
  int get count {
    final snapshot = _snapshot;
    if (snapshot == null) return 0;
    return (decisions.loaded
            ? decisions.open.length
            : snapshot.decisionsWaiting) +
        _asking(snapshot).length;
  }

  /// Whether the Activity row is bold: something needs the reader, or a tag
  /// or a thread they follow has news they have not read.
  bool get unread => count > 0 || _tags.isNotEmpty || attention.threadsUnread;

  /// What the reader's PM answered for them today, newest first: decisions
  /// they left to the PM, or that waited 24 hours.
  List<SuperTabDecision> get handledToday {
    final now = clock.now();
    return [
      for (final d in decisions.answered)
        if (d.delegated &&
            d.answeredAt != null &&
            dayOf(d.answeredAt!.toLocal(), now) == SuperTabDay.today)
          d,
    ]..sort((a, b) => b.answeredAt!.compareTo(a.answeredAt!));
  }

  /// The tags that wait and the earlier ones (read or answered), newest first,
  /// folded by author and chat; unread ones are bold, the rest are read rows.
  List<SuperTabMentionRow> get mentionRows {
    final epoch = DateTime.fromMillisecondsSinceEpoch(0);
    final all = [...mentions.waiting, ...mentions.earlier];
    // The index breaks ties: `sort` is not stable, and equal times must keep
    // the server's order so neighbours from one author still fold.
    final order = [for (var i = 0; i < all.length; i++) i]
      ..sort((a, b) {
        final byTime = (all[b].createdAt ?? epoch).compareTo(
          all[a].createdAt ?? epoch,
        );
        return byTime != 0 ? byTime : a.compareTo(b);
      });
    return groupMentions([for (final i in order) all[i]], mentionUnread);
  }

  /// The followed threads with news today.
  List<SuperTabFollowedThread> get threadRows => newReplies;

  /// What the listed [decided] call their PM: the coordinator of their
  /// project, or `the PMs` when they come from several.
  String coordinatorFor(Iterable<SuperTabDecision> decided) {
    final projects = {for (final d in decided) d.projectId};
    final snapshot = _snapshot;
    if (projects.length != 1 || snapshot == null) return 'the PMs';
    return snapshot.coordinatorNameOf(projects.single);
  }

  /// The view opened: reads what it lists now; what is new stays bold until
  /// [closed].
  void opened() {
    _open = true;
    attention.opened();
    unawaited(mentions.load());
    unawaited(decisions.load());
  }

  /// The view was left. It marks nothing read: it showed no reply or reaction
  /// row, and a thread is read when it is opened.
  void closed() {
    if (!_open) return;
    _open = false;
    // The view is going away while this runs (its dispose): what listens is
    // told after the frame's teardown, never during it.
    scheduleMicrotask(() {
      if (_disposed) return;
      attention.closed();
      notifyListeners();
    });
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    controller.removeListener(notifyListeners);
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
      if (controller.notifyOf(group.id) != SuperTabNotify.all) continue;
      if (controller.selectedId == group.id && _openChatRead) continue;
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
  bool get _openChatRead {
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
