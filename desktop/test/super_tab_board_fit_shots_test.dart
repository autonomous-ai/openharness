// Audit finding 5 of task #4211 (task #4251): a 1500×860 window, its Board's middle about 860 wide, with Proposal
// empty and several Shipped, for the PR's pictures, light and dark. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE
// names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_tasks_view_test.dart' show taskFixture;
import 'support/capture.dart';
import 'support/memory_key_value_store.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

/// Two Next up, three Working (one in review), one Done, one Merged waiting for its release and five Shipped.
List<Map<String, dynamic>> _tasks() {
  final now = DateTime.now();
  return [
    taskFixture('hotfix', 'Sign-in loops forever after a token refresh', 30),
    taskFixture('lanes', 'Document the crew lanes', 31),
    taskFixture(
      'composer',
      'Composer keeps its draft across tabs',
      32,
      status: 'working',
      agent: 'kestrel',
      pullRequest: 3790,
    ),
    taskFixture(
      'rename',
      'Rename a Swarm from the phone',
      33,
      status: 'review',
      agent: 'kestrel',
      pullRequest: 3772,
      liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
    ),
    taskFixture(
      'repair',
      'Repair the release notes',
      34,
      status: 'done',
      agent: 'kestrel',
      pullRequest: 3773,
    ),
    taskFixture(
      'fit',
      'Board fits the middle',
      35,
      status: 'done',
      agent: 'kestrel',
      pullRequest: 3774,
      merged: true,
      releasing: ['desktop'],
    ),
    for (final (i, title) in [
      'CLI retries a lost upload once',
      'Phone shows who is typing',
      'Release notes name every part',
      'Machines list sorts by load',
      'Invite link expires in a week',
    ].indexed)
      taskFixture(
        'shipped-$i',
        title,
        40 + i,
        status: 'done',
        agent: 'kestrel',
        pullRequest: 3700 + i,
        merged: true,
        shippedAt: now.subtract(Duration(hours: i + 1)),
      ),
  ];
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('Board fits a 1500×860 window (${brightness.name})', (
      tester,
    ) async {
      if (shots == null) return;
      await tester.binding.setSurfaceSize(const Size(1500, 860));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      final server = swarm();
      final conversations = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>();
      conversations.removeWhere((g) => g['id'] == 'offline');
      conversations.addAll(_tasks());
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      await tester.runAsync(c.refresh);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              paneStore: MemoryKeyValueStore(),
              board: true,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // A project's Board opens from the Projects grid (task #4466).
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-tasks-board-more-right')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await captureWindow(tester, shots, 'board-fit-1500-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    });
  }
}
