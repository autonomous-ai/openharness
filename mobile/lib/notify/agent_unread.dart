import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';

/// Which agents finished while the person was looking somewhere else.
///
/// The phone's half of the desktop's `AgentUnread` (`desktop/lib/notify/
/// agent_alerts.dart`) and of the dial's bell badge: a mark that sits still
/// until somebody goes to that agent. Its own notifier rather than app state,
/// so a mark appearing redraws the rows that show it and nothing else.
class AgentUnread extends ChangeNotifier {
  final _unread = <String>{};

  static String _key(AgentRef ref) => '${ref.machineId}/${ref.agentId}';

  /// How many agents are carrying news. Agents, not turns — the number answers
  /// "how many should I look at", and an agent that finished three turns is
  /// still one place to go.
  int get count => _unread.length;

  bool contains(AgentRef ref) => _unread.contains(_key(ref));

  void mark(AgentRef ref) {
    if (_unread.add(_key(ref))) notifyListeners();
  }

  /// The person went and looked. Silent when there was nothing to clear, so a
  /// pane being focused for any other reason does not redraw anything.
  void clear(AgentRef ref) {
    if (_unread.remove(_key(ref))) notifyListeners();
  }

  void clearAll() {
    if (_unread.isEmpty) return;
    _unread.clear();
    notifyListeners();
  }
}
