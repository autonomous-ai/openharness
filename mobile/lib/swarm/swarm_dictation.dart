import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/services.dart';

/// What the person said about the phone's speech recognizer and its
/// microphone, asked the first time a chat's mic is tapped.
enum SwarmDictationAccess {
  /// Both allowed: words show as they are said.
  allowed,

  /// Speech recognition refused or restricted: the chat records and has the
  /// backend transcribe instead, as before.
  denied,

  /// The microphone refused: nothing can be heard either way.
  noMic,
}

/// How a take with the phone's own recognizer ended ([SwarmDictation.start]'s
/// `onEnd`).
enum SwarmDictationEnd {
  /// Stopped, or finished by itself, with its last words delivered.
  done,

  /// Nothing was said in it.
  noSpeech,

  /// The recognizer failed: what it delivered so far stays, the rest is lost.
  failed,
}

/// The phone's own speech recognizer, the one the keyboard's dictation uses
/// (Tony, 10-28): its words come back while the person is still talking.
/// iOS only ([SwarmChannelDictation]); elsewhere a chat records and the
/// backend transcribes.
///
/// One take at a time: [start] ends any earlier one without a word.
abstract interface class SwarmDictation {
  /// Asks for speech recognition and the microphone the first time; after
  /// that, what the person answered.
  Future<SwarmDictationAccess> access();

  /// Listens in [locale] (`vi-VN`). False when the phone has no recognizer
  /// for it now. [onWords] hears every word so far each time — revised as the
  /// recognizer changes its mind — [onLevel] how loud the microphone is
  /// (0…1, `pcm16Level`'s scale), and [onEnd] once, when it has stopped.
  Future<bool> start(
    String locale, {
    required void Function(String words) onWords,
    required void Function(double level) onLevel,
    required void Function(SwarmDictationEnd end) onEnd,
  });

  /// Stops listening: the last words, then [start]'s `onEnd`.
  Future<void> stop();

  /// Stops listening and drops anything still to come: no more words, and no
  /// `onEnd`.
  Future<void> cancel();
}

/// The recognizer's locale for a code from `voiceLanguages`: Vietnamese for
/// one it does not know.
String swarmDictationLocale(String language) => switch (language) {
  'en' => 'en-US',
  'es' => 'es-ES',
  'fr' => 'fr-FR',
  'ja' => 'ja-JP',
  'it' => 'it-IT',
  _ => 'vi-VN',
};

/// An RMS (0…1 of full scale) as `pcm16Level` draws it: −55 dB is 0, −10 dB
/// is 1.
double swarmDictationLevel(double rms) {
  if (rms <= 0) return 0;
  final db = 20 * math.log(rms) / math.ln10;
  return ((db + 55) / 45).clamp(0.0, 1.0);
}

/// [SwarmDictation] over `harness/dictation` (iOS: `DictationChannel` in
/// `AppDelegate.swift`, `SFSpeechRecognizer`).
///
/// Each take has a number of its own, sent with every call and said back with
/// every event, so words from a take already ended land nowhere.
///
/// ⚠️ **Its guesses replace each other ([_stitched]), never add up.** The
/// recognizer says its latest best guess at the words not yet finished, and
/// rewrites it as it goes ("1", "Một 2", "123"); only a guess it says is
/// finished, or one its next words begin after in the take's audio — on the
/// phone it can start over after a pause, without a word — is kept, once, in
/// front of what it says next. Never a guess by how the words look: Tony's
/// 'một hai ba bốn năm' came out as 'Một 2 12345' that way (10-29).
class SwarmChannelDictation implements SwarmDictation {
  SwarmChannelDictation({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('harness/dictation') {
    _channel.setMethodCallHandler(_heard);
  }

  final MethodChannel _channel;
  int _take = 0;
  ({
    void Function(String) words,
    void Function(double) level,
    void Function(SwarmDictationEnd) end,
  })?
  _to;

  /// What the recognizer has finished saying in this take, and its guess at
  /// what comes after: where that ends in the take's audio, and whether it
  /// said that guess was finished.
  String _done = '', _guess = '';
  double _guessTo = 0;
  bool _guessFinished = false;

  /// How far a guess may begin before the last one ended and still be new
  /// words: the recognizer's own times overlap a little at a word's edge.
  static const _overlap = 0.05;

  @override
  Future<SwarmDictationAccess> access() async {
    try {
      return switch (await _channel.invokeMethod<String>('access')) {
        'allowed' => SwarmDictationAccess.allowed,
        'noMic' => SwarmDictationAccess.noMic,
        _ => SwarmDictationAccess.denied,
      };
    } on PlatformException {
      return SwarmDictationAccess.denied;
    } on MissingPluginException {
      return SwarmDictationAccess.denied;
    }
  }

  @override
  Future<bool> start(
    String locale, {
    required void Function(String words) onWords,
    required void Function(double level) onLevel,
    required void Function(SwarmDictationEnd end) onEnd,
  }) async {
    final take = ++_take;
    _to = (words: onWords, level: onLevel, end: onEnd);
    _done = _guess = '';
    _guessTo = 0;
    _guessFinished = false;
    try {
      final started = await _channel.invokeMethod<bool>('start', {
        'take': take,
        'locale': locale,
      });
      if (started != true && take == _take) _to = null;
      return started == true;
    } on PlatformException {
      if (take == _take) _to = null;
      return false;
    }
  }

  @override
  Future<void> stop() async {
    try {
      await _channel.invokeMethod<void>('stop', {'take': _take});
    } on PlatformException {
      _ended(_take, SwarmDictationEnd.failed);
    }
  }

  @override
  Future<void> cancel() async {
    final take = _take++;
    _to = null;
    try {
      await _channel.invokeMethod<void>('cancel', {'take': take});
    } on PlatformException {
      // Nothing more is wanted from it either way.
    }
  }

  Future<void> _heard(MethodCall call) async {
    final arguments = call.arguments;
    if (arguments is! Map || arguments['take'] != _take) return;
    final to = _to;
    if (to == null) return;
    switch (call.method) {
      case 'words':
        if (arguments['text'] case final String text) {
          to.words(
            _stitched(
              text,
              finished: arguments['final'] == true,
              from: _seconds(arguments['from']),
              to: _seconds(arguments['to']),
            ),
          );
        }
      case 'level':
        if (arguments['rms'] case final num rms) {
          to.level(swarmDictationLevel(rms.toDouble()));
        }
      case 'end':
        _ended(_take, switch (arguments['end']) {
          'done' => SwarmDictationEnd.done,
          'noSpeech' => SwarmDictationEnd.noSpeech,
          _ => SwarmDictationEnd.failed,
        });
    }
  }

  /// Every word of the take so far: what is [_done], then [guess], the
  /// recognizer's latest — which replaces the last, unless that one is done.
  ///
  /// The last guess is done when this one begins after it ended in the take's
  /// audio ([from], [to]: seconds, 0 where the recognizer gives none). Without
  /// both times, when the recognizer said it was [finished] and this one is not the
  /// same words again with more after them, as a recognizer that keeps the
  /// whole take in each guess says it.
  String _stitched(
    String guess, {
    required bool finished,
    required double from,
    required double to,
  }) {
    final timed = from > 0 && _guessTo > 0;
    final after = timed && from >= _guessTo - _overlap;
    final again = _plain(guess).join(' ').startsWith(_plain(_guess).join(' '));
    if (_guess.isNotEmpty && (after || (!timed && _guessFinished && !again))) {
      _done = _joined(_done, _guess);
    }
    _guess = guess;
    _guessTo = to;
    _guessFinished = finished;
    return _joined(_done, guess);
  }

  static double _seconds(Object? value) =>
      value is num && value.isFinite ? value.toDouble() : 0;

  /// [text]'s words without case or punctuation, to be compared.
  static List<String> _plain(String text) => text
      .toLowerCase()
      .replaceAll(RegExp(r'[^\p{L}\p{N}\s]', unicode: true), '')
      .split(RegExp(r'\s+'))
      .where((word) => word.isNotEmpty)
      .toList();

  static String _joined(String kept, String text) =>
      kept.isEmpty || text.isEmpty ? '$kept$text' : '$kept $text';

  void _ended(int take, SwarmDictationEnd end) {
    if (take != _take) return;
    final to = _to;
    _to = null;
    to?.end(end);
  }
}
