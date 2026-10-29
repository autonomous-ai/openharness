import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// The chat never moves what the reader is looking at by itself: rows above
/// the view changing height, pages read in above, or the newest row growing
/// while the reader is at the end.
void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    SuperTabReading reading = const SuperTabReading(),
  }) async {
    final c = server.controller(reading: reading);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
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
    addTearDown(c.dispose);
    return c;
  }

  // Reading saves the place read a moment later: let it land.
  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  }

  ScrollPosition position(WidgetTester tester) => tester
      .widget<ScrollView>(
        find.byKey(const PageStorageKey('super-messages-tab-lead')),
      )
      .controller!
      .position;

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));

  double top(WidgetTester tester, String id) => tester.getTopLeft(row(id)).dy;

  void fromAgent(ConversationServer server) => server.messages.last['author'] =
      {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'};

  void agentUpdates(ConversationServer server, int count) {
    for (var i = 0; i < count; i++) {
      server.append(
        'Update $i: checking the offline queue and reconnect behavior.',
      );
      fromAgent(server);
    }
  }

  /// Scrolls so [id]'s row ends just above the view: built, but not seen.
  Future<void> justAbove(WidgetTester tester, String id) async {
    final scroll = position(tester);
    scroll.jumpTo(0);
    await tester.pumpAndSettle();
    final listTop = tester
        .getTopLeft(find.byKey(const PageStorageKey('super-messages-tab-lead')))
        .dy;
    scroll.jumpTo(tester.getBottomLeft(row(id)).dy - listTop + 20);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'the receipt moving off a row above the view leaves the view in place',
    (tester) async {
      final server = ConversationServer()..append('My first question');
      agentUpdates(server, 30);
      final c = await show(tester, server);
      await justAbove(tester, 'message-1');
      expect(
        find.byKey(
          const ValueKey('super-message-receipt-message-1'),
          skipOffstage: false,
        ),
        findsOneWidget,
      );
      final reading = top(tester, 'message-4');

      // The reader's own next message, sent from another device: the
      // receipt line leaves the first one, above the view.
      server.append('A second question');
      await c.refresh();
      await tester.pumpAndSettle();

      expect(
        find.byKey(
          const ValueKey('super-message-receipt-message-1'),
          skipOffstage: false,
        ),
        findsNothing,
      );
      expect(top(tester, 'message-4'), moreOrLessEquals(reading, epsilon: .5));
      expect(find.text('1 new message'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await close(tester, c);
    },
  );

  testWidgets(
    'a receipt growing in a row above the view leaves the view in place',
    (tester) async {
      final server = ConversationServer()..append('My first question');
      server.messages.last['deliveries'] = [
        {'id': 'delivery-1', 'agentId': 'lead-agent', 'status': 'delivered'},
      ];
      agentUpdates(server, 30);
      final c = await show(tester, server);
      await justAbove(tester, 'message-1');
      final reading = top(tester, 'message-4');

      // The delivery turns uncertain: its receipt adds a note and actions.
      server.messages.first['deliveries'] = [
        {'id': 'delivery-1', 'agentId': 'lead-agent', 'status': 'uncertain'},
      ];
      await c.refresh();
      await tester.pumpAndSettle();

      // In the row above the view.
      expect(
        find.text("Couldn't confirm delivery", skipOffstage: false),
        findsOneWidget,
      );
      expect(top(tester, 'message-4'), moreOrLessEquals(reading, epsilon: .5));
      expect(tester.takeException(), isNull);
      await close(tester, c);
    },
  );

  testWidgets(
    'at the end, the newest row growing keeps the end in view and the next '
    'reply follows',
    (tester) async {
      final server = ConversationServer();
      agentUpdates(server, 30);
      server.append('Is the reconnect fixed?');
      server.messages.last['deliveries'] = [
        {'id': 'delivery-1', 'agentId': 'lead-agent', 'status': 'delivered'},
      ];
      final c = await show(tester, server);
      expect(position(tester).extentAfter, lessThan(1));

      server.messages.last['deliveries'] = [
        {'id': 'delivery-1', 'agentId': 'lead-agent', 'status': 'uncertain'},
      ];
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      expect(position(tester).extentAfter, lessThan(1));

      server.append('Yes, it reconnects now.');
      fromAgent(server);
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('1 new message'), findsNothing);
      expect(position(tester).extentAfter, lessThan(1));
      expect(find.text('Yes, it reconnects now.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await close(tester, c);
    },
  );

  testWidgets('reading older messages, the end growing does not scroll', (
    tester,
  ) async {
    final server = ConversationServer();
    agentUpdates(server, 30);
    server.append('Is the reconnect fixed?');
    final c = await show(tester, server);
    // A little above the end: not following it any more.
    position(tester).jumpTo(position(tester).maxScrollExtent - 120);
    await tester.pumpAndSettle();
    final reading = position(tester).pixels;

    server.append('Yes, it reconnects now.');
    fromAgent(server);
    await c.refresh();
    await tester.pumpAndSettle();

    expect(position(tester).pixels, reading);
    expect(find.text('1 new message'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await close(tester, c);
  });

  testWidgets('a page read in above keeps the rows on screen, state and all', (
    tester,
  ) async {
    final server = ConversationServer()..messagePage = 20;
    agentUpdates(server, 40);
    final c = await show(tester, server);
    expect(c.messages('lead').length, 20);
    position(tester).jumpTo(0);
    await tester.pump();
    final first = tester.element(row('message-21'));
    final reading = top(tester, 'message-21');

    // Reaching the top reads the page before it.
    await tester.pumpAndSettle();

    expect(c.messages('lead').length, 40);
    expect(tester.element(row('message-21')), same(first));
    expect(top(tester, 'message-21'), moreOrLessEquals(reading, epsilon: .5));
    expect(tester.takeException(), isNull);
    await close(tester, c);
  });

  testWidgets('a page read in above regroups none of the rows on screen', (
    tester,
  ) async {
    // One agent's run of short updates: every third shows its name.
    final server = ConversationServer()..messagePage = 20;
    agentUpdates(server, 41);
    final c = await show(tester, server);
    position(tester).jumpTo(0);
    await tester.pump();
    final shown = [
      for (final m in c.messages('lead'))
        if (row(m.id).hitTestable().evaluate().isNotEmpty) m.id,
    ];
    expect(shown.length, greaterThan(3));
    final tops = {for (final id in shown) id: top(tester, id)};

    await tester.pumpAndSettle();

    expect(c.messages('lead').length, 40);
    for (final id in shown) {
      expect(top(tester, id), moreOrLessEquals(tops[id]!, epsilon: .5));
    }
    expect(tester.takeException(), isNull);
    await close(tester, c);
  });

  testWidgets('paging with the keyboard across the dividing row moves rows '
      'only by the page', (tester) async {
    // Two pages: the one read first, and one read in above it.
    final server = ConversationServer()..messagePage = 20;
    agentUpdates(server, 60);
    final c = await show(tester, server);
    position(tester).jumpTo(position(tester).minScrollExtent);
    await tester.pumpAndSettle();
    expect(c.messages('lead').length, greaterThanOrEqualTo(40));
    // Just below the first row drawn, where the two halves meet.
    position(tester).jumpTo(100);
    await tester.pumpAndSettle();
    final start = position(tester).pixels;

    Future<void> page(LogicalKeyboardKey key) async {
      // The reader clicks a message, then pages; the row watched stays
      // in view: the top one going up, the bottom one going down.
      final shown = [
        for (final m in c.messages('lead'))
          if (row(m.id).hitTestable().evaluate().isNotEmpty) m.id,
      ];
      final id = key == LogicalKeyboardKey.pageUp ? shown.first : shown.last;
      tester
          .widget<Focus>(
            find.descendant(of: row(id), matching: find.byType(Focus)).first,
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      final before = position(tester).pixels, top = tester.getTopLeft(row(id));
      await tester.sendKeyEvent(key);
      await tester.pumpAndSettle();
      final moved = position(tester).pixels - before;
      expect(moved.abs(), greaterThan(100));
      expect(
        tester
            .getTopLeft(
              find.byKey(ValueKey('super-message-$id'), skipOffstage: false),
            )
            .dy,
        moreOrLessEquals(top.dy - moved, epsilon: .5),
      );
    }

    for (var i = 0; i < 3; i++) {
      await page(LogicalKeyboardKey.pageUp);
    }
    expect(position(tester).pixels, lessThan(0), reason: 'above the divide');
    // Above it, the rows read in still run oldest to newest down the view.
    final above = [
      for (final m in c.messages('lead'))
        if (row(m.id).hitTestable().evaluate().isNotEmpty) m.id,
    ];
    expect(above.length, greaterThan(2));
    final tops = [for (final id in above) tester.getTopLeft(row(id)).dy];
    expect(tops, orderedEquals([...tops]..sort()));
    for (var i = 0; i < 3; i++) {
      await page(LogicalKeyboardKey.pageDown);
    }
    expect(position(tester).pixels, moreOrLessEquals(start, epsilon: .5));
    expect(tester.takeException(), isNull);
    await close(tester, c);
  });

  testWidgets('sending while reading older messages shows the message at the '
      'end', (tester) async {
    final server = ConversationServer();
    agentUpdates(server, 30);
    final c = await show(tester, server);
    position(tester).jumpTo(200);
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('super-message-composer')),
      'Please check the arm64 build',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(server.messages.last['text'], 'Please check the arm64 build');
    expect(row('message-31').hitTestable(), findsOneWidget);
    expect(position(tester).extentAfter, lessThan(1));
    expect(find.text('1 new message'), findsNothing);
    expect(tester.takeException(), isNull);
    await close(tester, c);
  });

  double bottomOf(WidgetTester tester, String id) =>
      tester.getBottomLeft(row(id)).dy;

  /// Each row in view, where it is drawn: a row regrouped (its name shown or
  /// hidden) changes height, one moved changes place.
  Map<String, Rect> onScreen(WidgetTester tester) {
    final list = tester.getRect(
      find.byKey(const PageStorageKey('super-messages-tab-lead')),
    );
    final rows = find.byWidgetPredicate(
      (w) => switch (w.key) {
        ValueKey<String>(:final value) => value.startsWith(
          'super-message-message-',
        ),
        _ => false,
      },
    );
    return {
      for (final element in rows.evaluate())
        if (tester.getRect(find.byWidget(element.widget)) case final rect
            when rect.overlaps(list))
          (element.widget.key! as ValueKey<String>).value: rect,
    };
  }

  /// Polls [c] while [count] agent updates arrive, 50 a poll (once with
  /// none), checking [each] at every frame, or once settled.
  Future<void> poll(
    WidgetTester tester,
    ConversationServer server,
    SuperTabController c,
    int count,
    void Function() each, {
    bool everyFrame = true,
  }) async {
    for (var polls = count == 0 ? 1 : count ~/ 50; polls > 0; polls--) {
      if (count > 0) agentUpdates(server, 50);
      await c.refresh();
      for (var frame = 0; everyFrame && frame < 3; frame++) {
        await tester.pump();
        each();
      }
      await tester.pumpAndSettle();
      each();
    }
  }

  testWidgets('a reader at the end stays at the end as polls cut the oldest '
      'rows', (tester) async {
    final server = ConversationServer();
    agentUpdates(server, 30);
    final c = await show(tester, server);
    final end = bottomOf(tester, 'message-30');

    // 1,000 updates, 50 a poll: past 500 each poll cuts the oldest. New rows
    // reach the end a frame after they arrive, cut or not.
    await poll(tester, server, c, 1000, everyFrame: false, () {
      final newest = c.messages('lead').last.id;
      expect(bottomOf(tester, newest), moreOrLessEquals(end, epsilon: .5));
    });

    expect(position(tester).extentAfter, lessThan(1));
    expect(c.messages('lead'), hasLength(500));
    expect(c.hasOlder('lead'), isTrue);
    expect(tester.takeException(), isNull);
    await close(tester, c);
  });

  testWidgets('a reader scrolled up keeps every row, in place, as polls pass '
      'the cap', (tester) async {
    final server = ConversationServer();
    agentUpdates(server, 30);
    final c = await show(tester, server);
    position(tester).jumpTo(position(tester).maxScrollExtent / 2);
    await tester.pumpAndSettle();
    final shown = onScreen(tester);
    expect(shown, isNotEmpty);

    await poll(tester, server, c, 1000, () {
      expect(onScreen(tester), shown);
    });

    expect(c.messages('lead'), hasLength(1030));
    expect(tester.takeException(), isNull);
    await close(tester, c);
  });

  testWidgets('back at the end after reading up, the cut with nothing new '
      'moves and regroups no row', (tester) async {
    final server = ConversationServer();
    agentUpdates(server, 30);
    // Desktop's: the messages read lands beside the state read, before the
    // view hears of either.
    final c = await show(tester, server, reading: SuperTabReading.desktop);
    position(tester).jumpTo(position(tester).maxScrollExtent / 2);
    await tester.pumpAndSettle();
    await poll(tester, server, c, 600, () {});
    expect(c.messages('lead'), hasLength(630));
    // Back to the end: a lazy list learns its full extent as it goes.
    for (var i = 0; i < 12 && position(tester).extentAfter > 0; i++) {
      position(tester).jumpTo(position(tester).maxScrollExtent);
      await tester.pumpAndSettle();
    }
    final shown = onScreen(tester);
    expect(shown.keys, contains('super-message-message-630'));

    // The first poll moves the list's dividing row to the rows on screen;
    // the cut above it waits for the next.
    for (var i = 0; i < 2; i++) {
      await poll(tester, server, c, 0, () {
        expect(onScreen(tester), shown);
      });
    }

    expect(c.messages('lead'), hasLength(500));
    expect(position(tester).extentAfter, lessThan(1));
    expect(tester.takeException(), isNull);
    await close(tester, c);
  });
}
