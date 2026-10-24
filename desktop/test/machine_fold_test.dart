// One row per computer (docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is a second
// machine on the account, `hostMachineId` naming the Mac it runs on, and every list shows that Mac alone. The account
// stays a machine the app knows, so the agents running there still open.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

Machine _machine(String id, String name, {String? host}) => Machine(
  machineId: id,
  name: name,
  authMode: MachineAuthMode.remote,
  hostMachineId: host,
);

AppNotifier _app(List<Machine> machines) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  app.machines = machines;
  for (final machine in machines) {
    app.machineStates[machine.machineId] = MachineState(machine);
  }
  return app;
}

void main() {
  test('the machine list names the Mac a Harness Team account runs on', () {
    Machine read(Object? host) => Machine.fromJson({
      'machineId': 'team',
      'authMode': 'remote',
      'hostMachineId': host,
    });
    expect(read('mac').hostMachineId, 'mac');
    // Every other machine, and a backend from before the field.
    expect(read(null).hostMachineId, isNull);
    expect(read('').hostMachineId, isNull);
    expect(read(7).hostMachineId, isNull);
    expect(
      _machine('team', 'x', host: 'mac').copyWith(name: 'y').hostMachineId,
      'mac',
    );
  });

  test('a Harness Team account folds into its Mac only while that Mac is in the same list', () {
    final team = _machine('team', 'MacBook Pro · Team', host: 'mac');
    expect(foldsIntoHost(team, {'mac', 'team'}.contains), isTrue);
    // Its Mac left the account, or is not listed here: it shows on its own, as before.
    expect(foldsIntoHost(team, {'team'}.contains), isFalse);
    // A machine used only for agents has no host, and nothing folds into itself.
    expect(
      foldsIntoHost(_machine('box', 'Mac mini'), {'box'}.contains),
      isFalse,
    );
    expect(
      foldsIntoHost(_machine('odd', 'x', host: 'odd'), {'odd'}.contains),
      isFalse,
    );
  });

  test('lists show one row per computer, and the account stays a machine the app can open', () {
    final app = _app([
      _machine('mac', 'MacBook Pro'),
      _machine('team', 'MacBook Pro · Team', host: 'mac'),
      _machine('box', 'Mac mini'),
      _machine('orphan', 'Studio · Team', host: 'gone'),
    ]);
    expect(app.listedMachines.map((m) => m.machine.machineId), [
      'mac',
      'box',
      'orphan',
    ]);
    expect(app.foldedIntoHost('team'), isTrue);
    expect(app.foldedIntoHost('mac'), isFalse);
    expect(app.foldedIntoHost('orphan'), isFalse);
    expect(app.foldedIntoHost('unknown'), isFalse);
    // An agent in the team account reads as on the Mac.
    expect(app.shownMachineId('team'), 'mac');
    expect(app.shownMachineId('orphan'), 'orphan');
    expect(app.shownMachineId('unknown'), 'unknown');
    expect(app.stateOf('team'), isNotNull);
  });
}
