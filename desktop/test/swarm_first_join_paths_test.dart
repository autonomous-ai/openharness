import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

// Task #3791 (Scholes, 11-06): a new member on Desktop 1.3.82 still had to click Add machine and never saw the Harness
// Team account / My account choice. The join's add (#3115) and its choice (#3178) must run on every first join, however
// it happened, once for each Swarm on this computer and account, and never for a computer the person removed (#3138).

/// A fresh install's app: signed in, this Mac's own row not known yet, so nothing can be added until it is, and the
/// Swarm's server state naming the person a collaborator.
SuperTabLaunchFixture _freshComputer({bool chooseTeam = true}) {
  final f = SuperTabLaunchFixture();
  f.app.status = AppStatus.authenticated;
  f.app.teamAccountHereForTest = false;
  f.connection.teamCheck = {'state': 'wanted'};
  f.connection.server.state
    ..['ownerId'] = 'boss'
    ..['people'] = <dynamic>[
      {'id': 'boss', 'email': 'boss@example.com', 'role': 'owner'},
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'collaborator'},
    ];
  if (chooseTeam) {
    f.app.addListener(() => f.app.joinAccountRequest?.complete(false));
  }
  return f;
}

/// What the Join Swarm dialog does once the server took the join
/// (`SwarmJoinDialog._join`): opens the Swarm, then asks for the add.
Future<void> _joinInTheDialog(SuperTabLaunchFixture f) async {
  f.app.openSuperTab(tabId, 'Swarm');
  await f.app.addMachineOnJoin(tabId, role: 'collaborator');
}

/// One discovery, and the add it started run to its end.
Future<void> _discover(SuperTabLaunchFixture f) async {
  await f.app.superTabs.refreshTabs();
  await f.app.joinAddPassForTest;
  await pumpEventQueue();
}

List<Map> _contributions(SuperTabLaunchFixture f) => [
  for (final post in f.connection.server.posts)
    if ((post['command'] as Map)['type'] == 'machine.contribute')
      post['command'] as Map,
];

void main() {
  test('an invite joined before this Mac\'s own row is known adds it once the row is, with no click', () async {
    final f = _freshComputer();
    await _joinInTheDialog(f);
    // Nothing could be added yet: this Mac's own row was not known.
    expect(_contributions(f), isEmpty);

    // The row arrives; the person never opens Machines. The first discovery
    // for this account must not take the Swarm they just joined as one they
    // already had (the update's baseline).
    f.app.teamAccountHereForTest = true;
    await _discover(f);
    expect(_contributions(f), [containsPair('teamAccountOnly', true)]);
  });

  test('the account choice appears for an invite joined before this Mac\'s own row is known', () async {
    final f = _freshComputer(chooseTeam: false);
    await _joinInTheDialog(f);
    f.app.teamAccountHereForTest = true;
    await _discover(f);
    expect(f.app.joinAccountRequest, isNotNull);
    expect(f.app.joinAccountRequest!.swarmName, isNotEmpty);
    f.app.joinAccountRequest!.complete(false);
    await f.app.joinAddPassForTest;
  });

  test('a computer the person removed stays out of an invite joined before its row is known', () async {
    final f = _freshComputer();
    f.connection.server.state['removedMachines'] = ['m'];
    await _joinInTheDialog(f);
    f.app.teamAccountHereForTest = true;
    await _discover(f);
    expect(_contributions(f), isEmpty);
    expect(f.app.joinAccountRequest, isNull);
  });

  test('a Swarm the person already had open before the update is still never added', () async {
    // The baseline's own job (#3115): a long-time member's Swarms stay as they chose.
    final f = _freshComputer();
    f.app.openSuperTab(tabId, 'Swarm');
    f.app.teamAccountHereForTest = true;
    await _discover(f);
    expect(_contributions(f), isEmpty);
  });
}
