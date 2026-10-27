import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_pm_chat.dart';
import 'package:harness_mobile/swarm/team_glance.dart';
import 'package:harness_mobile/swarm/waiting_work.dart';

import 'swarm_fixture.dart';

/// The last Home kept on the phone, so a cold start draws it at once: only
/// what Home draws, encrypted under a key in the Keychain, and gone with the
/// account, the Swarm switch, or the person's access.
void main() {
  /// A Swarm whose work g1 waits on the person, with everything Home does
  /// not draw filled in: a brief, checks, a question, emails.
  ({SuperTabSnapshot snapshot, Map<String, String> partners}) read() {
    final load = firstLoad(
      groups: [
        {
          ...groupData(
            'g1',
            title: 'Rotate the keys',
            number: 4,
            agentIds: ['agent-builder'],
          ),
          'brief': 'The secret plan',
          'checks': [
            {'id': 'c1', 'description': 'Keys rotated in prod'},
          ],
          'assignment': {
            'id': 'attempt-g1',
            'agentId': 'agent-builder',
            'status': 'needs_human',
            'result': 'Which vault holds the old key?',
          },
          'partnerId': me,
          'lastMessageSequence': 12,
        },
      ],
    );
    final state = SuperTabParts.firstLoad(load).state;
    return (
      snapshot: SuperTabSnapshot.fromJson(state),
      partners: swarmPartners(state),
    );
  }

  group('the view kept', () {
    test('draws Home as the Swarm did', () {
      final (:snapshot, :partners) = read();

      final kept = swarmHomeSwarm(snapshot, partners);
      final back = SuperTabSnapshot.fromJson(kept.state);

      expect(back.name, snapshot.name);
      expect([for (final p in back.projects) p.name], ['Mobile']);
      final project = back.projects.single;
      expect(swarmPmName(back, project), 'River');
      expect(
        swarmTeamGlance(back, projectId: project.id).line,
        swarmTeamGlance(snapshot, projectId: project.id).line,
      );
      final waiting = swarmWaitingWork(back, me, partners: kept.partners);
      expect(
        [for (final w in waiting) w.conversation.label],
        ['#4 Rotate the keys'],
      );
      expect(waiting.single.status, 'needs_human');
      expect(waiting.single.agentName, 'Nova');
    });

    test('keeps nothing Home does not draw', () {
      final (:snapshot, :partners) = read();

      final text = jsonEncode(swarmHomeSwarm(snapshot, partners).state);

      expect(text, isNot(contains('The secret plan')));
      expect(text, isNot(contains('Keys rotated')));
      expect(text, isNot(contains('Which vault')));
      expect(text, isNot(contains('@example.com')));
      final back = SuperTabSnapshot.fromJson(
        swarmHomeSwarm(snapshot, partners).state,
      );
      expect(back.decisionsWaiting, 0);
      expect(back.mentionsWaiting, 0);
      expect(back.conversation('g1')!.lastMessageSequence, 0);
    });
  });
}
