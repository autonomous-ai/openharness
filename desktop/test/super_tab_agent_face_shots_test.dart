// Audit findings 6 and 12 of task #4211: My agents with each agent's face, and @ in an agent's own chat, for the PR's
// pictures, light and dark. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'super_tab_agent_face_test.dart' show showAgentFaces;
import 'super_tab_private_mention_test.dart' show privateMentionSwarm;
import 'support/capture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final scene in ['agent-faces', 'private-mention']) {
      testWidgets('$scene (${brightness.name})', (tester) async {
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final c = await showAgentFaces(
          tester,
          privateMentionSwarm(),
          selectedId: 'agent-chat-kestrel',
          brightness: brightness,
        );
        if (scene == 'private-mention') {
          final composer = find.byKey(const ValueKey('super-message-composer'));
          await tester.tap(composer);
          await tester.enterText(composer, 'Please check @');
          await tester.pump();
        }
        await captureWindow(tester, shots, '$scene-${brightness.name}');
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(c.flush);
        c.dispose();
      });
    }
  }
}
