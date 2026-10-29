import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/team_glance.dart';

import 'swarm_fixture.dart';

/// The team at a glance on the phone: who is working, who waits on a person,
/// who is down — read from the Swarm alone, as the phone sees no agent's
/// computer.
void main() {
  final now = DateTime(2026, 10, 27, 9);

  SuperTabSnapshot swarm({
    required List<Map<String, dynamic>> agents,
    List<Map<String, dynamic>> groups = const [],
  }) => SuperTabSnapshot.fromJson(
    SuperTabParts.firstLoad(firstLoad(agents: agents, groups: groups)).state,
  );

  Map<String, dynamic> working(String agentId, String status) => groupData(
    'work-$agentId',
    title: 'Task of $agentId',
    agentIds: [agentId],
    status: status,
    workerId: agentId,
  );

  String stateOf(SwarmTeamGlance glance, String agentId) =>
      glance.agents.singleWhere((a) => a.agent.id == agentId).label;

  test('each agent in a word, from the work it holds and its health', () {
    final glance = swarmTeamGlance(
      swarm(
        agents: [
          agent('a-work', displayName: 'Ana'),
          agent('a-review', displayName: 'Bo'),
          agent('a-check', displayName: 'Cy'),
          agent('a-wait', displayName: 'Di'),
          agent('a-stuck', displayName: 'Ed'),
          {
            ...agent('a-down', displayName: 'Fy'),
            'downSince': '2026-10-27T08:00:00Z',
          },
          {
            ...agent('a-limit', displayName: 'Gu'),
            'limitedUntil': DateTime(
              2026,
              10,
              27,
              9,
              5,
            ).toUtc().toIso8601String(),
          },
          agent('a-lost', displayName: 'Hu'),
          agent('a-idle', displayName: 'Io'),
        ],
        groups: [
          working('a-work', 'working'),
          working('a-review', 'review'),
          working('a-check', 'reconciling'),
          working('a-wait', 'needs_human'),
          working('a-stuck', 'blocked'),
          working('a-lost', 'lost'),
        ],
      ),
      now: now,
    );

    expect(stateOf(glance, 'a-work'), 'Working');
    expect(stateOf(glance, 'a-review'), 'In review');
    expect(stateOf(glance, 'a-check'), 'Checking');
    expect(stateOf(glance, 'a-wait'), 'Waiting');
    expect(stateOf(glance, 'a-stuck'), 'Stuck');
    expect(stateOf(glance, 'a-down'), 'Down');
    expect(stateOf(glance, 'a-limit'), 'Limited until 09:05');
    expect(stateOf(glance, 'a-lost'), 'Lost');
    expect(stateOf(glance, 'a-idle'), 'Idle');
  });

  test('down outranks the work it held; a limit that passed is no limit', () {
    final glance = swarmTeamGlance(
      swarm(
        agents: [
          {
            ...agent('a1', displayName: 'Ana'),
            'downSince': '2026-10-27T08:00:00Z',
          },
          {
            ...agent('a2', displayName: 'Bo'),
            'limitedUntil': DateTime(2026, 10, 27, 8).toUtc().toIso8601String(),
          },
        ],
        groups: [working('a1', 'needs_human'), working('a2', 'working')],
      ),
      now: now,
    );

    expect(stateOf(glance, 'a1'), 'Down');
    expect(stateOf(glance, 'a2'), 'Working');
  });

  test('the line counts working, waiting on a person, and down', () {
    final glance = swarmTeamGlance(
      swarm(
        agents: [
          agent('a1'),
          agent('a2'),
          agent('a3'),
          agent('a4'),
          {...agent('a5'), 'downSince': '2026-10-27T08:00:00Z'},
          agent('a6'),
        ],
        groups: [
          working('a1', 'working'),
          working('a2', 'review'),
          working('a3', 'needs_human'),
          working('a4', 'blocked'),
        ],
      ),
      now: now,
    );

    expect(glance.working, 2);
    expect(glance.waiting, 2, reason: 'stuck work waits on a person too');
    expect(glance.down, 1);
    expect(glance.line, '2 working · 2 waiting · 1 down');
  });

  test('the line leaves out what is none, and says when all are idle', () {
    expect(
      swarmTeamGlance(
        swarm(
          agents: [agent('a1'), agent('a2')],
          groups: [working('a1', 'working')],
        ),
        now: now,
      ).line,
      '1 working',
    );
    expect(
      swarmTeamGlance(swarm(agents: [agent('a1')]), now: now).line,
      'All idle',
    );
    expect(swarmTeamGlance(swarm(agents: []), now: now).line, 'No agents yet');
  });

  test('who needs a person comes first, then who is down, then the rest', () {
    final glance = swarmTeamGlance(
      swarm(
        agents: [
          agent('a-idle', displayName: 'Ana'),
          agent('a-work', displayName: 'Bo'),
          {
            ...agent('a-down', displayName: 'Cy'),
            'downSince': '2026-10-27T08:00:00Z',
          },
          agent('a-wait', displayName: 'Di'),
        ],
        groups: [
          working('a-work', 'working'),
          working('a-wait', 'needs_human'),
        ],
      ),
      now: now,
    );

    expect([for (final a in glance.agents) a.name], ['Di', 'Cy', 'Bo', 'Ana']);
  });

  test("an agent's task is the open work it holds", () {
    final glance = swarmTeamGlance(
      swarm(
        agents: [agent('a1')],
        groups: [
          {...working('a1', 'done'), 'id': 'old'},
          working('a1', 'working'),
        ],
      ),
      now: now,
    );

    expect(glance.agents.single.task?.id, 'work-a1');
  });

  group('in one project', () {
    test('only its agents: by their project, else by the work they are in', () {
      final glance = swarmTeamGlance(
        swarm(
          agents: [
            agent('mine'),
            {...agent('other'), 'projectId': 'project-2'},
            {...agent('placed'), 'projectId': null},
            {...agent('unplaced'), 'projectId': null},
          ],
          groups: [
            groupData('g1', agentIds: ['placed']),
          ],
        ),
        projectId: project,
        now: now,
      );

      expect({for (final a in glance.agents) a.agent.id}, {'mine', 'placed'});
    });

    test("an agent's project: the one it records, else the work it is in, "
        'as a worker or its Lead; none for neither', () {
      final snapshot = swarm(
        agents: [
          agent('mine'),
          {...agent('other'), 'projectId': 'project-2'},
          {...agent('worker'), 'projectId': null},
          {...agent('lead'), 'projectId': null},
          {...agent('unplaced'), 'projectId': null},
        ],
        groups: [
          {
            ...groupData('g2', agentIds: ['worker']),
            'projectId': 'project-2',
          },
          groupData('g1', leadId: 'lead'),
        ],
      );
      String? projectOf(String id) =>
          swarmAgentProject(snapshot, snapshot.agent(id)!);

      expect(projectOf('mine'), project);
      expect(projectOf('other'), 'project-2');
      expect(projectOf('worker'), 'project-2');
      expect(projectOf('lead'), project);
      expect(projectOf('unplaced'), isNull);
    });
  });

  group('once per Swarm read', () {
    SuperTabSnapshot team() => swarm(
      agents: [
        agent('mine', displayName: 'Ana'),
        {...agent('other', displayName: 'Bo'), 'projectId': 'project-2'},
      ],
      groups: [working('mine', 'needs_human')],
    );

    test('the same read and project give the same glance, not a new one', () {
      final snapshot = team();

      final first = swarmTeamGlance(snapshot, projectId: project, now: now);

      expect(
        swarmTeamGlance(snapshot, projectId: project, now: now),
        same(first),
      );
      expect(
        swarmTeamGlance(snapshot, now: now),
        same(swarmTeamGlance(snapshot, now: now)),
        reason: 'the whole Swarm is kept too',
      );
      expect(
        swarmTeamGlance(snapshot, now: now),
        isNot(same(first)),
        reason: 'each project keeps its own',
      );
    });

    test('a new read is counted again', () {
      final before = swarmTeamGlance(team(), projectId: project, now: now);
      final after = swarmTeamGlance(
        swarm(
          agents: [agent('mine', displayName: 'Ana')],
          groups: [working('mine', 'working')],
        ),
        projectId: project,
        now: now,
      );

      expect(before.line, '1 waiting');
      expect(after.line, '1 working');
    });

    test('a limit that runs out reads again, on the same read', () {
      final snapshot = swarm(
        agents: [
          {
            ...agent('a1', displayName: 'Ana'),
            'limitedUntil': DateTime(
              2026,
              10,
              27,
              9,
              5,
            ).toUtc().toIso8601String(),
          },
        ],
        groups: [working('a1', 'working')],
      );
      String labelAt(DateTime at) =>
          swarmTeamGlance(snapshot, now: at).agents.single.label;

      expect(labelAt(now), 'Limited until 09:05');
      expect(
        labelAt(now.add(const Duration(minutes: 4))),
        'Limited until 09:05',
      );
      expect(labelAt(DateTime(2026, 10, 27, 9, 5)), 'Working');
      expect(labelAt(now), 'Limited until 09:05', reason: 'asked for earlier');
    });
    test('a read after losing a project keeps nothing of it', () {
      final before = team();
      expect(
        swarmTeamGlance(before, projectId: 'project-2', now: now).agents,
        hasLength(1),
      );

      final after = swarm(
        agents: [agent('mine', displayName: 'Ana')],
        groups: [working('mine', 'needs_human')],
      );

      final glance = swarmTeamGlance(after, projectId: 'project-2', now: now);
      expect(glance.agents, isEmpty);
      expect(glance.line, 'No agents yet');
      expect(swarmTeamGlance(after, now: now).agents.map((a) => a.agent.id), [
        'mine',
      ]);
    });
  });
  // Ken, 10-29: a Buddy is a person's own helper, never one of the team. The
  // phone's Agents lists and their counts leave every Buddy out, the person's
  // own included (it shows only under Buddies).
  group('with three Buddies running', () {
    final buddies = [
      buddyData('agent-wren', displayName: 'Wren'),
      buddyData('agent-ivy', owner: 'person-dee', displayName: 'Ivy'),
      {
        ...buddyData('agent-oak', owner: 'person-kai', displayName: 'Oak'),
        'downSince': '2026-10-27T08:00:00Z',
      },
    ];
    final team = [
      agent('agent-lead', name: 'Lead', displayName: 'River'),
      agent('agent-ana', displayName: 'Ana'),
    ];

    Future<SuperTabSnapshot> read(List<Map<String, dynamic>> groups) async {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        agents: [...team, ...buddies],
        groups: [
          ...groups,
          buddyChatData('buddy-me', agentIds: ['agent-wren']),
          buddyChatData(
            'buddy-dee',
            owner: 'person-dee',
            agentIds: ['agent-ivy'],
          ),
          buddyChatData(
            'buddy-kai',
            owner: 'person-kai',
            agentIds: ['agent-oak'],
          ),
        ],
      );
      final r = SwarmReader(tabId: tab, accountId: me, request: fake.request);
      addTearDown(r.dispose);
      await r.refresh();
      return r.snapshot!;
    }

    test('the team and its counts leave every Buddy out', () async {
      final snapshot = await read([working('agent-ana', 'working')]);

      for (final glance in [
        swarmTeamGlance(snapshot, now: now),
        swarmTeamGlance(snapshot, projectId: project, now: now),
      ]) {
        expect(
          [for (final a in glance.agents) a.agent.id],
          ['agent-ana', 'agent-lead'],
        );
        expect(glance.line, '1 working', reason: "Oak's being down counts not");
      }
    });

    test('a Swarm read off the UI isolate leaves them out too', () async {
      final snapshot = await read([
        working('agent-ana', 'working'),
        for (var i = 0; i < swarmParseOffThreadParts; i++)
          groupData('g$i', title: 'Work $i'),
      ]);

      expect(
        [
          for (final a in swarmTeamGlance(snapshot, now: now).agents)
            a.agent.id,
        ],
        ['agent-ana', 'agent-lead'],
      );
    });
  });
}
