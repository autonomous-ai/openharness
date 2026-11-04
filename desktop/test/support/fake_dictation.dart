import 'package:harness/super_tabs/voice_dictation.dart';

/// A recognizer for widget tests: no platform channel. [ready] answers
/// `available`; [say] hands words to the open listen, as the system's
/// recognizer streams them; [fail] reports an error; every call is in [calls].
class FakeDictation implements SuperTabDictation {
  final calls = <String>[];
  SuperTabDictationReady ready = SuperTabDictationReady.ready;
  void Function(String words, bool done)? _onWords;
  void Function(String error)? _onError;

  bool get listening => _onWords != null;

  @override
  Future<SuperTabDictationReady> available() async {
    calls.add('available');
    return ready;
  }

  @override
  Future<void> listen({
    required String lang,
    required void Function(String words, bool done) onWords,
    required void Function(String error) onError,
  }) async {
    calls.add('listen $lang');
    _onWords = onWords;
    _onError = onError;
  }

  /// The recognizer hears [words] so far; [done] when it has finished.
  void say(String words, {bool done = false}) {
    _onWords?.call(words, done);
    if (done) _onWords = _onError = null;
  }

  void fail(String error) {
    _onError?.call(error);
    _onWords = _onError = null;
  }

  @override
  Future<void> stop() async {
    calls.add('stop');
    _onWords = _onError = null;
  }

  @override
  Future<void> cancel() async {
    calls.add('cancel');
    _onWords = _onError = null;
  }
}
