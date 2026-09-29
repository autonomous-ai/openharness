import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/companion_life.dart';

void main() {
  late DateTime now;
  late CompanionLife life;
  setUp(() {
    now = DateTime.utc(2026, 9, 28, 9);
    life = CompanionLife(now: () => now);
  });
  void advance(Duration duration) {
    now = now.add(duration);
  }

  test('a full day follows real workload, rest and quiet time', () {
    expect(life.feeling.emotion, CompanionEmotion.content);
    advance(const Duration(seconds: 50));
    expect(life.feeling.emotion, CompanionEmotion.curious);
    advance(const Duration(minutes: 3));
    expect(life.feeling.emotion, CompanionEmotion.bored);
    life.observe(working: 4, needs: 0, failures: 0);
    expect(life.feeling.emotion, CompanionEmotion.focused);
    advance(const Duration(hours: 2));
    expect(life.feeling.emotion, CompanionEmotion.tired);
    advance(const Duration(hours: 2));
    expect(life.feeling.emotion, CompanionEmotion.exhausted);
    life.observe(working: 0, needs: 0, failures: 0);
    advance(const Duration(minutes: 20));
    expect(life.feeling.emotion, CompanionEmotion.asleep);
    advance(const Duration(hours: 2));
    life.observe(working: 1, needs: 0, failures: 0);
    expect(life.feeling.emotion, CompanionEmotion.working);
  });

  test('a merge celebrates once and a reconnect never replays it', () {
    life.record(CompanionEvent.merged, 'repo/pull/442');
    expect(life.feeling.emotion, CompanionEmotion.excited);
    expect(life.feeling.intensity, 3);
    advance(const Duration(seconds: 4));
    life.record(CompanionEvent.merged, 'repo/pull/442');
    expect(life.feeling.remainingMs, 5000);
    life.observe(working: 0, needs: 0, failures: 0, connected: false);
    expect(life.feeling.emotion, CompanionEmotion.offline);
    life.observe(working: 0, needs: 0, failures: 0);
    life.record(CompanionEvent.merged, 'repo/pull/442');
    expect(life.feeling.emotion, CompanionEmotion.content);
  });

  test('repeated actual bugs frustrate, escalate and then resolve', () {
    life.record(CompanionEvent.bug, 'tool-1');
    expect(life.feeling.emotion, CompanionEmotion.frustrated);
    for (var i = 2; i <= 3; i++) {
      advance(const Duration(seconds: 4));
      life.record(CompanionEvent.bug, 'tool-$i');
    }
    expect(life.feeling.emotion, CompanionEmotion.angry);
    life.record(CompanionEvent.recovered, 'tests-passed');
    expect(life.feeling.emotion, CompanionEmotion.relieved);
    advance(const Duration(seconds: 8));
    life.record(CompanionEvent.bug, 'new-tool');
    expect(life.feeling.emotion, CompanionEmotion.frustrated);
  });

  test('questions outrank celebrations and do not postpone them', () {
    life.record(CompanionEvent.merged, 'merge');
    life.observe(working: 3, needs: 1, failures: 0);
    expect(life.feeling.emotion, CompanionEmotion.attentive);
    advance(const Duration(seconds: 20));
    life.observe(working: 3, needs: 0, failures: 0);
    expect(life.feeling.emotion, CompanionEmotion.focused);
    expect(life.feeling.reactionId, isNull);
  });

  test('a new attempt clears frustration but remembers the recovery', () {
    life.record(CompanionEvent.failed, 'failed-turn');
    expect(life.feeling.emotion, CompanionEmotion.frustrated);
    life.observe(working: 1, needs: 0, failures: 0);
    expect(life.feeling.emotion, CompanionEmotion.working);
    life.observe(working: 0, needs: 0, failures: 0);
    life.record(CompanionEvent.completed, 'retry');
    expect(life.feeling.emotion, CompanionEmotion.relieved);
  });

  test('inventories establish state without fabricating a fresh event', () {
    life.observe(working: 0, needs: 0, failures: 3);
    expect(life.feeling.emotion, CompanionEmotion.sad);
    expect(life.feeling.reactionId, isNull);
    life.observe(working: 0, needs: 0, failures: 0, asleep: true);
    life.record(CompanionEvent.merged, 'while-asleep');
    life.observe(working: 0, needs: 0, failures: 0);
    expect(life.feeling.emotion, CompanionEmotion.content);
  });

  test('small successes do not interrupt a hatch or a merge', () {
    life.record(CompanionEvent.hatched, 'egg-1');
    life.record(CompanionEvent.completed, 'turn-1');
    expect(life.feeling.emotion, CompanionEmotion.hatching);
    advance(const Duration(seconds: 9));
    expect(life.feeling.emotion, CompanionEmotion.content);
    life.record(CompanionEvent.merged, 'merge-1');
    life.record(CompanionEvent.completed, 'turn-2');
    expect(life.feeling.emotion, CompanionEmotion.excited);
  });

  test('reset forgets the previous account and clock rollback is harmless', () {
    life.record(CompanionEvent.failed, 'failure');
    life.observe(working: 2, needs: 0, failures: 1);
    advance(const Duration(hours: 4));
    expect(life.feeling.emotion, CompanionEmotion.exhausted);
    advance(const Duration(hours: -2));
    expect(life.feeling.emotion, CompanionEmotion.exhausted);
    life.reset();
    expect(life.feeling.emotion, CompanionEmotion.content);
    expect(life.feeling.toJson().containsKey('reactionId'), isFalse);
  });
}
