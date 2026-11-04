import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/agent_alert_banners.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;
import 'super_tab_waiting_notice_test.dart' show waitingSwarm;
import 'support/capture.dart';

/// Set to a folder to write the PR's screenshots there.
final _shots = Platform.environment['HARNESS_WAITING_NOTICE_CAPTURE_DIR'];

/// The toast, the task with the agent's terminal open after its click, and
/// the reason for an agent no chat holds (#2792).
void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      final f = SuperTabLaunchFixture();
      final c = await waitingSwarm(f);
      f.app.agentAlerts.store.value = true;
      addTearDown(() => f.app.agentAlerts.store.value = false);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: Stack(
              children: [
                ListenableBuilder(
                  listenable: f.app,
                  builder: (_, _) => SuperTabWorkspace(
                    app: f.app,
                    canvas: PaneGrid(notifier: f.app, swarmMode: true),
                    onAddAgent: (_) {},
                  ),
                ),
                AgentAlertBanners(notifier: f.app),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> toast(String agent) async {
        f.app.agentAlerts.post(
          AgentAlert(
            machineId: 'm',
            agentId: 'native-$agent',
            title: agent == 'nova' ? 'Nova' : 'Finn',
            kind: AlertKind.needsYou,
            at: DateTime.now(),
          ),
        );
        for (var frame = 0; frame < 5; frame++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }

      await toast('nova');
      await captureWindow(tester, _shots, 'waiting-toast-${brightness.name}');
      await tester.tap(find.byKey(const Key('agent-alert-banner')));
      // A terminal pane keeps drawing, so frames rather than a settle.
      for (var frame = 0; frame < 20; frame++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(c.selectedId, 'task');
      await captureWindow(
        tester,
        _shots,
        'waiting-terminal-${brightness.name}',
      );
      await toast('finn');
      await tester.tap(find.byKey(const Key('agent-alert-banner')));
      for (var frame = 0; frame < 10; frame++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byType(SnackBar), findsOneWidget);
      await captureWindow(tester, _shots, 'waiting-no-chat-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    });
  }
}
