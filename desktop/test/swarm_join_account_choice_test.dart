import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/join_dialog.dart';

import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/join_link.dart';

void main() {
  testWidgets('join uses the signed-in account without a Team choice', (
    tester,
  ) async {
    final joined = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => SwarmJoinDialog(
                  link: const SwarmJoinLink('pilot', token: 'token'),
                  accountEmail: 'member@example.com',
                  isCurrent: () => true,
                  onJoined: (id, _) => joined.add(id),
                  request: (_, path, {body}) async => path.endsWith('/preview')
                      ? {
                          'id': 'pilot',
                          'name': 'Pilot',
                          'role': 'collaborator',
                          'alreadyMember': false,
                        }
                      : {
                          'id': 'pilot',
                          'role': 'collaborator',
                          'alreadyMember': false,
                        },
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Separate Harness Team account'), findsNothing);
    expect(find.text('My account'), findsNothing);
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(joined, ['pilot']);
  });
}
