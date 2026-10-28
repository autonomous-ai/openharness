import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's sidebar pictures there.
final shots = Platform.environment['SUPER_TAB_SIDEBAR_SHOTS'];

/// SF Symbols as AppKit draws them (`systemSymbolPng`), `<name>.png` at 2×:
/// what the Mac app's channel answers with.
final symbols = Platform.environment['SUPER_TAB_SIDEBAR_SYMBOLS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('the Swarm sidebar in ${brightness.name}', (tester) async {
      if (shots == null) return;
      if (symbols != null) {
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('harness/system_symbols'),
          (call) async {
            final name = (call.arguments as Map)['name'];
            final file = File('$symbols/$name.png');
            return file.existsSync() ? file.readAsBytesSync() : null;
          },
        );
      }
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2400, 1400);
      addTearDown(tester.view.reset);
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final now = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> machine(
        String id,
        String name,
        String? type, {
        bool online = true,
      }) => {
        'machineId': id,
        'name': name,
        'contributorId': 'owner',
        'observation': {
          'receivedAt': online ? now : now - 3 * 3600 * 1000,
          'resources': {'deviceType': ?type},
        },
      };
      final server = ConversationServer()
        ..tag('message-1')
        ..tag('message-2')
        ..ask(['Ship it behind a flag?']);
      server.state['agents'] = <Object>[];
      server.state['machines'] = [
        machine('studio', 'MACs-Mac-Studio.local', 'Mac Studio'),
        machine('mbp', "Dee's MacBook Pro", 'MacBook Pro'),
        machine('mini', 'Build Mac mini', 'Mac mini', online: false),
        machine('imac', 'Front desk iMac', 'iMac'),
        machine('box', 'WIN-DELL', null),
      ];
      final c = server.controller();
      await c.refresh();
      final picture = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: RepaintBoundary(
            key: picture,
            child: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                onNewProject: () {},
                machineName: (_) => 'Team Mac',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // Decode the symbols' pictures, which a widget test does only for real.
      for (final image in tester.widgetList<Image>(find.byType(Image))) {
        await tester.runAsync(
          () =>
              precacheImage(image.image, tester.element(find.byType(Scaffold))),
        );
      }
      await tester.pumpAndSettle();
      await captureBoundary(
        tester,
        picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
        shots,
        'sidebar-${brightness.name}',
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}
