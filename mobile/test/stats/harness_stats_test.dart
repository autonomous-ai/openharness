import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/snapshot_store.dart';
import 'package:harness_mobile/stats/harness_stats.dart';

/// The app's own counters — agents started, turns taken, time worked.
///
/// Nothing on the phone draws them today, but they are kept and written every
/// launch, so what lands on disk has to be something a page brought back later
/// could trust: no turn counted twice for a re-announce, no clock time invented
/// for a turn this app never saw start, and a snapshot it cannot read treated
/// as no snapshot rather than a failed launch.
///
/// The debounced write never runs under `flutter test` (a pending timer is a
/// `pumpAndSettle` that never settles), so what reaches the store is read here
/// through [HarnessStats.flush] — the one other door to the same write.
void main() {
  Map<String, Object?> written(MemorySnapshotStore store) =>
      jsonDecode(store.contents!) as Map<String, Object?>;

  test(
    'counts agents and turns, and the time between a start and its end',
    () async {
      final store = MemorySnapshotStore();
      final stats = HarnessStats(store: store);
      addTearDown(stats.dispose);
      final t0 = DateTime(2026, 9, 27, 9);
      var notified = 0;
      stats.addListener(() => notified++);

      stats.onAgentSpawned(at: t0);
      stats.onTurnStarted('m/a', at: t0);
      stats.onTurnEnded('m/a', at: t0.add(const Duration(seconds: 90)));
      await stats.flush();

      expect(written(store), {
        'version': 1,
        'agentsSpawned': 1,
        'turns': 1,
        'workedMs': 90000,
        'firstEventAt': t0.toIso8601String(),
      });
      expect(notified, 3);
    },
  );

  test(
    'a turn re-announced while under way is one turn, timed from its start',
    () async {
      final store = MemorySnapshotStore();
      final stats = HarnessStats(store: store);
      addTearDown(stats.dispose);
      final t0 = DateTime(2026, 9, 27, 9);
      stats.onTurnStarted('m/a', at: t0);
      // A heartbeat, or the re-announce after a reconnect.
      stats.onTurnStarted('m/a', at: t0.add(const Duration(minutes: 1)));
      stats.onTurnEnded('m/a', at: t0.add(const Duration(minutes: 2)));
      await stats.flush();
      expect(written(store)['turns'], 1);
      expect(written(store)['workedMs'], 120000);
    },
  );

  test('an end for a turn this app never saw start adds no time', () async {
    final store = MemorySnapshotStore();
    final stats = HarnessStats(store: store);
    addTearDown(stats.dispose);
    stats.onTurnEnded('m/unknown');
    // And a clock that went backwards contributes nothing either.
    final t0 = DateTime(2026, 9, 27, 9);
    stats.onTurnStarted('m/a', at: t0);
    stats.onTurnEnded('m/a', at: t0.subtract(const Duration(seconds: 5)));
    await stats.flush();
    expect(written(store)['workedMs'], 0);
    expect(written(store)['turns'], 1);
  });

  test('"tracking since" is the first event and never moves', () async {
    final store = MemorySnapshotStore();
    final stats = HarnessStats(store: store);
    addTearDown(stats.dispose);
    final first = DateTime(2026, 9, 1);
    stats.onAgentSpawned(at: first);
    stats.onAgentSpawned(at: DateTime(2026, 9, 20));
    stats.onTurnStarted('x');
    await stats.flush();
    expect(written(store)['firstEventAt'], first.toIso8601String());
  });

  test(
    'a flush closes out the turns still running, counting their time',
    () async {
      final store = MemorySnapshotStore();
      final stats = HarnessStats(store: store);
      addTearDown(stats.dispose);
      stats.onTurnStarted(
        'm/a',
        at: DateTime.now().subtract(const Duration(minutes: 5)),
      );
      await stats.flush();
      expect(written(store)['workedMs'] as int, greaterThanOrEqualTo(300000));
      // Closed, not still live: a second flush adds nothing more.
      final before = written(store)['workedMs'];
      await stats.flush();
      expect(written(store)['workedMs'], before);
    },
  );

  group('load', () {
    test(
      'reads the counters back, and they keep counting from there',
      () async {
        final store = MemorySnapshotStore(
          jsonEncode({
            'version': 1,
            'agentsSpawned': 4,
            'turns': 9,
            'workedMs': 1000,
            'firstEventAt': '2026-08-01T10:00:00.000',
          }),
        );
        final stats = HarnessStats(store: store);
        addTearDown(stats.dispose);
        var notified = 0;
        stats.addListener(() => notified++);
        await stats.load();
        expect(notified, 1);
        stats.onAgentSpawned(at: DateTime(2026, 9, 27));
        await stats.flush();
        expect(written(store), {
          'version': 1,
          'agentsSpawned': 5,
          'turns': 9,
          'workedMs': 1000,
          // The stored date stands: a later event does not move it.
          'firstEventAt': '2026-08-01T10:00:00.000',
        });
      },
    );

    test('nothing stored is nothing to load', () async {
      final stats = HarnessStats(store: MemorySnapshotStore());
      addTearDown(stats.dispose);
      var notified = 0;
      stats.addListener(() => notified++);
      await stats.load();
      expect(notified, 0);
    });

    test('a snapshot it cannot read is one it does not have', () async {
      for (final contents in [
        'not json',
        '[1, 2]',
        jsonEncode({'version': 0, 'turns': 50}),
        jsonEncode({
          'version': 1,
          'agentsSpawned': -3,
          'turns': 'many',
          'workedMs': 2.5e3,
          'firstEventAt': 17,
        }),
      ]) {
        final store = MemorySnapshotStore(contents);
        final stats = HarnessStats(store: store);
        await stats.load();
        await stats.flush();
        final back = written(store);
        expect(back['turns'], 0, reason: contents);
        expect(back['agentsSpawned'], 0, reason: contents);
        expect(back['firstEventAt'], isNull, reason: contents);
        // A fractional or odd number is read as far as it goes, not dropped.
        if (contents.contains('2500')) expect(back['workedMs'], 2500);
        stats.dispose();
      }
    });
  });

  test('after dispose it counts quietly, notifying nobody', () {
    final stats = HarnessStats(store: MemorySnapshotStore());
    stats.dispose();
    // A disposed ChangeNotifier throws when notified; this must not.
    stats.onAgentSpawned();
    stats.onTurnStarted('k');
    stats.onTurnEnded('k');
  });
}
