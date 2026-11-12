import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_team.dart';

import 'swarm_fixture.dart';

/// Your Team as Desktop's left pane reads it (Swarm v4): the reader's own
/// agents, A to Z, each with where it runs, folded past eight rows.
void main() {
  SuperTabSnapshot read({
    required List<Map<String, dynamic>> agents,
    List<Map<String, dynamic>> machines = const [],
    List<Map<String, dynamic>> groups = const [],
  }) => SuperTabSnapshot.fromJson(
    SuperTabParts.firstLoad(
      firstLoad(agents: agents, machines: machines, groups: groups),
    ).state,
  );

  Map<String, dynamic> theirs(Map<String, dynamic> agent) => {
    ...agent,
    'contributorId': 'person-other',
  };

  group('swarmMyAgents', () {
    test("the reader's agents only, A to Z by the name they show, any "
        'case', () {
      final snapshot = read(
        agents: [
          agent('a-zed', displayName: 'zed'),
          theirs(agent('a-them', displayName: 'Aaron')),
          agent('a-bea', name: 'Bea'),
          agent('a-ada', displayName: 'Ada'),
        ],
      );
      expect(
        [for (final a in swarmMyAgents(snapshot, me)) a.id],
        ['a-ada', 'a-bea', 'a-zed'],
      );
    });

    test("the backend's myAgent wins over whose agent it is", () {
      final snapshot = read(
        agents: [
          {...agent('a-mine', displayName: 'Mine'), 'myAgent': false},
          {...theirs(agent('a-lent', displayName: 'Lent')), 'myAgent': true},
        ],
      );
      expect([for (final a in swarmMyAgents(snapshot, me)) a.id], ['a-lent']);
    });

    test('none when the reader brought none', () {
      final snapshot = read(agents: [theirs(agent('a-them'))]);
      expect(swarmMyAgents(snapshot, me), isEmpty);
    });
  });

  test("swarmAgentIsPm: the backend's kind when it sends one, else whether "
      'it leads a project', () {
    final snapshot = read(
      agents: [
        agent('agent-lead', name: 'Lead'),
        {...agent('a-pm'), 'kind': 'pm'},
        {...agent('agent-builder'), 'kind': 'agent'},
        agent('a-dev'),
      ],
    );
    bool pm(String id) => swarmAgentIsPm(snapshot, snapshot.agent(id)!);
    expect(pm('agent-lead'), isTrue, reason: "it leads the fixture's project");
    expect(pm('a-pm'), isTrue);
    expect(pm('agent-builder'), isFalse);
    expect(pm('a-dev'), isFalse);
  });

  test("swarmAgentChat: the agent's own chat while the Swarm lists it", () {
    final snapshot = read(
      agents: [
        {...agent('a-1'), 'chatId': 'chat-1'},
        {...agent('a-2'), 'chatId': 'chat-gone'},
        agent('a-3'),
      ],
      groups: [
        groupData('chat-1', kind: 'agent-chat', agentIds: ['a-1']),
      ],
    );
    SuperTabConversation? chat(String id) =>
        swarmAgentChat(snapshot, snapshot.agent(id)!);
    expect(chat('a-1')?.id, 'chat-1');
    expect(chat('a-2'), isNull);
    expect(chat('a-3'), isNull);
  });

  group('swarmEngineName', () {
    SuperTabAgent withEngine(String engine) => SuperTabAgent.fromJson({
      ...agent('a-1'),
      'configuration': {'engine': engine},
    });

    test('Claude Code for claude, as Desktop says it', () {
      expect(swarmEngineName(withEngine('claude')), 'Claude Code');
    });

    test("any other engine by its identity's label", () {
      expect(swarmEngineName(withEngine('codex')), 'Codex');
    });

    test('none for an agent naming no engine', () {
      expect(swarmEngineName(withEngine('  ')), isNull);
      expect(
        swarmEngineName(
          SuperTabAgent.fromJson({...agent('a-1'), 'configuration': {}}),
        ),
        isNull,
      );
    });
  });

  group('swarmAgentWhere', () {
    test('its machine, then its engine', () {
      final snapshot = read(
        agents: [agent('a-1', machineId: 'mac-1')],
        machines: [
          {'machineId': 'mac-1', 'name': ' Mac Studio '},
        ],
      );
      expect(swarmAgentWhere(snapshot, snapshot.agent('a-1')!), (
        machine: 'Mac Studio',
        engine: 'Claude Code',
      ));
    });

    test('its engine alone on a machine the Swarm does not name', () {
      final snapshot = read(
        agents: [agent('a-1', machineId: 'mac-gone')],
        machines: [
          {'machineId': 'mac-2', 'name': ''},
        ],
      );
      expect(swarmAgentWhere(snapshot, snapshot.agent('a-1')!), (
        machine: null,
        engine: 'Claude Code',
      ));
    });

    test('its machine alone for an agent naming no engine', () {
      final snapshot = read(
        agents: [
          {...agent('a-1', machineId: 'mac-1'), 'configuration': {}},
        ],
        machines: [
          {'machineId': 'mac-1', 'name': 'Mac Studio'},
        ],
      );
      expect(swarmAgentWhere(snapshot, snapshot.agent('a-1')!), (
        machine: 'Mac Studio',
        engine: null,
      ));
    });

    test('nothing when it names neither', () {
      final snapshot = read(
        agents: [
          {...agent('a-1', machineId: 'mac-1'), 'configuration': {}},
        ],
        machines: [
          {'machineId': 'mac-1', 'name': '   '},
        ],
      );
      expect(swarmAgentWhere(snapshot, snapshot.agent('a-1')!), isNull);
    });
  });

  group('swarmTeamRows', () {
    /// [count] agents, those at [unread] with something new.
    List<SwarmTeamMember> team(int count, {Set<int> unread = const {}}) => [
      for (var i = 0; i < count; i++)
        (
          agent: SuperTabAgent.fromJson(agent('a-$i')),
          chat: null,
          unread: unread.contains(i),
        ),
    ];

    test('every row when one more than eight would show', () {
      final rows = swarmTeamRows(team(9), open: false);
      expect(rows.shown, List.generate(9, (i) => i));
      expect(rows.hidden, 0);
      expect(rows.hiddenUnread, isFalse);
    });

    test('eight rows past that, the rest under N more', () {
      final rows = swarmTeamRows(team(12), open: false);
      expect(rows.shown, List.generate(8, (i) => i));
      expect(rows.hidden, 4);
      expect(rows.hiddenUnread, isFalse);
    });

    test('those with something new shown first, each in its place', () {
      final rows = swarmTeamRows(team(12, unread: {10, 11}), open: false);
      expect(rows.shown, [0, 1, 2, 3, 4, 5, 10, 11]);
      expect(rows.hidden, 4);
      expect(rows.hiddenUnread, isFalse);
    });

    test('a folded row with something new says so on N more', () {
      final rows = swarmTeamRows(
        team(12, unread: {for (var i = 2; i < 11; i++) i}),
        open: false,
      );
      expect(rows.shown, [2, 3, 4, 5, 6, 7, 8, 9]);
      expect(rows.hiddenUnread, isTrue);
    });

    test('opened, every row', () {
      final rows = swarmTeamRows(team(12, unread: {11}), open: true);
      expect(rows.shown, List.generate(12, (i) => i));
      expect(rows.hidden, 0);
      expect(rows.hiddenUnread, isFalse);
    });
  });
}
