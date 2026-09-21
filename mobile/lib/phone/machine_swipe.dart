import 'package:flutter/material.dart';

import 'package:harness_mobile/state/app_state.dart';
import 'agents_page.dart';
import 'link_page.dart';

/// The machines a machine page can swipe between, in the order the list drew them.
///
/// A SNAPSHOT, taken when the page opens, for the same reason [AgentSwipeList] is one: the Machines
/// tab sorts on state that moves by itself — a machine that finishes connecting sorts upward, one
/// that drops offline sorts down — so a pager recomputing this list would renumber its own pages
/// under the finger.
///
/// ⚠️ **Machine IDS, not [MachineState]s.** The agent pager can hold its entries because an
/// `AgentEntry` is read once and drawn; a machine page is LIVE — it watches `needsLink` to decide
/// whether it shows the password form or the agents, and the notifier replaces these state objects
/// as machines answer. A held instance would go stale and the page would keep drawing the machine as
/// it was when the list was tapped.
///
/// Every machine is kept, including the ones that need a password or are offline. That is the whole
/// difference from the agent pager, which drops the rows it cannot open: a machine row that cannot
/// be opened still has something to show — the password form is exactly what somebody swiping to it
/// came for, and an offline machine says so in words.
class MachineSwipeList {
  MachineSwipeList(List<MachineState> machines)
    : machineIds = [
        for (final machine in machines) machine.machine.machineId,
      ];

  final List<String> machineIds;

  bool get isEmpty => machineIds.isEmpty;

  /// Whether the pager wraps around — past the last machine is the first one again.
  ///
  /// Needs at least TWO machines, and that is not a formality. With one, every page of an endless
  /// pager is the same machine: the screen would take a swipe, move, and land on what it just left,
  /// which reads as the gesture having failed rather than as a list with one thing in it.
  bool get wraps => machineIds.length > 1;

  /// Where a machine sits in the snapshot, or null if it is not in it.
  int? indexOf(String machineId) {
    final index = machineIds.indexOf(machineId);
    return index < 0 ? null : index;
  }
}

/// One machine's page, with the machines beside it a swipe away.
///
/// ⚠️ **The pager holds the route, and the pages inside it no longer do.** Without [neighbours] it
/// is a passthrough, which is how anything still opening a single machine keeps the old behaviour.
///
/// Nothing here mirrors the agent pager's `_attached`/`_detachAll`. That bookkeeping exists because
/// a terminal page ATTACHES a pane — a remote stream with a scrollback and a heartbeat — that
/// nothing else would ever close. A machine page holds no such thing: it reads machine state the
/// notifier keeps anyway, for every machine at once, whether this page is mounted or not. Three
/// mounted pages cost three list widgets.
class MachineSwipeHost extends StatefulWidget {
  const MachineSwipeHost({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.neighbours,
  });

  final AppNotifier notifier;

  /// The machine the route was opened on — the page that is shown first.
  final String machineId;

  /// Null for a page opened without neighbours, which is then simply the page.
  final MachineSwipeList? neighbours;

  @override
  State<MachineSwipeHost> createState() => _MachineSwipeHostState();
}

class _MachineSwipeHostState extends State<MachineSwipeHost> {
  /// How many laps of the list the opening page sits above zero — see [initState].
  static const _origin = 1000;

  PageController? _controller;

  @override
  void initState() {
    super.initState();
    final neighbours = widget.neighbours;
    if (neighbours == null || neighbours.isEmpty) return;
    final start = neighbours.indexOf(widget.machineId) ?? 0;
    // Opening in the MIDDLE of the endless run, not at its start, is what lets the first swipe go
    // either way: page 0 has nothing to its left, and the last machine has to be reachable by
    // swiping back from the first one. `_origin` is far enough from both ends that neither is
    // reachable by hand — ~1,000 laps of the list — and it is a whole number of laps, so
    // `page % length` still names the machine.
    final page = neighbours.wraps
        ? _origin * neighbours.machineIds.length + start
        : start;
    _controller = PageController(initialPage: page);
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final neighbours = widget.neighbours;
    final controller = _controller;
    if (neighbours == null || controller == null || neighbours.isEmpty) {
      return MachinePage(notifier: widget.notifier, machineId: widget.machineId);
    }
    return PageView.builder(
      controller: controller,
      // The lists below scroll vertically, so the horizontal axis is free — and here it is the
      // pager's ALONE. The route's own edge-swipe back used to compete for it and win at the left
      // margin, being registered above this in the tree: a drag started near the edge to reach the
      // previous MACHINE left the screen instead. The route is pushed without that gesture now (see
      // `phoneRoute`'s `swipeToGoBack`), so going back is the header's back band, or Android's back
      // button.
      physics: const PageScrollPhysics(),
      // No count is what makes it endless: the builder answers for any page, and the modulo below
      // wraps it back onto the list. A one-machine list keeps its single page instead — see
      // [MachineSwipeList.wraps].
      itemCount: neighbours.wraps ? null : neighbours.machineIds.length,
      itemBuilder: (context, i) => MachinePage(
        // ⚠️ Keyed by PAGE, not by machine: an endless run holds several pages for the same machine
        // — the lap before and the lap after — and a machine-shaped key would make Flutter treat two
        // live pages as one widget, which throws on a duplicate key the moment both are mounted.
        key: ValueKey(i),
        notifier: widget.notifier,
        machineId:
            neighbours.machineIds[i % neighbours.machineIds.length],
      ),
    );
  }
}

/// One machine, drawn as whatever that machine currently needs.
///
/// ⚠️ **This is a SWITCH, not a route, and that is the point.** Both screens used to be pushed:
/// `openMachine` chose one, and [LinkPage] then `pushReplacement`ed its way to [AgentsPage] once the
/// password landed. Inside a pager that replacement would swap out the PAGER — the route is the
/// host's, not the page's — and the swipe would silently die the first time somebody linked a
/// machine from it. Deciding here, off the notifier, keeps the pager whole: the page simply becomes
/// the agents list under the finger, on the same page number, with its neighbours still beside it.
class MachinePage extends StatelessWidget {
  const MachinePage({
    super.key,
    required this.notifier,
    required this.machineId,
  });

  final AppNotifier notifier;
  final String machineId;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      final machine = notifier.stateOf(machineId);
      // A machine dropped from the account while its page sits in a pager. The page stays — popping
      // one page out of a pager is not a thing a PageView can do — and [AgentsPage] already draws
      // an empty machine shell for a null state, which is the honest answer.
      //
      // ⚠️ The dismissal is half of this test, not a detail. The form's own Close only calls
      // `dismissLinkPrompt`; on a pushed [LinkPage] that lands as a pop, but a page cannot pop out of
      // a pager, so without reading the mark here Close would do nothing visible and read as broken.
      // Dismissed, the page falls through to [AgentsPage]'s padlock empty state — which is the same
      // machine, still unlinked, with its "Enter password" calling `revisitLinkPrompt` to come back
      // here. Close and that button are then the two directions of one switch.
      if (machine != null &&
          machine.needsLink &&
          !notifier.isLinkPromptDismissed(machineId)) {
        return LinkPage(
          notifier: notifier,
          machineId: machineId,
          // The form no longer navigates: this builder is what moves the page on, the moment
          // `needsLink` goes false — or the moment Close marks it dismissed.
          embedded: true,
        );
      }
      return AgentsPage(
        notifier: notifier,
        machineId: machineId,
        // Unlinking must not pop the pager, and the empty state's "Enter password" must not push a
        // second link route over it — this builder handles both by rebuilding.
        embedded: true,
      );
    },
  );
}
