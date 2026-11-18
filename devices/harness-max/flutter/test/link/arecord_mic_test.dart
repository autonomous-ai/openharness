// The board's mic: the C bar's level meter (voice_level_feed) on raw PCM, and arecord run as a process the test plays.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/arecord_mic.dart';

/// [blocks] 10 ms blocks of a square wave swinging [peakToPeak] around [dc], as s16le.
Uint8List _wave(int blocks, int peakToPeak, {int dc = 0}) {
  final out = ByteData(blocks * kLevelBlockSamples * 2);
  for (var i = 0; i < blocks * kLevelBlockSamples; i++) {
    final v = dc + (i.isEven ? peakToPeak ~/ 2 : -(peakToPeak - peakToPeak ~/ 2));
    out.setInt16(i * 2, v, Endian.little);
  }
  return out.buffer.asUint8List();
}

List<double> _levels(MicLevelMeter m, Uint8List pcm) {
  final out = <double>[];
  m.feed(pcm, out.add);
  return out;
}

/// arecord, played by the test.
class _FakeArecord implements Process {
  final _stdout = StreamController<List<int>>();
  final _stderr = StreamController<List<int>>();
  final _exit = Completer<int>();
  int kills = 0;

  void audio(List<int> bytes) => _stdout.add(bytes);

  /// Exits by itself, as arecord does on a missing or busy device.
  Future<void> quit(int code, [String why = '']) async {
    if (why.isNotEmpty) _stderr.add(why.codeUnits);
    await _stdout.close();
    await _stderr.close();
    if (!_exit.isCompleted) _exit.complete(code);
  }

  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    kills++;
    // SIGTERM: arecord writes what it holds and exits.
    scheduleMicrotask(() => quit(-15));
    return true;
  }

  @override
  Stream<List<int>> get stdout => _stdout.stream;
  @override
  Stream<List<int>> get stderr => _stderr.stream;
  @override
  Future<int> get exitCode => _exit.future;
  @override
  IOSink get stdin => IOSink(StreamController<List<int>>().sink);
  @override
  int get pid => 4242;
}

class _Starts {
  final List<(String, List<String>)> calls = [];
  final List<_FakeArecord> processes = [];
  bool missing = false;

  Future<Process> call(String exe, List<String> args) async {
    calls.add((exe, args));
    if (missing) throw const ProcessException('arecord', [], 'No such file or directory', 2);
    final p = _FakeArecord();
    processes.add(p);
    return p;
  }
}

void main() {
  group('the level', () {
    test('steps as the C bar\'s: 64, 180, 500, 1600', () {
      expect(
        [
          for (final e in [0, 63, 64, 179, 180, 499, 500, 1599, 1600, 30000]) MicLevelMeter.stepOf(e),
        ],
        [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
      );
    });

    test('comes 20 times a second, 0..1 in quarters', () {
      final m = MicLevelMeter();
      expect(_levels(m, _wave(100, 0)), List.filled(20, 0.0));
      for (final (p2p, level) in [(100, 0.25), (300, 0.5), (1000, 0.75), (5000, 1.0)]) {
        expect(_levels(MicLevelMeter(), _wave(5, p2p)), [level], reason: 'peak-to-peak $p2p');
      }
    });

    test('a DC offset is not sound', () {
      expect(_levels(MicLevelMeter(), _wave(5, 0, dc: 12000)), [0.0]);
      expect(_levels(MicLevelMeter(), _wave(5, 100, dc: -12000)), [0.25]);
    });

    test('falls back slowly after a word, and to nothing', () {
      final m = MicLevelMeter();
      expect(_levels(m, _wave(5, 2000)), [1.0]);
      final after = _levels(m, _wave(200, 0));
      expect(after.first, 1.0);
      for (var i = 1; i < after.length; i++) {
        expect(after[i], lessThanOrEqualTo(after[i - 1]));
      }
      expect(after.toSet(), {1.0, 0.75, 0.5, 0.25, 0.0});
      expect(after.last, 0.0);
    });

    test('a sample split across reads reads the same', () {
      final pcm = Uint8List.fromList([..._wave(7, 400), ..._wave(9, 3000), ..._wave(30, 0)]);
      final whole = _levels(MicLevelMeter(), pcm);
      final m = MicLevelMeter();
      final split = <double>[];
      for (var i = 0; i < pcm.length; i += 3) {
        m.feed(Uint8List.sublistView(pcm, i, i + 3 > pcm.length ? pcm.length : i + 3), split.add);
      }
      expect(split, whole);
      expect(whole, hasLength(9));
    });

    test('reset starts a recording from silence', () {
      final m = MicLevelMeter();
      m.feed(_wave(5, 5000), (_) {});
      m.feed(Uint8List.fromList([1, 2, 3]), (_) {});
      m.reset();
      expect(_levels(m, _wave(5, 0)), [0.0]);
    });
  });

  group('arecord', () {
    test('runs as the C bar records: 16 kHz mono s16le raw from the named device', () async {
      final starts = _Starts();
      final mic = ArecordMic(device: 'plughw:CARD=Device,DEV=0', start: starts.call, log: (_) {});
      final opened = mic.open();
      await pumpEventQueue();
      starts.processes.single.audio([0, 0]);
      expect(await opened, isTrue);
      expect(starts.calls.single.$1, 'arecord');
      expect(starts.calls.single.$2, [
        '-q',
        '-D',
        'plughw:CARD=Device,DEV=0',
        '-f',
        'S16_LE',
        '-c',
        '1',
        '-r',
        '16000',
        '-t',
        'raw',
        '-B',
        '100000', //
      ]);
      expect(mic.sampleRate, 16000);
    });

    test('its audio is the pcm, and the level is metered from it', () async {
      final starts = _Starts();
      final mic = ArecordMic(start: starts.call, log: (_) {});
      final pcm = <int>[];
      final levels = <double>[];
      mic.pcm.listen(pcm.addAll);
      mic.levels.listen(levels.add);
      final opened = mic.open();
      await pumpEventQueue();
      final arecord = starts.processes.single;
      final sound = _wave(10, 1000);
      arecord.audio(sound.sublist(0, 999));
      arecord.audio(sound.sublist(999));
      expect(await opened, isTrue);
      await pumpEventQueue();
      expect(pcm, sound);
      expect(levels, [0.75, 0.75]);
    });

    test('no arecord on the board: not open, and said why', () async {
      final starts = _Starts()..missing = true;
      final log = <String>[];
      final mic = ArecordMic(start: starts.call, log: log.add);
      expect(await mic.open(), isFalse);
      expect(log.single, contains('no arecord'));
    });

    test('an arecord that exits before any audio (no device, or a busy one) is not open, and no error', () async {
      final starts = _Starts();
      final log = <String>[];
      final mic = ArecordMic(start: starts.call, log: log.add);
      final errors = <Object>[];
      mic.pcm.listen((_) {}, onError: errors.add);
      final opened = mic.open();
      await pumpEventQueue();
      await starts.processes.single.quit(1, 'arecord: main:850: audio open error: Device or resource busy');
      expect(await opened, isFalse);
      await pumpEventQueue();
      expect(errors, isEmpty);
      expect(log.single, contains('Device or resource busy'));
      // The next open tries again.
      final again = mic.open();
      await pumpEventQueue();
      expect(starts.processes, hasLength(2));
      starts.processes.last.audio([0, 0]);
      expect(await again, isTrue);
    });

    test('a running arecord with nothing to say yet is open after a second', () async {
      final starts = _Starts();
      final mic = ArecordMic(start: starts.call, log: (_) {});
      final watch = Stopwatch()..start();
      expect(await mic.open(), isTrue);
      expect(watch.elapsed, greaterThanOrEqualTo(ArecordMic.firstAudio));
      await mic.close();
    });

    test('close stops it, delivers what it held, and is no error; open again starts a new one', () async {
      final starts = _Starts();
      final mic = ArecordMic(start: starts.call, log: (_) {});
      final pcm = <int>[];
      final errors = <Object>[];
      mic.pcm.listen(pcm.addAll, onError: errors.add);
      final opened = mic.open();
      await pumpEventQueue();
      final arecord = starts.processes.single;
      arecord.audio([1, 2]);
      expect(await opened, isTrue);
      arecord.audio([3, 4]);
      final closing = mic.close();
      final again = mic.close();
      await closing;
      await again;
      expect(arecord.kills, 1);
      expect(pcm, [1, 2, 3, 4]);
      await pumpEventQueue();
      expect(errors, isEmpty);
      await mic.close();
      expect(arecord.kills, 1);

      final reopened = mic.open();
      await pumpEventQueue();
      expect(starts.processes, hasLength(2));
      starts.processes.last.audio([5, 6]);
      expect(await reopened, isTrue);
      expect(pcm, [1, 2, 3, 4, 5, 6]);
    });

    test('an arecord that dies under a recording is an error on the pcm', () async {
      final starts = _Starts();
      final mic = ArecordMic(start: starts.call, log: (_) {});
      final errors = <Object>[];
      mic.pcm.listen((_) {}, onError: errors.add);
      final opened = mic.open();
      await pumpEventQueue();
      starts.processes.single.audio([0, 0]);
      expect(await opened, isTrue);
      await starts.processes.single.quit(1, 'arecord: pcm_read:2221: read error: No such device');
      await pumpEventQueue();
      expect(errors.single, isA<StateError>());
    });

    test('opening an open mic is the same mic', () async {
      final starts = _Starts();
      final mic = ArecordMic(start: starts.call, log: (_) {});
      final opened = mic.open();
      await pumpEventQueue();
      starts.processes.single.audio([0, 0]);
      expect(await opened, isTrue);
      expect(await mic.open(), isTrue);
      expect(starts.processes, hasLength(1));
    });

    test('the bar has a mic on Linux only', () {
      final mic = createMic();
      expect(mic, Platform.isLinux ? isA<ArecordMic>() : isNull);
    });
  });
}
