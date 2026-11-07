// Task #3122 (Scholes, 11-05): a computer moved from kelvin's account, for the pull request's pictures. Writes nothing
// unless COMPUTER_MOVE_SHOTS names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/machines.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

final shots = Platform.environment['COMPUTER_MOVE_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('a moved computer\'s row in ${brightness.name}', (
      tester,
    ) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(1240, 520);
      addTearDown(tester.view.reset);
      final app = createApp(connected: true);
      app.machineStates['m']!.localOnly = true;
      final server = ConversationServer();
      (server.state['people'] as List).add({
        'id': 'kelvin',
        'email': 'kelvin@example.com',
        'username': 'kelvin',
        'role': 'collaborator',
      });
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'MacBooks-MacBook-Pro-7',
          'contributorId': 'owner',
          'scope': 'swarm',
          'cwd': '/swarm',
          'engines': ['claude', 'codex'],
          'maxAgents': 4,
          'paused': false,
          'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
          'teamWork': {
            'allowed': false,
            'code': 'TEAM_ACCOUNT_REQUIRED',
            'reason': 'Refused.',
          },
          'previousOwner': {
            'personId': 'kelvin',
            'until': DateTime(
              DateTime.now().year,
              11,
              5,
              12,
            ).toUtc().toIso8601String(),
          },
        },
      ];
      final c = server.controller(account: 'owner');
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(brightness: brightness),
          home: Scaffold(
            body: SuperTabMachines(controller: c, app: app, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'computer-move-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
      app.dispose();
    });
  }
}
