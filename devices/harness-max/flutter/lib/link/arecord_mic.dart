// The board's microphone through ALSA's arecord (no plugins on flutter-pi): 16 kHz mono s16le on its stdout, and the
// level the C bar reads (main/audio/voice_buffer.c voice_level_feed over 10 ms blocks, 0..4), as 0..1.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'mic.dart';

/// The USB microphone Near's voice service uses: the board's default card is its codec, with no microphone wired.
const String kDefaultMic = 'plughw:CARD=Device,DEV=0';

/// The bar's mic: arecord on Linux, none elsewhere (null).
Mic? createMic() =>
    Platform.isLinux ? ArecordMic(device: Platform.environment['HARNESS_MAX_MIC'] ?? kDefaultMic) : null;

/// What the C recorder meters at a time: 10 ms of 16 kHz.
const int kLevelBlockSamples = 160;

/// A level goes out every this many blocks: 50 ms, 20 a second.
const int kLevelEveryBlocks = 5;

/// The mic's envelope as the C bar meters it (voice_level_feed): peak-to-peak per 10 ms block, released by 1/32 a
/// block, in five steps. The bar's speech threshold (step 2 of 4) is 0.5 here.
class MicLevelMeter {
  int _envelope = 0, _samples = 0, _blocks = 0, _lo = 0, _hi = 0;
  int? _odd;

  /// The step a block's envelope reads as, 0..4 (pro_rec_level).
  static int stepOf(int envelope) => envelope < 64
      ? 0
      : envelope < 180
      ? 1
      : envelope < 500
      ? 2
      : envelope < 1600
      ? 3
      : 4;

  void reset() {
    _envelope = _samples = _blocks = 0;
    _odd = null;
  }

  /// Feeds PCM (s16le, split anywhere, even mid-sample) and calls [level] with 0..1 every [kLevelEveryBlocks] blocks.
  void feed(Uint8List pcm, void Function(double level) level) {
    var i = 0;
    final odd = _odd;
    if (odd != null && pcm.isNotEmpty) {
      _sample(odd | (pcm[0] << 8), level);
      _odd = null;
      i = 1;
    }
    for (; i + 1 < pcm.length; i += 2) {
      _sample(pcm[i] | (pcm[i + 1] << 8), level);
    }
    if (i < pcm.length) _odd = pcm[i];
  }

  void _sample(int raw, void Function(double level) level) {
    final v = raw >= 0x8000 ? raw - 0x10000 : raw;
    if (_samples == 0 || v < _lo) _lo = v;
    if (_samples == 0 || v > _hi) _hi = v;
    if (++_samples < kLevelBlockSamples) return;
    _samples = 0;
    // Peak-to-peak rejects a DC offset; the release keeps a word visible between the bar's reads.
    _envelope = _envelope * 31 ~/ 32;
    if (_hi - _lo > _envelope) _envelope = _hi - _lo;
    if (++_blocks == kLevelEveryBlocks) {
      _blocks = 0;
      level(stepOf(_envelope) / 4);
    }
  }
}

/// Starts a process (Process.start, or a test's own).
typedef ProcessStarter = Future<Process> Function(String executable, List<String> arguments);

class ArecordMic implements Mic {
  ArecordMic({this.device = kDefaultMic, ProcessStarter? start, this.log = _stderr})
    : _start = start ?? ((exe, args) => Process.start(exe, args));

  /// The ALSA capture device (an `arecord -L` name).
  final String device;
  final ProcessStarter _start;
  final void Function(String line) log;
  final _pcm = StreamController<Uint8List>.broadcast(sync: true);
  final _levels = StreamController<double>.broadcast(sync: true);
  final _meter = MicLevelMeter();
  Process? _process, _stopping;
  Completer<void>? _stdoutDone;
  Future<void>? _closing;

  /// How long open() waits for the first audio before it takes a silent but running arecord as open.
  static const Duration firstAudio = Duration(seconds: 1);

  @override
  int get sampleRate => 16000;

  /// The recording, while open. An error on it says the mic stopped by itself (arecord exited).
  @override
  Stream<Uint8List> get pcm => _pcm.stream;

  @override
  Stream<double> get levels => _levels.stream;

  /// Starts arecord. False when there is none, or it exits before any audio (no such device, or one another program
  /// holds).
  @override
  Future<bool> open() async {
    await _closing;
    if (_process != null) return true;
    final Process process;
    try {
      // A 100 ms buffer, the C bar's ALSA latency: audio arrives in small reads, so the level moves smoothly.
      process = await _start('arecord', [
        '-q',
        '-D',
        device,
        '-f',
        'S16_LE',
        '-c',
        '1',
        '-r',
        '$sampleRate',
        '-t',
        'raw',
        '-B',
        '100000',
      ]);
    } on ProcessException catch (e) {
      log('no arecord: ${e.message}');
      return false;
    }
    _process = process;
    _meter.reset();
    var opened = false;
    final first = Completer<bool>();
    final done = _stdoutDone = Completer<void>();
    process.stdout.listen(
      (data) {
        if (!first.isCompleted) first.complete(true);
        final chunk = data is Uint8List ? data : Uint8List.fromList(data);
        _pcm.add(chunk);
        _meter.feed(chunk, _levels.add);
      },
      onDone: done.complete,
      onError: (Object _) {},
    );
    final why = StringBuffer();
    process.stderr.listen((data) => why.write(String.fromCharCodes(data)), onError: (Object _) {});
    process.exitCode.then((code) {
      if (!first.isCompleted) first.complete(false);
      if (_process != process || identical(_stopping, process)) return;
      _process = null;
      log('arecord on $device exited ($code): ${why.toString().trim()}');
      // Exited by itself under a recording: the recording is over.
      if (opened) _pcm.addError(StateError('the microphone stopped'));
    });
    opened = await first.future.timeout(firstAudio, onTimeout: () => true);
    if (!opened && _process == process) _process = null;
    return opened;
  }

  /// Stops arecord; the audio it had already read has been delivered when this returns.
  @override
  Future<void> close() => _closing ??= _close().whenComplete(() => _closing = null);

  Future<void> _close() async {
    final process = _process;
    if (process == null) return;
    _stopping = process;
    final done = _stdoutDone;
    process.kill();
    await done?.future.timeout(const Duration(seconds: 1), onTimeout: () {});
    if (_process == process) _process = null;
  }
}

void _stderr(String line) => stderr.writeln('mic: $line');
