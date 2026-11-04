import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/widgets/app_icon_button.dart';

/// @ Tag on a composer's row, as on the phone: it types `@` at the caret
/// ([superTabTagPrompt]), and the tag list opens as for one typed.
class SuperTabComposerTagButton extends StatelessWidget {
  const SuperTabComposerTagButton({super.key, required this.onPressed});

  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => AppIconButton(
    icon: AppIcons.atSign,
    tooltip: 'Tag someone',
    onPressed: onPressed,
  );
}

/// The mic left of send: starts a voice message (voice_recorder.dart). A
/// composer draws it only with a recorder.
class SuperTabComposerMic extends StatelessWidget {
  const SuperTabComposerMic({super.key, required this.onPressed});

  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => AppIconButton(
    icon: AppIcons.mic,
    tooltip: 'Record a voice message',
    onPressed: onPressed,
  );
}
