import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/store/store_harness_actions.dart';

import 'swarm_state_test.dart' show createApp;
import 'support/real_fonts.dart';

Agent _agent(String id, {String? dsh, String? name, bool available = true}) =>
    Agent(
      id: id,
      name: name ?? 'Enclosure prototype',
      engine: 'codex',
      dsh: dsh,
      terminalAvailable: available,
      project: const AgentProject(
        name: 'Desk prototype',
        cwd: '/code/desk-prototype',
      ),
    );

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });
  test('resume uses the exact harness identity, not its base coding agent', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      _agent('code'),
      _agent('blender', dsh: 'autonomous/blender'),
      _agent('manager', dsh: 'autonomous/machine-monitor'),
      _agent('stopped', available: false),
    ];
    expect(storeResumeTargets(app, 'codex').map((t) => t.agent.id), ['code']);
    expect(
      storeResumeTargets(app, 'autonomous/blender').map((t) => t.agent.id),
      ['blender'],
    );
    expect(
      storeResumeTargets(
        app,
        'autonomous/machine-monitor',
      ).map((t) => t.agent.id),
      ['manager'],
    );
  });

  test('current pages resume legacy harnesses across machines without merging instances', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      _agent('local-models', dsh: 'local/ollama'),
      _agent('current-models', dsh: 'autonomous/ollama'),
      _agent('board', dsh: 'autonomous/copper'),
    ];
    const remote = Machine(
      machineId: 'remote',
      name: 'Mac mini',
      authMode: MachineAuthMode.remote,
    );
    app.machineStates['remote'] = MachineState(remote)
      ..agents = [_agent('local-models', dsh: 'local/ollama')];
    final targets = storeResumeTargets(app, 'autonomous/ollama');
    expect(targets, hasLength(3));
    expect(targets.map((t) => t.destinationId).toSet(), hasLength(3));
    expect(
      storeResumeTargets(app, 'autonomous/autonomous-circuit').single.agent.id,
      'board',
    );
    expect(storeResumeTargets(app, 'community/ollama'), isEmpty);
  });

  test(
    'resume reveals an existing tab, even offline, without adding views',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = [_agent('a', dsh: 'autonomous/blender')];
      await app.addAgentToSwarm('m', 'a');
      final original = app.activeSwarm;
      final pane = app.focusedPane;
      app.openStore();
      final tabs = app.swarms.length;
      final target = storeResumeTargets(app, 'autonomous/blender').single;
      expect(
        await resumeStoreHarness(app, 'autonomous/blender', target),
        isTrue,
      );
      expect(app.activeSwarm, same(original));
      expect(app.focusedPane, same(pane));
      expect(app.swarms.length, tabs);
      await resumeStoreHarness(app, 'autonomous/blender', target);
      expect(app.allPanes.where((p) => p.agentId == 'a'), hasLength(1));
      expect(app.swarms.length, tabs);
    },
  );

  test('resume after closing the tab attaches to the same agent', () async {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      _agent('a', dsh: 'autonomous/machine-monitor'),
    ];
    await app.addAgentToSwarm('m', 'a');
    final closed = app.activeSwarmId;
    app.openStore();
    app.closeSwarm(closed);
    expect(app.allPanes, isEmpty);
    final target = storeResumeTargets(app, 'autonomous/machine-monitor').single;
    await resumeStoreHarness(app, 'autonomous/machine-monitor', target);
    expect(app.focusedPane?.agentId, 'a');
    expect(app.machineStates['m']!.agents, hasLength(1));
    expect(app.activeSwarm.isStore, isFalse);
  });

  test(
    'a removed menu choice cannot create an empty tab or a new harness',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = [_agent('a')];
      final target = storeResumeTargets(app, 'codex').single;
      app.openStore();
      final store = app.activeSwarm;
      final tabs = app.swarms.length;
      app.machineStates['m']!.agents = [];
      expect(await resumeStoreHarness(app, 'codex', target), isFalse);
      expect(app.activeSwarm, same(store));
      expect(app.swarms.length, tabs);
      expect(app.allPanes, isEmpty);
    },
  );

  test('recency is navigation order; identical ids on different machines remain distinct', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [_agent('same'), _agent('same')];
    const remote = Machine(
      machineId: 'remote',
      name: 'Mac mini',
      authMode: MachineAuthMode.remote,
    );
    app.machineStates['remote'] = MachineState(remote)
      ..agents = [_agent('same')];
    final choices = storeResumeTargets(
      app,
      'codex',
      recent: [agentDestinationId('remote', 'same')],
    );
    expect(choices, hasLength(2));
    expect(choices.first.machineId, 'remote');
    expect(choices.last.machineId, 'm');
  });

  Future<void> showActions(
    WidgetTester tester,
    AppNotifier app, {
    required Future<void> Function() onNew,
    String harnessId = 'codex',
    double width = 1000,
    double scale = 1,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = Size(width, 640);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      RepaintBoundary(
        key: const ValueKey('store-actions-capture'),
        child: MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: MediaQuery(
            data: MediaQueryData(
              size: Size(width, 640),
              textScaler: TextScaler.linear(scale),
            ),
            child: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(24),
                child: StoreHarnessActions(
                  notifier: app,
                  harnessId: harnessId,
                  onNew: onNew,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('no choices shows only New Harness', (tester) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [];
    var created = 0;
    await showActions(
      tester,
      app,
      onNew: () async {
        created++;
      },
    );
    expect(find.byKey(const ValueKey('store-resume:codex')), findsNothing);
    expect(
      find.byKey(const ValueKey('store-resume-chevron:codex')),
      findsNothing,
    );
    await tester.tap(find.text('New Harness'));
    expect(created, 1);
  });

  for (final id in [
    'codex',
    'autonomous/blender',
    'autonomous/harness-manager',
    'autonomous/machine-monitor',
  ]) {
    testWidgets('$id: one choice resumes directly; New always starts fresh', (
      tester,
    ) async {
      final app = createApp();
      app.machineStates['m']!.agents = [
        _agent('one', dsh: id == 'codex' ? null : id),
      ];
      app.openStore();
      var created = 0;
      await showActions(
        tester,
        app,
        harnessId: id,
        onNew: () async {
          created++;
        },
      );
      expect(find.byKey(ValueKey('store-resume-chevron:$id')), findsNothing);
      expect(
        tester.getSize(find.byKey(ValueKey('store-resume:$id'))).width,
        tester.getSize(find.byKey(ValueKey('store-new:$id'))).width,
      );
      await tester.tap(find.text('Resume Harness'));
      await tester.pumpAndSettle();
      expect(find.text('Recent harnesses'), findsNothing);
      expect(app.focusedPane?.agentId, 'one');
      expect(created, 0);
      await tester.tap(find.text('New Harness'));
      expect(created, 1);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  testWidgets(
    'multiple choices show name, machine and project; choosing the remote opens that harness',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.agents = [_agent('same')];
      const remote = Machine(
        machineId: 'remote',
        name: 'Mac mini',
        authMode: MachineAuthMode.remote,
      );
      app.machineStates['remote'] = MachineState(remote)
        ..nodeOnline = false
        ..agents = [_agent('same')];
      app.openStore();
      final store = app.activeSwarm;
      await showActions(tester, app, onNew: () async {});
      expect(
        find.byKey(const ValueKey('store-resume-chevron:codex')),
        findsOneWidget,
      );
      expect(
        tester.getSize(find.byKey(const ValueKey('store-resume:codex'))).width,
        tester.getSize(find.byKey(const ValueKey('store-new:codex'))).width,
      );
      await tester.tap(find.text('Resume Harness'));
      await tester.pumpAndSettle();
      expect(
        app.activeSwarm,
        same(store),
        reason: 'multiple choices never pick one automatically',
      );
      expect(find.text('Enclosure prototype'), findsNWidgets(2));
      expect(find.text('Test host · Desk prototype'), findsOneWidget);
      expect(find.text('Mac mini · Desk prototype'), findsOneWidget);
      expect(find.byTooltip('Machine offline'), findsNWidgets(2));
      if (Platform.environment['HARNESS_STORE_CAPTURE_DIR']
          case final output?) {
        final layer = tester.renderObject<RenderRepaintBoundary>(
          find.byKey(const ValueKey('store-actions-capture')),
        );
        await tester.runAsync(() async {
          final image = await layer.toImage(pixelRatio: 1);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(output).create(recursive: true);
          await File('$output/resume-menu.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }
      await tester.tap(find.text('Mac mini · Desk prototype'));
      await tester.pumpAndSettle();
      expect(app.focusedPane?.machineId, 'remote');
      expect(app.focusedPane?.agentId, 'same');
      expect(find.text('Recent harnesses'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'arrow down opens choices and Escape dismisses without resuming',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = [_agent('a'), _agent('b')];
      app.openStore();
      final store = app.activeSwarm;
      await showActions(tester, app, onNew: () async {});
      tester
          .widget<OutlinedButton>(
            find.byKey(const ValueKey('store-resume:codex')),
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
      expect(find.text('Recent harnesses'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Recent harnesses'), findsNothing);
      expect(app.activeSwarm, same(store));
    },
  );

  testWidgets('actions wrap at narrow widths and large text', (tester) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [_agent('a'), _agent('b')];
    await showActions(tester, app, onNew: () async {}, width: 360, scale: 2);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('Resume Harness'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('Recent harnesses'), findsOneWidget);
  });
}
