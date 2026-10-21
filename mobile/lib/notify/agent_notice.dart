/// What the phone says about an agent, and how loudly — shared by the two
/// things the dial announces: a turn that finished (`done_notice.dart`) and a
/// question waiting on the person (`question_notice.dart`).
library;

/// What the news is. The NEWEST kind wins on an agent: one that finished and
/// then asked something is waiting on a person, and that is the mark worth
/// showing — the desktop's `AgentUnread` rule.
enum NoticeKind { done, question }

/// How far one piece of news goes. [chime], [mark] and [alert] escalate, each
/// doing everything the one before it does; [filed] is a mark on its own.
enum AgentNotice {
  /// Not news. Nothing at all.
  none,

  /// Worth a glance later, not now — the daemon's `list` tier. The agent is
  /// marked, with no tap and no system notice: the dial files a drawer row
  /// without a beep or a wake.
  filed,

  /// The person is looking straight at this agent. The tap still comes — the
  /// dial's beep ALWAYS sounded before the daemon sent a tier — but nothing is
  /// filed for later: they are already where the news is.
  chime,

  /// The app is in front of the person, on something else. Chime, and mark the
  /// agent — the dial's badge.
  mark,

  /// The app is not in front of anybody. Mark it, and post a system
  /// notification — the dial waking its dark panel.
  alert;

  bool get chimes => this == chime || this == mark || this == alert;
  bool get marks => this == filed || this == mark || this == alert;
  bool get alerts => this == alert;
}

/// How far news that IS news goes, by where the person is. [watching] — the
/// agent on screen is the one it is about — only counts in front.
AgentNotice escalate({required bool inFront, required bool watching}) {
  if (!inFront) return AgentNotice.alert;
  if (watching) return AgentNotice.chime;
  return AgentNotice.mark;
}
