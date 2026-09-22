import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/machine_profile.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';

Swarm tab(
  String id,
  List<String> machines, {
  String? titleMachine,
  String kind = 'harness',
}) {
  final swarm = Swarm(id: id, name: id, kind: kind)
    ..titleMachineId = titleMachine;
  for (var i = 0; i < machines.length; i++) {
    swarm.panes.add(TerminalPane(id: i, machineId: machines[i], agentId: 'a$i'));
  }
  return swarm;
}

void main() {
  test('no profile shows every tab', () {
    final tabs = [tab('local', ['m1']), tab('remote', ['m2'])];
    expect(swarmsForMachineProfile(tabs, null).map((s) => s.id), ['local', 'remote']);
    expect(swarmsForMachineProfile(tabs, '').map((s) => s.id), ['local', 'remote']);
  });

  test('a machine profile keeps that computer and drops the other', () {
    final store = Swarm(id: 'store', name: Swarm.storeName, kind: 'store');
    final blank = Swarm(id: 'blank');
    final local = tab('local', ['m1']);
    final remote = tab('remote', ['m2'], titleMachine: 'm2');
    final mixed = tab('mixed', ['m1', 'm2']);
    final shown = swarmsForMachineProfile([store, blank, local, remote, mixed], 'm1');
    expect(shown.map((s) => s.id), ['store', 'blank', 'local']);
  });

  test('a tab titled for another computer stays out even with no pane yet', () {
    final named = Swarm(id: 'remote-blank')..titleMachineId = 'm2';
    expect(swarmMatchesMachineProfile(named, 'm1'), isFalse);
    expect(swarmMatchesMachineProfile(named, 'm2'), isTrue);
  });

  test('a stale title does not hide a tab whose agents are all on this computer', () {
    final local = tab('local', ['m1'])..titleMachineId = 'm2';
    expect(swarmMatchesMachineProfile(local, 'm1'), isTrue);
    expect(swarmMatchesMachineProfile(local, 'm2'), isFalse);
  });

  test('closing a visible tab does not land on a hidden one in between', () {
    final local = tab('local', ['m1']);
    final remote = tab('remote', ['m2']);
    final store = Swarm(id: 'store', name: Swarm.storeName, kind: 'store');
    final swarms = [local, remote, store];
    swarms.removeAt(0);
    expect(profileNeighborId(swarms, 'm1', 0), 'store');
    expect(profileNeighborId([remote], 'm1', 0), isNull);
  });
}
