@TestOn('browser')
library;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/browser_lock.dart';
import 'package:harness/core/harness_file_store.dart';

/// Task #3728: browser_workspace_test.dart's persistence case waited forever and stopped the web runner. A widget test
/// runs in a fake-async zone whose microtasks never run once the test ends. A browser lock taken there was held by a
/// callback that could not finish, and the shared store kept the first caller's migration future for good, so every
/// later test on the same page waited on it.
///
/// The first test runs in that zone and ends without pumping; the second is an ordinary test that must
/// still get the store. Each wait is bounded, so a regression fails instead of stopping the runner.
const _bound = Duration(seconds: 5);

/// Lets the browser run the lock callback, which happens outside the fake clock.
Future<void> _until(WidgetTester tester, bool Function() condition) =>
    tester.runAsync(() async {
      final stop = Stopwatch()..start();
      while (!condition() && stop.elapsed < _bound) {
        await Future<void>.delayed(Duration.zero);
      }
    });

void main() {
  var migrationRan = false;

  testWidgets('the shared store is first used in a widget test', (
    tester,
  ) async {
    unawaited(HarnessFileStore.shared.read('zone-probe'));
    unawaited(
      withBrowserLock('migration', () async {
        migrationRan = true;
      }),
    );
    await _until(tester, () => migrationRan);
    expect(migrationRan, isTrue, reason: 'The migration lock must be free');
  });

  test('the shared store still answers in the next test', () async {
    final store = HarnessFileStore.shared;
    await store.write('zone-probe', 'ok').timeout(_bound);
    expect(await store.read('zone-probe').timeout(_bound), 'ok');
    await store.delete('zone-probe').timeout(_bound);
  });
}
