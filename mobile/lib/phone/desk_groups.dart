import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';
import 'package:harness_mobile/state/swarm.dart';
import 'package:harness_mobile/widgets/engine_identity.dart'
    show canonicalHarnessId, isCodeEngine, isHarnessId;

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
///
/// Only the tabs the phone SHOWS — [AppNotifier.profileDeskTabs], narrowed to the
/// computer chosen under Settings ▸ Profile.
List<DeskGroup> deskGroups(AppNotifier notifier, List<AgentEntry> visible) {
  final openable = [
    for (final entry in visible)
      if (entry.agent.terminalAvailable) entry,
  ];
  final tabs = notifier.profileDeskTabs;
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
  final names = deskTabNames(notifier);
  return [
    for (final tab in tabs)
      DeskGroup(
        id: tab.id,
        name: names[tab.id] ?? Swarm.defaultName,
        entries: [for (final pane in tab.panes) ?byKey[pane.key]],
      ),
  ];
}

/// One tab as the Harnesses list narrows to it: its id, its name, and every
/// agent it names.
///
/// ⚠️ **Not a [DeskGroup].** A group keeps only the agents with a terminal —
/// what a swipe can land on — and this list also draws stopped work, which a
/// tap resumes. A filter built from groups would hide a tab's stopped agents
/// under that tab while All still showed them.
class DeskTabFilter {
  const DeskTabFilter({
    required this.id,
    required this.name,
    required this.keys,
  });

  final String id;
  final String name;

  /// [DeskPaneRef.key] of every agent on the tab, reachable or not.
  final Set<String> keys;

  /// Whether the tab names no agent at all, as against naming agents this
  /// phone cannot reach right now.
  bool get isEmpty => keys.isEmpty;

  bool holds(AgentEntry entry) => keys.contains(
    DeskPaneRef(machineId: entry.machineId, agentId: entry.agent.id).key,
  );
}

/// The desk's tabs, in the desk's order, each named as the tab strip names it ([deskTabNames]).
///
/// Empty where the desk has no tabs or has not answered — and then there is
/// nothing to narrow by, so the list draws no filter at all.
///
/// The tabs the phone shows ([AppNotifier.profileDeskTabs]): a chip for a tab the
/// profile hides would narrow the list to a tab nowhere else on the phone.
List<DeskTabFilter> deskTabFilters(AppNotifier notifier) {
  final tabs = notifier.profileDeskTabs;
  if (tabs.isEmpty) return const [];
  final names = deskTabNames(notifier);
  return [
    for (final tab in tabs)
      DeskTabFilter(
        id: tab.id,
        name: names[tab.id] ?? Swarm.defaultName,
        keys: {for (final pane in tab.panes) pane.key},
      ),
  ];
}

/// What a tab's agents can have in common, strongest claim first when counts tie: what they are,
/// the project they work in, the machine they run on.
enum _TabTrait { type, project, machine }

typedef _TabName = ({_TabTrait trait, String label, int count});

/// What each of the desk's tabs is called, by tab id — the desktop's rule, `workspaceTabNames` in
/// `desktop/lib/state/workspace_status.dart`, so a tab reads the same here as in the window beside
/// the phone.
///
/// A name somebody gave it stands. Otherwise its agents vote on the three [_TabTrait]s — their type
/// (`code` for every coding engine, a harness's own name for a harness: [_tabType]), their project,
/// their machine — and the trait most of them share names the tab. A tie goes to the trait least
/// repeated across the other tabs, and after that to the stronger trait. A tab with nothing to vote
/// is [Swarm.defaultName].
///
/// ⚠️ **Why the vote and not the first agent's name (owner, 2026-10-01).** The phone named a tab
/// after its first agent — the desktop's rule (`AppNotifier._syncAgentName`) until the desktop
/// moved to this one on 2026-09-24 — and kept that rule after it moved: the same tab of two
/// Claude Code agents read `code` on the desktop and `Fix bugs` on the phone.
///
/// ⚠️ **Derived here, never written back.** Every window derives it the same way, and the desk
/// syncs only names a person chose (`nameIsCustom`); writing a derived one would turn it into a
/// chosen one on every computer.
///
/// ⚠️ **Where it can still differ from the desktop.** The desktop also votes with a pane's live
/// session engine when its agent is not listed, and counts repetitions across its window-only tabs
/// (Store, orchestrator) — neither of which the phone has. Both reach only a tab whose agents the
/// machine has not listed, or a tie decided by repetitions.
///
/// ⚠️ Over the WHOLE desk ([AppNotifier.deskTabs]), never the profile's tabs: a tie is decided by
/// repetitions across every tab, and a profile hiding some would rename the rest on this phone alone.
Map<String, String> deskTabNames(AppNotifier notifier) {
  final tabs = notifier.deskTabs;
  final candidates = <String, List<_TabName>>{};
  for (final tab in tabs) {
    if (tab.nameIsCustom) {
      candidates[tab.id] = const [];
      continue;
    }
    final counts = <_TabTrait, Map<String, int>>{
      for (final trait in _TabTrait.values) trait: {},
    };
    void vote(_TabTrait trait, String? label) {
      if (label == null || label.isEmpty) return;
      counts[trait]!.update(label, (n) => n + 1, ifAbsent: () => 1);
    }

    // One vote per agent, however many panes name it.
    final seen = <String>{};
    for (final pane in tab.panes) {
      if (!seen.add(pane.key)) continue;
      final machine = notifier.stateOf(pane.machineId);
      final agent = machine?.agents
          .where((agent) => agent.id == pane.agentId)
          .firstOrNull;
      vote(_TabTrait.type, _tabType(agent?.identityEngine));
      vote(_TabTrait.project, agent?.displayProject?.label);
      vote(_TabTrait.machine, machine?.machine.displayName ?? pane.machineId);
    }
    candidates[tab.id] = [
      for (final trait in _TabTrait.values)
        if (counts[trait]!.isNotEmpty)
          (() {
            // The first to reach the top count wins it: pane order breaks a tie within a trait.
            final winner = counts[trait]!.entries.reduce(
              (a, b) => b.value > a.value ? b : a,
            );
            return (trait: trait, label: winner.key, count: winner.value);
          })(),
    ];
  }
  int repetitions(_TabName name) => candidates.values
      .where(
        (choices) => choices.any(
          (other) => other.trait == name.trait && other.label == name.label,
        ),
      )
      .length;
  return {
    for (final tab in tabs)
      tab.id: tab.nameIsCustom
          ? tab.name
          : candidates[tab.id]!.isEmpty
          ? Swarm.defaultName
          : candidates[tab.id]!.reduce((a, b) {
              if (b.count != a.count) return b.count > a.count ? b : a;
              return repetitions(b) < repetitions(a) ? b : a;
            }).label,
  };
}

/// An agent's type as a tab's name counts it, from its [Agent.identityEngine] — the desktop's:
/// `code` for a coding engine, a harness's own name (`kicad`, not `autonomous/kicad`), and any
/// other engine by its id (`terminal`).
String? _tabType(String? engine) {
  final id = engine?.trim().toLowerCase() ?? '';
  if (id.isEmpty) return null;
  if (isHarnessId(id)) {
    final canonical = canonicalHarnessId(id);
    return canonical.substring(canonical.lastIndexOf('/') + 1);
  }
  return isCodeEngine(id) ? 'code' : id;
}

/// Whether [agent] is on none of the desk's tabs — one opened from search or a
/// notification, which know nothing of tabs. False on a phone with no tabs,
/// where the single group holds everything.
///
/// Read from the desk's panes, not from [deskGroups]: an agent of a tab whose
/// terminal is still being verified is missing from its group for those
/// seconds, and is not untabbed for it.
///
/// Of the tabs the phone SHOWS ([AppNotifier.profileDeskTabs]): an agent whose only
/// tab the profile hides opens on its own, as one in no tab does, instead of
/// lighting a tab it is not on.
bool isUntabbed(AppNotifier notifier, AgentRef agent) {
  final tabs = notifier.profileDeskTabs;
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
