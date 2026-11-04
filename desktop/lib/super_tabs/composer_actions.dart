import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';

/// How far a composer's row of [target]-square buttons sits in from the box's
/// sides, and up from its bottom, so the glyphs of + and send keep the text's
/// edges and the arrow sits as far up as the text sits down (Huy, 11-04). A
/// phone's finger targets take what they need.
EdgeInsets composerRowInsets({required double target}) {
  final glyph = (target - AppIcons.inlineSize) / 2;
  final side = math.max(0.0, grid.AppDesktop.composerSide - glyph);
  return EdgeInsets.fromLTRB(
    side,
    0,
    side,
    math.max(0.0, grid.AppDesktop.composerTop - glyph),
  );
}

/// The text's insets in a composer's box, above [composerRowInsets]' row of
/// [target]-square buttons: the same air between the text and the glyphs as
/// over Desktop's 32pt targets, so a phone's taller ones add none.
EdgeInsets composerFieldInsets({required double target}) => EdgeInsets.fromLTRB(
  grid.AppDesktop.composerSide,
  grid.AppDesktop.composerTop,
  grid.AppDesktop.composerSide,
  math.max(
    0.0,
    grid.AppDesktop.composerRowGap - (target - grid.AppControl.height) / 2,
  ),
);

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
