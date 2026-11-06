import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/join_dialog.dart';

import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/join_link.dart';

import 'support/capture.dart';

void main() {
  final shots = Platform.environment['HARNESS_JOIN_ACCOUNT_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));
  Future<void> mount(
    WidgetTester tester, {
    required void Function(bool) selected,
    bool already = false,
    String role = 'collaborator',
    bool Function()? current,
    bool resultAlready = false,
    Brightness brightness = Brightness.light,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => SwarmJoinDialog(
                  link: const SwarmJoinLink('pilot', token: 'token'),
                  accountEmail: 'member@example.com',
                  isCurrent: current ?? () => true,
                  onJoined: (_, _) {},
                  onNewMember: (_, role) {
                    if (role == 'collaborator') selected(true);
                  },
                  request: (_, path, {body}) async => path.endsWith('/preview')
                      ? {
                          'id': 'pilot',
                          'name': 'Pilot',
                          'role': role,
                          'alreadyMember': already,
                        }
                      : {
                          'id': 'pilot',
                          'role': role,
                          'alreadyMember': resultAlready,
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
  }

  testWidgets('join uses the signed-in account without a Team choice', (
    tester,
  ) async {
    final choices = <bool>[];
    await mount(tester, selected: choices.add);
    expect(find.text('Separate Harness Team account'), findsNothing);
    expect(find.text('My account'), findsNothing);
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(choices, [true]);
  });

  testWidgets(
    'viewers and existing members never choose local account access',
    (tester) async {
      for (final scenario in [(true, 'collaborator'), (false, 'viewer')]) {
        final choices = <bool>[];
        await mount(
          tester,
          selected: choices.add,
          already: scenario.$1,
          role: scenario.$2,
        );
        expect(find.text('My account'), findsNothing);
        await tester.tap(find.byKey(const Key('swarm-join-confirm')));
        await tester.pumpAndSettle();
        expect(choices, isEmpty);
      }
    },
  );

  testWidgets(
    'membership race never forwards selected own-account permission',
    (tester) async {
      final choices = <bool>[];
      await mount(tester, selected: choices.add, resultAlready: true);
      await tester.tap(find.byKey(const Key('swarm-join-confirm')));
      await tester.pumpAndSettle();
      expect(choices, isEmpty);
    },
  );

  testWidgets('account change before confirmation never forwards permission', (
    tester,
  ) async {
    var active = true;
    final choices = <bool>[];
    await mount(tester, selected: choices.add, current: () => active);
    active = false;
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(choices, isEmpty);
  });
}
