import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_language_store.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

/// Talking instead of typing in a chat: the terminal's voice input
/// ([VoiceInputController]), with what it hears put into the message box —
/// never sent. Send is the person's own tap, once they have read it.
///
/// Tap to talk; tap again, or stop talking for [pause], and the take is
/// transcribed into the box. The words land when the take ends, not as they
/// are said: the backend's speech-to-text takes a finished recording. The
/// language is the terminal's ([voiceLanguageStore]).
///
/// ⚠️ **Only while the chat is seen.** A take goes the moment the chat does —
/// covered by another screen ([hide]) or the app sent to the background — so
/// nothing is recorded, or sent to be transcribed, behind the person's back.
/// Behind a system prompt the take is kept, but nothing ends it by itself
/// until the app is back: neither its pause nor its time limit. A take that
/// ended just before goes to be transcribed only then, too.
class SwarmVoice extends ChangeNotifier {
  SwarmVoice({required this.create, required this.insert});

  /// How long a quiet after speech ends the take, as a second tap does.
  static const pause = Duration(seconds: 3);

  /// The microphone's level (`pcm16Level`, 0…1) at and above which it hears
  /// speech, and below which [_quiet] begins a pause. Apart, so a soft word
  /// keeps the take going without being needed to start the count.
  static const _speech = 0.4;
  static const _quiet = 0.25;

  /// Makes the voice input, which this owns and disposes.
  final VoiceInputController Function() create;

  /// Puts what was heard into the draft.
  final void Function(String words) insert;

  VoiceInputController? _voice;

  /// Speech was heard in this take: only then does a quiet end it, so the
  /// moment before somebody starts talking is not a pause.
  bool _spoke = false;
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
  String? get notice => _voice?.notice;

  /// Starts a take; ends it, calls it off while the microphone opens, or
  /// does nothing while its words are on their way.
  void tap() {
    if (_disposed) return;
    final voice = _voice ?? _start();
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

  /// Throws away the take under way — opening, recording or being
  /// transcribed — with its words: the chat went out of sight. What it was
  /// waiting on lands nowhere ([VoiceInputController.clear]), and the next
  /// tap starts afresh.
  ///
  /// ⚠️ `clear`, never `stopListening` or a [_finish]: those transcribe the
  /// take, and a take nobody can see must not leave the phone.
  void hide() {
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
    final state = WidgetsBinding.instance.lifecycleState;
    _inFront = state == null || state == AppLifecycleState.resumed;
    _lifecycle = AppLifecycleListener(onStateChange: _lifecycleChanged);
    return voice;
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
      case AppLifecycleState.inactive:
        _inFront = false;
        _stopPause();
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
    _heard();
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
  /// draft as it was and leaves its [notice].
  void _finish(VoiceInputController voice) {
    _stopPause();
    unawaited(
      voice.submit((words) async {
        insert(words);
        return true;
      }),
    );
  }

  void _changed() {
    if (_voice?.status != VoiceInputStatus.listening) {
      _stopPause();
      _spoke = false;
      _limitReached = false;
    }
    notifyListeners();
  }

  /// The microphone's level moved: speech holds the take open, and a quiet
  /// after it starts the [pause] that ends it.
  void _heard() {
    final voice = _voice;
    if (voice == null || voice.status != VoiceInputStatus.listening) return;
    final level = voice.level.value;
    if (level >= _quiet) {
      _stopPause();
      if (level >= _speech) _spoke = true;
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
    final controller = voice.voice;
    final face = controller == null
        ? null
        : controller.isSending
        ? VoiceMicFace.busy
        : switch (controller.status) {
            VoiceInputStatus.starting => VoiceMicFace.starting,
            VoiceInputStatus.listening => VoiceMicFace.listening,
            VoiceInputStatus.transcribing => VoiceMicFace.busy,
            VoiceInputStatus.idle || VoiceInputStatus.unavailable => null,
          };
    final off = controller?.status == VoiceInputStatus.unavailable;
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
                        level: controller!.level,
                      ),
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}
