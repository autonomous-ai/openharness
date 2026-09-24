import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';
import 'package:harness_mobile/state/swarm.dart';

import 'agent_index.dart';

/// What the strip falls back to when the account has no tabs at all: one group
/// over everything, which is the phone exactly as it was before the desk.
const String kEveryAgentGroupName = 'All harnesses';

/// One tab of the desk as this phone can show it: its name, and the agents of it
/// that can actually be opened right now.
///
/// ⚠️ **A tab is not its agents.** The desk names `(machine, agent)` pairs, and a
/// phone reaches the ones whose machine is linked and answering — so a tab of
/// five can be a group of two, or of none, and the tab still exists. A group
/// with nothing in it is drawn and left inert rather than hidden: a tab that
/// vanished from the strip because its machine is asleep reads as a tab that was
/// deleted.
class DeskGroup {
  const DeskGroup({
    required this.id,
    required this.name,
    required this.entries,
  });

  /// The desk's id for the tab, or null for the single group a phone with no
  /// tabs shows, and for [untabbedGroup].
  final String? id;

  final String name;

  /// The agents, in the tab's own order — which is the order a swipe walks.
  final List<AgentEntry> entries;

  bool get isEmpty => entries.isEmpty;

  bool holds(AgentRef agent) => entries.any(
    (entry) =>
        entry.machineId == agent.machineId && entry.agent.id == agent.agentId,
  );
}

/// The desk's tabs, filled with the agents from [visible] they hold.
///
/// Agents with no terminal are left out throughout: a group that counts agents
/// nothing can open would offer a tab that opens on "Attaching…" for ever.
///
/// ⚠️ **Tabs and nothing else — there is no "Other" group for the agents no tab
/// holds.** The phone is built around the desk's tabs, as every window is (owner,
/// 2026-09-24): an agent outside them all is reached through search, and opens
/// on its own ([untabbedGroup]) rather than as a chip beside the real tabs.
///
/// Never empty: a phone with no tabs, and even one with no agents, still gets
/// the single group every caller below is allowed to assume.
List<DeskGroup> deskGroups(AppNotifier notifier, List<AgentEntry> visible) {
  final openable = [
    for (final entry in visible)
      if (entry.agent.terminalAvailable) entry,
  ];
  final tabs = notifier.deskTabs;
  // No desk, or a desk with nothing on it: one group over the lot. The strip
  // draws nothing for a single group, so this is the phone as it always was.
  if (tabs.isEmpty) {
    return [DeskGroup(id: null, name: kEveryAgentGroupName, entries: openable)];
  }
  Map<String, AgentEntry> keyed(Iterable<AgentEntry> entries) => {
    for (final entry in entries)
      DeskPaneRef(machineId: entry.machineId, agentId: entry.agent.id).key:
          entry,
  };
  final byKey = keyed(openable);
  final known = keyed(visible);
  return [
    for (final tab in tabs)
      DeskGroup(
        id: tab.id,
        name: deskTabName(
          tab,
          tab.panes.isEmpty ? null : known[tab.panes.first.key]?.agent,
        ),
        entries: [for (final pane in tab.panes) ?byKey[pane.key]],
      ),
  ];
}

/// What a tab is called — the desktop's rule (`AppNotifier._syncAgentName`).
///
/// A name somebody gave it stands. Otherwise the tab is named after its first
/// agent ([first]), and follows that agent's [Agent.displayName] as its session
/// titles it — `Greet user` rather than the `Untitled Tab` the desk was left
/// holding. An agent with no name of its own leaves the tab [Swarm.defaultName].
///
/// ⚠️ **Derived here, never written back.** Every window derives it the same
/// way, and the desk syncs only names a person chose (`nameIsCustom`); writing a
/// derived one would turn it into a chosen one on every computer.
String deskTabName(DeskTab tab, Agent? first) {
  if (tab.nameIsCustom || first == null) return tab.name;
  final name = first.displayName;
  return name == kUntitledPane ? Swarm.defaultName : name;
}

/// Whether [agent] is on none of the desk's tabs — one opened from search or a
/// notification, which know nothing of tabs. False on a phone with no tabs,
/// where the single group holds everything.
///
/// Read from the desk's panes, not from [deskGroups]: an agent of a tab whose
/// terminal is still being verified is missing from its group for those
/// seconds, and is not untabbed for it.
bool isUntabbed(AppNotifier notifier, AgentRef agent) {
  final tabs = notifier.deskTabs;
  if (tabs.isEmpty) return false;
  final key = DeskPaneRef(
    machineId: agent.machineId,
    agentId: agent.agentId,
  ).key;
  return !tabs.any((tab) => tab.panes.any((pane) => pane.key == key));
}

/// What a swipe walks for an agent no tab holds: that agent alone. Not drawn
/// on the strip — it is no tab — so the strip lights nothing while it is shown.
DeskGroup untabbedGroup(AgentEntry entry) =>
    DeskGroup(id: null, name: entry.agent.displayName, entries: [entry]);

/// The group the phone is in.
///
/// The agent on SCREEN decides it, not the other way round — which is what keeps
/// the strip honest when an agent is opened from somewhere with no idea of tabs
/// (search, a notification, the record of last time): whatever lands on screen,
/// the strip lights the tab it belongs to.
///
/// ⚠️ **The same agent can be on two tabs**, and then the tiebreak has to be
/// something that does not move on its own: the tab this phone was already in
/// ([AppNotifier.activeDeskTabId], which a tap on the strip sets before it opens
/// anything). Without it, an agent on two tabs would light whichever one the
/// desk happens to list first, and a tap on the other would appear to do nothing.
///
/// [groups] comes from [deskGroups] and is therefore never empty.
DeskGroup activeDeskGroup(
  AppNotifier notifier,
  List<DeskGroup> groups,
  AgentRef? showing,
) {
  final preferred = notifier.activeDeskTabId;
  if (showing != null) {
    final holding = [
      for (final group in groups)
        if (group.holds(showing)) group,
    ];
    if (holding.isNotEmpty) {
      return holding.where((group) => group.id == preferred).firstOrNull ??
          holding.first;
    }
  }
  // Nothing on screen yet — a launch, or the moment after a tab was tapped and
  // before its agent arrives. The tab last chosen holds the strip until then.
  return groups.where((group) => group.id == preferred).firstOrNull ??
      groups.where((group) => !group.isEmpty).firstOrNull ??
      groups.first;
}
