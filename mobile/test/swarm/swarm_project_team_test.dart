import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_project_team.dart';

import 'swarm_fixture.dart';

/// A project's Team, as Swarm Home C lists it (Dee's rules, 2026-10-29):
/// every agent in one of seven states, the most urgent first, and no ranks.
void main() {
  final now = DateTime(2026, 10, 30, 9);

  SuperTabSnapshot swarm({
    required List<Map<String, dynamic>> agents,
    List<Map<String, dynamic>> groups = const [],
    Map<String, dynamic> derived = const {},
  }) => SuperTabSnapshot.fromJson(
    SuperTabParts.firstLoad(
      firstLoad(agents: agents, groups: groups, derived: derived),
    ).state,
  );

  Map<String, dynamic> work(String agentId, String status, {int? number}) =>
      groupData(
        'work-$agentId',
        title: 'Task of $agentId',
        number: number,
        agentIds: [agentId],
        status: status,
        workerId: agentId,
      );

  SwarmTeamAgent of(List<SwarmTeamAgent> team, String agentId) =>
      team.singleWhere((a) => a.agent.id == agentId);

  group('each agent', () {
    test('is in one of seven states, in words', () {
      final team = swarmProjectAgents(
        swarm(
          agents: [
            agent('a-input', displayName: 'Ana'),
            agent('a-stuck', displayName: 'Bo'),
            agent('a-review', displayName: 'Cy'),
            {
              ...agent('a-limit', displayName: 'Di'),
              'limitedUntil': DateTime(
                2026,
                10,
                30,
                9,
                5,
              ).toUtc().toIso8601String(),
            },
            {
              ...agent('a-down', displayName: 'Ed'),
              'downSince': '2026-10-30T01:00:00Z',
            },
            agent('a-lost', displayName: 'Fy'),
            agent('a-work', displayName: 'Gu'),
            agent('a-check', displayName: 'Hu'),
            {...agent('a-done', displayName: 'Io'), 'workDecision': 'awaiting'},
            {...agent('a-kept', displayName: 'Jo'), 'workDecision': 'keep'},
            agent('a-idle', displayName: 'Ky'),
            {...agent('a-stop', displayName: 'Lu'), 'workDecision': 'stop'},
          ],
          groups: [
            work('a-input', 'needs_human'),
            work('a-stuck', 'blocked'),
            work('a-review', 'review'),
            work('a-lost', 'lost'),
            work('a-work', 'working'),
            work('a-check', 'reconciling'),
          ],
        ),
        project,
        now: now,
      );

      String said(String id) =>
          '${of(team, id).state.name}: '
          '${of(team, id).label}';
      expect(said('a-input'), 'needsInput: Needs input');
      expect(said('a-stuck'), 'needsInput: Stuck');
      expect(said('a-review'), 'waiting: Waiting for review');
      expect(said('a-limit'), 'waiting: Limited until 09:05');
      expect(said('a-down'), 'offline: Offline');
      expect(said('a-lost'), 'offline: Offline');
      expect(said('a-work'), 'working: Working');
      expect(said('a-check'), 'working: Checking');
      expect(said('a-done'), 'done: Done');
      expect(said('a-kept'), 'idle: Idle');
      expect(said('a-idle'), 'idle: Idle');
      expect(said('a-stop'), 'stopped: Stopped');
    });

    test('the Swarm saying it finished, after it was read idle, is Done', () {
      final team = swarmProjectAgents(
        swarm(
          agents: [agent('a1', displayName: 'Ana')],
          derived: {
            'agents': {
              'a1': {
                'downSince': null,
                'limitedUntil': null,
                'workDecision': 'awaiting',
                'roleId': null,
              },
            },
          },
        ),
        project,
        now: now,
      );

      expect(of(team, 'a1').state, SwarmMemberState.done);
    });

    test('being stopped outranks the work it still holds; offline outranks '
        'being stopped', () {
      final team = swarmProjectAgents(
        swarm(
          agents: [
            {...agent('a1', displayName: 'Ana'), 'workDecision': 'stop'},
            {
              ...agent('a2', displayName: 'Bo'),
              'workDecision': 'stop',
              'downSince': '2026-10-30T01:00:00Z',
            },
          ],
          groups: [work('a1', 'working')],
        ),
        project,
        now: now,
      );

      expect(of(team, 'a1').state, SwarmMemberState.stopped);
      expect(of(team, 'a2').state, SwarmMemberState.offline);
    });

    test('holds its open task, said after its state', () {
      final team = swarmProjectAgents(
        swarm(
          agents: [
            agent('a1', displayName: 'Ana'),
            agent('a2'),
          ],
          groups: [work('a1', 'working', number: 2156)],
        ),
        project,
        now: now,
      );

      expect(of(team, 'a1').line, 'Working · #2156 Task of a1');
      expect(of(team, 'a2').line, 'Idle');
    });
  });

  group('the list', () {
    test('is the most urgent first, then by name, with no ranks', () {
      final team = swarmProjectAgents(
        swarm(
          agents: [
            {...agent('a-stop', displayName: 'Ash'), 'workDecision': 'stop'},
            agent('a-idle', displayName: 'bea'),
            {
              ...agent('a-done', displayName: 'Cal'),
              'workDecision': 'awaiting',
            },
            agent('a-work2', displayName: 'Wren'),
            agent('a-work1', displayName: 'moss'),
            {
              ...agent('a-off', displayName: 'Dot'),
              'downSince': '2026-10-30T01:00:00Z',
            },
            agent('a-wait', displayName: 'Juno'),
            agent('a-input', displayName: 'Zed'),
          ],
          groups: [
            work('a-work1', 'working'),
            work('a-work2', 'working'),
            work('a-wait', 'review'),
            work('a-input', 'needs_human'),
          ],
        ),
        project,
        now: now,
      );

      expect(
        [for (final a in team) a.name],
        ['Zed', 'Juno', 'Dot', 'moss', 'Wren', 'Cal', 'bea', 'Ash'],
        reason: 'letter case aside within a state',
      );
    });

    test("lists only this project's agents, never a Buddy, and matches by "
        'id though another project has an agent of the same name', () {
      final team = swarmProjectAgents(
        swarm(
          agents: [
            agent('a-nova', displayName: 'Nova'),
            {...agent('b-nova', displayName: 'Nova'), 'projectId': 'project-2'},
            buddyData('buddy-me'),
          ],
          groups: [
            {...work('b-nova', 'needs_human'), 'projectId': 'project-2'},
          ],
        ),
        project,
        now: now,
      );

      expect([for (final a in team) a.agent.id], ['a-nova']);
      expect(
        of(team, 'a-nova').state,
        SwarmMemberState.idle,
        reason: "the other Nova's work is not this one's",
      );
    });

    test('names none of the work an agent still holds in another project, '
        'and keeps its state', () {
      final team = swarmProjectAgents(
        swarm(
          agents: [agent('a-ash', displayName: 'Ash')],
          groups: [
            {
              ...work('a-ash', 'working', number: 3001),
              'projectId': 'project-2',
            },
          ],
        ),
        project,
        now: now,
      );

      expect(of(team, 'a-ash').state, SwarmMemberState.working);
      expect(of(team, 'a-ash').task, isNull);
      expect(of(team, 'a-ash').line, 'Working');
    });

    test('counts what needs attention, in the order it is listed', () {
      final team = swarmProjectAgents(
        swarm(
          agents: [
            agent('a1'),
            agent('a2'),
            agent('a3'),
            agent('a4'),
            {...agent('a5'), 'workDecision': 'stop'},
            agent('a6'),
          ],
          groups: [
            work('a1', 'working'),
            work('a2', 'working'),
            work('a3', 'review'),
            work('a4', 'needs_human'),
          ],
        ),
        project,
        now: now,
      );

      expect(
        swarmTeamAgentsLine(team),
        '1 needs input · 1 waiting · 2 working',
      );
      expect(swarmTeamAgentsLine(const []), '');
    });
  });
}
