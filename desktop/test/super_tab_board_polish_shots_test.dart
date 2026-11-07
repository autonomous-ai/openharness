// The Board and middle of the Desktop 1.3.89 audit (task #4445), light and dark, for the PR's pictures: the Board at
// 1500 with Working in view, at 880 with the left pane folded and its drawer open, the empty Swarm, and List on.
// Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'super_tab_board_fit_test.dart' show closeWindow, crewServer, showWindow;
import 'super_tab_empty_swarm_test.dart' show endEmptySwarm, showEmptySwarm;
import 'support/capture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    final name = brightness.name;

    testWidgets('the Board at 1500 ($name)', (tester) async {
      if (shots == null) return;
      final c = await showWindow(tester, crewServer(), brightness: brightness);
      await captureWindow(tester, shots, 'board-1500-$name');
      await closeWindow(tester, c);
    });

    testWidgets('the Board at 880, folded and with its drawer ($name)', (
      tester,
    ) async {
      if (shots == null) return;
      final c = await showWindow(
        tester,
        crewServer(),
        width: 880,
        brightness: brightness,
      );
      await captureWindow(tester, shots, 'board-880-folded-$name');
      await tester.tap(find.byTooltip('Conversations'));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'board-880-drawer-$name');
      await closeWindow(tester, c);
    });

    testWidgets('the empty Swarm ($name)', (tester) async {
      if (shots == null) return;
      final c = await showEmptySwarm(tester, brightness: brightness);
      await captureWindow(tester, shots, 'empty-swarm-$name');
      await endEmptySwarm(tester, c);
    });

    testWidgets('List on, under the Board tab ($name)', (tester) async {
      if (shots == null) return;
      final c = await showWindow(tester, crewServer(), brightness: brightness);
      await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'board-list-$name');
      await closeWindow(tester, c);
    });
  }
}
