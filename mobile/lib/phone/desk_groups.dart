import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';

import 'agent_index.dart';

/// The name of the group holding the agents no tab does.
///
/// Short because it is drawn as a chip beside real tab names, and a chip is the
/// one place on this screen with no room for a sentence.
const String kUntabbedGroupName = 'Other';

/// What the strip falls back to when the account has no tabs at all: one group
/// over everything, which is the phone exactly as it was before the desk.
const String kEveryAgentGroupName = 'All agents';

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

  /// The desk's id for the tab, or null for [kUntabbedGroupName] and for the
  /// single group a phone with no tabs shows.
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
/// [visible] is the phone's own list — [visibleAgents] — so the leftovers keep
/// the order the app would have shown them in. Agents with no terminal are left
/// out throughout: a group that counts agents nothing can open would offer a tab
/// that opens on "Attaching…" for ever.
///
/// The leftover group comes last, and only when there is something in it. Nobody
/// puts every agent on a tab, and with a swipe now staying inside one group the
/// agents outside them all would otherwise be reachable only through search.
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
  final byKey = {
    for (final entry in openable)
      DeskPaneRef(machineId: entry.machineId, agentId: entry.agent.id).key:
          entry,
  };
  final claimed = <String>{};
  final groups = <DeskGroup>[];
  for (final tab in tabs) {
    final held = <AgentEntry>[];
    for (final pane in tab.panes) {
      final entry = byKey[pane.key];
      if (entry == null) continue;
      claimed.add(pane.key);
      held.add(entry);
    }
    groups.add(DeskGroup(id: tab.id, name: tab.name, entries: held));
  }
  final rest = [
    for (final entry in byKey.entries)
      if (!claimed.contains(entry.key)) entry.value,
  ];
  if (rest.isNotEmpty) {
    groups.add(DeskGroup(id: null, name: kUntabbedGroupName, entries: rest));
  }
  return groups;
}

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
