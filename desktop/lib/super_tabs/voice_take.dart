import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import 'voice_recorder.dart';

/// Whether a take went, and what to say about it either way.
typedef SuperTabVoicePosted = ({bool sent, String? notice});

/// Posts [clip] as a voice message in [conversationId], in the thread [root]
/// when there is one (voice_send.dart).
typedef SuperTabVoicePost = Future<SuperTabVoicePosted> Function(
  String conversationId,
  String? root,
  SuperTabVoiceClip clip,
);

/// Where a composer's voice message is.
enum SuperTabVoiceState {
  /// No take: the composer shows its row and mic.
  off,

  /// The microphone is asked for, or opening.
  starting,

  /// Recording.
  recording,

  /// Stopped and kept, with Send and X: at [SuperTabVoiceTake.maxTake], or as
  /// its chat or thread was left.
  held,

  /// Its audio is on its way.
  sending,
}

/// One composer's voice message, as the phone's `SwarmVoice` (Dee, 11-04:
/// "just send the full audio"). The mic records for a chat (and a thread's
/// [root]); the composer then shows the voice row in place of its own: X
/// throws the take away, Send posts it as audio ([post]), and the server
/// reads its words for agents. Nothing goes into the message box.
///
/// A take is never sent by itself. It stops and is kept, Send still there, at
/// [maxTake] and when its chat or thread is left ([hold]); it stays with the
/// chat it was recorded for.
class SuperTabVoiceTake extends ChangeNotifier {
  SuperTabVoiceTake({required this.recorder, required this.post});

  /// The longest take; it stops there with Send ready.
  static const maxTake = Duration(minutes: 10);

  static const nothingRecorded = "Couldn't record anything · try the mic again";
  static const couldNotStart = "The microphone couldn't start · try again";
  static const notSent = 'Not sent · try Send again';

  /// Makes the microphone on the first tap, which this owns and disposes: a
  /// recorder opens a platform channel, and a chat nobody talks in should not.
  final SuperTabVoiceRecorder Function() recorder;
  final SuperTabVoicePost post;

  SuperTabVoiceRecorder? _recorder;
  SuperTabVoiceState _state = SuperTabVoiceState.off;
  String? _conversationId, _root, _notice;
  SuperTabVoiceClip? _clip;
  bool _denied = false, _disposed = false;

  /// Bumped by everything that ends a take, so what an earlier one still
  /// awaits lands nowhere.
  int _turn = 0;
  Timer? _limit;
  Stopwatch? _clock;

  SuperTabVoiceState get state => _state;

  /// The chat and thread the take is for.
  String? get conversationId => _conversationId;
  String? get root => _root;

  /// What went wrong with the last take or send; null otherwise.
  String? get notice => _notice;

  /// The microphone was refused at the last tap: the composer says where to
  /// allow it.
  bool get denied => _denied;

  /// A take is under way or kept: the composer shows the voice row.
  bool get active => _state != SuperTabVoiceState.off;

  /// Whether the voice row belongs in the composer of [conversationId]'s
  /// [root] (null: the main chat).
  bool activeIn(String conversationId, String? root) =>
      active && _conversationId == conversationId && _root == root;

  /// Send can be pressed: a take is recording or kept.
  bool get canSend =>
      _state == SuperTabVoiceState.recording ||
      _state == SuperTabVoiceState.held && _clip != null;

  /// How long the take has run, or the kept take's length.
  Duration get length => _clip?.length ?? _clock?.elapsed ?? Duration.zero;

  /// How loud the microphone is, for the row's wave.
  ValueListenable<double> get level => _recorder?.level ?? _silence;
  static final ValueListenable<double> _silence = ValueNotifier(0);

  /// Starts a take for [conversationId], in the thread [root] when one is
  /// open. A take kept for another chat is thrown away first.
  void start({required String conversationId, String? root}) {
    if (_disposed || _state == SuperTabVoiceState.sending) return;
    if (_state != SuperTabVoiceState.off) discard();
    _conversationId = conversationId;
    _root = root;
    unawaited(_start());
  }

  /// Stops the take and keeps it, with Send and X: its chat or thread was
  /// left. A take still opening is called off.
  void hold() {
    if (_state == SuperTabVoiceState.starting) discard();
    if (_state == SuperTabVoiceState.recording) unawaited(_stop());
  }

  /// Throws the take away, recorded or kept, and sends nothing.
  void discard() {
    if (_disposed || _state == SuperTabVoiceState.sending) return;
    final recording =
        _state == SuperTabVoiceState.recording ||
        _state == SuperTabVoiceState.starting;
    _end();
    if (recording) unawaited(_recorder?.cancel());
    _notice = null;
    _set(SuperTabVoiceState.off);
  }

  /// Posts the take, stopping it first while it records.
  void send() {
    if (!canSend) return;
    unawaited(_send());
  }

  Future<void> _start() async {
    final turn = ++_turn;
    _notice = null;
    _set(SuperTabVoiceState.starting);
    final mic = _recorder ??= recorder();
    final bool allowed;
    try {
      allowed = await mic.allowed();
    } on Object {
      if (turn == _turn) _fail(couldNotStart);
      return;
    }
    if (turn != _turn) return;
    _denied = !allowed;
    if (!allowed) {
      _end();
      _set(SuperTabVoiceState.off);
      return;
    }
    try {
      await mic.start();
    } on Object {
      if (turn == _turn) _fail(couldNotStart);
      return;
    }
    // Called off while the microphone opened.
    if (turn != _turn) {
      unawaited(mic.cancel());
      return;
    }
    _clip = null;
    _clock = clock.stopwatch()..start();
    _limit = Timer(maxTake, hold);
    _set(SuperTabVoiceState.recording);
  }

  void _fail(String notice) {
    _end();
    _notice = notice;
    _set(SuperTabVoiceState.off);
  }

  /// Ends the recording and keeps it; true once there is a take to send.
  Future<bool> _stop() async {
    if (_state != SuperTabVoiceState.recording) return _clip != null;
    final turn = _turn;
    _limit?.cancel();
    _clock?.stop();
    // Held while the recorder finishes: no second stop, X or Send meanwhile.
    _set(SuperTabVoiceState.held);
    SuperTabVoiceClip? clip;
    try {
      clip = await _recorder!.stop();
    } on Object {
      clip = null;
    }
    if (turn != _turn || _disposed) return false;
    if (clip == null) {
      _fail(nothingRecorded);
      return false;
    }
    _clip = clip;
    notifyListeners();
    return true;
  }

  Future<void> _send() async {
    if (!await _stop()) return;
    final clip = _clip!, turn = _turn;
    final conversationId = _conversationId!, root = _root;
    _notice = null;
    _set(SuperTabVoiceState.sending);
    SuperTabVoicePosted posted;
    try {
      posted = await post(conversationId, root, clip);
    } on Object {
      // Whatever failed, the take stays with Send and X.
      posted = (sent: false, notice: notSent);
    }
    if (turn != _turn || _disposed) return;
    _notice = posted.notice;
    if (!posted.sent) {
      _set(SuperTabVoiceState.held);
      return;
    }
    _end();
    _set(SuperTabVoiceState.off);
  }

  void _end() {
    _turn++;
    _limit?.cancel();
    _limit = null;
    _clock = null;
    _clip = null;
  }

  void _set(SuperTabVoiceState state) {
    if (_disposed) return;
    _state = state;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    final recording =
        _state == SuperTabVoiceState.recording ||
        _state == SuperTabVoiceState.starting;
    _end();
    final mic = _recorder;
    if (mic != null) {
      unawaited(() async {
        if (recording) await mic.cancel();
        await mic.dispose();
      }());
    }
    super.dispose();
  }
}
