import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/task_history.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// ⌘B's recent prompts: newest first, said again moves to the top, kept across launches.
void main() {
  test('a prompt said again moves to the top, never twice', () async {
    final history = TaskHistory(null);
    await history.add('what is the d3 retention rate');
    await history.add('  also add tests  ');
    await history.add('what is the d3 retention rate');
    expect(history.recent, ['what is the d3 retention rate', 'also add tests']);
  });

  test(
    'keeps the newest twenty, and no empty or pasted-document prompts',
    () async {
      final history = TaskHistory(null);
      for (var i = 0; i < 25; i++) {
        await history.add('task $i');
      }
      await history.add('   ');
      await history.add('x' * (TaskHistory.maxChars + 1));
      expect(history.recent, hasLength(TaskHistory.keep));
      expect(history.recent.first, 'task 24');
      expect(history.recent.last, 'task 5');
    },
  );

  test('is there again after the app restarts', () async {
    final store = MemoryStore();
    await TaskHistory(store).add('plot signups by week');
    await TaskHistory(store).add('ship the retention chart');
    final reopened = TaskHistory(store);
    await reopened.load();
    expect(reopened.recent, [
      'ship the retention chart',
      'plot signups by week',
    ]);
  });

  test('an unreadable history is no history', () async {
    final store = MemoryStore();
    await store.write('task_box_recent_v1', '{not json');
    final history = TaskHistory(store);
    await history.load();
    expect(history.recent, isEmpty);
    await store.write('task_box_recent_v1', '{"a": 1}');
    final other = TaskHistory(store);
    await other.load();
    expect(other.recent, isEmpty);
  });
}
