import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_status.dart';
import 'package:harness_mobile/state/app_state.dart';

/// Intern 3, set up from this phone on a slow Wi-Fi (2026-11-03): refused because its key was not
/// in the account's log yet. Late, not locked — until the wait runs out.
void main() {
  MachineState refused() =>
      MachineState(
          const Machine(
            machineId: 'm',
            authMode: MachineAuthMode.remote,
            name: 'Harness-EE07',
          ),
        )
        ..nodeOnline = true
        ..needsLink = true;

  test('a machine whose key has not landed reads as connecting', () {
    final machine = refused()..keyAwaitedSince = DateTime.now();
    expect(machine.awaitingKey, isTrue);
    expect(phoneMachineStatusOf(machine), PhoneMachineStatus.connecting);
  });

  test('the wait runs out: its password form', () {
    final machine = refused()
      ..keyAwaitedSince = DateTime.now().subtract(MachineState.keyAwaitLimit);
    expect(machine.awaitingKey, isFalse);
    expect(phoneMachineStatusOf(machine), PhoneMachineStatus.needsPassword);
  });

  test('a refusal with its key in the log is locked at once', () {
    final machine = refused();
    expect(machine.awaitingKey, isFalse);
    expect(phoneMachineStatusOf(machine), PhoneMachineStatus.needsPassword);
  });

  test('linked, it waits for nothing', () {
    final machine = refused()
      ..keyAwaitedSince = DateTime.now()
      ..needsLink = false;
    expect(machine.awaitingKey, isFalse);
  });
}
