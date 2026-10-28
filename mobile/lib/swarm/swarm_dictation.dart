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
/// ⚠️ **Its words are stitched ([_stitched]).** The recognizer on the phone can
/// start its words over after a pause, saying only what came after it; what
/// it dropped is kept here, in front, so the box never loses a phrase.
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

  /// What the recognizer said before it last started over, and what it said
  /// last, as it said it.
  String _kept = '', _last = '';

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
    _kept = _last = '';
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
        if (arguments['text'] case final String text) to.words(_stitched(text));
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

  /// [text], every word so far as the recognizer says it, after what it has
  /// dropped. Started over: fewer words than it said last, from a different
  /// first word — one changing its mind keeps the start of its sentence. All
  /// said again, as a recognizer may at the end: nothing kept is put in front.
  String _stitched(String text) {
    final words = _plain(text), before = _plain(_last);
    if (_kept.isNotEmpty &&
        words.join(' ').startsWith(_plain(_kept).join(' '))) {
      _kept = '';
    } else if (before.length >= 2 &&
        words.isNotEmpty &&
        words.length < before.length &&
        words.first != before.first) {
      _kept = _joined(_kept, _last);
    }
    _last = text;
    return _joined(_kept, text);
  }

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
