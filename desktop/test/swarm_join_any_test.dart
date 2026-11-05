import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/join_machine.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

// Task #3160 (Scholes, 11-05): about a dozen new members joined through a
// domain auto-join, a Workspace-open join or on the phone or web first, and
// were never offered the Harness Team account: the add ran only from
// Desktop's own join dialog. Discovery now runs it once for any Swarm new here.

/// This Mac's app, signed in, its Swarm list naming one Swarm the person is
/// in as [role], joined on the server (a domain auto-join) with no client
/// asking.
SuperTabLaunchFixture _computer({String role = 'collaborator'}) {
  final f = SuperTabLaunchFixture();
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
        'role': role,
        'joinedVia': 'domain',
      },
    ];
  return f;
}

/// One discovery, and the add it started run to its end.
Future<void> _discover(SuperTabLaunchFixture f) async {
  await f.app.superTabs.refreshTabs();
  await f.app.joinAddPassForTest;
}

List<Map> _contributions(SuperTabLaunchFixture f) => [
  for (final post in f.connection.server.posts)
    if ((post['command'] as Map)['type'] == 'machine.contribute')
      post['command'] as Map,
];

List<Map> _teamOffers(SuperTabLaunchFixture f) => [
  for (final (type, payload) in f.connection.calls)
    if (type == 'super_tabs' && payload['action'] == 'teamSetupCheck') payload,
];

void main() {
  test('a Swarm first seen through a domain auto-join adds this Mac and offers the Team account, once', () async {
    final f = _computer();
    final notes = <SwarmJoinedMachine>[];
    final listening = f.app.joinedMachines.listen(notes.add);
    await _discover(f);
    expect(_contributions(f), [containsPair('teamAccountOnly', true)]);
    expect(_contributions(f).single['machineId'], 'm');
    expect(_teamOffers(f), [
      {'action': 'teamSetupCheck', 'reason': 'join', 'tabId': tabId},
    ]);
    expect(notes.map((n) => (n.tabId, n.added)), [(tabId, true)]);
    expect(f.app.teamSetupLocked, isTrue);

    // The person removed this Mac again: the next discovery leaves it so.
    f.connection.server.state['machines'] = <dynamic>[];
    await _discover(f);
    expect(_contributions(f), hasLength(1));
    expect(_teamOffers(f), hasLength(1));
    expect(notes, hasLength(1));
    await listening.cancel();
  });

  test(
    'it never runs again for the same Swarm and person after a restart',
    () async {
      final first = _computer();
      await _discover(first);
      expect(_contributions(first), hasLength(1));

      final restarted = _computer();
      restarted.store.values.addAll(first.store.values);
      await _discover(restarted);
      expect(_contributions(restarted), isEmpty);
      expect(_teamOffers(restarted), isEmpty);
    },
  );

  test('a viewer is never added and never offered the Team account', () async {
    final f = _computer(role: 'viewer');
    final notes = <SwarmJoinedMachine>[];
    final listening = f.app.joinedMachines.listen(notes.add);
    await _discover(f);
    await _discover(f);
    expect(_contributions(f), isEmpty);
    expect(_teamOffers(f), isEmpty);
    expect(notes, isEmpty);
    await listening.cancel();
  });

  test(
    'a Swarm already shown on this computer before the update is left as it is',
    () async {
      final f = _computer();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      await _discover(f);
      expect(_contributions(f), isEmpty);
      expect(_teamOffers(f), isEmpty);
    },
  );

  test(
    'a join in Desktop and the discovery after it add this Mac once',
    () async {
      final f = _computer();
      await f.app.addMachineOnJoin(tabId, role: 'collaborator');
      expect(_contributions(f), hasLength(1));
      f.connection.server.state['machines'] = <dynamic>[];
      await _discover(f);
      expect(_contributions(f), hasLength(1));
      expect(_teamOffers(f), hasLength(1));
    },
  );
}
