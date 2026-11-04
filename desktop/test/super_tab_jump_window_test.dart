import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Task #2911: a jump reads the window around its time in one request, the
/// chat reads pages both ways only as asked, and the rows held stay near 300.
void main() {
  final now = DateTime.now();
  final weekAgo = DateTime(now.year, now.month, now.day - 7);

  /// The Lead chat with [count] messages over two weeks to now, everything
  /// read, its latest page held; [reads] collects each messages read after.
  Future<(SuperTabController, ConversationServer, List<String>)> chat({
    int count = 2000,
  }) async {
    final server = ConversationServer();
    final start = now.subtract(const Duration(days: 14));
    final step = const Duration(days: 14).inSeconds ~/ count;
    for (var i = 1; i <= count; i++) {
      server.append('Update $i');
      server.messages.last['createdAt'] = start
          .add(Duration(seconds: step * i))
          .toUtc()
          .toIso8601String();
    }
    server.markReadElsewhere('lead', count);
    final c = server.controller();
    await c.refresh();
    await c.loadMessages('lead');
    final reads = <String>[];
    server.onRead = reads.add;
    addTearDown(c.dispose);
    return (c, server, reads);
  }

  String firstFrom(ConversationServer server, DateTime from) =>
      server.messages.firstWhere(
            (m) => !DateTime.parse(m['createdAt'] as String).isBefore(from),
          )['id']
          as String;

  test(
    'a jump a week back is one read, and holds the rows around it',
    () async {
      final (c, server, reads) = await chat();
      final target = await c.jumpTo('lead', weekAgo);
      expect(reads, hasLength(1));
      expect(reads.single, contains('at=${weekAgo.millisecondsSinceEpoch}'));
      expect(target, firstFrom(server, weekAgo));
      final held = c.messages('lead');
      expect(held, hasLength(200));
      expect(held.indexWhere((m) => m.id == target), 100);
      expect(c.hasOlder('lead'), isTrue);
      expect(c.hasNewer('lead'), isTrue);
    },
  );

  test('the very beginning lands on the first message, one read', () async {
    final (c, server, reads) = await chat();
    final target = await c.jumpTo('lead', null);
    expect(reads.single, contains('at=0'));
    expect(target, server.messages.first['id']);
    expect(c.hasOlder('lead'), isFalse);
  });

  test('scrolling down reads one newer page a time, to the live end', () async {
    final (c, server, reads) = await chat();
    await c.jumpTo('lead', weekAgo);
    reads.clear();
    await c.loadNewer('lead');
    expect(reads, hasLength(1));
    expect(reads.single, contains('after='));
    expect(c.messages('lead').length, lessThanOrEqualTo(300));
    var pages = 1;
    while (c.hasNewer('lead') && pages < 30) {
      await c.loadNewer('lead');
      pages++;
      expect(c.messages('lead').length, lessThanOrEqualTo(300));
    }
    expect(c.hasNewer('lead'), isFalse);
    expect(c.messages('lead').last.id, server.messages.last['id']);
    // The rows dropped above are read again by scrolling up.
    expect(c.hasOlder('lead'), isTrue);
    expect(reads, hasLength(pages));
  });

  test(
    'scrolling up past 300 rows drops the newest, which wait below',
    () async {
      final (c, _, _) = await chat();
      final target = await c.jumpTo('lead', weekAgo);
      for (var page = 0; page < 4; page++) {
        await c.loadMessages('lead', older: true, dropFar: true);
        expect(c.messages('lead').length, lessThanOrEqualTo(300));
      }
      expect(c.messages('lead').any((m) => m.id == target), isFalse);
      expect(c.hasNewer('lead'), isTrue);
      expect(c.hasOlder('lead'), isTrue);
    },
  );

  test('Jump to latest after a jump is one read, at the live end', () async {
    final (c, server, reads) = await chat();
    await c.jumpTo('lead', weekAgo);
    reads.clear();
    await c.showLatest('lead');
    expect(reads, hasLength(1));
    expect(c.messages('lead').last.id, server.messages.last['id']);
    expect(c.hasNewer('lead'), isFalse);
  });

  group('in the chat', () {
    const list = PageStorageKey('super-messages-tab-lead');

    /// [chat] on screen, settled at its end.
    Future<(SuperTabController, ConversationServer, List<String>)> open(
      WidgetTester tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1280, 860));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final (c, server, reads) = await chat();
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
      reads.clear();
      return (c, server, reads);
    }

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
      if (find.text(text).evaluate().isEmpty) return false;
      final view = tester.getRect(find.byKey(list));
      final at = tester.getRect(row(text));
      return at.top >= view.top - 1 && at.top < view.bottom;
    }

    String textOf(ConversationServer server, String id) =>
        server.messages.firstWhere((m) => m['id'] == id)['text'] as String;

    Future<void> lastWeek(WidgetTester tester) async {
      await tester.drag(find.byKey(list), const Offset(0, 300));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-day-pill')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Last week'));
      // The highlight lasts 2 seconds: look while it is on.
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    /// The topmost row in view, by its key, and its top.
    (Key, double) topRow(WidgetTester tester) {
      final view = tester.getRect(find.byKey(list));
      (Key, double)? top;
      for (final element
          in find
              .descendant(
                of: find.byKey(list),
                matching: find.byWidgetPredicate(
                  (w) =>
                      w.key is ValueKey<String> &&
                      (w.key! as ValueKey<String>).value.startsWith(
                        'super-message-message-',
                      ),
                ),
              )
              .evaluate()) {
        final key = element.widget.key!;
        final at = tester.getRect(find.byKey(key)).top;
        if (at >= view.top && (top == null || at < top.$2)) top = (key, at);
      }
      return top!;
    }

    testWidgets('Last week lands on and lights that day\'s first message, '
        'after one read', (tester) async {
      final (c, server, reads) = await open(tester);
      await lastWeek(tester);
      expect(reads, hasLength(1));
      expect(reads.single, contains('at='));
      final target = textOf(server, firstFrom(server, weekAgo));
      expect(onScreen(tester, target), isTrue);
      expect(lit(tester, target), isTrue);
      expect(c.messages('lead').length, lessThanOrEqualTo(200));
      await tester.pumpAndSettle(const Duration(seconds: 3));
    });

    testWidgets('scrolling down reads the page below, and up the page above, '
        'each once, with the rows on screen in place and the list small', (
      tester,
    ) async {
      final (c, _, reads) = await open(tester);
      await lastWeek(tester);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      reads.clear();
      // Down: to the window's end, and on past it, page by page.
      for (var i = 0; i < 12; i++) {
        await tester.drag(find.byKey(list), const Offset(0, -3000));
        await tester.pumpAndSettle();
        final e = tester.takeException();
        // ignore: avoid_print
        print(
          'down $i held ${c.messages('lead').length} first ${c.messages('lead').first.text} last ${c.messages('lead').last.text} newer ${c.hasNewer('lead')} reads ${reads.length} ex ${e != null}',
        );
        expect(c.messages('lead').length, lessThanOrEqualTo(400));
      }
      final newer = reads.where((r) => r.contains('after=')).length;
      expect(newer, greaterThanOrEqualTo(2));
      expect(reads.where((r) => r.contains('at=')), isEmpty);
      // A page landing below keeps the row at the top where it is.
      // ignore: avoid_print
      print('before top ex ${tester.takeException() != null}');
      final (key, top) = topRow(tester);
      await tester.drag(find.byKey(list), const Offset(0, -200));
      await tester.pumpAndSettle();
      await tester.drag(find.byKey(list), const Offset(0, 200));
      await tester.pumpAndSettle();
      expect(
        tester.getRect(find.byKey(key)).top,
        moreOrLessEquals(top, epsilon: 2),
      );
      // Up: past where the jump landed, page by page.
      reads.clear();
      for (var i = 0; i < 16; i++) {
        await tester.drag(find.byKey(list), const Offset(0, 3000));
        await tester.pumpAndSettle();
        final e = tester.takeException();
        // ignore: avoid_print
        print(
          'up $i held ${c.messages('lead').length} first ${c.messages('lead').first.text} last ${c.messages('lead').last.text} newer ${c.hasNewer('lead')} reads ${reads.length} ex ${e != null}',
        );
        expect(c.messages('lead').length, lessThanOrEqualTo(400));
      }
      expect(
        reads.where((r) => r.contains('before=')).length,
        greaterThanOrEqualTo(2),
      );
      expect(c.hasNewer('lead'), isTrue);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Jump to latest after a jump is one read, at the end', (
      tester,
    ) async {
      final (c, server, reads) = await open(tester);
      await lastWeek(tester);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      reads.clear();
      await tester.tap(find.byKey(const ValueKey('super-jump-latest')));
      await tester.pumpAndSettle();
      expect(reads, hasLength(1));
      expect(c.hasNewer('lead'), isFalse);
      expect(onScreen(tester, server.messages.last['text'] as String), isTrue);
    });

    testWidgets('text selected in the chat, then a jump, pages both ways and '
        'the rows dropped raise nothing, and the chat stays drawn (#2762)', (
      tester,
    ) async {
      final (c, server, _) = await open(tester);
      final last = server.messages.last['text'] as String;
      Future<void> select(String text) async {
        final at = tester.getRect(find.text(text).last);
        final mouse = await tester.startGesture(
          at.centerLeft + const Offset(2, 0),
          kind: PointerDeviceKind.mouse,
        );
        await tester.pump();
        await mouse.moveTo(at.centerRight - const Offset(2, 0));
        await tester.pump();
        await mouse.up();
        await tester.pump();
      }

      await select(last);
      await lastWeek(tester);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      final target = textOf(server, firstFrom(server, weekAgo));
      await select(target);
      for (var i = 0; i < 8; i++) {
        await tester.drag(find.byKey(list), const Offset(0, -3000));
        await tester.pumpAndSettle();
      }
      for (var i = 0; i < 12; i++) {
        await tester.drag(find.byKey(list), const Offset(0, 3000));
        await tester.pumpAndSettle();
      }
      await lastWeek(tester);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      await tester.tap(find.byKey(const ValueKey('super-jump-latest')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byType(ErrorWidget), findsNothing);
      expect(c.messages('lead').last.text, last);
    });
  });
}
