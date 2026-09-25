import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/store/store_mark.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/swarm_icon.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'swarm_switcher_test.dart' show jumpField;

class _UnopenedAgent extends Agent {
  _UnopenedAgent()
    : super(id: 'unopened', name: 'Unopened', terminalAvailable: true);

  int projectReads = 0;

  @override
  AgentProject? get project {
    projectReads++;
    return const AgentProject(name: 'Unopened project', cwd: '/work/unopened');
  }
}

void main() {
  test(
    'closing unused starter pages never crowds work out of history',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      await app.closeSwarm(app.activeSwarmId);
      final savedWork = app.closedHistory.single.historyId;
      for (var i = 0; i < 30; i++) {
        app.newSwarm();
        await app.closeSwarm(app.activeSwarmId);
      }
      expect(app.closedHistory.map((entry) => entry.historyId), [savedWork]);
      expect(closedWorkDestinations(app), hasLength(1));
      expect(app.reopenClosed(), isTrue);
      expect(app.panes.single.agentId, 'a0');
    },
  );

  for (final count in [1, 2]) {
    test('History keeps the engine identity of $count-agent agents', () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.machineStates['m']!.agents[0] = const Agent(
        id: 'a0',
        name: 'Architecture',
        engine: 'claude',
        terminalAvailable: true,
      );
      for (var i = 0; i < count; i++) {
        app.adoptSessionForTest(terminal('a$i', []));
      }
      final history = SwarmNavigationHistory()..record(app);
      final open = history
          .menuDestinations(app)
          .singleWhere((row) => row.isSwarm);
      expect(open.members, hasLength(count));
      expect(open.engine, count == 1 ? 'claude' : isNull);
      await app.closeSwarm(app.activeSwarmId);
      app.machineStates['m']!.agents = [];
      final closed = closedWorkDestinations(app).single;
      expect(closed.isSwarm, isTrue);
      expect(closed.members, hasLength(count));
      expect(closed.engine, count == 1 ? 'claude' : isNull);
    });
  }

  test('History does not format unopened agents during focus changes', () {
    final app = createApp();
    addTearDown(app.dispose);
    final unopened = _UnopenedAgent();
    app.machineStates['m']!.agents = [
      ...app.machineStates['m']!.agents,
      unopened,
    ];
    final history = SwarmNavigationHistory();
    app.addListener(() => history.record(app));
    final first = app.adoptSessionForTest(terminal('a0', []));
    final second = app.adoptSessionForTest(terminal('a1', []));
    history.record(app);
    history.menuDestinations(app);
    unopened.projectReads = 0;
    for (var i = 0; i < 12; i++) {
      final pane = i.isEven ? first : second;
      app.focusPane(pane.id);
      final rows = history.menuDestinations(app);
      expect(rows.first.agentId, pane.agentId);
      expect(rows.first.current, isTrue);
      expect(rows.any((row) => row.agentId == unopened.id), isFalse);
    }
    expect(unopened.projectReads, 0);
  });

  test(
    'swarm History counts distinct machines, including offline and closed work',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final history = SwarmNavigationHistory();
      history.record(app);
      String machines() => history
          .menuDestinations(app)
          .firstWhere((entry) => entry.isSwarm)
          .machineLabel;
      expect(machines(), '');
      app.adoptSessionForTest(terminal('a0', []));
      app.adoptSessionForTest(terminal('a1', []));
      expect(machines(), 'Test host');
      const remote = Machine(
        machineId: 'remote',
        authMode: MachineAuthMode.remote,
        name: 'Test host',
      );
      app.machineStates['remote'] = MachineState(remote)..nodeOnline = false;
      app.activeSwarm.panes.addAll([
        TerminalPane(id: 900, machineId: 'remote', agentId: 'remote-agent'),
        TerminalPane(id: 901, machineId: 'setup-only'),
      ]);
      expect(
        machines(),
        '2 machines',
        reason: 'Count machine identities, not names, agents or setup panes',
      );
      await app.closeSwarm(app.activeSwarmId);
      expect(closedWorkDestinations(app).single.machineLabel, '2 machines');
    },
  );

  testWidgets(
    'native History restores closed agents and sends their engine icons',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final messenger = tester.binding.defaultBinaryMessenger;
      final updates = <Map>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final app = createApp();
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Planning',
          engine: 'claude',
          terminalAvailable: true,
        ),
      ];
      final pane = app.adoptSessionForTest(terminal('a0', []));
      final origin = app.activeSwarm;
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();
      final recent = (updates.last['history'] as List).cast<Map>().first;
      expect(recent['engine'], 'claude');
      expect(
        (updates.last['history'] as List).cast<Map>().firstWhere(
          (row) => row['swarm'] == true,
        )['machineName'],
        'Test host',
      );
      await app.closePane(pane.id);
      await tester.pump();
      final closed = (updates.last['closedHistory'] as List).cast<Map>().single;
      expect(closed['swarm'], isFalse);
      expect(closed['engine'], 'claude');
      expect(closed['title'], 'Planning');
      expect(closed['canReopen'], isTrue);
      final reply = Completer<void>();
      messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('reopenHistory', {'id': closed['id']}),
        ),
        (_) => reply.complete(),
      );
      await reply.future;
      await tester.pump();
      expect(app.activeSwarm, same(origin));
      expect(app.panes.single.agentId, 'a0');
      expect(app.closedHistory, isEmpty);
      await app.closeSwarm(origin.id);
      await tester.pump();
      expect(
        (updates.last['closedHistory'] as List).cast<Map>().single['swarm'],
        isTrue,
      );
      expect(
        (updates.last['closedHistory'] as List)
            .cast<Map>()
            .single['machineName'],
        'Test host',
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      projects.dispose();
    },
  );

  for (final native in [false, true]) {
    testWidgets(
      'History lists the store tab by the app icon, visited and closed (native=$native)',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        final messenger = tester.binding.defaultBinaryMessenger;
        final updates = <Map>[];
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'update') updates.add(call.arguments as Map);
          return true;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final app = createApp();
        app.adoptSessionForTest(terminal('a0', []));
        final work = app.activeSwarm;
        await mount(tester, app, nativeTabs: native);
        app.openStore();
        await tester.pump();
        final store = app.activeSwarm;
        expect(store.isStore, isTrue);
        app.selectSwarm(work.id);
        await tester.pump();

        // The mark a History row draws for the store, never the group grid.
        Future<void> expectFlutterRow() async {
          await chord(tester, LogicalKeyboardKey.keyY);
          await tester.pump();
          final row = find.ancestor(
            of: find.text(Swarm.storeName),
            matching: find.byType(ListTile),
          );
          expect(row, findsOneWidget);
          expect(
            find.descendant(of: row, matching: find.byType(SwarmIcon)),
            findsNothing,
          );
          expect(
            find.descendant(
              of: row,
              matching: find.byWidgetPredicate(
                (w) =>
                    w is Image &&
                    w.image is AssetImage &&
                    (w.image as AssetImage).assetName == kStoreMarkAsset,
              ),
            ),
            findsOneWidget,
          );
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 100));
        }

        if (native) {
          final visited = (updates.last['history'] as List)
              .cast<Map>()
              .firstWhere((row) => row['id'] == swarmDestinationId(store.id));
          expect(visited['store'], isTrue);
          expect(visited['engine'], 'store');
          expect(visited['iconAsset'], kStoreMarkAsset);
        } else {
          await expectFlutterRow();
        }

        await app.closeSwarm(store.id);
        await tester.pump();
        if (native) {
          final closed = (updates.last['closedHistory'] as List)
              .cast<Map>()
              .single;
          expect(closed['title'], Swarm.storeName);
          expect(closed['store'], isTrue);
          expect(closed['engine'], 'store');
          expect(closed['iconAsset'], kStoreMarkAsset);
        } else {
          await expectFlutterRow();
        }
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  test('Back and Forward retain exact pane locations and discard a branched future', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final history = SwarmNavigationHistory();
    app.addListener(() => history.record(app));
    final first = app.adoptSessionForTest(terminal('a0', []));
    history.record(app);
    final original = app.activeSwarmId;
    final second = app.adoptSessionForTest(terminal('a1', []));
    history.record(app);
    app.newSwarm(name: 'Other');
    final other = app.activeSwarmId;
    await app.addAgentToSwarm('m', 'a0');
    history.step(app, -1);
    expect(app.activeSwarmId, original);
    expect(app.focusedPaneId, second.id);
    expect(history.canGoForward(app), isTrue);
    history.step(app, 1);
    expect(app.activeSwarmId, other);
    history.step(app, -1);
    app.focusPane(first.id);
    expect(history.canGoForward(app), isFalse);
    await app.closePane(second.id);
    history.step(app, -1);
    expect(app.focusedPaneId, isNot(second.id));
    expect(app.allPanes.where((p) => p.agentId == 'a1'), isEmpty);
  });

  test(
    'a chosen closed Swarm restores independently and stale tokens stay inert',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final first = app.activeSwarmId;
      app.renameSwarm(first, 'First');
      app.newSwarm(name: 'Second');
      final second = app.activeSwarmId;
      app.newSwarm(name: 'Keep');
      await app.closeSwarm(first);
      final restoreFirst = app.closedSwarms.single.historyId;
      await app.closeSwarm(second);
      app.reopenClosedSwarm(historyId: restoreFirst);
      expect(app.activeSwarm.name, 'First');
      expect(app.closedSwarms.single.name, 'Second');
      await app.closeSwarm(first);
      final before = app.swarms.toList();
      app.reopenClosedSwarm(historyId: restoreFirst);
      expect(app.swarms, before);
      expect(app.closedSwarms, hasLength(2));
    },
  );
  test(
    'recent menus retain snapshots through output and refresh live identities',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final history = SwarmNavigationHistory();
      app.addListener(() => history.record(app));
      final first = app.adoptSessionForTest(terminal('a0', []));
      history.record(app);
      app.adoptSessionForTest(terminal('a1', []));
      history.record(app);
      final before = history.menuDestinations(app);
      expect(before.first.agentId, 'a1');
      for (var i = 0; i < 100; i++) {
        app.dismissError();
        expect(history.menuDestinations(app), same(before));
      }
      app.machineStates['m']!.agents = [
        const Agent(id: 'a0', name: 'Renamed agent', terminalAvailable: true),
        const Agent(id: 'a1', name: 'Agent 1', terminalAvailable: true),
      ];
      app.renameSwarm(app.activeSwarmId, 'Renamed Swarm');
      final renamed = history.menuDestinations(app);
      expect(
        renamed.firstWhere((e) => e.agentId == 'a0').title,
        'Renamed agent',
      );
      expect(renamed.firstWhere((e) => e.isSwarm).title, 'Renamed Swarm');
      app.machineStates['m']!.nodeOnline = false;
      expect(history.menuDestinations(app).first.detail, contains('Offline'));
      await app.closePane(first.id);
      expect(
        history.menuDestinations(app).where((e) => e.agentId == 'a0'),
        isEmpty,
      );
      expect(history.recent, contains(agentDestinationId('m', 'a0')));
    },
  );

  testWidgets(
    'native History focuses its agent, refuses stale entries and respects Settings',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final messenger = tester.binding.defaultBinaryMessenger;
      final updates = <Map>[];
      final fieldUpdates = <Map>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        if (call.method == 'searchState') {
          fieldUpdates.add(call.arguments as Map);
        }
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      Future<void> native(String method, [Map<String, Object?>? args]) {
        final done = Completer<void>();
        messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall(method, args),
          ),
          (_) => done.complete(),
        );
        return done.future;
      }

      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      final firstSession = terminal('a0', input);
      final first = app.adoptSessionForTest(firstSession);
      final otherInput = <TerminalBinaryFrame>[];
      final second = app.adoptSessionForTest(terminal('a1', otherInput));
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();
      app.focusPane(first.id);
      app.focusPane(second.id);
      await tester.pump();
      final id = agentDestinationId('m', 'a0');
      final row = (updates.last['history'] as List).cast<Map>().firstWhere(
        (row) => row['id'] == id,
      );
      expect(row['title'], 'Agent 0');
      expect(row['machineName'], 'Test host');
      expect(row['engine'], 'codex');
      expect(row['iconAsset'], 'assets/engine-icons/codex.png');
      final before = updates.length;
      for (var i = 0; i < 20; i++) {
        app.dismissError();
      }
      await tester.pump();
      expect(
        updates.length,
        before,
        reason: 'Output/state churn emits no unchanged native menu update',
      );
      await native('historyDestination', {'id': id});
      await tester.pump();
      expect(app.focusedPaneId, first.id);
      final focused = tester.widget<TerminalView>(
        find.byWidgetPredicate(
          (w) =>
              w is TerminalView && identical(w.terminal, firstSession.terminal),
        ),
      );
      expect(focused.focusNode!.hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(input.single.bytes, [27, 91, 68]);
      expect(otherInput, isEmpty);

      final settings = native('settings');
      await tester.pump();
      expect(find.byType(SettingsScreen), findsOneWidget);
      await native('historyDestination', {'id': agentDestinationId('m', 'a1')});
      await native('jump');
      await native('newAgent');
      await native('linkMachine');
      await native('addProject');
      expect(app.focusedPaneId, first.id);
      expect(jumpField, findsNothing);
      Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
      await tester.pump();
      await settings;

      await native('historyDestination', {'id': agentDestinationId('m', 'a1')});
      await tester.pump();
      expect(app.focusedPaneId, second.id);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(otherInput.single.bytes, [27, 91, 68]);

      await native('historyBack');
      await tester.pump();
      expect(app.focusedPaneId, first.id);
      await native('historyForward');
      await tester.pump();
      expect(app.focusedPaneId, second.id);
      final historyView = native('showHistory');
      await tester.pump();
      final historyField = find.byWidgetPredicate(
        (w) => w is TextField && w.decoration?.hintText == 'Search history',
      );
      expect(historyField, findsOneWidget);
      await tester.enterText(historyField, 'Agent 0');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await historyView;
      expect(app.focusedPaneId, first.id);
      app.focusPane(second.id);

      await app.closePane(first.id);
      await tester.pump();
      await native('historyDestination', {'id': id});
      await tester.pump();
      expect(app.panes, [
        second,
      ], reason: 'Stale history cannot recreate a closed view');
      expect(app.focusedPaneId, second.id);
      await tester.pumpWidget(const SizedBox());
      projects.dispose();
      app.dispose();
    },
  );
}
