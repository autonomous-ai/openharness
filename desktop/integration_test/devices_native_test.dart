import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/devices/devices_screen.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import '../test/keymap_runtime_test.dart' show native;
import '../tool/devices_preview.dart';

void main() {
  if (!kUnderTest) throw StateError('Use FLUTTER_TEST=1 with this fixture.');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1440, 1040));
    await windowManager.show();
    await windowManager.focus();
  });
  testWidgets(
    'Devices opens its native DSH, routes remote edits, and hides unreachable devices',
    (tester) async {
      final app = DevicesReviewApp();
      await app.prepare();
      final projects = SwarmProjectStore();
      final boundary = GlobalKey();
      Future<void> mount(
        Brightness brightness, {
        DevicesReviewApp? notifier,
      }) async {
        grid.AppTheme.palette.value = brightness == Brightness.light
            ? HarnessPalette.paper
            : HarnessPalette.graphite;
        grid.AppTheme.brightness.value = brightness;
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (_, child) => grid.BrightnessScope(child: child!),
              home: SwarmScreen(
                notifier: notifier ?? app,
                nativeTabs: true,
                projectStore: projects,
              ),
            ),
          ),
        );
        final context = tester.element(find.byType(DevicesScreen));
        for (final art in ['front', 'side', 'desk']) {
          await precacheImage(
            AssetImage('assets/devices/harness-$art.webp'),
            context,
          );
        }
        await tester.pumpAndSettle();
      }

      Future<void> capture(String name) async {
        final directory = Platform.environment['HARNESS_DEVICES_CAPTURE_DIR'];
        if (directory == null) return;
        await tester.pump(const Duration(milliseconds: 120));
        final image =
            await (boundary.currentContext!.findRenderObject()
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 1);
        try {
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(directory).create(recursive: true);
          await File('$directory/$name.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
        } finally {
          image.dispose();
        }
      }

      await mount(Brightness.light);
      await native(tester, 'devices');
      await tester.pumpAndSettle();
      expect(app.activeSwarm.panes.where((p) => p.isDevices), hasLength(1));
      expect(
        app.activeSwarm.panes.where((p) => p.agentId == 'review-devices'),
        hasLength(1),
      );
      final controller = tester
          .widget<DevicesScreen>(find.byType(DevicesScreen))
          .controller;
      expect(controller.devices, hasLength(5));
      expect(controller.devices.map((d) => d.machineId).toSet(), hasLength(3));
      await capture('light-devices-dsh');
      final remote = controller.devices.firstWhere(
        (d) => d.machineId == 'office-mac',
      );
      final remoteCard = find.byKey(ValueKey('device-card-${remote.key}'));
      await tester.ensureVisible(remoteCard);
      await tester.tap(remoteCard);
      await tester.pumpAndSettle();
      final sound = find.byKey(ValueKey('devices-sound-${remote.key}'));
      await tester.ensureVisible(sound);
      await tester.tap(sound);
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(app.writes.single.$1, 'office-mac');
      expect(app.writes.single.$2, remote.status.id);
      expect(controller.device(remote.key)!.status.settings!.muted, isFalse);
      expect(controller.saving(remote.key), isFalse);
      final offline = controller.devices.firstWhere(
        (d) => d.machineId == 'workshop-pc',
      );
      final offlineCard = find.byKey(ValueKey('device-card-${offline.key}'));
      expect(offlineCard, findsNothing);
      expect(controller.device(offline.key)!.canEdit, isFalse);
      expect(controller.device(offline.key)!.status.settings, isNotNull);
      await mount(Brightness.dark);
      await tester.ensureVisible(find.byKey(const Key('devices-add')));
      await tester.pumpAndSettle();
      await capture('dark-devices-dsh');
      await app.experimentalFeatures.set(ExperimentalFeature.devicesTab, false);
      await tester.pumpAndSettle();
      await native(tester, 'devices');
      expect(app.swarms.any((tab) => tab.isDevices), isFalse);
      expect(find.byType(DevicesScreen), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      final waiting = DevicesReviewApp();
      await waiting.prepare(conversationReady: false);
      await mount(Brightness.dark, notifier: waiting);
      expect(find.text('Devices chat'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('devices-conversation-setup')),
        findsOneWidget,
      );
      final left = tester.getRect(
        find.byKey(ValueKey('pane-frame:${waiting.panes.first.id}')),
      );
      final right = tester.getRect(
        find.byKey(ValueKey('pane-frame:${waiting.panes.last.id}')),
      );
      expect(left.right, lessThan(right.left));
      expect(left.width / (left.width + right.width), closeTo(.7, .01));
      await capture('dark-devices-chat-unavailable');
      await mount(Brightness.light, notifier: waiting);
      await capture('light-devices-chat-unavailable');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      waiting.dispose();
      projects.dispose();
    },
  );
}
