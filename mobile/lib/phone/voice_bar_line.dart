import 'package:flutter/material.dart';

import 'tty.dart';
import 'voice_mic_face.dart' show VoiceMicCore;
import 'voice_input_controller.dart';

/// What the mic is doing — shown by the mic itself, not said beside it.
///
/// Recording, the mic is green and [VoiceLevelHalo] glows behind it with the voice; opening,
/// transcribing and sending, its arc spins. Words appear on the line above it only when something
/// went wrong ([voiceStatus]). The take goes to the harness on screen, which its title names.
abstract final class VoiceLine {
  /// Whether the voice has anything to say or show.
  static bool shows(VoiceInputController voice) =>
      voice.isSending ||
      voice.notice != null ||
      voice.transcript.isNotEmpty ||
      voice.status == VoiceInputStatus.starting ||
      voice.status == VoiceInputStatus.listening ||
      voice.status == VoiceInputStatus.transcribing;
}

/// The words for the line above the mic — only when something went wrong: the mic could not
/// start or heard nothing, or a take is kept unsent. Null the rest of the time, the mic's own
/// face saying the rest.
({String text, Color color})? voiceStatus(VoiceInputController voice, Tty tty) {
  if (voice.notice case final notice?) {
    return (text: notice.toLowerCase(), color: tty.yellow);
  }
  final idle =
      !voice.isSending &&
      voice.status != VoiceInputStatus.starting &&
      voice.status != VoiceInputStatus.listening &&
      voice.status != VoiceInputStatus.transcribing;
  if (idle && voice.transcript.isNotEmpty) {
    return (text: 'not sent · tap the mic again', color: tty.red);
  }
  return null;
}

/// How loud the take is, as Siri shows it: a soft green glow behind the mic that swells with the
/// voice — [VoiceMicCore.diameter] at silence, 28pt wider at full voice.
class VoiceLevelHalo extends StatefulWidget {
  const VoiceLevelHalo({super.key, required this.voice});

  final VoiceInputController voice;

  /// The widest it grows: the box it is laid out in.
  static const double extent = VoiceMicCore.diameter + 28;

  @override
  State<VoiceLevelHalo> createState() => _VoiceLevelHaloState();
}

class _VoiceLevelHaloState extends State<VoiceLevelHalo> {
  double _level = 0;

  @override
  void initState() {
    super.initState();
    widget.voice.level.addListener(_onLevel);
  }

  @override
  void didUpdateWidget(VoiceLevelHalo old) {
    super.didUpdateWidget(old);
    if (!identical(old.voice, widget.voice)) {
      old.voice.level.removeListener(_onLevel);
      widget.voice.level.addListener(_onLevel);
    }
  }

  @override
  void dispose() {
    widget.voice.level.removeListener(_onLevel);
    super.dispose();
  }

  void _onLevel() {
    if (widget.voice.status != VoiceInputStatus.listening) return;
    final level = widget.voice.level.value.clamp(0.0, 1.0);
    if ((level - _level).abs() > 0.02) setState(() => _level = level);
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final size =
        VoiceMicCore.diameter +
        (VoiceLevelHalo.extent - VoiceMicCore.diameter) * _level;
    return SizedBox.square(
      dimension: VoiceLevelHalo.extent,
      child: Center(
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: tty.green.withValues(alpha: 0.28),
          ),
        ),
      ),
    );
  }
}
