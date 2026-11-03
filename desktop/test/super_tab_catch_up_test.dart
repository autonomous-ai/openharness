import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/activity_view.dart';
import 'package:harness/super_tabs/catch_up.dart';
import 'package:harness/super_tabs/catch_up_card.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _card = ValueKey('super-catch-up');
const _close = ValueKey('super-catch-up-close');
const _line = ValueKey('super-new-messages-line');
const _decisions = ValueKey('super-catch-up-decisions');
const _mentions = ValueKey('super-catch-up-mentions');

/// [count] messages in the Lead conversation from the Lead agent.
ConversationServer _server(int count) {
  final server = ConversationServer();
  for (var i = 1; i <= count; i++) {
    server.append('Update $i');
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'lead-agent',
      'name': 'Lead',
    };
  }
  return server;
}

Map<String, dynamic> _item(int sequence, String text, {String by = 'River'}) =>
    {
      'messageId': 'message-$sequence',
      'sequence': sequence,
      'author': by,
      'text': text,
    };

Map<String, dynamic> _list(List<Map<String, dynamic>> items, {int? total}) => {
  'total': total ?? items.length,
  'items': items,
};

/// What the backend answers for the Lead conversation read after message 10.
Map<String, dynamic> _summary({
  List<Map<String, dynamic>> landed = const [],
  List<Map<String, dynamic>> blocked = const [],
  List<Map<String, dynamic>> needsYou = const [],
  int needsYouTotal = 0,
  int decisions = 0,
  bool more = false,
}) => {
  'after': 10,
  'through': 40,
  'unread': 30,
  'more': more,
  'decisions': decisions,
  'landed': _list(landed),
  'blocked': _list(blocked),
  'needsYou': _list(needsYou, total: needsYouTotal > 0 ? needsYouTotal : null),
};

/// Every list with more than it shows, and two decisions: Needs you 3 more,
/// Blocked 2 more, Landed 4 more.
Map<String, dynamic> _counted() => {
  ..._summary(decisions: 2),
  'needsYou': _list([_item(25, 'Question 3')], total: 4),
  'blocked': _list([_item(26, 'Stuck: no simulator', by: 'Iris')], total: 3),
  'landed': _list([_item(27, 'Avatars')], total: 5),
};

void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    final c = server.controller();
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

  Finder inCard(String text) =>
      find.descendant(of: find.byKey(_card), matching: find.text(text));

  /// An item row, whose words follow its author's name.
  Finder rowSaying(String text) => find.descendant(
    of: find.byKey(_card),
    matching: find.textContaining(text),
  );

  group('SuperTabCatchUp', () {
    test('reads the backend summary, and is empty with nothing listed', () {
      final summary = SuperTabCatchUp.fromJson(
        _summary(
          needsYou: [_item(12, 'Dee, which colour?')],
          needsYouTotal: 7,
          decisions: 2,
        ),
      );
      expect(summary.unread, 30);
      expect(summary.decisions, 2);
      expect(summary.needsYou.total, 7);
      expect(summary.needsYou.items.single.messageId, 'message-12');
      expect(summary.needsYou.items.single.author, 'River');
      expect(summary.needsYou.items.single.text, 'Dee, which colour?');
      expect(summary.isEmpty, isFalse);
      expect(SuperTabCatchUp.fromJson(_summary()).isEmpty, isTrue);
      // Decisions alone are something that needs the reader.
      expect(SuperTabCatchUp.fromJson(_summary(decisions: 1)).isEmpty, isFalse);
      // A span longer than one summary reads is shown even with nothing
      // listed: the reader is told it is partial.
      final partial = SuperTabCatchUp.fromJson(_summary(more: true));
      expect(partial.more, isTrue);
      expect(partial.isEmpty, isFalse);
      // A malformed answer is empty, never a crash.
      expect(SuperTabCatchUp.fromJson(const {}).isEmpty, isTrue);
    });
  });

  for (final late in [false, true]) {
    testWidgets('shows what the reader missed just under the New messages '
        'line (${late ? 'answered late' : 'answered at once'})', (
      tester,
    ) async {
      // A window and a span as long as a real return's: the card arrives
      // once the view has opened at the line.
      tester.view.physicalSize = const Size(1200, 860);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final server = _server(80)..markReadElsewhere('lead', 30);
      server.catchUps['lead'] = _summary(
        landed: [_item(40, 'Avatars'), _item(44, 'Done: Merged #2201.')],
        blocked: [_item(50, 'Stuck: No simulator on this Mac.', by: 'Iris')],
        needsYou: [_item(45, 'Dee, which colour?')],
      );
      final hold = late ? server.holdCatchUp = Completer<void>() : null;
      await show(tester, server);
      if (hold != null) {
        expect(find.byKey(_card), findsNothing);
        hold.complete();
        await tester.pumpAndSettle();
      }
      expect(server.catchUpReads, [
        '/api/super-tabs/tab/conversations/lead/catch-up?after=30',
      ]);
      expect(find.byKey(_card), findsOneWidget);
      // Whenever it arrives, the line and the card's top are in view: the card
      // makes the line's row taller than the view.
      final list = tester.getRect(
        find.byKey(const PageStorageKey('super-messages-tab-lead')),
      );
      expect(tester.getTopLeft(find.byKey(_line)).dy, greaterThan(list.top));
      expect(
        tester.getTopLeft(inCard('While you were away')).dy,
        lessThan(list.bottom),
      );
      expect(inCard('While you were away'), findsOneWidget);
      expect(inCard('30 new messages'), findsOneWidget);
      for (final heading in ['Needs you', 'Blocked', 'Landed']) {
        expect(inCard(heading), findsOneWidget);
      }
      expect(rowSaying('Dee, which colour?'), findsOneWidget);
      expect(rowSaying('Stuck: No simulator on this Mac.'), findsOneWidget);
      expect(rowSaying('Avatars'), findsOneWidget);
      // Needs you first: what the reader has to act on.
      final top = tester.getTopLeft(inCard('Needs you')).dy;
      expect(top, lessThan(tester.getTopLeft(inCard('Blocked')).dy));
      expect(
        tester.getTopLeft(inCard('Blocked')).dy,
        lessThan(tester.getTopLeft(inCard('Landed')).dy),
      );
      // At the top of the new messages: below the line, above the first unread.
      expect(
        tester.getTopLeft(find.byKey(_card)).dy,
        greaterThan(tester.getTopLeft(find.byKey(_line)).dy),
      );
      expect(
        tester.getTopLeft(find.byKey(_card)).dy,
        lessThan(tester.getTopLeft(find.text('Update 31')).dy),
      );
    });
  }

  testWidgets('an item opens its message, lit', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 10);
    server.catchUps['lead'] = _summary(needsYou: [_item(38, 'Update 38')]);
    await show(tester, server);
    await tester.tap(find.byKey(const ValueKey('super-catch-up-message-38')));
    await tester.pumpAndSettle();
    final lit = find.byWidgetPredicate(
      (w) => w is SuperTabMessageHighlight && w.on,
    );
    expect(
      find.descendant(of: lit, matching: find.text('Update 38')),
      findsOneWidget,
    );
  });

  testWidgets('says how many more each list has, and the decisions waiting', (
    tester,
  ) async {
    final server = _server(40)..markReadElsewhere('lead', 10);
    server.catchUps['lead'] = _summary(
      needsYou: [_item(25, 'Question 3'), _item(26, 'Question 4')],
      needsYouTotal: 5,
      decisions: 2,
    );
    await show(tester, server);
    expect(inCard('3 more'), findsOneWidget);
    expect(inCard('2 decisions wait for you'), findsOneWidget);
  });

  testWidgets('says when it covers only the first part of a long absence', (
    tester,
  ) async {
    final server = _server(40)..markReadElsewhere('lead', 10);
    server.catchUps['lead'] = _summary(more: true);
    await show(tester, server);
    expect(find.byKey(_card), findsOneWidget);
    // Never a count that reads as complete.
    expect(inCard('30+ new messages'), findsOneWidget);
    expect(inCard('30 new messages'), findsNothing);
    expect(
      inCard(
        'Covers only the first part of what you missed. '
        'Newer messages are below.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('Close dismisses it for this visit, without reading again', (
    tester,
  ) async {
    final server = _server(40)..markReadElsewhere('lead', 10);
    server.catchUps['lead'] = _summary(landed: [_item(20, 'Avatars')]);
    final c = await show(tester, server);
    await tester.tap(find.byKey(_close));
    await tester.pumpAndSettle();
    expect(find.byKey(_card), findsNothing);
    // The line stays: only the card was dismissed.
    expect(find.byKey(_line), findsOneWidget);
    server.append('Later');
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.byKey(_card), findsNothing);
    expect(server.catchUpReads, hasLength(1));
  });

  testWidgets('Esc reads everything, card and line together', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 10);
    server.catchUps['lead'] = _summary(landed: [_item(20, 'Avatars')]);
    await show(tester, server);
    await tester.tap(find.byType(TextField).last);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(_card), findsNothing);
    expect(find.byKey(_line), findsNothing);
  });

  testWidgets('no card when nothing landed, is blocked or needs the reader', (
    tester,
  ) async {
    final server = _server(40)..markReadElsewhere('lead', 10);
    await show(tester, server);
    expect(server.catchUpReads, hasLength(1));
    expect(find.byKey(_line), findsOneWidget);
    expect(find.byKey(_card), findsNothing);
  });

  testWidgets('nothing unread reads no summary', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 40);
    await show(tester, server);
    expect(server.catchUpReads, isEmpty);
    expect(find.byKey(_card), findsNothing);
  });

  testWidgets('a failed read leaves the New messages line as it was', (
    tester,
  ) async {
    final server = _server(40)
      ..markReadElsewhere('lead', 10)
      ..failCatchUp = true;
    await show(tester, server);
    expect(find.byKey(_card), findsNothing);
    expect(find.byKey(_line), findsOneWidget);
  });

  group('the counts open what they count', () {
    Future<SuperTabController> showCounted(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 860);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final server = _server(40)..markReadElsewhere('lead', 10);
      server.catchUps['lead'] = _counted();
      return show(tester, server);
    }

    Finder activityView() => find.byType(SuperTabActivityView);

    testWidgets('the decisions line opens Activity on Decisions', (
      tester,
    ) async {
      final c = await showCounted(tester);
      expect(
        find.descendant(
          of: find.byKey(_decisions),
          matching: find.text('2 decisions wait for you'),
        ),
        findsOneWidget,
      );
      expect(activityView(), findsNothing);
      await tester.tap(find.byKey(_decisions));
      await tester.pumpAndSettle();
      expect(activityView(), findsOneWidget);
      expect(SuperTabActivity.of(c).filter, SuperTabActivityFilter.decisions);
    });

    testWidgets("Needs you's more opens Activity on Mentions", (tester) async {
      final c = await showCounted(tester);
      expect(
        find.descendant(
          of: find.byKey(_mentions),
          matching: find.text('3 more'),
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(_mentions));
      await tester.pumpAndSettle();
      expect(activityView(), findsOneWidget);
      expect(SuperTabActivity.of(c).filter, SuperTabActivityFilter.mentions);
    });

    for (final (key, filter, press, name) in [
      (
        _decisions,
        SuperTabActivityFilter.decisions,
        LogicalKeyboardKey.enter,
        'Enter',
      ),
      (
        _mentions,
        SuperTabActivityFilter.mentions,
        LogicalKeyboardKey.space,
        'Space',
      ),
    ]) {
      testWidgets('$name on the focused ${filter.name} link opens '
          'it, the focus drawn', (tester) async {
        final c = await showCounted(tester);
        expect(find.byKey(key), findsOneWidget);
        // The link takes keyboard focus as the app's other controls do.
        final node = Focus.of(
          tester.element(
            find.descendant(of: find.byKey(key), matching: find.byType(Text)),
          ),
        );
        node.requestFocus();
        await tester.pumpAndSettle();
        expect(node.hasPrimaryFocus, isTrue);
        final rim = tester.widget<DecoratedBox>(
          find
              .descendant(
                of: find.byKey(key),
                matching: find.byType(DecoratedBox),
              )
              .first,
        );
        expect(
          (rim.decoration as BoxDecoration).border!.top.color,
          grid.AppDesktop.focus,
        );
        await tester.sendKeyEvent(press);
        await tester.pumpAndSettle();
        expect(activityView(), findsOneWidget);
        expect(SuperTabActivity.of(c).filter, filter);
      });
    }

    testWidgets('a hand over the link, which underlines it in the accent', (
      tester,
    ) async {
      await showCounted(tester);
      final text = find.descendant(
        of: find.byKey(_decisions),
        matching: find.text('2 decisions wait for you'),
      );
      TextStyle style() => tester.widget<Text>(text).style!;
      expect(style().decoration, isNot(TextDecoration.underline));
      expect(style().color, grid.AppPalette.accentOnSurface);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(tester.getCenter(text));
      await tester.pumpAndSettle();
      expect(
        RendererBinding.instance.mouseTracker.debugDeviceActiveCursor(1),
        SystemMouseCursors.click,
      );
      expect(style().decoration, TextDecoration.underline);
    });

    testWidgets("Blocked's and Landed's more are words, not links", (
      tester,
    ) async {
      await showCounted(tester);
      for (final more in ['2 more', '4 more']) {
        expect(inCard(more), findsOneWidget);
        expect(
          find.ancestor(of: inCard(more), matching: find.byType(SuperTabLink)),
          findsNothing,
        );
        expect(
          find.ancestor(of: inCard(more), matching: find.byType(InkWell)),
          findsNothing,
        );
      }
      // Only the two that have somewhere to go.
      expect(
        find.descendant(
          of: find.byKey(_card),
          matching: find.byType(SuperTabLink),
        ),
        findsNWidgets(2),
      );
    });
  });

  testWidgets('with nowhere to open, the counts are plain words', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabCatchUpCard(
            summary: SuperTabCatchUp.fromJson(_counted()),
            onOpen: (_) {},
            onClose: () {},
          ),
        ),
      ),
    );
    expect(inCard('2 decisions wait for you'), findsOneWidget);
    expect(inCard('3 more'), findsOneWidget);
    expect(find.byKey(_decisions), findsNothing);
    expect(find.byKey(_mentions), findsNothing);
    expect(find.byType(SuperTabLink), findsNothing);
  });
}
