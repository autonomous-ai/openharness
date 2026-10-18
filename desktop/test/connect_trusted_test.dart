import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

/// Connecting with no password: the machine is dialed now, and the answer is
/// read off its socket — connected, or refused again as needing a link.
void main() {
  late AppNotifier app;
  late MachineState mac;

  setUp(() {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    const machine = Machine(
      machineId: 'mac',
      name: 'Mac',
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    mac = app.machineStates['mac'] = MachineState(machine)
      ..nodeOnline = true
      ..needsLink = true;
  });

  tearDown(() => app.dispose());

  void socket(ConnectionStatus status, {required bool needsLink}) {
    mac
      ..connectionStatus = status
      ..needsLink = needsLink;
    app.notifyListeners();
  }

  test('a machine that trusts this device connects', () async {
    final answer = app.connectTrusted('mac');
    socket(ConnectionStatus.connecting, needsLink: true);
    socket(ConnectionStatus.connected, needsLink: false);

    expect(await answer, isTrue);
  });

  test('repeated Connect joins the active dial', () async {
    final first = app.connectTrusted('mac');
    final second = app.connectTrusted('mac');
    expect(second, same(first));
    socket(ConnectionStatus.connecting, needsLink: true);
    socket(ConnectionStatus.connected, needsLink: false);
    expect(await first, isTrue);
    expect(await second, isTrue);

    final next = app.connectTrusted('mac');
    expect(next, isNot(same(first)));
    expect(await next, isTrue);
  });

  test('a replacement machine cannot complete the old Connect', () async {
    final answer = app.connectTrusted('mac');
    socket(ConnectionStatus.connecting, needsLink: true);
    app.machineStates['mac'] = MachineState(mac.machine)
      ..connectionStatus = ConnectionStatus.connected;
    app.notifyListeners();
    expect(await answer, isFalse);
  });

  test('one that refuses again still wants its password', () async {
    final answer = app.connectTrusted('mac');
    socket(ConnectionStatus.connecting, needsLink: true);
    socket(ConnectionStatus.disconnected, needsLink: true);

    expect(await answer, isFalse);
  });

  test('the refusal from before this dial is not the answer', () async {
    final answer = app.connectTrusted(
      'mac',
      timeout: const Duration(milliseconds: 50),
    );
    // Still the old refusal: nothing has been dialed yet.
    socket(ConnectionStatus.disconnected, needsLink: true);
    var settled = false;
    answer.then((_) => settled = true);
    await Future<void>.delayed(Duration.zero);
    expect(settled, isFalse);

    expect(await answer, isFalse); // the timeout
  });

  test('an unknown machine is not connected', () async {
    expect(await app.connectTrusted('nowhere'), isFalse);
  });
}
