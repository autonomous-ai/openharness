import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/ledger/device_usage.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/usage_overview.dart';

void main() {
  final now = DateTime(2026, 10, 6, 12);
  test('freshness uses wire milliseconds at the five-minute boundary', () {
    final at = DateTime(2026, 10, 6, 12, 0, 0, 0, 900);
    final scan = DateTime(2026, 10, 6, 11, 55, 0, 0, 100);
    final result = projectDeviceUsage(
      machineId: 'local',
      machineName: 'This Mac',
      now: at,
      ledgers: const [ProviderLedger(provider: LedgerProvider.claude)],
      states: [
        LedgerScanState(
          provider: LedgerProvider.claude,
          enabled: true,
          status: LedgerStatus.ok,
          lastScanAt: scan,
        ),
      ],
    );
    expect(
      (result['generatedAtMs'] as int) - (result['asOfMs'] as int),
      300000,
    );
    expect(result['stale'], false);
    expect((result['providers'] as List).map((p) => p['id']), [
      'claude',
      'codex',
      'opencode',
    ]);
  });
  LedgerEntry entry(DateTime time, {double? cost = 1, String? model}) =>
      LedgerEntry(
        provider: LedgerProvider.claude,
        sessionId: 'private-session',
        timestamp: time,
        totals: const UsageTotals(output: 100),
        costUsd: cost,
        model: model,
        directory: '/private/path',
      );
  Map<String, dynamic> project({
    List<LedgerEntry> entries = const [],
    LedgerStatus status = LedgerStatus.ok,
    bool enabled = true,
    DateTime? scan,
    List<LedgerScanState> extra = const [],
  }) => projectDeviceUsage(
    machineId: 'local',
    machineName: '猫' * 100,
    now: now,
    ledgers: [ledgerFromEntries(LedgerProvider.claude, entries)],
    states: [
      LedgerScanState(
        provider: LedgerProvider.claude,
        enabled: enabled,
        status: status,
        lastScanAt: scan ?? now,
      ),
      ...extra,
    ],
  );
  test('clips the local calendar day, preserves known zero, and sends no transcript fields', () {
    final result = project(
      entries: [
        entry(DateTime(2026, 10, 5, 23, 59), cost: 30),
        entry(DateTime(2026, 10, 6), cost: 0),
        entry(now, cost: 2),
        entry(DateTime(2026, 10, 7), cost: 100),
      ],
    );
    expect(result['costUsd'], 2);
    expect(result['coverage'], 'complete');
    expect(result['day'], '2026-10-06');
    expect(result['windowEndMs'], DateTime(2026, 10, 7).millisecondsSinceEpoch);
    expect(utf8.encode(result['machineName'] as String).length, 39);
    final json = jsonEncode(result);
    expect(json.length, lessThan(1800));
    expect(json, isNot(contains('/private')));
    expect(json, isNot(contains('private-session')));
    expect(project()['costUsd'], 0);
    expect(project(entries: [entry(now, cost: 0)])['costUsd'], 0);
  });
  test('off, failures, prior-day cache and partial empty scans never establish zero', () {
    for (final result in [
      project(enabled: false),
      project(status: LedgerStatus.failed),
      project(status: LedgerStatus.unavailable),
      project(status: LedgerStatus.partial),
      project(scan: DateTime(2026, 10, 5, 23, 59)),
      project(scan: now.add(const Duration(seconds: 1))),
    ]) {
      expect(result.containsKey('costUsd'), false);
      expect(result.containsKey('asOfMs'), false);
      expect(result['coverage'], 'unavailable');
      expect(result['stale'], true);
    }
  });
  test(
    'unpriced is missing, while a known subtotal stays partial even at zero',
    () {
      final unknown = entry(now, cost: null, model: 'unknown-model');
      expect(project(entries: [unknown]).containsKey('costUsd'), false);
      final result = project(entries: [unknown, entry(now, cost: 0)]);
      expect(result['costUsd'], 0);
      expect(result['coverage'], 'partial');
      expect((result['providers'] as List).first['priced'], false);
    },
  );
  test('other enabled failures qualify the subtotal; freshness follows its oldest source', () {
    final result = project(
      entries: [entry(now.subtract(const Duration(minutes: 20)))],
      scan: now.subtract(const Duration(minutes: 10)),
      extra: [
        LedgerScanState(
          provider: LedgerProvider.codex,
          enabled: true,
          status: LedgerStatus.failed,
          lastScanAt: now,
        ),
      ],
    );
    expect(result['coverage'], 'partial');
    expect(result['costUsd'], 1);
    expect(
      result['asOfMs'],
      now.subtract(const Duration(minutes: 10)).millisecondsSinceEpoch,
    );
    expect(result['stale'], true);
  });
}
