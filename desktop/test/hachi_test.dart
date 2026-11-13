// Hachi's rules in the window (docs/design/2026-11-12-hachi.md, "Where it runs", "Surface", "Off"):
// one per account, found on the desk or any connected machine before one is made; the first to land
// on the desk wins; an asleep home is said, never replaced; the tab stays first and stays open; off,
// it goes and says once what kept running; a finished goal is one notice, at most one in two minutes.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/state/desk_sync.dart';
import 'package:harness/state/hachi.dart';
import 'package:harness/state/terminal_pane.dart';

import 'support/hachi.dart';

const _hachiOnStudio = Agent(
  id: 'hachi-9',
  name: 'Hachi',
  engine: 'claude',
  dsh: 'autonomous/hachi',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late HachiTestApp app;
  setUp(() async {
    app = HachiTestApp();
    await app.experimentalFeatures.refresh();
  });
  tearDown(() => app.dispose());

  Future<void> turnOn() => app.serverSwitch(true);

  test('off, nothing opens, nothing is made and nothing is counted', () async {
    expect(app.hachi.on, isFalse);
    expect(await app.hachi.openFrom(HachiOpening.shortcut), isNull);
    expect(app.connections['m']!.creations, isEmpty);
    expect(app.swarms.any((tab) => tab.isHachi), isFalse);
    expect(app.measured.counted, isEmpty);
  });

  test('the first open makes it here, in a first tab of its own, waiting for '
      'the person; a second ⇧⌘H goes back', () async {
    await turnOn();
    app.renameSwarm(app.activeSwarmId, 'Work');
    final work = app.activeSwarmId;
    expect(await app.hachi.openFrom(HachiOpening.palette), isNull);
    final made = app.connections['m']!.creations.single;
    expect(made['dsh'], 'autonomous/hachi');
    expect(made['name'], 'Hachi');
    expect(made['engine'], 'claude');
    expect(made['prompt'], isNull);
    expect(
      app.connections['m']!.requests.map((r) => r.type),
      isNot(anyOf(contains('dsh_list'), contains('dsh_install'))),
      reason: 'a built-in the daemon puts in place: never asked of the Store',
    );
    expect(app.swarms.first.id, hachiTabId);
    expect(app.activeSwarmId, hachiTabId);
    expect(app.hachi.home?.agentId, 'hachi-1');
    expect(app.measured.counted, ['ui_desktop_hachi_open_palette']);

    expect(await app.hachi.openFrom(HachiOpening.shortcut), isNull);
    expect(app.activeSwarmId, work, reason: 'the second press goes back');
    expect(await app.hachi.openFrom(HachiOpening.shortcut), isNull);
    expect(app.activeSwarmId, hachiTabId);
    expect(app.connections['m']!.creations, hasLength(1));
  });

  test('switched on a moment ago, before the daemon put it in place: said so, '
      'and the next open makes it', () async {
    await turnOn();
    final daemon = app.connections['m']!..hachiPrepared = false;
    expect(
      await app.hachi.openFrom(HachiOpening.shortcut),
      'Hachi is still being set up. Try again in a moment.',
    );
    expect(app.hachi.home, isNull);
    expect(app.measured.counted.last, 'hachi_open_failed_create_failed');

    daemon.hachiPrepared = true;
    expect(await app.hachi.openFrom(HachiOpening.shortcut), isNull);
    expect(app.hachi.home?.agentId, 'hachi-1');
    expect(daemon.creations, hasLength(2));
  });

  test('its tab stays first, open and named; ⌘1 is the first tab after it', () async {
    await turnOn();
    final work = app.activeSwarmId;
    await app.hachi.openFrom(HachiOpening.shortcut);
    app.newSwarm(name: 'Second');
    final second = app.activeSwarmId;

    await app.requestCloseSwarm(hachiTabId);
    await app.requestClosePane(app.hachi.home!.id);
    expect(app.swarms.first.id, hachiTabId);
    app.selectSwarm(hachiTabId);
    await app.requestClosePane(app.hachi.home!.id);
    expect(app.hachi.home, isNotNull);
    app.renameSwarm(hachiTabId, 'Mine');
    expect(app.swarms.first.name, 'Hachi');
    app.reorderSwarm(hachiTabId, 2);
    app.reorderSwarm(second, 0);
    expect(app.swarms.first.id, hachiTabId);

    app.selectSwarmByIndex(0);
    expect(app.activeSwarmId, isNot(hachiTabId));
    expect(app.numberedSwarms.map((tab) => tab.id), [second, work]);
  });

  test('a Hachi on another connected machine is the one: opened there, none made here', () async {
    await turnOn();
    app.stateOf('studio')!
      ..connectionStatus = ConnectionStatus.connected
      ..agents = [_hachiOnStudio];
    expect(app.hachi.exists, isTrue);
    expect(await app.hachi.openFrom(HachiOpening.shortcut), isNull);
    expect(app.connections['m']!.creations, isEmpty);
    expect(app.hachi.home?.machineId, 'studio');
    expect(app.hachi.home?.agentId, 'hachi-9');
  });

  test('a shared machine\'s Hachi is not this account\'s', () async {
    await turnOn();
    app.stateOf('studio')!
      ..connectionStatus = ConnectionStatus.connected
      ..agents = [_hachiOnStudio];
    app.machines = [
      app.machines.first,
      const Machine(
        machineId: 'studio',
        authMode: MachineAuthMode.remote,
        name: 'studio',
        isShared: true,
      ),
    ];
    app.machineStates['studio'] = app.stateOf('studio')!
      ..machine = app.machines.last;
    expect(app.hachi.searched.map((m) => m.machine.machineId), ['m']);
  });

  test('home asleep: its tab says where Hachi is, and no second one is made', () async {
    await turnOn();
    app.stateOf('studio')!
      ..connectionStatus = ConnectionStatus.connected
      ..agents = [_hachiOnStudio];
    await app.hachi.openFrom(HachiOpening.shortcut);
    app.newSwarm(name: 'Elsewhere');
    app.stateOf('studio')!.connectionStatus = ConnectionStatus.disconnected;
    app.measured.counted.clear();

    expect(await app.hachi.openFrom(HachiOpening.shortcut), isNull);
    expect(app.activeSwarmId, hachiTabId);
    expect(app.connections['m']!.creations, isEmpty);
    expect(identical(app.hachi.asleepHome, app.stateOf('studio')), isTrue);
    expect(
      HachiController.asleepLine('studio'),
      'Hachi is on studio, which is asleep.',
    );
    expect(app.measured.counted, [
      'ui_desktop_hachi_open_shortcut',
      'hachi_open_failed_home_asleep',
    ]);
    // On its way back is not asleep, and still makes nothing.
    app.stateOf('studio')!.connectionStatus = ConnectionStatus.reconnecting;
    expect(app.hachi.asleepHome, isNull);
    app.newSwarm(name: 'Again');
    await app.hachi.openFrom(HachiOpening.tab);
    expect(app.connections['m']!.creations, isEmpty);
  });

  test('two at once: the first on the desk is home, and this window closes '
      'the Hachi it just made', () async {
    await turnOn();
    await app.hachi.openFrom(HachiOpening.shortcut);
    // Another computer's Hachi landed on the desk first: its pane is first.
    app.stateOf('studio')!
      ..connectionStatus = ConnectionStatus.connected
      ..agents = [_hachiOnStudio];
    app.swarms.first.panes.insert(
      0,
      TerminalPane(id: 900, machineId: 'studio', agentId: 'hachi-9'),
    );
    app.hachi.settle();
    await pumpEventQueue();
    expect(app.hachi.tab!.panes.map((pane) => pane.agentId), ['hachi-9']);
    expect(
      app.connections['m']!.requests.where((r) => r.type == 'agent_delete').map(
        (r) => r.payload['agentId'],
      ),
      ['hachi-1'],
    );
    // A pane another computer made is that computer's to close.
    app.swarms.first.panes.add(
      TerminalPane(id: 901, machineId: 'laptop', agentId: 'hachi-3'),
    );
    app.hachi.settle();
    expect(app.hachi.tab!.panes, hasLength(2));
  });

  test('the desk adds Hachi\'s panes at the end, so the first to land stays first', () {
    const before = <DeskTab>[];
    final ops = deskDiff(before, [
      DeskTab(
        id: hachiTabId,
        name: 'Hachi',
        nameIsCustom: true,
        panes: const [DeskPaneRef(machineId: 'm', agentId: 'hachi-1')],
      ),
      DeskTab(
        id: newDeskId(),
        name: 'Work',
        panes: const [DeskPaneRef(machineId: 'm', agentId: 'a0')],
      ),
    ]);
    final adds = ops.where((op) => op['op'] == 'pane.add').toList();
    expect(adds.first.containsKey('index'), isFalse);
    expect(adds.last['index'], 0);
    expect(
      ops.firstWhere((op) => op['op'] == 'tab.create')['index'],
      0,
      reason: 'the tab itself is first',
    );
    expect(isDeskId(hachiTabId), isTrue);
  });

  test('off: the tab goes and the window says once what kept running', () async {
    await turnOn();
    await app.hachi.openFrom(HachiOpening.shortcut);
    final said = <String>[];
    app.agentChangeNotice = said.add;
    app.stateOf('m')!.agents = [
      ...app.stateOf('m')!.agents,
      for (final id in ['api-fix', 'reviewer'])
        Agent(id: id, name: id, engine: 'codex', parentAgentId: 'hachi-1'),
      const Agent(
        id: 'done',
        name: 'done',
        engine: 'codex',
        parentAgentId: 'hachi-1',
        status: 'stopped',
      ),
      const Agent(id: 'mine', name: 'mine', engine: 'codex'),
    ];
    await app.serverSwitch(false);
    await pumpEventQueue();
    expect(app.swarms.any((tab) => tab.isHachi), isFalse);
    expect(said, ['Hachi is off. Its 2 harnesses keep running.']);
    expect(app.canReopenLastClosed, isFalse, reason: 'not in Recently Closed');
    // A Hachi tab the desk still had while off is not drawn, and not said again.
    app.openHachiTab();
    app.hachi.settle();
    await pumpEventQueue();
    expect(app.swarms.any((tab) => tab.isHachi), isFalse);
    expect(said, hasLength(1));
    expect(HachiController.offLine(0), 'Hachi is off.');
    expect(HachiController.offLine(1), 'Hachi is off. Its harness keeps running.');
  });

  test('the switch is counted when the person turns it, not when another window did', () async {
    await app.experimentalFeatures.set(ExperimentalFeature.hachi, true);
    await app.experimentalFeatures.set(ExperimentalFeature.shareButton, true);
    await app.serverSwitch(false);
    await app.experimentalFeatures.set(ExperimentalFeature.hachi, true);
    await app.experimentalFeatures.set(ExperimentalFeature.hachi, false);
    expect(app.measured.counted, [
      'ui_desktop_hachi_switch_on',
      'ui_desktop_hachi_switch_on',
      'ui_desktop_hachi_switch_off',
    ]);
  });

  test('a finished goal: one notice, once, at most one in two minutes, and '
      'none while off', () async {
    var now = DateTime.utc(2026, 11, 12, 9);
    final hachi = HachiController(app, now: () => now);
    Map<String, dynamic> goal(String id, [String title = 'flaky login test']) =>
        {'agentId': 'hachi-1', 'goalId': id, 'title': title};
    expect(hachi.goalDone(goal('g0')), isNull, reason: 'off');
    await turnOn();
    expect(hachi.goalDone(goal('g1')), 'Hachi: flaky login test is done');
    expect(hachi.goalDone(goal('g1')), isNull, reason: 'the same goal twice');
    now = now.add(const Duration(seconds: 119));
    expect(hachi.goalDone(goal('g2')), isNull, reason: 'under two minutes');
    now = now.add(const Duration(seconds: 2));
    expect(hachi.goalDone(goal('g3', 'x' * 120)), 'Hachi: ${'x' * 80} is done');
    expect(hachi.goalDone({'goalId': 'g4'}), isNull);
    expect(
      app.measured.counted.where((name) => name == 'hachi_notice_goal_done'),
      hasLength(2),
    );
  });
}
