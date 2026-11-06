import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'super_tab_tasks_view_test.dart' show tasksServer, taskFixture;
import 'support/capture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_TASKS_SHOTS'];

/// A project's Tasks view as the PR shows it (Dee, task #2569): Board and
/// List, in both appearances, with a Needs-you card and the header's count.
/// The Board's columns are panels of inset tiles (Huy, task #2948): Proposals
/// is empty and says so, and the task just opened from the board shows
/// selected on coming back.
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
    for (final layout in ['board', 'list']) {
      testWidgets('screenshots for review ($layout, ${brightness.name})', (
        tester,
      ) async {
        await tester.binding.setSurfaceSize(
          // Six columns of 280 beside the sidebar: the whole Board in one picture.
          layout == 'list' ? const Size(1900, 1500) : const Size(2300, 900),
        );
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = before);
        final server = tasksServer();
        server.proposals['lead'] = [];
        (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          taskFixture(
            'dial',
            'Dial thread alerts',
            15,
            requester: 'scholes',
            status: 'working',
          ),
          taskFixture(
            'grouping',
            'Task chat grouping',
            16,
            requester: 'scholes',
            status: 'review',
            liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
          ),
          taskFixture(
            'long',
            'A long title that takes all three of its lines on the board, '
                'and then goes on with more words than three lines of a '
                'column can hold, so the rest is cut',
            17,
            requester: 'tony',
          ),
          taskFixture(
            'lost',
            'Phone tests: a picture test',
            18,
            status: 'lost',
            agent: 'gone',
          ),
          taskFixture(
            'failed',
            'A failed build reports its error',
            19,
            status: 'failed',
          ),
          taskFixture(
            'shipped-gone',
            'Tasks board looks finished',
            20,
            requester: 'scholes',
            status: 'done',
            agent: 'gone',
            merged: true,
            pullRequest: 3007,
            shippedAt: DateTime(2026, 11, 5),
          ),
          // The six columns (task #3812): done and waiting for a merge, one of
          // them past an hour; merged and waiting for a release; released.
          taskFixture(
            'done-fresh',
            'Review and test passed',
            22,
            requester: 'tony',
            status: 'done',
            pullRequest: 3500,
            shippedAt: DateTime.now().subtract(const Duration(minutes: 12)),
            checks: {
              'https://github.com/autonomous-ai/openharness/pull/3500': 'green',
            },
          ),
          taskFixture(
            'done-red',
            'Checks failed after review',
            27,
            requester: 'owner',
            status: 'done',
            pullRequest: 3502,
            shippedAt: DateTime.now().subtract(const Duration(minutes: 5)),
            checks: {
              'https://github.com/autonomous-ai/openharness/pull/3502': 'red',
            },
          ),
          taskFixture(
            'done-stuck',
            'Waiting on the merge train',
            23,
            requester: 'scholes',
            status: 'done',
            pullRequest: 3501,
            shippedAt: DateTime.now().subtract(const Duration(minutes: 90)),
            checks: {
              'https://github.com/autonomous-ai/openharness/pull/3501': 'green',
            },
          ),
          taskFixture(
            'merged-two',
            'Dial recap on main',
            24,
            requester: 'owner',
            status: 'done',
            merged: true,
            pullRequest: 3498,
            shippedAt: DateTime.now().subtract(const Duration(hours: 1)),
            releasing: ['desktop', 'cli'],
          ),
          taskFixture(
            'merged-backend',
            'A backend read on main',
            25,
            requester: 'ken',
            status: 'done',
            merged: true,
            pullRequest: 3499,
            shippedAt: DateTime.now().subtract(const Duration(minutes: 30)),
            releasing: ['backend'],
          ),
          taskFixture(
            'released',
            'Chat limits out in a release',
            26,
            requester: 'scholes',
            status: 'done',
            merged: true,
            pullRequest: 3480,
            shippedAt: DateTime.now().subtract(const Duration(hours: 3)),
            released: {
              'at': DateTime.now().millisecondsSinceEpoch,
              'tags': ['v1.3.84_desktop'],
            },
          ),
        ]);
        // What the server sends in `derived.releaseTimes` (task #3827): the apps may release in two hours, the backend later.
        server.state['releaseTimes'] = {
          'lead': {
            'desktop': DateTime.now()
                .add(const Duration(hours: 2))
                .millisecondsSinceEpoch,
            'cli': DateTime.now()
                .add(const Duration(hours: 2))
                .millisecondsSinceEpoch,
            'backend': DateTime.now()
                .add(const Duration(hours: 4))
                .millisecondsSinceEpoch,
          },
        };
        final conversations = (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>();
        conversations.firstWhere((task) => task['id'] == 'sender')['liveness'] =
            {'state': 'waiting', 'why': 'person', 'personId': 'owner'};
        conversations.firstWhere(
          (task) => task['id'] == 'tag',
        )['lastMessageSequence'] = 10;
        // A promise the PM keeps, as the mockup's preview route.
        (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((g) => g['id'] == 'preview')
          ..['notBefore'] = '2026-12-04'
          ..['requesterId'] = 'ken';
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
        await tester.tap(find.byKey(const ValueKey('super-tasks')));
        await tester.pumpAndSettle();
        // Open a task from the board, then come back: it shows selected.
        await tester.tap(find.byKey(const ValueKey('super-task-card-dial')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-tasks')));
        await tester.pumpAndSettle();
        if (layout == 'list') {
          await tester.tap(
            find.byKey(const ValueKey('super-tasks-layout-list')),
          );
          await tester.pumpAndSettle();
        }
        if (layout == 'list') {
          await tester.tap(
            find.byKey(const ValueKey('super-tasks-heading-shipped')),
          );
          await tester.pumpAndSettle();
        }
        expect(find.textContaining('Needs you'), findsNWidgets(2));
        expect(find.byKey(const ValueKey('super-tasks-badge')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'tasks-$layout-${brightness.name}');
      });
    }
  }
}
