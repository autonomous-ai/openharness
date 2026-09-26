import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'support/stop_connection.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

class _Connection extends StopConnection {
  final creation = Completer<Map<String, dynamic>>();

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) => type == 'agent_create'
      ? creation.future
      : super.request(type, payload: payload, timeout: timeout);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'closing the final pane selects its neighboring tab and persists it',
    () async {
      final store = MemoryStore();
      final app = createApp(store: store);
      addTearDown(app.dispose);
      final left = app.adoptSessionForTest(terminal('a0', []));
      final leftTab = app.activeSwarm;
      app.newSwarm(name: 'Closing');
      final closing = app.adoptSessionForTest(terminal('a1', []));
      final closingTab = app.activeSwarm;
      app.newSwarm(name: 'Working');
      final right = app.adoptSessionForTest(terminal('a2', []));
      final rightTab = app.activeSwarm;
      app.selectSwarm(closingTab.id);

      await app.closePane(closing.id);

      expect(app.swarms, [leftTab, rightTab]);
      expect(app.activeSwarm, same(rightTab));
      expect(app.focusedPane, same(right));
      expect(app.allPanes, [left, right]);
      await app.flushPaneLayout();
      final restored = createApp(store: store);
      addTearDown(restored.dispose);
      await restored.restorePaneLayoutForTest();
      expect(restored.swarms.map((tab) => tab.id), [leftTab.id, rightTab.id]);
      expect(restored.activeSwarmId, rightTab.id);
    },
  );

  test('the last tab becomes a fresh welcome and can be reopened with its name and layout', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final original = app.activeSwarm;
    app.renameSwarm(original.id, 'Project work');
    original.presets[2] = PanePreset.rows;

    await app.closePane(pane.id);

    expect(app.swarms.single.id, isNot(original.id));
    expect(app.activeSwarm.name, Swarm.defaultName);
    expect(app.activeSwarm.isEmptyStarter, isTrue);
    expect(app.closedHistory, hasLength(1));
    expect(app.reopenClosed(), isTrue);
    expect(app.swarms.single.id, original.id);
    expect(app.activeSwarm.name, 'Project work');
    expect(app.activeSwarm.presets[2], PanePreset.rows);
    expect(app.panes.single.agentId, 'a0');
  });

  test('a shared terminal stays attached when its other tab closes', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final session = pane.session;
    final closing = app.activeSwarm;
    app.newSwarm(name: 'Shared work');
    await app.addAgentToSwarm('m', 'a0');
    final kept = app.activeSwarm;
    app.selectSwarm(closing.id);

    await app.closePane(pane.id);

    expect(app.swarms, [kept]);
    expect(app.panes.single, same(pane));
    expect(pane.session, same(session));
  });

  test('an owned viewer closes with the final terminal and is not restored as an empty terminal', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final closing = app.activeSwarm;
    closing.panes.add(
      TerminalPane(
        id: 900,
        machineId: 'm',
        kind: PaneKind.web,
        ownerAgentId: 'a0',
        url: 'http://fixture.invalid',
      ),
    );

    await app.closePane(pane.id);

    expect(app.swarms, isNot(contains(closing)));
    expect(app.allPanes, isEmpty);
    expect(app.reopenClosed(), isTrue);
    expect(app.panes.single.agentId, 'a0');
  });

  test(
    'closing one of several panes keeps the tab and its remaining work',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final first = app.adoptSessionForTest(terminal('a0', []));
      final second = app.adoptSessionForTest(terminal('a1', []));
      final tab = app.activeSwarm;

      await app.closePane(first.id);

      expect(app.swarms, [tab]);
      expect(app.panes, [second]);
      expect(app.closedHistory.single, isA<ClosedAgent>());
    },
  );

  test('an in-flight creation retains its destination after the old final pane closes', () async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final tab = app.activeSwarm;
    app.stateOf('m')!.nodeOnline = true;
    final creating = app.createAgent(
      'm',
      engine: 'codex',
      folder: '/tmp',
      swarmId: tab.id,
    );
    await Future<void>.delayed(Duration.zero);

    await app.closePane(pane.id);

    expect(app.swarms, [tab]);
    connection.creation.complete({'error': 'FIXTURE_FAILURE'});
    await creating;
  });

  testWidgets(
    'closing the final pane by keyboard returns input to the neighboring tab',
    (tester) async {
      final app = createApp();
      final input = <TerminalBinaryFrame>[];
      final kept = app.adoptSessionForTest(terminal('a0', input));
      final keptTab = app.activeSwarm;
      app.newSwarm(name: 'Closing');
      app.adoptSessionForTest(terminal('a1', []));
      await mount(tester, app);

      await chord(tester, LogicalKeyboardKey.keyW, shift: true);

      expect(app.swarms, [keptTab]);
      expect(app.focusedPane, same(kept));
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(input.single.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
