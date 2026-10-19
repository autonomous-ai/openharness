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
import 'package:harness/widgets/agent_drag.dart';
import 'package:harness/widgets/terminal_panel.dart';

import '../test/super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;

/// A real Flutter/macOS surface with in-memory accounts and native protocol
/// fixtures. It never opens a production daemon, account, harness or database.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized()
    ..framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
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
      f.connection.nativeName = 'hi';
      f.connection.nativeSurface = true;
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
      debugPrint(
        'Super Tab fixture: render first frame '
        '(lifecycle=${binding.lifecycleState}, '
        'framesEnabled=${binding.framesEnabled}, '
        'visible=${await windowManager.isVisible()}, '
        'minimized=${await windowManager.isMinimized()}, '
        'focused=${await windowManager.isFocused()})',
      );
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: ListenableBuilder(
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
      debugPrint('Super Tab fixture: first frame painted');
      await tester.pumpAndSettle(
        const Duration(milliseconds: 100),
        EnginePhase.sendSemanticsUpdate,
        const Duration(seconds: 10),
      );
      debugPrint('Super Tab fixture: conversation settled');
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
      debugPrint('Super Tab fixture: open participants');
      await tester.tap(find.text('1 agent · 20 people'));
      debugPrint('Super Tab fixture: participants tapped');
      await tester.pumpAndSettle();
      debugPrint('Super Tab fixture: participants settled');
      expect(find.text('Lead'), findsWidgets);
      expect(find.text('Open terminal'), findsOneWidget);
      await tester.tap(find.text('Open terminal'));
      debugPrint('Super Tab fixture: terminal requested');
      for (var i = 0; i < 30 && f.app.activeSwarm.panes.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(f.app.activeSwarm.panes, hasLength(1));
      final machine = f.app.machineStates['m']!;
      debugPrint(
        'Super Tab fixture: native prerequisites '
        'online=${machine.nodeOnline} capability=${machine.terminalCapabilityAvailable} '
        'agents=${machine.agents.map((a) => '${a.id}:${a.terminalAvailable}').join(',')} '
        'session=${f.app.activeSwarm.panes.single.session?.status}',
      );
      // A live terminal keeps its cursor animated. Wait for the protocol's
      // readiness, not for the entire window to stop scheduling frames.
      for (
        var i = 0;
        i < 120 && f.app.activeSwarm.panes.single.session?.streamId == null;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(
        f.app.activeSwarm.panes.single.session?.streamId,
        SuperTabFixtureConnection.streamId,
        reason: 'Native terminal did not attach: ${f.connection.terminalCalls}',
      );
      expect(f.app.activeSwarm.panes.single.inputContext, isNotNull);
      await tester.pump(const Duration(milliseconds: 100));
      debugPrint('Super Tab fixture: terminal ready');
      await shot('terminal');
      expect(find.byType(PaneGrid), findsOneWidget);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('terminal-pane-title')))
            .data,
        'Lead',
      );
      var reviews = 0;
      f.app.reviewSessionClose = (_, {tabName, canStop}) async {
        reviews++;
        return false;
      };
      await tester.tap(find.byType(PaneCloseButton));
      await tester.pumpAndSettle();
      expect(f.app.activeSwarm.panes, isEmpty);
      expect(c!.terminalAgent('lead'), isNull);
      expect(find.byType(TerminalPanel), findsNothing);
      expect(reviews, 0);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_close'),
        isEmpty,
      );
      expect(c.snapshot!.agents, hasLength(1));
      await shot('hidden-terminal');
      // An earlier app/daemon may already have cleaned up this member. Reopening
      // must resume its exact saved conversation before preparing recording.
      f.connection.native = {
        ...f.connection.native!,
        'status': 'stopped',
        'sessionId': 'saved-native-conversation',
        'terminal': {'available': false},
      };
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      await tester.tap(find.text('1 agent · 20 people'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Open terminal'));
      for (
        var i = 0;
        i < 120 &&
            (f.app.activeSwarm.panes.isEmpty ||
                f.app.activeSwarm.panes.single.session?.streamId == null);
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(
        f.app.activeSwarm.panes,
        hasLength(1),
        reason:
            'Reopen failed: ${f.connection.calls}\n'
            '${tester.widgetList<Text>(find.byType(Text)).map((text) => text.data).whereType<String>().join("\n")}',
      );
      expect(f.app.activeSwarm.panes.single.agentId, 'native-lead');
      expect(
        f.app.activeSwarm.panes.single.session?.streamId,
        SuperTabFixtureConnection.streamId,
      );
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_create'),
        hasLength(1),
      );
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_resume'),
        hasLength(1),
      );
      expect(
        f.app.stateOf('m')!.agents.single.sessionId,
        'saved-native-conversation',
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(TerminalPanel), findsOneWidget);
      await shot('resumed-terminal');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
