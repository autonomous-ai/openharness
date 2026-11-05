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

/// A question heard while the app is in front, waiting out
/// [AgentAnnouncer.questionGrace] before it buzzes.
typedef _PendingQuestion = ({
  NoticeAgent agent,
  String requestId,
  String prompt,
  bool Function() watching,
  Timer timer,
});

/// One request of one agent: what a question that comes back is known by.
typedef _QuestionKey = ({AgentRef ref, String requestId});

/// What the phone did with one question lately: when it was first heard, when
/// it was last heard or closed, and whether the person was told of it.
typedef _HeardQuestion = ({DateTime first, DateTime touched, bool told});

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
    this.questionGrace = const Duration(seconds: 15),
    this.alertCooldown = const Duration(minutes: 5),
    this.reopenWindow = const Duration(minutes: 10),
    DateTime Function()? now,
  }) : _chime = chime ?? _haptic,
       _inFront = inFront ?? _appInFront,
       _now = now ?? DateTime.now {
    _away.attach();
  }

  final SystemNotices system;
  final unread = AgentUnread();
  final _asked = AskedQuestions();

  /// How long a question waits, while the app is in front, before it buzzes.
  /// One answered within it — at the computer, by an auto mode, on another
  /// client — was never the person's to hear (2026-11-05: a Team machine's
  /// approvals, each answered at its desk in seconds, buzzed a phone over and
  /// over). Its mark shows at once. Away it goes at once, and so does one
  /// still waiting when the app goes away ([wentAway]): iOS suspends a
  /// backgrounded app within seconds, and a timer then fires only when it is
  /// opened again.
  final Duration questionGrace;

  /// After an agent buzzes for a question, its next ones within this long are
  /// posted quietly ([AgentNotice.quiet]): a run of approvals is one
  /// interruption, then quiet updates of the same notice.
  final Duration alertCooldown;

  /// How long a question is remembered after it was last heard or closed. One
  /// back within it — its dialog flickered off the pane and on, and the daemon
  /// closed and announced it again with the same id — never buzzes twice.
  final Duration reopenWindow;

  final DateTime Function() _now;
  late final _away = _AwayWatch(wentAway);

  /// Questions waiting out [questionGrace]: the newest per agent.
  final _pendingQuestions = <AgentRef, _PendingQuestion>{};

  /// Questions heard within [reopenWindow], and those still open.
  final _heard = <_QuestionKey, _HeardQuestion>{};

  /// When each agent last buzzed for a question ([alertCooldown]).
  final _lastBuzz = <AgentRef, DateTime>{};

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
  /// daemon's id for it, which a re-announce repeats. What was done now: a
  /// new question in front is only marked until its [questionGrace] runs out.
  AgentNotice questionAsked(
    NoticeAgent agent, {
    required String requestId,
    required String prompt,
    required bool Function() watching,
  }) {
    final ref = agent.ref;
    final now = _now();
    // Before hearing it: heard first, this very request would read as open,
    // and be kept however long ago it was last told.
    _forgetOldQuestions(now);
    if (!_asked.hear(ref, requestId)) {
      appLog.debug('notify', 'question · ${_short(ref)} · open already · none');
      return AgentNotice.none;
    }
    // Only the newest question is asked: one still waiting is dropped.
    _pendingQuestions.remove(ref)?.timer.cancel();
    final key = (ref: ref, requestId: requestId);
    final before = _heard[key];
    final heard = (
      first: before?.first ?? now,
      touched: now,
      told: before?.told ?? false,
    );
    _heard[key] = heard;
    final front = inFront;
    final wait = heard.first.add(questionGrace).difference(now);
    // Away there is no time to wait; on the agent its pane shows the dialog;
    // one told of already never buzzes; one back after its grace ran out,
    // while its dialog was off the pane, has waited long enough.
    if (!front || watching() || heard.told || wait <= Duration.zero) {
      return _askNow(agent, requestId: requestId, prompt: prompt, watching: watching);
    }
    unread.mark(ref, NoticeKind.question);
    _pendingQuestions[ref] = (
      agent: agent,
      requestId: requestId,
      prompt: prompt,
      watching: watching,
      timer: Timer(wait, () => _questionDue(ref)),
    );
    appLog.debug('notify', 'question · ${_short(ref)} · front · waits ${wait.inSeconds}s · filed');
    return AgentNotice.filed;
  }

  /// Tells of question [requestId] now, by where the person is ([decideQuestionNotice]).
  AgentNotice _askNow(
    NoticeAgent agent, {
    required String requestId,
    required String prompt,
    required bool Function() watching,
  }) {
    final ref = agent.ref;
    final now = _now();
    final key = (ref: ref, requestId: requestId);
    final heard = _heard[key];
    final told = heard?.told ?? false;
    final front = inFront;
    final seen = front && watching();
    final last = _lastBuzz[ref];
    final cooling = last != null && now.difference(last) < alertCooldown;
    final notice = decideQuestionNotice(
      isNew: true,
      inFront: front,
      watching: seen,
      told: told,
      cooling: cooling,
    );
    if (notice == AgentNotice.alert) _lastBuzz[ref] = now;
    _heard[key] = (first: heard?.first ?? now, touched: now, told: true);
    appLog.debug('notify', 'question · ${_short(ref)} · ${front ? 'front' : 'away'}${seen ? ' · watching' : ''}${told ? ' · told' : ''}${cooling ? ' · cooling' : ''} · ${notice.name}');
    _deliver(agent, notice, NoticeKind.question, () => noticeBody(prompt));
    return notice;
  }

  /// [ref]'s question waited out its grace, or the app is going away while it
  /// waits: told now.
  void _questionDue(AgentRef ref) {
    final waiting = _pendingQuestions.remove(ref);
    if (waiting == null) return;
    waiting.timer.cancel();
    _askNow(
      waiting.agent,
      requestId: waiting.requestId,
      prompt: waiting.prompt,
      watching: waiting.watching,
    );
  }

  /// The app left the screen: every question still waiting out its grace is
  /// told now, while there is time to post it — iOS suspends a backgrounded
  /// app within seconds, and its timers with it.
  void wentAway() {
    for (final ref in _pendingQuestions.keys.toList()) {
      _questionDue(ref);
    }
  }

  /// Forgets the questions last heard or closed more than [reopenWindow] ago,
  /// keeping those still open: one asked for an hour is still the same
  /// question when its dialog flickers.
  void _forgetOldQuestions(DateTime now) {
    _heard.removeWhere(
      (key, heard) =>
          now.difference(heard.touched) > reopenWindow &&
          _asked.openOn(key.ref) != key.requestId,
    );
  }

  /// The question is off the pane — answered here, by hand, on another client
  /// or on the dial. Its mark and its notice go with it: news nobody can act
  /// on any more is not news. A finished turn's mark is left alone. What was
  /// told of it is kept ([reopenWindow]), and a grace it was waiting out
  /// resumes if it comes back.
  void questionClosed(AgentRef ref, {String? requestId}) {
    final open = _asked.openOn(ref);
    if (!_asked.forget(ref, requestId: requestId)) return;
    _pendingQuestions.remove(ref)?.timer.cancel();
    if (open != null) {
      final key = (ref: ref, requestId: open);
      if (_heard[key] case final heard?) {
        _heard[key] = (first: heard.first, touched: _now(), told: heard.told);
      }
    }
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
  /// finished turn still waiting for its tier is not announced after. A
  /// question still waiting out its grace is not either: the person has seen
  /// its dialog, and it counts as told.
  void seen(AgentRef ref) {
    _awaitingTier.remove(ref)?.timer.cancel();
    _pendingQuestions.remove(ref)?.timer.cancel();
    if (_asked.openOn(ref) case final open?) {
      final key = (ref: ref, requestId: open);
      final heard = _heard[key];
      final now = _now();
      _heard[key] = (first: heard?.first ?? now, touched: now, told: true);
    }
    unread.clear(ref);
    _withdraw(ref);
  }

  /// The agent is gone. An agent that no longer exists cannot be gone to, and
  /// a notice about it would open nothing.
  void forgetAgent(AgentRef ref) {
    _asked.forget(ref);
    seen(ref);
    _heard.removeWhere((key, _) => key.ref == ref);
    _lastBuzz.remove(ref);
  }

  /// Signed out: nothing any of it was about is this person's any more.
  void reset() {
    _cancelAwaiting();
    unread.clearAll();
    _asked.clear();
    _heard.clear();
    _lastBuzz.clear();
    _posted.toList().forEach(_withdraw);
  }

  void _cancelAwaiting() {
    for (final waiting in _awaitingTier.values) {
      waiting.timer.cancel();
    }
    _awaitingTier.clear();
    for (final waiting in _pendingQuestions.values) {
      waiting.timer.cancel();
    }
    _pendingQuestions.clear();
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
      quiet: notice == AgentNotice.quiet,
    ));
  }

  /// [system] is left alone: the shell may still be letting go of its
  /// [SystemNotices.opened] after the notifier has gone.
  void dispose() {
    _cancelAwaiting();
    _away.detach();
    unread.dispose();
  }
}

/// Calls [onAway] when the app leaves the screen: hidden or paused. A plain
/// observer rather than an `AppLifecycleListener`, which asserts on the jumps
/// between states that widget tests make.
class _AwayWatch extends WidgetsBindingObserver {
  _AwayWatch(this.onAway);

  final VoidCallback onAway;
  bool _attached = false;

  /// Tolerant of there being NO binding, as [AgentAnnouncer._appInFront] is:
  /// plain `test()`s build the announcer without one.
  void attach() {
    try {
      WidgetsBinding.instance.addObserver(this);
      _attached = true;
    } catch (_) {}
  }

  void detach() {
    if (!_attached) return;
    _attached = false;
    try {
      WidgetsBinding.instance.removeObserver(this);
    } catch (_) {}
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      onAway();
    }
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
