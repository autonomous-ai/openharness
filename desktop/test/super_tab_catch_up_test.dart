import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/catch_up.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _card = ValueKey('super-catch-up');
const _close = ValueKey('super-catch-up-close');
const _line = ValueKey('super-new-messages-line');

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
}) => {
  'after': 10,
  'through': 40,
  'unread': 30,
  'more': false,
  'decisions': decisions,
  'landed': _list(landed),
  'blocked': _list(blocked),
  'needsYou': _list(needsYou, total: needsYouTotal > 0 ? needsYouTotal : null),
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
}
