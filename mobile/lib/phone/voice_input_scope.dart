import 'package:flutter/widgets.dart';

import 'voice_input_controller.dart';

/// Who makes the voice input for the terminal pages below — where it is not the backend's
/// speech-to-text over the phone's microphone.
///
/// Sample mode (`lib/demo/`) is the one place that has this: it has no account to sign a
/// transcription with and no reason to open the microphone, so it hands its own controller down
/// here. Without one, `AgentSwipeHost` builds the ordinary controller, exactly as before.
class VoiceInputScope extends InheritedWidget {
  const VoiceInputScope({
    super.key,
    required this.create,
    required super.child,
  });

  /// A new controller for one pager, which owns and disposes it.
  final VoiceInputController Function() create;

  static VoiceInputScope? maybeOf(BuildContext context) =>
      context.getInheritedWidgetOfExactType<VoiceInputScope>();

  @override
  bool updateShouldNotify(VoiceInputScope oldWidget) => false;
}
