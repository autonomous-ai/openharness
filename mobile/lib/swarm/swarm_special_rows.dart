import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_message_row.dart' show SwarmMessageFrame, swarmChatText;

TextStyle _quiet() => swarmChatText(14, color: AppPalette.textSecondary);

/// The quiet line a terminal's answer starts with, and the one under a
/// response that was cut short (Desktop's view.dart).
Widget? swarmTerminalNote(SuperTabMessage message) =>
    switch (message.terminalNote) {
      final note? => Padding(
        padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
        child: Text(note, style: _quiet()),
      ),
      null => null,
    };

Widget? swarmCutShort(SuperTabMessage message) {
  final words = message.source['truncated'] == true
      ? 'Excerpt · open the terminal for the full response'
      : message.source['interrupted'] == true
      ? 'Response interrupted'
      : null;
  return words == null
      ? null
      : Padding(
          padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
          child: Text(words, style: _quiet()),
        );
}
