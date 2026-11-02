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
      ['s1', 's2'],
    );
  });
}
