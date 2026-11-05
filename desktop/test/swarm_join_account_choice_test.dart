import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';

void main() {
  Future<void> mount(WidgetTester tester, {
    required void Function(bool) selected,
    bool already = false,
    String role = 'collaborator',
    bool Function()? current,
    bool resultAlready = false,
    Brightness brightness = Brightness.light,
  }) async {
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData(brightness: brightness),
      home: Builder(builder: (context) => Scaffold(body: TextButton(
        onPressed: () => showDialog<void>(context: context, builder: (_) => SwarmJoinDialog(
          link: const SwarmJoinLink('pilot', token: 'token'),
          accountEmail: 'member@example.com', isCurrent: current ?? () => true,
          onJoined: (_, _) {},
          onNewMemberAccount: (_, _, own) => selected(own),
          request: (_, path, {body}) async => path.endsWith('/preview')
            ? {'id': 'pilot', 'name': 'Pilot', 'role': role, 'alreadyMember': already}
            : {'id': 'pilot', 'role': role, 'alreadyMember': resultAlready},
        )), child: const Text('open'),
      ))),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('Team stays default and preserves setup choice', (tester) async {
    final choices = <bool>[];
    await mount(tester, selected: choices.add);
    expect(find.text('Separate Harness Team account'), findsOneWidget);
    expect(find.text('My account'), findsOneWidget);
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(choices, [false]);
  });

  testWidgets('own account requires selection after access warning', (tester) async {
    final choices = <bool>[];
    await mount(tester, selected: choices.add);
    expect(find.textContaining('keychain'), findsOneWidget);
    await tester.ensureVisible(find.text('My account'));
    await tester.tap(find.text('My account'));
    await tester.pump();
    expect(choices, isEmpty);
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(choices, [true]);
  });

  testWidgets('viewers and existing members never choose local account access', (tester) async {
    for (final scenario in [(true, 'collaborator'), (false, 'viewer')]) {
      final choices = <bool>[];
      await mount(tester, selected: choices.add, already: scenario.$1, role: scenario.$2);
      expect(find.text('My account'), findsNothing);
      await tester.tap(find.byKey(const Key('swarm-join-confirm')));
      await tester.pumpAndSettle();
      expect(choices, isEmpty);
    }
  });

  testWidgets('membership race never forwards selected own-account permission', (tester) async {
    final choices = <bool>[];
    await mount(tester, selected: choices.add, resultAlready: true);
    await tester.ensureVisible(find.text('My account'));
    await tester.tap(find.text('My account'));
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(choices, isEmpty);
  });

  testWidgets('account change before confirmation never forwards permission', (tester) async {
    var active = true;
    final choices = <bool>[];
    await mount(tester, selected: choices.add, current: () => active);
    await tester.ensureVisible(find.text('My account'));
    await tester.tap(find.text('My account'));
    active = false;
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(choices, isEmpty);
  });
}
