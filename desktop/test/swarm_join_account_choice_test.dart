import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_account_choice.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/join_link.dart';

import 'support/capture.dart';
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

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
                  onNewMemberAccount: (_, _, own) => selected(own),
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

  testWidgets('Team stays default and preserves setup choice', (tester) async {
    final choices = <bool>[];
    await mount(tester, selected: choices.add);
    expect(find.text('Separate Harness Team account'), findsOneWidget);
    expect(find.text('My account'), findsOneWidget);
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(choices, [false]);
  });

  testWidgets('own account requires selection after access warning', (
    tester,
  ) async {
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
      await tester.ensureVisible(find.text('My account'));
      await tester.tap(find.text('My account'));
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
    await tester.ensureVisible(find.text('My account'));
    await tester.tap(find.text('My account'));
    active = false;
    await tester.tap(find.byKey(const Key('swarm-join-confirm')));
    await tester.pumpAndSettle();
    expect(choices, isEmpty);
  });
  testWidgets(
    'the Desktop host presents and completes a discovered account choice',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.status = AppStatus.authenticated;
      f.app.teamAccountHereForTest = true;
      f.connection.server.state
        ..['ownerId'] = 'boss'
        ..['people'] = <dynamic>[
          {'id': 'boss', 'email': 'boss@example.com', 'role': 'owner'},
          {'id': 'owner', 'email': 'owner@example.com', 'role': 'collaborator'},
        ];
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmJoinHost(
            app: f.app,
            child: const Scaffold(body: Text('workspace')),
          ),
        ),
      );
      late Future<void> joining;
      await tester.runAsync(() async {
        joining = f.app.addMachineOnJoin(tabId, role: 'collaborator');
        for (var i = 0; f.app.joinAccountRequest == null && i < 200; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
        expect(f.app.joinAccountRequest, isNotNull);
      });
      await tester.pumpAndSettle();
      expect(find.byType(SwarmJoinAccountDialog), findsOneWidget);
      await tester.ensureVisible(find.text('My account'));
      await tester.tap(find.text('My account'));
      await tester.tap(find.byKey(const Key('swarm-join-account-continue')));
      await tester.pumpAndSettle();
      await tester.runAsync(() => joining);
      expect(f.app.joinAccountRequest, isNull);
      expect(f.app.teamSetupLocked, isFalse);
      expect(
        f.connection.server.posts.last['command'],
        containsPair('allowed', true),
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a queued choice from another account is discarded without showing its Swarm',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.status = AppStatus.authenticated;
      f.app.teamAccountHereForTest = true;
      f.connection.server.state
        ..['ownerId'] = 'boss'
        ..['people'] = <dynamic>[
          {'id': 'boss', 'email': 'boss@example.com', 'role': 'owner'},
          {'id': 'owner', 'email': 'owner@example.com', 'role': 'collaborator'},
        ];
      late Future<void> joining;
      await tester.runAsync(() async {
        joining = f.app.addMachineOnJoin(tabId, role: 'collaborator');
        for (var i = 0; f.app.joinAccountRequest == null && i < 200; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
        expect(f.app.joinAccountRequest, isNotNull);
      });
      f.app.currentUser = const CurrentUserProfile(
        id: 'different',
        email: 'different@example.com',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmJoinHost(
            app: f.app,
            child: const Scaffold(body: Text('workspace')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(SwarmJoinAccountDialog), findsNothing);
      await tester.runAsync(() => joining);
      expect(f.connection.server.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final brightness in Brightness.values) {
    testWidgets(
      'join account choices fit and remain usable in ${brightness.name}',
      (tester) async {
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        await tester.binding.setSurfaceSize(const Size(900, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await mount(tester, selected: (_) {}, brightness: brightness);
        expect(tester.takeException(), isNull);
        await captureWindow(
          tester,
          shots,
          'join-account-team-${brightness.name}',
        );
        await tester.ensureVisible(find.text('My account'));
        await tester.tap(find.text('My account'));
        await tester.pumpAndSettle();
        await captureWindow(
          tester,
          shots,
          'join-account-own-${brightness.name}',
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: brightness),
            home: const Scaffold(
              body: SwarmJoinAccountDialog(swarmName: 'Pilot'),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await captureWindow(
          tester,
          shots,
          'join-account-discovery-${brightness.name}',
        );
      },
    );
  }
}
