import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/office_map.dart';
import 'package:harness/super_tabs/team_glance.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

final now = DateTime.utc(2026, 10, 27, 3);
String ago(Duration d) => now.subtract(d).toIso8601String();

Map<String, dynamic> agentRow(
  String id,
  String name, {
  String machine = 'm1',
}) => {
  'id': id,
  'name': name,
  'displayName': name,
  'machineId': machine,
  'harnessId': 'h-$id',
  'contributorId': 'owner',
  'configuration': <String, dynamic>{},
};

Map<String, dynamic> conv(
  String id,
  String title, {
  String projectId = 'lead',
  List<String> agents = const [],
  String? leadId,
  Map<String, dynamic>? work,
  Map<String, String>? recentPeople,
  bool private = false,
  bool archived = false,
}) => {
  ...conversationFixture(id, title),
  'projectId': projectId,
  'agentIds': agents,
  'leadId': leadId,
  'archived': archived,
  'assignment': ?work,
  'recentPeople': ?recentPeople,
  if (private)
    'audience': {
      'people': [
        {'id': 'owner', 'generation': 'tab'},
      ],
    },
};

SuperTabSnapshot snapshot(List<Map<String, dynamic>> groups) =>
    SuperTabSnapshot.fromJson({
      'version': 1,
      'id': 'tab',
      'name': 'Pilot',
      'ownerId': 'owner',
      'paused': false,
      'people': [
        {'id': 'owner', 'email': 'dee@example.com', 'role': 'owner'},
        {'id': 'peer', 'email': 'theo@example.com', 'role': 'collaborator'},
      ],
      'agents': [
        agentRow('pm', 'River'),
        agentRow('dev', 'Juno', machine: 'm2'),
        agentRow('rev', 'Ellis'),
      ],
      'invitations': <dynamic>[],
      'leadsConversationId': 'leads',
      'projects': [
        projectFixture('lead', 'Harness', 'lead'),
        projectFixture('web', 'Website', 'web-pm'),
      ],
      'conversations': [
        ...groups,
        {...conversationFixture('leads', 'Leads'), 'kind': 'leads'},
      ],
    });

List<SuperTabOfficeTable> map(
  List<Map<String, dynamic>> groups, {
  Map<String, SuperTabSeatState> states = const {},
}) => superTabOfficeMap(
  snapshot(groups),
  now: now,
  stateOf: (agent) => states[agent.id] ?? SuperTabSeatState.idle,
  machineOf: (agent) => agent.machineId == 'm2' ? 'Mac Studio' : 'MacBook',
);

void main() {
  group('office map tables', () {
    test(
      'a table for each conversation with work moving or a person in it lately',
      () {
        final tables = map([
          conv(
            'lead',
            'Harness',
            agents: ['pm'],
            leadId: 'pm',
            recentPeople: {'owner': ago(const Duration(minutes: 5))},
          ),
          conv(
            'g1',
            'Office map',
            agents: ['pm', 'dev'],
            leadId: 'pm',
            work: {'agentId': 'dev', 'status': 'working'},
          ),
          conv(
            'g2',
            'Finished',
            agents: ['dev'],
            work: {'agentId': 'dev', 'status': 'done'},
          ),
          conv(
            'g3',
            'Quiet chat',
            recentPeople: {'peer': ago(const Duration(hours: 3))},
          ),
          conv(
            'web-pm',
            'Website',
            projectId: 'web',
            agents: ['rev'],
            leadId: 'rev',
          ),
        ]);
        expect(tables.map((t) => (t.conversationId, t.title, t.projectName)), [
          ('lead', 'Harness', 'Harness'),
          ('g1', 'Office map', 'Harness'),
        ]);
      },
    );

    test('private chats, Chat with PM, the Product Managers and closed groups never get a table', () {
      final tables = map([
        conv(
          'chat',
          'Chat with PM',
          agents: ['pm'],
          private: true,
          recentPeople: {'owner': ago(Duration.zero)},
        ),
        conv(
          'old',
          'Archived',
          archived: true,
          work: {'agentId': 'dev', 'status': 'working'},
        ),
        {
          ...conv(
            'quiet',
            'Dormant',
            work: {'agentId': 'dev', 'status': 'working'},
          ),
          'dormant': true,
        },
      ]);
      expect(tables, isEmpty);
    });
  });

  group('office map seating', () {
    test('the Lead first, then the other agents, then the people who posted lately, newest first', () {
      final [table] = map(
        [
          conv(
            'g1',
            'Office map',
            agents: ['dev', 'pm', 'gone'],
            leadId: 'pm',
            work: {'agentId': 'dev', 'status': 'working'},
            recentPeople: {
              'peer': ago(const Duration(minutes: 1)),
              'owner': ago(const Duration(minutes: 30)),
              'left-swarm': ago(const Duration(minutes: 2)),
              'stale': ago(const Duration(hours: 2, minutes: 1)),
            },
          ),
        ],
        states: {'dev': SuperTabSeatState.working},
      );
      expect(
        table.seats.map((s) => (s.id, s.name, s.isAgent, s.state, s.machine)),
        [
          ('pm', 'River', true, SuperTabSeatState.idle, 'MacBook'),
          ('dev', 'Juno', true, SuperTabSeatState.working, 'Mac Studio'),
          ('peer', 'theo', false, null, null),
          ('owner', 'dee', false, null, null),
        ],
      );
    });
  });

  group('office map states', () {
    test('Team at a glance\'s state read in three words', () {
      const expected = {
        SuperTabAgentState.working: SuperTabSeatState.working,
        SuperTabAgentState.assigned: SuperTabSeatState.working,
        SuperTabAgentState.checking: SuperTabSeatState.working,
        SuperTabAgentState.starting: SuperTabSeatState.working,
        SuperTabAgentState.waiting: SuperTabSeatState.waiting,
        SuperTabAgentState.stuck: SuperTabSeatState.waiting,
        SuperTabAgentState.review: SuperTabSeatState.waiting,
        SuperTabAgentState.idle: SuperTabSeatState.idle,
        SuperTabAgentState.down: SuperTabSeatState.idle,
        SuperTabAgentState.lost: SuperTabSeatState.idle,
        SuperTabAgentState.limited: SuperTabSeatState.idle,
        SuperTabAgentState.paused: SuperTabSeatState.idle,
      };
      expect(expected.keys.toSet(), SuperTabAgentState.values.toSet());
      for (final MapEntry(:key, :value) in expected.entries) {
        expect(superTabSeatState(key), value, reason: key.name);
      }
    });
  });

  group('office view', () {
    testWidgets(
      'one click from the header opens the floor, and a table opens its conversation',
      (tester) async {
        final server = ConversationServer();
        final groups = (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>();
        server.state['agents'] = [agentRow('dev', 'Juno')];
        groups.firstWhere((g) => g['id'] == 'offline')
          ..['agentIds'] = ['dev']
          ..['assignment'] = {
            'id': 'w1',
            'agentId': 'dev',
            'status': 'working',
          };
        groups.firstWhere((g) => g['id'] == 'lead')['recentPeople'] = {
          'owner': DateTime.now()
              .subtract(const Duration(minutes: 3))
              .toIso8601String(),
        };
        groups.add({
          ...conv(
            'secret',
            'Chat with PM',
            work: {'id': 'w2', 'agentId': 'dev', 'status': 'working'},
          ),
          'audience': {
            'people': [
              {'id': 'owner'},
            ],
          },
        });
        final controller = server.controller();
        addTearDown(controller.dispose);
        await controller.refresh();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SuperTabView(
                controller: controller,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const ValueKey('super-office-open')));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('super-office-table-offline')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('super-office-table-lead')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('super-office-table-secret')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('super-office-dot-dev-working')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('super-office-table-lead')),
            matching: find.text('owner'),
          ),
          findsOneWidget,
        );

        await tester.tap(
          find.byKey(const ValueKey('super-office-table-offline')),
        );
        await tester.pumpAndSettle();
        expect(controller.selectedId, 'offline');
        expect(find.byKey(const ValueKey('super-office')), findsNothing);
      },
    );
  });
}
