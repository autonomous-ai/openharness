import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/web/shell/web_machine_choice.dart';

MachineState _machine(
  AppNotifier app,
  String id, {
  bool connected = true,
  bool needsLink = false,
  bool shared = false,
}) {
  final machine = Machine(
    machineId: id,
    name: id,
    authMode: MachineAuthMode.remote,
    isShared: shared,
  );
  app.machines.add(machine);
  return app.machineStates[id] = MachineState(machine)
    ..nodeOnline = true
    ..needsLink = needsLink
    ..connectionStatus = connected
        ? ConnectionStatus.connected
        : ConnectionStatus.disconnected;
}

void main() {
  late AppNotifier app;
  setUp(() {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
  });
  tearDown(() => app.dispose());

  test('prefers the selected machine when it can take work', () {
    _machine(app, 'first');
    _machine(app, 'second');
    app.selectedMachineId = 'second';
    expect(webNewHarnessMachine(app), 'second');
  });

  test('skips machines that cannot start a harness', () {
    _machine(app, 'linking', needsLink: true);
    _machine(app, 'offline', connected: false);
    _machine(app, 'shared', shared: true);
    app.selectedMachineId = 'linking';
    expect(webNewHarnessMachine(app), isNull);
    _machine(app, 'ready');
    expect(webNewHarnessMachine(app), 'ready');
  });
}
