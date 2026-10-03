import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/sections/profiles_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';

import 'swarm_state_test.dart' show createApp;

OutlinedButton _button(WidgetTester tester, int row) => tester
    .widgetList<OutlinedButton>(find.byType(OutlinedButton))
    .elementAt(row);

void main() {
  testWidgets(
    'a computer that is not connected or is offline cannot be chosen',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      const other = Machine(
        machineId: 'far',
        authMode: MachineAuthMode.remote,
        name: 'Far host',
      );
      app.machines = [...app.machines, other];
      app.machineStates['far'] = MachineState(other)
        ..connectionStatus = ConnectionStatus.disconnected;

      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(body: ProfilesSection(notifier: app)),
        ),
      );
      // All machines is the default, and chosen.
      expect(_button(tester, 0).onPressed, isNull);
      expect(find.text('Showing'), findsOneWidget);
      // Connected and online: can be chosen.
      expect(_button(tester, 1).onPressed, isNotNull);
      // Not connected: cannot, and says why.
      expect(_button(tester, 2).onPressed, isNull);
      expect(find.textContaining('Not connected.'), findsOneWidget);

      // A connection that is up to a machine that reports itself offline.
      app.machineStates['far']!
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = false;
      app.notifyListeners();
      await tester.pump();
      expect(_button(tester, 2).onPressed, isNull);
      expect(find.textContaining('Offline.'), findsOneWidget);

      app.machineStates['far']!.nodeOnline = true;
      app.notifyListeners();
      await tester.pump();
      expect(_button(tester, 2).onPressed, isNotNull);
      await tester.tap(find.byType(OutlinedButton).at(2));
      await tester.pump();
      expect(app.machineProfileId, 'far');
    },
  );
}
