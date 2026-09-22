import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/new_harness.dart';

import 'support/stop_connection.dart';
import 'swarm_state_test.dart' show createApp;
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show terminal, mount;

class _Connection extends StopConnection {
  final create = Completer<Map<String, dynamic>>();
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) => type == 'agent_create'
      ? create.future
      : super.request(type, payload: payload, timeout: timeout);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;
  late _Connection connection;
  setUp(() {
    newHarnessOpensInBox = true;
    connection = _Connection();
    app = createApp(connectionForTest: (_) => connection);
  });
  tearDown(() {
    newHarnessOpensInBox = false;
    app.dispose();
  });
  Future<void> stopped([String machine = 'm', String agent = 'a0']) =>
      app.handleEventForTest(machine, {
        'type': 'agent_deleted',
        'payload': {'agentId': agent},
      });

  test(
    'stopping a store harness closes only its emptied tab and owned viewer',
    () async {
      final other = app.adoptSessionForTest(terminal('a1', []));
      final otherTab = app.activeSwarm;
      app.newSwarm(name: 'Blender');
      final closing = app.activeSwarm;
      app.adoptSessionForTest(terminal('a0', []));
      closing.panes.add(
        TerminalPane(
          id: 900,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'a0',
          url: 'http://fixture.invalid',
        ),
      );
      final stop = app.deleteAgent('m', 'a0');
      connection.stopReplies.single.complete({'deleted': true});
      expect(await stop, isNull);
      expect(app.swarms, [otherTab]);
      expect(app.activeSwarm, same(otherTab));
      expect(app.allPanes, [other]);
    },
  );
  test('a background stop does not switch the tab the user is using', () async {
    app.adoptSessionForTest(terminal('a0', []));
    final closing = app.activeSwarm;
    app.newSwarm(name: 'Working');
    final current = app.activeSwarm;
    final kept = app.adoptSessionForTest(terminal('a1', []));
    await stopped();
    expect(app.swarms.contains(closing), isFalse);
    expect(app.activeSwarm, same(current));
    expect(app.focusedPane, same(kept));
  });
  test('all affected empty tabs close while a shared tab with another pane survives', () async {
    final shared = app.adoptSessionForTest(terminal('a0', []));
    final one = app.activeSwarm;
    app.newSwarm(name: 'Second');
    final two = app.activeSwarm;
    two.panes.add(shared);
    app.newSwarm(name: 'Mixed');
    final mixed = app.activeSwarm;
    mixed.panes.add(shared);
    final kept = app.adoptSessionForTest(terminal('a1', []));
    await stopped();
    expect(app.swarms.contains(one), isFalse);
    expect(app.swarms.contains(two), isFalse);
    expect(app.swarms, [mixed]);
    expect(app.allPanes, [kept]);
  });
  test(
    'does not sweep unrelated empty, store, orchestrator, or draft tabs',
    () async {
      app.adoptSessionForTest(terminal('a0', []));
      final blank = Swarm(id: 'blank');
      final store = Swarm(id: 'store', kind: 'store');
      final orchestrator = Swarm(id: 'orchestrator', kind: 'orchestrator');
      app.swarms.addAll([blank, store, orchestrator]);
      app.newSwarm(draft: true);
      final selected = app.activeSwarm;
      await stopped();
      expect(app.swarms, containsAll([blank, store, orchestrator]));
      expect(app.activeSwarm, same(selected));
    },
  );
  for (final keep in [
    'other machine',
    'unowned viewer',
    'placeholder',
    'preset',
  ]) {
    test('preserves a tab containing $keep', () async {
      app.adoptSessionForTest(terminal('a0', []));
      final tab = app.activeSwarm;
      if (keep == 'preset') {
        tab.presets[2] = PanePreset.columns;
      } else {
        tab.panes.add(
          TerminalPane(
            id: 901,
            machineId: keep == 'other machine' ? 'other' : 'm',
            agentId: keep == 'other machine' ? 'a0' : null,
            ownerAgentId: keep == 'unowned viewer' ? 'a1' : null,
            kind: keep == 'unowned viewer' ? PaneKind.web : PaneKind.terminal,
          ),
        );
      }
      await stopped();
      expect(app.swarms.single, same(tab));
    });
  }
  test('a late Stop reply cannot close a reused identity or its tab', () async {
    app.adoptSessionForTest(terminal('a0', []));
    final tab = app.activeSwarm;
    final stop = app.deleteAgent('m', 'a0');
    app.stateOf('m')!.agents[0] = const Agent(
      id: 'a0',
      name: 'Replacement',
      sessionId: 'new-session',
    );
    connection.stopReplies.single.complete({'deleted': true});
    expect(await stop, isNotNull);
    expect(app.swarms.single, same(tab));
    expect(tab.panes, hasLength(1));
  });
  test('creation already in flight keeps its destination even when the old final pane stops', () async {
    app.adoptSessionForTest(terminal('a0', []));
    final tab = app.activeSwarm;
    app.stateOf('m')!.nodeOnline = true;
    final creation = app.createAgent(
      'm',
      engine: 'codex',
      folder: '/tmp',
      swarmId: tab.id,
    );
    await Future<void>.delayed(Duration.zero);
    await stopped();
    expect(app.swarms.single, same(tab));
    connection.create.complete({'error': 'FIXTURE_FAILURE'});
    await creation;
  });
  testWidgets('a quiet New Tab stays open when the previous tab stops', (
    tester,
  ) async {
    app.status = AppStatus.authenticated;
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyT);
    final draft = app.activeSwarmId;
    expect(app.swarms, hasLength(2));
    await stopped();
    await tester.pump();
    expect(app.swarms, hasLength(1));
    expect(app.activeSwarmId, draft);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(app.swarms, hasLength(1));
    expect(app.activeSwarmId, draft);
    expect(app.activeSwarm.isNewTabPage, isTrue);
    expect(app.activeSwarm.isEmptyStarter, isTrue);
    expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('last stopped tab becomes one quiet welcome page', (
    tester,
  ) async {
    // The same entry condition as an authenticated, connected workspace.
    app.status = AppStatus.authenticated;
    app.adoptSessionForTest(terminal('a0', []));
    app.renameSwarm(app.activeSwarmId, 'Blender');
    final oldId = app.activeSwarmId;
    await mount(tester, app);
    await stopped();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(app.swarms, hasLength(1));
    expect(app.activeSwarmId, isNot(oldId));
    expect(app.activeSwarm.isEmptyStarter, isTrue);
    expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
    await stopped();
    expect(app.swarms, hasLength(1));
    await tester.pumpWidget(const SizedBox());
  });
}
