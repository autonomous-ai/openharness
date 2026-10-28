import 'dart:async';
import 'dart:typed_data';

import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/phone/voice_recorder.dart';

/// A microphone the test talks into: [captured] is what the next [stop] hands
/// back — speech-loud unless a test says otherwise — and [pendingPermission]
/// holds a permission prompt open.
class FakeVoiceRecorder implements VoiceRecorder {
  bool permitted = true;
  Completer<bool>? pendingPermission;
  VoiceTake? captured = (
    wav: Uint8List.fromList([1, 2, 3, 4]),
    length: const Duration(seconds: 2),
    peak: 9000,
  );

  int starts = 0;
  int stops = 0;
  int cancels = 0;
  bool recording = false;

  @override
  Future<bool> allowed() =>
      pendingPermission?.future ?? Future.value(permitted);

  @override
  Future<void> start() async {
    starts++;
    recording = true;
  }

  @override
  Future<VoiceTake?> stop() async {
    stops++;
    recording = false;
    return captured;
  }

  @override
  Future<void> cancel() async {
    cancels++;
    recording = false;
  }

  @override
  Future<void> dispose() async {}
}

/// The backend's `/api/voice/stt`: answers each recording with the next of
/// [replies], or with [pending] held open until the test completes it.
class FakeTranscriber {
  final List<String> replies = [];
  final List<({int bytes, String lang})> calls = [];
  Completer<String>? pending;
  bool fails = false;

  Future<String> call(Uint8List wav, String lang) async {
    calls.add((bytes: wav.length, lang: lang));
    if (fails) throw Exception('HTTP 502');
    final held = pending;
    if (held != null) return held.future;
    return replies.isEmpty ? '' : replies.removeAt(0);
  }
}

class MemoryKeyValueStore implements LocalKeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
