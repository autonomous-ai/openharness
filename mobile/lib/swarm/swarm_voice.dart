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

  VoiceInputController _start() {
    final voice = _voice = create();
    voice.addListener(_changed);
    voice.level.addListener(_heard);
    return voice;
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
    if (!_spoke) return;
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
