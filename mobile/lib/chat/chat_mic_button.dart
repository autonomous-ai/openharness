import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_action.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

/// Chat UI's mic, in the composer: the phone's own voice input, the same take the terminal's mic
/// records, transcribes and sends ([voiceMicAction]) — only drawn at the composer's size.
class ChatMicButton extends StatelessWidget {
  const ChatMicButton({super.key, required this.voice, required this.session});

  final VoiceInputController voice;
  final TerminalSession session;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: voice,
    builder: (context, _) {
      AppTheme.watch(context);
      final action = voiceMicAction(voice, session);
      final face = action.face;
      final live = face == VoiceMicFace.listening;
      final waiting =
          face == VoiceMicFace.starting ||
          face == VoiceMicFace.busy ||
          face == VoiceMicFace.sending ||
          face == VoiceMicFace.cancelling;
      final Widget glyph = waiting
          ? SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppPalette.textSecondary,
              ),
            )
          : Icon(
              switch (face) {
                VoiceMicFace.listening => LucideIcons.audioLines,
                VoiceMicFace.sent => LucideIcons.check,
                VoiceMicFace.retry => LucideIcons.rotateCcw,
                VoiceMicFace.off => LucideIcons.micOff,
                _ => LucideIcons.mic,
              },
              size: 18,
              color: live ? Colors.white : AppPalette.textPrimary,
            );
      final tap = action.onPressed;
      final holdStart = action.onHoldStart;
      final holdFinish = action.onHoldFinish;
      return Semantics(
        button: true,
        label: live ? 'Send what was said' : 'Talk',
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: tap,
          onLongPressStart: holdStart == null ? null : (_) => holdStart(),
          onLongPressEnd: holdFinish == null
              ? null
              : (_) => holdFinish(cancelled: false),
          onLongPressCancel: holdFinish == null
              ? null
              : () => holdFinish(cancelled: true),
          child: Container(
            width: 36,
            height: 36,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: live ? AppPalette.dangerFill : Colors.transparent,
            ),
            child: glyph,
          ),
        ),
      );
    },
  );
}
