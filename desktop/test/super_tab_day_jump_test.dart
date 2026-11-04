import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/day_jump.dart';
import 'package:harness/super_tabs/day_pill.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _pill = ValueKey('super-day-pill');

/// A list of 40 rows on Oct 20 and 21, 2026 under a sticky day that jumps
/// with [onJump], scrolled so its pill shows.
Future<void> _list(WidgetTester tester, ValueChanged<DateTime?> onJump) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: SizedBox(
          height: 400,
          child: SuperTabStickyDay(
            pillKey: _pill,
            onJump: onJump,
            child: ListView(
              children: [
                for (var i = 0; i < 40; i++)
                  SuperTabDayMark(
                    time: DateTime(2026, 10, i < 20 ? 20 : 21, 9, i),
                    child: SizedBox(height: 40, child: Text('Row $i')),
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
  await tester.drag(find.byType(ListView), const Offset(0, -300));
  await tester.pumpAndSettle();
}

void main() {
  group('the time each choice starts at', () {
    final wednesday = DateTime(2026, 11, 4, 15, 30);

    test('Yesterday, Last week and Last month start at their midnight', () {
      expect(
        superTabJumpStart(SuperTabJumpTo.yesterday, wednesday),
        DateTime(2026, 11, 3),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastWeek, wednesday),
        DateTime(2026, 10, 28),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, wednesday),
        DateTime(2026, 10, 4),
      );
    });

    test('The very beginning has no time', () {
      expect(superTabJumpStart(SuperTabJumpTo.beginning, wednesday), isNull);
    });

    test('Last month from a day a shorter month lacks is its last day', () {
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, DateTime(2026, 3, 31, 9)),
        DateTime(2026, 2, 28),
      );
      expect(
        superTabJumpStart(SuperTabJumpTo.lastMonth, DateTime(2027, 1, 15, 9)),
        DateTime(2026, 12, 15),
      );
    });
  });

  group('the pill opens the Jump to menu', () {
    testWidgets('the pill is a button with a chevron', (tester) async {
      await _list(tester, (_) {});
      expect(find.byKey(_pill), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(_pill),
          matching: find.byIcon(AppIcons.chevronDown),
        ),
        findsOneWidget,
      );
      expect(
        tester.getSemantics(find.byKey(_pill)),
        matchesSemantics(
          isButton: true,
          hasTapAction: true,
          label: 'Jump to…',
          value: 'Tue, Oct 20',
        ),
      );
    });

    testWidgets('a click opens its choices, and each jumps from its time', (
      tester,
    ) async {
      DateTime? jumped;
      var calls = 0;
      await _list(tester, (at) {
        jumped = at;
        calls++;
      });
      for (final choice in SuperTabJumpTo.values) {
        await tester.tap(find.byKey(_pill));
        await tester.pumpAndSettle();
        for (final label in [
          'Jump to…',
          'Yesterday',
          'Last week',
          'Last month',
          'The very beginning',
          'Jump to a specific date',
        ]) {
          expect(find.text(label), findsOneWidget, reason: label);
        }
        final before = calls;
        await tester.tap(find.text(choice.label));
        await tester.pumpAndSettle();
        expect(calls, before + 1);
        expect(jumped, superTabJumpStart(choice, DateTime.now()));
        expect(find.text('Jump to…'), findsNothing);
      }
    });

    testWidgets('Jump to a specific date picks a day on a calendar', (
      tester,
    ) async {
      final jumped = <DateTime?>[];
      await _list(tester, jumped.add);
      await tester.tap(find.byKey(_pill));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Jump to a specific date'));
      await tester.pumpAndSettle();
      expect(find.byType(CalendarDatePicker), findsOneWidget);
      // It opens at the pill's month.
      expect(find.text('October 2026'), findsOneWidget);
      await tester.tap(find.text('15'));
      await tester.pumpAndSettle();
      expect(jumped, [DateTime(2026, 10, 15)]);
      expect(find.byType(CalendarDatePicker), findsNothing);
    });

    testWidgets('Esc closes the menu, and nothing jumps', (tester) async {
      final jumped = <DateTime?>[];
      await _list(tester, jumped.add);
      await tester.tap(find.byKey(_pill));
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Jump to…'), findsNothing);
      expect(jumped, isEmpty);
    });
  });

  group('the chat lands on the first message from that time', () {
    /// The Lead chat with [said] in order, everything read, [page] messages
    /// to a page.
    Future<SuperTabController> chat(
      WidgetTester tester,
      List<(String, DateTime)> said, {
      int page = 20,
    }) async {
      final server = ConversationServer()..messagePage = page;
      for (final (text, at) in said) {
        server.append(text);
        server.messages.last['createdAt'] = at.toUtc().toIso8601String();
      }
      server.markReadElsewhere('lead', said.length);
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      addTearDown(c.dispose);
      return c;
    }

    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    DateTime daysAgo(int days, [int minute = 0]) =>
        DateTime(today.year, today.month, today.day - days, 10, minute);
    List<(String, DateTime)> run(
      String name,
      int count,
      DateTime Function(int) at,
    ) => [for (var i = 1; i <= count; i++) ('$name $i', at(i))];

    Finder row(String text) => find
        .ancestor(
          of: find.text(text),
          matching: find.byWidgetPredicate(
            (w) =>
                w.key is ValueKey<String> &&
                (w.key! as ValueKey<String>).value.startsWith(
                  'super-message-message-',
                ),
          ),
        )
        .first;
    bool lit(WidgetTester tester, String text) => tester
        .widget<SuperTabMessageHighlight>(
          find.ancestor(
            of: row(text),
            matching: find.byType(SuperTabMessageHighlight),
          ),
        )
        .on;
    bool onScreen(WidgetTester tester, String text) {
      final list = tester.getRect(
        find.byKey(const PageStorageKey('super-messages-tab-lead')),
      );
      final at = tester.getRect(row(text));
      return at.top >= list.top - 1 && at.top < list.bottom;
    }

    Future<void> choose(WidgetTester tester, String label) async {
      await tester.tap(find.byKey(_pill));
      await tester.pumpAndSettle();
      await tester.tap(find.text(label));
      // The highlight lasts 2 seconds: look while it is on.
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    // Older days first, then yesterday and today: one page holds today alone.
    List<(String, DateTime)> days() => [
      ...run('Old', 40, (i) => daysAgo(20, i)),
      ...run('Week', 20, (i) => daysAgo(7, i)),
      ...run('Yesterday', 20, (i) => daysAgo(1, i)),
      ...run('Today', 20, (i) => now.subtract(Duration(minutes: 40 - i))),
    ];

    testWidgets(
      'Yesterday lands on yesterday\'s first message, and lights it',
      (tester) async {
        await chat(tester, days(), page: 40);
        await choose(tester, 'Yesterday');
        expect(onScreen(tester, 'Yesterday 1'), isTrue);
        expect(lit(tester, 'Yesterday 1'), isTrue);
        await tester.pumpAndSettle(const Duration(seconds: 3));
      },
    );

    testWidgets('Last week reads older pages to reach its first message', (
      tester,
    ) async {
      final c = await chat(tester, days());
      expect(c.messages('lead').any((m) => m.text == 'Week 1'), isFalse);
      await choose(tester, 'Last week');
      await tester.pumpAndSettle(const Duration(milliseconds: 100));
      expect(onScreen(tester, 'Week 1'), isTrue);
      expect(lit(tester, 'Week 1'), isTrue);
      await tester.pumpAndSettle(const Duration(seconds: 3));
    });

    testWidgets('The very beginning lands on the chat\'s first message', (
      tester,
    ) async {
      await chat(tester, days(), page: 10);
      await choose(tester, 'The very beginning');
      await tester.pumpAndSettle(const Duration(milliseconds: 100));
      expect(onScreen(tester, 'Old 1'), isTrue);
      expect(lit(tester, 'Old 1'), isTrue);
      await tester.pumpAndSettle(const Duration(seconds: 3));
    });

    testWidgets('with nothing said since, it lands on the newest message', (
      tester,
    ) async {
      await chat(tester, run('Earlier', 40, (i) => daysAgo(3, i)));
      await choose(tester, 'Yesterday');
      expect(onScreen(tester, 'Earlier 40'), isTrue);
      expect(lit(tester, 'Earlier 40'), isTrue);
      await tester.pumpAndSettle(const Duration(seconds: 3));
    });

    testWidgets('a time more than 50 pages back says so, and the list stays', (
      tester,
    ) async {
      await chat(tester, [
        ...run('Old', 2, (i) => daysAgo(40, i)),
        ...run('Recent', 120, (i) => daysAgo(20, i)),
        ...run('Today', 20, (i) => now.subtract(Duration(minutes: 40 - i))),
      ], page: 2);
      expect(onScreen(tester, 'Today 20'), isTrue);
      await choose(tester, 'Last month');
      await tester.pumpAndSettle();
      expect(find.text('That day is too far back to open.'), findsOneWidget);
      expect(find.text('Recent 1'), findsNothing);
      // Where the reader was: at the newest message, none of them lit.
      expect(onScreen(tester, 'Today 20'), isTrue);
      expect(lit(tester, 'Today 20'), isFalse);
    });
  });

  group('the thread lands on its first reply from that time', () {
    final now = DateTime.now();
    DateTime daysAgo(int days, [int minute = 0]) =>
        DateTime(now.year, now.month, now.day - days, 10, minute);
    const pill = ValueKey('super-thread-day-pill');
    const root = 'Should we cache the reads?';

    /// A thread of 40 replies over three weeks, four to a page: it opens
    /// with the newest 20, yesterday's.
    Future<SuperTabController> thread(WidgetTester tester) async {
      final server = ConversationServer()
        ..threads = true
        ..messagePage = 4;
      server.append(root);
      server.messages.last['createdAt'] = daysAgo(30).toUtc().toIso8601String();
      for (final (name, days, count) in [
        ('Old', 20, 10),
        ('Week', 7, 10),
        ('Recent', 1, 20),
      ]) {
        for (var i = 1; i <= count; i++) {
          server.append('$name reply $i');
          server.messages.last
            ..['thread'] = 'message-1'
            ..['replyTo'] = 'message-1'
            ..['createdAt'] = daysAgo(days, i).toUtc().toIso8601String();
        }
      }
      server.markReadElsewhere('lead', server.messages.length);
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      addTearDown(c.dispose);
      c.openThread('message-1');
      await tester.pumpAndSettle();
      return c;
    }

    Finder inThread(String text) => find.descendant(
      of: find.byKey(const ValueKey('super-thread-panel')),
      matching: find.text(text),
    );
    bool lit(WidgetTester tester, String text) => tester
        .widget<SuperTabMessageHighlight>(
          find
              .ancestor(
                of: inThread(text),
                matching: find.byType(SuperTabMessageHighlight),
              )
              .first,
        )
        .on;
    bool onScreen(WidgetTester tester, String text) {
      final list = tester.getRect(
        find
            .descendant(
              of: find.byKey(const ValueKey('super-thread-panel')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      final at = tester.getRect(inThread(text));
      return at.top >= list.top - 1 && at.top < list.bottom;
    }

    Future<void> choose(WidgetTester tester, String label) async {
      await tester.tap(find.byKey(pill));
      await tester.pumpAndSettle();
      await tester.tap(find.text(label));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    testWidgets('Last week reads earlier replies to its first, and lights it', (
      tester,
    ) async {
      await thread(tester);
      expect(inThread('Week reply 1'), findsNothing);
      await choose(tester, 'Last week');
      expect(onScreen(tester, 'Week reply 1'), isTrue);
      expect(lit(tester, 'Week reply 1'), isTrue);
      await tester.pumpAndSettle(const Duration(seconds: 3));
    });

    testWidgets('The very beginning lands on the root', (tester) async {
      await thread(tester);
      await choose(tester, 'The very beginning');
      expect(onScreen(tester, root), isTrue);
      expect(lit(tester, root), isTrue);
      await tester.pumpAndSettle(const Duration(seconds: 3));
    });
  });
}
