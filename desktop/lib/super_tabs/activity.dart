import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/widgets.dart';

import 'attention.dart';
import 'controller.dart';
import 'decisions.dart';
import 'model.dart';
import 'notifications.dart';

/// What one row of Needs you is.
enum SuperTabNeedKind { decision, agent, mention }

/// One row of Needs you: a decision asked of the reader, an agent waiting on
/// them, or a tag of them.
class SuperTabNeed {
  const SuperTabNeed({
    required this.kind,
    required this.id,
    required this.title,
    required this.conversationId,
    this.at,
    this.decision,
    this.mention,
  });
  final SuperTabNeedKind kind;

  /// Stable across reads: `decision:<id>`, `agent:<group>`, `mention:<id>`.
  final String id;

  /// What the row says: the question, `<agent> is waiting on you`, or
  /// `<author> mentioned you in # <project>`.
  final String title;
  final String conversationId;
  final DateTime? at;
  final SuperTabDecision? decision;
  final SuperTabMention? mention;
}

/// The reader's Activity in one Swarm: the one place for everything new for
/// them (Quiet Swarm design, screens 6 and 11b). Three lists over what the
/// Swarm already holds, no feed of its own:
///
/// * Needs you: decisions asked of them, agents waiting on them and their
///   tags. Its length is Activity's number.
/// * New replies: the followed threads with replies they have not read.
/// * Done today: tasks that shipped today.
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

  /// Decisions asked of the reader, then agents waiting on them, then their
  /// tags; each newest first.
  List<SuperTabNeed> get needsYou {
    final snapshot = _snapshot;
    if (snapshot == null) return const [];
    final epoch = DateTime.fromMillisecondsSinceEpoch(0);
    final asked = decisions.open;
    final decided = {for (final d in asked) d.conversationId};
    final people = {for (final p in snapshot.people) p.id: p};
    return [
      for (final d in [
        ...asked,
      ]..sort((a, b) => (b.createdAt ?? epoch).compareTo(a.createdAt ?? epoch)))
        SuperTabNeed(
          kind: SuperTabNeedKind.decision,
          id: 'decision:${d.id}',
          title: d.question,
          conversationId: d.conversationId,
          at: d.createdAt,
          decision: d,
        ),
      for (final group in snapshot.conversations)
        if (_waiting(snapshot, group, decided))
          SuperTabNeed(
            kind: SuperTabNeedKind.agent,
            id: 'agent:${group.id}',
            title:
                '${_agentName(snapshot, group.assignment!['agentId'] as String)} is waiting on you',
            conversationId: group.id,
          ),
      for (final m in [
        ..._tags,
      ]..sort((a, b) => (b.createdAt ?? epoch).compareTo(a.createdAt ?? epoch)))
        SuperTabNeed(
          kind: SuperTabNeedKind.mention,
          id: 'mention:${m.id}',
          title:
              '${people[m.leadId]?.username ?? m.leadName} mentioned you in # ${m.projectName}',
          conversationId: m.conversationId,
          at: m.createdAt,
          mention: m,
        ),
    ];
  }

  /// A tag from a server that does not say where it is: it counts until
  /// answered, past any read mark. Not `1 << 52`: a shift is 32 bits on the web.
  static const _unknown = 9007199254740991;

  /// The tags that need the reader: not read past (the number clears by
  /// reading). One in a thread that New replies lists is shown there instead;
  /// a tag in a thread the reader does not follow still needs them.
  Iterable<SuperTabMention> get _tags {
    final listed = {
      for (final t in newReplies) '${t.conversationId}/${t.rootId}',
    };
    return mentions.waiting.where(
      (m) =>
          mentionUnread(m) &&
          (m.threadId == null ||
              !listed.contains('${m.conversationId}/${m.threadId}')),
    );
  }

  /// A task whose agent waits on the reader (it needs a decision, or is
  /// stuck) and has not already asked it as a decision.
  bool _waiting(
    SuperTabSnapshot snapshot,
    SuperTabConversation group,
    Set<String> decided,
  ) {
    final work = group.assignment;
    if (work == null ||
        group.closed ||
        group.isBuddyChat ||
        decided.contains(group.id) ||
        !superTabWorkWaits(work['status']) ||
        snapshot.agent(work['agentId'] as String? ?? '') == null) {
      return false;
    }
    // Whoever it asked, else whoever asked for the task, else the Swarm's
    // owner: a task waiting on nobody named is for no other reader.
    final forThem =
        work['askedOf'] as String? ?? group.requesterId ?? snapshot.ownerId;
    return forThem == controller.accountId;
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

  /// Tasks that shipped today (the reader's day), newest first: no review or
  /// test step, no Buddy chat.
  List<SuperTabConversation> get doneToday {
    final snapshot = _snapshot;
    if (snapshot == null) return const [];
    final now = clock.now();
    bool today(DateTime at) =>
        at.year == now.year && at.month == now.month && at.day == now.day;
    return [
      for (final g in snapshot.conversations)
        if (g.shippedAt case final at? when today(at.toLocal()))
          if (g.reviewOf == null && !g.isBuddyChat) g,
    ]..sort((a, b) => b.shippedAt!.compareTo(a.shippedAt!));
  }

  /// The Activity row's red number: what needs the reader, and nothing else.
  /// A tag counts until it is read, a decision or an agent waiting until it
  /// is answered. Before the tags are read the server's count stands in.
  int get count {
    final snapshot = _snapshot;
    if (snapshot == null) return 0;
    final decided = {for (final d in decisions.open) d.conversationId};
    final tags = mentions.waiting.isEmpty && snapshot.mentionsWaiting > 0
        ? snapshot.mentionsWaiting
        : _tags.length;
    return tags +
        snapshot.decisionsWaiting +
        snapshot.conversations
            .where((g) => _waiting(snapshot, g, decided))
            .length;
  }

  /// Whether the Activity row is bold: something needs the reader, or a thread
  /// they follow has replies they have not read.
  bool get unread => count > 0 || attention.threadsUnread;

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
