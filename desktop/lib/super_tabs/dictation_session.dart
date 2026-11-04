import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';

import 'voice_dictation.dart';
import 'voice_recorder.dart';

/// Where a composer's dictation is.
enum SuperTabDictationState {
  /// Not dictating: the mic shows at rest.
  off,

  /// Asking the recognizer, or the microphone, to start.
  starting,

  /// Listening: words stream into the box (or, with no recognizer, a take
  /// records for transcribing).
  listening,

  /// With no recognizer: the take is with the server, its words not back yet.
  transcribing,
}

/// Turns a take into its words (`ApiClient.transcribeVoice`, `/api/voice/stt`).
typedef SuperTabTranscriber = Future<String> Function(
  Uint8List wav,
  String lang,
);

/// One composer's dictation (#2888), as the Claude app's mic: a tap listens
/// with the system's recognizer, and what it hears streams into the box at
/// the caret as editable text, each partial replacing the one before. A tap
/// again, Enter, or the person typing stops it; what was heard stays. A
/// browser with no recognizer records instead, and the take's words land at
/// the caret when it stops ([transcribe]).
class SuperTabDictationSession extends ChangeNotifier {
  SuperTabDictationSession({
    required this.recognizer,
    required this.lang,
    this.fallbackRecorder,
    this.transcribe,
  });

  /// The longest a recording runs with no recognizer; it is then transcribed.
  static const maxFallback = Duration(minutes: 5);

  static const failed = "Dictation stopped · tap the mic to try again";
  static const unavailable = "Dictation isn't available in this browser";
  static const notTranscribed = "Couldn't turn that into words · try again";
  static const nothingHeard = "Didn't catch that · tap the mic to try again";

  final SuperTabDictation Function() recognizer;
  final String Function() lang;
  final SuperTabVoiceRecorder Function()? fallbackRecorder;
  final SuperTabTranscriber? transcribe;

  SuperTabDictation? _recognizer;
  SuperTabVoiceRecorder? _recorder;
  SuperTabDictationState _state = SuperTabDictationState.off;
  String? _conversationId, _root, _notice;
  bool _refused = false, _fallback = false, _disposed = false;
  int _turn = 0;
  Timer? _limit;

  TextEditingController? _box;
  String _before = '', _after = '';

  /// What this session last wrote into the box: any other change is the
  /// person typing.
  String? _wrote;

  SuperTabDictationState get state => _state;
  String? get conversationId => _conversationId;
  String? get root => _root;
  String? get notice => _notice;

  /// Speech recognition was refused at the last tap: the composer says where
  /// to allow it.
  bool get refused => _refused;

  /// Listening (or recording, or transcribing): the mic shows it.
  bool get active => _state != SuperTabDictationState.off;

  /// Whether this session's mic is the one in [conversationId]'s [root]
  /// composer (null: the main chat).
  bool activeIn(String conversationId, String? root) =>
      active && _conversationId == conversationId && _root == root;

  /// Starts dictating into [text], the box of [conversationId]'s composer (of
  /// the thread [root] when one is open). One dictation at a time: another
  /// under way stops first.
  void start({
    required String conversationId,
    String? root,
    required TextEditingController text,
  }) {
    if (_disposed) return;
    if (active) stop();
    _conversationId = conversationId;
    _root = root;
    _notice = null;
    _refused = false;
    unawaited(_start(text));
  }

  Future<void> _start(TextEditingController box) async {
    final turn = ++_turn;
    _set(SuperTabDictationState.starting);
    final speech = _recognizer ??= recognizer();
    final ready = await speech.available();
    if (turn != _turn || _disposed) return;
    switch (ready) {
      case SuperTabDictationReady.refused:
        _refused = true;
        _set(SuperTabDictationState.off);
      case SuperTabDictationReady.none:
        await _startFallback(turn, box);
      case SuperTabDictationReady.ready:
        _attach(box);
        _fallback = false;
        _set(SuperTabDictationState.listening);
        try {
          await speech.listen(
            lang: lang(),
            onWords: (words, done) {
              if (turn != _turn) return;
              _write(words);
              if (done) _end();
            },
            onError: (_) {
              if (turn != _turn) return;
              _notice = failed;
              _end();
            },
          );
        } on Object {
          if (turn != _turn) return;
          _notice = failed;
          _end();
        }
    }
  }

  Future<void> _startFallback(int turn, TextEditingController box) async {
    final makeRecorder = fallbackRecorder;
    if (makeRecorder == null || transcribe == null) {
      _notice = unavailable;
      _set(SuperTabDictationState.off);
      return;
    }
    final mic = _recorder ??= makeRecorder();
    try {
      if (!await mic.allowed()) {
        if (turn != _turn) return;
        _refused = true;
        _set(SuperTabDictationState.off);
        return;
      }
      await mic.start();
    } on Object {
      if (turn != _turn) return;
      _notice = failed;
      _set(SuperTabDictationState.off);
      return;
    }
    if (turn != _turn || _disposed) {
      unawaited(mic.cancel());
      return;
    }
    _box = box;
    _fallback = true;
    _limit = Timer(maxFallback, stop);
    _set(SuperTabDictationState.listening);
  }

  /// Stops listening and keeps what was heard; with no recognizer, sends the
  /// take for its words.
  void stop() {
    if (_disposed) return;
    switch (_state) {
      case SuperTabDictationState.off || SuperTabDictationState.transcribing:
        return;
      case SuperTabDictationState.starting:
        _turn++;
        _set(SuperTabDictationState.off);
      case SuperTabDictationState.listening:
        if (_fallback) {
          unawaited(_transcribe());
        } else {
          unawaited(_recognizer?.stop());
          _end();
        }
    }
  }

  Future<void> _transcribe() async {
    final turn = ++_turn;
    _limit?.cancel();
    _set(SuperTabDictationState.transcribing);
    SuperTabVoiceClip? clip;
    try {
      clip = await _recorder!.stop();
    } on Object {
      clip = null;
    }
    if (turn != _turn || _disposed) return;
    if (clip == null) {
      _notice = nothingHeard;
      _finish();
      return;
    }
    String words;
    try {
      words = (await transcribe!(clip.wav, lang())).trim();
    } on Object {
      if (turn != _turn || _disposed) return;
      _notice = notTranscribed;
      _finish();
      return;
    }
    if (turn != _turn || _disposed) return;
    final box = _box;
    if (words.isEmpty) {
      _notice = nothingHeard;
    } else if (box != null) {
      // Where the caret is now: the person may have moved it while waiting.
      _capture(box);
      _write(words);
    }
    _finish();
  }

  /// Ends listening and keeps the words; nothing it hears later lands.
  void _end() {
    _turn++;
    _detach();
    _set(SuperTabDictationState.off);
  }

  void _finish() {
    _box = null;
    _fallback = false;
    _set(SuperTabDictationState.off);
  }

  void _attach(TextEditingController box) {
    _detach();
    _box = box;
    _capture(box);
    box.addListener(_edited);
  }

  void _detach() {
    _box?.removeListener(_edited);
    _box = null;
    _wrote = null;
  }

  /// The text before and after the caret, which dictated words go between.
  void _capture(TextEditingController box) {
    final value = box.value;
    final at = value.selection.isValid
        ? value.selection.baseOffset.clamp(0, value.text.length)
        : value.text.length;
    _before = value.text.substring(0, at);
    _after = value.text.substring(at);
    _wrote = value.text;
  }

  /// Puts [words] between the text before and after the caret, a space apart
  /// from each, replacing the words this dictation wrote before.
  void _write(String words) {
    final box = _box;
    if (box == null) return;
    final heard = words.trim();
    final lead = heard.isNotEmpty && _before.isNotEmpty && !_endsBlank(_before)
        ? ' '
        : '';
    final tail = heard.isNotEmpty && _after.isNotEmpty && !_startsBlank(_after)
        ? ' '
        : '';
    final text = '$_before$lead$heard$tail$_after';
    final caret = _before.length + lead.length + heard.length;
    _wrote = text;
    box.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: caret),
    );
  }

  /// The person typed while listening: dictation stops, and both stay.
  void _edited() {
    final box = _box;
    if (box == null || box.text == _wrote) return;
    unawaited(_recognizer?.stop());
    _end();
  }

  static bool _endsBlank(String text) => RegExp(r'\s$').hasMatch(text);
  static bool _startsBlank(String text) => RegExp(r'^\s').hasMatch(text);

  void _set(SuperTabDictationState state) {
    if (_disposed) return;
    _state = state;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _turn++;
    _limit?.cancel();
    _detach();
    final speech = _recognizer, mic = _recorder;
    if (speech != null) unawaited(speech.cancel());
    if (mic != null) {
      unawaited(() async {
        if (_fallback) await mic.cancel();
        await mic.dispose();
      }());
    }
    super.dispose();
  }
}
