import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/machines.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_MACHINE_CREW_SHOTS'];

/// Manage → Machines as task #3412 draws it, in both appearances: a machine with
/// four crew members (two asleep, one moving) and its details open, beside a
/// machine without crew, whose row is as before. Memory store, no sign-in.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  Map<String, dynamic> pool(String id, String name, double diskFree) => {
    'machineId': id,
    'name': name,
    'contributorId': 'owner',
    'scope': 'swarm',
    'cwd': '/swarm',
    'engines': ['claude', 'codex'],
    'maxAgents': 6,
    'paused': false,
    'observation': {
      'receivedAt': DateTime.now().millisecondsSinceEpoch,
      'resources': {
        'cpuPercent': 18,
        'memoryTotalBytes': 64e9,
        'memoryUsedBytes': 22e9,
        'diskFreeBytes': diskFree,
        'diskTotalBytes': 1000e9,
        'deviceType': 'Desktop',
      },
    },
    'teamWork': {'allowed': true},
  };
  int hoursAgo(num hours) => DateTime.now()
      .subtract(Duration(minutes: (hours * 60).round()))
      .millisecondsSinceEpoch;
  Map<String, dynamic> agent(
    String id,
    String name, {
    bool crew = true,
    String machineId = 'mac3',
    Object? asleep,
    Object? movedTo,
  }) => {
    'id': id,
    'projectId': 'lead',
    'name': name,
    'displayName': name,
    'machineId': machineId,
    'harnessId': 'h-$id',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude', 'model': 'opus'},
    if (crew) 'crew': {'role': 'Engineer', 'at': 1, 'by': 'owner'},
    'asleep': ?asleep,
    'movedTo': ?movedTo,
  };

  for (final brightness in Brightness.values) {
    testWidgets('screenshot machine crew (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer();
      server.state['machines'] = [
        pool('mac3', 'Mac 3', 42e9),
        pool('studio', 'Mac Studio', 310e9),
      ];
      (server.state['agents'] as List).addAll([
        agent('a1', 'TestKeep', asleep: {'since': hoursAgo(5.4)}),
        agent('a2', 'Keeper'),
        agent('a3', 'Heron', movedTo: {'machineId': 'studio'}),
        agent('a4', 'Sorrel', asleep: {'since': hoursAgo(1.2)}),
        agent('a5', 'Engineer 9', crew: false),
        agent('a6', 'Reviewer 2', crew: false, machineId: 'studio'),
      ]);
      final c = server.controller(account: 'owner');
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(720, 760));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              manage: true,
              onAddAgent: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-machine-mac3')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-machine-crew-mac3')),
        findsOneWidget,
      );
      await tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 2);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/machine-crew-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}
