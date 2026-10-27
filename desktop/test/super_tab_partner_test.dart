import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/super_tab_collab_fixture.dart';

void main() {
  final line = find.byKey(const ValueKey('super-partner-line'));

  Future<void> choosePartner(WidgetTester tester, String name) async {
    await tester.tap(find.byKey(const ValueKey('super-group-options')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(MenuItemButton, 'Partner'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('super-partner-picker')),
        matching: find.text(name),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'a writer names the partner from the readers; it shows beside the Engineer and on the person',
    (tester) async {
      final (server, c) = await showSwarm(tester);
      final work = (server.state['conversations'] as List).last as Map;
      work['assignment'] = {
        'id': 'w1',
        'agentId': 'atlas',
        'status': 'working',
      };
      await c.refresh();
      await tester.pumpAndSettle();
      expect(line, findsNothing);

      await choosePartner(tester, 'dee');
      expect(server.posts.single['command'], {
        'type': 'conversation.partner',
        'conversationId': 'work',
        'personId': 'dee',
      });
      expect(tester.widget<Text>(line).data, 'Engineer: Atlas · Partner: dee');
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-person-dee')),
          matching: find.text('Partner'),
        ),
        findsOneWidget,
      );

      await choosePartner(tester, 'No partner');
      expect((server.posts.last['command'] as Map)['personId'], isNull);
      expect(line, findsNothing);
    },
  );

  testWidgets('a viewer names no partner', (tester) async {
    await showSwarm(tester, account: 'kai');
    await tester.tap(find.byKey(const ValueKey('super-group-options')));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(MenuItemButton, 'Partner'), findsNothing);
  });
}
