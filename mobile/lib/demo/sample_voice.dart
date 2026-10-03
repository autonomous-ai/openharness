import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/phone/voice_recorder.dart';

/// A microphone that records nothing.
///
/// Sample mode has no speech service to send audio to, so there is no reason to open the real
/// microphone — or to ask for it. A take here is a moving meter and a few bytes; what it "said"
/// is [SampleTranscriber]'s to decide.
class SampleVoiceRecorder implements VoiceRecorder, VoiceLevelMeter {
  SampleVoiceRecorder({required this.every});

  /// Where the meter's clock comes from — the sample's, so leaving it stops the meter.
  final Timer Function(Duration period, void Function() run) every;

  final ValueNotifier<double> _level = ValueNotifier(0);
  final Random _random = Random(7);
  Timer? _meter;
  int _beats = 0;

  @override
  ValueListenable<double> get level => _level;

  @override
  Future<bool> allowed() async => true;

  @override
  Future<void> start() async {
    _beats = 0;
    _meter?.cancel();
    _meter = every(const Duration(milliseconds: 90), () {
      _beats++;
      // Speech-shaped: a syllable's rise and fall, with some breath in it.
      final syllable = (sin(_beats * 0.9) + 1) / 2;
      _level.value = 0.15 + 0.6 * syllable * (0.6 + 0.4 * _random.nextDouble());
    });
  }

  @override
  Future<VoiceTake?> stop() async {
    _halt();
    final length = Duration(milliseconds: max(1200, _beats * 90));
    return (wav: Uint8List(44), length: length, peak: 12000);
  }

  @override
  Future<void> cancel() async => _halt();

  void _halt() {
    _meter?.cancel();
    _meter = null;
    _level.value = 0;
  }

  @override
  Future<void> dispose() async {
    _halt();
    _level.dispose();
  }
}

/// What the sample's voice takes are heard to say: believable things to tell a coding agent, in
/// turn — or an answer, when the harness on screen is asking something.
class SampleTranscriber {
  SampleTranscriber({required this.after, required this.answering});

  /// The sample's clock: [transcribe] answers a moment later, the way a real upload would.
  final Timer Function(Duration delay, void Function() run) after;

  /// Whether the harness on screen has a question open.
  final bool Function() answering;

  static const phrases = [
    'run the tests and fix whatever fails',
    'show me the diff',
    "what's left on this branch?",
    'add a test for the expired token case',
    'commit this with a good message',
  ];

  static const answers = ['yes', 'no, run it against a copy first'];

  int _phrase = 0;
  int _answer = 0;

  /// How long a take takes to come back.
  static const delay = Duration(milliseconds: 700);

  Future<String> transcribe() {
    final done = Completer<String>();
    final words = answering()
        ? answers[_answer++ % answers.length]
        : phrases[_phrase++ % phrases.length];
    after(delay, () => done.complete(words));
    return done.future;
  }
}
