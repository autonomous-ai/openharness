import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/join_machine.dart';
import 'package:harness/ws/ws_conn.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

// Task #3160 (Scholes, 11-05): about a dozen new members joined through a
// domain auto-join, a Workspace-open join or on the phone or web first, and
// were never offered the Harness Team account: the add ran only from
// Desktop's own join dialog. Discovery now runs it once for any Swarm new here.

/// This Mac's app, signed in, its Swarm list naming one Swarm the person is
/// in as [role], joined on the server (a domain auto-join) with no client
/// asking.
SuperTabLaunchFixture _computer({
  String role = 'collaborator',
  bool chooseTeam = true,
}) {
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
  if (chooseTeam) {
    f.app.addListener(() => f.app.joinAccountRequest?.complete(false));
  }
  return f;
}

/// One discovery, and the add it started run to its end.
Future<void> _discover(SuperTabLaunchFixture f) async {
  await f.app.superTabs.refreshTabs();
  await f.app.joinAddPassForTest;
  // The notes reach their listeners after it.
  await pumpEventQueue();
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

/// The Swarm's first loads: each is a read of its whole state.
int _firstLoads(SuperTabLaunchFixture f) => [
  for (final (type, payload) in f.connection.calls)
    if (type == 'super_tabs' &&
        payload['method'] == 'GET' &&
        payload['path'] == '/api/super-tabs/$tabId/parts')
      payload,
].length;

void main() {
  test('explicit own-account join skips every Team setup offer', () async {
    final f = _computer();
    final notes = <SwarmJoinedMachine>[];
    final listening = f.app.joinedMachines.listen(notes.add);
    await f.app.addMachineOnJoin(tabId, role: 'collaborator', ownAccount: true);
    await pumpEventQueue();
    expect(_teamOffers(f), isEmpty);
    expect(f.app.teamSetupLocked, isFalse);
    expect(notes.single.ownAccount, isTrue);
    expect(f.connection.server.posts.last['command'], {
      'type': 'machine.ownAccountWork',
      'machineId': 'm',
      'allowed': true,
    });
    await listening.cancel();
  });

  test('discovery asks where agents run before adding the computer', () async {
    final f = _computer(chooseTeam: false);
    var asked = 0;
    f.app.addListener(() {
      final request = f.app.joinAccountRequest;
      if (request == null || request.answered) return;
      expect(_contributions(f), isEmpty);
      asked++;
      request.complete(true);
    });
    await _discover(f);
    expect(asked, 1);
    expect(_teamOffers(f), isEmpty);
    expect(
      f.connection.server.posts.last['command'],
      containsPair('allowed', true),
    );
  });

  test('cancelled choice contributes nothing and starts no setup', () async {
    final f = _computer(chooseTeam: false);
    f.app.addListener(() => f.app.joinAccountRequest?.complete(null));
    await _discover(f);
    expect(_contributions(f), isEmpty);
    expect(_teamOffers(f), isEmpty);
  });

  test(
    'account change while choosing never contributes or sends consent',
    () async {
      final f = _computer(chooseTeam: false);
      f.app.addListener(() {
        final request = f.app.joinAccountRequest;
        if (request == null || request.answered) return;
        f.app.currentUser = null;
        request.complete(true);
      });
      await _discover(f);
      expect(_contributions(f), isEmpty);
      expect(_teamOffers(f), isEmpty);
    },
  );

  test(
    'refused own-account setting never starts Team setup as an alternative',
    () async {
      final f = _computer();
      f.connection.server.unknownCommand = (c) =>
          c['type'] == 'machine.ownAccountWork';
      final notes = <SwarmJoinedMachine>[];
      final listening = f.app.joinedMachines.listen(notes.add);
      await f.app.addMachineOnJoin(
        tabId,
        role: 'collaborator',
        ownAccount: true,
      );
      await pumpEventQueue();
      expect(_teamOffers(f), isEmpty);
      expect(notes.single.ownAccount, isFalse);
      expect(notes.single.accountProblem, isNotEmpty);
      await listening.cancel();
    },
  );

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

  // Review of #3115: a Swarm opened only for the add kept polling, and a
  // viewer's was read in full on every discovery.
  test('a Swarm opened only to add this Mac is let go, and a viewer\'s is read once', () async {
    final viewer = _computer(role: 'viewer');
    await _discover(viewer);
    await _discover(viewer);
    expect(_firstLoads(viewer), 1);
    expect(viewer.app.superTabs.peek(tabId), isNull);

    final collaborator = _computer();
    await _discover(collaborator);
    expect(_contributions(collaborator), hasLength(1));
    expect(collaborator.app.superTabs.peek(tabId), isNull);
  });

  test('a first discovery before this Mac\'s own row is known still takes the update\'s baseline', () async {
    final f = _computer();
    f.app.teamAccountHereForTest = false;
    await _discover(f);
    expect(_contributions(f), isEmpty);
    // Discovery showed the Swarm meanwhile; it is still new to the add.
    f.app.teamAccountHereForTest = true;
    await _discover(f);
    expect(_contributions(f), hasLength(1));
  });

  // Task #3212: a reinstall (an empty record here) added this Mac back to a
  // Swarm its person had taken it out of.
  test(
    'after its person took this Mac out, a fresh install does not add it back',
    () async {
      final f = _computer();
      // As the Swarm tells this person: their own removed computers.
      f.connection.server.state['removedMachines'] = ['m'];
      await _discover(f);
      expect(_contributions(f), isEmpty);
      expect(_teamOffers(f), isEmpty);
      // Decided for this Swarm: the next discovery does not read it again.
      final loads = _firstLoads(f);
      await _discover(f);
      expect(_firstLoads(f), loads);
    },
  );

  test(
    'a fresh install still adds this Mac to a Swarm it was never taken out of',
    () async {
      final f = _computer();
      f.connection.server.state['removedMachines'] = ['another-computer'];
      await _discover(f);
      expect(_contributions(f), hasLength(1));
      expect(_teamOffers(f), hasLength(1));
    },
  );

  group('a failed step shows the person a note', () {
    test(
      'a Team account this Mac could not be offered says where to set it up',
      () async {
        final f = _computer();
        // A daemon that cannot say whether the account is wanted.
        f.connection.teamCheck = null;
        final notes = <SwarmJoinedMachine>[];
        final listening = f.app.joinedMachines.listen(notes.add);
        await _discover(f);
        expect(notes.map((n) => (n.added, n.teamProblem)), [
          (true, null),
          (true, 'Set it up from Machines.'),
        ]);
        await listening.cancel();
      },
    );

    test('a Swarm joined here that cannot be read says to add this Mac from Machines', () async {
      final f = _computer();
      f.connection.backendFailure = const WsRequestFailure(
        responseType: 'super_tabs_result',
        code: 'UNAVAILABLE',
        detail: 'The Swarm service is unavailable.',
        payload: {'status': 503},
      );
      final notes = <SwarmJoinedMachine>[];
      final listening = f.app.joinedMachines.listen(notes.add);
      await f.app.addMachineOnJoin(tabId, role: 'collaborator');
      await pumpEventQueue();
      expect(notes.map((n) => (n.tabId, n.added, n.problem)), [
        (
          tabId,
          false,
          'Could not reach the Swarm. Add this computer from Machines.',
        ),
      ]);
      await listening.cancel();
    });
  });
}
