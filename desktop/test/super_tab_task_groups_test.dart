import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/task_groups.dart';

import 'support/super_tab_fixture.dart';

/// A project's open tasks in the sidebar, in four foldable groups (Huy, #2309): Needs you, Working, Waiting on
/// others, The rest.
void main() {
  SuperTabConversation task({
    String? status,
    Map<String, dynamic>? liveness,
  }) => SuperTabConversation.fromJson({
    ...conversationFixture('t', 'Task'),
    if (status != null)
      'assignment': {'agentId': 'a1', 'status': status, 'progressAt': 1},
    'liveness': ?liveness,
  });
  Map<String, dynamic> waiting(String why, {String? personId}) => {
    'state': 'waiting',
    'why': why,
    'since': 1,
    'personId': ?personId,
  };

  group('which group a task is in', () {
    SuperTabTaskGroup of(
      SuperTabConversation g, {
      int mentions = 0,
      int needsHuman = 0,
    }) => superTabTaskGroupOf(
      g,
      readerId: 'me',
      mentions: mentions,
      needsHuman: needsHuman,
    );

    test('the groups read in the sidebar\'s order, The rest folded', () {
      expect(SuperTabTaskGroup.values.map((g) => g.label), [
        'Needs you',
        'Working',
        'Waiting on others',
        'The rest',
      ]);
      expect(
        SuperTabTaskGroup.values.where((g) => g.foldedByDefault),
        [SuperTabTaskGroup.rest],
      );
    });

    test('a task that tags the reader needs them, whatever else it waits on', () {
      expect(of(task(), mentions: 1), SuperTabTaskGroup.needsYou);
      expect(
        of(
          task(status: 'needs_human', liveness: waiting('person', personId: 'other')),
          mentions: 2,
        ),
        SuperTabTaskGroup.needsYou,
      );
    });

    test('a wait on the reader, or on no one named, needs them', () {
      expect(
        of(task(status: 'needs_human', liveness: waiting('person', personId: 'me'))),
        SuperTabTaskGroup.needsYou,
      );
      expect(
        of(task(status: 'needs_human', liveness: waiting('person'))),
        SuperTabTaskGroup.needsYou,
      );
    });

    test('a question in a working task\'s terminal needs the reader', () {
      expect(of(task(status: 'working'), needsHuman: 1), SuperTabTaskGroup.needsYou);
    });

    test('a wait on another person, a review, a revision, a block or a machine waits on others', () {
      for (final g in [
        task(status: 'needs_human', liveness: waiting('person', personId: 'other')),
        task(status: 'review', liveness: waiting('review')),
        task(status: 'working', liveness: waiting('revision')),
        task(status: 'blocked', liveness: waiting('blocked')),
        task(status: 'working', liveness: waiting('queued')),
      ]) {
        expect(of(g, needsHuman: 1), SuperTabTaskGroup.waitingOnOthers, reason: '${g.liveness}');
      }
    });

    test('a stuck task waits on others: the PM hands it on', () {
      expect(
        of(task(status: 'working', liveness: {'state': 'quiet', 'since': 1})),
        SuperTabTaskGroup.waitingOnOthers,
      );
      expect(
        of(task(status: 'working', liveness: {'state': 'orphaned', 'why': 'lost', 'since': 1})),
        SuperTabTaskGroup.waitingOnOthers,
      );
    });

    test('a task moving or starting its agent is working', () {
      expect(of(task(status: 'working')), SuperTabTaskGroup.working);
      expect(of(task(status: 'planned')), SuperTabTaskGroup.working);
      expect(
        of(task(status: 'working', liveness: waiting('starting'))),
        SuperTabTaskGroup.working,
      );
    });

    test('anything else is the rest', () {
      expect(of(task()), SuperTabTaskGroup.rest);
      expect(of(task(status: 'done')), SuperTabTaskGroup.rest);
      expect(of(task(status: 'stopped')), SuperTabTaskGroup.rest);
      expect(
        of(task(status: 'working', liveness: {'state': 'unheard-of', 'since': 1})),
        SuperTabTaskGroup.rest,
      );
    });
  });
}
