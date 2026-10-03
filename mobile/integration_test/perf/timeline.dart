import 'dart:math' as math;

/// Folds a VM timeline into its costliest events, by thread.
///
/// Complete (`X`) events carry their duration; begin/end (`B`/`E`) pairs are
/// matched per thread with a stack. Each event is charged both INCLUSIVE time
/// (all of it) and SELF time (minus the events nested inside it on the same
/// thread) — with per-widget build and per-render-object layout/paint events on,
/// a parent's inclusive time repeats all of its children's, so self time is the
/// one that names where the work actually is.
///
/// The raw timeline stays on the phone: a few seconds of every stream runs to
/// megabytes, and the ranking is what the report needs.
Map<String, Object?> summarizeTimeline(
  List<Map<String, dynamic>> events, {
  int top = 40,
}) {
  final threadNames = <Object, String>{};
  for (final event in events) {
    if (event['ph'] == 'M' && event['name'] == 'thread_name') {
      final args = event['args'];
      if (args is Map && args['name'] != null) {
        threadNames[event['tid'] as Object] = args['name'].toString();
      }
    }
  }
  String threadOf(Object? tid) {
    final name = threadNames[tid] ?? '$tid';
    if (name.contains('raster')) return 'raster';
    if (name.contains('.ui') || name.endsWith('ui')) return 'ui';
    if (name.contains('io.flutter.1.io')) return 'io';
    if (name.contains('platform') || name.contains('main')) return 'platform';
    return name;
  }

  final totals = <String, _Tally>{};
  void charge(String thread, String name, int inclusive, int self) {
    final key = '$thread · $name';
    (totals[key] ??= _Tally(thread, name)).add(inclusive, self);
  }

  // Per thread: the open B events and, for each, the time its children used.
  final open = <Object?, List<({String name, int ts, List<int> child})>>{};
  // Complete events, to be nested by time after the pass.
  final complete = <Object?, List<({String name, int ts, int dur})>>{};
  // By time, and by position among equal times: List.sort is not stable, and a
  // begin and an end stamped alike must keep their order.
  final indexed =
      [
        for (final (index, event) in events.indexed)
          if (event['ts'] is num) (index: index, event: event),
      ]..sort((a, b) {
        final byTime = (a.event['ts'] as num).compareTo(b.event['ts'] as num);
        return byTime != 0 ? byTime : a.index.compareTo(b.index);
      });
  for (final (index: _, :event) in indexed) {
    final ph = event['ph'];
    final tid = event['tid'];
    final ts = (event['ts'] as num?)?.toInt();
    if (ts == null) continue;
    final name = event['name']?.toString() ?? '?';
    switch (ph) {
      case 'X':
        final dur = (event['dur'] as num?)?.toInt() ?? 0;
        (complete[tid] ??= []).add((name: name, ts: ts, dur: dur));
      case 'B':
        (open[tid] ??= []).add((name: name, ts: ts, child: [0]));
      case 'E':
        final stack = open[tid];
        if (stack == null || stack.isEmpty) continue;
        final frame = stack.removeLast();
        final dur = math.max(0, ts - frame.ts);
        charge(
          threadOf(tid),
          frame.name,
          dur,
          math.max(0, dur - frame.child[0]),
        );
        if (stack.isNotEmpty) stack.last.child[0] += dur;
    }
  }
  for (final MapEntry(key: tid, value: list) in complete.entries) {
    list.sort(
      (a, b) => a.ts != b.ts ? a.ts.compareTo(b.ts) : b.dur.compareTo(a.dur),
    );
    final stack = <({int end, List<int> child})>[];
    final selfOf = List<int>.filled(list.length, 0);
    final parents = <int>[];
    for (var i = 0; i < list.length; i++) {
      final e = list[i];
      while (stack.isNotEmpty && e.ts >= stack.last.end) {
        stack.removeLast();
        parents.removeLast();
      }
      if (parents.isNotEmpty) selfOf[parents.last] -= e.dur;
      selfOf[i] += e.dur;
      stack.add((end: e.ts + e.dur, child: [0]));
      parents.add(i);
    }
    for (var i = 0; i < list.length; i++) {
      charge(threadOf(tid), list[i].name, list[i].dur, math.max(0, selfOf[i]));
    }
  }

  List<Map<String, Object?>> rank(int Function(_Tally) by) {
    final sorted = totals.values.toList()
      ..sort((a, b) => by(b).compareTo(by(a)));
    return [for (final tally in sorted.take(top)) tally.toJson()];
  }

  return {
    'events': events.length,
    'threads': threadNames.values.toSet().toList()..sort(),
    'bySelfTime': rank((t) => t.self),
    'byInclusiveTime': rank((t) => t.inclusive),
  };
}

class _Tally {
  _Tally(this.thread, this.name);

  final String thread;
  final String name;
  int count = 0;
  int inclusive = 0;
  int self = 0;
  int maxInclusive = 0;

  void add(int inclusiveMicros, int selfMicros) {
    count++;
    inclusive += inclusiveMicros;
    self += selfMicros;
    maxInclusive = math.max(maxInclusive, inclusiveMicros);
  }

  Map<String, Object?> toJson() => {
    'thread': thread,
    'name': name,
    'count': count,
    'selfMs': self / 1000,
    'inclusiveMs': inclusive / 1000,
    'maxInclusiveMs': maxInclusive / 1000,
  };
}
