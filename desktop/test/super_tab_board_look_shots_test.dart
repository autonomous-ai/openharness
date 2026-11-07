// Task #3787 item 2 (anh Dee, 11-06): the Tasks Board as Trello draws one, for the PR's pictures, light and dark.
// Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/tasks_view.dart';

import 'super_tab_pulse_test.dart' show pulseFixture, pulseServer, pulseNow;
import 'super_tab_tasks_view_test.dart' show taskFixture;
import 'support/capture.dart';
import 'support/memory_key_value_store.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

/// A board with work in every column: proposals, P0 and P1 next to quiet P2
/// work, lanes, an agent on a card, pull requests, one that needs the reader,
/// one unread and the one the reader has open.
List<Map<String, dynamic>> _tasks() => [
  {
    ...taskFixture('hotfix', 'Sign-in loops forever after a token refresh', 30),
    'priority': 'P0',
    'handOutLane': 'backend',
  },
  {
    ...taskFixture('composer', 'Composer keeps its draft across tabs', 31),
    'priority': 'P1',
    'handOutLane': 'Desktop',
    'requesterId': 'tony',
  },
  {
    ...taskFixture('docs-lanes', 'Document the crew lanes', 32),
    'handOutLane': 'docs',
    'requesterId': 'scholes',
  },
  {
    ...taskFixture(
      'board-look',
      'Board looks like Trello in light and dark',
      33,
      requester: 'owner',
      status: 'working',
      pullRequest: 3790,
    ),
    'priority': 'P1',
    'handOutLane': 'Desktop',
  },
  {
    ...taskFixture(
      'cli-retry',
      'CLI retries a lost upload once',
      34,
      requester: 'ken',
      status: 'working',
    ),
    'handOutLane': 'CLI',
    'lastMessageSequence': 10,
  },
  {
    ...taskFixture(
      'phone-rename',
      'Rename a Swarm from the phone',
      35,
      requester: 'tony',
      status: 'review',
      pullRequest: 3772,
      liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
    ),
    'handOutLane': 'mobile',
  },
  {
    ...taskFixture(
      'release-notes',
      'Release notes name every part that shipped',
      36,
      requester: 'scholes',
      status: 'done',
      pullRequest: 3755,
      merged: true,
      shippedAt: pulseNow.subtract(const Duration(hours: 5)),
    ),
    'handOutLane': 'backend',
  },
];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('Board in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(3080, 1640);
      addTearDown(tester.view.reset);
      final server = pulseServer(pulseFixture());
      server.proposals['lead']!.first['priority'] = 'P1';
      (server.state['conversations'] as List).addAll(_tasks());
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: Scaffold(
            body: SuperTabTasksView(
              controller: c,
              project: c.snapshot!.projects.single,
              storage: MemoryKeyValueStore(),
              needsHuman: (_) => 0,
              onOpenTask: (_) {},
              onOpenProposal: (_) {},
              onOpenMessage: (_, _) {},
              selectedId: 'board-look',
              now: () => pulseNow,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await captureWindow(tester, shots, 'board-look-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });
  }
}
