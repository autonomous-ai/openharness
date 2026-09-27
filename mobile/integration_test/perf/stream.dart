import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'claude_output.dart';
import 'fixture.dart';
import 'frames.dart';

/// Which output an agent is producing.
enum StreamLoad {
  /// Claude Code's live region (8 rows) erased and redrawn in place at 20 Hz —
  /// the desktop benchmark's load, in Claude's shape.
  redraw,

  /// Three long prose lines appended per burst at 20 Hz (~60 lines/s, each
  /// wrapping several times), with the live region redrawn under them.
  append,
}

/// Feeds one terminal at 20 Hz, the desktop benchmark's producer: a periodic
/// timer, and a burst that is still being taken in when the next is due is
/// SKIPPED and counted rather than queued. Achieved bytes are what to read.
///
/// Every burst is generated and encoded before the pump starts, so the only
/// work the timer adds to this thread is the app's own: the session taking the
/// frame in.
class OutputPump {
  OutputPump(this.terminal, this.output, this.load, {int seconds = 30})
    : _bursts = [
        for (var tick = 0; tick < seconds * 20; tick++)
          _encoded(
            load == StreamLoad.redraw
                ? output.redrawBurst(tick + 1)
                : output.appendBurst(tick + 1),
          ),
      ];

  static ({Uint8List bytes, bool compressed, int plain}) _encoded(String text) {
    final body = FixtureTerminal.encode(text);
    return (
      bytes: body.bytes,
      compressed: body.compressed,
      plain: utf8.encode(text).length,
    );
  }

  final FixtureTerminal terminal;
  final ClaudeOutput output;
  final StreamLoad load;
  final List<({Uint8List bytes, bool compressed, int plain})> _bursts;

  Timer? _timer;
  bool _pending = false;
  int _next = 0;

  /// Encoded bytes handed to the session, as on the wire.
  int wireBytes = 0;
  int bursts = 0;
  int skipped = 0;

  /// Per burst: wall time it was handed over, how long the session took, and
  /// its size on the wire and decoded.
  final List<({int atWall, int micros, int wire, int plain})> takes = [];

  void start() {
    _timer = Timer.periodic(const Duration(milliseconds: 50), (_) async {
      if (_pending) {
        skipped++;
        return;
      }
      _pending = true;
      try {
        final body = _bursts[_next++ % _bursts.length];
        final at = wallMicros();
        final micros = await terminal.output((
          bytes: body.bytes,
          compressed: body.compressed,
        ));
        takes.add((
          atWall: at,
          micros: micros,
          wire: body.bytes.length,
          plain: body.plain,
        ));
        wireBytes += body.bytes.length;
        bursts++;
      } finally {
        _pending = false;
      }
    });
  }

  Future<void> stop() async {
    _timer?.cancel();
    _timer = null;
    while (_pending) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  /// What was produced in [startWall, endWall): bytes and the session's cost.
  Map<String, Object?> window(int startWall, int endWall) {
    final inside = [
      for (final take in takes)
        if (take.atWall >= startWall && take.atWall < endWall) take,
    ];
    final seconds = (endWall - startWall) / 1e6;
    final plain = inside.fold<int>(0, (sum, t) => sum + t.plain);
    final wire = inside.fold<int>(0, (sum, t) => sum + t.wire);
    return {
      'load': load.name,
      'decodedBytesPerSecond': plain / seconds,
      'wireBytesPerSecond': wire / seconds,
      'meanDecodedBytesPerBurst': inside.isEmpty ? 0 : plain / inside.length,
      'burstsInWindow': inside.length,
      'skippedTotal': skipped,
      'burstsPerSecond': inside.length / seconds,
      'sessionTakeMs': distribution([for (final t in inside) t.micros]),
      'sessionTakeRawUs': [for (final t in inside) t.micros],
    };
  }
}
