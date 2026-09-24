import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';

import 'agent_notice.dart';
import 'agent_unread.dart';
import 'done_notice.dart';
import 'question_notice.dart';
import 'system_notices.dart';

/// Who the news is about, in the words the notice uses.
typedef NoticeAgent = ({AgentRef ref, String name, String machine});

/// Carries out the dial's two rules — [decideDoneNotice] and
/// [decideQuestionNotice]: the chime, the unread mark, the system notice. The
/// notifier says what happened; this decides what it is worth and does it, so
/// none of the three can drift from the rule.
class AgentAnnouncer {
  AgentAnnouncer({
    required this.system,
    Future<void> Function()? chime,
    bool Function()? inFront,
  }) : _chime = chime ?? _haptic,
       _inFront = inFront ?? _appInFront;

  final SystemNotices system;
  final unread = AgentUnread();
  final _asked = AskedQuestions();

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
  /// Unknown counts as in front, which errs toward a mark over a notice.
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
    final front = inFront;
    final notice = decideDoneNotice(
      end,
      inFront: front,
      watching: front && watching(),
    );
    _deliver(agent, notice, NoticeKind.done, () => noticeBody(end.reply!));
    return notice;
  }

  /// The agent stopped to ask the person [prompt]. [requestId] is the
  /// daemon's id for it, which a re-announce repeats.
  AgentNotice questionAsked(
    NoticeAgent agent, {
    required String requestId,
    required String prompt,
    required bool Function() watching,
  }) {
    final front = inFront;
    final notice = decideQuestionNotice(
      isNew: _asked.hear(agent.ref, requestId),
      inFront: front,
      watching: front && watching(),
    );
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

  /// The person went to the agent — tapped its row, its notice, or came back
  /// to the app on it. Whatever it was carrying has been read: the mark AND
  /// the notice still sitting in the OS centre come down together.
  void seen(AgentRef ref) {
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
    unread.clearAll();
    _asked.clear();
    _posted.toList().forEach(_withdraw);
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
  void dispose() => unread.dispose();
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
  return '${line.substring(0, limit - 1).trimRight()}…';
}
