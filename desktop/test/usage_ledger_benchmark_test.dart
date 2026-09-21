// Synthetic CPU benchmark. No user logs, account data, or filesystem scans.
// HARNESS_USAGE_BENCHMARK=1 flutter test test/usage_ledger_benchmark_test.dart
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/snapshot_store.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/usage_ledger_controller.dart';
import 'package:harness/usage/ledger/usage_ledger_store.dart';
import 'package:harness/usage/ledger/usage_report.dart';
import 'package:harness/usage/ledger/opencode_ledger_scanner.dart';

import 'usage_ledger_test.dart'
    show MemorySettings, FakeScanner, sourceOf, entryOf;

import 'package:harness/usage/ledger/ledger_scanner.dart';

import 'usage_scanners_test.dart' show createUsageDatabase;

void main() {
  test('OpenCode scan CPU stays off the caller event loop', () async {
    final fixture = await Directory.systemTemp.createTemp(
      'harness-usage-timing-',
    );
    addTearDown(() => fixture.delete(recursive: true));
    final db = createUsageDatabase('${fixture.path}/opencode.db');
    db.execute('BEGIN');
    final insert = db.prepare(
      'INSERT INTO session VALUES (?, ?, ?, 0, 100, 0, 0, 0, 0, ?)',
    );
    for (var i = 0; i < 30000; i++) {
      insert.execute([
        'fixture-$i',
        '/fixture',
        1789862400000 + i,
        'fixture-model',
      ]);
    }
    insert.dispose();
    db.execute('COMMIT');
    db.dispose();
    final scanner = OpenCodeLedgerScanner(dataDirectory: fixture.path);
    final elapsed = <int>[];
    final gaps = <int>[];
    for (var run = 0; run < 6; run++) {
      final watch = Stopwatch()..start();
      var previousTick = 0;
      var maximumGap = 0;
      final ticker = Timer.periodic(const Duration(milliseconds: 1), (_) {
        final now = watch.elapsedMicroseconds;
        final gap = now - previousTick;
        if (gap > maximumGap) maximumGap = gap;
        previousTick = now;
      });
      try {
        final result = await scanner.scan({});
        final duration = watch.elapsedMicroseconds;
        await Future<void>.delayed(const Duration(milliseconds: 5));
        expect(result.sources.single.entries, hasLength(30000));
        if (run > 0) {
          elapsed.add(duration);
          gaps.add(maximumGap);
        }
      } finally {
        ticker.cancel();
      }
    }
    elapsed.sort();
    gaps.sort();
    // Scheduling observations, not a native-frame or CI latency assertion.
    // ignore: avoid_print
    print(
      'OpenCode / 30000 sessions / debug: median scan ${elapsed[2]} us; '
      'median maximum caller event-loop gap ${gaps[2]} us',
    );
  }, skip: Platform.environment['HARNESS_USAGE_BENCHMARK'] != '1');

  test('repeated overview reads of 60000 synthetic turns', () async {
    final now = DateTime(2026, 9, 20, 12);
    final controller = UsageLedgerController(
      stores: [
        for (final provider in LedgerProvider.values)
          UsageLedgerStore(
            scanner: FakeScanner(
              provider,
              LedgerScanResult(
                sources: [
                  sourceOf(
                    '${provider.name}.jsonl',
                    List.generate(
                      20000,
                      (i) => entryOf(
                        provider: provider,
                        dedupeKey: '${provider.name}-$i',
                        sessionId: 'session-${i ~/ 40}',
                        timestamp: now
                            .subtract(Duration(hours: i % 2160))
                            .toIso8601String(),
                        model: provider == LedgerProvider.claude
                            ? 'claude-opus-5'
                            : 'gpt-5',
                      ),
                    ),
                  ),
                ],
              ),
            ),
            settings: MemorySettings(),
            snapshots: MemorySnapshotStore(),
          ),
      ],
    );
    addTearDown(controller.dispose);
    await controller.load();
    for (final store in controller.stores) {
      await store.setEnabled(true);
    }
    for (var i = 0; i < 8; i++) {
      controller.overviewFor(UsageRange.d30, now: now);
    }
    final times = <int>[];
    for (var i = 0; i < 60; i++) {
      final watch = Stopwatch()..start();
      final result = controller.overviewFor(UsageRange.d30, now: now);
      times.add(watch.elapsedMicroseconds);
      expect(result.enabledCount, 3);
      expect(result.totals.total, greaterThan(0));
    }
    times.sort();
    // Report only: shared-machine timing is not a pass/fail latency target.
    // ignore: avoid_print
    print(
      'usage overview / 60000 turns / warm debug CPU: '
      'median ${times[30]} us; p95 ${times[57]} us',
    );
  }, skip: Platform.environment['HARNESS_USAGE_BENCHMARK'] != '1');
}
