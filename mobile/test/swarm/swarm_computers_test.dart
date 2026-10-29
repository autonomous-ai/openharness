import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/swarm/swarm_computers.dart';

import '../viewer_app_fixture.dart';

/// The account's computers as Swarm's start screens see them, from the app's
/// own machine list.
void main() {
  test('each computer by name, away only when the socket and the list agree, '
      'and nothing until the list has answered', () async {
    final rig = viewerApp();
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    expect(computers.computers, isNull, reason: 'not answered yet');

    rig.api.onMachines = () async => [
      remoteMachine('a', name: 'Studio Mac'),
      remoteMachine('b', name: 'Mac mini', status: 'offline'),
    ];
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('a', ConnectionStatus.connected);
    rig.app.connectionStatusForTest('b', ConnectionStatus.disconnected);
    await settle();

    expect(computers.computers, [
      (name: 'Studio Mac', away: false),
      (name: 'Mac mini', away: true),
    ]);
  });

  test('tells only when the computers change, not at every change of the '
      'app', () async {
    final rig = await signedInWith({'a': []});
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    var told = 0;
    computers.addListener(() => told++);

    rig.app.connectionStatusForTest('a', ConnectionStatus.connected);
    await settle();
    expect(told, 0);

    rig.api.onMachines = () async => [remoteMachine('a', status: 'offline')];
    await rig.app.refreshMachines();
    rig.app.connectionStatusForTest('a', ConnectionStatus.disconnected);
    await settle();

    expect(computers.computers, [(name: 'Machine a', away: true)]);
    expect(told, 1);
  });

  // At a cold start the socket comes up after the list, away all along: a
  // Swarm read that failed for want of a computer waited 2 to 8 s for its
  // next try (audit of 44d284f65, item 6).
  test('tells when a computer comes up, and not when it goes', () async {
    final rig = await signedInWith({'a': []});
    addTearDown(rig.app.dispose);
    rig.app.connectionStatusForTest('a', ConnectionStatus.connecting);
    await settle();
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    var told = 0;
    computers.addListener(() => told++);

    rig.app.connectionStatusForTest('a', ConnectionStatus.connected);
    await settle();
    expect(told, 1);
    expect(computers.computers, [(name: 'Machine a', away: false)]);

    rig.app.connectionStatusForTest('a', ConnectionStatus.reconnecting);
    await settle();
    expect(told, 1, reason: 'still listed as up: nothing to tell');
  });

  test("the person's own computers: never one shared with them, nor a "
      'Harness Team account, nor one waiting for a link; their own away '
      'ones too, as away', () async {
    final rig = viewerApp();
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    Machine machine(String id, {bool shared = false, String? kind}) => Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: id,
      status: 'online',
      shared: shared,
      sessionKind: kind,
    );
    rig.api.onMachines = () async => [
      machine('studio'),
      machine('mini'),
      machine('ken-mac', shared: true),
      machine('team', kind: 'team'),
      machine('new-mac'),
    ];
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('studio', ConnectionStatus.connected);
    rig.app.connectionStatusForTest('mini', ConnectionStatus.disconnected);
    rig.app.machineStates['new-mac']!.needsLink = true;
    rig.api.onMachines = () async => [
      machine('studio'),
      Machine(
        machineId: 'mini',
        authMode: MachineAuthMode.remote,
        name: 'mini',
        status: 'offline',
      ),
      machine('ken-mac', shared: true),
      machine('team', kind: 'team'),
      machine('new-mac'),
    ];
    await rig.app.refreshMachines();
    await settle();

    expect(computers.computers, hasLength(5));
    expect(computers.own, [
      (id: 'studio', name: 'studio', away: false),
      (id: 'mini', name: 'mini', away: true),
    ]);
  });

  test('Try again reads the list again', () async {
    final rig = await signedInWith({'a': []});
    addTearDown(rig.app.dispose);
    final computers = AppSwarmComputers(rig.app);
    addTearDown(computers.dispose);
    var listed = 0;
    rig.api.onMachines = () async {
      listed++;
      return [remoteMachine('a')];
    };

    await computers.recheck();

    expect(listed, 1);
    expect(computers.rechecking, isFalse);
  });
}
