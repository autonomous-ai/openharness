import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import 'voice_wav.dart';

/// One finished take: the WAV to upload and how long it ran.
typedef SuperTabVoiceClip = ({Uint8List wav, Duration length});

/// The microphone behind the composer's mic (voice_take.dart): sent as audio,
/// people hear it and agents read its words (Dee, 11-04; #2887), never typed
/// into the box. The phone's recorder seam (mobile/lib/phone/voice_recorder.dart).
///
/// A seam rather than `AudioRecorder` itself: the plugin is a platform channel,
/// and a widget test that reached it would hang on a call no recorder answers.
abstract interface class SuperTabVoiceRecorder {
  /// Asks for the microphone the first time it runs. False once refused.
  Future<bool> allowed();

  /// Starts a take. Throws when the microphone cannot be opened.
  Future<void> start();

  /// Ends the take, or null when not one buffer was captured.
  Future<SuperTabVoiceClip?> stop();

  /// Ends the take and throws it away.
  Future<void> cancel();

  Future<void> dispose();

  /// How loud the microphone is now, 0…1 (`pcm16Level`); 0 between takes.
  ValueListenable<double> get level;
}

/// The recorder for this build, or null where none works: macOS (AVFoundation),
/// Windows (Media Foundation) and the web (getUserMedia). Linux gets none, so its
/// composer draws no mic (#2665: a mic that cannot record is a button that does
/// nothing).
SuperTabVoiceRecorder Function()? superTabVoiceRecorder({
  bool web = kIsWeb,
  TargetPlatform? platform,
}) {
  final here = platform ?? defaultTargetPlatform;
  return web || here == TargetPlatform.macOS || here == TargetPlatform.windows
      ? SuperTabMicRecorder.new
      : null;
}

/// [SuperTabVoiceRecorder] over the computer's or browser's microphone.
///
/// Streams 16 kHz mono PCM and wraps it in a WAV here, as the phone does: the
/// server's voice read is tuned on it, and a minute is under 2 MB to upload.
class SuperTabMicRecorder implements SuperTabVoiceRecorder {
  static const _requested = RecordConfig(
    encoder: AudioEncoder.pcm16bits,
    sampleRate: 16000,
    numChannels: 1,
  );

  /// How long a stop lets audio already captured arrive before the
  /// microphone closes, and how long it waits for the stream to end.
  static const _tailSettle = Duration(milliseconds: 120);
  static const _drainLimit = Duration(seconds: 2);

  final AudioRecorder _recorder = AudioRecorder();
  final BytesBuilder _pcm = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? _subscription;
  Completer<void>? _drained;

  /// What the platform records at: a device may refuse 16 kHz and say so,
  /// and a header with the wrong rate transcribes at the wrong speed.
  int _sampleRate = _requested.sampleRate;
  int _channels = _requested.numChannels;

  /// Never disposed: the row's wave may still listen as this is torn down.
  final ValueNotifier<double> _level = ValueNotifier(0);

  @override
  ValueListenable<double> get level => _level;

  /// One plugin call at a time: a discard not awaited must never land on
  /// the next take.
  Future<void> _tail = Future.value();

  Future<T> _serially<T>(Future<T> Function() operation) {
    final result = _tail.then((_) => operation());
    _tail = result.then((_) {}, onError: (Object _) {});
    return result;
  }

  @override
  Future<bool> allowed() => _recorder.hasPermission();

  @override
  Future<void> start() => _serially(() async {
    await _discard();
    _sampleRate = _requested.sampleRate;
    _channels = _requested.numChannels;
    await _recorder.setOnConfigChanged((config) {
      _sampleRate = config.sampleRate;
      _channels = config.numChannels;
    });
    // A broadcast stream drops what arrives before a listener: subscribe in
    // the same step, with nothing awaited between.
    final stream = await _recorder.startStream(_requested);
    final drained = Completer<void>();
    _drained = drained;
    void finish([Object? _]) {
      if (!drained.isCompleted) drained.complete();
    }

    _subscription = stream.listen(
      (buffer) {
        _pcm.add(buffer);
        _level.value = pcm16Level(buffer);
      },
      onDone: finish,
      onError: finish,
    );
  });

  @override
  Future<SuperTabVoiceClip?> stop() => _serially(() async {
    final drained = _drained;
    if (drained == null) return null;
    await _settleTail();
    await _recorder.stop();
    await drained.future.timeout(_drainLimit, onTimeout: () {});
    await _subscription?.cancel();
    _subscription = null;
    _drained = null;
    _level.value = 0;
    final pcm = _pcm.takeBytes();
    if (pcm.isEmpty) return null;
    final samples = pcm.length ~/ (2 * _channels);
    return (
      wav: wavFromPcm16(pcm, sampleRate: _sampleRate, channels: _channels),
      length: Duration(microseconds: samples * 1000000 ~/ _sampleRate),
    );
  });

  @override
  Future<void> cancel() => _serially(() async {
    if (_drained == null) return;
    await _recorder.cancel();
    await _discard();
  });

  @override
  Future<void> dispose() => _serially(() async {
    await _discard();
    await _recorder.dispose();
  });

  /// Waits until a stretch passes with no buffer, at most [_tailSettle].
  Future<void> _settleTail() async {
    const step = Duration(milliseconds: 20);
    final deadline = DateTime.now().add(_tailSettle);
    var seen = _pcm.length, quiet = 0;
    while (_subscription != null && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(step);
      if (_pcm.length != seen) {
        seen = _pcm.length;
        quiet = 0;
      } else if (++quiet >= 2) {
        return;
      }
    }
  }

  Future<void> _discard() async {
    await _subscription?.cancel();
    _subscription = null;
    _drained = null;
    _pcm.clear();
    _level.value = 0;
  }
}
