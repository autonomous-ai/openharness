import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/phone/voice_notice.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'swarm_dictation.dart';

/// Talking instead of typing in a chat, into the message box (Tony, 10-28:
/// "like the Claude app"). Tap to talk; tap again and what is in the box is
/// sent ([send]) — what the person typed or changed meanwhile included. Stop
/// talking for [pause] instead and listening ends with the words left in the
/// box, unsent. A long press picks the language ([voiceLanguageStore]).
///
/// Two ways to hear, the first wherever it can:
///
/// - **The phone's own recognizer** ([dictation]), the one the keyboard's
///   dictation uses: the words show in the box as they are said. Asked for
///   once, with the microphone.
/// - **The terminal's voice input** ([VoiceInputController]): the take is
///   recorded and the backend transcribes it as it ends. Where there is no
///   recognizer (Android, sample mode), speech recognition was refused, or
///   the recognizer has no such language.
///
/// ⚠️ **Only while the chat is seen.** A take goes the moment the chat does —
/// covered by another screen ([hide]) or the app sent to the background — so
/// nothing is recorded, or sent to be transcribed, behind the person's back.
/// Behind a system prompt the take is kept, but nothing ends it by itself
/// until the app is back: neither its pause nor its time limit. A take that
/// ended just before goes to be transcribed only then, too.
class SwarmVoice extends ChangeNotifier {
  SwarmVoice({
    required this.create,
    this.dictation,
    required this.draft,
    required this.write,
    required this.send,
  });

  /// How long a quiet after speech ends the take, its words left in the box.
  static const pause = Duration(seconds: 3);

  /// The microphone's level (`pcm16Level`, 0…1) at and above which it hears
  /// speech, and below which [_quiet] begins a pause. Apart, so a soft word
  /// keeps the take going without being needed to start the count.
  static const _speech = 0.4;
  static const _quiet = 0.25;

  /// In a room louder than that, speech and quiet are as far above the room
  /// ([_room]) as these. Tony's iPhone 14 in his room (10-29): the room 0.41
  /// to 0.47, speech 0.78 to 0.94 with breaths at 0.63 — above both levels
  /// before, so no take there ever paused.
  static const _speechOverRoom = 0.25;
  static const _quietOverRoom = 0.12;

  /// How far [_room] rises a buffer, after a room that grows louder.
  static const _roomRise = 0.001;

  /// How long the recognizer has to say it has stopped, after a tap asked it
  /// to, before its take is given up and nothing is sent.
  static const _endWait = Duration(seconds: 2);

  /// Makes the voice input, which this owns and disposes.
  final VoiceInputController Function() create;

  /// The phone's own recognizer; null where there is none.
  final SwarmDictation? dictation;

  /// The draft as it is now, and the draft written anew.
  final String Function() draft;
  final void Function(String text) write;

  /// Sends the draft: the second tap ended a take with nothing of it lost.
  final void Function() send;

  /// The recognizer's take: asking for it, listening, or waiting for it to
  /// say it has stopped.
  _Live _live = _Live.off;

  /// Bumped by everything that ends a recognizer's take, so what an earlier
  /// one still says lands nowhere.
  int _liveTake = 0;

  /// Speech recognition was refused: the mic records from now on.
  bool _liveRefused = false;

  /// What the recognizer shows is spliced into the draft after [_liveFrom]:
  /// the draft as the take began, or as the person last left it. [_liveShown]
  /// is the draft as the recognizer last wrote it; a draft that is not, the
  /// person changed — their change stays, and only words heard after it are
  /// added ([_liveSkip] of [_liveCount] are already in it).
  String _liveFrom = '', _liveShown = '', _liveText = '';
  int _liveSkip = 0, _liveCount = 0;

  /// The take was ended by a second tap: the draft goes once it has stopped.
  bool _liveSend = false;
  Timer? _liveQuiet, _liveLimit, _liveEnd, _liveNoticeTimer;
  final ValueNotifier<double> _liveLevel = ValueNotifier(0);
  String? _liveNotice;

  VoiceInputController? _voice;

  /// Speech was heard in this take: only then does a quiet end it, so the
  /// moment before somebody starts talking is not a pause.
  bool _spoke = false;

  /// How loud the room is in this take: the quietest the microphone has been,
  /// rising by [_roomRise] a buffer. Not from its first buffer, the click it
  /// opens on (0.21 in Tony's room, the room itself 0.34 and up after it).
  double? _room;
  bool _opened = false;
  Timer? _pauseTimer;
  bool _disposed = false;

  /// Hears the app go to the background, from the first tap.
  AppLifecycleListener? _lifecycle;

  /// The app is in front: not behind a system prompt or Control Center, nor
  /// gone. Only then does a take end by itself and go to be transcribed.
  bool _inFront = true;

  /// The take reached [VoiceInputController.maxTake] while the app was not
  /// in front: it ends as the app comes back.
  bool _limitReached = false;

  /// A take whose microphone closed while the app was not in front, waiting
  /// for it to come back ([_mayTranscribe]).
  Completer<bool>? _held;

  /// The voice input, from the first tap: a recorder opens a platform
  /// channel, and a chat nobody talks to should not.
  VoiceInputController? get voice => _voice;

  /// What went wrong with the last take, as the terminal says it.
  String? get notice => _liveNotice ?? _voice?.notice;

  /// The mic's face: null at rest.
  VoiceMicFace? get face => switch (_live) {
    _Live.asking => VoiceMicFace.starting,
    _Live.listening => VoiceMicFace.listening,
    _Live.ending => VoiceMicFace.busy,
    _Live.off => switch (_voice) {
      null => null,
      final voice when voice.isSending => VoiceMicFace.busy,
      final voice => switch (voice.status) {
        VoiceInputStatus.starting => VoiceMicFace.starting,
        VoiceInputStatus.listening => VoiceMicFace.listening,
        VoiceInputStatus.transcribing => VoiceMicFace.busy,
        VoiceInputStatus.idle || VoiceInputStatus.unavailable => null,
      },
    },
  };

  /// The microphone was refused: the mic is off.
  bool get off =>
      _live == _Live.off && _voice?.status == VoiceInputStatus.unavailable;

  /// How loud the microphone is, for the face's bars.
  ValueListenable<double>? get level =>
      _live == _Live.off ? _voice?.level : _liveLevel;

  /// Starts a take; ends it and sends the box, calls it off while the
  /// microphone opens or its permission is asked, or does nothing while its
  /// words are on their way.
  void tap() {
    if (_disposed) return;
    switch (_live) {
      case _Live.asking:
        _offLive();
        return;
      case _Live.listening:
        _endLive(send: true);
        return;
      case _Live.ending:
        return;
      case _Live.off:
    }
    _setLiveNotice(null);
    final recorded = _voice;
    final underWay =
        recorded != null &&
        (recorded.isSending ||
            (recorded.status != VoiceInputStatus.idle &&
                recorded.status != VoiceInputStatus.unavailable));
    if (!underWay && dictation != null && !_liveRefused) {
      unawaited(_listen(dictation!));
      return;
    }
    _tapRecorded(recorded ?? _start());
  }

  /// [tap] on the terminal's voice input.
  void _tapRecorded(VoiceInputController voice) {
    if (voice.isSending) return;
    switch (voice.status) {
      case VoiceInputStatus.idle || VoiceInputStatus.unavailable:
        unawaited(voice.startListening());
      case VoiceInputStatus.starting:
        unawaited(voice.stopListening());
      case VoiceInputStatus.listening:
        _finish(voice, send: true);
      case VoiceInputStatus.transcribing:
        break;
    }
  }

  /// Throws away the take under way — opening, recording or being
  /// transcribed — with its words: the chat went out of sight. What it was
  /// waiting on lands nowhere ([VoiceInputController.clear]), and the next
  /// tap starts afresh.
  ///
  /// ⚠️ `clear`, never `stopListening` or a [_finish]: those transcribe the
  /// take, and a take nobody can see must not leave the phone.
  void hide() {
    _offLive();
    _stopPause();
    _release(false);
    final voice = _voice;
    if (voice == null || voice.isIdle) return;
    voice.clear();
  }

  VoiceInputController _start() {
    final voice = _voice = create();
    voice.addListener(_changed);
    voice.level.addListener(_heard);
    voice.onTakeLimit = () async => _limit(voice);
    voice.mayTranscribe = _mayTranscribe;
    _watchApp();
    return voice;
  }

  /// Hears the app come and go, from the first tap.
  void _watchApp() {
    if (_lifecycle != null) return;
    final state = WidgetsBinding.instance.lifecycleState;
    _inFront = state == null || state == AppLifecycleState.resumed;
    _lifecycle = AppLifecycleListener(onStateChange: _lifecycleChanged);
  }

  /// A take with the phone's recognizer: asked for, then listening in the
  /// long-press language. Refused, or without the language, the tap records
  /// instead.
  Future<void> _listen(SwarmDictation dictation) async {
    final take = ++_liveTake;
    _watchApp();
    _live = _Live.asking;
    notifyListeners();
    final access = await dictation.access();
    if (_disposed || take != _liveTake) return;
    if (access != SwarmDictationAccess.allowed) {
      if (access == SwarmDictationAccess.denied) _liveRefused = true;
      _live = _Live.off;
      _tapRecorded(_voice ?? _start());
      notifyListeners();
      return;
    }
    _liveFrom = _liveShown = draft();
    _liveText = '';
    _liveSkip = _liveCount = 0;
    _liveSend = false;
    final started = await dictation.start(
      swarmDictationLocale(voiceLanguageStore.value),
      onWords: (words) => _liveWords(take, words),
      onLevel: (level) {
        if (take == _liveTake) _liveLevel.value = level;
      },
      onEnd: (end) => _liveEnded(take, end),
    );
    if (_disposed || take != _liveTake) {
      if (started) unawaited(dictation.cancel());
      return;
    }
    if (!started) {
      _live = _Live.off;
      _tapRecorded(_voice ?? _start());
      notifyListeners();
      return;
    }
    _live = _Live.listening;
    _liveLimit = Timer(VoiceInputController.maxTake, () {
      if (take == _liveTake) _endLive(send: false);
    });
    notifyListeners();
  }

  /// Every word the recognizer has heard so far, into the draft after
  /// [_liveFrom]; a new word starts the [pause] that stops listening.
  void _liveWords(int take, String text) {
    if (take != _liveTake || _live == _Live.off) return;
    final words = text.split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
    final now = draft();
    if (now != _liveShown) {
      _liveFrom = now;
      _liveSkip = _liveCount;
    }
    _liveCount = words.length;
    _liveShown = _joined(_liveFrom, words.skip(_liveSkip).join(' '));
    if (_liveShown != now) write(_liveShown);
    if (text == _liveText || words.isEmpty) return;
    _liveText = text;
    if (_live != _Live.listening) return;
    _liveQuiet?.cancel();
    _liveQuiet = Timer(pause, () {
      if (take == _liveTake) _endLive(send: false);
    });
  }

  /// Asks the recognizer to stop: its last words, then its end
  /// ([_liveEnded]) — which, with [send], sends the draft.
  void _endLive({required bool send}) {
    final dictation = this.dictation;
    if (_live != _Live.listening || dictation == null) return;
    final take = _liveTake;
    _live = _Live.ending;
    _liveSend = send;
    _stopLiveTimers();
    _liveEnd = Timer(_endWait, () {
      if (take != _liveTake) return;
      unawaited(dictation.cancel());
      _liveEnded(take, SwarmDictationEnd.failed);
    });
    notifyListeners();
    unawaited(dictation.stop());
  }

  /// The recognizer has stopped: by itself, or as a tap or a pause asked. The
  /// draft goes only after a second tap, with words heard and none lost.
  void _liveEnded(int take, SwarmDictationEnd end) {
    if (take != _liveTake || _live == _Live.off) return;
    final send =
        _liveSend &&
        _live == _Live.ending &&
        end == SwarmDictationEnd.done &&
        _liveCount > 0;
    _liveTake++;
    _live = _Live.off;
    _stopLiveTimers();
    _liveLevel.value = 0;
    _setLiveNotice(switch (end) {
      SwarmDictationEnd.failed => VoiceNotice.notTranscribed,
      _ when _liveCount == 0 => VoiceNotice.nothingHeard,
      _ => null,
    });
    notifyListeners();
    if (send && !_disposed) this.send();
  }

  /// Calls off the recognizer's take, whatever it is doing: the words already
  /// shown stay in the draft, and nothing is sent.
  void _offLive() {
    if (_live == _Live.off) return;
    final listened = _live != _Live.asking;
    _liveTake++;
    _live = _Live.off;
    _stopLiveTimers();
    _liveLevel.value = 0;
    if (listened) unawaited(dictation?.cancel());
    if (!_disposed) notifyListeners();
  }

  void _stopLiveTimers() {
    _liveQuiet?.cancel();
    _liveLimit?.cancel();
    _liveEnd?.cancel();
    _liveQuiet = _liveLimit = _liveEnd = null;
  }

  /// A notice of the recognizer's, which goes by itself as the terminal's do.
  void _setLiveNotice(String? notice) {
    _liveNoticeTimer?.cancel();
    _liveNoticeTimer = null;
    _liveNotice = notice;
    if (notice == null) return;
    _liveNoticeTimer = Timer(VoiceInputController.noticeLinger, () {
      _liveNotice = null;
      if (!_disposed) notifyListeners();
    });
  }

  /// [words] after [draft], a space between them unless the draft ends in one.
  static String _joined(String draft, String words) {
    if (words.isEmpty) return draft;
    final spaced = draft.isEmpty || RegExp(r'\s$').hasMatch(draft);
    return '$draft${spaced ? '' : ' '}$words';
  }

  void _lifecycleChanged(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        _inFront = true;
        _release(true);
        _back();
      // ⚠️ Kept, not thrown away: the microphone permission prompt itself
      // leaves the app inactive, and so do Control Center and a call's banner,
      // and the take asked for must survive them. Only its ending waits.
      //
      // The recognizer's take is not, once it listens: it has no prompt left
      // to survive, and what it hears goes to be recognized at once.
      case AppLifecycleState.inactive:
        _inFront = false;
        _stopPause();
        if (_live != _Live.asking) _offLive();
      case AppLifecycleState.hidden ||
          AppLifecycleState.paused ||
          AppLifecycleState.detached:
        _inFront = false;
        hide();
    }
  }

  /// The app is back in front: a take that reached its limit meanwhile ends
  /// now, and a quiet after speech starts its pause again.
  void _back() {
    final voice = _voice;
    if (voice == null || voice.status != VoiceInputStatus.listening) return;
    if (_limitReached) {
      _limitReached = false;
      _finish(voice);
      return;
    }
    _judge();
  }

  /// The take reached [VoiceInputController.maxTake]: it ends into the box,
  /// as a tap would — once the app is in front, never behind a prompt.
  void _limit(VoiceInputController voice) {
    if (_inFront) {
      _finish(voice);
    } else {
      _limitReached = true;
    }
  }

  /// Whether a take may go to be transcribed, asked once its microphone has
  /// closed: at once in front; behind a system prompt, once the app is back —
  /// and never if it goes away instead ([hide]).
  ///
  /// ⚠️ Asked again here, not only as the take ends: the microphone takes a
  /// moment to close, and Control Center can come down in it.
  Future<bool> _mayTranscribe() async {
    while (!_inFront) {
      if (!await (_held ??= Completer()).future) return false;
    }
    return true;
  }

  /// Lets a take held by [_mayTranscribe] go to be transcribed, or drops it.
  void _release(bool go) {
    final held = _held;
    _held = null;
    held?.complete(go);
  }

  /// Ends the take, its words into the draft, and with [send] sends the draft
  /// once they are there. A take that fails keeps the draft as it was, sends
  /// nothing and leaves its [notice].
  void _finish(VoiceInputController voice, {bool send = false}) {
    _stopPause();
    var heard = false;
    unawaited(
      voice
          .submit((words) async {
            write(_joined(draft(), words));
            heard = true;
            return true;
          })
          .then((_) {
            if (heard && send && !_disposed) this.send();
          }),
    );
  }

  void _changed() {
    if (_voice?.status != VoiceInputStatus.listening) {
      _stopPause();
      _spoke = false;
      _room = null;
      _opened = false;
      _limitReached = false;
    }
    notifyListeners();
  }

  /// The microphone's level moved: how loud the room is, then [_judge].
  void _heard() {
    final voice = _voice;
    if (voice == null || voice.status != VoiceInputStatus.listening) return;
    final level = voice.level.value;
    if (_opened) {
      final room = _room;
      _room = room == null ? level : math.min(level, room + _roomRise);
    }
    _opened = true;
    _judge();
  }

  /// Speech holds the take open, and a quiet after it starts the [pause] that
  /// ends it — both above the room ([_room]) when it is loud.
  void _judge() {
    final voice = _voice;
    if (voice == null || voice.status != VoiceInputStatus.listening) return;
    final level = voice.level.value;
    final room = _room ?? 0;
    if (level >= math.max(_quiet, room + _quietOverRoom)) {
      _stopPause();
      if (level >= math.max(_speech, room + _speechOverRoom)) _spoke = true;
      return;
    }
    if (!_spoke || !_inFront) return;
    _pauseTimer ??= Timer(pause, () {
      _pauseTimer = null;
      if (!_disposed && voice.status == VoiceInputStatus.listening) {
        _finish(voice);
      }
    });
  }

  void _stopPause() {
    _pauseTimer?.cancel();
    _pauseTimer = null;
  }

  /// Throws away a take still under way: the microphone closes with the chat.
  @override
  void dispose() {
    _disposed = true;
    _offLive();
    _liveNoticeTimer?.cancel();
    _liveLevel.dispose();
    _stopPause();
    _release(false);
    _lifecycle?.dispose();
    if (_voice case final voice?) {
      voice.removeListener(_changed);
      voice.level.removeListener(_heard);
      voice.dispose();
    }
    super.dispose();
  }
}

/// The composer's mic, a 44pt round like its other buttons: a plain mic at
/// rest, and the terminal's face ([VoiceMicCore]) while a take is under way —
/// opening, listening with its bars moving to the voice, transcribing. A long
/// press picks the language, from the terminal's list.
class SwarmVoiceMic extends StatelessWidget {
  const SwarmVoiceMic({super.key, required this.voice});

  final SwarmVoice voice;

  /// How wide the terminal's face is drawn here: inside the 44pt round, as
  /// the filled Send beside it is.
  static const double _face = 36;

  @override
  Widget build(BuildContext context) {
    final face = voice.face;
    final off = voice.off;
    void talk() {
      HapticFeedback.lightImpact();
      voice.tap();
    }

    void chooseLanguage() => unawaited(showVoiceLanguagePicker(context));
    // The actions on the node itself: the button's own are left out with its
    // icon, and VoiceOver's double-tap-and-hold is the only way to the list.
    return Semantics(
      button: true,
      enabled: true,
      onTap: talk,
      onLongPress: chooseLanguage,
      // One word while the mic is open: VoiceOver reads the label aloud, and
      // a sentence read into an open microphone lands in the take.
      label: switch (face) {
        VoiceMicFace.starting => 'Cancel',
        VoiceMicFace.listening => 'Done',
        null when off => 'Voice input is off',
        null => 'Talk',
        _ => 'Working',
      },
      onLongPressHint: 'Choose language',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('swarm-mic'),
        behavior: HitTestBehavior.opaque,
        onTap: talk,
        onLongPress: chooseLanguage,
        child: SizedBox.square(
          dimension: 44,
          child: Center(
            child: face == null
                ? Icon(
                    off ? LucideIcons.micOff : LucideIcons.mic,
                    size: AppIconSize.standalone,
                    color: off
                        ? AppPalette.textFaint
                        : AppPalette.textSecondary,
                  )
                : SizedBox.square(
                    dimension: _face,
                    child: FittedBox(
                      child: VoiceMicCore(
                        face: face,
                        dead: false,
                        level: voice.level,
                      ),
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}

/// Where [SwarmVoice]'s take with the phone's recognizer is.
enum _Live { off, asking, listening, ending }
