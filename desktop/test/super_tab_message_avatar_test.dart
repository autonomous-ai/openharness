import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';

/// The chat and the thread draw round faces at 28 (anh Dee, 11-07, #4467; Huy's 11-03 36 px rounded squares
/// before), with more room above each new sender.
SuperTabMessage _message(String id) => SuperTabMessage.fromJson({
  'id': id,
  'conversationId': 'lead',
  'text': 'Shipped the fix',
  'sequence': 1,
  'author': {'kind': 'person', 'id': 'peer', 'name': 'ivy@example.com'},
});

Widget _row(SuperTabMessage message, {bool grouped = false}) =>
    SuperTabMessageRow(
      message: message,
      author: 'ivy',
      receipts: const [],
      onReturnToComposer: () {},
      readerId: 'owner',
      grouped: grouped,
    );

Future<void> _show(WidgetTester tester, List<Widget> rows) => tester.pumpWidget(
  MaterialApp(
    home: Scaffold(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: rows,
      ),
    ),
  ),
);

/// The face's round fill.
bool _round(Widget w) =>
    w is Container &&
    w.decoration is BoxDecoration &&
    (w.decoration! as BoxDecoration).shape == BoxShape.circle;

void main() {
  testWidgets('a message avatar is a 28-point circle', (tester) async {
    await _show(tester, [_row(_message('m1'))]);
    final avatar = find.byType(SuperTabAvatar);
    expect(tester.getSize(avatar), const Size.square(28));
    expect(
      find.descendant(of: avatar, matching: find.byWidgetPredicate(_round)),
      findsOneWidget,
    );
  });

  testWidgets('a message photo is clipped to the same circle', (tester) async {
    await _show(tester, [
      SuperTabMessageRow(
        message: _message('m1'),
        author: 'ivy',
        receipts: const [],
        onReturnToComposer: () {},
        readerId: 'owner',
        person: SuperTabPerson.fromJson({
          'id': 'peer',
          'email': 'ivy@example.com',
          'role': 'collaborator',
          'avatar': {
            'kind': 'upload',
            'url': 'https://storage.googleapis.com/avatars/ivy.png',
          },
        }),
      ),
    ]);
    final avatar = find.byType(SuperTabAvatar);
    expect(
      find.descendant(of: avatar, matching: find.byType(ClipOval)),
      findsOneWidget,
    );
    expect(
      find.descendant(of: avatar, matching: find.byType(ClipRRect)),
      findsNothing,
    );
  });

  testWidgets('avatars outside messages stay round', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: SuperTabAvatar(identity: 'person:peer', name: 'ivy'),
      ),
    );
    final fill = tester.widget<Container>(
      find.descendant(
        of: find.byType(SuperTabAvatar),
        matching: find.byWidgetPredicate(
          (w) => w is Container && w.decoration is BoxDecoration,
        ),
      ),
    );
    expect((fill.decoration! as BoxDecoration).shape, BoxShape.circle);
  });

  Finder bubble() => find.byKey(const ValueKey('swarm-bubble'));

  testWidgets('a new sender starts a group gap down, its face by its bubble', (
    tester,
  ) async {
    await _show(tester, [_row(_message('m1'))]);
    final rowTop = tester.getTopLeft(find.byType(SuperTabMessageRow)).dy;
    expect(
      tester.getTopLeft(find.text('ivy')).dy - rowTop,
      grid.AppDesktop.groupGap,
    );
    // The face sits by the bottom of its sender's last bubble (#4529).
    expect(
      tester.getBottomLeft(find.byType(SuperTabAvatar)).dy,
      tester.getBottomLeft(bubble()).dy,
    );
  });

  testWidgets('a grouped follow-up bubble sits close under the one above', (
    tester,
  ) async {
    await _show(tester, [_row(_message('m2'), grouped: true)]);
    final rowTop = tester.getTopLeft(find.byType(SuperTabMessageRow)).dy;
    expect(
      tester.getTopLeft(bubble()).dy - rowTop,
      SuperTabMessageRow.joinedGap,
    );
  });
}
