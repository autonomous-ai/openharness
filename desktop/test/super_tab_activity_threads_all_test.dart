import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/activity_view.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm, unreadThread;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

// Darren (11-04, task #2835): Activity's Threads lists every thread he took part in, not only the unread ones: unread on
// top as before, then the read ones, plain, newest reply first, 50 at a time.
final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
final _now = DateTime(2026, 11, 2, 20, 30);

Finder _key(String key) => find.byKey(ValueKey(key));

/// A thread the person follows and has read, its newest reply at [at].
Map<String, dynamic> readThread(
  String root, {
  required DateTime at,
  String text = 'Read root',
  String replier = 'Kiln',
}) => {
  'conversationId': 'offline',
  'rootId': root,
  'root': {
    'id': root,
    'sequence': 1,
    'author': {'kind': 'person', 'id': 'darren', 'name': 'Darren'},
    'text': text,
    'createdAt': '2026-10-30T01:00:00Z',
    'attachments': 0,
  },
  'replies': 4,
  'lastReplyAt': at.toUtc().toIso8601String(),
  'lastReplySequence': 9,
  'lastReplier': {
    'kind': 'agent',
    'id': replier.toLowerCase(),
    'name': replier,
  },
  'follow': null,
};

Future<SuperTabActivity> _loaded(
  WidgetTester tester,
  ConversationServer server,
) async => (await tester.runAsync(() => load(server)))!;

Future<List<(String, String)>> _show(
  WidgetTester tester,
  SuperTabActivity activity, {
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(const Size(900, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  final opened = <(String, String)>[];
  await tester.pumpWidget(const SizedBox());
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabActivityView(
          activity: activity,
          onOpenMention: (_) {},
          onOpenThread: (conversation, root) =>
              opened.add((conversation, root)),
          onOpenConversation: (_) {},
          now: () => _now,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return opened;
}

Future<void> _threadsTab(WidgetTester tester) async {
  await tester.tap(_key('super-activity-tab-threads'));
  await tester.pumpAndSettle();
}

/// Lets the server's answer arrive, then draws it.
Future<void> _settle(WidgetTester tester) async {
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 50)),
  );
  await tester.pumpAndSettle();
}

double _top(WidgetTester tester, Finder f) => tester.getTopLeft(f).dy;

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  testWidgets(
    'unread threads first as before, then the read ones, plain, newest reply first',
    (tester) async {
      final server = swarm();
      server.followedThreads = {
        'unread': [unreadThread('new-1', text: 'Title: Dial fix — details')],
        'read': [
          readThread(
            'read-new',
            at: DateTime(2026, 11, 2, 16, 42),
            text: 'Title: Lamp boot loop — it reboots',
          ),
          readThread(
            'read-old',
            at: DateTime(2026, 11, 1, 9, 10),
            text: 'Title: Firmware OTA timeout — after 30 s',
          ),
        ],
        'more': false,
      };
      await withClock(Clock.fixed(_now), () async {
        await _show(tester, await _loaded(tester, server));
        await _threadsTab(tester);
        final unread = _key('super-activity-row-thread:offline/new-1');
        final newer = _key('super-activity-row-thread:offline/read-new');
        final older = _key('super-activity-row-thread:offline/read-old');
        final heading = _key('super-activity-threads-read');
        for (final f in [unread, heading, newer, older]) {
          expect(f, findsOneWidget);
        }
        expect(_top(tester, unread), lessThan(_top(tester, heading)));
        expect(_top(tester, heading), lessThan(_top(tester, newer)));
        expect(_top(tester, newer), lessThan(_top(tester, older)));
        // A read thread says when its last reply came, never a "new" count.
        expect(
          find.descendant(of: newer, matching: find.textContaining('new')),
          findsNothing,
        );
        expect(
          find.descendant(
            of: newer,
            matching: find.text('Kiln replied · # web-project'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: newer, matching: find.text('Lamp boot loop')),
          findsOneWidget,
        );
        // The tab's number stays the unread ones.
        expect(
          find.descendant(
            of: _key('super-activity-tab-threads'),
            matching: find.text('1'),
          ),
          findsOneWidget,
        );
      });
    },
  );

  testWidgets('a read thread opens beside its chat', (tester) async {
    final server = swarm();
    server.followedThreads = {
      'unread': [],
      'read': [readThread('read-1', at: DateTime(2026, 11, 2, 16, 42))],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      final opened = await _show(tester, await _loaded(tester, server));
      await _threadsTab(tester);
      await tester.tap(_key('super-activity-row-thread:offline/read-1'));
      await tester.pumpAndSettle();
      expect(opened, [('offline', 'read-1')]);
    });
  });

  testWidgets(
    'it asks for 50 read threads, and 50 more at the end only while there are more',
    (tester) async {
      final server = swarm();
      final fifty = [
        for (var i = 0; i < 50; i++)
          readThread(
            'read-$i',
            at: DateTime(2026, 11, 2, 16).subtract(Duration(minutes: i)),
          ),
      ];
      server.followedThreads = {'unread': [], 'read': fifty, 'more': true};
      await withClock(Clock.fixed(_now), () async {
        await _show(tester, await _loaded(tester, server));
        await _threadsTab(tester);
        expect(
          server.threadListReads.where((p) => p.contains('/threads')).last,
          endsWith('/threads?read=50'),
        );
        expect(_key('super-activity-threads-more'), findsNothing);
        await tester.scrollUntilVisible(
          _key('super-activity-threads-more'),
          600,
          scrollable: find.descendant(
            of: _key('super-activity-list'),
            matching: find.byType(Scrollable),
          ),
        );
        server.followedThreads = {
          'unread': [],
          'read': [
            ...fifty,
            for (var i = 50; i < 60; i++)
              readThread(
                'read-$i',
                at: DateTime(2026, 11, 2, 15).subtract(Duration(minutes: i)),
              ),
          ],
          'more': false,
        };
        await _settle(tester);
        expect(
          server.threadListReads.where((p) => p.contains('/threads')).last,
          endsWith('/threads?read=100'),
        );
        await tester.scrollUntilVisible(
          _key('super-activity-row-thread:offline/read-59'),
          600,
          scrollable: find.descendant(
            of: _key('super-activity-list'),
            matching: find.byType(Scrollable),
          ),
        );
        // No more to read: no marker, no further read.
        final reads = server.threadListReads.length;
        expect(_key('super-activity-threads-more'), findsNothing);
        await _settle(tester);
        expect(server.threadListReads.length, reads);
      });
    },
  );

  testWidgets('a server before paging still lists its read threads', (
    tester,
  ) async {
    final server = swarm()
      ..refuseThreadsRead = true
      ..followedThreads = {
        'unread': [],
        'read': [readThread('read-1', at: DateTime(2026, 11, 2, 16, 42))],
        'more': true,
      };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      await _threadsTab(tester);
      await _settle(tester);
      expect(_key('super-activity-row-thread:offline/read-1'), findsOneWidget);
      // It cannot page: no marker that would ask again and again.
      expect(_key('super-activity-threads-more'), findsNothing);
    });
  });

  testWidgets('no thread at all says so', (tester) async {
    final server = swarm();
    server.followedThreads = {'unread': [], 'read': [], 'more': false};
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      await _threadsTab(tester);
      expect(find.text('No threads yet'), findsOneWidget);
    });
  });

  testWidgets('screenshots for Darren', (tester) async {
    for (final (brightness, name) in [
      (Brightness.light, 'light'),
      (Brightness.dark, 'dark'),
    ]) {
      final server = swarm();
      server.followedThreads = {
        'unread': [unreadThread('new-1', text: 'Title: Dial fix — details')],
        'read': [
          readThread(
            'read-new',
            at: DateTime(2026, 11, 2, 16, 42),
            text: 'Title: Lamp boot loop — it reboots when it wakes',
          ),
          readThread(
            'read-mid',
            at: DateTime(2026, 11, 2, 11, 5),
            text: 'Title: Brightness curve — too dim at 10%',
            replier: 'Ken',
          ),
          readThread(
            'read-old',
            at: DateTime(2026, 11, 1, 9, 10),
            text: 'Title: Firmware OTA timeout — after 30 s on the dial',
          ),
        ],
        'more': false,
      };
      await withClock(Clock.fixed(_now), () async {
        await _show(
          tester,
          await _loaded(tester, server),
          brightness: brightness,
        );
        await _threadsTab(tester);
        await captureWindow(tester, shots, 'activity-threads-all-$name');
      });
    }
  }, skip: shots == null);
}
