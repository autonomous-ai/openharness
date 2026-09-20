import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/state/workspace_learning.dart';

class LearningMemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  Completer<String?>? pending;
  @override
  Future<String?> read(String key) async =>
      pending == null ? values[key] : pending!.future;
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

void main() {
  test(
    'quick start follows work, resumes after restart, and stays dismissed',
    () async {
      final store = LearningMemoryStore();
      final first = WorkspaceLearning(storage: store);
      addTearDown(first.dispose);
      await first.load();
      expect(first.offer, isTrue);
      first.observe(agents: 2, zoomed: true);
      expect(first.completed, isEmpty, reason: 'The guide is opt-in');
      first.start();
      first.observe(agents: 0, zoomed: false);
      first.commandSearchOpened();
      expect(first.next, WorkspaceLesson.agent);
      first.observe(agents: 1, zoomed: false);
      expect(first.next, WorkspaceLesson.pane);
      first.pause();
      await first.flush();
      final resumed = WorkspaceLearning(storage: store);
      addTearDown(resumed.dispose);
      await resumed.load();
      expect(resumed.offer, isFalse);
      expect(resumed.active, isFalse);
      expect(resumed.next, WorkspaceLesson.pane);
      resumed.start();
      resumed.observe(agents: 2, zoomed: false);
      expect(resumed.next, WorkspaceLesson.zoom);
      resumed.observe(agents: 2, zoomed: true);
      resumed.commandSearchOpened();
      expect(resumed.finished, isTrue);
      await resumed.flush();
      resumed.start();
      expect(
        resumed.next,
        WorkspaceLesson.agent,
        reason: 'The whole guide is repeatable',
      );
    },
  );

  test(
    'late storage reads cannot undo an explicit start or dismissal',
    () async {
      final store = LearningMemoryStore()..pending = Completer<String?>();
      final learning = WorkspaceLearning(storage: store);
      addTearDown(learning.dispose);
      final loaded = learning.load();
      learning.start();
      learning.observe(agents: 1, zoomed: false);
      learning.pause();
      store.pending!.complete('{"active":true,"completed":[]}');
      await loaded;
      expect(learning.active, isFalse);
      expect(learning.next, WorkspaceLesson.pane);
      await learning.flush();
    },
  );
}
