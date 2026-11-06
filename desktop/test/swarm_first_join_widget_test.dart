import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/new_harness_form.dart';
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
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      final f = newMember();
      await tester.binding.setSurfaceSize(const Size(1000, 760));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
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
      // Task #4196: the Cmd-N form, its agent and computer, for a Buddy.
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(find.text('Bring agent'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('new-harness-field-project')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('new-harness-field-agent-kind')),
        findsNothing,
      );
      expect(find.text('Separate Harness Team account'), findsNothing);
      expect(find.text('Add machine'), findsNothing);
      await captureWindow(tester, shots, 'bring-agent-${brightness.name}');
      if (brightness == Brightness.dark) {
        await tester.tap(find.byKey(const ValueKey('new-harness-close')));
        await tester.pumpAndSettle();
        await tester.runAsync(() => joining);
        expectNoEnrollment(f);
      } else {
        await tester.runAsync(() async {
          await tester.tap(find.text('Bring agent'));
          await pumpEventQueue();
        });
        await tester.pumpAndSettle();
        if (find.text('Retry').evaluate().isNotEmpty) {
          await tester.runAsync(() async {
            await tester.tap(find.text('Retry'));
            await pumpEventQueue();
          });
          await tester.pumpAndSettle();
        }
        expect(find.byType(NewHarnessForm), findsNothing);
        await tester.runAsync(() => joining);
        final starts = f.connection.server.posts.where(
          (post) => (post['command'] as Map)['type'] == 'buddy.create',
        );
        expect(starts, hasLength(1));
        expect(f.app.activeSwarm.superTabId, tabId);
        expect(starts.single['command'], containsPair('engine', 'claude'));
        expect(starts.single['command'], containsPair('machineId', 'm'));
        expect(
          f.connection.server.posts.where(
            (post) => (post['command'] as Map)['type'] == 'machine.contribute',
          ),
          isEmpty,
        );
      }
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    });
  }
}
