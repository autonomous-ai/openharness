import 'dart:ui' show Size;

import 'pane_preset.dart';
import 'pane_arrangement.dart';
import 'terminal_pane.dart';

/// A named arrangement of agents. Membership never owns the agent process.
/// Shared agents reuse the same pane/session across swarms, so the daemon has
/// exactly one controller and switching tabs cannot take over our own stream.
class Swarm {
  Swarm({required this.id, String name = defaultName})
    : name = const {
            'New swarm',
            'New tab',
            'New Tab',
            'New Harness',
            'New Agent',
          }.contains(name)
          ? defaultName
          : name;

  /// What an untouched tab is called, and the desktop's own word for it
  /// (`desktop/lib/state/swarm.dart`).
  ///
  /// ⚠️ **"New Harness" is in the legacy set above, not here, and the two are
  /// not the same thing.** A *harness* is one agent — what the desktop's menus
  /// stop, fork and rename. A *tab* is the box several of them sit in. The
  /// default was 'New Harness' until 2026-09-15, which read as though opening a
  /// tab opened an agent; a layout saved then still carries the name, and it
  /// has to come back as the same fresh tab.
  static const defaultName = 'Untitled Tab';

  final String id;
  String name;
  final List<TerminalPane> panes = [];
  final Map<int, PanePreset> presets = {};
  final Map<String, PaneArrangement> paneSizes = {};
  PaneArrangement? arranged;
  String? arrangedKey;
  Size? arrangedMinimum;
  int? focusedPaneId;
  int? zoomedPaneId;
  int? previousPaneId;
  int? gridColumns;
  final Map<int, int> pinnedSlots = {};

  bool get isEmptyStarter =>
      name == defaultName && panes.isEmpty && presets.isEmpty;

  PaneArrangement? get manualLayout => paneSizes['${panes.length}:manual'];

  void savePaneSizes(String key, PaneArrangement arrangement) {
    paneSizes[key] = arrangement;
    while (paneSizes.length > 64) {
      paneSizes.remove(paneSizes.keys.first);
    }
  }

  void remove(TerminalPane pane) {
    final index = panes.indexOf(pane);
    if (index < 0) return;
    final manual = manualLayout;
    panes.removeAt(index);
    if (manual != null && panes.length > 1) {
      final next = manual.remove(index);
      if (next == null) {
        paneSizes.remove('${panes.length}:manual');
      } else {
        savePaneSizes('${panes.length}:manual', next);
      }
    }
    if (manual != null) {
      pinnedSlots.updateAll((_, slot) => slot > index ? slot - 1 : slot);
    }
    arranged = null;
    arrangedKey = null;
    pinnedSlots.remove(pane.id);
    if (focusedPaneId == pane.id) {
      focusedPaneId = panes.isEmpty
          ? null
          : panes[index.clamp(0, panes.length - 1)].id;
    }
    if (zoomedPaneId == pane.id) zoomedPaneId = null;
    if (previousPaneId == pane.id) previousPaneId = null;
  }

  Map<String, Object?> toJson() {
    // Warm tiles are the pager's guesses, not the person's layout — see
    // [TerminalPane.warm]. Saved, a relaunch would open every one of them as a
    // stream before the agent the person was actually reading.
    final agents = panes
        .where((p) => p.agentId != null && !p.warm)
        .toList(growable: false);
    return {
      'id': id,
      'name': name,
      'focus': agents.indexWhere((p) => p.id == focusedPaneId),
      'previousFocus': agents.indexWhere((p) => p.id == previousPaneId),
      'zoom': agents.indexWhere((p) => p.id == zoomedPaneId),
      'presets': {for (final e in presets.entries) '${e.key}': e.value.id},
      if (paneSizes.isNotEmpty)
        'paneSizes': {
          for (final e in paneSizes.entries) e.key: e.value.toJson(),
        },
      'panes': [
        for (final p in agents)
          PaneLayoutEntry(
            machineId: p.machineId,
            agentId: p.agentId!,
            composerVisible: p.composerVisible,
            pinnedSlot: pinnedSlots[p.id],
          ).toJson(),
      ],
    };
  }
}

/// Session-free history: closing a view never owns the agent's lifetime.
sealed class ClosedWork {
  const ClosedWork({required this.historyId});
  final String historyId;
}

class ClosedAgent extends ClosedWork {
  ClosedAgent(
    TerminalPane pane,
    Swarm swarm, {
    required super.historyId,
    required this.name,
    required this.machineName,
    required this.engine,
  }) : swarmId = swarm.id,
       swarmName = swarm.name,
       index = swarm.panes.indexOf(pane),
       machineId = pane.machineId,
       agentId = pane.agentId!,
       composerVisible = pane.composerVisible,
       pinnedSlot = swarm.pinnedSlots[pane.id],
       manualLayout = swarm.manualLayout,
       remainingAgents = List.unmodifiable([
         for (final other in swarm.panes)
           if (other != pane) (other.machineId, other.agentId),
       ]),
       zoomed = swarm.zoomedPaneId == pane.id;

  final String swarmId, swarmName, machineId, machineName, agentId, name;
  final String? engine;
  final int index;
  final bool composerVisible, zoomed;
  final int? pinnedSlot;
  final PaneArrangement? manualLayout;
  final List<(String, String?)> remainingAgents;
}

/// Terminal buffers and controllers are released normally; a reopened view
/// reuses any live peer.
class ClosedSwarm extends ClosedWork {
  ClosedSwarm(
    Swarm swarm, {
    required super.historyId,
    required this.index,
    Swarm? replacement,
    this.engine,
  }) : id = swarm.id,
       name = swarm.name,
       gridColumns = swarm.gridColumns,
       focus = swarm.panes.indexWhere((p) => p.id == swarm.focusedPaneId),
       previousFocus = swarm.panes.indexWhere(
         (p) => p.id == swarm.previousPaneId,
       ),
       zoom = swarm.panes.indexWhere((p) => p.id == swarm.zoomedPaneId),
       presets = Map.unmodifiable(swarm.presets),
       paneSizes = Map.unmodifiable(swarm.paneSizes),
       panes = List.unmodifiable([
         for (final pane in swarm.panes)
           (
             machineId: pane.machineId,
             agentId: pane.agentId,
             composerVisible: pane.composerVisible,
             pinnedSlot: swarm.pinnedSlots[pane.id],
           ),
       ]),
       replacementId = replacement?.id;

  final String id;
  final String name;
  final String? engine;
  final int index;
  final int? gridColumns;
  final int focus;
  final int previousFocus;
  final int zoom;
  final Map<int, PanePreset> presets;
  final Map<String, PaneArrangement> paneSizes;
  final List<
    ({String machineId, String? agentId, bool composerVisible, int? pinnedSlot})
  >
  panes;
  final String? replacementId;

  bool replacesUntouchedWelcome(Swarm swarm) =>
      swarm.id == replacementId &&
      swarm.name == Swarm.defaultName &&
      swarm.panes.isEmpty &&
      swarm.presets.isEmpty;
}
