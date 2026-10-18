import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';

import '../test/super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// A real Flutter/macOS surface with in-memory accounts and native protocol
/// fixtures. It never opens a production daemon, account, harness or database.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native Super Tab keeps group context, people and terminal in one workspace',
    (tester) async {
      debugPrint('Super Tab fixture: initialize window');
      await windowManager.ensureInitialized().timeout(
        const Duration(seconds: 10),
      );
      await windowManager
          .setSize(const Size(1280, 800))
          .timeout(const Duration(seconds: 10));
      await windowManager.show().timeout(const Duration(seconds: 10));
      await windowManager.focus().timeout(const Duration(seconds: 10));
      debugPrint('Super Tab fixture: create lead');
      final f = SuperTabLaunchFixture();
      f.app.machineStates['m']!.terminalCapabilityAvailable = true;
      await tester.runAsync(() async {
        final box = await f.box(engine: 'claude');
        expect(
          await box.create().timeout(const Duration(seconds: 20)),
          NewHarnessOutcome.created,
          reason: box.error,
        );
      });
      debugPrint('Super Tab fixture: show conversation');
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      final server = f.connection.server;
      server.state['name'] = 'Pilot';
      (server.state['conversations'] as List)[0]['agentIds'] = ['lead-agent'];
      (server.state['conversations'] as List)[0]['leadId'] = 'lead-agent';
      (server.state['people'] as List).addAll(
        List.generate(
          19,
          (i) => {
            'id': 'person-$i',
            'email': 'person$i@example.com',
            'role': 'collaborator',
          },
        ),
      );
      server.append(
        'Let’s agree on the offline editing behavior before building.',
      );
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'lead-agent',
        'name': 'Lead',
      };
      server.append(
        'Keep changes on the device and sync when the connection returns.',
      );
      debugPrint('Super Tab fixture: load conversation controller');
      final c = await tester.runAsync(() async {
        final controller = await f.app.superTabs
            .open(tabId)
            .timeout(const Duration(seconds: 10));
        debugPrint('Super Tab fixture: refresh conversation');
        await controller.refresh().timeout(const Duration(seconds: 10));
        return controller;
      });
      expect(c, isNotNull);
      debugPrint('Super Tab fixture: render first frame');
      final boundary = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: RepaintBoundary(
              key: boundary,
              child: ListenableBuilder(
                listenable: f.app,
                builder: (context, _) => SuperTabWorkspace(
                  app: f.app,
                  canvas: PaneGrid(notifier: f.app, swarmMode: true),
                  onAddAgent: (_) {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('1 agent · 20 people'), findsOneWidget);
      expect(find.text('CHATS'), findsNothing);
      expect(find.text('New group'), findsOneWidget);
      expect(find.text('Invite'), findsOneWidget);
      final folder = Platform.environment['SUPER_TAB_NATIVE_SHOTS'];
      Future<void> shot(String name) async {
        if (folder == null) return;
        final render =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await render.toImage(pixelRatio: 1);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(folder).create(recursive: true);
        await File('$folder/$name.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      }

      await shot('conversation');
      await tester.tap(find.text('1 agent · 20 people'));
      await tester.pumpAndSettle();
      expect(find.text('Lead'), findsWidgets);
      expect(find.text('Open terminal'), findsOneWidget);
      await tester.tap(find.text('Open terminal'));
      for (var i = 0; i < 30 && f.app.activeSwarm.panes.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(f.app.activeSwarm.panes, hasLength(1));
      await tester.pumpAndSettle();
      await shot('terminal');
      expect(find.byType(PaneGrid), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await c!.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
