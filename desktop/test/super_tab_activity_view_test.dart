import 'package:clock/clock.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/activity_view.dart';

import 'super_tab_activity_lists_test.dart'
    show finish, load, swarm, unreadThread;
import 'support/super_tab_fixture.dart';

final _now = DateTime(2026, 11, 2, 20, 30);

Future<SuperTabActivity> loaded(
  WidgetTester tester,
  ConversationServer server,
) async => (await tester.runAsync(() => load(server)))!;

class _Opened {
  final mentions = <String>[];
  final threads = <(String, String)>[];
  final conversations = <String>[];
}

Future<_Opened> show(
  WidgetTester tester,
  SuperTabActivity activity, {
  double width = 900,
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(Size(width, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final opened = _Opened();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabActivityView(
          activity: activity,
          onOpenMention: (m) => opened.mentions.add(m.id),
          onOpenThread: (conversation, root) =>
              opened.threads.add((conversation, root)),
          onOpenConversation: opened.conversations.add,
          now: () => _now,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return opened;
}

/// Everything the Activity screen draws: a decision, an agent waiting, a tag,
/// a thread with new replies and two tasks done today.
ConversationServer full() {
  final server = swarm();
  server.ask(['W1 ships alone or waits?']);
  server.state['agents'] = [
    ...(server.state['agents'] as List),
    {
      'id': 'nico',
      'projectId': 'lead',
      'name': 'Builder',
      'displayName': 'Nico',
      'machineId': 'host',
      'harnessId': 'nico',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    },
  ];
  (server.state['conversations'] as List).add(<String, dynamic>{
    ...conversationFixture('waiting', 'Mac fix'),
    'projectId': 'lead',
    'agentIds': ['nico'],
    'assignment': {'id': 'a9', 'agentId': 'nico', 'status': 'needs_human'},
  });
  server.tag('message-1', createdAt: '2026-11-02T13:09:00Z');
  server.followedThreads = {
    'unread': [unreadThread('message-1', text: 'Windows credential fix')],
    'read': [],
    'more': false,
  };
  finish(
    server,
    DateTime(2026, 11, 2, 8, 8),
    title: 'Closed agents leave the list',
  );
  return server;
}

void main() {
  testWidgets('has the three sections in order, and no filter', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final activity = await loaded(tester, full());
      await show(tester, activity);
      double top(String text) => tester.getTopLeft(find.text(text)).dy;
      expect(top('Needs you'), lessThan(top('New replies')));
      expect(top('New replies'), lessThan(top('Done today')));
      for (final filter in [
        'All',
        'Decisions',
        'Mentions',
        'Replies',
        'Reactions',
      ]) {
        expect(find.text(filter), findsNothing, reason: filter);
      }
      expect(find.text("You're all caught up."), findsNothing);
    });
  });

  testWidgets('draws each row as one line with its word or time', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final activity = await loaded(tester, full());
      await show(tester, activity);
      expect(find.text('W1 ships alone or waits?'), findsOneWidget);
      expect(find.text('Answer'), findsOneWidget);
      expect(find.text('Nico is waiting on you'), findsOneWidget);
      expect(find.text('Open'), findsOneWidget);
      expect(find.text('Wren mentioned you in # web-project'), findsOneWidget);
      expect(find.text('Windows credential fix'), findsOneWidget);
      expect(find.text('3 new'), findsOneWidget);
      expect(find.text('Closed agents leave the list'), findsOneWidget);
      expect(find.text('08:08'), findsOneWidget);
    });
  });

  for (final width in [900.0, 360.0]) {
    testWidgets('every row stays one line at $width px with long names', (
      tester,
    ) async {
      await withClock(Clock.fixed(_now), () async {
        final server = full();
        final long = 'A very long name that cannot fit on one line ' * 4;
        server.ask([long]);
        (server.state['conversations'] as List)
                .cast<Map<String, dynamic>>()
                .firstWhere((g) => g['id'] == 'offline')['title'] =
            long;
        server.followedThreads = {
          'unread': [unreadThread('message-1', text: long)],
          'read': [],
          'more': false,
        };
        final activity = await loaded(tester, server);
        await show(tester, activity, width: width);
        final rows = find.byWidgetPredicate(
          (w) =>
              w.key is ValueKey<String> &&
              (w.key! as ValueKey<String>).value.startsWith(
                'super-activity-row-',
              ),
        );
        expect(rows, findsNWidgets(6));
        final heights = {
          for (final row in rows.evaluate())
            tester.getSize(find.byWidget(row.widget)).height,
        };
        expect(
          heights,
          hasLength(1),
          reason: 'all rows are one height: $heights',
        );
        expect(heights.single, lessThan(48));
        expect(tester.takeException(), isNull);
      });
    });
  }

  testWidgets(
    'a decision row opens its card to answer, a second tap folds it',
    (tester) async {
      final activity = await loaded(tester, full());
      await show(tester, activity);
      expect(find.text('Behind a flag'), findsNothing);
      await tester.tap(
        find.byKey(const ValueKey('super-activity-row-decision:decision-1')),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('Behind a flag'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('super-activity-row-decision:decision-1')),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('Behind a flag'), findsNothing);
    },
  );

  testWidgets('every title starts in one column, and a heading starts where '
      'its rows do', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final activity = await loaded(tester, full());
      await show(tester, activity);
      double left(Finder f) => tester.getTopLeft(f).dx;
      final titles = {
        left(find.text('W1 ships alone or waits?')),
        left(find.text('Nico is waiting on you')),
        left(find.text('Wren mentioned you in # web-project')),
        left(find.text('Windows credential fix')),
        left(find.text('Closed agents leave the list')),
      };
      expect(titles, hasLength(1), reason: 'title columns: $titles');
      // The mark column starts where the headings do.
      final marks = {
        left(find.text('◐').first),
        left(find.text('@')),
        left(find.text('↳')),
        left(find.text('✓').first),
      };
      expect(marks, hasLength(1), reason: 'mark columns: $marks');
      for (final heading in ['Needs you', 'New replies', 'Done today']) {
        expect(left(find.text(heading)), marks.single, reason: heading);
      }
    });
  });

  testWidgets('a New replies row offers Unfollow on hover, nothing at rest', (
    tester,
  ) async {
    final server = full();
    final activity = await loaded(tester, server);
    await show(tester, activity);
    final row = find.byKey(
      const ValueKey('super-activity-row-thread:offline/message-1'),
    );
    expect(find.text('Unfollow'), findsNothing);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(row));
    await tester.pumpAndSettle();
    expect(find.text('Unfollow'), findsOneWidget);
    await tester.runAsync(() async {
      await tester.tap(find.text('Unfollow'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pumpAndSettle();
    expect(server.followPosts.single['follow'], false);
    expect(server.followPosts.single['root'], 'message-1');
  });

  testWidgets('a row opens where it is: agent, tag, thread and done task', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final activity = await loaded(tester, full());
      final opened = await show(tester, activity);
      await tester.tap(find.text('Nico is waiting on you'));
      await tester.tap(find.text('Wren mentioned you in # web-project'));
      await tester.tap(find.text('Windows credential fix'));
      await tester.tap(find.text('Closed agents leave the list'));
      expect(opened.conversations, ['waiting', 'offline']);
      expect(opened.mentions, hasLength(1));
      expect(opened.threads, [('offline', 'message-1')]);
    });
  });

  testWidgets('a tag read past leaves the list, one not read is bold', (
    tester,
  ) async {
    final server = swarm()..followedThreads = null;
    server.tag('message-1', messageSequence: 1);
    server.tag('message-2', messageSequence: 9);
    server.state['readMarks'] = {
      'owner': {'lead': 4},
    };
    final activity = await loaded(tester, server);
    await show(tester, activity);
    final unread = find.byKey(
      const ValueKey('super-activity-row-mention:mention-2'),
    );
    expect(
      find.byKey(const ValueKey('super-activity-row-mention:mention-1')),
      findsNothing,
    );
    expect(unread, findsOneWidget);
    final title = find.descendant(
      of: unread,
      matching: find.textContaining('mentioned you'),
    );
    expect(tester.widget<Text>(title).style?.fontWeight, FontWeight.w600);
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'says you are all caught up when nothing is new ($brightness)',
      (tester) async {
        final server = swarm()..followedThreads = null;
        final activity = await loaded(tester, server);
        await show(tester, activity, brightness: brightness);
        expect(find.text("You're all caught up."), findsOneWidget);
        for (final heading in ['Needs you', 'New replies', 'Done today']) {
          expect(find.text(heading), findsNothing, reason: heading);
        }
      },
    );
  }

  testWidgets('leaving the view marks nothing read', (tester) async {
    final server = full();
    final activity = await loaded(tester, server);
    await show(tester, activity);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(server.activityReadPosts, isEmpty);
  });
}
