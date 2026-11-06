import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/join_dialog.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

// Task #3791 (Scholes, 11-06; Rowtest's review): the first-join paths as a person sees them. Each mounts the join host
// the workspace mounts (`SwarmJoinHost`), so the account choice is the real dialog, and ends with this Mac added or
// not, with no click on Add machine. The state-level cases are in swarm_first_join_paths_test.dart.

/// A new member's app: signed in as a collaborator the server joined by their email domain, this Mac's own row known.
/// [swarmMode] false is a fresh sign-in, before any Swarm view has put the app in Swarm mode.
SuperTabLaunchFixture _newMember({bool swarmMode = true}) {
  final f = SuperTabLaunchFixture(swarmMode: swarmMode);
  f.app.status = AppStatus.authenticated;
  f.app.teamAccountHereForTest = true;
  f.connection.teamCheck = {'state': 'wanted'};
  f.connection.server.state
    ..['ownerId'] = 'boss'
    ..['people'] = <dynamic>[
      {'id': 'boss', 'email': 'boss@example.com', 'role': 'owner'},
      {
        'id': 'owner',
        'email': 'owner@example.com',
        'role': 'collaborator',
        'joinedVia': 'domain',
      },
    ];
  return f;
}

Future<void> _mount(WidgetTester tester, SuperTabLaunchFixture f) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: SwarmJoinHost(app: f.app, child: const Scaffold()),
    ),
  );
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.binding.setSurfaceSize(const Size(900, 700));
}

/// One discovery, with the real timers of the fake server running.
Future<void> _discover(WidgetTester tester, SuperTabLaunchFixture f) async {
  await tester.runAsync(() async {
    await f.app.superTabs.refreshTabs();
    await pumpEventQueue();
  });
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

List<Map> _contributions(SuperTabLaunchFixture f) => [
  for (final post in f.connection.server.posts)
    if ((post['command'] as Map)['type'] == 'machine.contribute')
      post['command'] as Map,
];

/// The person answers the choice with its default, a separate Harness Team account, and waits for the add.
Future<void> _continueWithTeamAccount(
  WidgetTester tester,
  SuperTabLaunchFixture f,
) async {
  expect(find.text('Separate Harness Team account'), findsOneWidget);
  expect(find.text('My account'), findsOneWidget);
  await tester.tap(find.byKey(const Key('swarm-join-account-continue')));
  await tester.pump();
  await tester.runAsync(() async {
    await f.app.joinAddPassForTest;
    await pumpEventQueue();
  });
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets(
    'a domain auto-join listed at sign-in, then opened from the picker, shows the choice and adds this Mac',
    (tester) async {
      // Sign-in's discovery lists the Swarm before the app is in Swarm mode: the result is dropped. The person then
      // opens that Swarm, so it is open here by the time the first pass that can add runs; it must still be new.
      final f = _newMember(swarmMode: false);
      await _mount(tester, f);
      await _discover(tester, f);
      expect(find.text('Separate Harness Team account'), findsNothing);
      expect(_contributions(f), isEmpty);

      f.app.openSuperTab(tabId, 'Swarm');
      await _discover(tester, f);
      await _continueWithTeamAccount(tester, f);
      expect(_contributions(f), [containsPair('teamAccountOnly', true)]);
      expect(_contributions(f).single['machineId'], 'm');
    },
  );

  testWidgets(
    'a Swarm joined on the phone or in a Workspace, listed when Swarm mode is on, shows the choice and adds this Mac',
    (tester) async {
      final f = _newMember();
      await _mount(tester, f);
      await _discover(tester, f);
      await _continueWithTeamAccount(tester, f);
      expect(_contributions(f), [containsPair('teamAccountOnly', true)]);
    },
  );

  testWidgets(
    'an invite joined in the dialog before this Mac\'s row is known shows the choice once it is, and adds this Mac',
    (tester) async {
      final f = _newMember();
      f.app.teamAccountHereForTest = false;
      await _mount(tester, f);
      // What the dialog does once the server took the join: opens the Swarm, then asks for the add.
      f.app.openSuperTab(tabId, 'Swarm');
      await tester.runAsync(
        () => f.app.addMachineOnJoin(tabId, role: 'collaborator'),
      );
      await tester.pump();
      expect(find.text('Separate Harness Team account'), findsNothing);

      f.app.teamAccountHereForTest = true;
      await _discover(tester, f);
      await _continueWithTeamAccount(tester, f);
      expect(_contributions(f), [containsPair('teamAccountOnly', true)]);
    },
  );

  testWidgets(
    'a Swarm the person hid and reopens shows no choice and adds nothing',
    (tester) async {
      final f = _newMember();
      await _mount(tester, f);
      // The hidden id is set at once; its saved write is not what this checks.
      unawaited(f.app.superTabs.setTabVisible(tabId, false));
      expect(f.app.superTabs.hiddenIds, contains(tabId));
      f.app.openSuperTab(tabId, 'Swarm');
      await _discover(tester, f);
      // Nothing waits for an answer, so the pass ends by itself.
      await tester.runAsync(() => f.app.joinAddPassForTest);
      await tester.pump();
      expect(find.text('Separate Harness Team account'), findsNothing);
      expect(f.app.joinAccountRequest, isNull);
      expect(_contributions(f), isEmpty);
    },
  );

  testWidgets(
    'a computer the person removed from the Swarm shows no choice and stays out',
    (tester) async {
      final f = _newMember();
      f.connection.server.state['removedMachines'] = ['m'];
      await _mount(tester, f);
      await _discover(tester, f);
      await tester.runAsync(() => f.app.joinAddPassForTest);
      await tester.pump();
      expect(find.text('Separate Harness Team account'), findsNothing);
      expect(f.app.joinAccountRequest, isNull);
      expect(_contributions(f), isEmpty);
    },
  );
}
