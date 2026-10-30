/// The dial's rule for a finished turn, on a phone.
///
/// Ported from the firmware, which is where this was decided and argued out:
/// `devices/harness-device/firmware/main/cable_client.c` (the `summary` frame)
/// and `ui_notify_task_done` in `firmware/main/ui/ui_screens.c`. Keep the two in
/// step — a turn the dial stays quiet about must not make the phone buzz.
library;

import 'agent_notice.dart';

/// How loudly the daemon says one finished turn should be told — decided once
/// for every screen (`cli/src/lib/notifyTier.ts`: rules first, Jev for the
/// rest, "list if it ran 120 s or more" when Jev cannot answer). It rides the
/// `turn_summary` that follows `turn_ended`, as its payload's `tier`.
enum NoticeTier {
  /// News now: the dial beeps, wakes and files a drawer row.
  alert,

  /// Worth a glance later: a drawer row, no beep, no wake.
  list,

  /// Not news: nothing is filed.
  silent,
}

/// Reads the wire's `"alert" | "list" | "silent"`. Null when absent or a word
/// this build does not know — the old rule applies, as the dial's
/// `ui_notify_summary` falls back to its flags.
NoticeTier? noticeTierFrom(Object? raw) => switch (raw) {
  'alert' => NoticeTier.alert,
  'list' => NoticeTier.list,
  'silent' => NoticeTier.silent,
  _ => null,
};

/// One turn's end, as the machine socket reported it.
///
/// The flags come straight off the `turn_ended` frame. Every one of them is
/// ABSENT from an older daemon and absent reads as false, so a phone talking to
/// one notifies exactly as if the daemon had said "yes, this is news".
typedef TurnEnd = ({
  /// Killed by an interrupt. The dial draws a bare `done` for it — no beep, no
  /// recap — because the person who pressed stop already knows.
  bool aborted,

  /// A turn re-read from disk while a session was picked back up, not one
  /// finishing now. The dial's `restore` door: history being filled in must not
  /// announce every turn that ended while nobody was connected.
  bool replay,

  /// An Orchestrator specialist's turn, or its Director's while specialists are
  /// still out — the dial's `silent`. "chỉ cần báo thằng main thôi" (owner,
  /// 2026-09-21): only the main agent is worth hearing from.
  bool subagent,

  /// What the turn said, or null when it said nothing. The dial rings on the
  /// SUMMARY, never on the bare `done`: a tools-only or phantom turn has no
  /// summary, stays silent, and the notification always has words in it.
  String? reply,

  /// The daemon's [NoticeTier] for this turn, from the `turn_summary` after
  /// it — never on `turn_ended` itself, which leaves before it is decided.
  /// Null from a daemon that does not decide one, or did not say in time:
  /// every end that is news escalates as it always did.
  NoticeTier? tier,
});

/// Reads a [TurnEnd] off one `turn_ended` frame. [reply] is what the phone saw
/// the turn say (`SessionPreview.turnReply`), which the frame does not carry;
/// nor its tier, which the `turn_summary` after it does.
TurnEnd turnEndFrom(
  Map<String, dynamic> event,
  Map<String, dynamic> payload, {
  required String? reply,
}) => (
  aborted: payload['aborted'] == true,
  replay: event['replay'] == true,
  subagent: event['subagent'] == true,
  reply: reply,
  tier: null,
);

/// Whether a turn's end is news at all — what no tier can change: not killed,
/// not a replay, not a sub-agent's, and it said something.
bool isNewsEnd(TurnEnd end) {
  if (end.aborted || end.replay || end.subagent) return false;
  final reply = end.reply;
  return reply != null && reply.trim().isNotEmpty;
}

/// Decides what one turn's end is worth.
///
/// [inFront] is whether the app is on screen at all; [watching] whether the
/// agent it is showing is the one that finished — only meaningful in front.
///
/// The [TurnEnd] flags say whether the end is news at all; its tier, when
/// the daemon sends one, says how loud. As on the dial
/// (`ui_notify_summary`, 2026-10-19): the agent on screen already shows its
/// own news and gets nothing, a `list` turn is a mark with no tap and no
/// notice, and only an `alert` goes as far as the phone's place allows.
AgentNotice decideDoneNotice(
  TurnEnd end, {
  required bool inFront,
  required bool watching,
}) {
  if (!isNewsEnd(end)) return AgentNotice.none;
  final tier = end.tier;
  if (tier == null) return escalate(inFront: inFront, watching: watching);
  if (tier == NoticeTier.silent || (inFront && watching)) {
    return AgentNotice.none;
  }
  if (tier == NoticeTier.list) return AgentNotice.filed;
  return escalate(inFront: inFront, watching: false);
}
