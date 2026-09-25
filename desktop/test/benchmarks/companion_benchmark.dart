// Run explicitly: flutter test test/benchmarks/companion_benchmark.dart --reporter expanded
// Headless debug controller timings, not native UI, network, or frame latency.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/state/workspace_onboarding.dart';

Map<String, double> measure(void Function() event) {
  const batch = 5000;
  for (var i = 0; i < batch; i++) {
    event();
  }
  final samples = <double>[];
  for (var sample = 0; sample < 30; sample++) {
    final watch = Stopwatch()..start();
    for (var i = 0; i < batch; i++) {
      event();
    }
    watch.stop();
    samples.add(watch.elapsedTicks * 1000000 / watch.frequency / batch);
  }
  samples.sort();
  return {'medianUsPerEvent': samples[15], 'p95UsPerEvent': samples[28]};
}

void main() {
  for (final machineCount in [1, 10, 100]) {
    testWidgets('companion event checks with $machineCount machines', (
      tester,
    ) async {
      final journey = WorkspaceOnboarding();
      // Keep the production clock: DateTime.now is part of the measured path.
      final pet = CompanionController(journey);
      journey.sync(
        scope: 'benchmark',
        observed: WorkspaceOnboarding.hatchSteps.toSet(),
        otherComputer: true,
        modelsAvailable: false,
      );
      await tester.pump();
      pet.hatch(reduceMotion: true);
      await tester.pump(const Duration(seconds: 7));
      final turns = {for (var i = 0; i < machineCount; i++) 'm$i': 0};
      final last = 'm${machineCount - 1}';
      var completed = 0, notifications = 0;
      void sync() => pet.sync(
        working: false,
        needsInput: false,
        browsing: false,
        completedTurns: completed,
        turnsByMachine: turns,
      );
      sync();
      pet.addListener(() => notifications++);
      final unchanged = measure(sync);
      final suppressedFinishes = measure(() {
        turns[last] = ++completed;
        sync();
      });
      // No per-event repaint or timer from either stable updates or bursts.
      expect(notifications, 0);
      // ignore: avoid_print
      print(
        jsonEncode({
          'machines': machineCount,
          'samples': 30,
          'eventsPerSample': 5000,
          'unchanged': unchanged,
          'finishesDuringCooldown': suppressedFinishes,
        }),
      );
      pet.dispose();
      journey.dispose();
    });
  }
}
