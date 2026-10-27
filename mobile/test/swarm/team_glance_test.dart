import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
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
  });
}
