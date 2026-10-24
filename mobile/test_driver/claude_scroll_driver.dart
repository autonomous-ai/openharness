// A command-line driver; printing is its interface.
// ignore_for_file: avoid_print

import 'dart:convert';
import 'dart:io';

import 'package:integration_test/integration_test_driver.dart';

/// Host side of `integration_test/claude_scroll_test.dart`: writes the phone's
/// results to `HARNESS_SCROLL_OUT` (default `build/claude_scroll/`) as
/// `<HARNESS_SCROLL_LABEL>-<UTC time>.json`, never over an earlier run, and
/// prints the summary.
Future<void> main() => integrationDriver(
  timeout: const Duration(minutes: 20),
  writeResponseOnFailure: true,
  responseDataCallback: (data) async {
    if (data == null) {
      print('[scroll] the phone reported no data');
      return;
    }
    final env = Platform.environment;
    final directory = Directory(
      env['HARNESS_SCROLL_OUT'] ?? 'build/claude_scroll',
    );
    await directory.create(recursive: true);
    final label = env['HARNESS_SCROLL_LABEL'] ?? 'run';
    final stamp = DateTime.now()
        .toUtc()
        .toIso8601String()
        .replaceAll(RegExp(r'[:\-]'), '')
        .split('.')
        .first;
    var file = File('${directory.path}/$label-${stamp}Z.json');
    for (var n = 2; file.existsSync(); n++) {
      file = File('${directory.path}/$label-${stamp}Z-$n.json');
    }
    await file.writeAsString(const JsonEncoder.withIndent('  ').convert(data));
    print('[scroll] wrote ${file.path}');
    print('[scroll] summary ${jsonEncode(data['summary'])}');
    if (data['failures'] case final Map<String, dynamic> failures
        when failures.isNotEmpty) {
      print('[scroll] FAILED $failures');
    }
  },
);
