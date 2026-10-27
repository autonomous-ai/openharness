import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/super_tab_collab_fixture.dart';

void main() {
  final edit = find.widgetWithText(TextButton, 'Edit areas');
  final field = find.byKey(const ValueKey('super-areas-field'));

  Future<void> openPerson(WidgetTester tester, String id) async {
    await tester.tap(find.byKey(ValueKey('super-person-$id')));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'the project owner sets a person\'s areas; members read them, and the partner picker shows them',
    (tester) async {
      final (server, c) = await showSwarm(tester);
      await openPerson(tester, 'dee');
      expect(find.textContaining('Areas:'), findsNothing);
      await tester.tap(edit);
      await tester.pumpAndSettle();
      await tester.enterText(field, 'devices, mobile ,, devices');
      await tester.tap(find.widgetWithText(TextButton, 'Save'));
      await tester.pumpAndSettle();
      expect(server.posts.single['command'], {
        'type': 'project.areas',
        'projectId': 'web',
        'personId': 'dee',
        'areas': ['devices', 'mobile'],
      });

      await openPerson(tester, 'dee');
      expect(find.textContaining('Areas: devices, mobile'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Close'));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('super-group-options')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(MenuItemButton, 'Partner'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-partner-picker')),
          matching: find.text('devices, mobile'),
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'an area longer than 40 characters, or more than 10, is not sent',
    (tester) async {
      final (server, _) = await showSwarm(tester, account: 'dee');
      await openPerson(tester, 'dee');
      await tester.tap(edit);
      await tester.pumpAndSettle();
      await tester.enterText(field, 'a' * 41);
      await tester.tap(find.widgetWithText(TextButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Keep each area to 40 characters.'), findsOneWidget);
      await tester.enterText(
        field,
        List.generate(11, (i) => 'area $i').join(','),
      );
      await tester.tap(find.widgetWithText(TextButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('List at most 10 areas.'), findsOneWidget);
      expect(server.posts, isEmpty);
    },
  );

  testWidgets('a person edits their own areas, not another person\'s', (
    tester,
  ) async {
    await showSwarm(tester, account: 'dee');
    await openPerson(tester, 'kai');
    expect(edit, findsNothing);
    await tester.tap(find.widgetWithText(TextButton, 'Close'));
    await tester.pumpAndSettle();
    await openPerson(tester, 'dee');
    expect(edit, findsOneWidget);
  });
}
