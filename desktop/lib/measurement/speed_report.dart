/// Reads the `speed` lines [SpeedMarks] wrote to the app log and answers the
/// three questions of the speed plan (task #3176). Pure Dart, so
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

class MessageRead {
  const MessageRead(this.kind, this.rows, this.requestMs, this.totalMs);
  final String kind;
  final int rows;
  final int requestMs;
  final int totalMs;
}

class ImageFetch {
  const ImageFetch(this.ok, this.bytes, this.ms);
  final bool ok;
  final int bytes;
  final int ms;
}

class SpeedReport {
  SpeedReport(this.launch, this.reads, this.images);

  /// The last launch in the log, in the order its steps were reached.
  final List<LaunchStep> launch;
  final List<MessageRead> reads;
  final List<ImageFetch> images;

  static final _line = RegExp(
    r'(?:^|[\s\[])speed\]?\s+(launch|messages|image)\s+(.+?)\s*$',
  );

  static SpeedReport parse(Iterable<String> lines) {
    var steps = <(String, int)>[];
    final reads = <MessageRead>[];
    final images = <ImageFetch>[];
    for (final text in lines) {
      final match = _line.firstMatch(text);
      if (match == null) continue;
      final fields = {
        for (final pair in match.group(2)!.split(' '))
          if (pair.contains('='))
            pair.substring(0, pair.indexOf('=')): pair.substring(
              pair.indexOf('=') + 1,
            ),
      };
      int? number(String key) => int.tryParse(fields[key] ?? '');
      switch (match.group(1)) {
        case 'launch':
          final step = fields['step'];
          final ms = number('ms');
          if (step == null || ms == null) continue;
          if (step == 'started') steps = [];
          steps.add((step, ms));
        case 'messages':
          final rows = number('rows');
          final request = number('request_ms');
          final total = number('total_ms');
          if (fields['kind'] == null ||
              rows == null ||
              request == null ||
              total == null) {
            continue;
          }
          reads.add(MessageRead(fields['kind']!, rows, request, total));
        case 'image':
          final ms = number('ms');
          final bytes = number('bytes');
          if (ms == null || bytes == null) continue;
          images.add(ImageFetch(fields['ok'] == '1', bytes, ms));
      }
    }
    final launch = <LaunchStep>[];
    var before = 0;
    for (final (name, at) in steps) {
      launch.add(LaunchStep(name, at, at - before));
      before = at;
    }
    return SpeedReport(launch, reads, images);
  }

  /// The three steps of launch that took longest after the step before.
  List<LaunchStep> get slowestLaunch => ([
    ...launch,
  ]..sort((a, b) => b.tookMs.compareTo(a.tookMs))).take(3).toList();

  /// The three message reads that took longest, whole.
  List<MessageRead> get slowestReads => ([
    ...reads,
  ]..sort((a, b) => b.totalMs.compareTo(a.totalMs))).take(3).toList();

  /// Opening the app to the first chat on screen, or null if never reached.
  int? get launchToFirstChatMs => launch
      .where((s) => s.name == 'first_chat_painted')
      .map((s) => s.atMs)
      .firstOrNull;

  int get imageBytes =>
      images.where((i) => i.ok).fold(0, (n, i) => n + i.bytes);

  static int _percentile(List<int> sorted, double p) =>
      sorted.isEmpty ? 0 : sorted[((sorted.length - 1) * p).round()];

  String markdown() {
    final out = StringBuffer();
    final first = launchToFirstChatMs;
    out.writeln('| Measure | Value |');
    out.writeln('| --- | --- |');
    out.writeln(
      '| Open the app to a painted chat | '
      '${first == null ? 'not reached' : '$first ms'} |',
    );
    final latest = reads.where((r) => r.kind == 'latest').firstOrNull;
    final older = reads.where((r) => r.kind == 'older').toList();
    out.writeln(
      '| Big chat, first page | '
      '${latest == null ? 'not read' : '${latest.totalMs} ms (${latest.rows} rows, request ${latest.requestMs} ms)'} |',
    );
    if (older.isNotEmpty) {
      final times = older.map((r) => r.totalMs).toList()..sort();
      out.writeln(
        '| Big chat, scroll-up pages | ${older.length} pages, '
        'median ${_percentile(times, .5)} ms, slowest ${times.last} ms |',
      );
    }
    final ok = images.where((i) => i.ok).toList();
    final ms = ok.map((i) => i.ms).toList()..sort();
    out.writeln(
      '| Images | ${ok.length} loaded'
      '${images.length > ok.length ? ', ${images.length - ok.length} failed' : ''}'
      ', $imageBytes bytes'
      '${ok.isEmpty ? '' : ', median ${_percentile(ms, .5)} ms, p95 ${_percentile(ms, .95)} ms, slowest ${ms.last} ms'} |',
    );
    out.writeln();
    out.writeln('Three slowest launch steps (time since the step before):');
    out.writeln();
    out.writeln('| Step | Took | At |');
    out.writeln('| --- | --- | --- |');
    for (final s in slowestLaunch) {
      out.writeln('| ${s.name} | ${s.tookMs} ms | ${s.atMs} ms |');
    }
    out.writeln();
    out.writeln('Three slowest message reads:');
    out.writeln();
    out.writeln('| Kind | Rows | Request | Total |');
    out.writeln('| --- | --- | --- | --- |');
    for (final r in slowestReads) {
      out.writeln(
        '| ${r.kind} | ${r.rows} | ${r.requestMs} ms | ${r.totalMs} ms |',
      );
    }
    return out.toString();
  }
}
