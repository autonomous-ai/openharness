import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';

import 'agent_notice.dart';

/// Which agents have news the person has not gone to yet, and what it is.
///
/// The phone's half of the desktop's `AgentUnread` (`desktop/lib/notify/
/// agent_alerts.dart`) and of the dial's bell badge: a mark that sits still
/// until somebody goes to that agent. Its own notifier rather than app state,
/// so a mark appearing redraws the rows that show it and nothing else.
class AgentUnread extends ChangeNotifier {
  final _unread = <String, NoticeKind>{};

  static String _key(AgentRef ref) => '${ref.machineId}/${ref.agentId}';

  /// How many agents are carrying news. Agents, not events — the number
  /// answers "how many should I look at", and an agent that finished three
  /// turns is still one place to go.
  int get count => _unread.length;

  /// Whether any of them is waiting on the person, which is what the count's
  /// colour says.
  bool get anyQuestion => _unread.containsValue(NoticeKind.question);

  bool contains(AgentRef ref) => _unread.containsKey(_key(ref));

  /// What this agent's mark says, or null when it has none.
  NoticeKind? kindFor(AgentRef ref) => _unread[_key(ref)];

  /// The NEWEST kind wins — see [NoticeKind].
  void mark(AgentRef ref, NoticeKind kind) {
    final key = _key(ref);
    if (_unread[key] == kind) return;
    _unread[key] = kind;
    notifyListeners();
  }

  /// The person went and looked — or, with [kind], only that kind of news went
  /// away: a question answered elsewhere takes its own mark down, and leaves a
  /// finished turn's alone. Silent when there was nothing to clear, so a pane
  /// being focused for any other reason does not redraw anything.
  void clear(AgentRef ref, {NoticeKind? kind}) {
    final key = _key(ref);
    if (!_unread.containsKey(key)) return;
    if (kind != null && _unread[key] != kind) return;
    _unread.remove(key);
    notifyListeners();
  }

  void clearAll() {
    if (_unread.isEmpty) return;
    _unread.clear();
    notifyListeners();
  }
}
