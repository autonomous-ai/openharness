import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/join/agent_dialog.dart';
import 'package:harness/super_tabs/join_dialog.dart';

import 'support/capture.dart';
import 'swarm_join_any_test.dart' show newMember, expectNoEnrollment;
import 'super_tab_launch_test.dart' show tabId;

import 'dart:io';

void main() {
  final shots = Platform.environment['HARNESS_V3_JOIN_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));
  for (final brightness in Brightness.values) {
    testWidgets('new membership brings own agent in ${brightness.name}', (
      tester,
    ) async {
      final f = newMember();
      await tester.binding.setSurfaceSize(const Size(1000, 760));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: SwarmJoinHost(app: f.app, child: const Scaffold()),
        ),
      );
      late Future<void> joining;
      await tester.runAsync(() async {
        joining = f.app.addMachineOnJoin(tabId, role: 'collaborator');
        await pumpEventQueue();
      });
      await tester.pump();
      await tester.runAsync(() async => pumpEventQueue());
      await tester.pumpAndSettle();
      expect(find.byType(SwarmAgentDialog), findsOneWidget);
      expect(find.text('Bring your agent'), findsOneWidget);
      expect(find.text('Separate Harness Team account'), findsNothing);
      expect(find.text('Add machine'), findsNothing);
      await captureWindow(tester, shots, 'bring-agent-${brightness.name}');
      await tester.tap(find.byTooltip('Close').first);
      await tester.pumpAndSettle();
      await tester.runAsync(() => joining);
      expectNoEnrollment(f);
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    });
  }
}
