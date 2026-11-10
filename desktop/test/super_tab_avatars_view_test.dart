import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';

/// A hover that says [text].
Finder saying(String text) => find.byWidgetPredicate(
  (w) => w is Tooltip && (w.message ?? '').contains(text),
);

void main() {
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
