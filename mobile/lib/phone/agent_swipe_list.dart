import 'agent_index.dart';

export 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;

/// The agents a terminal page can swipe between, in the order the list drew them.
///
/// A SNAPSHOT, taken when the page opens. The Agents tab sorts partly on state that moves by itself
/// — an idle agent that starts working sorts upward — so a pager recomputing this list would
/// renumber its own pages under the finger: the page to the right could become a different agent
/// between one swipe and the next, for a reason nothing on screen explains.
///
/// Only entries that can actually be opened are kept. A row with no terminal does nothing when
/// tapped in the list, and a page for it would be a screen of "Attaching…" that never resolves —
/// worse mid-swipe than in a list, where at least the row is still readable.
class AgentSwipeList {
  AgentSwipeList(List<AgentEntry> entries)
    : entries = [
        for (final entry in entries)
          if (entry.agent.terminalAvailable) entry,
      ];

  final List<AgentEntry> entries;

  bool get isEmpty => entries.isEmpty;

  /// Whether the pager wraps around — past the last agent is the first one again.
  ///
  /// Needs at least TWO agents, and that is not a formality. With one, every page of an endless
  /// pager is the same agent: the screen would take a swipe, move, and land on what it just left,
  /// which reads as the gesture having failed rather than as a list with one thing in it. One agent
  /// gets one page and no swipe at all.
  bool get wraps => entries.length > 1;

  /// Where an agent sits in the snapshot, or null if it is not in it.
  ///
  /// Used to find the page to open on, and the agent on screen in a list retaken under a live pager
  /// (`AgentSwipeHost`'s `didUpdateWidget`): the tapped row may be a "Waiting for you" row, an
  /// agent with no terminal may have been dropped by the constructor above, and neither the list's
  /// index nor the row's position can be assumed to survive either.
  int? indexOf(String machineId, String agentId) {
    for (final (index, entry) in entries.indexed) {
      if (entry.machineId == machineId && entry.agent.id == agentId) {
        return index;
      }
    }
    return null;
  }
}
