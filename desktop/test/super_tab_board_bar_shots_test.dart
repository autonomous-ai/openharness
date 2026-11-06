import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'super_tab_board_layout_test.dart' show boardSwarm;
import 'support/capture.dart';

/// Set to a folder to write the review's screenshots there.
final shots = Platform.environment['SUPER_TAB_TASKS_SHOTS'];

/// The Board page as the review shows it (Huy, 2026-11-06): one row above the
/// lanes (header, Board/List/Members as one control, Mine, Search), and the
/// Buddy pane's ⋮ with Restart, Remove and Rename, in both appearances.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1900, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final before = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = before);
      final c = boardSwarm(buddy: true).controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      await tester.runAsync(c.refresh);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'MacBookPro2021',
              board: true,
            ),
          ),
        ),
      );
      Future<void> settle() => tester.pumpAndSettle(
        const Duration(milliseconds: 50),
        EnginePhase.sendSemanticsUpdate,
        const Duration(seconds: 5),
      );
      await settle();
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await settle();
      expect(find.byKey(const ValueKey('super-tasks-layout')), findsOneWidget);
      await captureWindow(tester, shots, 'board-bar-${brightness.name}');

      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('super-board-chat')),
          matching: find.byTooltip('Buddy options'),
        ),
      );
      await settle();
      expect(find.text('Remove Buddy'), findsOneWidget);
      await captureWindow(tester, shots, 'board-buddy-menu-${brightness.name}');

      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    });
  }
}
