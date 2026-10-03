import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/machines_tab.dart';

import 'viewer_app_fixture.dart';

void main() {
  testWidgets('machines that could not load say so, and offer another go', (
    tester,
  ) async {
    // An account whose machines cannot be fetched — the relay down, the phone offline.
    final rig = viewerApp();
    final app = rig.app;
    addTearDown(app.dispose);
    rig.api.onMachines = () async =>
        throw StateError('The network connection was lost.');
    await app.retryMachines();
    await tester.pumpWidget(MaterialApp(home: MachinesTab(notifier: app)));

    // Not "No machines yet": that tells somebody with three machines to go and
    // set one up.
    expect(find.text('No computers yet'), findsNothing);
    expect(find.text("Couldn't reach your computers"), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await tester.pump();

    expect(rig.api.machineFetches, 2);
  });
}
