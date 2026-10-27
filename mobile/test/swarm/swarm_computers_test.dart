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
