import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

Map<String, dynamic> _agent(String id, [Map<String, dynamic>? extra]) => {
  'id': id,
  'projectId': 'p1',
  'name': id,
  'machineId': 'm1',
  'harnessId': 'h-$id',
  'contributorId': 'u1',
  'configuration': <String, dynamic>{},
  ...?extra,
};

SuperTabSnapshot _swarm({
  List<Map<String, dynamic>> agents = const [],
  Map<String, dynamic>? project,
}) => SuperTabSnapshot.fromJson({
  'version': 1,
  'id': 'tab1',
  'name': 'Swarm',
  'ownerId': 'u1',
  'people': <Object>[],
  'agents': agents,
  'conversations': [
    {
      'id': 'c1',
      'projectId': 'p1',
      'title': 'Lamp',
      'brief': '',
      'leadId': 'lead',
      'agentIds': ['lead'],
      'status': 'active',
      'createdBy': 'u1',
      'createdAt': '2026-10-30T00:00:00Z',
    },
  ],
  'invitations': <Object>[],
  'projects': [
    {
      'id': 'p1',
      'name': 'Lamp',
      'ownerId': 'u1',
      'leadConversationId': 'c1',
      ...?project,
    },
  ],
});

void main() {
  test('names an agent by its role and the coordinator by its project', () {
    final swarm = _swarm(
      agents: [
        _agent('tester', {'roleName': 'Tester'}),
        _agent('qa', {'roleName': 'Quality assurance lead'}),
        _agent('exact', {'roleName': 'Twelve chars'}),
        _agent('lead', {'roleName': 'PM'}),
        _agent('buddy', {
          'buddyOf': {'personId': 'u1'},
        }),
      ],
      project: {'coordinatorName': 'Coordinator'},
    );
    expect(swarm.roleOf('tester'), (name: 'Tester', badge: 'Tester'));
    expect(swarm.roleOf('qa'), (
      name: 'Quality assurance lead',
      badge: 'Quality ass…',
    ));
    expect(swarm.roleOf('exact')?.badge, 'Twelve chars');
    expect(swarm.roleOf('lead'), (name: 'PM', badge: 'PM'));
    expect(swarm.roleOf('buddy'), isNull);
    expect(swarm.roleOf('nobody'), isNull);
    expect(swarm.coordinatorNameOf('p1'), 'Coordinator');
    expect(swarm.coordinatorNameOf('elsewhere'), kDefaultCoordinatorName);
    expect(
      swarm.leadProtectionReason('lead'),
      'lead is the Coordinator of project Lamp. Delete the project first.',
    );

    // A backend from before project instructions: today's three pairs.
    final older = _swarm(
      agents: [
        _agent('lead'),
        _agent('rev', {'role': 'reviewer'}),
        _agent('dev'),
      ],
    );
    expect(older.roleOf('lead'), (name: 'Product Manager', badge: 'PM'));
    expect(older.roleOf('rev'), (name: 'Reviewer', badge: 'Rev'));
    expect(older.roleOf('dev'), (name: 'Engineer', badge: 'Dev'));
    expect(older.coordinatorNameOf('p1'), 'Product Manager');
    expect(
      older.leadProtectionReason('lead'),
      'lead is the Product Manager of project Lamp. Delete the project first.',
    );
  });

  testWidgets(
    'an empty project chat names its coordinator as the project does',
    (tester) async {
      for (final (coordinator, line) in [
        (null, 'Discuss the plan with Product Manager.'),
        ('Coordinator', 'Discuss the plan with Coordinator.'),
      ]) {
        final server = ConversationServer();
        server.state['projects'] = [
          {
            ...projectFixture('lead', 'web-project', 'lead'),
            'coordinatorName': ?coordinator,
          },
        ];
        final c = server.controller();
        await c.refresh();
        await c.select('lead');
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Team Mac',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text(line), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      }
    },
  );

  test('a badge is the name, or its first 11 characters and an ellipsis', () {
    expect(superTabRoleBadge('Tester'), 'Tester');
    expect(superTabRoleBadge('Twelve chars'), 'Twelve chars');
    expect(superTabRoleBadge('Thirteen char'), 'Thirteen ch…');
    // Never cuts a character in half.
    expect(superTabRoleBadge('Designer 🎨🎨🎨🎨'), 'Designer 🎨🎨…');
  });
}
