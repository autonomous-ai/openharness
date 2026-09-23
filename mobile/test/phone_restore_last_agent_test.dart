import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';
import 'voice_fakes.dart';

/// The phone opens on the agent it was left on.
///
/// ⚠️ **The window these are about is a daemon that has just started.** It clears every agent's
/// terminal availability as it loads its registry and fills it back in one agent at a time, as its
/// reconciler observes each pane — so a launch inside that window sees its own agent as unopenable
/// for a second or two. Reading that as "gone" put the phone on whichever agent happened to have
/// been verified first, which is the oldest one on the machine.
void main() {
  Future<void> pumpHome(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(
      MaterialApp(
        home: PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (_, _) {},
          child: AgentHome(notifier: app),
        ),
      ),
    );
    // The record is read from storage, so the first frame cannot have it yet.
    await tester.pump();
    await tester.pump();
    // The visit the pager records is debounced (see [PhoneSearchHistory]); let it land rather than
    // leave its timer behind.
    await tester.pump(const Duration(milliseconds: 700));
  }

  /// The fixture dials its machine as it is built, and that load is still in flight when a test
  /// starts arranging the machine's agents. Let it land first, so the scene each test sets is the
  /// one the screen sees.
  Future<void> settleFixtureLoad(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 11));
  }

  String? openedAgent(WidgetTester tester) {
    final hosts = tester.widgetList<AgentSwipeHost>(
      find.byType(AgentSwipeHost),
    );
    return hosts.isEmpty ? null : hosts.first.agentId;
  }

  MemoryKeyValueStore remembering(String agentId) => MemoryKeyValueStore()
    ..values['phone_last_agent_v1'] = jsonEncode({
      'machineId': 'm',
      'agentId': agentId,
    });

  Agent agent(String id, {required bool terminal}) => Agent(
    id: id,
    name: id,
    engine: 'claude',
    project: const AgentProject(name: 'work', cwd: '/work'),
    terminalAvailable: terminal,
  );

  /// The machine listing [ids], as it is once its `agents_list` has landed.
  void machineLists(AppNotifier app, List<Agent> agents) => app.stateOf('m')!
    ..agents = agents
    ..agentLoadStatus = AgentLoadStatus.loaded;

  /// The daemon reporting one agent's terminal, the way its reconciler does when it has looked at
  /// the pane — the only signal that turns an agent back on once the list has landed.
  Future<void> reportTerminal(
    WidgetTester tester,
    AppNotifier app,
    String id,
  ) async {
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'agentId': id,
      'payload': <String, dynamic>{
        'agent': <String, dynamic>{
          'id': id,
          'name': id,
          'engine': 'claude',
          'project': <String, dynamic>{'name': 'work', 'cwd': '/work'},
          'terminal': <String, dynamic>{'available': true},
        },
      },
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));
  }

  Future<AppNotifier> app(
    WidgetTester tester, {
    MemoryKeyValueStore? storage,
  }) async {
    final app = await deskApp(
      PagerConn(),
      opensTerminals: false,
      storage: storage,
    );
    addTearDown(app.dispose);
    await settleFixtureLoad(tester);
    return app;
  }

  testWidgets('opens the agent the last run left, not the first one', (
    tester,
  ) async {
    final notifier = await app(tester, storage: remembering('c'));
    machineLists(notifier, [
      for (final id in pagerAgentIds) agent(id, terminal: true),
    ]);
    await pumpHome(tester, notifier);
    expect(openedAgent(tester), 'c');
  });

  testWidgets('records the agent it opens, so the next launch finds it', (
    tester,
  ) async {
    final storage = MemoryKeyValueStore();
    final notifier = await app(tester, storage: storage);
    machineLists(notifier, [
      for (final id in pagerAgentIds) agent(id, terminal: true),
    ]);
    await pumpHome(tester, notifier);
    expect(storage.values['phone_last_agent_v1'], isNotNull);
  });

  testWidgets('waits for the remembered agent\'s terminal to be verified', (
    tester,
  ) async {
    final notifier = await app(tester, storage: remembering('c'));
    // The list has landed with the agent on it, but nothing has looked at its pane yet.
    machineLists(notifier, [
      for (final id in pagerAgentIds) agent(id, terminal: id != 'c'),
    ]);
    await pumpHome(tester, notifier);
    await reportTerminal(tester, notifier, 'c');
    expect(openedAgent(tester), 'c');
  });

  testWidgets('keeps the agent on screen when its terminal blinks out', (
    tester,
  ) async {
    final notifier = await app(tester, storage: remembering('c'));
    machineLists(notifier, [
      for (final id in pagerAgentIds) agent(id, terminal: true),
    ]);
    await pumpHome(tester, notifier);
    expect(openedAgent(tester), 'c', reason: 'opened on the record');
    // A refresh that has not verified this agent's terminal — it is still listed, so this is not a
    // deletion and there is nowhere for the screen to go.
    notifier.stateOf('m')!.agents = [
      for (final id in pagerAgentIds) agent(id, terminal: id != 'c'),
    ];
    await reportTerminal(tester, notifier, 'a');
    expect(openedAgent(tester), 'c');
  });
}
