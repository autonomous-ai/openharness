import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/sleep_aware.dart';

/// What a closed lid looks like to the event loop: nothing runs, then every overdue timer is due at
/// once. Blocking the isolate reproduces exactly that — the VM skips the periods it missed.
void _sleepFor(Duration duration) {
  final until = DateTime.now().add(duration);
  while (DateTime.now().isBefore(until)) {}
}

void main() {
  test('fires after its duration of awake time, like any timer', () async {
    var fired = 0;
    SleepAwareTimer(const Duration(milliseconds: 150), () => fired++);
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(fired, 0);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(fired, 1);
  });

  // 2026-09-29 19:06:11: a request timed out the instant the machine woke, its answer one second
  // behind. A plain timer spends the sleep; this one does not.
  test(
    'does not spend a sleep on its deadline, where a plain timer does',
    () async {
      var plain = 0;
      var aware = 0;
      Timer(const Duration(milliseconds: 200), () => plain++);
      SleepAwareTimer(const Duration(milliseconds: 200), () => aware++);
      _sleepFor(const Duration(milliseconds: 900));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(
        plain,
        1,
        reason: 'the plain timer fires on the first turn after the wake',
      );
      expect(aware, 0, reason: 'the time asleep was nobody’s silence');
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(aware, 1, reason: 'awake again for the whole deadline, it fires');
    },
  );

  test('can be cancelled', () async {
    var fired = 0;
    final timer = SleepAwareTimer(
      const Duration(milliseconds: 50),
      () => fired++,
    );
    expect(timer.isActive, isTrue);
    timer.cancel();
    expect(timer.isActive, isFalse);
    await Future<void>.delayed(const Duration(milliseconds: 150));
    expect(fired, 0);
  });

  test(
    'awakeTimeout answers with the future, or with onTimeout after awake time',
    () async {
      expect(
        await awakeTimeout(
          Future.value(7),
          const Duration(seconds: 1),
          onTimeout: () => 0,
        ),
        7,
      );
      expect(
        await awakeTimeout(
          Completer<int>().future,
          const Duration(milliseconds: 50),
          onTimeout: () => -1,
        ),
        -1,
      );
      await expectLater(
        awakeTimeout<int>(
          Completer<int>().future,
          const Duration(milliseconds: 50),
          onTimeout: () => throw TimeoutException('late'),
        ),
        throwsA(isA<TimeoutException>()),
      );
    },
  );
}
