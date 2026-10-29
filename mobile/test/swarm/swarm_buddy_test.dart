import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_buddy.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// Buddies on the phone (spec: Buddies, 10-28; every Swarm since #2090): each
/// person's Buddy chat in each project, where the PM's private lines land,
/// and the Buddy that may run in it — Desktop's `buddies.dart` and
/// `SuperTabController.buddyChat`/`buddy`/`buddyStart`.
void main() {
  SwarmReader reader(FakeSwarm swarm) =>
      SwarmReader(tabId: tab, accountId: me, request: swarm.request);

  group('the reader', () {
    test("keeps the person's own Buddy chat and Buddy in each project, and "
        'knows every Buddy chat it holds', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [
          groupData('g1', title: 'Fix login', number: 7),
          buddyChatData('buddy-dee', owner: 'person-dee'),
          buddyChatData('buddy-me', agentIds: ['agent-wren']),
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          buddyData('agent-ivy', owner: 'person-dee', displayName: 'Ivy'),
          buddyData('agent-wren', displayName: 'Wren'),
        ],
      );
      final r = reader(swarm);
      addTearDown(r.dispose);

      await r.refresh();

      expect(swarmBuddyChat(r, project)?.id, 'buddy-me');
      expect(swarmBuddy(r, project)?.id, 'agent-wren');
      expect(swarmIsBuddyChat(r, 'buddy-me'), isTrue);
      expect(
        swarmIsBuddyChat(r, 'buddy-dee'),
        isTrue,
        reason: "someone else's is a Buddy chat too, never a workgroup",
      );
      expect(swarmIsBuddyChat(r, 'g1'), isFalse);
      expect(swarmIsBuddyChat(r, leadChat), isFalse);
    });

    test('has no Buddy chat or Buddy in a project where the person has '
        'none', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [buddyChatData('buddy-dee', owner: 'person-dee')],
        agents: [buddyData('agent-ivy', owner: 'person-dee')],
      );
      final r = reader(swarm);
      addTearDown(r.dispose);

      await r.refresh();

      expect(swarmBuddyChat(r, project), isNull);
      expect(swarmBuddy(r, project), isNull);
      expect(swarmBuddyChat(r, 'project-other'), isNull);
    });

    test('follows a Buddy added later, and forgets every Buddy once access '
        'ends', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
          firstLoad(groups: [buddyChatData('buddy-me')]);
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c2', lastChangedAt: 200),
        'agents': [part('agent-wren', 1, buddyData('agent-wren'))],
      };
      final r = reader(swarm);
      addTearDown(r.dispose);

      await r.refresh();
      expect(swarmBuddy(r, project), isNull);

      await r.refresh();
      expect(swarmBuddy(r, project)?.id, 'agent-wren');

      r.revoke();
      expect(swarmBuddyChat(r, project), isNull);
      expect(swarmBuddy(r, project), isNull);
      expect(swarmIsBuddyChat(r, 'buddy-me'), isFalse);
    });

    test("the newest of the person's own Buddy starts in a project is the one "
        'that counts', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [
          buddyChatData('buddy-me'),
          buddyChatData('buddy-dee', owner: 'person-dee'),
        ],
        starts: [
          buddyStartData('s1', chatId: 'buddy-me', error: 'Machine offline'),
          buddyStartData('s2', chatId: 'buddy-me', engine: 'codex'),
          buddyStartData('s3', chatId: 'buddy-dee', owner: 'person-dee'),
        ],
      );
      final r = reader(swarm);
      addTearDown(r.dispose);

      await r.refresh();

      final start = swarmBuddyStart(r, project)!;
      expect(start['id'], 's2');
      expect((start['request'] as Map)['engine'], 'codex');
    });

    test('a work start is no Buddy start', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [buddyChatData('buddy-me')],
        starts: [
          {
            'id': 's1',
            'request': {
              'conversationId': 'buddy-me',
              'machineId': 'mac-1',
              'engine': 'claude',
            },
            'harnessId': null,
            'error': null,
          },
        ],
      );
      final r = reader(swarm);
      addTearDown(r.dispose);

      await r.refresh();

      expect(swarmBuddyStart(r, project), isNull);
    });
  });

  group('commands', () {
    const commands = '/api/super-tabs/$tab/commands';

    test(
      'opening a Buddy chat the read holds asks the server nothing',
      () async {
        final swarm = FakeSwarm();
        swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
            firstLoad(groups: [buddyChatData('buddy-me')]);
        final r = reader(swarm);
        addTearDown(r.dispose);
        await r.refresh();

        expect(await openSwarmBuddyChat(r, project), 'buddy-me');
        expect(swarm.commands, isEmpty);
      },
    );

    test('opening one the read lacks opens it on the server, one request per '
        'person, membership and project, and answers its id', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      swarm.routes[commands] = (_) => {
        'result': {'conversationId': 'buddy-new'},
      };
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();

      expect(await openSwarmBuddyChat(r, project), 'buddy-new');
      expect(await openSwarmBuddyChat(r, project), 'buddy-new');

      expect(swarm.commands, [
        {'type': 'buddy.chat', 'projectId': project},
        {'type': 'buddy.chat', 'projectId': project},
      ]);
      final operations = {
        for (final call in swarm.calls)
          if (call.path == commands) call.body!['operationId'],
      };
      expect(operations, {
        'buddy-chat-$project-$me-gen-$me',
      }, reason: 'a second tap or another device gets the same chat back');
    });

    test('a refused open says why', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      swarm.routes[commands] = (_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'You cannot read this project.',
        statusCode: 403,
      );
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();

      await expectLater(
        openSwarmBuddyChat(r, project),
        throwsA(
          isA<SuperTabFailure>().having(
            (f) => f.message,
            'message',
            'You cannot read this project.',
          ),
        ),
      );
    });

    test('starting a Buddy sends its project, machine and engine, then reads '
        'the Swarm again so its start shows', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
          firstLoad(groups: [buddyChatData('buddy-me')]);
      swarm.routes[commands] = (_) => {
        'result': {'conversationId': 'buddy-me'},
      };
      var changesRead = 0;
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) {
        changesRead++;
        return {
          ...changes(cursor: 'c2', lastChangedAt: 200),
          'starts': [part('s1', 1, buddyStartData('s1', chatId: 'buddy-me'))],
        };
      };
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();

      final id = await startSwarmBuddy(
        r,
        projectId: project,
        machineId: 'mac-1',
        engine: 'codex',
      );

      expect(id, 'buddy-me');
      expect(swarm.commands, [
        {
          'type': 'buddy.create',
          'projectId': project,
          'machineId': 'mac-1',
          'engine': 'codex',
        },
      ]);
      expect(changesRead, 1);
      expect(swarmBuddyStart(r, project)?['id'], 's1');
    });

    test(
      'removing the Buddy sends its project, then reads the Swarm again',
      () async {
        final swarm = FakeSwarm();
        swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
          groups: [buddyChatData('buddy-me')],
          agents: [buddyData('agent-wren')],
        );
        swarm.routes[commands] = (_) => {'result': <String, Object?>{}};
        swarm.routes['/api/super-tabs/$tab/changes'] = (_) => {
          ...changes(cursor: 'c2', lastChangedAt: 200),
          'agents': [
            {
              'key': 'agent-wren',
              'version': 2,
              'changedAt': 200,
              'deleted': true,
            },
          ],
        };
        final r = reader(swarm);
        addTearDown(r.dispose);
        await r.refresh();

        await removeSwarmBuddy(r, project);

        expect(swarm.commands, [
          {'type': 'buddy.remove', 'projectId': project},
        ]);
        expect(swarm.paths.last, startsWith('/api/super-tabs/$tab/changes'));
        expect(swarmBuddy(r, project), isNull);
        expect(
          swarmBuddyChat(r, project)?.id,
          'buddy-me',
          reason: 'its chat stays',
        );
      },
    );
  });

  group('a Buddy as its rows show it', () {
    Future<SwarmReader> read({
      List<Map<String, dynamic>> agents = const [],
      List<Map<String, dynamic>> starts = const [],
    }) async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [buddyChatData('buddy-me')],
        agents: agents,
        starts: starts,
      );
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();
      return r;
    }

    test('is named after its Buddy, and reads Buddy while none runs', () async {
      expect(
        swarmBuddyName(
          await read(agents: [buddyData('agent-wren', displayName: 'Wren')]),
          project,
        ),
        'Wren',
      );
      expect(swarmBuddyName(await read(), project), 'Buddy');
    });

    test(
      'says not started, starting, or offline; nothing while it runs',
      () async {
        expect(swarmBuddyNote(await read(), project), 'not started');
        expect(
          swarmBuddyNote(
            await read(starts: [buddyStartData('s1', chatId: 'buddy-me')]),
            project,
          ),
          'starting',
        );
        expect(
          swarmBuddyNote(
            await read(
              starts: [
                buddyStartData('s1', chatId: 'buddy-me', error: 'No machine'),
              ],
            ),
            project,
          ),
          'not started',
          reason: 'a start that failed is no start',
        );
        expect(
          swarmBuddyNote(
            await read(
              agents: [
                {
                  ...buddyData('agent-wren'),
                  'downSince': '2026-10-29T01:00:00.000Z',
                },
              ],
            ),
            project,
          ),
          'offline',
        );
        expect(
          swarmBuddyNote(
            await read(agents: [buddyData('agent-wren')]),
            project,
          ),
          isNull,
        );
      },
    );
  });

  group("a project's work", () {
    test('lists no Buddy chat and no private chat: Chat with PM is closed '
        '(#2090), so its old history is hidden too', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [
          groupData('g1', title: 'Fix login', number: 7),
          buddyChatData('buddy-me'),
          groupData('pm-old', title: 'person-me', audience: [me]),
          groupData('g2', title: 'Ship it', number: 8),
        ],
      );
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();
      final snapshot = r.snapshot!;

      final work = swarmProjectWork(
        snapshot,
        snapshot.projects.single,
        buddies: r.buddies,
      );

      expect([for (final g in work.active) g.id], ['g1', 'g2']);
      expect(work.older, isEmpty);
    });
  });

  group('the machines a Buddy may start on', () {
    Map<String, dynamic> pool(
      String id,
      String name, {
      String owner = me,
      String? host,
    }) => {
      'machineId': id,
      'name': name,
      'contributorId': owner,
      'hostMachineId': ?host,
      'engines': ['claude', 'codex'],
    };

    test("are the person's own, named without .local; never one shared with "
        'them or another person\'s', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        machines: [
          pool('mac-1', 'Tonys-MacBook-Pro.local'),
          pool('mac-2', 'Dee Studio', owner: 'person-dee'),
          pool('mac-3', 'Shared Mini', host: 'mac-9'),
          pool('mac-4', 'Mac Studio'),
        ],
      );
      final r = reader(swarm);
      addTearDown(r.dispose);

      await r.refresh();

      expect(swarmBuddyMachines(r), [
        (id: 'mac-1', name: 'Tonys-MacBook-Pro', inSwarm: true, away: false),
        (id: 'mac-4', name: 'Mac Studio', inSwarm: true, away: false),
      ]);
    });

    // Dee, 10-29: a Buddy runs on any of the person's own computers without
    // adding it to the Swarm; each by the name its person gave it.
    test('are every computer of their own too, by its given name, online ones '
        'first and offline ones last', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
          firstLoad(machines: [pool('mac-1', 'Tonys-MacBook-Pro.local')]);
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();

      expect(
        swarmBuddyMachines(
          r,
          computers: [
            (id: 'air', name: 'MacBook Air', away: true),
            (id: 'mac-1', name: 'tropic', away: false),
            (id: 'studio', name: 'Studio', away: false),
          ],
        ),
        [
          (id: 'mac-1', name: 'tropic', inSwarm: true, away: false),
          (id: 'studio', name: 'Studio', inSwarm: false, away: false),
          (id: 'air', name: 'MacBook Air', inSwarm: false, away: true),
        ],
      );
      expect(
        swarmBuddyMachineName(
          r,
          'studio',
          computers: [(id: 'studio', name: 'Studio', away: false)],
        ),
        'Studio',
      );
    });

    test('are none before the Swarm is read', () {
      final r = reader(FakeSwarm());
      addTearDown(r.dispose);

      expect(swarmBuddyMachines(r), isEmpty);
    });
  });
  group("the PM's private lines", () {
    SuperTabMessage line(String chat, String author, {bool agent = true}) =>
        SuperTabMessage.fromJson({
          'id': 'm-$chat-$author',
          'conversationId': chat,
          'text': 'hello',
          'sequence': 1,
          'author': {'kind': agent ? 'agent' : 'person', 'id': author},
        });

    test("are the project Lead's lines in the person's own Buddy chat, and "
        'no one else\'s', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [
          groupData('g1', title: 'Fix login', number: 7),
          buddyChatData('buddy-me', agentIds: ['agent-wren']),
          buddyChatData('buddy-dee', owner: 'person-dee'),
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          buddyData('agent-wren', displayName: 'Wren'),
        ],
      );
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();

      expect(swarmIsPmLine(r, line('buddy-me', 'agent-lead')), isTrue);
      expect(
        swarmIsPmLine(r, line('buddy-me', 'agent-wren')),
        isFalse,
        reason: 'the Buddy itself',
      );
      expect(
        swarmIsPmLine(r, line('buddy-me', me, agent: false)),
        isFalse,
        reason: 'the person',
      );
      expect(
        swarmIsPmLine(r, line('buddy-dee', 'agent-lead')),
        isFalse,
        reason: "someone else's Buddy chat",
      );
      expect(swarmIsPmLine(r, line('g1', 'agent-lead')), isFalse);
      expect(swarmIsPmLine(r, line(leadChat, 'agent-lead')), isFalse);
      expect(swarmIsOwnBuddyChat(r, 'buddy-me'), isTrue);
      expect(swarmIsOwnBuddyChat(r, 'buddy-dee'), isFalse);
    });
  });

  group('names in a Buddy chat', () {
    test('a machine by its Swarm name without .local, another machine while '
        'unnamed; a person by their address before the @', () async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        machines: [
          {'machineId': 'mac-1', 'name': 'Tonys-MacBook-Pro.local'},
          {'machineId': 'mac-2', 'name': ''},
        ],
      );
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();

      expect(swarmBuddyMachineName(r, 'mac-1'), 'Tonys-MacBook-Pro');
      expect(swarmBuddyMachineName(r, 'mac-2'), 'another machine');
      expect(swarmBuddyMachineName(r, 'mac-9'), 'another machine');
      expect(swarmBuddyPersonName(r, me), 'person-me');
      expect(swarmBuddyPersonName(r, 'person-gone'), 'its owner');
    });
  });

  group('what the person does to their Buddy', () {
    const commands = '/api/super-tabs/$tab/commands';

    Future<(FakeSwarm, SwarmReader)> read() async {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) =>
          firstLoad(groups: [buddyChatData('buddy-me')]);
      final r = reader(swarm);
      addTearDown(r.dispose);
      await r.refresh();
      return (swarm, r);
    }

    test('runs one at a time: a second tap while one is under way sends '
        'nothing', () async {
      final (swarm, r) = await read();
      final answer = Completer<Object?>();
      swarm.routes[commands] = (_) => answer.future;
      final actions = SwarmBuddyActions(r, project);
      addTearDown(actions.dispose);

      final first = actions.start(machineId: 'mac-1', engine: 'codex');
      expect(actions.busy, isTrue);
      await actions.start(machineId: 'mac-1', engine: 'claude');
      await actions.remove();
      answer.complete({'result': <String, dynamic>{}});
      await first;

      expect(swarm.commands, [
        {
          'type': 'buddy.create',
          'projectId': project,
          'machineId': 'mac-1',
          'engine': 'codex',
        },
      ]);
      expect(actions.busy, isFalse);
      expect(actions.error, isNull);
    });

    test('on a computer of their own outside the Swarm prepares it there, '
        'then starts the Buddy with its setup', () async {
      final (swarm, r) = await read();
      swarm.routes[commands] = (_) => {'result': <String, dynamic>{}};
      final computers = FakeComputers(const []);
      var asks = 0;
      computers.answer = (_, payload) => ++asks == 1
          ? {'ok': true, 'state': 'preparing'}
          : {
              'ok': true,
              'state': 'ready',
              'scope': 'swarm',
              'cwd': '/home/me/swarm',
              'engines': ['claude', 'pi'],
            };
      final actions = SwarmBuddyActions(r, project);
      addTearDown(actions.dispose);

      await actions.start(
        machineId: 'studio',
        engine: 'claude',
        machine: (id: 'studio', name: 'Studio', inSwarm: false, away: false),
        computers: computers,
      );

      expect(actions.error, isNull);
      expect(computers.asked.map((a) => a.$1), ['studio', 'studio']);
      expect(computers.asked.first.$2, {
        'action': 'prepareContribution',
        'tabId': tab,
        'scope': 'swarm',
        'operationId': computers.asked.last.$2['operationId'],
      });
      expect(swarm.commands, [
        {
          'type': 'buddy.create',
          'projectId': project,
          'machineId': 'studio',
          'engine': 'claude',
          'setup': {
            'name': 'Studio',
            'cwd': '/home/me/swarm',
            'engines': ['claude'],
          },
        },
      ]);
    });

    test('on a machine already in the Swarm sends no setup and asks the '
        'computer nothing', () async {
      final (swarm, r) = await read();
      swarm.routes[commands] = (_) => {'result': <String, dynamic>{}};
      final computers = FakeComputers(const []);
      final actions = SwarmBuddyActions(r, project);
      addTearDown(actions.dispose);

      await actions.start(
        machineId: 'mac-1',
        engine: 'claude',
        machine: (id: 'mac-1', name: 'tropic', inSwarm: true, away: false),
        computers: computers,
      );

      expect(computers.asked, isEmpty);
      expect(swarm.commands.single, isNot(contains('setup')));
    });

    test(
      'a computer that cannot prepare says why and starts nothing',
      () async {
        final (swarm, r) = await read();
        final computers = FakeComputers(const [])
          ..answer = (_, _) => {'ok': true, 'state': 'unknown'};
        final actions = SwarmBuddyActions(r, project);
        addTearDown(actions.dispose);

        await actions.start(
          machineId: 'studio',
          engine: 'claude',
          machine: (id: 'studio', name: 'Studio', inSwarm: false, away: false),
          computers: computers,
        );

        expect(
          actions.error,
          'Update Harness on this computer, then try again.',
        );
        expect(swarm.commands, isEmpty);
      },
    );

    test('says why a start was refused, and forgets it once the next goes '
        'through', () async {
      final (swarm, r) = await read();
      swarm.routes[commands] = (_) => throw const SuperTabFailure(
        'MACHINE_OFFLINE',
        'That machine is offline.',
        statusCode: 409,
      );
      final actions = SwarmBuddyActions(r, project);
      addTearDown(actions.dispose);

      await actions.start(machineId: 'mac-1', engine: 'claude');
      expect(actions.error, 'That machine is offline.');

      swarm.routes[commands] = (_) => {'result': <String, dynamic>{}};
      await actions.remove();
      expect(actions.error, isNull);
      expect(swarm.commands.last, {
        'type': 'buddy.remove',
        'projectId': project,
      });
    });

    test('a failure with no reason says what failed', () async {
      final (swarm, r) = await read();
      swarm.routes[commands] = (_) => throw StateError('offline');
      final actions = SwarmBuddyActions(r, project);
      addTearDown(actions.dispose);

      await actions.remove();

      expect(actions.error, "Couldn't remove your Buddy. Try again.");
    });

    test('closed while one is under way, it tells no one', () async {
      final (swarm, r) = await read();
      final answer = Completer<Object?>();
      swarm.routes[commands] = (_) => answer.future;
      final actions = SwarmBuddyActions(r, project);
      var told = 0;
      actions.addListener(() => told++);

      final running = actions.start(machineId: 'mac-1', engine: 'claude');
      expect(told, 1);
      actions.dispose();
      answer.complete({'result': <String, dynamic>{}});
      await running;

      expect(told, 1);
    });
  });
}
