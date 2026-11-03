import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';

/// Huy (11-03): the chat and the thread draw avatars as Slack does, 36 px
/// rounded squares, with more room above each new sender.
SuperTabMessage _message(String id, {Map<String, dynamic>? avatar}) =>
    SuperTabMessage.fromJson({
      'id': id,
      'conversationId': 'lead',
      'text': 'Shipped the fix',
      'sequence': 1,
      'author': {
        'kind': 'person',
        'id': 'peer',
        'name': 'ivy@example.com',
        if (avatar != null) 'avatar': avatar,
      },
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

/// The face's rounded-square fill: no circle, an 8-point corner.
bool _roundedSquare(Widget w) =>
    w is Container &&
    w.decoration is BoxDecoration &&
    (w.decoration! as BoxDecoration).shape == BoxShape.rectangle &&
    (w.decoration! as BoxDecoration).borderRadius == BorderRadius.circular(8);

void main() {
  testWidgets('a message avatar is a 36-point rounded square', (tester) async {
    await _show(tester, [_row(_message('m1'))]);
    final avatar = find.byType(SuperTabAvatar);
    expect(tester.getSize(avatar), const Size.square(36));
    expect(
      find.descendant(
        of: avatar,
        matching: find.byWidgetPredicate(_roundedSquare),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a message photo is clipped to the same rounded square', (
    tester,
  ) async {
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
          'avatar': {'kind': 'upload', 'url': 'https://storage.googleapis.com/avatars/ivy.png'},
        }),
      ),
    ]);
    final avatar = find.byType(SuperTabAvatar);
    expect(
      find.descendant(of: avatar, matching: find.byType(ClipOval)),
      findsNothing,
    );
    final clip = tester.widget<ClipRRect>(
      find.descendant(of: avatar, matching: find.byType(ClipRRect)),
    );
    expect(clip.borderRadius, BorderRadius.circular(8));
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

  testWidgets('a new sender starts a group gap and a control gap down', (
    tester,
  ) async {
    await _show(tester, [_row(_message('m1'))]);
    final rowTop = tester.getTopLeft(find.byType(SuperTabMessageRow)).dy;
    final avatarTop = tester.getTopLeft(find.byType(SuperTabAvatar)).dy;
    expect(
      avatarTop - rowTop,
      grid.AppDesktop.groupGap + grid.AppDesktop.controlGap,
    );
  });

  testWidgets('a grouped follow-up line keeps today\'s tight spacing', (
    tester,
  ) async {
    await _show(tester, [_row(_message('m2'), grouped: true)]);
    final rowTop = tester.getTopLeft(find.byType(SuperTabMessageRow)).dy;
    final textTop = tester.getTopLeft(find.text('Shipped the fix')).dy;
    expect(textTop - rowTop, 6);
  });
}
