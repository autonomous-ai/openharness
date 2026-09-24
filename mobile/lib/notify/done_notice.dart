/// The dial's rule for a finished turn, on a phone.
///
/// Ported from the firmware, which is where this was decided and argued out:
/// `devices/harness-device/firmware/main/cable_client.c` (the `summary` frame)
/// and `ui_notify_task_done` in `firmware/main/ui/ui_screens.c`. Keep the two in
/// step — a turn the dial stays quiet about must not make the phone buzz.
library;

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
});

/// Reads a [TurnEnd] off one `turn_ended` frame. [reply] is what the phone saw
/// the turn say (`SessionPreview.turnReply`), which the frame does not carry.
TurnEnd turnEndFrom(
  Map<String, dynamic> event,
  Map<String, dynamic> payload, {
  required String? reply,
}) => (
  aborted: payload['aborted'] == true,
  replay: event['replay'] == true,
  subagent: event['subagent'] == true,
  reply: reply,
);

/// What the phone does about one finished turn — escalating, each step doing
/// everything the one before it does.
enum DoneNotice {
  /// Not news. Nothing at all.
  none,

  /// The person is looking straight at this agent. The tap still comes — the
  /// dial's beep ALWAYS sounds, because somebody reading the last reply is not
  /// watching for the next to end — but nothing is filed for later: they are
  /// already where the news is.
  chime,

  /// The app is in front of the person, on something else. Chime, and mark the
  /// agent unread — the dial's badge. Never more than that: an agent finishing
  /// elsewhere must not yank anybody off what they are doing.
  mark,

  /// The app is not in front of anybody. Mark it, and post a system
  /// notification — the dial waking its dark panel onto the drawer.
  alert;

  bool get chimes => this != none;
  bool get marks => this == mark || this == alert;
  bool get alerts => this == alert;
}

/// Decides what one turn's end is worth.
///
/// [inFront] is whether the app is on screen at all; [watching] whether the
/// agent it is showing is the one that finished — only meaningful in front.
DoneNotice decideDoneNotice(
  TurnEnd end, {
  required bool inFront,
  required bool watching,
}) {
  if (end.aborted || end.replay || end.subagent) return DoneNotice.none;
  final reply = end.reply;
  if (reply == null || reply.trim().isEmpty) return DoneNotice.none;
  if (!inFront) return DoneNotice.alert;
  if (watching) return DoneNotice.chime;
  return DoneNotice.mark;
}
