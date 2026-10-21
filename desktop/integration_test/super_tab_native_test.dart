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
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/agent_drag.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import '../test/super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;
import '../test/super_tab_route_test.dart' show routeRow, decision;
import '../test/support/super_tab_fixture.dart'
    show projectFixture, conversationFixture;

/// A real Flutter/macOS surface with in-memory accounts and native protocol
/// fixtures. It never opens a production daemon, account, harness or database.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized()
    ..framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  testWidgets(
    'native Swarm keeps group context, people and terminal in one workspace',
    (tester) async {
      debugPrint('Swarm fixture: initialize window');
      await windowManager.ensureInitialized().timeout(
        const Duration(seconds: 10),
      );
      await windowManager
          .setSize(const Size(1280, 800))
          .timeout(const Duration(seconds: 10));
      await windowManager.show().timeout(const Duration(seconds: 10));
      await windowManager.focus().timeout(const Duration(seconds: 10));
      debugPrint('Swarm fixture: create lead');
      final f = SuperTabLaunchFixture();
      f.connection.nativeName = 'hi';
      f.connection.nativeSurface = true;
      f.app.machineStates['m']!
        ..terminalCapabilityAvailable = true
        // The fixture serves a local daemon's protocol. A local machine with
        // no endpoint means offline to PaneGrid, even when its registry is set.
        ..localEndpoint = LocalCliEndpoint(
          computerId: 'fixture',
          machineId: 'm',
          wsUri: Uri.parse('ws://fixture.invalid'),
          protocolVersion: 1,
          terminalProtocolVersion: 3,
        );
      await tester.runAsync(() async {
        final box = await f.box(engine: 'claude');
        expect(
          await box.create().timeout(const Duration(seconds: 20)),
          NewHarnessOutcome.created,
          reason: box.error,
        );
      });
      debugPrint('Swarm fixture: show conversation');
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      final server = f.connection.server;
      server.state['name'] = 'Company';
      for (final agent in server.state['agents'] as List) {
        agent['displayName'] = agent['id'] == 'lead-agent' ? 'Atlas' : 'Sage';
      }
      server.state['projects'] = [
        projectFixture('lead', 'Lamp OS', 'lead'),
        projectFixture(
          'design',
          'Design',
          'design-lead',
          visibility: 'private',
        ),
      ];
      (server.state['conversations'] as List)[1]['number'] = 12;
      (server.state['conversations'] as List).add({
        ...conversationFixture('design-lead', 'Lead'),
        'projectId': 'design',
      });
      server.state['machines'] = [
        {
          'machineId': 'm',
          'name': 'Studio Mac',
          'contributorId': 'owner',
          'cwd': '/fixture/project',
          'engines': ['claude', 'codex'],
          'maxAgents': 4,
          'paused': false,
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'resources': {
              'deviceType': 'Mac Studio',
              'chip': 'Apple M2 Max',
              'os': 'macOS',
              'cpuPercent': 14,
              'gpuPercent': 2,
              'memoryTotalBytes': 64000000000,
              'memoryUsedBytes': 41600000000,
              'diskTotalBytes': 1000000000000,
              'diskFreeBytes': 130000000000,
              'projectDiskTotalBytes': 1000000000000,
              'projectDiskFreeBytes': 130000000000,
            },
            'quotas': [
              for (final engine in ['claude', 'codex'])
                {
                  'engine': engine,
                  'known': true,
                  'windows': [
                    {
                      'name': '5-hour',
                      'usedPercent': engine == 'claude' ? 50 : 12,
                      'resetsAt': DateTime.now()
                          .add(const Duration(hours: 2))
                          .millisecondsSinceEpoch,
                    },
                  ],
                },
            ],
            'runningHarnessIds': [f.connection.native!['id']],
          },
        },
      ];
      (server.state['conversations'] as List)[0]['agentIds'] = ['lead-agent'];
      (server.state['conversations'] as List)[0]['leadId'] = 'lead-agent';
      (server.state['people'] as List).addAll(
        List.generate(
          2,
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
        'displayName': 'Atlas',
      };
      server.append(
        'Keep changes on the device and sync when the connection returns.',
      );
      server.append('Routed to Multiply');
      server.messages.last['source'] = routeRow()['source'];
      server.routeDecisions['d1'] = decision();
      debugPrint('Swarm fixture: load conversation controller');
      final c = await tester.runAsync(() async {
        final controller = await f.app.superTabs
            .open(tabId)
            .timeout(const Duration(seconds: 10));
        debugPrint('Swarm fixture: refresh conversation');
        await controller.refresh().timeout(const Duration(seconds: 10));
        controller.toggleProject('lead');
        return controller;
      });
      expect(c, isNotNull);
      debugPrint(
        'Swarm fixture: render first frame '
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
                  onNewProject: () {},
                ),
              ),
            ),
          ),
        ),
      );
      debugPrint('Swarm fixture: first frame painted');
      await tester.pumpAndSettle(
        const Duration(milliseconds: 100),
        EnginePhase.sendSemanticsUpdate,
        const Duration(seconds: 10),
      );
      debugPrint('Swarm fixture: conversation settled');
      expect(find.byTooltip('Invite people'), findsOneWidget);
      expect(find.text('CHATS'), findsNothing);
      expect(find.text('New group'), findsNothing);
      expect(find.text('New project'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('super-project-expand-design')),
      );
      await tester.pumpAndSettle();
      expect(c!.selectedId, 'design-lead');
      expect(c.expandedProjects.contains('design'), isFalse);
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      await tester.tap(find.byKey(const ValueKey('super-your-devices')));
      await tester.pumpAndSettle();
      expect(f.app.takeMachinesRequest(), (devicePub: null, phones: false));
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
      expect(
        tester.getTopLeft(find.text('Routed to Multiply')).dx,
        tester.getTopLeft(find.byType(SuperTabMessageText).first).dx,
      );
      expect(find.text('Change'), findsNothing);
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      expect(find.text('schema change, high risk'), findsOneWidget);
      await shot('routing-details');
      await tester.tap(find.text('Hide details'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Project options'));
      await tester.pumpAndSettle();
      await shot('project-menu');
      await tester.tap(find.text('Update cadence'));
      await tester.pumpAndSettle();
      await shot('project-cadence');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(ValueKey('super-member-${c.snapshot!.agents.single.id}')),
      );
      debugPrint('Swarm fixture: terminal requested');
      for (var i = 0; i < 30 && f.app.activeSwarm.panes.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(f.app.activeSwarm.panes, hasLength(1));
      final machine = f.app.machineStates['m']!;
      debugPrint(
        'Swarm fixture: native prerequisites '
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
      debugPrint('Swarm fixture: terminal ready');
      await shot('terminal');
      expect(find.byType(PaneGrid), findsOneWidget);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('terminal-pane-title')))
            .data,
        'Atlas',
      );
      var reviews = 0;
      f.app.reviewSessionClose = (_, {tabName, canStop}) async {
        reviews++;
        return false;
      };
      expect(find.byType(PaneCloseButton), findsNothing);
      await f.app.requestClosePane(f.app.activeSwarm.panes.single.id);
      await tester.pump(const Duration(milliseconds: 100));
      expect(f.app.activeSwarm.panes, hasLength(1));
      expect(c.terminalAgent('lead'), isNotNull);
      expect(reviews, 0);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_close'),
        isEmpty,
      );
      await tester.tap(find.byTooltip('Chat'));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.byTooltip('Add machine'));
      await tester.pumpAndSettle();
      expect(find.text('Choose project folder'), findsNothing);
      expect(find.text('Maximum agents at once'), findsNothing);
      await shot('add-machine');
      Navigator.of(tester.element(find.byType(AlertDialog))).pop();
      await tester.pumpAndSettle();
      // Navigation preserves a stopped member. Only an explicit Resume may
      // reopen its exact saved conversation before preparing recording.
      f.connection.native = {
        ...f.connection.native!,
        'status': 'stopped',
        'sessionId': 'saved-native-conversation',
        'terminal': {'available': false},
      };
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      await tester.tap(
        find.byKey(ValueKey('super-member-${c.snapshot!.agents.single.id}')),
      );
      for (var i = 0; i < 40 && find.text('Resume').evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_resume'),
        isEmpty,
      );
      expect(find.text('Resume'), findsOneWidget);
      await tester.tap(find.text('Resume'));
      for (
        var i = 0;
        i < 120 &&
            (f.app.activeSwarm.panes.isEmpty ||
                f.app.stateOf('m')!.agents.single.isStopped ||
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
      final group = (server.state['conversations'] as List)[1] as Map;
      group['number'] = 1;
      group['agentIds'] = ['lead-agent', 'worker-a', 'worker-b', 'worker-c'];
      group['leadId'] = 'lead-agent';
      for (final name in ['a', 'b', 'c']) {
        (server.state['agents'] as List).add({
          'id': 'worker-$name',
          'name': 'Builder $name',
          'machineId': 'm',
          'harnessId': 'native-$name',
          'contributorId': 'owner',
          'configuration': {'engine': name == 'b' ? 'pi' : 'codex'},
        });
        f.app.machineStates['m']!.agents.add(
          Agent.fromJson({
            'id': 'native-$name',
            'name': 'Builder $name',
            'engine': name == 'b' ? 'pi' : 'codex',
            'status': 'stopped',
            'terminal': {'available': false},
          }),
        );
      }
      await c.refresh();
      c.select('offline');
      c.selectGroupTerminals('offline');
      for (var i = 0; i < 120 && f.app.activeSwarm.panes.length != 4; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      await tester.pump(const Duration(milliseconds: 200));
      expect(f.app.activeSwarm.panes, hasLength(4));
      expect(find.byType(PaneCloseButton), findsNothing);
      expect(find.text('#1 Offline editing'), findsWidgets);
      expect(tester.takeException(), isNull);
      await shot('group-terminals');

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
