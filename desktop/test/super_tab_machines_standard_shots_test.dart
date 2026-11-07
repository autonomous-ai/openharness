// Task #3801 (Scholes, 11-06): the Machines screen grouped by status, your own pinned, light and dark, for the PR's
// pictures. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/machines.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

Map<String, dynamic> _machine(
  String id,
  String name,
  String owner,
  Duration seen,
) => {
  'machineId': id,
  'name': name,
  'contributorId': owner,
  'observation': {
    'receivedAt': DateTime.now().millisecondsSinceEpoch - seen.inMilliseconds,
    'resources': {
      'cpuPercent': 18,
      'memoryTotalBytes': 32000000000,
      'memoryUsedBytes': 12000000000,
      'diskTotalBytes': 1000000000000,
      'diskFreeBytes': 420000000000,
    },
  },
};

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('Machines grouped in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(840, 1000);
      addTearDown(tester.view.reset);
      final server = ConversationServer();
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      server.state['machines'] = [
        _machine('mine', 'My MacBook Pro', 'owner', Duration.zero),
        _machine('build', 'Build Box', 'peer', Duration.zero),
        _machine('studio', 'Studio Mac', 'peer', const Duration(seconds: 5)),
        _machine('old', 'Old Linux', 'peer', const Duration(hours: 3)),
      ];
      final c = server.controller();
      await tester.runAsync(c.refresh);
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        c.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await captureWindow(tester, shots, 'machines-grouped-${brightness.name}');
    });
  }
}
