import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/swarm_v4_data.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write Swarm v4's screenshots there.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// Swarm v4 (anh Dee 2026-11-08), in both appearances: the left pane (Your agents, Projects, Humans, Manage), a project's
/// channel in the middle, a task's chat beside it, and an agent's own chat.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final scene in [
      'channel',
      'thread',
      'tasks',
      'agent',
      'instructions',
    ]) {
      testWidgets('$scene (${brightness.name})', (tester) async {
        await tester.binding.setSurfaceSize(const Size(1440, 860));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = before);
        final server = swarmV4Server();
        final c = server.controller(
          account: 'owner',
          initial: {
            'tabId': 'tab',
            'accountId': 'owner',
            'selectedId': scene == 'agent' || scene == 'instructions'
                ? 'agent-chat-second'
                : 'lead',
          },
        );
        await tester.runAsync(c.refresh);
        if (scene == 'thread') {
          c.openThread(
            server.messages.firstWhere(
                  (m) => (m['text'] as String).startsWith('#2191'),
                )['id']
                as String,
          );
        }
        final AppNotifier app = createApp();
        addTearDown(app.dispose);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
                onNewSwarm: () {},
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
                board: true,
              ),
            ),
          ),
        );
        Future<void> settle() async {
          for (var i = 0; i < 3; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 30)),
            );
            await tester.pump(const Duration(milliseconds: 50));
          }
        }

        await settle();
        if (scene == 'instructions') {
          await tester.tap(
            find.byKey(const ValueKey('swarm-instructions-button')),
          );
          await settle();
        }
        if (scene == 'tasks') {
          await tester.tap(find.byKey(const ValueKey('swarm-tasks-button')));
          await settle();
        }
        await captureWindow(tester, shots, 'v4-$scene-${brightness.name}');
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(c.flush);
        c.dispose();
        await tester.pump(const Duration(seconds: 5));
      });
    }
  }
}
