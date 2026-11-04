import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:speech_to_text/speech_to_text.dart';

/// Whether the system can dictate here.
enum SuperTabDictationReady {
  /// A recognizer is there and may listen.
  ready,

  /// The person refused speech recognition (or the microphone) for Harness.
  refused,

  /// No recognizer: a browser without the Web Speech API.
  none,
}

/// The system's own speech recognizer behind the composer's mic (#2888): it
/// streams the words it hears, which the composer puts in its box as editable
/// text. A seam rather than `SpeechToText` itself: the plugin is a platform
/// channel, and a widget test that reached it would hang on a call nothing
/// answers.
abstract interface class SuperTabDictation {
  Future<SuperTabDictationReady> available();

  /// Listens in [lang] (a language code; the recognizer's own when it has no
  /// match). [onWords] gets everything heard so far each time it changes, with
  /// `done` on the last; [onError] ends the listen.
  Future<void> listen({
    required String lang,
    required void Function(String words, bool done) onWords,
    required void Function(String error) onError,
  });

  /// Ends the listen; the recognizer may still hand its last words.
  Future<void> stop();

  /// Ends the listen and drops what it had not handed yet.
  Future<void> cancel();
}

/// The dictation for this build, or null where the composer has no mic
/// (Linux and Windows, as `superTabVoiceRecorder`).
SuperTabDictation Function()? superTabDictation({
  bool web = kIsWeb,
  TargetPlatform? platform,
}) => web || (platform ?? defaultTargetPlatform) == TargetPlatform.macOS
    ? SuperTabSystemDictation.new
    : null;

/// [SuperTabDictation] over `speech_to_text`: SFSpeechRecognizer on macOS, the
/// Web Speech API in a browser.
class SuperTabSystemDictation implements SuperTabDictation {
  SuperTabSystemDictation([this._web = kIsWeb]);

  final bool _web;
  final SpeechToText _speech = SpeechToText();
  void Function(String error)? _onError;

  @override
  Future<SuperTabDictationReady> available() async {
    final bool ready;
    try {
      ready = await _speech.initialize(
        onError: (error) => _onError?.call(error.errorMsg),
      );
    } on Object {
      return _web
          ? SuperTabDictationReady.none
          : SuperTabDictationReady.refused;
    }
    if (ready) return SuperTabDictationReady.ready;
    // macOS always has a recognizer: one that will not start was refused. A
    // browser that has none says so the same way.
    return _web ? SuperTabDictationReady.none : SuperTabDictationReady.refused;
  }

  @override
  Future<void> listen({
    required String lang,
    required void Function(String words, bool done) onWords,
    required void Function(String error) onError,
  }) async {
    _onError = onError;
    final locales = await _speech.locales();
    final locale = locales
        .where((l) => l.localeId.toLowerCase().startsWith(lang.toLowerCase()))
        .firstOrNull;
    await _speech.listen(
      onResult: (result) => onWords(result.recognizedWords, result.finalResult),
      listenOptions: SpeechListenOptions(
        partialResults: true,
        listenMode: ListenMode.dictation,
        cancelOnError: true,
        localeId: locale?.localeId,
      ),
    );
  }

  @override
  Future<void> stop() => _speech.stop();

  @override
  Future<void> cancel() => _speech.cancel();
}
