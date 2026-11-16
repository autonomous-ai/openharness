/// Reads the `speed` lines [SpeedMarks] wrote to the app log and answers how
/// long opening the app took, step by step (task #3176). Pure Dart, so
/// `tool/speed_report.dart` runs it outside the app.
library;

class LaunchStep {
  const LaunchStep(this.name, this.atMs, this.tookMs);
  final String name;

  /// Milliseconds since the app started.
  final int atMs;

  /// Milliseconds since the step before it.
  final int tookMs;
}

class SpeedReport {
  SpeedReport(this.launch);

  /// The last launch in the log, in the order its steps were reached.
  final List<LaunchStep> launch;

  static final _line = RegExp(r'(?:^|[\s\[])speed\]?\s+launch\s+(.+?)\s*$');

  static SpeedReport parse(Iterable<String> lines) {
    var steps = <(String, int)>[];
    for (final text in lines) {
      final match = _line.firstMatch(text);
      if (match == null) continue;
      final fields = {
        for (final pair in match.group(1)!.split(' '))
          if (pair.contains('='))
            pair.substring(0, pair.indexOf('=')): pair.substring(
              pair.indexOf('=') + 1,
            ),
      };
      final step = fields['step'];
      final ms = int.tryParse(fields['ms'] ?? '');
      if (step == null || ms == null) continue;
      // A new launch: what an earlier one reached is not this one's.
      if (step == 'started') steps = [];
      steps.add((step, ms));
    }
    final launch = <LaunchStep>[];
    var before = 0;
    for (final (name, at) in steps) {
      launch.add(LaunchStep(name, at, at - before));
      before = at;
    }
    return SpeedReport(launch);
  }

  /// The three steps of launch that took longest after the step before.
  List<LaunchStep> get slowestLaunch => ([
    ...launch,
  ]..sort((a, b) => b.tookMs.compareTo(a.tookMs))).take(3).toList();

  String markdown() {
    final out = StringBuffer();
    out.writeln('| Step | Took | At |');
    out.writeln('| --- | --- | --- |');
    for (final s in launch) {
      out.writeln('| ${s.name} | ${s.tookMs} ms | ${s.atMs} ms |');
    }
    out.writeln();
    out.writeln('Three slowest launch steps (time since the step before):');
    out.writeln();
    out.writeln('| Step | Took | At |');
    out.writeln('| --- | --- | --- |');
    for (final s in slowestLaunch) {
      out.writeln('| ${s.name} | ${s.tookMs} ms | ${s.atMs} ms |');
    }
    return out.toString();
  }
}
