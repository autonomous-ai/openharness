import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/logging/app_log.dart';

import 'agent_notice.dart';
import 'agent_unread.dart';
import 'done_notice.dart';
import 'question_notice.dart';
import 'system_notices.dart';

/// Who the news is about, in the words the notice uses.
typedef NoticeAgent = ({AgentRef ref, String name, String machine});

/// A turn that ended as news, waiting for the daemon to say how loudly.
typedef _AwaitingTier = ({
  NoticeAgent agent,
  TurnEnd end,
  bool Function() watching,
  Timer timer,
});

/// Carries out the dial's two rules — [decideDoneNotice] and
/// [decideQuestionNotice]: the chime, the unread mark, the system notice. The
/// notifier says what happened; this decides what it is worth and does it, so
/// none of the three can drift from the rule.
class AgentAnnouncer {
  AgentAnnouncer({
    required this.system,
    Future<void> Function()? chime,
    bool Function()? inFront,
    this.tierWait = const Duration(seconds: 4),
  }) : _chime = chime ?? _haptic,
       _inFront = inFront ?? _appInFront;

  final SystemNotices system;
  final unread = AgentUnread();
  final _asked = AskedQuestions();

  /// How long a turn's end waits for the daemon's tier. It follows
  /// `turn_ended` by the daemon's decision — at most a second of Jev — and the
  /// relay; an older daemon's `turn_summary`, with none, comes at once. A
  /// recap held for a sub-agent comes later than this, and its turn is told by
  /// the old rule rather than not at all.
  final Duration tierWait;

  /// Turns that ended as news and wait for their tier: the newest per agent.
  final _awaitingTier = <AgentRef, _AwaitingTier>{};

  /// Agents with a notice up in the OS centre right now. What lets going to
  /// an agent take its notice down — a notice about news already read is a
  /// second thing to dismiss by hand — without asking the OS for one that was
  /// never posted.
  final _posted = <AgentRef>{};
  final Future<void> Function() _chime;
  final bool Function() _inFront;

  /// The dial's three tones, as a phone says them without a sound: a tap the
  /// hand feels even with the ringer off. Never worth an error — a plain
  /// `test()` has no binding to send it through.
  static Future<void> _haptic() async {
    try {
      await HapticFeedback.mediumImpact();
    } catch (_) {}
  }

  /// Whether the app is on screen. ⚠️ Tolerant of there being NO binding, as
  /// the desktop's `lifecycle` is: plain `test()`s drive the notifier without
  /// one, and `WidgetsBinding.instance` throws rather than answering null.
  /// Unknown counts as in front, which errs toward the agent on screen being
  /// seen there rather than told about again.
  static bool _appInFront() {
    try {
      final state = WidgetsBinding.instance.lifecycleState;
      return state == null || state == AppLifecycleState.resumed;
    } catch (_) {
      return true;
    }
  }

  bool get inFront => _inFront();

  /// One turn ended. [watching] is whether [agent] is the one on screen —
  /// only asked when the app is in front.
  AgentNotice turnEnded(
    NoticeAgent agent,
    TurnEnd end, {
    required bool Function() watching,
  }) {
    // Whatever it was asking, the turn it asked in is over — and a turn that
    // ends with nothing to say must not leave the question's mark standing.
    questionClosed(agent.ref);
    return _announceEnd(agent, end, watching: watching);
  }

  /// One turn ended, and the daemon says how loudly on the `turn_summary`
  /// after it ([tierDecided]). The notice waits for that, at most [tierWait];
  /// an end that is not news waits for nothing. Where the person is, is read
  /// when it goes.
  void turnEndedAwaitingTier(
    NoticeAgent agent,
    TurnEnd end, {
    required bool Function() watching,
  }) {
    questionClosed(agent.ref);
    _awaitingTier.remove(agent.ref)?.timer.cancel();
    if (!isNewsEnd(end)) {
      appLog.debug('notify', 'turn end · ${_short(agent.ref)} · not news');
      return;
    }
    _awaitingTier[agent.ref] = (
      agent: agent,
      end: end,
      watching: watching,
      timer: Timer(tierWait, () => tierDecided(agent.ref, null)),
    );
  }

  /// The daemon said how loudly [ref]'s turn tells — or nothing ([tier] null:
  /// an older daemon, or not in time). What was done, or null when no turn of
  /// [ref]'s was waiting.
  AgentNotice? tierDecided(AgentRef ref, NoticeTier? tier) {
    final waiting = _awaitingTier.remove(ref);
    if (waiting == null) return null;
    waiting.timer.cancel();
    appLog.debug('notify', 'tier · ${_short(ref)} · ${tier?.name ?? 'none'}');
    // A question asked since — Command Code asks AFTER its turn — is what the
    // person has to act on, and the daemon says no "done" over one either
    // (cli `lib/agentNotifications.ts`).
    if (_asked.asking(ref)) return AgentNotice.none;
    final end = waiting.end;
    return _announceEnd(waiting.agent, (
      aborted: end.aborted,
      replay: end.replay,
      subagent: end.subagent,
      reply: end.reply,
      tier: tier,
    ), watching: waiting.watching);
  }

  AgentNotice _announceEnd(
    NoticeAgent agent,
    TurnEnd end, {
    required bool Function() watching,
  }) {
    final front = inFront;
    final seen = front && watching();
    final notice = decideDoneNotice(end, inFront: front, watching: seen);
    // Ids and decisions only: what the turn said stays out of the log.
    appLog.debug('notify', 'done · ${_short(agent.ref)} · ${front ? 'front' : 'away'}${seen ? ' · watching' : ''} · ${notice.name}');
    _deliver(agent, notice, NoticeKind.done, () => noticeBody(end.reply!));
    return notice;
  }

  static String _short(AgentRef ref) => ref.agentId.length > 8 ? ref.agentId.substring(0, 8) : ref.agentId;

  /// The agent stopped to ask the person [prompt]. [requestId] is the
  /// daemon's id for it, which a re-announce repeats.
  AgentNotice questionAsked(
    NoticeAgent agent, {
    required String requestId,
    required String prompt,
    required bool Function() watching,
  }) {
    final front = inFront;
    final seen = front && watching();
    final notice = decideQuestionNotice(
      isNew: _asked.hear(agent.ref, requestId),
      inFront: front,
      watching: seen,
    );
    appLog.debug('notify', 'question · ${_short(agent.ref)} · ${front ? 'front' : 'away'}${seen ? ' · watching' : ''} · ${notice.name}');
    _deliver(agent, notice, NoticeKind.question, () => noticeBody(prompt));
    return notice;
  }

  /// The question is off the pane — answered here, by hand, on another client
  /// or on the dial. Its mark and its notice go with it: news nobody can act
  /// on any more is not news. A finished turn's mark is left alone.
  void questionClosed(AgentRef ref, {String? requestId}) {
    if (!_asked.forget(ref, requestId: requestId)) return;
    if (unread.kindFor(ref) != NoticeKind.question) return;
    unread.clear(ref, kind: NoticeKind.question);
    _withdraw(ref);
  }

  /// [machineId] said which of its questions are open at all — as an app
  /// connects, after each one still open (cli `core/questions.ts`
  /// `reannounceRemote`). One announced here and not among them was answered
  /// while the phone was away: its mark and its notice go, as on a close.
  void questionsOpen(String machineId, Set<String> requestIds) {
    for (final MapEntry(key: ref, value: requestId)
        in _asked.askedOn(machineId).entries) {
      if (!requestIds.contains(requestId)) {
        questionClosed(ref, requestId: requestId);
      }
    }
  }

  /// The person went to the agent — tapped its row, its notice, or came back
  /// to the app on it. Whatever it was carrying has been read: the mark AND
  /// the notice still sitting in the OS centre come down together, and a
  /// finished turn still waiting for its tier is not announced after.
  void seen(AgentRef ref) {
    _awaitingTier.remove(ref)?.timer.cancel();
    unread.clear(ref);
    _withdraw(ref);
  }

  /// The agent is gone. An agent that no longer exists cannot be gone to, and
  /// a notice about it would open nothing.
  void forgetAgent(AgentRef ref) {
    _asked.forget(ref);
    seen(ref);
  }

  /// Signed out: nothing any of it was about is this person's any more.
  void reset() {
    _cancelAwaiting();
    unread.clearAll();
    _asked.clear();
    _posted.toList().forEach(_withdraw);
  }

  void _cancelAwaiting() {
    for (final waiting in _awaitingTier.values) {
      waiting.timer.cancel();
    }
    _awaitingTier.clear();
  }

  void _withdraw(AgentRef ref) {
    if (_posted.remove(ref)) system.cancel(ref);
  }

  void _deliver(
    NoticeAgent agent,
    AgentNotice notice,
    NoticeKind kind,
    String Function() body,
  ) {
    if (notice.chimes && inFront) _chime();
    if (notice.marks) unread.mark(agent.ref, kind);
    if (!notice.alerts) return;
    _posted.add(agent.ref);
    system.show((
      agent: agent.ref,
      kind: kind,
      title: agent.name,
      machine: agent.machine,
      body: body(),
    ));
  }

  /// [system] is left alone: the shell may still be letting go of its
  /// [SystemNotices.opened] after the notifier has gone.
  void dispose() {
    _cancelAwaiting();
    unread.dispose();
  }
}

/// The text, cut to what a lock screen shows: its last paragraph — where an
/// agent says what it did — on one line, at most [limit] characters.
String noticeBody(String text, {int limit = 180}) {
  final paragraphs = text
      .trim()
      .split(RegExp(r'\n\s*\n'))
      .where((p) => p.trim().isNotEmpty);
  final last = paragraphs.isEmpty ? text : paragraphs.last;
  final line = last.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (line.length <= limit) return line;
  // Back off one unit rather than cut an emoji — or any character past the
  // BMP — in half: a lone surrogate reaches the lock screen as `�`, since the
  // platform channel encodes the body as UTF-8.
  var end = limit - 1;
  if (end > 0 && (line.codeUnitAt(end - 1) & 0xFC00) == 0xD800) end--;
  return '${line.substring(0, end).trimRight()}…';
}
