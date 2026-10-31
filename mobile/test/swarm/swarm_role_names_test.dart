import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';

/// The phone names agents as Desktop does (desktop/test/super_tab_role_names_test.dart): by the role the project's
/// document gives them, and the coordinator by what its project calls it.
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

  test('a badge is the name, or its first 11 characters and an ellipsis', () {
    expect(superTabRoleBadge('Tester'), 'Tester');
    expect(superTabRoleBadge('Twelve chars'), 'Twelve chars');
    expect(superTabRoleBadge('Thirteen char'), 'Thirteen ch…');
    // Never cuts a character in half.
    expect(superTabRoleBadge('Designer 🎨🎨🎨🎨'), 'Designer 🎨🎨…');
  });
}
