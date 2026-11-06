import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/right_pane_row.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

Finder key(String value) => find.byKey(ValueKey(value));

Map<String, dynamic> buddy(String id, String name, {bool first = false}) => {
  ...conversationFixture(id, name),
  'kind': 'swarm-buddy',
  'buddyOwnerId': 'owner',
  'buddyName': name,
  if (first) 'buddyDefault': true,
};

Future<SuperTabController> controller(
  WidgetTester tester, {
  int cards = 0,
}) async {
  final server = swarm();
  server.state['swarmBuddy'] = true;
  server.state['buddyCap'] = 5;
  (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
    buddy('code', 'Code'),
    buddy('plan', 'Planning', first: true),
  ]);
  for (var i = 0; i < cards; i++) {
    (server.state['conversations'] as List).add(<String, dynamic>{
      ...conversationFixture('card-$i', 'Card $i'),
      'projectId': 'lead',
      'lastMessageSequence': 2,
      'lastMainSequence': 2,
    });
  }
  final c = server.controller(
    account: 'owner',
    initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'offline'},
  );
  await tester.runAsync(c.refresh);
  return c;
}

Future<void> showRow(WidgetTester tester, SuperTabController c) =>
    tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 500,
              child: SuperTabRightPaneRow(controller: c),
            ),
          ),
        ),
      ),
    );

void main() {
  testWidgets(
    'Buddies stay pinned before card chats, selecting and closing a card keeps Buddies',
    (tester) async {
      final c = await controller(tester);
      await showRow(tester, c);
      expect(
        tester.getTopLeft(key('super-buddy-tab-plan')).dx,
        lessThan(tester.getTopLeft(key('super-buddy-tab-code')).dx),
      );
      expect(
        tester.getTopLeft(key('super-buddy-tab-code')).dx,
        lessThan(tester.getTopLeft(key('super-chat-tab-offline')).dx),
      );
      expect(key('super-chat-divider'), findsOneWidget);
      await tester.tap(key('super-buddy-tab-code'));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'code');
      await tester.tap(key('super-chat-tab-offline'));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'offline');
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(key('super-chat-tab-offline')));
      await tester.pumpAndSettle();
      await tester.tap(key('super-chat-close-offline'));
      await tester.pumpAndSettle();
      expect(key('super-chat-tab-offline'), findsNothing);
      expect(c.selectedId, 'plan');
      expect(key('super-buddy-tab-code'), findsOneWidget);
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets('plus opens the existing New Buddy form', (tester) async {
    final c = await controller(tester);
    await showRow(tester, c);
    await tester.tap(key('super-buddy-new'));
    await tester.pumpAndSettle();
    expect(key('super-buddy-new-name'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 1));
  });
  testWidgets(
    'unread card avatars overflow after eight and the menu opens the rest',
    (tester) async {
      final c = await controller(tester, cards: 8);
      await showRow(tester, c);
      for (var i = 0; i < 8; i++) {
        await tester.runAsync(() => c.select('card-$i'));
        await tester.pump();
      }
      expect(key('super-chat-unread-card-0'), findsOneWidget);
      // Two pinned Buddies + the original card + eight more = eleven.
      expect(find.text('+3'), findsOneWidget);
      expect(key('super-chat-tab-card-7'), findsNothing);
      await tester.tap(key('super-chat-overflow'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Card 7'));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'card-7');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 1));
    },
  );
}
