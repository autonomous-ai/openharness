import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/task_history.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// ⌘B's recent prompts: newest first, said again moves to the top, kept across launches, and only ever
/// shown to the account that said them.
void main() {
  test('a prompt said again moves to the top, never twice', () async {
    final history = TaskHistory(null);
    await history.add('what is the d3 retention rate', account: 'u1');
    await history.add('  also add tests  ', account: 'u1');
    await history.add('what is the d3 retention rate', account: 'u1');
    expect(history.recentFor('u1'), [
      'what is the d3 retention rate',
      'also add tests',
    ]);
  });

  test(
    'keeps the newest twenty, and no empty or pasted-document prompts',
    () async {
      final history = TaskHistory(null);
      for (var i = 0; i < 25; i++) {
        await history.add('task $i', account: 'u1');
      }
      await history.add('   ', account: 'u1');
      await history.add('x' * (TaskHistory.maxChars + 1), account: 'u1');
      expect(history.recentFor('u1'), hasLength(TaskHistory.keep));
      expect(history.recentFor('u1').first, 'task 24');
      expect(history.recentFor('u1').last, 'task 5');
    },
  );

  test('is there again after the app restarts', () async {
    final store = MemoryStore();
    await TaskHistory(store).add('plot signups by week', account: 'u1');
    await TaskHistory(store).add('ship the retention chart', account: 'u1');
    final reopened = TaskHistory(store);
    await reopened.load();
    expect(reopened.recentFor('u1'), [
      'ship the retention chart',
      'plot signups by week',
    ]);
  });

  test(
    'another account on this computer sees none of them, and starts its own',
    () async {
      final store = MemoryStore();
      await TaskHistory(store).add('a private prompt', account: 'u1');
      final next = TaskHistory(store);
      await next.load();
      expect(next.recentFor('u2'), isEmpty);
      expect(next.recentFor(null), isEmpty);
      await next.add('hello from u2', account: 'u2');
      expect(next.recentFor('u2'), ['hello from u2']);
      expect(next.recentFor('u1'), isEmpty);
      expect(jsonDecode(store.values['task_box_recent_v1']!), {
        'owner': 'u2',
        'prompts': ['hello from u2'],
      });
    },
  );

  test('nothing is kept while no account is known', () async {
    final store = MemoryStore();
    await TaskHistory(store).add('who am i', account: null);
    expect(store.values, isEmpty);
  });

  test('an unreadable history is no history', () async {
    final store = MemoryStore();
    for (final raw in [
      '{not json',
      '["a list"]',
      '{"owner": 1, "prompts": []}',
    ]) {
      await store.write('task_box_recent_v1', raw);
      final history = TaskHistory(store);
      await history.load();
      expect(history.recentFor('u1'), isEmpty, reason: raw);
    }
  });
}
