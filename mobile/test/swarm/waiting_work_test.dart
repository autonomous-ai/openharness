import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/waiting_work.dart';

import 'swarm_fixture.dart';

/// Work that waits on the reader: a worker needs a person or is stuck, in a
/// group whose partner is the reader, or with no partner in a project the
/// reader owns (Lead's ruling, 2026-10-27). Work named for someone else is
/// theirs alone.
void main() {
  /// What the reader would hold after a first load of [groups]: the Swarm, and its raw state.
  ({SuperTabSnapshot snapshot, Map<String, dynamic> state}) swarm(
    List<Map<String, dynamic>> groups, {
    String projectOwner = me,
  }) {
    final state = SuperTabParts.firstLoad(
      firstLoad(
        groups: groups,
        head: headData(
          projects: [
            {
              'id': project,
              'name': 'Mobile',
              'ownerId': projectOwner,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
            },
          ],
        ),
      ),
    ).state;
    return (snapshot: SuperTabSnapshot.fromJson(state), state: state);
  }

  List<SwarmWaitingWork> waitingIn(
    List<Map<String, dynamic>> groups, {
    String projectOwner = me,
  }) {
    final read = swarm(groups, projectOwner: projectOwner);
    return swarmWaitingWork(
      read.snapshot,
      me,
      partners: swarmPartners(read.state),
    );
  }

  test('needs-human and stuck work in my project wait on me', () {
    final waiting = waitingIn([
      groupData('g1', title: 'Login', status: 'needs_human'),
      groupData('g2', title: 'Sync', status: 'blocked'),
      groupData('g3', title: 'Docs', status: 'working'),
      groupData('g4', title: 'Icons', status: 'done'),
      groupData('g5', title: 'Chat'),
    ]);

    expect([for (final w in waiting) w.conversation.title], ['Login', 'Sync']);
    expect(waiting.first.status, 'needs_human');
    expect(waiting.first.agentName, 'Nova');
    expect(waiting.first.project.name, 'Mobile');
  });

  test("another person's project waits on them, not me", () {
    final waiting = waitingIn([
      groupData('g1', status: 'needs_human'),
    ], projectOwner: 'person-other');

    expect(waiting, isEmpty);
  });

  test("work whose partner is someone else is theirs alone", () {
    final partnered = {
      ...groupData('g1', status: 'needs_human'),
      'partnerId': 'person-other',
    };

    expect(waitingIn([partnered]), isEmpty);
  });

  test("work whose partner is me waits on me, in anyone's project", () {
    final partnered = {...groupData('g1', status: 'blocked'), 'partnerId': me};

    expect(
      waitingIn([
        partnered,
      ], projectOwner: 'person-other').single.conversation.id,
      'g1',
    );
  });

  test('its question is what the worker wrote', () {
    final row = {
      ...groupData('g1', status: 'needs_human'),
      'assignment': {
        'id': 'attempt-g1',
        'agentId': 'agent-builder',
        'status': 'needs_human',
        'result': 'Keep the old screen?',
      },
    };

    expect(waitingIn([row]).single.question, 'Keep the old screen?');
  });

  group('once per Swarm read', () {
    test('the same read, reader and partners give the same list', () {
      final read = swarm([groupData('g1', status: 'needs_human')]);
      final partners = swarmPartners(read.state);

      final first = swarmWaitingWork(read.snapshot, me, partners: partners);

      expect(first, hasLength(1));
      expect(
        swarmWaitingWork(read.snapshot, me, partners: partners),
        same(first),
      );
    });

    test('a new read, another reader or new partners count again', () {
      final read = swarm([groupData('g1', status: 'needs_human')]);
      final partners = swarmPartners(read.state);
      final first = swarmWaitingWork(read.snapshot, me, partners: partners);

      expect(
        swarmWaitingWork(read.snapshot, 'person-other', partners: partners),
        isEmpty,
      );
      expect(
        swarmWaitingWork(read.snapshot, me, partners: {'g1': 'person-other'}),
        isEmpty,
      );
      expect(
        swarmWaitingWork(
          swarm([groupData('g1', status: 'working')]).snapshot,
          me,
          partners: partners,
        ),
        isEmpty,
      );
      expect(
        [
          for (final w in swarmWaitingWork(
            read.snapshot,
            me,
            partners: partners,
          ))
            w.conversation.id,
        ],
        [for (final w in first) w.conversation.id],
        reason: 'back to the first: still right',
      );
    });

    test('the list cannot be changed by a caller', () {
      final read = swarm([groupData('g1', status: 'needs_human')]);

      expect(
        () => swarmWaitingWork(read.snapshot, me).clear(),
        throwsUnsupportedError,
      );
    });
    test('a read after losing access, or another person signed in, keeps '
        'nothing from before', () {
      final read = swarm([groupData('g1', status: 'needs_human')]);
      final partners = swarmPartners(read.state);
      expect(
        swarmWaitingWork(read.snapshot, me, partners: partners),
        hasLength(1),
      );

      final after = swarm([groupData('g2', status: 'working')]);
      expect(
        swarmWaitingWork(
          after.snapshot,
          me,
          partners: swarmPartners(after.state),
        ),
        isEmpty,
        reason: 'g1 is no longer in the read',
      );
      expect(
        swarmWaitingWork(read.snapshot, 'person-other', partners: partners),
        isEmpty,
        reason: 'signed out, then someone else on the same read',
      );
    });
  });
}
