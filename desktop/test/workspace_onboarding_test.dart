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
  const third = OnboardingStep.store;
  const bonus = OnboardingStep.models;
  Future<void> sync(
    WorkspaceOnboarding journey, {
    String scope = 'a',
    Set<OnboardingStep> observed = const {},
    bool other = false,
    bool models = true,
    Set<String> used = const {},
  }) async {
    journey.sync(
      scope: scope,
      observed: observed,
      otherComputer: other,
      modelsAvailable: models,
      usedHarnesses: used,
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
    expect(journey.completedCount, 3);
    expect(journey.next, isNull);
    expect(journey.complete, isTrue);
    await journey.flush();
    final finished = WorkspaceOnboarding(storage: store);
    addTearDown(finished.dispose);
    await sync(finished);
    expect(finished.next, isNull);
    expect(finished.nextHatchStep, isNull);
    expect(finished.completed(bonus), isFalse);
    expect(finished.hatchCompanion(), isTrue);
    expect(finished.next, bonus);
    expect(finished.nextHatchStep, isNull);
  });

  test('hatch guidance waits for the current account to load', () async {
    final store = _HeldStore();
    final journey = WorkspaceOnboarding(storage: store);
    addTearDown(journey.dispose);
    expect(journey.nextHatchStep, isNull);
    await sync(journey);
    expect(journey.nextHatchStep, isNull);
    store.reads[WorkspaceOnboarding.storageKey('a')]!.complete(null);
    await Future<void>.delayed(Duration.zero);
    expect(journey.nextHatchStep, first);
    await sync(journey, scope: 'b');
    expect(journey.nextHatchStep, isNull);
    store.reads[WorkspaceOnboarding.storageKey('b')]!.complete(
      '{"completed":["harnesses","machines","store"]}',
    );
    await Future<void>.delayed(Duration.zero);
    expect(journey.nextHatchStep, isNull);
  });

  test(
    'dismissing every invitation keeps unfinished hatch steps reachable',
    () async {
      final journey = WorkspaceOnboarding();
      addTearDown(journey.dispose);
      await sync(journey);
      for (final step in WorkspaceOnboarding.hatchSteps) {
        journey.dismiss(step);
      }
      expect(journey.next, isNull);
      expect(journey.nextHatchStep, first);
      await sync(journey, observed: {first});
      expect(journey.nextHatchStep, second);
      await sync(journey, observed: {second});
      expect(journey.nextHatchStep, third);
      expect(journey.completed(bonus), isFalse);
      await sync(journey, observed: {third});
      expect(journey.nextHatchStep, isNull);
      expect(journey.complete, isTrue);
    },
  );

  test(
    'a saved Store dismissal never sends hatch guidance to local models',
    () async {
      final store = MemoryStore()
        ..values[WorkspaceOnboarding.storageKey('a')] =
            '{"completed":["harnesses","machines"],"dismissed":["store"]}';
      final journey = WorkspaceOnboarding(storage: store);
      addTearDown(journey.dispose);
      await sync(journey);
      expect(journey.next, isNull);
      expect(journey.nextHatchStep, third);
      expect(journey.completed(bonus), isFalse);
      expect(journey.hatchCompanion(), isFalse);
      await sync(journey, observed: {bonus});
      expect(journey.nextHatchStep, third);
      expect(journey.completedCount, 2);
    },
  );

  test('the second computer leads with existing work, not new setup', () async {
    final journey = WorkspaceOnboarding();
    addTearDown(journey.dispose);
    await sync(journey, other: true);
    expect(journey.next, second);
    expect(journey.nextHatchStep, second);
    expect(journey.completed(first), isFalse);
    // Merely seeing a machine in inventory is not a successful connection.
    expect(journey.completed(second), isFalse);
    await sync(journey, observed: {second}, other: true);
    expect(journey.completed(first), isFalse);
    expect(journey.next, third);
    expect(journey.nextHatchStep, third);
    journey.dismiss(third);
    expect(journey.next, isNull);
    expect(journey.nextHatchStep, first);
  });

  test('skipping a machine offers Store; local models cannot replace a required step', () async {
    final journey = WorkspaceOnboarding(storage: MemoryStore());
    addTearDown(journey.dispose);
    await sync(journey, observed: {first}, models: false);
    journey.dismiss(second);
    expect(journey.next, third);
    expect(journey.completed(second), isFalse);
    await sync(journey, models: true);
    expect(journey.next, third);
    await sync(journey, observed: {bonus});
    expect(journey.completedCount, 1);
    expect(journey.next, third);
    journey.dismiss(third);
    expect(journey.next, isNull);
    expect(journey.complete, isFalse);
  });

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

  test(
    'a different harness survives closing work and restarting, per account',
    () async {
      final store = MemoryStore();
      final journey = WorkspaceOnboarding(storage: store);
      addTearDown(journey.dispose);
      await sync(journey, used: {'coding'});
      expect(journey.completed(first), isTrue);
      expect(journey.completed(third), isFalse);
      await sync(journey, used: {'coding'});
      await sync(journey);
      await journey.flush();
      final restored = WorkspaceOnboarding(storage: store);
      addTearDown(restored.dispose);
      await sync(restored, used: {'autonomous/kicad'});
      expect(restored.completed(third), isTrue);
      expect(restored.completedCount, 2);
      await sync(restored, scope: 'b', used: {'autonomous/kicad'});
      expect(restored.completed(third), isTrue);
      expect(restored.completed(second), isFalse);
      await sync(restored, scope: 'a');
      expect(restored.completed(third), isTrue);
    },
  );

  test('old local-model progress is retained but does not replace the store discovery', () async {
    final store = MemoryStore()
      ..values[WorkspaceOnboarding.storageKey('a')] =
          '{"completed":["harnesses","machines","models"]}';
    final journey = WorkspaceOnboarding(storage: store);
    addTearDown(journey.dispose);
    await sync(journey);
    expect(journey.completedCount, 2);
    expect(journey.total, 3);
    expect(journey.completed(bonus), isTrue);
    expect(journey.complete, isFalse);
    expect(journey.next, third);
    journey.acknowledge(third);
    expect(journey.completed(third), isFalse);
    await sync(journey, used: {'coding', 'autonomous/kicad'});
    expect(journey.complete, isTrue);
    await journey.flush();
    final restored = WorkspaceOnboarding(storage: store);
    addTearDown(restored.dispose);
    await sync(restored);
    expect(restored.complete, isTrue);
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

  test(
    'egg invitation is shown once per account and does not earn progress',
    () async {
      final store = MemoryStore();
      final journey = WorkspaceOnboarding(storage: store);
      addTearDown(journey.dispose);
      expect(journey.acknowledgeCompanionHint(), isFalse);
      await sync(journey);
      expect(journey.needsCompanionHint, isTrue);
      expect(journey.acknowledgeCompanionHint(), isTrue);
      expect(journey.acknowledgeCompanionHint(), isFalse);
      expect(journey.completedCount, 0);
      await journey.flush();
      final restored = WorkspaceOnboarding(storage: store);
      addTearDown(restored.dispose);
      await sync(restored);
      expect(restored.needsCompanionHint, isFalse);
      await sync(restored, scope: 'b');
      expect(restored.needsCompanionHint, isTrue);
      await sync(restored, observed: WorkspaceOnboarding.hatchSteps.toSet());
      expect(restored.hatchCompanion(), isTrue);
      expect(restored.needsCompanionHint, isFalse);
    },
  );
}
