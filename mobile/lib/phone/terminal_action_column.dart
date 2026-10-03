import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_input_controller.dart';
import 'voice_mic_button.dart';
import 'voice_mic_face.dart';
import 'voice_mic_fab.dart';

/// The terminal's floating control: the mic, low at the foot of the page — see `terminal_page.dart`
/// for where it stands.
///
/// ⚠️ **The mic alone.** Search used to ride in a column under it, and over it while the keyboard
/// was up; Find is a swipe right or a tap on the agent's name now, and the column kept only the
/// mic. What the mic is doing is shown by the mic itself — see `voice_bar_line.dart`.
class TerminalActionColumn extends StatelessWidget {
  const TerminalActionColumn({
    super.key,
    required this.voice,
    required this.session,
    this.working = false,
  });

  final VoiceInputController voice;

  /// The agent is working: the mic wears a ring — see `VoiceMicCore.working`.
  final bool working;

  /// Null while the terminal is still attaching: the mic is drawn dimmed and
  /// dead, since there is nothing to talk to yet.
  final TerminalSession? session;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = this.session;
    // Still attaching: the mic in its place, dimmed and dead.
    if (session == null) {
      return const VoiceMicButton(face: VoiceMicFace.talk, onPressed: null);
    }
    return VoiceMicFab(voice: voice, session: session, working: working);
  }
}
