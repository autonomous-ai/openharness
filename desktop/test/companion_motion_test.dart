import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/state/workspace_onboarding.dart';

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  int writes = 0;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    writes++;
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

Future<(WorkspaceOnboarding, CompanionController, _MemoryStore)> _egg(
  WidgetTester tester, {
  Set<OnboardingStep> observed = const {},
}) async {
  final storage = _MemoryStore();
  final journey = WorkspaceOnboarding(storage: storage, random: Random(3));
  final pet = CompanionController(journey, now: tester.binding.clock.now);
  addTearDown(() {
    pet.dispose();
    journey.dispose();
  });
  journey.sync(
    scope: 'motion-test',
    observed: observed,
    otherComputer: false,
    modelsAvailable: false,
  );
  await tester.pump();
  return (journey, pet, storage);
}

void _discover(WorkspaceOnboarding journey, Set<OnboardingStep> steps) {
  journey.sync(
    scope: 'motion-test',
    observed: steps,
    otherComputer: false,
    modelsAvailable: false,
  );
}

void _syncWork(CompanionController pet, {bool working = false, int turns = 0}) {
  pet.sync(
    working: working,
    needsInput: false,
    browsing: false,
    completedTurns: turns,
  );
}

void main() {
  testWidgets(
    'each discovery keeps its nest stage through motion and restores',
    (tester) async {
      final (journey, pet, storage) = await _egg(tester);
      final stages = <String>[pet.statusGlyph];
      final observed = <OnboardingStep>{};
      final frames = <String>[];
      pet.addListener(() => frames.add(pet.statusGlyph));

      // The machine can come first; Models adds no stage beyond the first task.
      for (final step in [
        OnboardingStep.machines,
        OnboardingStep.harnesses,
        OnboardingStep.store,
      ]) {
        observed.add(step);
        _discover(journey, observed);
        for (var i = 0; i < 6; i++) {
          await tester.pump(const Duration(milliseconds: 160));
        }
        final stage = pet.statusGlyph;
        stages.add(stage);
        expect(pet.identity, isNull);
        pet.setEnvironment(foreground: false);
        expect(pet.statusGlyph, stage);
        pet.setEnvironment(foreground: true, reduceMotion: true);
        await tester.pump(const Duration(seconds: 30));
        expect(pet.statusGlyph, stage);
        pet.setEnvironment(foreground: true);
        frames.clear();
        await tester.pump(const Duration(hours: 1));
        expect(frames, isEmpty);
        expect(pet.statusGlyph, stage);
        if (journey.completedCount == 2) {
          observed.add(OnboardingStep.models);
          _discover(journey, observed);
          expect(pet.statusGlyph, stage);
        }

        await journey.flush();
        final restoredJourney = WorkspaceOnboarding(storage: storage);
        final restoredPet = CompanionController(restoredJourney)
          ..setEnvironment(foreground: true, reduceMotion: true);
        restoredJourney.sync(
          scope: 'motion-test',
          observed: {},
          otherComputer: false,
          modelsAvailable: false,
        );
        await tester.pump();
        expect(restoredPet.statusGlyph, stage);
        expect(restoredPet.eggReply, isNull);
        expect(restoredPet.identity, isNull);
        restoredPet.dispose();
        restoredJourney.dispose();
      }
      expect(stages.toSet(), hasLength(4));
      expect(
        frames.every((frame) => frame.length <= pet.statusColumns),
        isTrue,
      );
      expect(
        frames.every((frame) => RegExp(r'^[\x20-\x7e]+$').hasMatch(frame)),
        isTrue,
      );
      pet.dispose();
    },
  );

  testWidgets('loaded and restored discoveries stay still; ready is awake', (
    tester,
  ) async {
    final (journey, pet, _) = await _egg(
      tester,
      observed: WorkspaceOnboarding.hatchSteps.toSet(),
    );
    expect(pet.eggReply, isNull);
    expect(pet.statusGlyph, CompanionController.readyEgg);
    final frames = <String>[];
    pet.addListener(() => frames.add(pet.statusGlyph));
    await tester.pump(const Duration(seconds: 30));
    expect(frames, isEmpty);

    await journey.flush();
    journey.sync(
      scope: 'another-account',
      observed: {},
      otherComputer: false,
      modelsAvailable: false,
    );
    await tester.pump();
    _discover(journey, {});
    await tester.pump();
    expect(journey.complete, isTrue);
    expect(pet.eggReply, isNull);
    expect(pet.statusGlyph, CompanionController.readyEgg);
    pet.dispose();
  });

  testWidgets(
    'discoveries take priority over finishes without queuing motion',
    (tester) async {
      final (journey, pet, _) = await _egg(tester);
      final frames = <String>[];
      pet.addListener(() => frames.add(pet.statusGlyph));
      _syncWork(pet, working: true);
      _discover(journey, {OnboardingStep.harnesses});
      // The workspace delivers discovery and work-state updates together.
      _syncWork(pet, turns: 1);
      expect(pet.eggReply, isNotNull);
      final stirring = CompanionController.eggStages[1];
      expect(pet.statusGlyph, isNot(stirring));
      final firstReply = pet.eggReply;
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 160));
      }
      await tester.pump(const Duration(milliseconds: 2200));
      expect(pet.eggReply, isNull);
      expect(pet.statusGlyph, stirring);

      _discover(journey, {OnboardingStep.harnesses});
      expect(pet.eggReply, isNull);
      frames.clear();
      _syncWork(pet, turns: 2);
      expect(frames, isEmpty); // Same burst; no delayed replay.
      await tester.pump(const Duration(seconds: 17));
      expect(frames, isEmpty);
      _syncWork(pet, turns: 3);
      expect(pet.eggReply, 'a little cheer from inside.');

      // Even when the turn arrives first, the discovery immediately takes over.
      _discover(journey, {OnboardingStep.harnesses, OnboardingStep.machines});
      expect(pet.eggReply, isNot(firstReply));
      expect(pet.eggReply, 'oh. hello out there.');
      _discover(journey, WorkspaceOnboarding.hatchSteps.toSet());
      expect(pet.eggReply!.length, lessThanOrEqualTo(30));
      expect(pet.statusGlyph, CompanionController.readyEgg);
      await tester.pump(const Duration(seconds: 3));
      frames.clear();
      await tester.pump(const Duration(hours: 1));
      expect(frames, isEmpty);
      expect(pet.statusGlyph, CompanionController.readyEgg);
      expect(frames.every((frame) => frame.length <= 8), isTrue);
      expect(
        frames.every((frame) => RegExp(r'^[\x20-\x7e]+$').hasMatch(frame)),
        isTrue,
      );
      pet.dispose();
    },
  );

  testWidgets('idle eggs and creatures schedule no timers or repaint work', (
    tester,
  ) async {
    final (journey, pet, _) = await _egg(tester);
    var wakeups = 0, notifications = 0;
    pet.addListener(() => notifications++);
    final zone = Zone.current.fork(
      specification: ZoneSpecification(
        createTimer: (self, parent, zone, duration, callback) =>
            parent.createTimer(zone, duration, () {
              wakeups++;
              callback();
            }),
        createPeriodicTimer: (self, parent, zone, duration, callback) =>
            parent.createPeriodicTimer(zone, duration, (timer) {
              wakeups++;
              callback(timer);
            }),
      ),
    );
    zone.run(() => _syncWork(pet));
    await tester.pump(const Duration(hours: 24));
    expect(wakeups, 0);
    expect(notifications, 0);
    zone.run(() => _syncWork(pet, turns: 1));
    await tester.pump(const Duration(seconds: 7));
    expect(wakeups, greaterThan(0));
    final settled = (wakeups, notifications);
    await tester.pump(const Duration(hours: 24));
    expect((wakeups, notifications), settled);

    _discover(journey, WorkspaceOnboarding.hatchSteps.toSet());
    zone.run(() => pet.hatch());
    await tester.pump(const Duration(seconds: 9));
    final hatched = (wakeups, notifications);
    await tester.pump(const Duration(hours: 24));
    expect((wakeups, notifications), hatched);
    expect(pet.mood, CompanionMood.content);
    pet.dispose();
  });

  testWidgets(
    'completion cooldown expires only on a new event; knocks respond',
    (tester) async {
      final (_, pet, _) = await _egg(tester);
      _syncWork(pet, turns: 10); // Imported history is only a baseline.
      expect(pet.eggReply, isNull);
      _syncWork(pet, turns: 11);
      expect(pet.eggReply, 'a little cheer from inside.');
      pet.knock(); // Explicit interaction answers during the automatic cooldown.
      expect(pet.eggReply, 'a tiny rustle from inside.');
      await tester.pump(const Duration(seconds: 3));
      var notifications = 0;
      pet.addListener(() => notifications++);
      for (var turns = 12; turns < 30; turns++) {
        _syncWork(pet, turns: turns);
      }
      await tester.pump(const Duration(seconds: 16));
      _syncWork(pet, turns: 30);
      expect(notifications, 0);
      await tester.pump(const Duration(seconds: 1));
      expect(notifications, 0); // No cooldown timer and no queued celebration.
      _syncWork(pet, turns: 31);
      expect(pet.eggReply, 'a little cheer from inside.');
      pet.dispose();
    },
  );

  testWidgets(
    'return greets once after a break, never for brief app switches',
    (tester) async {
      final (_, pet, _) = await _egg(tester);
      _syncWork(pet);
      pet.setEnvironment(foreground: false);
      await tester.pump(const Duration(minutes: 14, seconds: 59));
      pet.setEnvironment(foreground: true);
      expect(pet.eggReply, isNull);
      pet.setEnvironment(foreground: false);
      await tester.pump(const Duration(minutes: 15));
      _syncWork(pet, turns: 1); // A finish while away is not replayed.
      expect(pet.eggReply, isNull);
      pet.setEnvironment(foreground: true);
      expect(pet.eggReply, 'oh. you came back.');
      _syncWork(
        pet,
        turns: 2,
      ); // Returning takes priority over the next update.
      expect(pet.eggReply, 'oh. you came back.');
      await tester.pump(const Duration(seconds: 3));
      pet.setEnvironment(foreground: true);
      _syncWork(pet, turns: 2);
      expect(pet.eggReply, isNull);
      pet.dispose();
    },
  );

  testWidgets('knocking is transient, rate limited, and never earns progress', (
    tester,
  ) async {
    final (journey, pet, storage) = await _egg(tester);
    await journey.flush();
    final writes = storage.writes;
    var notifications = 0;
    pet.addListener(() => notifications++);
    pet.knock();
    expect(pet.eggReply, isNotNull);
    expect(pet.eggReply!.length, lessThanOrEqualTo(30));
    expect(pet.statusGlyph, isNot(CompanionController.egg));
    final afterKnock = notifications;
    for (var i = 0; i < 10; i++) {
      pet.knock();
    }
    expect(notifications, afterKnock);
    expect(journey.completedCount, 0);
    expect(journey.companion, isNull);
    await journey.flush();
    expect(storage.writes, writes);
    await tester.pump(const Duration(seconds: 3));
    expect(pet.eggReply, isNull);

    pet.setEnvironment(foreground: true, reduceMotion: true);
    pet.knock();
    expect(pet.eggReply, isNotNull);
    expect(pet.statusGlyph, CompanionController.egg);
    await tester.pump(const Duration(seconds: 3));
    expect(pet.eggReply, isNull);
    expect(pet.statusGlyph, CompanionController.egg);
    pet.dispose();
  });

  testWidgets(
    'background cancels egg reactions without replaying discoveries',
    (tester) async {
      final (journey, pet, _) = await _egg(tester);
      pet.knock();
      pet.setEnvironment(foreground: false);
      expect(pet.eggReply, isNull);
      expect(pet.statusGlyph, CompanionController.egg);
      _discover(journey, WorkspaceOnboarding.hatchSteps.toSet());
      expect(pet.eggReply, isNull);
      expect(pet.statusGlyph, CompanionController.readyEgg);
      var notifications = 0;
      pet.addListener(() => notifications++);
      await tester.pump(const Duration(minutes: 1));
      expect(notifications, 0);
      pet.setEnvironment(foreground: true);
      expect(pet.eggReply, isNull);
      expect(pet.statusGlyph, CompanionController.readyEgg);
      pet.knock();
      expect(pet.eggReply, isNull);
      pet.dispose();
    },
  );

  testWidgets(
    'reveal has anticipation, finishes under two seconds, and keeps identity',
    (tester) async {
      final (journey, pet, _) = await _egg(
        tester,
        observed: WorkspaceOnboarding.hatchSteps.toSet(),
      );
      pet.hatch();
      final identity = pet.identity!;
      expect(pet.hatching, isTrue);
      expect(pet.eggReply, isNull);
      expect(pet.statusGlyph, CompanionController.readyEgg);
      await tester.pump(const Duration(milliseconds: 200));
      expect(pet.statusGlyph, CompanionController.readyEgg);
      for (var i = 0; i < 8; i++) {
        await tester.pump(const Duration(milliseconds: 200));
        expect(pet.statusGlyph.length, lessThanOrEqualTo(8));
        expect(pet.identity, same(identity));
      }
      expect(pet.hatching, isFalse);
      expect(pet.mood, CompanionMood.happy);
      await journey.flush();
      final restored = WorkspaceOnboarding(storage: journey.storage);
      restored.sync(
        scope: 'motion-test',
        observed: {},
        otherComputer: false,
        modelsAvailable: false,
      );
      await tester.pump();
      expect(restored.companion!.species, identity.species);
      restored.dispose();
      pet.dispose();
    },
  );

  testWidgets(
    'reducing motion during reveal cancels frames and preserves hatch',
    (tester) async {
      final (_, pet, _) = await _egg(
        tester,
        observed: WorkspaceOnboarding.hatchSteps.toSet(),
      );
      pet.hatch();
      final identity = pet.identity;
      await tester.pump(const Duration(milliseconds: 400));
      pet.setEnvironment(foreground: true, reduceMotion: true);
      expect(pet.hatching, isFalse);
      expect(pet.statusGlyph, identity!.species.pose(pet.mood));
      var notifications = 0;
      pet.addListener(() => notifications++);
      await tester.pump(const Duration(seconds: 3));
      expect(notifications, 0);
      expect(pet.identity, same(identity));
      pet.dispose();
    },
  );

  testWidgets('wake and name replies expire into the current workspace mood', (
    tester,
  ) async {
    final (_, pet, _) = await _egg(
      tester,
      observed: WorkspaceOnboarding.hatchSteps.toSet(),
    );
    pet.hatch(reduceMotion: true);
    await tester.pump(const Duration(seconds: 7));
    _syncWork(pet);
    pet.nap();
    expect(pet.say('wake'), isTrue);
    expect(pet.napping, isFalse);
    _syncWork(pet, working: true);
    await tester.pump(const Duration(seconds: 13));
    expect(pet.mood, CompanionMood.focused);
    expect(pet.quote, pet.identity!.species.quote(CompanionMood.focused));

    pet.nap();
    expect(pet.say('/name Pip'), isTrue);
    expect(pet.napping, isFalse);
    expect(pet.quote, 'you can call me Pip.');
    await tester.pump(const Duration(seconds: 13));
    expect(pet.mood, CompanionMood.focused);
    expect(pet.quote, pet.identity!.species.quote(CompanionMood.focused));
    expect(pet.identity!.name, 'Pip');
    pet.dispose();
  });
}
