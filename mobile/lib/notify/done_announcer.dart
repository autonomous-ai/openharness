import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';

import 'agent_unread.dart';
import 'done_notice.dart';
import 'system_notices.dart';

/// Who finished, in the words the notice uses.
typedef DoneAgent = ({AgentRef ref, String name, String machine});

/// Carries out [decideDoneNotice]: the chime, the unread mark, the system
/// notice. The notifier says what happened; this decides what it is worth and
/// does it, so none of the three can drift from the rule.
class DoneAnnouncer {
  DoneAnnouncer({
    required this.system,
    Future<void> Function()? chime,
    bool Function()? inFront,
  }) : _chime = chime ?? _haptic,
       _inFront = inFront ?? _appInFront;

  final SystemNotices system;
  final unread = AgentUnread();
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
  DoneNotice turnEnded(
    DoneAgent agent,
    TurnEnd end, {
    required bool Function() watching,
  }) {
    final front = inFront;
    final notice = decideDoneNotice(
      end,
      inFront: front,
      watching: front && watching(),
    );
    if (notice.chimes && front) _chime();
    if (notice.marks) unread.mark(agent.ref);
    if (notice.alerts) {
      system.show((
        agent: agent.ref,
        title: agent.name,
        machine: agent.machine,
        body: noticeBody(end.reply!),
      ));
    }
    return notice;
  }

  /// [system] is left alone: the shell may still be letting go of its
  /// [SystemNotices.opened] after the notifier has gone.
  void dispose() => unread.dispose();
}

/// The reply, cut to what a lock screen shows: its last paragraph — where an
/// agent says what it did — on one line, at most [limit] characters.
String noticeBody(String reply, {int limit = 180}) {
  final paragraphs = reply
      .trim()
      .split(RegExp(r'\n\s*\n'))
      .where((p) => p.trim().isNotEmpty);
  final last = paragraphs.isEmpty ? reply : paragraphs.last;
  final line = last.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (line.length <= limit) return line;
  return '${line.substring(0, limit - 1).trimRight()}…';
}
