// Run with `dart run tool/log_append_probe.dart`. Only private temporary files
// and owned child processes are used; no app, daemon or user session is started.
import 'dart:convert';
import 'dart:io';

import 'package:harness/logging/log_append.dart';

Future<void> main(List<String> args) async {
  const records = 500;
  const writers = 4;
  if (args.length == 3 && args.first == '--worker') {
    final file = File(args[1]);
    final writer = int.parse(args[2]);
    for (var i = 0; i < records; i++) {
      appendDurableLog(file, 'writer $writer record $i 🦋\n');
    }
    return;
  }
  if (args.isNotEmpty) throw ArgumentError('Unexpected arguments');
  if (!Platform.isMacOS && !Platform.isLinux) {
    throw UnsupportedError('Atomic append probe requires macOS or Linux');
  }
  final directory = Directory.systemTemp.createTempSync('harness-log-process-');
  try {
    final file = File('${directory.path}/shared 日本語.log');
    final results = await Future.wait([
      for (var writer = 0; writer < writers; writer++)
        Process.run(Platform.resolvedExecutable, [
          if (Platform.packageConfig case final packages?)
            '--packages=$packages',
          Platform.script.toFilePath(),
          '--worker',
          file.path,
          '$writer',
        ]),
    ]);
    for (final result in results) {
      if (result.exitCode != 0) {
        throw StateError('Writer failed: ${result.stderr}');
      }
    }
    final lines = file.readAsLinesSync();
    if (lines.length != writers * records) {
      throw StateError(
        'Expected ${writers * records} records, got ${lines.length}',
      );
    }
    for (var writer = 0; writer < writers; writer++) {
      final found = lines.where((line) => line.startsWith('writer $writer '));
      final expected = List.generate(
        records,
        (i) => 'writer $writer record $i 🦋',
      );
      if (found.join('\n') != expected.join('\n')) {
        throw StateError('Writer $writer records were altered or reordered');
      }
    }
    stdout.writeln(
      jsonEncode({
        'platform': Platform.operatingSystem,
        'dart': Platform.version,
        'writers': writers,
        'records': lines.length,
        'allRecordsIntact': true,
      }),
    );
  } finally {
    directory.deleteSync(recursive: true);
  }
}
