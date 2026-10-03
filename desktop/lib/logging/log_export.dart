import 'dart:convert';

import '../core/harness_cli_runner.dart';
import 'app_log.dart';

/// What `harness logs export --json` answered.
class LogExportResult {
  const LogExportResult({this.path, this.included = const [], this.error});

  /// The zip on disk, or null when the export failed.
  final String? path;
  final List<String> included;
  final String? error;
}

/// Runs `harness logs export --json` through [runner] and reads its one line.
///
/// The CLI owns the bundle (`cli/src/lib/logBundle.ts`): it knows where the
/// daemon's `harness.log` is, it writes the dial's log, and a terminal with no
/// window needs the same export. This app adds nothing to it but a button.
Future<LogExportResult> exportLogs(HarnessCliRunner runner) async {
  try {
    flushAppLog();
    final result = await runner.run(const ['logs', 'export', '--json']);
    final out = (result.stdout as String).trim();
    if (result.exitCode != 0 || out.isEmpty) {
      final err = (result.stderr as String).trim();
      return LogExportResult(
        error: err.isEmpty ? 'harness exited ${result.exitCode}' : err,
      );
    }
    return parseLogExport(out.split('\n').last);
  } on Object catch (e) {
    return LogExportResult(error: '$e');
  }
}

/// `{"path":…,"included":[…],"bytes":…}` → [LogExportResult]. Pure, for tests.
LogExportResult parseLogExport(String line) {
  try {
    final json = jsonDecode(line);
    if (json is! Map<String, dynamic>) {
      return const LogExportResult(error: 'unexpected answer');
    }
    final path = json['path'];
    final included = json['included'];
    return LogExportResult(
      path: path is String ? path : null,
      included: included is List
          ? included.map((e) => '$e').toList()
          : const [],
      error: path is String ? null : 'no path in answer',
    );
  } on FormatException {
    return LogExportResult(error: 'unreadable answer: $line');
  }
}
