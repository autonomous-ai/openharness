/// What the phone says about an agent, and how loudly — shared by the two
/// things the dial announces: a turn that finished (`done_notice.dart`) and a
/// question waiting on the person (`question_notice.dart`).
library;

/// What the news is. The NEWEST kind wins on an agent: one that finished and
/// then asked something is waiting on a person, and that is the mark worth
/// showing — the desktop's `AgentUnread` rule.
enum NoticeKind { done, question }

/// How far one piece of news goes. [chime] and [alert] escalate, [alert]
/// doing everything [chime] does; [filed] is a mark on its own.
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

  /// About an agent the person is not looking at — the app on another one, or
  /// not in front at all. Chime, mark it, and post a system notification: the
  /// OS's own banner, over this app too (owner, 2026-10-21: "notification dạng
  /// truyền thống"). Until then the app in front got only the tap and the mark,
  /// and a notice could only reach a phone in the second or two before iOS
  /// suspends a backgrounded app — so it almost never reached one at all.
  alert;

  bool get chimes => this == chime || this == alert;
  bool get marks => this == filed || this == alert;
  bool get alerts => this == alert;
}

/// How far news that IS news goes, by where the person is. [watching] — the
/// agent on screen is the one it is about — only counts in front.
AgentNotice escalate({required bool inFront, required bool watching}) {
  if (inFront && watching) return AgentNotice.chime;
  return AgentNotice.alert;
}
