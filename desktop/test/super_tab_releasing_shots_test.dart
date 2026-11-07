import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/tasks_view.dart';

import 'super_tab_tasks_view_test.dart' show tasksServer, taskFixture;
import 'support/capture.dart';
import 'support/memory_key_value_store.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_RELEASING_SHOTS'];

final _now = DateTime(2026, 11, 5, 12);

/// The board as the PR shows it (Dee, task #3452): merged tasks waiting on
/// their release sit in Merged, with their parts; released ones, and merges
/// from before the server kept a release list, stay in Shipped.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (board, ${brightness.name})', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1500, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final before = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = before);
      final server = tasksServer();
      server.proposals['lead'] = [];
      (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        taskFixture(
          'dial',
          'Round dial: instant recap on swipe',
          3401,
          requester: 'scholes',
          status: 'done',
          pullRequest: 3231,
          merged: true,
          shippedAt: _now.subtract(const Duration(hours: 2)),
          releasing: ['desktop', 'cli'],
        ),
        taskFixture(
          'reminder',
          'Opening a reminder opens no empty thread',
          3445,
          requester: 'owner',
          status: 'done',
          pullRequest: 3234,
          merged: true,
          shippedAt: _now.subtract(const Duration(minutes: 3)),
          releasing: [],
        ),
        taskFixture(
          'window',
          'Releases outside the window are refused',
          3388,
          requester: 'ken',
          status: 'done',
          pullRequest: 3210,
          merged: true,
          shippedAt: _now.subtract(const Duration(days: 1)),
          releasing: ['backend'],
        ),
        taskFixture(
          'released',
          'Board counts only what is released',
          3350,
          requester: 'scholes',
          status: 'done',
          pullRequest: 3190,
          merged: true,
          shippedAt: _now.subtract(const Duration(days: 3)),
        ),
      ]);
      final c = server.controller();
      addTearDown(c.dispose);
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
              onOpenMessage: (_, _) {},
              onOpenProposal: (_) {},
              now: () => _now,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final words in [
        'waiting for Desktop, CLI',
        'waiting for a release',
        'waiting for Backend',
      ]) {
        expect(find.textContaining(words), findsOneWidget, reason: words);
      }
      expect(tester.takeException(), isNull);
      await captureWindow(tester, shots, 'releasing-board-${brightness.name}');
    });
  }
}
