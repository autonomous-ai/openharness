import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/phone/voice_notice.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/swarm_tokens_set_b.dart';

import 'swarm_conversation_page.dart' show SwarmRoundButton;
import 'swarm_dictation.dart';

/// Talking instead of typing in a chat, into the message box (Tony, 10-28:
/// "like the Claude app"). Tap the mic to talk. While talking the composer
/// shows [SwarmVoiceRow]: [stop] ends the take with its words left in the box,
/// [cancel] throws away what the take added, and [send] ends it and posts
/// the box. Voice never sends by itself (Tony, 11-01): sending is a tap on
/// Send, the composer's or the row's. No pause ends a take (10-29:
/// "until I tap") — save [idle] without a new word, which stops listening
/// with the words left in the box. A long press on the mic picks the language
/// ([voiceLanguageStore]).
///
/// Two ways to hear, the first wherever it can:
///
/// - **The phone's own recognizer** ([dictation]), the one the keyboard's
///   dictation uses: the words show in the box as they are said. Asked for
///   once, with the microphone.
/// - **The terminal's voice input** ([VoiceInputController]): the take is
///   recorded and the backend transcribes it as it ends — at [stop], or at
///   [VoiceInputController.maxTake] — its words left in the box, unsent.
///   They reach the box only once transcribed, after the take: no live words.
///   Where there is no recognizer (Android, sample mode), speech recognition
///   was refused, or the recognizer has no such language.
///
/// ⚠️ **Only while the chat is seen.** A take goes the moment the chat does —
/// covered by another screen ([hide]) or the app sent to the background — so
/// nothing is recorded, or sent to be transcribed, behind the person's back.
/// Behind a system prompt a recorded take is kept, but its time limit ends
/// it only once the app is back; a take that ended just before goes to be
/// transcribed only then, too.
class SwarmVoice extends ChangeNotifier {
  SwarmVoice({
    required this.create,
    this.dictation,
    required this.draft,
    required this.write,
    required this.post,
  });

  /// How long the recognizer listens without hearing a new word before it
  /// stops by itself: the microphone is released and the words stay in the
  /// box, for Send or the next take (Lead, review of #2056: a microphone open
  /// for nobody). A shorter pause never ends it.
  static const idle = Duration(minutes: 2);

  /// What the chat says, quietly, as the recognizer stops by itself after
  /// [idle], for [stoppedLinger] (Lead, 10-29: a mic that went still with no
  /// word said why).
  static const stoppedListening = 'Stopped listening';
  static const stoppedLinger = Duration(seconds: 3);

  /// What the chat says as a [send] ends with nothing to post (Tony, 11-01).
  static const nothingSent = "Couldn't hear anything, nothing sent";

  /// How long the recognizer has to say it has stopped, after [stop] asked it
  /// to, before its take is given up with what the box holds left there.
  static const _endWait = Duration(seconds: 2);

  /// Makes the voice input, which this owns and disposes.
  final VoiceInputController Function() create;

  /// The phone's own recognizer; null where there is none.
  final SwarmDictation? dictation;

  /// The draft as it is now, and the draft written anew.
  final String Function() draft;
  final void Function(String text) write;

  /// Posts the draft through the composer's own Send, once [send]'s take
  /// has ended into it.
  final VoidCallback post;

  /// The recognizer's take: asking for it, listening, or waiting for it to
  /// say it has stopped — as only [stop] asks.
  _Live _live = _Live.off;

  /// Bumped by everything that ends a recognizer's take, so what an earlier
  /// one still says lands nowhere.
  int _liveTake = 0;

  /// Speech recognition was refused: the mic records from now on.
  bool _liveRefused = false;

  /// What the recognizer shows is spliced into the draft after [_liveFrom]:
  /// the draft as the take began, or as the person last left it. [_liveShown]
  /// is the draft as the recognizer last wrote it; a draft that is not, the
  /// person changed — their change stays, with [_liveHeard] as it was then in
  /// it ([_liveBase]).
  String _liveFrom = '', _liveShown = '';

  /// Every word the recognizer has heard in the take, as it last said them;
  /// and those of them already in [_liveFrom].
  List<String> _liveHeard = const [], _liveBase = const [];
  Timer? _liveEnd, _liveIdle, _liveNoticeTimer, _stoppedTimer;
  final ValueNotifier<double> _liveLevel = ValueNotifier(0);
  String? _liveNotice;

  /// The row's Send under way ([send]): the take ends, then the draft is
  /// posted once. Replaced by everything that ends a take otherwise, so a
  /// take cancelled or gone meanwhile posts nothing.
  Object? _sending;

  VoiceInputController? _voice;
  bool _disposed = false;

  /// Hears the app go to the background, from the first tap.
  AppLifecycleListener? _lifecycle;

  /// The app is in front: not behind a system prompt or Control Center, nor
  /// gone. Only then does a take reach its limit and go to be transcribed.
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

  /// [stoppedListening] for a moment after the recognizer stopped by itself;
  /// null otherwise.
  String? get stopped => _stoppedTimer == null ? null : stoppedListening;

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

  /// The row's Send is under way: the take is ending, then the draft posts.
  /// The row takes no tap meanwhile.
  bool get sending => _sending != null;

  /// The row's Send can be tapped: listening, and with the phone's
  /// recognizer only once the box has words — the words a recording heard
  /// reach it only as it ends.
  bool get canSend {
    if (_disposed || _sending != null) return false;
    if (_live != _Live.off) {
      return _live == _Live.listening && draft().trim().isNotEmpty;
    }
    final voice = _voice;
    return voice != null &&
        !voice.isSending &&
        voice.status == VoiceInputStatus.listening;
  }

  /// The microphone was refused: the mic is off.
  bool get off =>
      _live == _Live.off && _voice?.status == VoiceInputStatus.unavailable;

  /// How loud the microphone is, for the face's bars.
  ValueListenable<double>? get level =>
      _live == _Live.off ? _voice?.level : _liveLevel;

  /// Starts a take, or calls it off while the microphone opens or its
  /// permission is asked. While listening it is [stop]; while the words are
  /// on their way it does nothing.
  void tap() {
    if (_disposed) return;
    switch (_live) {
      case _Live.asking:
        _offLive();
        return;
      case _Live.listening:
        _endLive();
        return;
      case _Live.ending:
        return;
      case _Live.off:
    }
    _setLiveNotice(null);
    _stoppedTimer?.cancel();
    _stoppedTimer = null;
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
        _finish(voice);
      case VoiceInputStatus.transcribing:
        break;
    }
  }

  /// Ends the take with its words left in the box. Nothing is sent.
  void stop() {
    if (_disposed) return;
    if (_live == _Live.listening) {
      _endLive();
      return;
    }
    final voice = _voice;
    if (voice != null && voice.status == VoiceInputStatus.listening) {
      _finish(voice);
    }
  }

  /// Ends the take and posts the draft with its words, once ([post]): the
  /// recognizer's last words, waited for no longer than it is at [stop]; or
  /// the recording, once transcribed. A take that ends with nothing to post
  /// posts nothing and says [nothingSent]; what was typed stays.
  void send() {
    if (!canSend) return;
    final sending = _sending = Object();
    if (_live == _Live.listening) {
      _endLive();
      return;
    }
    notifyListeners();
    unawaited(_sendRecorded(_voice!, sending));
  }

  /// [send] on a recording: what was typed, then the words transcribed.
  Future<void> _sendRecorded(VoiceInputController voice, Object sending) async {
    var posted = false;
    await voice.submit((words) async {
      // Gone meanwhile: its words land nowhere.
      if (_sending != sending) return true;
      write(_joined(draft(), words));
      posted = true;
      post();
      return true;
    });
    if (_disposed || _sending != sending) return;
    _sending = null;
    if (!posted) _setLiveNotice(nothingSent);
    notifyListeners();
  }

  /// Throws the take away: what it added leaves the box, the person's edits
  /// stay. A recorded take is dropped with its words, even while they are
  /// being transcribed ([VoiceInputController.clear]).
  void cancel() {
    if (_disposed) return;
    _sending = null;
    if (_live != _Live.off) {
      if (_live != _Live.asking && draft() == _liveShown) write(_liveFrom);
      _offLive();
      return;
    }
    final voice = _voice;
    if (voice != null && !voice.isIdle) voice.clear();
  }

  /// Throws away the take under way — opening, recording or being
  /// transcribed — with its words: the chat went out of sight. What it was
  /// waiting on lands nowhere ([VoiceInputController.clear]), and the next
  /// tap starts afresh.
  ///
  /// ⚠️ `clear`, never `stopListening` or a [_finish]: those transcribe the
  /// take, and a take nobody can see must not leave the phone.
  void hide() {
    _sending = null;
    _offLive();
    _release(false);
    final voice = _voice;
    if (voice == null || voice.isIdle) return;
    voice.clear();
  }

  VoiceInputController _start() {
    final voice = _voice = create();
    voice.addListener(_changed);
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
  /// long-press language until the next tap, for as long as the chat is in
  /// front. Refused, or without the language, the tap records instead.
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
    _liveHeard = _liveBase = const [];
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
    _waitForWords(take);
    notifyListeners();
  }

  /// Starts [idle] over: a take that hears no new word in it is called off.
  void _waitForWords(int take) {
    _liveIdle?.cancel();
    _liveIdle = Timer(idle, () {
      if (take != _liveTake || _live != _Live.listening) return;
      _stoppedTimer = Timer(stoppedLinger, () {
        _stoppedTimer = null;
        if (!_disposed) notifyListeners();
      });
      _offLive();
    });
  }

  /// Every word the recognizer has heard so far, into the draft after
  /// [_liveFrom]: those not already in it, which — after an edit — are the
  /// ones past what the recognizer said then and says still, however it has
  /// revised it since. A spoken word may show twice; none is lost.
  void _liveWords(int take, String text) {
    if (take != _liveTake || _live == _Live.off) return;
    final words = text.split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
    final now = draft();
    if (now != _liveShown) {
      _liveFrom = now;
      _liveBase = _liveHeard;
    }
    final heard = words.toList();
    final changed = heard.join(' ') != _liveHeard.join(' ');
    _liveHeard = heard;
    final kept = _sameStart(_liveBase, heard);
    _liveShown = _joined(_liveFrom, heard.skip(kept).join(' '));
    if (_liveShown != now) write(_liveShown);
    if (changed && _live == _Live.listening) _waitForWords(take);
  }

  /// How many words [a] and [b] begin with alike, case and punctuation aside.
  static int _sameStart(List<String> a, List<String> b) {
    String plain(String word) => word.toLowerCase().replaceAll(
      RegExp(r'[^\p{L}\p{N}]', unicode: true),
      '',
    );
    var same = 0;
    while (same < a.length &&
        same < b.length &&
        plain(a[same]) == plain(b[same])) {
      same++;
    }
    return same;
  }

  /// [stop]: asks the recognizer to stop — its last words, then its end
  /// ([_liveEnded]), with the words left in the box.
  void _endLive() {
    final dictation = this.dictation;
    if (_live != _Live.listening || dictation == null) return;
    final take = _liveTake;
    _live = _Live.ending;
    _stopLiveTimers();
    _liveEnd = Timer(_endWait, () {
      if (take != _liveTake) return;
      unawaited(dictation.cancel());
      _liveEnded(take, SwarmDictationEnd.failed);
    });
    notifyListeners();
    unawaited(dictation.stop());
  }

  /// The recognizer has stopped, as [stop] or [send] asked or because it
  /// cannot go on: its words stay in the box, and only [send]'s are posted.
  /// No notice after a stop with words in the box, however the recognizer's
  /// last session ended.
  void _liveEnded(int take, SwarmDictationEnd end) {
    if (take != _liveTake || _live == _Live.off) return;
    final stopped = _live == _Live.ending && draft().trim().isNotEmpty;
    final send = _sending != null && _live == _Live.ending;
    _sending = null;
    _liveTake++;
    _live = _Live.off;
    _stopLiveTimers();
    _liveLevel.value = 0;
    if (send && stopped) post();
    _setLiveNotice(switch (end) {
      _ when send && !stopped => nothingSent,
      _ when stopped => null,
      SwarmDictationEnd.failed => VoiceNotice.notTranscribed,
      _ when _liveHeard.isEmpty => VoiceNotice.nothingHeard,
      _ => null,
    });
    notifyListeners();
  }

  /// Calls off the recognizer's take, whatever it is doing: the words already
  /// shown stay in the draft, and nothing is sent.
  void _offLive() {
    if (_live == _Live.off) return;
    _sending = null;
    final listened = _live != _Live.asking;
    _liveTake++;
    _live = _Live.off;
    _stopLiveTimers();
    _liveLevel.value = 0;
    if (listened) unawaited(dictation?.cancel());
    if (!_disposed) notifyListeners();
  }

  void _stopLiveTimers() {
    _liveEnd?.cancel();
    _liveIdle?.cancel();
    _liveEnd = _liveIdle = null;
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
        if (_live != _Live.asking) _offLive();
      case AppLifecycleState.hidden ||
          AppLifecycleState.paused ||
          AppLifecycleState.detached:
        _inFront = false;
        hide();
    }
  }

  /// The app is back in front: a take that reached its limit meanwhile ends
  /// now.
  void _back() {
    final voice = _voice;
    if (voice == null || voice.status != VoiceInputStatus.listening) return;
    if (!_limitReached) return;
    _limitReached = false;
    _finish(voice);
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

  /// Ends the take, its words into the draft. A take that fails keeps the
  /// draft as it was and leaves its [notice]. Nothing is sent.
  void _finish(VoiceInputController voice) {
    unawaited(
      voice.submit((words) async {
        write(_joined(draft(), words));
        return true;
      }),
    );
  }

  void _changed() {
    if (_voice?.status != VoiceInputStatus.listening) _limitReached = false;
    notifyListeners();
  }

  /// Throws away a take still under way: the microphone closes with the chat.
  @override
  void dispose() {
    _disposed = true;
    _offLive();
    _liveNoticeTimer?.cancel();
    _stoppedTimer?.cancel();
    _liveLevel.dispose();
    _release(false);
    _lifecycle?.dispose();
    if (_voice case final voice?) {
      voice.removeListener(_changed);
      voice.dispose();
    }
    super.dispose();
  }
}

/// The composer's mic: a 36pt circle in a 44pt target, like the card's other
/// round buttons. A tap starts a take; a long press picks the language, from
/// the terminal's list. While a take is under way the composer shows
/// [SwarmVoiceRow] in its place, so the mic draws no live face of its own.
class SwarmVoiceMic extends StatelessWidget {
  const SwarmVoiceMic({super.key, required this.voice});

  final SwarmVoice voice;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
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
      label: off ? 'Voice input is off' : 'Talk',
      onLongPressHint: 'Choose language',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('swarm-mic'),
        behavior: HitTestBehavior.opaque,
        onTap: talk,
        onLongPress: chooseLanguage,
        child: _VoiceRound(
          fill: tty.text.withValues(alpha: 0.08),
          child: Icon(
            off ? LucideIcons.micOff : LucideIcons.mic,
            size: 22,
            color: off ? AppPalette.textFaint : AppPalette.textSecondary,
          ),
        ),
      ),
    );
  }
}

/// The card's toolbar while a take is under way (Tony, 11-01): cancel, the
/// wave, stop and Send — no +, Tag or mic.
///
/// - Opening ([VoiceMicFace.starting]): cancel, a flat wave and Send off.
/// - Listening: cancel, the wave following [SwarmVoice.level], stop, and
///   Send ([SwarmVoice.send]) — with the phone's recognizer only once the box
///   has words; a recording's reach it only as it ends.
/// - Busy after stop (the recognizer stopping, or the recording being
///   transcribed): cancel, the terminal's busy face where stop was, Send off.
/// - Sending ([SwarmVoice.sending]): Send's spinner, and nothing else takes
///   a tap until the post has gone.
///
/// Every label is one word: VoiceOver reads a label aloud, and a sentence
/// read into an open microphone lands in the take.
class SwarmVoiceRow extends StatelessWidget {
  const SwarmVoiceRow({super.key, required this.voice, this.canPost = true});

  final SwarmVoice voice;

  /// The composer could post now, words aside: New message has a chat
  /// picked and no post on its way.
  final bool canPost;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final face = voice.face;
    final fill = tty.text.withValues(alpha: 0.08);
    final sending = voice.sending;
    final canSend = canPost && voice.canSend;
    return Row(
      children: [
        _VoiceButton(
          key: const ValueKey('swarm-voice-cancel'),
          label: 'Cancel',
          onTap: sending ? null : voice.cancel,
          child: _VoiceRound(
            fill: fill,
            child: Icon(
              LucideIcons.x,
              size: 20,
              color: sending ? AppPalette.textFaint : AppPalette.textSecondary,
            ),
          ),
        ),
        const SizedBox(width: AppSpace.xs),
        Expanded(
          child: SwarmVoiceWave(
            key: const ValueKey('swarm-voice-wave'),
            level: face == VoiceMicFace.listening ? voice.level : null,
            flat: face != VoiceMicFace.listening,
          ),
        ),
        const SizedBox(width: AppSpace.xs),
        switch (face) {
          _ when sending => const SizedBox(width: 44),
          VoiceMicFace.listening => _VoiceButton(
            key: const ValueKey('swarm-voice-stop'),
            label: 'Stop',
            onTap: voice.stop,
            child: _VoiceRound(
              fill: fill,
              child: Container(
                width: 14,
                height: 14,
                decoration: BoxDecoration(
                  color: AppPalette.textPrimary,
                  borderRadius: BorderRadius.circular(SwarmComposer.stopRadius),
                ),
              ),
            ),
          ),
          VoiceMicFace.starting || null => const SizedBox(width: 44),
          final face => Semantics(
            key: const ValueKey('swarm-voice-busy'),
            label: 'Working',
            excludeSemantics: true,
            child: SizedBox.square(
              dimension: 44,
              child: Center(
                child: SizedBox.square(
                  dimension: 36,
                  child: FittedBox(
                    child: VoiceMicCore(face: face, dead: false),
                  ),
                ),
              ),
            ),
          ),
        },
        SwarmRoundButton(
          key: const ValueKey('swarm-voice-send'),
          label: 'Send',
          face: 36,
          fill: canSend || sending ? AppPalette.accent : ttyRaised(tty),
          onTap: canSend
              ? () {
                  HapticFeedback.lightImpact();
                  voice.send();
                }
              : null,
          child: sending
              ? SizedBox.square(
                  dimension: AppIconSize.besideText,
                  child: CircularProgressIndicator(
                    key: const ValueKey('swarm-voice-sending'),
                    strokeWidth: 2,
                    color: AppInk.onFill,
                  ),
                )
              : Icon(
                  LucideIcons.arrowUp,
                  size: 20,
                  color: canSend ? AppInk.onFill : AppPalette.textFaint,
                ),
        ),
      ],
    );
  }
}

/// A 44pt target with [child] on a 36pt circle of [fill].
class _VoiceRound extends StatelessWidget {
  const _VoiceRound({required this.fill, required this.child});

  final Color fill;
  final Widget child;

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: 44,
    child: Center(
      child: SizedBox.square(
        dimension: 36,
        child: DecoratedBox(
          decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
          child: Center(child: child),
        ),
      ),
    ),
  );
}

/// One of [SwarmVoiceRow]'s round buttons, with a light tap felt.
class _VoiceButton extends StatelessWidget {
  const _VoiceButton({
    super.key,
    required this.label,
    required this.onTap,
    required this.child,
  });

  final String label;

  /// Null while the row's Send is under way: no tap.
  final VoidCallback? onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final onTap = this.onTap;
    void tap() {
      HapticFeedback.lightImpact();
      onTap?.call();
    }

    return Semantics(
      button: true,
      enabled: onTap != null,
      label: label,
      onTap: onTap == null ? null : tap,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap == null ? null : tap,
        child: child,
      ),
    );
  }
}

/// The voice row's wave: a history of the microphone's [level] scrolling in
/// from the right, one bar 2 wide every 2, 3 to 24 tall. A breath of motion
/// even in silence, so a listening take never looks frozen; [flat] draws the
/// bars at rest while the microphone opens or the words are on their way.
///
/// Painted, not built: the history moves in a [CustomPainter] behind a
/// [RepaintBoundary], so the composer around it is not rebuilt at every
/// frame. Under Reduce Motion nothing scrolls: the bars hold one shape that
/// rises and falls with the level alone.
class SwarmVoiceWave extends StatefulWidget {
  const SwarmVoiceWave({super.key, required this.level, this.flat = false});

  final ValueListenable<double>? level;
  final bool flat;

  static const double bar = 2;
  static const double gap = 2;
  static const double low = 3;
  static const double high = 24;

  /// How often a new bar comes in on the right.
  static const Duration step = Duration(milliseconds: 70);

  /// The most bars kept: enough for any phone's width.
  static const int _keep = 160;

  @override
  State<SwarmVoiceWave> createState() => _SwarmVoiceWaveState();
}

class _SwarmVoiceWaveState extends State<SwarmVoiceWave>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);

  /// Each bar's height, 0 to 1, oldest first.
  final List<double> _history = [];

  /// Bumped as the history moves: what repaints the painter.
  final ValueNotifier<int> _moved = ValueNotifier(0);
  Duration _last = Duration.zero;
  double _shown = 0;
  bool _motion = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _motion = !MediaQuery.disableAnimationsOf(context);
    _sync();
  }

  @override
  void didUpdateWidget(SwarmVoiceWave old) {
    super.didUpdateWidget(old);
    if (widget.flat && !old.flat) {
      _history.clear();
      _moved.value++;
    }
    _sync();
  }

  void _sync() {
    final run = _motion && !widget.flat;
    if (run && !_ticker.isActive) {
      _last = Duration.zero;
      unawaited(_ticker.start());
    } else if (!run && _ticker.isActive) {
      _ticker.stop();
    }
  }

  void _tick(Duration elapsed) {
    if (elapsed - _last < SwarmVoiceWave.step) return;
    _last = elapsed;
    final target = (widget.level?.value ?? 0).clamp(0.0, 1.0);
    _shown += (target - _shown) * 0.6;
    // A breath in silence: never a flat, frozen line while listening.
    final breath = 0.06 + 0.05 * math.sin(elapsed.inMilliseconds / 180.0).abs();
    _history.add(math.max(_shown, breath).clamp(0.0, 1.0));
    if (_history.length > SwarmVoiceWave._keep) _history.removeAt(0);
    _moved.value++;
  }

  @override
  void dispose() {
    _ticker.dispose();
    _moved.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final level = widget.level;
    return RepaintBoundary(
      child: SizedBox(
        height: 44,
        child: CustomPaint(
          painter: _WavePainter(
            history: _history,
            moved: _moved,
            color: AppPalette.textPrimary,
            flat: widget.flat,
            still: !_motion && level != null ? level : null,
          ),
          size: Size.infinite,
        ),
      ),
    );
  }
}

class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.history,
    required this.moved,
    required this.color,
    required this.flat,
    required this.still,
  }) : super(repaint: still == null ? moved : Listenable.merge([moved, still]));

  final List<double> history;
  final Listenable moved;
  final Color color;
  final bool flat;

  /// Under Reduce Motion: the level the one still shape follows.
  final ValueListenable<double>? still;

  @override
  void paint(Canvas canvas, Size size) {
    const pitch = SwarmVoiceWave.bar + SwarmVoiceWave.gap;
    final count = (size.width / pitch).floor();
    if (count <= 0) return;
    final paint = Paint()..color = color;
    final mid = size.height / 2;
    double heightOf(int i) {
      if (flat) return 0;
      if (still case final still?) {
        // One shape, taller toward the middle, scaled by the level.
        final shape = 0.35 + 0.65 * math.sin(math.pi * (i + 0.5) / count);
        return (0.08 + 0.92 * still.value.clamp(0.0, 1.0)) * shape;
      }
      // Newest on the right.
      final back = count - 1 - i;
      final at = history.length - 1 - back;
      return at < 0 ? 0 : history[at];
    }

    for (var i = 0; i < count; i++) {
      final amount = heightOf(i);
      final h =
          SwarmVoiceWave.low +
          (SwarmVoiceWave.high - SwarmVoiceWave.low) * amount;
      final x = size.width - (count - i) * pitch + SwarmVoiceWave.gap;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, mid - h / 2, SwarmVoiceWave.bar, h),
          const Radius.circular(SwarmVoiceWave.bar / 2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) =>
      old.flat != flat || old.color != color || old.still != still;
}

/// Where [SwarmVoice]'s take with the phone's recognizer is.
enum _Live { off, asking, listening, ending }
