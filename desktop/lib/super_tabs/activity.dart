import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/widgets.dart';

import 'activity_rows.dart';
import 'attention.dart';
import 'controller.dart';
import 'decisions.dart';
import 'model.dart';
import 'notifications.dart';
import 'reminders.dart';

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
    this.agentId,
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

  /// The agent waiting on the reader, for an agent row: its terminal opens
  /// beside the task (#2792).
  final String? agentId;
}

/// Whether [mention] is unread for [controller]'s reader: what
/// [SuperTabActivity.mentionUnread] says, for a reader with no Activity.
bool superTabMentionUnread(
  SuperTabController controller,
  SuperTabMention mention,
) {
  if (mention.resolvedBy case 'read' || 'done') return false;
  final sequence = mention.messageSequence;
  if (sequence == null ||
      controller.snapshot?.conversation(mention.conversationId) == null) {
    return mention.resolvedBy == null;
  }
  return sequence >
      (mention.threadId == null
          ? controller.readMark(mention.conversationId)
          : controller.threadReadMark(mention.threadId!));
}

/// What one notice of [SuperTabActivity.notices] is: a reminder that is due,
/// an agent waiting on the reader, a decision asked of them, or a tag of them
/// they have not read.
enum SuperTabNoticeKind { reminder, agent, decision, mention }

/// One thing Activity lists for the reader, as the menu bar's Swarm section
/// lists it too (task #2914).
class SuperTabNotice {
  const SuperTabNotice.reminder(SuperTabReminder this.reminder)
    : kind = SuperTabNoticeKind.reminder,
      need = null,
      mention = null;
  SuperTabNotice.need(SuperTabNeed this.need)
    : kind = need.decision == null
          ? SuperTabNoticeKind.agent
          : SuperTabNoticeKind.decision,
      reminder = null,
      mention = null;
  const SuperTabNotice.mention(SuperTabMention this.mention)
    : kind = SuperTabNoticeKind.mention,
      reminder = null,
      need = null;

  final SuperTabNoticeKind kind;
  final SuperTabReminder? reminder;
  final SuperTabNeed? need;
  final SuperTabMention? mention;

  /// What opens it: the reminder's, decision's or tag's id; the chat's for an
  /// agent waiting.
  String get id => switch (kind) {
    SuperTabNoticeKind.reminder => reminder!.id,
    SuperTabNoticeKind.agent => need!.conversationId,
    SuperTabNoticeKind.decision => need!.decision!.id,
    SuperTabNoticeKind.mention => mention!.id,
  };

  String get conversationId =>
      reminder?.conversationId ??
      need?.conversationId ??
      mention!.conversationId;
}

/// The reader's Activity in one Swarm: the one place for everything new for
/// them (Quiet Swarm design, screens 6 and 11b). Three lists over what the
/// Swarm already holds, no feed of its own:
///
/// * Needs you: reminders they set that are due, decisions asked of them and
///   agents waiting on them. Its length is Activity's number.
/// * Mentions: the tags of them, folded by author and chat.
/// * Threads: the followed threads with replies they have not read.
///
/// Leaving the view marks nothing read: it shows no reply or reaction row,
/// and a thread is read when it is opened. One per controller.
class SuperTabActivity extends ChangeNotifier {
  SuperTabActivity._(this.controller)
    : mentions = SuperTabMentions.of(controller),
      decisions = SuperTabDecisions.of(controller),
      attention = SuperTabAttention.of(controller),
      reminders = SuperTabReminders.of(controller) {
    controller.addListener(notifyListeners);
    controller.onDispose(dispose);
    mentions.addListener(notifyListeners);
    decisions.addListener(notifyListeners);
    reminders.addListener(notifyListeners);
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
  final SuperTabReminders reminders;
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
          agentId: group.assignment!['agentId'] as String,
        ),
    ];
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
        _answered[group.id] != _askedBy(group) &&
        !group.closed &&
        !group.isBuddyChat &&
        !decided.contains(group.id) &&
        work['status'] == 'needs_human' &&
        work['askedOf'] == controller.accountId &&
        snapshot.agent(work['agentId'] as String? ?? '') != null;
  }

  /// The question each waiting task was answered on from Decisions, by its
  /// chat: it leaves the list until its agent asks again.
  final _answered = <String, String>{};

  /// Sends [words] in [need]'s task to the agent waiting on the reader, as
  /// the Decisions page's typed answer (task #2996); the row leaves until the
  /// agent asks something else. False when it was not sent.
  Future<bool> answerWaiting(SuperTabNeed need, String words) async {
    final text = words.trim();
    final agentId = need.agentId;
    if (text.isEmpty || agentId == null || need.decision != null) return false;
    final sent = await controller.command({
      'type': 'message.send',
      'conversationId': need.conversationId,
      'text': text,
      'replyTo': null,
      'recipientIds': [agentId],
    });
    if (sent == null || _disposed) return false;
    _answered[need.conversationId] = need.question ?? '';
    notifyListeners();
    return true;
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

  /// Whether [mention] shows bold: not read past (its thread's mark for a
  /// reply that lives in a thread) and not marked read. The server resolves a
  /// tag when the reader answers anyone, a Buddy's posts as them included, so
  /// only `read` and `done` say they saw it (Diego, #2887). A tag from a
  /// server that does not say where it is counts until resolved, and so does
  /// one in a chat the snapshot does not hold (archived, quiet): no read mark
  /// or Mark read can reach it here, so a resolved one would never clear.
  bool mentionUnread(SuperTabMention mention) =>
      superTabMentionUnread(controller, mention);

  /// Marks [tags] read: the ones that still wait are marked done on the
  /// server; the ones it resolved without the reader reading them move the
  /// read mark to their message (the thread's for a thread reply).
  void markMentionsRead(Iterable<SuperTabMention> tags) {
    final waiting = <SuperTabMention>[];
    for (final m in tags) {
      if (m.resolvedBy == null) {
        waiting.add(m);
      } else if (mentionUnread(m)) {
        final sequence = m.messageSequence!;
        if (m.threadId case final root?) {
          controller.markThreadRead(m.conversationId, root, sequence);
        } else {
          controller.markReadThrough(m.conversationId, sequence);
        }
      }
    }
    if (waiting.isNotEmpty) unawaited(mentions.doneAll(waiting));
  }

  /// The followed threads with replies the reader has not read, newest reply
  /// first; one read during this visit stays, bold, until the view is left.
  List<SuperTabFollowedThread> get newReplies => [
    for (final t in attention.shown)
      if (attention.isNew(t)) t,
  ];

  /// Needs you's number: what was asked of the reader and is unanswered, plus
  /// the reminders they set that are due. Replies and stuck tasks nobody was
  /// asked about add nothing. Until the decisions are read the server's count
  /// stands in for them.
  int get needsCount {
    final snapshot = _snapshot;
    if (snapshot == null) return 0;
    return (decisions.loaded
            ? decisions.open.length
            : snapshot.decisionsWaiting) +
        _asking(snapshot).length +
        reminders.due.length;
  }

  /// The sidebar's Mentions number: every unread tag once; until the tags
  /// are read, the server's waiting ones stand in for them.
  int get mentionsCount {
    final snapshot = _snapshot;
    if (snapshot == null) return 0;
    return mentions.loaded ? mentionsUnread : snapshot.mentionsWaiting;
  }

  /// The sidebar's Threads number: followed threads with replies the reader
  /// has not read. Never red (anh Dee, 11-05).
  int get threadsCount => _snapshot == null ? 0 : attention.unread.length;

  /// The Mentions tab's number: every unread tag once, folded or not.
  int get mentionsUnread =>
      [...mentions.waiting, ...mentions.earlier].where(mentionUnread).length;

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

  /// The unread tags, waiting or answered, newest first, folded by author and
  /// chat. A read one is not listed: Mentions shows only what is unread
  /// (Diego, #2887).
  List<SuperTabMentionRow> get mentionRows {
    final epoch = DateTime.fromMillisecondsSinceEpoch(0);
    final all = [
      ...mentions.waiting,
      ...mentions.earlier,
    ].where(mentionUnread).toList();
    // The index breaks ties: `sort` is not stable, and equal times must keep
    // the server's order so neighbours from one author still fold.
    final order = [for (var i = 0; i < all.length; i++) i]
      ..sort((a, b) {
        final byTime = (all[b].createdAt ?? epoch).compareTo(
          all[a].createdAt ?? epoch,
        );
        return byTime != 0 ? byTime : a.compareTo(b);
      });
    return groupMentions([for (final i in order) all[i]]);
  }

  /// Everything [count] counts, once each, in the order Activity draws it:
  /// Needs you (the due reminders, the agents waiting on the reader, then the
  /// decisions newest first), then every unread tag, newest first. The menu
  /// bar's Swarm section lists exactly this (task #2914), so its rows and
  /// Activity's red number agree once the lists are read.
  List<SuperTabNotice> get notices {
    if (_snapshot == null) return const [];
    final needs = needsYou;
    return [
      for (final r in reminders.due) SuperTabNotice.reminder(r),
      for (final n in needs)
        if (n.decision == null) SuperTabNotice.need(n),
      for (final n in needs)
        if (n.decision != null) SuperTabNotice.need(n),
      for (final row in mentionRows)
        for (final m in row.all) SuperTabNotice.mention(m),
    ];
  }

  /// The followed threads with news today.
  List<SuperTabFollowedThread> get threadRows => newReplies;

  /// The followed threads the reader has read, newest reply first, below the
  /// new ones (Darren, task #2835).
  List<SuperTabFollowedThread> get readThreadRows => [
    for (final t in attention.shown)
      if (!attention.isNew(t)) t,
  ];

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
    reminders.removeListener(notifyListeners);
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
