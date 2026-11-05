// ignore_for_file: avoid_print
// Prints the speed table from the app log (task #3176): the time from opening
// Desktop to a painted chat, a large chat's first page and scroll-up pages,
// and each picture's time and bytes, with the three slowest steps of launch
// and of message load named.
//
//   dart run tool/speed_report.dart [app-log-file ...]
//
// Without arguments it reads today's and yesterday's `~/.harness/logs/app-*.log`.
// Open the app, open the big chat, scroll up through its history, scroll an
// image-heavy chat, then run this. It reads `speed` lines only: counts,
// milliseconds and bytes, never a name, path or message.
import 'dart:io';

import 'package:harness/measurement/speed_report.dart';

void main(List<String> args) {
  final files = args.isNotEmpty
      ? args.map(File.new).toList()
      : _recentLogs(Platform.environment['HOME'] ?? '.');
  if (files.isEmpty) {
    print('No app log found. Open Desktop first.');
    exitCode = 1;
    return;
  }
  final lines = <String>[];
  for (final file in files) {
    if (file.existsSync()) lines.addAll(file.readAsLinesSync());
  }
  final report = SpeedReport.parse(lines);
  if (report.launch.isEmpty && report.reads.isEmpty && report.images.isEmpty) {
    print('No speed lines in ${files.length} log file(s).');
    exitCode = 1;
    return;
  }
  print(report.markdown());
}

List<File> _recentLogs(String home) {
  final dir = Directory('$home/.harness/logs');
  if (!dir.existsSync()) return const [];
  final logs =
      dir
          .listSync()
          .whereType<File>()
          .where((f) => RegExp(r'app-\d{8}\.log$').hasMatch(f.path))
          .toList()
        ..sort((a, b) => a.path.compareTo(b.path));
  return logs.length > 2 ? logs.sublist(logs.length - 2) : logs;
}
