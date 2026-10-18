import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/machines_tab.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'edge_fixture.dart';

/// A launch wait that goes on: the computers are offered, and opening them that way is counted.
void main() {
  testWidgets(
    'a long wait offers the computers, counted as opened by a button',
    (tester) async {
      setPhone(tester, largePhone);
      final usage = RecordedOpenings();
      // The computer is up but its sessions never arrive: home waits on them.
      final app = edgeApp(
        agents: const [],
        load: AgentLoadStatus.loading,
        productMeasurement: usage,
      );
      addTearDown(app.dispose);
      await tester.pumpWidget(
        phoneApp(
          PhoneShellScope(
            onMachineLinked: (_) {},
            onOpenAgent: (_, _) {},
            child: AgentHome(notifier: app),
          ),
        ),
      );
      await frames(tester);
      expect(find.byKey(const ValueKey('home-wait-computers')), findsNothing);

      await tester.pump(const Duration(seconds: 16));
      await frames(tester);
      await tapInView(
        tester,
        find.byKey(const ValueKey('home-wait-computers')),
      );
      await frames(tester, count: 6);

      expect(find.byType(MachinesTab), findsOneWidget);
      expect(usage.opened, [(PhoneScreen.computers, ScreenOpening.button)]);
      await unmount(tester);
    },
  );
}
