// Task #3801 (Scholes, 11-06): the Machines screen grouped by status, your own pinned, light and dark, for the PR's
// pictures. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;

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
  setUpAll(() async {
    await loadCaptureFonts(shots);
    const mono = '/System/Library/Fonts/SFNSMono.ttf';
    if (shots != null && Platform.isMacOS && File(mono).existsSync()) {
      final bytes = ByteData.sublistView(await File(mono).readAsBytes());
      await (FontLoader(
        grid.AppType.monoFamily,
      )..addFont(Future.value(bytes))).load();
    }
  });

  for (final brightness in Brightness.values) {
    testWidgets('Machines grouped in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(1920, 1640);
      addTearDown(tester.view.reset);
      final fixture = SuperTabLaunchFixture();
      fixture.app.machineStates['mine'] = fixture.app.machineStates['m']!;
      fixture.app.machineStates['mine']!.localEndpoint = LocalCliEndpoint(
        computerId: 'capture-machine',
        wsUri: Uri.parse('ws://127.0.0.1:18473'),
        protocolVersion: 1,
        terminalProtocolVersion: 1,
      );
      fixture.app.machineStates['mine']!.machine = fixture
          .app
          .machineStates['mine']!
          .machine
          .copyWith(name: 'scholes-mbp-14');
      final server = ConversationServer();
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'username': 'dee',
        'role': 'collaborator',
      });
      (server.state['people'] as List).first['username'] = 'scholes';
      server.state['machines'] = [
        _machine('mine', 'scholes-mbp-14', 'owner', Duration.zero),
        _machine('leo', 'Leo-MacBook-Pro', 'peer', Duration.zero),
        _machine('build', 'Mac 3', 'peer', Duration.zero),
        _machine('darren', 'Darren-MacBook', 'peer', Duration.zero),
        _machine('td', 'MacBook-Pro-TD', 'peer', Duration.zero),
        _machine('huy', 'MacBookPro2021', 'peer', Duration.zero),
        _machine('vie', 'vie-macbook-air', 'peer', Duration.zero),
        _machine('gray', 'Gray-MacBook-Air', 'peer', Duration.zero),
        _machine('old', "Diego's Mac", 'peer', const Duration(seconds: 25)),
      ];
      server.state['agents'] = [
        for (final (id, count) in [
          ('mine', 1),
          ('leo', 3),
          ('build', 17),
          ('darren', 1),
          ('td', 1),
          ('huy', 1),
          ('vie', 1),
          ('gray', 1),
          ('old', 1),
        ])
          for (var i = 0; i < count; i++)
            {
              'id': '$id-$i',
              'name': 'Engineer $i',
              'machineId': id,
              'harnessId': 'native-$id-$i',
              'contributorId': 'owner',
              'configuration': {'engine': 'codex'},
              'crew': {'role': 'Engineer', 'lane': 'desktop'},
            },
      ];
      final c = server.controller();
      await tester.runAsync(c.refresh);
      addTearDown(() async {
        c.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          debugShowCheckedModeBanner: false,
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              app: fixture.app,
              onAddAgent: (_) {},
              manage: true,
              ticks: false,
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await captureWindow(tester, shots, 'machines-grouped-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      fixture.dispose();
    });
  }
}
