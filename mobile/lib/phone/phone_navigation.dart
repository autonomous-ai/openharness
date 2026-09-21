import 'dart:async';

import 'package:flutter/cupertino.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'agent_swipe.dart';
import 'agent_swipe_list.dart';
import 'agents_page.dart';
import 'link_page.dart';
import 'machine_swipe.dart';
import 'phone_shell_scope.dart';

/// Every phone page slides in the iOS way, and goes back with the edge swipe — unless
/// [swipeToGoBack] is off, which is how a page that wants the horizontal axis for itself keeps it.
Route<void> phoneRoute(WidgetBuilder builder, {bool swipeToGoBack = true}) =>
    swipeToGoBack
    ? CupertinoPageRoute<void>(builder: builder)
    : _NoSwipeBackRoute<void>(builder: builder);

/// A phone page that slides and animates exactly like every other one, but cannot be dragged away
/// from the left edge.
///
/// ⚠️ **It turns off the GESTURE only, and that distinction is the whole point.** `popGestureEnabled`
/// is read by `_CupertinoBackGestureDetector` and by nothing else, so every other way out still
/// works untouched: the header's chevron and its back band (`Navigator.maybePop`), Android's back
/// button and predictive-back (which go through `popDisposition`), and a page popping itself — the
/// terminal page does exactly that when its pane disappears.
///
/// Used by both pagers — agents and machines — where the horizontal drag belongs to the pager. The
/// edge swipe and the PageView were competing for the same axis: the route's detector sits ABOVE the
/// pager in the tree and wins at the left margin, so a swipe started near the edge to reach the
/// PREVIOUS entry left the screen instead. Only the header now goes back, which is what the whole
/// band across the top is widened for.
///
/// A machine opened on its own keeps the gesture: there is no pager under it competing for the axis,
/// and it is a plain pushed page like any other.
class _NoSwipeBackRoute<T> extends CupertinoPageRoute<T> {
  _NoSwipeBackRoute({required super.builder});

  @override
  bool get popGestureEnabled => false;
}

/// Where a tap on a machine goes. A machine this device holds no link to opens on ITS password
/// form — each machine has its own remote password — and only a linked one opens on its agents.
///
/// [swipeNeighbours] turns the page into a pager over that list — see [MachineSwipeList] and
/// [openMachinePager], which is how the Machines tab calls this.
void openMachine(
  BuildContext context,
  AppNotifier notifier,
  String machineId, {
  MachineSwipeList? swipeNeighbours,
}) {
  final machine = notifier.stateOf(machineId);
  // Offline: no password form to show and no agents to list — every caller also draws the row inert.
  if (machine == null || machine.nodeOnline == false) return;
  // A pager decides page by page which of the two screens a machine needs, because that answer
  // changes under the finger — linking one mid-swipe turns its page into the agents list. Opened on
  // its own, the old pair of routes is kept: [LinkPage] then walks forward to [AgentsPage] itself,
  // which is the push the back gesture expects to find behind it.
  if (swipeNeighbours != null) {
    Navigator.of(context).push(
      phoneRoute(
        (_) => MachineSwipeHost(
          notifier: notifier,
          machineId: machineId,
          neighbours: swipeNeighbours,
        ),
        // The horizontal axis belongs to the pager here — see [_NoSwipeBackRoute]. The way out is
        // the header's back band, and on Android the back button as well.
        swipeToGoBack: false,
      ),
    );
    return;
  }
  Navigator.of(context).push(
    phoneRoute(
      (_) => machine.needsLink
          ? LinkPage(notifier: notifier, machineId: machineId)
          : AgentsPage(notifier: notifier, machineId: machineId),
    ),
  );
}

/// Opens one machine as a PAGER over [machines]: the page it lands on is the machine tapped, and a
/// horizontal swipe moves to the one beside it.
///
/// Takes the machines as a SNAPSHOT rather than a way to recompute them, for the reason
/// [openAgentPager] does: the list is sorted partly on state that moves by itself — a machine that
/// finishes connecting sorts upward — so a page recomputing "the next one" mid-session would
/// renumber itself under the finger.
void openMachinePager(
  BuildContext context,
  AppNotifier notifier,
  List<MachineState> machines,
  String machineId,
) => openMachine(
  context,
  notifier,
  machineId,
  swipeNeighbours: MachineSwipeList(machines),
);

/// Opens one agent full screen.
///
/// ONE at a time, and that is the whole difference from the desktop grid: a phone has no room
/// for a second tile, so whatever else was open is closed rather than left attached somewhere
/// nobody can see it. The page goes up first and says it is attaching; the attach follows.
///
/// [swipeNeighbours] turns the page into a pager over that list — see [AgentSwipeList] and
/// [openAgentPager], which is how the Agents tab calls this.
///
/// [replacingCurrentPage] puts the agent in the place of the page it was opened FROM instead of on
/// top of it. That is what the new-agent form wants: the agent it just started opens straight away,
/// and going back from it lands on the list rather than on a form asking to create one again.
void openAgent(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId, {
  AgentSwipeList? swipeNeighbours,
  bool replacingCurrentPage = false,
}) {
  // Inside the shell the terminal is the home screen, so an agent is opened THERE — every stack
  // back to its root and the root switched to this agent — rather than pushed over the page that
  // asked. A pushed terminal carried a back button to a page the person was done with. The push
  // below is what a page pumped without a shell still gets.
  final shell = PhoneShellScope.maybeOf(context);
  if (shell != null) {
    shell.onOpenAgent(machineId, agentId);
    return;
  }
  final route = phoneRoute(
    (_) => AgentSwipeHost(
      notifier: notifier,
      machineId: machineId,
      agentId: agentId,
      neighbours: swipeNeighbours,
    ),
    // The horizontal axis belongs to the pager here — see [_NoSwipeBackRoute]. The way out is the
    // header's back band, and on Android the back button as well.
    swipeToGoBack: false,
  );
  final navigator = Navigator.of(context);
  if (replacingCurrentPage) {
    navigator.pushReplacement(route);
  } else {
    navigator.push(route);
  }
  unawaited(
    _openPane(
      notifier,
      machineId,
      agentId,
      keepOthers: swipeNeighbours != null,
    ),
  );
}

/// Opens one agent as a PAGER over [entries]: the page it lands on is the agent tapped, and a
/// horizontal swipe moves to the entry beside it.
///
/// Takes the entries as a SNAPSHOT rather than a way to recompute them. The list is sorted partly on
/// state that moves by itself — an agent that starts working sorts upward — so a page recomputing
/// "the next one" mid-session would renumber itself under the finger. What the person saw when they
/// tapped is the order they get, for as long as that screen is open.
void openAgentPager(
  BuildContext context,
  AppNotifier notifier,
  List<AgentEntry> entries,
  AgentEntry entry,
) => openAgent(
  context,
  notifier,
  entry.machineId,
  entry.agent.id,
  swipeNeighbours: AgentSwipeList(entries),
);

/// Attaches the agent's pane.
///
/// [keepOthers] is what separates the two ways in. A page opened on its own keeps the phone's old
/// rule — one pane, because a second one attached behind a screen nobody can see is a terminal
/// streaming for nothing. A PAGER does its own housekeeping instead: it closes the agent behind it
/// a beat after each swipe, and the rest when it goes (see [AgentSwipeHost]).
///
/// `selectAgent` already does the right thing either way — it reuses an existing pane and only
/// reopens a session that died, so arriving back on a page already attached costs nothing.
Future<void> _openPane(
  AppNotifier notifier,
  String machineId,
  String agentId, {
  required bool keepOthers,
}) async {
  await notifier.selectAgent(machineId, agentId);
  if (keepOthers) return;
  final keep = notifier.focusedPane?.id;
  for (final pane in [...notifier.panes]) {
    if (pane.id != keep) await notifier.closePane(pane.id);
  }
}
