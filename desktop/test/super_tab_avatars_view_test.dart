import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';

import 'super_tab_roster_test.dart' show RosterFixture;

void main() {
  testWidgets(
    'the roster shows each person’s avatar and status, each agent its pattern',
    (tester) async {
      final f = RosterFixture();
      addTearDown(f.dispose);
      await f.initialize();
      final people = f.server.state['people'] as List;
      people[0] = <String, dynamic>{
        ...people[0] as Map,
        'avatar': {'kind': 'preset', 'key': 'fox'},
        'status': {'text': 'Coffee break', 'emoji': '☕'},
      };
      f.server.state['agents'] = [
        for (final agent in f.server.state['agents'] as List)
          if ((agent as Map)['id'] == 'agent-1')
            {
              ...agent,
              'avatar': {'kind': 'preset', 'key': 'owl'},
            }
          else
            agent,
      ];
      await f.controller.refresh();
      await f.show(tester);
      final person = find.byKey(const ValueKey('super-person-owner'));
      expect(
        find.descendant(of: person, matching: find.text('🦊')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: person, matching: find.text('☕')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: person,
          matching: find.textContaining('Coffee break'),
        ),
        findsOneWidget,
      );
      expect(f.inRow(1, find.text('🦉')), findsOneWidget);
      expect(
        f.inRow(3, find.byKey(const ValueKey('super-avatar-pattern'))),
        findsOneWidget,
      );
      await f.close(tester);
    },
  );

  testWidgets('a message shows its author’s avatar', (tester) async {
    final person = SuperTabPerson.fromJson({
      'id': 'owner',
      'email': 'dee@example.com',
      'role': 'owner',
      'avatar': {'kind': 'preset', 'key': 'cactus'},
    });
    final message = SuperTabMessage.fromJson({
      'id': 'm1',
      'conversationId': 'lead',
      'text': 'Morning!',
      'sequence': 1,
      'author': {'kind': 'person', 'id': 'owner', 'name': 'dee@example.com'},
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabMessageRow(
            message: message,
            author: 'dee',
            person: person,
            receipts: const [],
            onReturnToComposer: () {},
          ),
        ),
      ),
    );
    expect(find.text('🌵'), findsOneWidget);
  });
}
