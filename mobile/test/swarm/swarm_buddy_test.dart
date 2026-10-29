import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_buddy.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

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
        (id: 'mac-1', name: 'Tonys-MacBook-Pro'),
        (id: 'mac-4', name: 'Mac Studio'),
      ]);
    });

    test('are none before the Swarm is read', () {
      final r = reader(FakeSwarm());
      addTearDown(r.dispose);

      expect(swarmBuddyMachines(r), isEmpty);
    });
  });
}
