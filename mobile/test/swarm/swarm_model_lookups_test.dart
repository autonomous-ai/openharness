import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';

import 'swarm_fixture.dart';

/// A Swarm read finds its chats, agents, projects and Product Managers by id,
/// and says so when one is not there.
void main() {
  const web = 'project-2';
  const webLead = 'group-lead-web';

  final snapshot = SuperTabSnapshot.fromJson(
    SuperTabParts.firstLoad(
      firstLoad(
        head: headData(
          projects: [
            {
              'id': project,
              'name': 'Mobile',
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
            },
            {
              'id': web,
              'name': 'Web',
              'ownerId': me,
              'leadConversationId': webLead,
              'visibility': 'public',
              'members': <Object>[],
            },
          ],
        ),
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', name: 'Builder'),
          {
            ...agent('agent-cleo', name: 'Lead', displayName: 'Cleo'),
            'projectId': web,
          },
        ],
        groups: [
          groupData('g1', title: 'Fix login', agentIds: ['agent-builder']),
          {
            ...groupData(
              webLead,
              title: 'Web',
              agentIds: ['agent-cleo'],
              leadId: 'agent-cleo',
            ),
            'projectId': web,
          },
        ],
      ),
    ).state,
  );

  test('a chat and an agent by id; none for an unknown id', () {
    expect(snapshot.conversation('g1')?.title, 'Fix login');
    expect(snapshot.conversation('nope'), isNull);
    expect(snapshot.agent('agent-builder')?.name, 'Builder');
    expect(snapshot.agent('nope'), isNull);
  });

  test(
    "an agent's name: its display name, else its name, else the fallback",
    () {
      expect(snapshot.agentName('agent-lead'), 'River');
      expect(snapshot.agentName('agent-builder'), 'Builder');
      expect(snapshot.agentName('nope'), 'Agent');
      expect(snapshot.agentName('nope', fallback: 'Gone'), 'Gone');
    },
  );

  test("a chat's project; none for an unknown chat", () {
    expect(snapshot.projectFor('g1')?.name, 'Mobile');
    expect(snapshot.projectFor(webLead)?.name, 'Web');
    expect(snapshot.projectFor('nope'), isNull);
  });

  test("each project's Product Manager, and no project for anyone else", () {
    expect(snapshot.leadProjectForAgent('agent-lead')?.id, project);
    expect(snapshot.leadProjectForAgent('agent-cleo')?.id, web);
    expect(snapshot.leadProjectForAgent('agent-builder'), isNull);
    expect(snapshot.isLead('agent-cleo'), isTrue);
    expect(snapshot.isLead('agent-builder'), isFalse);
    expect(
      snapshot.leadProtectionReason('agent-cleo'),
      'Cleo is the Product Manager of project Web. Delete the project first.',
    );
  });
}
