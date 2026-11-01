import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'devices_fixture.dart';

/// Which computers' terminals the shell says this phone can open (a Swarm
/// chat's Open terminal follows it): one it has, linked and not reported
/// offline — the terminal search's own rule.
void main() {
  testWidgets('linked and online, or not heard from yet: yes; offline, '
      'waiting for a link, or unknown: no', (tester) async {
    final app = DevicesApp();
    addTearDown(app.dispose);
    MachineState machine(String id) => app.machineStates[id] = MachineState(
      Machine(machineId: id, authMode: MachineAuthMode.remote, name: id),
    );
    machine('online').nodeOnline = true;
    machine('unheard');
    machine('offline').nodeOnline = false;
    machine('unlinked')
      ..nodeOnline = true
      ..needsLink = true;

    await tester.pumpWidget(MaterialApp(home: PhoneShell(notifier: app)));
    await tester.pump();
    final opens = tester
        .widget<PhoneShellScope>(find.byType(PhoneShellScope))
        .canOpenMachine!;

    expect(opens('online'), isTrue);
    expect(opens('unheard'), isTrue);
    expect(opens('offline'), isFalse, reason: 'reported offline');
    expect(opens('unlinked'), isFalse, reason: 'waits for its password');
    expect(opens('elsewhere'), isFalse, reason: 'not this phone\'s');

    // Read at the moment it is asked: a computer that goes offline closes.
    app.machineStates['online']!.nodeOnline = false;
    expect(opens('online'), isFalse);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });
}
