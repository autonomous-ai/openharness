import 'dart:async';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/state/app_state.dart';

/// Closes the streams of agents a pager is no longer showing.
///
/// [heldElsewhere] spares an agent another live pager is holding: the pager replacing this one can
/// be showing an agent this one swiped past, and closing its pane after it mounted would pull the
/// terminal out from under it.
void releaseAgentPanes(
  AppNotifier notifier,
  Iterable<AgentRef> agents, {
  required bool Function(AgentRef) heldElsewhere,
}) {
  for (final agent in agents) {
    if (heldElsewhere(agent)) continue;
    final pane = notifier.paneOfAgent(agent.machineId, agent.agentId);
    if (pane == null) continue;
    // Not awaited: `closePane` detaches the session and tells the daemon on its own, and every
    // caller here is a callback that cannot wait for it.
    unawaited(notifier.closePane(pane.id));
  }
}

/// Keeps the phone down to ONE open agent — the one on screen — by closing the rest a beat after
/// each swipe.
///
/// ⚠️ **Why an agent nobody is looking at must not stay open.** The daemon keeps a single controller
/// per agent, so an open stream is a CLAIM on that agent's terminal: every agent the pager had been
/// swiped to held one until the pager was thrown away, which on the phone is a whole session. A lap
/// of the list left the desktop locked out of every agent on it. Closing hands each one straight
/// back.
///
/// ⚠️ **A beat after the swipe, not on it.** `onPageChanged` fires at the halfway point of the
/// settle, with the page being left still sliding off screen — closing its stream there empties the
/// terminal the swipe is still showing, and it finishes the animation as an "Attaching…" skeleton.
/// The beat also folds a fling across several pages into one prune, at the page it lands on.
///
/// The cost is that swiping back re-attaches rather than arriving on output already there. That is
/// the trade this class exists to make: one remote stream per phone, not one per agent visited.
class AgentPanePruner {
  AgentPanePruner({
    required this.notifier,
    required this.attached,
    required this.heldElsewhere,
  });

  final AppNotifier notifier;

  /// The pager's own record of what it opened — shared, so what this closes is no longer on it and
  /// what the pager adds is seen here.
  final Set<AgentRef> attached;

  final bool Function(AgentRef) heldElsewhere;

  /// How long after landing on a page the agents behind it are closed.
  static const delay = Duration(milliseconds: 400);

  Timer? _timer;

  /// Arms the prune for [current], the agent now on screen. Re-arming replaces the pending one, so
  /// a flick through five pages prunes once.
  void keepOnly(AgentRef current) {
    _timer?.cancel();
    _timer = Timer(delay, () {
      _timer = null;
      final leaving = [
        for (final agent in attached)
          if (agent != current) agent,
      ];
      if (leaving.isEmpty) return;
      attached
        ..clear()
        ..add(current);
      releaseAgentPanes(notifier, leaving, heldElsewhere: heldElsewhere);
    });
  }

  /// Abandons the pending prune — the pager has moved, or is going.
  void cancel() {
    _timer?.cancel();
    _timer = null;
  }

  void dispose() => cancel();
}
