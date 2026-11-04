
import 'package:flutter/foundation.dart';
import 'package:harness/super_tabs/voice_recorder.dart';

/// A microphone for widget tests: no platform channel, and every call it
/// gets is in [calls]. [allow] answers the permission, [failStart] makes
/// start throw, [empty] makes stop hand back nothing.
class FakeVoiceRecorder implements SuperTabVoiceRecorder {
  final calls = <String>[];
  bool allow = true, failStart = false, empty = false;

  /// What every stop hands back: one second of 16 kHz mono silence.
  final SuperTabVoiceClip clip = (
    wav: Uint8List.fromList([...List.filled(44, 0), ...List.filled(32000, 0)]),
    length: const Duration(seconds: 1),
  );

  @override
  final ValueNotifier<double> level = ValueNotifier(0);

  @override
  Future<bool> allowed() async {
    calls.add('allowed');
    return allow;
  }

  @override
  Future<void> start() async {
    calls.add('start');
    if (failStart) throw Exception('no microphone');
  }

  @override
  Future<SuperTabVoiceClip?> stop() async {
    calls.add('stop');
    return empty ? null : clip;
  }

  @override
  Future<void> cancel() async => calls.add('cancel');

  @override
  Future<void> dispose() async => calls.add('dispose');
}
