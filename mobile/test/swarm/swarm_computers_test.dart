import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agents_list_page.dart';
import 'package:harness_mobile/swarm/swarm_agents.dart';
import 'package:harness_mobile/swarm/swarm_computers.dart';

import '../viewer_app_fixture.dart';

/// The account's computers as Swarm's start screens see them, from the app's
/// own machine list.
void main() {
  test('each computer by name, away only when the socket and the list agree, '
      'and nothing until the list has answered', () async {
    final rig = viewerApp();
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    expect(computers.computers, isNull, reason: 'not answered yet');

    rig.api.onMachines = () async => [
      remoteMachine('a', name: 'Studio Mac'),
      remoteMachine('b', name: 'Mac mini', status: 'offline'),
    ];
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('a', ConnectionStatus.connected);
    rig.app.connectionStatusForTest('b', ConnectionStatus.disconnected);
    await settle();

    expect(computers.computers, [
      (name: 'Studio Mac', away: false),
      (name: 'Mac mini', away: true),
    ]);
  });

  test('tells only when the computers change, not at every change of the '
      'app', () async {
    final rig = await signedInWith({'a': []});
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    var told = 0;
    computers.addListener(() => told++);

    rig.app.connectionStatusForTest('a', ConnectionStatus.connected);
    await settle();
    expect(told, 0);

    rig.api.onMachines = () async => [remoteMachine('a', status: 'offline')];
    await rig.app.refreshMachines();
    rig.app.connectionStatusForTest('a', ConnectionStatus.disconnected);
    await settle();

    expect(computers.computers, [(name: 'Machine a', away: true)]);
    expect(told, 1);
  });

  // At a cold start the socket comes up after the list, away all along: a
  // Swarm read that failed for want of a computer waited 2 to 8 s for its
  // next try (audit of 44d284f65, item 6).
  test('tells when a computer comes up, and not when it goes', () async {
    final rig = await signedInWith({'a': []});
    addTearDown(rig.app.dispose);
    rig.app.connectionStatusForTest('a', ConnectionStatus.connecting);
    await settle();
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    var told = 0;
    computers.addListener(() => told++);

    rig.app.connectionStatusForTest('a', ConnectionStatus.connected);
    await settle();
    expect(told, 1);
    expect(computers.computers, [(name: 'Machine a', away: false)]);

    rig.app.connectionStatusForTest('a', ConnectionStatus.reconnecting);
    await settle();
    expect(told, 1, reason: 'still listed as up: nothing to tell');
  });

  test("the person's own computers: never one shared with them, nor a "
      'Harness Team account, nor one waiting for a link; their own away '
      'ones too, as away', () async {
    final rig = viewerApp();
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    Machine machine(String id, {bool shared = false, String? kind}) => Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: id,
      status: 'online',
      shared: shared,
      sessionKind: kind,
    );
    rig.api.onMachines = () async => [
      machine('studio'),
      machine('mini'),
      machine('ken-mac', shared: true),
      machine('team', kind: 'team'),
      machine('new-mac'),
    ];
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('studio', ConnectionStatus.connected);
    rig.app.connectionStatusForTest('mini', ConnectionStatus.disconnected);
    rig.app.machineStates['new-mac']!.needsLink = true;
    rig.api.onMachines = () async => [
      machine('studio'),
      Machine(
        machineId: 'mini',
        authMode: MachineAuthMode.remote,
        name: 'mini',
        status: 'offline',
      ),
      machine('ken-mac', shared: true),
      machine('team', kind: 'team'),
      machine('new-mac'),
    ];
    await rig.app.refreshMachines();
    await settle();

    expect(computers.computers, hasLength(5));
    expect(computers.own, [
      (id: 'studio', name: 'studio', away: false),
      (id: 'mini', name: 'mini', away: true),
    ]);
  });

  test('tells when only what makes a computer the person\'s own changes — '
      'shared, a Team account, waiting for a link — its name and whether it '
      'is away the same', () async {
    final rig = viewerApp();
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    Machine machine(String id, {bool shared = false, String? kind}) => Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: id,
      status: 'online',
      shared: shared,
      sessionKind: kind,
    );
    rig.api.onMachines = () async => [machine('a'), machine('b'), machine('c')];
    await rig.app.bootstrap();
    await settle();
    final listed = computers.computers;
    var told = 0;
    computers.addListener(() => told++);

    rig.api.onMachines = () async => [
      machine('a', shared: true),
      machine('b'),
      machine('c'),
    ];
    await rig.app.refreshMachines();
    await settle();
    expect(computers.computers, listed, reason: 'names and away the same');
    expect(told, 1, reason: 'shared');
    expect([for (final c in computers.own) c.id], ['b', 'c']);

    rig.api.onMachines = () async => [
      machine('a', shared: true),
      machine('b', kind: 'team'),
      machine('c'),
    ];
    await rig.app.refreshMachines();
    await settle();
    expect(told, 2, reason: 'a Team account');
    expect([for (final c in computers.own) c.id], ['c']);

    rig.app.machineStates['c']!.needsLink = true;
    await rig.app.refreshMachines();
    await settle();
    expect(computers.computers, listed, reason: 'names and away the same');
    expect(told, 3, reason: 'waiting for a link');
    expect(computers.own, isEmpty);
  });

  test('Try again reads the list again', () async {
    final rig = await signedInWith({'a': []});
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    var listed = 0;
    rig.api.onMachines = () async {
      listed++;
      return [remoteMachine('a')];
    };

    await computers.recheck();

    expect(listed, 1);
    expect(computers.rechecking, isFalse);
  });

  group("the person's agents, for Home's Agents tile and Search", () {
    test('none known until the computers answer; then each agent that can '
        'open, by computer and engine, and how many work', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      final computers = AppSwarmComputers(rig.app);
      addTearDown(computers.dispose);
      expect(computers, isA<SwarmAgentsSource>());
      final agents = computers.agents;
      expect(agents.working, isNull, reason: 'not answered yet');
      expect(agents.agents, isEmpty);

      rig.api.onMachines = () async => [remoteMachine('a', name: 'Studio')];
      rig.conn('a').answers['agents_list'] = (_) => {
        'agents': [
          agentJson('one', name: 'Wren'),
          agentJson('two', name: 'Ivy', engine: 'codex'),
          agentJson('gone', terminal: false),
        ],
      };
      await rig.app.bootstrap();
      await settle();
      rig.app.connectionStatusForTest('a', ConnectionStatus.connected);
      await settle();

      expect(agents.working, 0);
      expect(
        [for (final a in agents.agents) (a.machineId, a.agentId, a.machine)],
        unorderedEquals([('a', 'one', 'Studio'), ('a', 'two', 'Studio')]),
        reason: 'one without a terminal cannot open',
      );
      final ivy = agents.agents.singleWhere((a) => a.agentId == 'two');
      expect((ivy.name, ivy.engine), ('Ivy', 'codex'));
      expect((ivy.working, ivy.waiting), (false, false));

      await push(rig, 'a', 'turn_started', {'agentId': 'two'});

      expect(agents.working, 1);
      expect(
        agents.agents.singleWhere((a) => a.agentId == 'two').working,
        isTrue,
      );
    });

    test('tells when how many work changes, not at every change of the app; '
        "and never tells Swarm's computers, whose change reads Swarms "
        'again', () async {
      final rig = await signedInWith({
        'a': ['one', 'two'],
      });
      addTearDown(rig.app.dispose);
      final computers = AppSwarmComputers(rig.app);
      addTearDown(computers.dispose);
      var told = 0, computersTold = 0;
      computers.agents.addListener(() => told++);
      computers.addListener(() => computersTold++);

      await push(rig, 'a', 'turn_started', {'agentId': 'one'});
      expect(told, 1);

      Map<String, dynamic> question() => {
        'agentId': 'two',
        'requestId': 'q1',
        'questions': [
          {
            'q': 'Proceed?',
            'options': ['Yes'],
          },
        ],
      };
      await push(rig, 'a', 'commander_question', question());
      expect(told, 2, reason: "one waits now: Search's dot");
      expect(
        computers.agents.agents.singleWhere((a) => a.agentId == 'two').waiting,
        isTrue,
      );

      var appTold = 0;
      void counted() => appTold++;
      rig.app.addListener(counted);
      addTearDown(() => rig.app.removeListener(counted));
      // Re-announced after a reconnect: the app tells, nothing changed.
      await push(rig, 'a', 'commander_question', question());
      await push(rig, 'a', 'turn_heartbeat', {'agentId': 'one'});
      await settle();
      expect(appTold, greaterThan(0), reason: 'the app did tell');
      expect(told, 2, reason: 'still one working, one waiting');

      await push(rig, 'a', 'turn_ended', {'agentId': 'one'});
      expect(told, 3);
      expect(computers.agents.working, 0);
      expect(computersTold, 0);
    });

    test(
      'tells when the agents themselves change, the count the same',
      () async {
        final rig = await signedInWith({
          'a': ['one'],
        });
        addTearDown(rig.app.dispose);
        final computers = AppSwarmComputers(rig.app);
        addTearDown(computers.dispose);
        var told = 0;
        computers.agents.addListener(() => told++);

        rig.conn('a').answers['agents_list'] = (_) => {
          'agents': [agentJson('one'), agentJson('three')],
        };
        await rig.app.syncAgentsForTest('a');
        await settle();

        expect(told, 1);
        expect(computers.agents.working, 0);
        expect(
          [for (final a in computers.agents.agents) a.agentId],
          ['one', 'three'],
        );
      },
    );

    test('gone with its computers: a change of the app after tells no one '
        'and throws nothing', () async {
      final rig = await signedInWith({
        'a': ['one'],
      });
      addTearDown(rig.app.dispose);
      final computers = AppSwarmComputers(rig.app);
      final agents = computers.agents;
      computers.dispose();

      await push(rig, 'a', 'turn_started', {'agentId': 'one'});

      expect(agents.working, 0, reason: 'as it was left');
    });

    testWidgets('opens every agent, the Agents list, over the page', (
      tester,
    ) async {
      final rig = await tester.runAsync(() => signedInWith({'a': []}));
      addTearDown(rig!.app.dispose);
      final computers = AppSwarmComputers(rig.app);
      addTearDown(computers.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => computers.agents.openList(context),
              child: const Text('Agents'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Agents'));
      await tester.pumpAndSettle();

      expect(find.byType(AgentsListPage), findsOneWidget);
    });
  });
}
