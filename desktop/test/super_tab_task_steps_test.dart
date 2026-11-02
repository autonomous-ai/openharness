import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/task_steps.dart';

import 'support/super_tab_fixture.dart';

/// Task steps design: a task's chat shows its steps' rows by time.
void main() {
  SuperTabMessage row(
    String id,
    String conversationId,
    String at,
    int sequence,
  ) => SuperTabMessage.fromJson({
    'id': id,
    'conversationId': conversationId,
    'sequence': sequence,
    'text': id,
    'createdAt': at,
    'author': {'kind': 'agent', 'id': 'a', 'name': 'A'},
  });

  test("steps' rows merge into the task's by time", () {
    final merged = superTabMergeSteps(
      [
        row('t1', 'task', '2026-11-02T09:00:00Z', 1),
        row('t2', 'task', '2026-11-02T09:10:00Z', 2),
      ],
      {
        'review': [row('s1', 'review', '2026-11-02T09:05:00Z', 1)],
        'test': [row('u1', 'test', '2026-11-02T09:15:00Z', 1)],
      },
    );
    expect(merged.map((m) => m.id), ['t1', 's1', 't2', 'u1']);
  });

  test("a task without steps keeps its rows as they were", () {
    final rows = [
      row('t2', 'task', '2026-11-02T09:10:00Z', 2),
      row('t1', 'task', '2026-11-02T09:00:00Z', 1),
    ];
    expect(superTabMergeSteps(rows, const {}).map((m) => m.id), ['t2', 't1']);
  });

  test("a task's steps, by number, without archived ones or other tasks'", () {
    final server = ConversationServer();
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      {
        ...conversationFixture('s2', 'Test'),
        'number': 32,
        'reviewOf': 'offline',
        'step': 'Test',
      },
      {
        ...conversationFixture('s1', 'Review'),
        'number': 31,
        'reviewOf': 'offline',
        'step': 'Review',
      },
      {
        ...conversationFixture('s3', 'Gone'),
        'number': 33,
        'reviewOf': 'offline',
        'step': 'Gone',
        'archived': true,
      },
      {
        ...conversationFixture('old', 'Review PR'),
        'number': 20,
        'reviewOf': 'offline',
      },
    ]);
    final snapshot = SuperTabSnapshot.fromJson(server.state);
    expect(
      superTabStepsOf(
        snapshot,
        snapshot.conversation('offline')!,
      ).map((g) => g.id),
      // The unnamed linked 'old' (#20) is a step too, first by number.
      ['old', 's1', 's2'],
    );
  });

  // Final review, minor 6: an archived task's chat kept none of its finished
  // steps' rows, as they archive with it.
  test("an archived task keeps its archived steps", () {
    final server = ConversationServer();
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      {
        ...conversationFixture('s1', 'Review'),
        'number': 31,
        'reviewOf': 'offline',
        'step': 'Review',
        'archived': true,
      },
    ]);
    (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((g) => g['id'] == 'offline')['archived'] =
        true;
    final snapshot = SuperTabSnapshot.fromJson(server.state);
    expect(
      superTabStepsOf(
        snapshot,
        snapshot.conversation('offline')!,
      ).map((g) => g.id),
      ['s1'],
    );
  });

  // Final review, minor 8: a chat built again with nothing new is not sorted
  // again.
  test('a merge of unchanged rows is the same list', () {
    final task = [row('t1', 'task', '2026-11-02T09:00:00Z', 1)];
    final step = [row('s1', 'review', '2026-11-02T09:05:00Z', 1)];
    final merge = SuperTabStepsMerge();
    final first = merge.of(task, {'review': step});
    expect(identical(merge.of(task, {'review': step}), first), isTrue);
    final more = [...step, row('s2', 'review', '2026-11-02T09:06:00Z', 2)];
    expect(merge.of(task, {'review': more}).map((m) => m.id), [
      't1',
      's1',
      's2',
    ]);
  });

  test(
    "the controller's merged chat is the same list while nothing changed",
    () async {
      final server = ConversationServer();
      (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        {
          ...conversationFixture('s1', 'Review'),
          'number': 31,
          'reviewOf': 'offline',
          'step': 'Review',
        },
      ]);
      server.append('Task row', conversationId: 'offline');
      server.append('Step row', conversationId: 's1');
      final controller = server.controller();
      addTearDown(controller.dispose);
      await controller.refresh();
      controller.select('offline');
      await controller.loadMessages('offline');
      await controller.loadMessages('s1');
      final first = controller.taskMessages('offline');
      expect(first.map((m) => m.text), ['Task row', 'Step row']);
      expect(identical(controller.taskMessages('offline'), first), isTrue);
    },
  );
}
