import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/ledger/ledger_scanner.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/usage_overview.dart';

import 'usage_jsonl_scanners_test.dart'
    show jsonlRoot, jsonlRow, jsonlScanner, sourcesOf;

Future<({int elapsed, int gap})> observeLoop(
  Future<void> Function() operation,
) async {
  final watch = Stopwatch()..start();
  var previous = 0;
  var maximum = 0;
  final timer = Timer.periodic(const Duration(milliseconds: 1), (_) {
    final now = watch.elapsedMicroseconds;
    final gap = now - previous;
    if (gap > maximum) maximum = gap;
    previous = now;
  });
  try {
    await operation();
    final elapsed = watch.elapsedMicroseconds;
    await Future<void>.delayed(const Duration(milliseconds: 5));
    return (elapsed: elapsed, gap: maximum);
  } finally {
    timer.cancel();
  }
}

void main() {
  for (final provider in [LedgerProvider.claude, LedgerProvider.codex]) {
    test('${provider.label} cold, cached, and aggregation event-loop timing', () async {
      final fixture = await Directory.systemTemp.createTemp(
        'harness-jsonl-timing-',
      );
      addTearDown(() => fixture.delete(recursive: true));
      final file = File('${jsonlRoot(provider, fixture.path)}/fixture.jsonl');
      await file.parent.create(recursive: true);
      final content = StringBuffer();
      // A large tool result plus 20,000 distinct usage events, entirely synthetic.
      content.writeln(
        jsonEncode({
          'type': 'tool_result',
          'text': 'assistant ${'x' * (2 * 1024 * 1024)}',
        }),
      );
      for (var i = 1; i <= 20000; i++) {
        content.writeln(jsonlRow(provider, i));
      }
      await file.writeAsString(content.toString());
      final scanner = jsonlScanner(provider, fixture.path);
      var result = const LedgerScanResult();
      for (final mode in ['cold', 'cached', 'aggregate']) {
        final samples = <({int elapsed, int gap})>[];
        for (var i = 0; i < 6; i++) {
          final reading = await observeLoop(() async {
            if (mode == 'aggregate') {
              expect(
                buildProviderLedger(provider, result.sources).entries,
                hasLength(20000),
              );
            } else {
              result = await scanner.scan(
                mode == 'cached' ? sourcesOf(result) : {},
              );
              expect(result.sources.single.entries, hasLength(20000));
            }
          });
          if (i > 0) samples.add(reading);
        }
        final elapsed = samples.map((sample) => sample.elapsed).toList()
          ..sort();
        final gaps = samples.map((sample) => sample.gap).toList()..sort();
        // Report only; shared-machine scheduling is not a CI timing gate.
        // ignore: avoid_print
        print(
          '${provider.label} / 20000 turns / $mode / debug: median ${elapsed[2]} us; '
          'median maximum caller event-loop gap ${gaps[2]} us',
        );
      }
    }, skip: Platform.environment['HARNESS_USAGE_BENCHMARK'] != '1');
  }
}
