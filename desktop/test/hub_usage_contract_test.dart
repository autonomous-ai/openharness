import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/measurement/hub_usage.dart';

/// `hub_usage.dart` counts a shared link with names the backend must accept; a counter it does
/// not know fails the whole report. This reads the backend's own source.
void main() {
  late String contract;
  setUpAll(() {
    final file = File('../backend/src/lib/hubMetricsContract.ts');
    if (!file.existsSync()) {
      throw StateError(
        '${file.path} missing — run from desktop/ in the monorepo',
      );
    }
    contract = file.readAsStringSync();
  });

  List<String> list(String name) {
    final from = contract.indexOf('export const $name = [');
    if (from < 0) {
      throw StateError('"$name" is gone from hubMetricsContract.ts');
    }
    final body = contract.substring(from, contract.indexOf('] as const', from));
    return RegExp(r"'([a-z0-9_]+)'")
        .allMatches(body)
        .map((m) => m[1]!)
        .toList();
  }

  test('a shared link\'s counters are the backend\'s', () {
    expect(list('HUB_VIEW_PAGES'), contains('shared'));
    expect(list('HUB_READERS'), ['visitor', 'member']);
    expect(SharedOpen.values.map((o) => o.wire), list('HUB_SHARED_OPENS'));
    expect(
      SharedAction.values.map((a) => 'shared_${a.wire}'),
      list('HUB_ACTIONS').where((a) => a.startsWith('shared_')),
    );
    expect(list('HUB_DWELL'), ['under_10s', '10s_to_1m', 'over_1m']);
    expect(contract, contains('hub_shared_open_\${open}'));
    expect(contract, contains('hub_shared_dwell_\${bucket}'));
    expect(
      RegExp(r'HUB_REPORT_MAX_VALUE = (\d+)').firstMatch(contract)![1],
      '$hubReportMaxValue',
    );
  });
}
