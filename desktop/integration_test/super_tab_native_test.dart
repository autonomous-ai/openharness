import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:window_manager/window_manager.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/core/models.dart';
import 'package:harness/devices/devices_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/agent_drag.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import '../test/super_tab_launch_test.dart'
    show SuperTabFixtureConnection, tabId;
import '../test/support/super_tab_devices_fixture.dart';
import '../test/super_tab_route_test.dart' show routeRow, decision;
import '../test/support/super_tab_fixture.dart'
    show projectFixture, conversationFixture;
import 'flutter_test_config.dart';

/// A real Flutter/macOS surface with in-memory accounts and native protocol
/// fixtures. It never opens a production daemon, account, harness or database.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  final binding = ensureNativeTestBinding()
    ..framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  testWidgets(
    'native Swarm keeps group context, people and terminal in one workspace',
    (tester) async {
      // FLUTTER_TEST makes Flutter's debug default Android, even on a real
      // macOS window. This native fixture must exercise the desktop guard.
      expect(defaultTargetPlatform, TargetPlatform.macOS);
      final semantics = binding.ensureSemantics();
      var semanticsDisposed = false;
      void disposeSemantics() {
        if (semanticsDisposed) return;
        semanticsDisposed = true;
        semantics.dispose();
      }

      addTearDown(disposeSemantics);
      debugPrint('Swarm fixture: initialize window');
      await windowManager.ensureInitialized().timeout(
        const Duration(seconds: 10),
      );
      await windowManager
          .setSize(const Size(1280, 800))
          .timeout(const Duration(seconds: 10));
      await windowManager.setTitle('Swarm review — test data');
      // macOS stops delivering frames to a fully occluded native test window.
      // Keep only this isolated fixture above other running Harness builds.
      await windowManager.setAlwaysOnTop(true);
      addTearDown(() => windowManager.setAlwaysOnTop(false));
      await windowManager.show().timeout(const Duration(seconds: 10));
      await windowManager.focus().timeout(const Duration(seconds: 10));
      debugPrint('Swarm fixture: create lead');
      final f = superTabDevicesFixture();
      (f.connection as SuperTabDevicesConnection).hasDevice = true;
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
      // A workgroup under Lamp OS, so the sidebar's tree shows a second level.
      (server.state['conversations'] as List).add({
        ...conversationFixture('polish', 'Sidebar polish'),
        'projectId': 'lead',
        'number': 20,
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
        // A second Studio Mac, owned by someone else, and one long offline, under its
        // closed "Offline · 1".
        {
          'machineId': 'm-twin',
          'name': 'Studio Mac',
          'contributorId': 'person-0',
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'resources': {'cpuPercent': 40},
          },
        },
        // A Codex-only machine: its Claude slot stays blank, so its Codex % lines up with the others'.
        {
          'machineId': 'm-codex',
          'name': 'Build Box',
          'contributorId': 'person-1',
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'quotas': [
              {
                'engine': 'codex',
                'known': true,
                'windows': [
                  {'name': '5-hour', 'usedPercent': 30},
                ],
              },
            ],
          },
        },
        {
          'machineId': 'm-old',
          'name': 'Old Mini',
          'contributorId': 'person-1',
          'observation': {
            'receivedAt': DateTime.now()
                .subtract(const Duration(minutes: 20))
                .millisecondsSinceEpoch,
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
      };
      server.append(
        'Keep changes on the device and sync when the connection returns.',
      );
      final instruction = server.messages.last;
      final deliveredAt = DateTime.now().subtract(const Duration(seconds: 42));
      instruction['deliveries'] = [
        // Typed loosely: the test advances this row through hold, uncertain and answered below.
        <String, Object?>{
          'id': 'native-receipt',
          'agentId': 'lead-agent',
          'status': 'delivered',
          'deliveredAt': deliveredAt.toIso8601String(),
        },
      ];
      server.append('Routed to Multiply');
      server.messages.last['source'] = routeRow()['source'];
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'lead-agent',
        'name': 'Lead',
      };
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
                  canvas: PaneGrid(
                    notifier: f.app,
                    swarmMode: true,
                    devicesViewer: (_) => DevicesTab(notifier: f.app),
                  ),
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

      expect(find.byTooltip('Invite people'), findsOneWidget);
      expect(find.text('CHATS'), findsNothing);
      expect(find.text('New group'), findsNothing);
      expect(find.byTooltip('New project'), findsOneWidget);
      expect(find.byKey(const ValueKey('super-new-project')), findsOneWidget);
      for (final id in ['m', 'm-twin', 'm-old']) {
        expect(find.byKey(ValueKey('super-machine-$id')), findsOneWidget);
      }
      expect(find.text('Offline · 1'), findsNothing);
      await shot('sidebar-groups');
      await tester.tap(find.byKey(const ValueKey('super-machine-toggle-m')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-machine-allowance-m-claude')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('super-machine-allowance-m-codex')),
        findsOneWidget,
      );
      final leadWasOpen = c!.expandedProjects.contains('lead');
      if (!leadWasOpen) {
        await tester.tap(
          find.byKey(const ValueKey('super-project-expand-lead')),
        );
      }
      await tester.pumpAndSettle();
      expect(find.text('#20 Sidebar polish'), findsOneWidget);
      double textX(String row, String label) => tester
          .getTopLeft(
            find.descendant(
              of: find.byKey(ValueKey(row)),
              matching: find.text(label),
            ),
          )
          .dx;
      expect(
        textX('super-group-polish', '#20 Sidebar polish'),
        closeTo(textX('super-group-lead', 'Lamp OS'), .01),
      );
      await shot('sidebar-tree');
      // Clicking the label itself collapses the whole section.
      await tester.tap(find.text('Machines'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-machine-m')), findsNothing);
      await tester.tap(find.text('Machines'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-machine-m')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('super-machine-toggle-m')));
      if (!leadWasOpen) {
        await tester.tap(
          find.byKey(const ValueKey('super-project-expand-lead')),
        );
      }
      await tester.pumpAndSettle();
      debugPrint('Swarm fixture: empty project disclosure');
      await tester.tap(
        find.byKey(const ValueKey('super-project-expand-design')),
      );
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      expect(c.expandedProjects.contains('design'), isTrue);
      expect(find.text('No workgroups yet'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      final swarmId = f.app.activeSwarmId;
      debugPrint('Swarm fixture: open Devices');
      await tester.tap(find.byKey(const ValueKey('super-your-devices')));
      // Attachment is scheduled after the navigation frame. Wait for the
      // actual viewer, rather than assuming a single native pump mounted it.
      for (
        var i = 0;
        i < 60 && find.byType(DevicesScreen).evaluate().isEmpty;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      debugPrint('Swarm fixture: Devices frame painted');
      expect(f.app.activeSwarm.isSuperTab, isTrue);
      expect(f.app.activeSwarmId, swarmId);
      expect(c.devicesSelected, isTrue);
      expect(f.app.activeSwarm.panes, hasLength(1));
      expect(f.app.activeSwarm.panes.single.isDevices, isTrue);
      expect(find.text('Devices chat'), findsNothing);
      expect(f.app.takeMachinesRequest(), isNull);
      expect(find.byType(DevicesScreen), findsOneWidget);
      for (
        var i = 0;
        i < 60 && find.text('Brightness').evaluate().isEmpty;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(find.text('Brightness'), findsOneWidget);
      await shot('embedded-devices');
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pumpAndSettle();
      debugPrint('Swarm fixture: returned from Devices');
      await shot('conversation');
      expect(find.textContaining('Delivered '), findsOneWidget);
      expect(find.text('Queued'), findsNothing);
      final receipt =
          (instruction['deliveries'] as List).single as Map<String, Object?>;
      receipt.addAll({
        'status': 'claimed',
        'holdReason': 'team_waiting_idle',
        'holdSince': DateTime.now()
            .subtract(const Duration(seconds: 34))
            .toIso8601String(),
      });
      await c.refresh();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Sent'), findsOneWidget);
      expect(find.textContaining('Atlas is busy'), findsNothing);
      expect(find.textContaining('by itself'), findsNothing);
      await shot('receipt-held');
      receipt['status'] = 'uncertain';
      await c.refresh();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      for (final label in ['Open terminal', 'Send again', 'It arrived']) {
        expect(find.text(label), findsOneWidget);
      }
      await shot('receipt-uncertain');
      receipt.addAll({
        'status': 'answered',
        'deliveredAt': deliveredAt.toIso8601String(),
        'answeredAt': deliveredAt
            .add(const Duration(seconds: 72))
            .toIso8601String(),
      });
      await c.refresh();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Replied · 1m 12s'), findsOneWidget);
      await shot('receipt-replied');
      debugPrint('Swarm fixture: collapse both left sidebar groups');
      await tester.tap(find.byTooltip('Collapse Projects'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Collapse Machines'));
      await tester.pumpAndSettle();
      expect(find.text('Design'), findsNothing);
      expect(find.textContaining('Studio Mac'), findsNothing);
      await shot('sidebar-collapsed');
      await tester.tap(find.byTooltip('Expand Projects'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Expand Machines'));
      await tester.pumpAndSettle();
      expect(find.text('Lead'), findsNothing);
      expect(find.text('Atlas'), findsNWidgets(2));
      expect(find.text('Available capacity'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('super-machine-m')));
      await tester.pumpAndSettle();
      expect(find.text('Available capacity'), findsOneWidget);
      expect(find.text('CPU'), findsOneWidget);
      expect(find.text('86%'), findsOneWidget);
      await shot('machine-details');
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
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
      await tester.pump(const Duration(milliseconds: 250));
      await tester.tap(find.text('Open terminal'));
      debugPrint('Swarm fixture: terminal requested');
      for (var i = 0; i < 30 && f.app.activeSwarm.panes.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      await shot('terminal-requested');
      expect(
        f.app.activeSwarm.panes,
        hasLength(1),
        reason:
            'Selected ${c.selectedId}; Devices ${c.devicesSelected}; '
            'terminals ${c.terminalAgents(c.selectedId).map((a) => a.id).toList()}; '
            'groups ${c.snapshot!.conversations.map((g) => '${g.id}:${g.agentIds}').toList()}; '
            'visible ${tester.widgetList<Text>(find.byType(Text)).map((t) => t.data).whereType<String>().join(" | ")}',
      );
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
      final liveSession = f.app.activeSwarm.panes.single.session;
      final nativePanel = tester.element(find.byType(TerminalPanel));
      final initialMiddle = tester
          .getSize(find.byKey(const ValueKey('super-center-pane')))
          .width;
      await tester.drag(
        find.byKey(const ValueKey('super-resize-left')),
        const Offset(30, 0),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await tester.drag(
        find.byKey(const ValueKey('super-resize-right')),
        const Offset(-30, 0),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        tester.getSize(find.byKey(const ValueKey('super-center-pane'))).width,
        closeTo(initialMiddle - 60, 1),
      );
      expect(f.app.activeSwarm.panes.single.session, same(liveSession));
      expect(tester.element(find.byType(TerminalPanel)), same(nativePanel));
      expect(
        f.app.activeSwarm.panes.single.session?.streamId,
        SuperTabFixtureConnection.streamId,
      );
      await shot('terminal-resized');
      final focusRequest = f.app.paneFocusRequest;
      final divider = find.byKey(const ValueKey('super-resize-right'));
      final resizeFocus = tester
          .widget<Focus>(
            find.descendant(of: divider, matching: find.byType(Focus)),
          )
          .focusNode!;
      resizeFocus.requestFocus();
      await tester.pump(const Duration(milliseconds: 50));
      FocusManager.instance.applyFocusChangesIfNeeded();
      expect(
        resizeFocus.hasPrimaryFocus,
        isTrue,
        reason:
            'Keyboard resize needs focus before Escape: '
            '${FocusManager.instance.primaryFocus}',
      );
      // A native window also receives the reviewer's physical modifier keys.
      // Keep this synthetic Escape assertion independent of that host input.
      final keyboard = HardwareKeyboard.instance;
      for (final physical in keyboard.physicalKeysPressed.toList()) {
        final logical = keyboard.lookUpLayout(physical);
        if (logical != null) {
          await tester.sendKeyUpEvent(logical, physicalKey: physical);
        }
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        f.app.paneFocusRequest,
        focusRequest + 1,
        reason:
            'Focus after Escape: ${FocusManager.instance.primaryFocus}; '
            'pressed keys: ${HardwareKeyboard.instance.logicalKeysPressed}; '
            'focused pane: ${f.app.focusedPaneId}',
      );
      expect(f.app.activeSwarm.panes.single.session, same(liveSession));
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
      await tester.pump(const Duration(milliseconds: 250));
      await tester.tap(find.text('Open terminal'));
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
      await tester.tap(find.byKey(const ValueKey('super-member-lead-agent')));
      await tester.pump(const Duration(milliseconds: 250));
      await tester.tap(find.text('Open terminal'));
      await tester.pump(const Duration(milliseconds: 200));
      expect(
        find.byKey(const ValueKey('super-agent-group-open')),
        findsOneWidget,
      );
      await shot('agent-workgroups');
      await tester.tap(find.byKey(const ValueKey('super-agent-group-cancel')));
      await tester.pump(const Duration(milliseconds: 200));
      expect(c.selectedId, 'offline');

      // Optional manual inspection of this same isolated native fixture. The
      // file is supplied by the reviewer; no production account or daemon is
      // connected, and the automated acceptance above has already completed.
      final reviewDone =
          const String.fromEnvironment('SUPER_TAB_NATIVE_REVIEW_DONE')
              .isNotEmpty
          ? const String.fromEnvironment('SUPER_TAB_NATIVE_REVIEW_DONE')
          : Platform.environment['SUPER_TAB_NATIVE_REVIEW_DONE'];
      if (reviewDone != null) {
        c.select('lead');
        c.selectTerminal('lead', null);
        await tester.pump(const Duration(milliseconds: 200));
        binding.framePolicy =
            LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
        debugPrint('Swarm fixture: ready for manual review');
        await tester.runAsync(() async {
          await File('$reviewDone.ready').writeAsString('ready');
          final deadline = DateTime.now().add(const Duration(minutes: 10));
          while (!await File(reviewDone).exists() &&
              DateTime.now().isBefore(deadline)) {
            await Future<void>.delayed(const Duration(milliseconds: 200));
          }
        });
        binding.framePolicy =
            LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
      }

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
      // Flutter verifies handles before addTearDown runs on the success path.
      disposeSemantics();
    },
    variant: const TargetPlatformVariant({TargetPlatform.macOS}),
    timeout: Timeout(
      Duration(
        minutes:
            Platform.environment['SUPER_TAB_NATIVE_REVIEW_DONE'] != null ||
                const String.fromEnvironment('SUPER_TAB_NATIVE_REVIEW_DONE')
                    .isNotEmpty
            ? 12
            : 2,
      ),
    ),
  );
}
