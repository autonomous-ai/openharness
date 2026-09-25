import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/state/workspace_onboarding.dart';

import 'swarm_state_test.dart' show MemoryStore;

class _HeldStore extends MemoryStore {
  final reads = <String, Completer<String?>>{};
  @override
  Future<String?> read(String key) =>
      (reads[key] = Completer<String?>()).future;
}

class _BrokenStore implements LocalKeyValueStore {
  @override
  Future<String?> read(String key) async => throw StateError('unavailable');
  @override
  Future<void> write(String key, String value) async =>
      throw StateError('full');
  @override
  Future<void> delete(String key) async {}
}

void main() {
  const first = OnboardingStep.harnesses;
  const second = OnboardingStep.machines;
  const third = OnboardingStep.models;
  Future<void> sync(
    WorkspaceOnboarding journey, {
    String scope = 'a',
    Set<OnboardingStep> observed = const {},
    bool other = false,
    bool models = true,
  }) async {
    journey.sync(
      scope: scope,
      observed: observed,
      otherComputer: other,
      modelsAvailable: models,
    );
    await Future<void>.delayed(Duration.zero);
  }

  test('one next step; viewing a panel does not complete it', () async {
    final store = MemoryStore();
    final journey = WorkspaceOnboarding(storage: store);
    addTearDown(journey.dispose);
    await sync(journey);
    expect(journey.next, first);
    expect(journey.showsDot(first), isTrue);
    journey.acknowledge(second);
    expect(journey.showsDot(first), isTrue);
    journey.acknowledge(first);
    expect(journey.next, first);
    expect(journey.showsDot(first), isFalse);
    await journey.flush();
    final reopened = WorkspaceOnboarding(storage: store);
    addTearDown(reopened.dispose);
    await sync(reopened);
    expect(reopened.next, first);
    expect(reopened.showsDot(first), isFalse);
    await sync(journey, observed: {first});
    expect(journey.next, second);
    expect(journey.showsDot(second), isTrue);
    await sync(journey); // Closing work never undoes the first success.
    expect(journey.next, second);
    await sync(journey, observed: {second});
    expect(journey.next, third);
    journey.acknowledge(third);
    expect(journey.completed(third), isFalse);
    await sync(journey, observed: {third});
    expect(journey.next, isNull);
    await journey.flush();
    final finished = WorkspaceOnboarding(storage: store);
    addTearDown(finished.dispose);
    await sync(finished);
    expect(finished.next, isNull);
  });

  test('the second computer leads with existing work, not new setup', () async {
    final journey = WorkspaceOnboarding();
    addTearDown(journey.dispose);
    await sync(journey, other: true);
    expect(journey.next, second);
    expect(journey.completed(first), isFalse);
    // Discovery is not access. A usable remote harness is the milestone.
    expect(journey.completed(second), isFalse);
    await sync(journey, observed: {second}, other: true);
    expect(journey.completed(first), isTrue);
    expect(journey.next, third);
  });

  test(
    'skip another computer and try local AI without a false completion',
    () async {
      final journey = WorkspaceOnboarding(storage: MemoryStore());
      addTearDown(journey.dispose);
      await sync(journey, observed: {first}, models: false);
      journey.dismiss(second);
      expect(journey.next, isNull);
      expect(journey.completed(second), isFalse);
      await sync(journey, models: true);
      expect(journey.next, third);
      journey.dismiss(third);
      expect(journey.next, isNull);
      await sync(journey);
      expect(journey.next, isNull);
    },
  );

  test(
    'dismissing first-use waits for actual work before offering next step',
    () async {
      final journey = WorkspaceOnboarding();
      addTearDown(journey.dispose);
      await sync(journey);
      journey.dismiss(first);
      expect(journey.next, isNull);
      await sync(journey, observed: {first});
      expect(journey.next, second);
    },
  );

  test('preferences and milestones stay isolated across accounts', () async {
    final journey = WorkspaceOnboarding(storage: MemoryStore());
    addTearDown(journey.dispose);
    await sync(journey, observed: {first});
    journey.dismiss(second);
    await sync(journey, scope: 'b');
    expect(journey.next, first);
    expect(journey.completed(first), isFalse);
    await sync(journey, scope: 'a');
    expect(journey.next, third);
  });

  test('late preferences cannot overwrite the new account', () async {
    final store = _HeldStore();
    final journey = WorkspaceOnboarding(storage: store);
    addTearDown(journey.dispose);
    await sync(journey);
    await sync(journey, scope: 'b');
    store.reads[WorkspaceOnboarding.storageKey('a')]!.complete(
      '{"completed":["harnesses","machines","models"]}',
    );
    store.reads[WorkspaceOnboarding.storageKey('b')]!.complete(null);
    await Future<void>.delayed(Duration.zero);
    expect(journey.next, first);
  });

  test('unavailable and corrupt preferences do not block onboarding', () async {
    for (final store in <LocalKeyValueStore>[
      _BrokenStore(),
      MemoryStore()..values[WorkspaceOnboarding.storageKey('a')] = 'invalid',
      MemoryStore()
        ..values[WorkspaceOnboarding.storageKey('a')] =
            '{"completed":["unknown"],"seen":123}',
    ]) {
      final journey = WorkspaceOnboarding(storage: store);
      await sync(journey);
      expect(journey.next, first);
      journey.dismiss(first);
      await journey.flush();
      journey.dispose();
    }
  });

  test('disposing while preferences load is safe', () async {
    final store = _HeldStore();
    final journey = WorkspaceOnboarding(storage: store);
    await sync(journey);
    journey.dispose();
    store.reads.values.single.complete(null);
    await Future<void>.delayed(Duration.zero);
    journey.sync(
      scope: 'b',
      observed: {},
      otherComputer: false,
      modelsAvailable: false,
    );
  });
}
