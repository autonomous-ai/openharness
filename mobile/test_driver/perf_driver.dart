// A command-line driver; printing is its interface.
// ignore_for_file: avoid_print

import 'dart:convert';
import 'dart:io';

import 'package:integration_test/integration_test_driver.dart';

/// Host side of `integration_test/perf_test.dart`: waits for the phone's
/// results and writes them, never over an earlier run.
///
/// Where: `HARNESS_PERF_OUT` (relative to `mobile/`), by default
/// `../docs/performance/2026-09-26-mobile-data`. Named
/// `<HARNESS_PERF_LABEL>-<UTC time>.json`, the label `baseline` unless set —
/// `after` for the redesign, say. A run with a failed scenario is written to
/// `failed/` under the same directory: it is kept for review, but the
/// summarizer does not pool it.
Future<void> main() => integrationDriver(
  timeout: const Duration(minutes: 25),
  writeResponseOnFailure: true,
  responseDataCallback: (data) async {
    if (data == null) {
      print('[perf] the phone reported no data');
      return;
    }
    final env = Platform.environment;
    final root = env['HARNESS_PERF_OUT'] ?? '../docs/performance/2026-09-26-mobile-data';
    final label = env['HARNESS_PERF_LABEL'] ?? 'baseline';
    final failed = data['success'] != true;
    final directory = Directory(failed ? '$root/failed' : root);
    await directory.create(recursive: true);
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
    data['host'] = await _host();
    await file.writeAsString(const JsonEncoder.withIndent('  ').convert(data));
    print('[perf] wrote ${file.path}');
    if (failed) print('[perf] FAILED scenarios: ${(data['failures'] as Map).keys}');
  },
);

/// What built the run: the source revision, whether the app's sources had
/// uncommitted edits, and the Flutter SDK. No paths or names from this Mac.
Future<Map<String, Object?>> _host() async {
  Future<String?> git(List<String> args) async {
    try {
      final result = await Process.run('git', args);
      return result.exitCode == 0 ? (result.stdout as String).trim() : null;
    } on ProcessException {
      return null;
    }
  }

  String? flutter;
  final sdk = Platform.environment['FLUTTER_ROOT'];
  if (sdk != null) {
    final version = File('$sdk/bin/cache/flutter.version.json');
    if (version.existsSync()) {
      final json = jsonDecode(version.readAsStringSync()) as Map<String, dynamic>;
      flutter = '${json['frameworkVersion']} (${json['frameworkRevision']}), '
          'Dart ${json['dartSdkVersion']}';
    }
  }
  final dirty = await git(['status', '--porcelain', '--', 'lib', 'third_party']);
  return {
    'revision': await git(['rev-parse', 'HEAD']),
    'appSourcesModified': dirty?.isNotEmpty,
    'flutter': flutter,
    'device': Platform.environment['HARNESS_PERF_DEVICE'],
  };
}
