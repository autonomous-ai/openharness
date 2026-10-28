import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

import 'voice_wav.dart';

/// One finished recording: the WAV to upload, how long it ran, and the loudest
/// sample in it — which is what tells "nobody spoke" apart from "no sound ever
/// reached the microphone".
typedef VoiceTake = ({Uint8List wav, Duration length, int peak});

/// The microphone behind [VoiceInputController], as the four things voice
/// input asks of it. Words are not its business: it hands back a WAV, and the
/// backend turns that into text.
///
/// A seam rather than `AudioRecorder` itself: the plugin is a platform channel,
/// and a widget test that reached it would hang on a call no recorder answers.
abstract interface class VoiceRecorder {
  /// Asks for the microphone the first time it runs. False once refused.
  Future<bool> allowed();

  /// Starts a recording. Throws when the microphone cannot be opened.
  Future<void> start();

  /// Ends the recording, or returns null when not one buffer was captured.
  Future<VoiceTake?> stop();

  /// Ends the recording and throws it away.
  Future<void> cancel();

  Future<void> dispose();
}

/// A [VoiceRecorder] that can also say how loud the microphone is right now.
///
/// ⚠️ **Its own interface rather than a member of [VoiceRecorder].** The level
/// only feeds the waveform beside the mic; a recorder with nothing to measure —
/// a test's fake — should not have to invent one, and
/// `VoiceInputController.level` reads silence from it instead.
abstract interface class VoiceLevelMeter {
  /// The loudness of the latest buffer the microphone delivered, 0…1 — see
  /// `pcm16Level`. Back to 0 whenever no take is being recorded.
  ValueListenable<double> get level;
}

/// [VoiceRecorder] over the phone's microphone.
///
/// Streams raw PCM and wraps it here, rather than recording a file: a file
/// needs somewhere to live and something to delete it, and a phrase of speech
/// is a few hundred kilobytes that are about to be uploaded anyway.
class MicVoiceRecorder implements VoiceRecorder, VoiceLevelMeter {
  /// What the backend's transcription is tuned on — the dial sends 8–16 kHz
  /// mono — and a minute of it is under 2 MB to upload.
  static const _requested = RecordConfig(
    encoder: AudioEncoder.pcm16bits,
    sampleRate: 16000,
    numChannels: 1,
  );

  final AudioRecorder _recorder = AudioRecorder();
  final BytesBuilder _pcm = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? _subscription;
  Completer<void>? _drained;

  /// What the platform actually records at. ⚠️ Not always [_requested]: a
  /// device may refuse 16 kHz and say so through `setOnConfigChanged`, and a
  /// WAV header stating the wrong rate plays back — and transcribes — at the
  /// wrong speed.
  int _sampleRate = _requested.sampleRate;
  int _channels = _requested.numChannels;

  /// How long [_stop] lets already-captured audio arrive before it closes the
  /// microphone. See the note in [_stop].
  ///
  /// The tap's buffers are handed over one main-thread hop at a time, so this
  /// only has to outlast a couple of event-loop turns plus the platform channel
  /// — not a buffer's worth of recording. Long enough to catch the tail of a
  /// sentence, short enough that nobody waits for the mic to let go.
  static const _tailSettle = Duration(milliseconds: 120);

  /// How long [_stop] waits for the stream to close after the plugin is
  /// stopped.
  ///
  /// ⚠️ Only a backstop now. With [_tailSettle] doing the collecting, the
  /// stream's own `onDone` normally arrives within a turn or two — and a stop
  /// that never closes must not hold the mic for seconds with a finished take
  /// already in hand.
  static const _drainLimit = Duration(seconds: 2);

  /// ⚠️ **Never disposed, on purpose.** The waveform listens to it from the
  /// widget tree, and this recorder is torn down from the controller's own
  /// `dispose` — which can run before the widgets listening here have let go.
  /// A notifier holds no platform resource; dropping it with the recorder is
  /// enough.
  final ValueNotifier<double> _level = ValueNotifier(0);

  @override
  ValueListenable<double> get level => _level;

  @override
  Future<bool> allowed() => _recorder.hasPermission();

  /// The tail of the operations running on the plugin, one at a time.
  ///
  /// ⚠️ **Serial, because the controller fires `cancel` without awaiting it.**
  /// A take slid off and a new hold pressed straight after would otherwise run
  /// the old cancel's `_discardTake` AFTER the new start had subscribed — the new
  /// take's stream cancelled under it, coming back as "No sound reached the
  /// microphone" — or land the plugin's own cancel on the new recording.
  Future<void> _tail = Future.value();

  Future<T> _serially<T>(Future<T> Function() operation) {
    final result = _tail.then((_) => operation());
    _tail = result.then((_) {}, onError: (Object _) {});
    return result;
  }

  @override
  Future<void> start() => _serially(_start);

  Future<void> _start() async {
    await _discardTake();
    _sampleRate = _requested.sampleRate;
    _channels = _requested.numChannels;
    await _recorder.setOnConfigChanged((config) {
      _sampleRate = config.sampleRate;
      _channels = config.numChannels;
    });
    // ⚠️ **The plugin hands back a BROADCAST stream, which drops every buffer
    // that arrives before something is listening** — `_startRecordStream` only
    // forwards `when ctrl.hasListener`. So the subscription is made in the same
    // synchronous step as the stream, with nothing awaited in between: an
    // `await` here yields to the event loop, and the microphone's first buffers
    // land on a stream nobody is on yet. That is the head of the sentence, and
    // it is what came back as a take that transcribed to nothing.
    final stream = await _recorder.startStream(_requested);
    final drained = Completer<void>();
    _drained = drained;
    void finish([Object? _]) {
      if (!drained.isCompleted) drained.complete();
    }

    _subscription = stream.listen(_onBuffer, onDone: finish, onError: finish);
  }

  /// Keeps the buffer for the take, and reports how loud it was.
  void _onBuffer(Uint8List buffer) {
    _pcm.add(buffer);
    _level.value = pcm16Level(buffer);
  }

  @override
  Future<VoiceTake?> stop() => _serially(_stop);

  Future<VoiceTake?> _stop() async {
    final drained = _drained;
    if (drained == null) return null;
    // ⚠️ **The tail of the take is collected BEFORE the plugin is stopped, and
    // that ordering is the whole of this method.** On iOS the engine's tap
    // hands each buffer to the event sink with `DispatchQueue.main.async` —
    // see `RecorderStreamDelegate.handleTap` — while `stop()` removes the tap
    // and closes the Dart stream synchronously. Buffers already queued on the
    // main thread then arrive at a controller that has been closed and are
    // thrown away: the last word of every sentence, and a short take lost
    // whole, which is what reached the backend as "Didn't catch that".
    //
    // One frame-ish pause lets those queued buffers land while the stream is
    // still open. It costs a tenth of a second at the end of a take, against
    // words that otherwise never existed.
    await _settleTail();
    await _recorder.stop();
    // The plugin's own rule: the last buffer arrives with the stream's close,
    // not with `stop()`, so the take is only whole once the stream is done.
    await drained.future.timeout(_drainLimit, onTimeout: () {});
    // Cancelled rather than dropped: after a timeout the stream is still open,
    // and a late buffer would otherwise land in the NEXT take.
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
      peak: pcm16Peak(pcm),
    );
  }

  @override
  Future<void> cancel() => _serially(_cancel);

  Future<void> _cancel() async {
    if (_drained == null) return;
    await _recorder.cancel();
    await _discardTake();
  }

  @override
  Future<void> dispose() => _serially(_dispose);

  Future<void> _dispose() async {
    await _discardTake();
    await _recorder.dispose();
  }

  /// Waits for the audio already captured to finish arriving, up to
  /// [_tailSettle].
  ///
  /// Waits for the STREAM to go quiet rather than for a fixed delay: it returns
  /// as soon as a stretch passes with no buffer, so an idle mic costs one hop
  /// and a mic still delivering gets the whole window. See [_stop] for why the
  /// tail needs collecting at all.
  Future<void> _settleTail() async {
    if (_subscription == null) return;
    const step = Duration(milliseconds: 20);
    final deadline = DateTime.now().add(_tailSettle);
    var seen = _pcm.length;
    var quiet = 0;
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(step);
      // Stopped, cancelled or restarted from under us while we waited.
      if (_subscription == null) return;
      final length = _pcm.length;
      if (length != seen) {
        seen = length;
        quiet = 0;
        continue;
      }
      // Two quiet steps in a row: the queued buffers have all landed.
      if (++quiet >= 2) return;
    }
  }

  Future<void> _discardTake() async {
    await _subscription?.cancel();
    _subscription = null;
    _drained = null;
    _pcm.clear();
    _level.value = 0;
  }
}
