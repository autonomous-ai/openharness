import 'dart:async';

import '../core/models.dart';
import '../measurement/product_measurement.dart';
import '../settings/experimental_features.dart';
import 'app_state.dart';
import 'desk_sync.dart' show hachiTabId;
import 'essential_harness_controller.dart';
import 'swarm.dart';
import 'terminal_pane.dart';

/// Hachi (docs/design/2026-11-12-hachi.md): the person's own Claude Code or Codex that starts and
/// follows their other harnesses, behind Settings ▸ Experimental. A built-in DSH, hidden from the Store
/// and New Harness: the switch is the only way in. It waits for the person, as Harness Monitor does.
const hachiEssential = EssentialHarness(
  id: 'autonomous/hachi',
  name: 'Hachi',
  folderLabel: 'hachi',
);

/// How the person came to Hachi, as its measures name it.
enum HachiOpening {
  shortcut(HachiMeasure.openShortcut),
  tab(HachiMeasure.openTab),
  palette(HachiMeasure.openPalette),
  welcome(HachiMeasure.openWelcome);

  const HachiOpening(this.measure);
  final HachiMeasure measure;
}

/// One Hachi per account, in the desk's first tab ([hachiTabId]). Its pane is the one record of where
/// Hachi lives; nothing else is stored.
class HachiController extends EssentialHarnessController {
  HachiController(AppNotifier app, {DateTime Function()? now})
    : _now = now ?? DateTime.now,
      super(app, hachiEssential);

  final DateTime Function() _now;

  /// Hachi notices nobody asked for: at most one in this long (the pair brain's bound).
  static const noticeGap = Duration(minutes: 2);

  /// Goals already announced, newest last; as many as the daemon keeps open.
  static const rememberedGoals = 50;

  /// The Hachis this window created, until the desk says whether each is the home.
  final _made = <(String, String)>{};
  final _announced = <String>[];
  DateTime? _lastNotice;
  String? _returnTo;
  bool? _wasOn;

  bool get on => app.experimentalFeatures.enabled(ExperimentalFeature.hachi);

  /// Hachi's tab, while it is in this window.
  Swarm? get tab => app.swarms.where((swarm) => swarm.isHachi).firstOrNull;

  /// The tab's first pane: Hachi's home, the harness every computer opens.
  TerminalPane? get home => tab?.panes.firstOrNull;

  /// The home's machine while it is asleep: off, or not connected and not on its way back.
  MachineState? get asleepHome {
    final pane = home;
    final machine = pane == null ? null : app.stateOf(pane.machineId);
    if (machine == null) return null;
    return machine.nodeOnline == false ||
            machine.connectionStatus == ConnectionStatus.disconnected
        ? machine
        : null;
  }

  /// What Hachi's pane says while its home is asleep. No "move it here" in v1: a second Hachi would
  /// split the goals between two conversations.
  static String asleepLine(String machine) =>
      'Hachi is on $machine, which is asleep.';

  /// Every machine of the account's own that is connected: a Hachi on any of them is the one.
  @override
  Iterable<MachineState> get searched => app.machineStates.values.where(
    (machine) =>
        machine.connectionStatus == ConnectionStatus.connected &&
        !machine.belongsToOtherAccount,
  );

  /// Only its own tab: Hachi is never opened in another.
  @override
  ({String tab, MachineState machine, Agent agent})? inTab() {
    final pane = home;
    final machine = pane == null ? null : app.stateOf(pane.machineId);
    final agent = machine?.agents
        .where((agent) => agent.id == pane!.agentId)
        .firstOrNull;
    if (agent == null) return null;
    return (tab: hachiTabId, machine: machine!, agent: agent);
  }

  @override
  void openTab() => app.openHachiTab();

  @override
  void created(MachineState machine, Agent agent) =>
      _made.add((machine.machine.machineId, agent.id));

  /// ⇧⌘H, the Hachi tab, Open Hachi or the welcome hint. A second ⇧⌘H goes back to the last tab.
  Future<String?> openFrom(HachiOpening via) async {
    if (!on) return null;
    app.productMeasurement.hachiCounted(via.measure);
    if (app.activeSwarmId == hachiTabId && via == HachiOpening.shortcut) {
      final back =
          app.swarms.where((swarm) => swarm.id == _returnTo).firstOrNull ??
          app.swarms.where((swarm) => !swarm.isHachi).firstOrNull;
      if (back != null) app.selectSwarm(back.id);
      return null;
    }
    if (app.activeSwarmId != hachiTabId) _returnTo = app.activeSwarmId;
    final pane = home;
    if (pane != null &&
        app.stateOf(pane.machineId)?.connectionStatus !=
            ConnectionStatus.connected) {
      // Its pane says where it is: one Hachi per account, never a second one here.
      app.selectSwarm(hachiTabId);
      if (asleepHome != null) {
        app.productMeasurement.hachiCounted(HachiMeasure.openFailedHomeAsleep);
      }
      return null;
    }
    final error = await open();
    if (error != null) {
      app.productMeasurement.hachiCounted(HachiMeasure.openFailedCreateFailed);
    }
    return error;
  }

  /// After the switch or the desk changed: off, the tab goes (said once when it was on here); on,
  /// a Hachi this window made that another computer's beat to the desk is closed. It has no
  /// conversation yet.
  void settle() {
    final choice = app.experimentalFeatures.choice(ExperimentalFeature.hachi);
    final turnedOff = _wasOn == true && choice == false;
    if (choice != null) _wasOn = choice;
    final tab = this.tab;
    if (tab == null) return;
    if (choice == false) {
      _close(say: turnedOff);
      return;
    }
    for (final pane in tab.panes.skip(1).toList()) {
      final agentId = pane.agentId;
      if (agentId == null || !_made.remove((pane.machineId, agentId))) {
        continue;
      }
      unawaited(app.closePane(pane.id, swarmId: hachiTabId));
      unawaited(app.deleteAgent(pane.machineId, agentId));
    }
  }

  void _close({required bool say}) {
    final hachi = home?.agentId;
    final kept = hachi == null
        ? 0
        : app.machineStates.values
              .expand((machine) => machine.agents)
              .where(
                (agent) => agent.parentAgentId == hachi && !agent.isStopped,
              )
              .length;
    _made.clear();
    _returnTo = null;
    unawaited(app.closeHachiTab());
    if (say) app.agentChangeNotice?.call(offLine(kept));
  }

  /// What the window says once when the switch goes off: what Hachi started keeps running, handed to
  /// the person by the daemon.
  static String offLine(int kept) => switch (kept) {
    0 => 'Hachi is off.',
    1 => 'Hachi is off. Its harness keeps running.',
    _ => 'Hachi is off. Its $kept harnesses keep running.',
  };

  /// The notice for a goal `harness goal done` closed (`hachi_goal_done`), or null when none is owed:
  /// Hachi off, a goal already announced, or another Hachi notice under [noticeGap] ago.
  String? goalDone(Map<String, dynamic> payload) {
    final goal = payload['goalId'], title = payload['title'];
    if (!on || goal is! String || title is! String || title.trim().isEmpty) {
      return null;
    }
    if (_announced.contains(goal)) return null;
    _announced.add(goal);
    if (_announced.length > rememberedGoals) _announced.removeAt(0);
    final now = _now();
    if (_lastNotice case final last? when now.difference(last) < noticeGap) {
      return null;
    }
    _lastNotice = now;
    app.productMeasurement.hachiCounted(HachiMeasure.noticeGoalDone);
    final words = title.trim();
    // The daemon keeps a title to 80 characters; a longer one is not its.
    return 'Hachi: ${words.length > 80 ? words.substring(0, 80) : words} is done';
  }
}
