import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/backlog.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/super_tab_fixture.dart';

/// Manage ▸ Backlog (Scholes, task #2355): every task of the Swarm the reader
/// can read, across projects, in the groups of its state.
void main() {
  const now = 1793700000000;

  SuperTabConversation task({
    Map<String, dynamic>? assignment,
    Map<String, dynamic>? liveness,
    int? shippedAt,
  }) => SuperTabConversation.fromJson({
    ...conversationFixture('work', 'A task'),
    'number': 7,
    'assignment': ?assignment,
    'liveness': ?liveness,
    'shippedAt': ?shippedAt,
  });

  Map<String, dynamic> working(String status) => {
    'id': 'a1',
    'agentId': 'kestrel',
    'status': status,
  };

  group('each state lands in its group', () {
    for (final (name, built, expected) in [
      ('no assignment', task(), SuperTabBacklogGroup.waitingForMachine),
      (
        'queued for a machine',
        task(
          assignment: working('planned'),
          liveness: {'state': 'waiting', 'why': 'queued', 'since': now},
        ),
        SuperTabBacklogGroup.waitingForMachine,
      ),
      (
        'its agent lost',
        task(assignment: working('lost')),
        SuperTabBacklogGroup.waitingForMachine,
      ),
      (
        'stopped',
        task(assignment: working('stopped')),
        SuperTabBacklogGroup.waitingForMachine,
      ),
      (
        'planned with an agent',
        task(assignment: working('planned')),
        SuperTabBacklogGroup.working,
      ),
      (
        'working',
        task(assignment: working('working')),
        SuperTabBacklogGroup.working,
      ),
      (
        'starting',
        task(
          assignment: working('working'),
          liveness: {'state': 'waiting', 'why': 'starting', 'since': now},
        ),
        SuperTabBacklogGroup.working,
      ),
      (
        'quiet',
        task(
          assignment: working('working'),
          liveness: {'state': 'quiet', 'since': now},
        ),
        SuperTabBacklogGroup.working,
      ),
      (
        'waiting on a person',
        task(
          assignment: working('working'),
          liveness: {
            'state': 'waiting',
            'why': 'person',
            'personId': 'scholes',
            'since': now,
          },
        ),
        SuperTabBacklogGroup.waitingOnSomeone,
      ),
      (
        'needs a person',
        task(assignment: working('needs_human')),
        SuperTabBacklogGroup.waitingOnSomeone,
      ),
      (
        'stuck',
        task(assignment: working('blocked')),
        SuperTabBacklogGroup.waitingOnSomeone,
      ),
      (
        'in review',
        task(assignment: working('review')),
        SuperTabBacklogGroup.inReview,
      ),
      (
        'fixing review findings',
        task(
          assignment: working('working'),
          liveness: {'state': 'waiting', 'why': 'revision', 'since': now},
        ),
        SuperTabBacklogGroup.inReview,
      ),
      (
        'done, not merged',
        task(assignment: working('done')),
        SuperTabBacklogGroup.readyToMerge,
      ),
      (
        'shipped',
        task(assignment: working('done'), shippedAt: now),
        SuperTabBacklogGroup.shipped,
      ),
      ('cancelled', task(assignment: working('cancelled')), null),
    ]) {
      test(name, () => expect(superTabBacklogGroupOf(built), expected));
    }
  });

  test('the groups read in order, as the mockup Scholes accepted', () {
    expect(SuperTabBacklogGroup.values.map((g) => g.label), [
      'Waiting for a machine',
      'Working',
      'Waiting on someone',
      'In review',
      'Ready to merge',
      'Shipped',
    ]);
  });

  test('lists every task across projects, newest first, and no project chat, '
      'Buddy chat, step or private chat', () async {
    final server = ConversationServer();
    server.state['projects'] = [
      projectFixture('lead', 'web-project', 'lead'),
      projectFixture('api', 'api', 'api-chat'),
    ];
    final conversations = server.state['conversations'] as List;
    (conversations[1] as Map)
      ..['projectId'] = 'lead'
      ..['number'] = 3;
    conversations.addAll(<Map<String, dynamic>>[
      {...conversationFixture('api-chat', 'api'), 'projectId': 'api'},
      {
        ...conversationFixture('api-task', 'Rate limits'),
        'projectId': 'api',
        'number': 9,
      },
      {
        ...conversationFixture('closed-task', 'Old fix'),
        'projectId': 'lead',
        'number': 1,
        'shippedAt': now,
      },
      {
        ...conversationFixture('review-step', 'Review: Rate limits'),
        'projectId': 'api',
        'number': 10,
        'reviewOf': 'api-task',
      },
      {
        ...conversationFixture('buddy', 'Wren'),
        'projectId': 'lead',
        'kind': 'buddy',
        'buddyOwnerId': 'owner',
      },
      {
        ...conversationFixture('private', 'Just us'),
        'projectId': 'lead',
        'audience': {
          'people': [
            {'id': 'owner'},
          ],
        },
      },
    ]);
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    expect(superTabBacklogTasks(c).map((t) => t.id), [
      'api-task',
      'offline',
      'closed-task',
    ]);
  });
}
