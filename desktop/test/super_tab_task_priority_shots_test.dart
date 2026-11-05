import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'super_tab_tasks_view_test.dart' show tasksServer, taskFixture;
import 'support/capture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_PRIORITY_SHOTS'];

/// Task priorities as the PR shows them (task #3117): the Board with a badge
/// on every card, P0 first in its column, and a task's header with its
/// priority menu open, in both appearances.
void main() {
  setUpAll(() async {
    await loadCaptureFonts(shots);
    if (shots != null && Platform.isMacOS) {
      for (final (family, path) in [
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    }
  });

  for (final brightness in Brightness.values) {
    for (final view in ['board', 'header']) {
      testWidgets('screenshots for review ($view, ${brightness.name})', (
        tester,
      ) async {
        await tester.binding.setSurfaceSize(const Size(1900, 900));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = before);
        final server = tasksServer();
        server.proposals['lead']!.first['priority'] = 'P1';
        (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          {
            ...taskFixture('hotfix', 'Sign-in loops forever', 30),
            'priority': 'P0',
          },
          taskFixture('legacy', 'Round dial crashes (Ken, high)', 31),
          {
            ...taskFixture('docs', 'Docs for the round dial', 32),
            'priority': 'P3',
          },
          {
            ...taskFixture(
              'crash',
              'Settings crash on open',
              8,
              requester: 'ken',
              status: 'working',
            ),
            'priority': 'P0',
          },
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
              body: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Team Mac',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (view == 'board') {
          await tester.tap(find.byKey(const ValueKey('super-tasks')));
          await tester.pumpAndSettle();
          expect(find.text('P0'), findsNWidgets(2));
        } else {
          await c.select('preview');
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('super-task-priority')));
          await tester.pumpAndSettle();
          expect(find.text('Planned goal'), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'priority-$view-${brightness.name}');
      });
    }
  }
}
