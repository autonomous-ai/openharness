import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The chat's prose in the app's own face: messages, quotes, names and fields.
TextStyle swarmChatText(
  double size, {
  Color? color,
  FontWeight weight = FontWeight.w400,
  double height = 1.35,
}) => TextStyle(
  fontSize: size,
  height: height,
  color: color ?? AppPalette.textPrimary,
  fontWeight: weight,
);

/// The hairline around the chat's cards, picker and field.
Color swarmChatHair(Tty tty) => tty.text.withValues(alpha: 0.12);

/// The ground of a card in the chat: a decision, the picker, a file.
Color swarmChatCard(Tty tty) =>
    Color.alphaBlend(tty.text.withValues(alpha: 0.05), tty.ground);
