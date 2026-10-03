@TestOn('browser')
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

/// In a browser a physical Backspace is the terminal's to send, on every
/// platform the browser reports — including the macOS and iOS that native
/// builds hand to Apple's text input client. Nothing typed in the hidden
/// input, it still reaches the pty (a pasted `[Image #1]` gets removed).
void main() {
  for (final platform in [
    TargetPlatform.macOS,
    TargetPlatform.iOS,
    TargetPlatform.android,
    TargetPlatform.windows,
  ]) {
    testWidgets('Backspace reaches the pty once on ${platform.name}', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = platform;
      final output = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: TerminalView(Terminal(onOutput: output.add), autofocus: true),
        ),
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.pump();
      // Reset inside the test: the binding checks debug overrides before
      // tear-downs run.
      debugDefaultTargetPlatformOverride = null;
      expect(output.join(), '\x7f');
    });
  }
}
