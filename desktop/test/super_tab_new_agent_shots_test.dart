// Desktop 1.3.89 audit, findings 11 and 14 (task #4445): + New agent's form, for the PR's pictures, light and dark, at
// 880 and 1500 wide. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'super_tab_new_agent_words_test.dart'
    show mountSwarm, tapNewAgent, unmountSwarm;
import 'support/capture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
final _kind = find.byKey(const ValueKey('new-harness-field-agent-kind'));

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final width in [880.0, 1500.0]) {
      final suffix = '${width.toInt()}-${brightness.name}';
      testWidgets('+ New agent at $suffix', (tester) async {
        if (shots == null) return;
        final f = await mountSwarm(tester, brightness: brightness);
        await tapNewAgent(tester);
        tester.view.physicalSize = Size(width, 900);
        await tester.pumpAndSettle();
        // The role chip beside New agent (product owner's ask).
        await captureWindow(tester, shots, 'new-agent-role-chip-$suffix');

        await tester.tap(_kind);
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'new-agent-role-menu-$suffix');

        await tester.tap(
          find.byKey(const ValueKey('new-harness-agent-kind-lead')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('new-harness-project-visibility')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'new-agent-pm-visibility-$suffix');
        await unmountSwarm(tester, f);
      });
    }
  }
}
