// Task #2914 (Diego, 11-04): Activity beside the menu bar's Swarm rows, for the PR's pictures, light and dark. The
// rows are what Dart hands the native menu (statusMenuSwarmEntries), drawn here in its layout: AppKit's own menu
// cannot be drawn offscreen. Writes nothing unless MENU_SHOTS names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/status_menu.dart';
import 'package:harness/super_tabs/activity_view.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;
import 'super_tab_menu_bar_notices_test.dart' show openWithEverything;
import 'support/capture.dart';

final shots = Platform.environment['MENU_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('Activity and the menu bar in ${brightness.name}', (
      tester,
    ) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2240, 1100);
      addTearDown(tester.view.reset);
      final f = SuperTabLaunchFixture(local: true);
      f.connection.server.followedThreads = {
        'unread': [],
        'read': [],
        'more': false,
      };
      final activity = (await tester.runAsync(() => openWithEverything(f)))!;
      final rows = statusMenuSwarmEntries(f.app);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 720,
                  child: SuperTabActivityView(
                    activity: activity,
                    onOpenMention: (_) {},
                    onOpenThread: (_, _) {},
                    onOpenConversation: (_) {},
                  ),
                ),
                const VerticalDivider(width: 1),
                SizedBox(width: 380, child: _MenuRows(rows)),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'needs-you-${brightness.name}');
      await tester.tap(
        find.byKey(const ValueKey('super-activity-tab-mentions')),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'mentions-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    });
  }
}

/// The menu bar's Swarm section as HarnessStatusMenu.swift lays it out: a
/// heading with its count, then each row's title and message.
class _MenuRows extends StatelessWidget {
  const _MenuRows(this.rows);
  final List<Map<String, Object?>> rows;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final quiet = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Menu bar (rows as sent to the native menu)', style: quiet),
        const SizedBox(height: 12),
        Text(
          'Swarm  ${rows.length}',
          style: theme.textTheme.labelLarge?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 8),
        for (final row in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  row['title'] as String,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if ((row['message'] as String?)?.isNotEmpty ?? false)
                  Text(row['message'] as String),
                Text(row['detail'] as String? ?? '', style: quiet),
              ],
            ),
          ),
      ],
    );
  }
}
