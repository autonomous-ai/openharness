import 'dart:io';
import 'dart:async';
import 'dart:ui' as ui;
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/workspace_status.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:harness/widgets/workspace_bar_control.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/widgets/agent_drag.dart';
import 'package:harness/widgets/status_line.dart';
import 'package:harness/widgets/pull_request_badge.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp, MemoryStore;
import 'swarm_screen_test.dart' show mount, terminal;
import 'support/real_fonts.dart';

class _PRConnection extends WsConn {
  _PRConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  int reads = 0;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'git_pull_request') return {};
    reads++;
    return {
      'status': 'found',
      'number': 298,
      'state': 'Merged',
      'url': 'https://github.com/acme/repo/pull/298',
    };
  }
}

class _PaneModelConnection extends _PRConnection {
  final retargets = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_retarget') {
      retargets.add(payload);
      return {};
    }
    if (type == 'grid_models_list') {
      return {
        'gridName': 'fixture',
        'models': [
          {'id': 'Local-Test-Model', 'node': 'local', 'grid': 'fixture'},
        ],
      };
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

Future<void> captureControls(WidgetTester tester, String name) async {
  final directory =
      Platform.environment['HARNESS_WORKSPACE_CONTROLS_CAPTURE_DIR'];
  if (directory == null) return;
  final view = tester.binding.renderViews.first;
  final layer = view.debugLayer! as OffsetLayer;
  await tester.runAsync(() async {
    final image = await layer.toImage(Offset.zero & view.size);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$directory/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    if (Platform.environment['HARNESS_WORKSPACE_CONTROLS_CAPTURE_DIR'] !=
        null) {
      await loadRealFonts();
      if (Platform.isMacOS) {
        final bytes = ByteData.sublistView(
          await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
        );
        for (final family in ['SF Mono', '.AppleSystemUIFontMonospaced']) {
          await (FontLoader(family)..addFont(Future.value(bytes))).load();
        }
      }
    }
  });
  for (final native in [false, true]) {
    testWidgets(
      'shared model selector follows focus and rejects stale actions (native=$native)',
      (tester) async {
        final updates = <Map>[];
        const channel = MethodChannel('harness/swarm_tabs');
        const codec = StandardMethodCodec();
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'update') updates.add(call.arguments as Map);
          return true;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        Future<void> activate(int paneId, String agentId) async {
          final done = Completer<void>();
          messenger.handlePlatformMessage(
            channel.name,
            codec.encodeMethodCall(
              MethodCall('focusedModel', {
                'paneId': paneId,
                'agentId': agentId,
              }),
            ),
            (bytes) {
              codec.decodeEnvelope(bytes!);
              done.complete();
            },
          );
          for (var i = 0; i < 8 && !done.isCompleted; i++) {
            await tester.pump();
          }
          expect(done.isCompleted, isTrue);
          await done.future;
        }

        final connection = _PaneModelConnection();
        final app = createApp(connectionForTest: (_) => connection);
        addTearDown(app.dispose);
        app.machineStates['m']!.nodeOnline = true;
        app.machineStates['m']!.agents = [
          Agent.fromJson({
            'id': 'a0',
            'engine': 'claude',
            'selectedModel': 'runtime-v1:a0:claude:fable@high',
            'terminal': {'available': true},
          }),
          Agent.fromJson({
            'id': 'a1',
            'engine': 'codex',
            'selectedModel': 'runtime-v1:a1:codex:gpt-6-astra@high',
            'terminal': {'available': true},
          }),
        ];
        final first = app.adoptSessionForTest(terminal('a0', []));
        final second = app.adoptSessionForTest(terminal('a1', []));
        await mount(tester, app, nativeTabs: native);
        final selectors = find.byType(GridModelPicker);
        expect(selectors, findsOneWidget);
        expect(
          find.descendant(of: find.byType(TerminalPanel), matching: selectors),
          findsNothing,
        );
        if (native) {
          expect(updates.last['focusedModel']['text'], 'GPT-6 Astra');
        } else {
          expect(find.text('GPT-6 Astra'), findsOneWidget);
          expect(find.text('Fable'), findsNothing);
          await captureControls(tester, 'focused-model');
          expect(
            find.descendant(
              of: find.byKey(const ValueKey('workspace-status-bar')),
              matching: selectors,
            ),
            findsOneWidget,
          );
        }
        app.focusPane(first.id);
        await tester.pump();
        if (native) {
          expect(updates.last['focusedModel']['text'], 'Fable');
          await activate(second.id, 'a1');
          expect(find.text('Local-Test-Model'), findsNothing);
          await activate(first.id, 'a0');
        } else {
          expect(find.text('GPT-6 Astra'), findsNothing);
          await tester.tap(selectors);
        }
        await tester.pumpAndSettle();
        await tester.tap(find.text('Local-Test-Model'));
        await tester.pumpAndSettle();
        expect(connection.retargets.single['agentId'], 'a0');
        expect(connection.retargets.single['gridModel'], 'Local-Test-Model');
        expect(app.panes, containsAll([first, second]));
        final stale = tester.widget<GridModelPicker>(selectors).onUseOwnLogin!;
        if (native) {
          await activate(first.id, 'a0');
        } else {
          await tester.tap(selectors);
        }
        await tester.pumpAndSettle();
        expect(find.text('Local-Test-Model'), findsOneWidget);
        app.focusPane(second.id);
        await tester.pumpAndSettle();
        expect(find.text('Local-Test-Model'), findsNothing);
        stale();
        await tester.pump();
        expect(connection.retargets, hasLength(1));
        app.machineStates['m']!.nodeOnline = false;
        app.focusPane(first.id);
        await tester.pump();
        app.focusPane(second.id);
        await tester.pump();
        expect(tester.widget<GridModelPicker>(selectors).enabled, isFalse);
        if (native) {
          expect(updates.last['focusedModel']['interactive'], isFalse);
          await activate(second.id, 'a1');
        }
        expect(find.text('Local-Test-Model'), findsNothing);
        app.newSwarm();
        await tester.pump();
        expect(selectors, findsNothing);
        if (native) expect(updates.last['focusedModel'], isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('hover close belongs to its pane and reserves title space', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    final first = app.adoptSessionForTest(terminal('a0', []));
    final second = app.adoptSessionForTest(terminal('a1', []));
    await mount(tester, app);
    final titles = find.byKey(const ValueKey('terminal-pane-title'));
    final titleRects = [
      for (var i = 0; i < 2; i++) tester.getRect(titles.at(i)),
    ];
    final close = find.byType(PaneCloseButton);
    expect(close, findsNWidgets(2));
    expect(close.hitTestable(), findsNothing);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(titles.first));
    await tester.pump();
    expect(close.hitTestable(), findsOneWidget);
    for (var i = 0; i < 2; i++) {
      expect(tester.getRect(titles.at(i)), titleRects[i]);
    }
    await tester.pump(const Duration(milliseconds: 100));
    await captureControls(tester, 'pane-hover-close');
    await tester.tap(close.hitTestable());
    await tester.pump();
    expect(find.byKey(first.cellKey), findsNothing);
    expect(app.panes, [second]);
    expect(app.allPanes, isNot(contains(first)));
    expect(second.session!.agentId, 'a1');
    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox());
  });

  for (final native in [false, true]) {
    testWidgets(
      'focused PR uses every selected theme without duplicate pane lookups (native=$native)',
      (tester) async {
        final updates = <Map>[];
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            if (call.method == 'update') updates.add(call.arguments as Map);
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final original = appearancePrefsStore.value;
        addTearDown(() => appearancePrefsStore.value = original);
        final connection = _PRConnection();
        final app = createApp(connectionForTest: (_) => connection);
        addTearDown(app.dispose);
        app.stateOf('m')!.nodeOnline = true;
        app.stateOf('m')!.agents = const [
          Agent(
            id: 'a0',
            name: 'Feature',
            engine: 'codex',
            modelName: 'GPT-6 Astra',
            terminalAvailable: true,
            project: AgentProject(
              name: 'repo',
              cwd: '/repo',
              root: '/repo',
              branch: 'feature',
            ),
          ),
        ];
        final pane = app.adoptSessionForTest(terminal('a0', []));
        await mount(tester, app, nativeTabs: native);
        await tester.pump();
        expect(find.byType(PullRequestBadge), findsNothing);
        for (final style in StatusLineStyle.values) {
          appearancePrefsStore.value = original.copyWith(
            prompt: PromptPrefs(statusStyle: style),
          );
          await tester.pump();
          if (native) {
            final pr = updates.last['pullRequest'] as Map;
            expect(pr['text'], '#298 Merged');
            expect(pr['url'], 'https://github.com/acme/repo/pull/298');
            expect(pr['segmented'], style.segmented);
            final capture =
                Platform.environment['HARNESS_NATIVE_STATUS_CAPTURE_DIR'];
            if (capture != null) {
              await tester.runAsync(() async {
                await Directory(capture).create(recursive: true);
                await File('$capture/${style.name}.json')
                    .writeAsString(jsonEncode(updates.last));
              });
            }

            expect(
              (pr['segments'] as List).any(
                (s) => (s as Map)['background'] != null,
              ),
              style.segmented,
            );
          } else {
            final badge = find.byKey(const ValueKey('workspace-pull-request'));
            final rendered = tester.widget<StatusLine>(
              find.descendant(of: badge, matching: find.byType(StatusLine)),
            );
            expect(rendered.parts.style, style);
            expect(rendered.parts.text, '#298 Merged');
            for (final width in [520.0, 1280.0]) {
              tester.view.physicalSize = Size(width, 800);
              await tester.pump(const Duration(milliseconds: 100));
              expect(tester.takeException(), isNull);
              final contextRight = tester
                  .getRect(find.byKey(const ValueKey('workspace-pane-context')))
                  .right;
              expect(
                tester.getRect(badge).left,
                style.segmented
                    ? closeTo(contextRight, .01)
                    : greaterThan(contextRight),
              );
            }
          }
        }
        expect(connection.reads, 1);
        app.renameSwarm(app.activeSwarmId, 'Release');
        // Let the terminal finish its resize debounce after the last layout.
        await tester.pump(const Duration(milliseconds: 100));
        if (native) {
          expect(
            ((updates.last['tabs'] as List).single as Map)['label'],
            '1:Release',
          );
        } else {
          expect(find.text('1:Release'), findsOneWidget);
        }
        app.newSwarm();
        await tester.pump();
        if (native) {
          expect(updates.last['pullRequest'], isNull);
        } else {
          expect(
            find.byKey(const ValueKey('workspace-pull-request')),
            findsNothing,
          );
        }
        expect(app.allPanes, contains(pane));
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  test(
    'custom tab labels survive pane changes, closing, and saved layout restore',
    () async {
      final storage = MemoryStore();
      final app = createApp(store: storage);
      await app.addAgentToSwarm('m', 'a0');
      final id = app.activeSwarmId;
      app.renameSwarm(id, 'My release');
      await app.addAgentToSwarm('m', 'a1');
      expect(workspaceTabNames(app)[id], 'My release');
      await app.closeSwarm(id);
      app.reopenClosedSwarm();
      expect(workspaceTabNames(app)[id], 'My release');
      await app.flushPaneLayout();
      app.dispose();
      final restored = createApp(store: storage);
      addTearDown(restored.dispose);
      await restored.restorePaneLayoutForTest();
      expect(workspaceTabNames(restored)[id], 'My release');
      expect(
        restored.swarms.singleWhere((s) => s.id == id).nameIsCustom,
        isTrue,
      );
    },
  );

  test(
    'status project names follow remote, subfolder, and ordinary folder rules',
    () {
      const root = AgentProject(
        name: 'local-clone',
        cwd: '/work/local-clone',
        root: '/work/local-clone',
        remote: 'github.com/team/api',
        branch: 'main',
      );
      const linked = AgentProject(
        name: 'local-clone',
        cwd: '/worktrees/random-name',
        root: '/worktrees/random-name',
        remote: 'github.com/team/api',
        branch: 'fix',
        worktree: true,
      );
      const subfolder = AgentProject(
        name: 'local-clone',
        cwd: '/work/local-clone/desktop/',
        root: '/work/local-clone',
        remote: 'github.com/team/api',
      );
      const local = AgentProject(
        name: 'local-repo',
        cwd: '/local-repo',
        root: '/local-repo',
      );
      const folder = AgentProject(name: 'notes', cwd: '/work/notes');
      expect(
        [root.label, linked.label, subfolder.label, local.label, folder.label],
        ['api', 'api', 'desktop', 'local-repo', 'notes'],
      );
      final app = createApp();
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = const [
        Agent(id: 'a', name: 'Fix', engine: 'codex', project: linked),
      ];
      app.activeSwarm.panes.add(
        TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
      );
      app.activeSwarm.focusedPaneId = 1;
      final context = WorkspacePaneContext.focused(app)!;
      expect(context.text, 'Test host:api  (fix)');
      expect(context.detail, contains('/worktrees/random-name'));
      for (final style in StatusLineStyle.values) {
        final text = context.format(PromptPrefs(statusStyle: style)).text;
        expect(text, isNot(contains('random-name')));
        expect(text, isNot(contains('[worktree]')));
      }
    },
  );

  test('project names distinguish code tabs while a distinct harness keeps its type', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'a',
        name: 'a',
        engine: 'codex',
        project: AgentProject(name: 'api', cwd: '/api'),
      ),
      Agent(
        id: 'b',
        name: 'b',
        engine: 'claude',
        project: AgentProject(name: 'web', cwd: '/web'),
      ),
      Agent(
        id: 'c',
        name: 'c',
        engine: 'claude',
        dsh: 'autonomous/blender',
        project: AgentProject(name: 'scene', cwd: '/scene'),
      ),
    ];
    app.swarms.clear();
    for (final id in ['a', 'b', 'c']) {
      app.swarms.add(
        Swarm(id: id)
          ..panes.add(
            TerminalPane(id: id.codeUnitAt(0), machineId: 'm', agentId: id),
          ),
      );
    }
    expect(workspaceTabNames(app), {'a': 'api', 'b': 'web', 'c': 'blender'});
    final scene = app.swarms.last;
    for (var id = 0; id < 4; id++) {
      scene.panes.add(
        TerminalPane(
          id: id,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'a',
        ),
      );
      scene.focusedPaneId = id;
      expect(workspaceTabNames(app)['c'], 'blender');
    }
    app.renameSwarm('a', 'My workspace');
    expect(workspaceTabNames(app)['a'], 'My workspace');
    expect(app.swarms.first.name, 'My workspace');
  });

  test('machine names distinguish the same project on different machines', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.swarms.clear();
    for (final id in ['laptop', 'server']) {
      final machine = Machine(
        machineId: id,
        name: id,
        authMode: MachineAuthMode.remote,
      );
      app.machineStates[id] = MachineState(machine)
        ..agents = const [
          Agent(
            id: 'a',
            name: 'a',
            engine: 'codex',
            project: AgentProject(name: 'api', cwd: '/api'),
          ),
        ];
      app.swarms.add(
        Swarm(id: id)
          ..panes.add(TerminalPane(id: 1, machineId: id, agentId: 'a')),
      );
    }
    expect(workspaceTabNames(app), {'laptop': 'laptop', 'server': 'server'});
  });

  test('a shared machine wins over a minority project or harness type', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'a',
        name: 'a',
        engine: 'codex',
        project: AgentProject(name: 'api', cwd: '/api'),
      ),
      Agent(
        id: 'b',
        name: 'b',
        engine: 'claude',
        project: AgentProject(name: 'web', cwd: '/web'),
      ),
      Agent(id: 'c', name: 'c', engine: 'claude', dsh: 'autonomous/blender'),
    ];
    app.activeSwarm.panes.addAll([
      for (final id in ['a', 'b', 'c'])
        TerminalPane(id: id.codeUnitAt(0), machineId: 'm', agentId: id),
    ]);
    expect(workspaceTabNames(app).values.single, 'Test host');
  });

  test('status presets retain real metadata and omit missing Git context', () {
    const expected = {
      StatusLineStyle.standard: 'OpenAI  M2:app  (main)',
      StatusLineStyle.robbyrussell: 'OpenAI  M2  ➜ app git:(main)',
      StatusLineStyle.pure: 'OpenAI  M2  app main ❯',
      StatusLineStyle.agnoster: 'OpenAI M2  app  main',
      StatusLineStyle.powerlevel10k: 'OpenAI  M2  app  main >',
      StatusLineStyle.spaceship: 'OpenAI  M2 in app on main',
    };
    for (final format in StatusLineStyle.values) {
      expect(
        statusLineParts(
          provider: 'OpenAI',
          machine: 'M2',
          project: 'app',
          branch: 'main',
          style: format,
        ).text,
        expected[format],
      );
      expect(
        statusLineParts(
          provider: 'OpenAI',
          machine: '',
          project: 'notes',
          style: format,
        ).text,
        isNot(anyOf(contains('git'), contains('()'), contains('[worktree]'))),
      );
      final prefs = PromptPrefs(
        statusStyle: format,
        machine: false,
        color: false,
      );
      expect(PromptPrefs.fromJson(prefs.toJson()), prefs);
    }
    expect(
      PromptPrefs.fromJson({'statusStyle': 'future'}).statusStyle,
      StatusLineStyle.standard,
    );
    expect(
      PromptPrefs.fromJson({'style': 'powerline'}).statusStyle,
      StatusLineStyle.standard,
    );
  });

  test('dominant type groups code engines, excludes viewers, and breaks ties by pane order', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(id: 'a', name: 'Code', engine: 'codex'),
      Agent(id: 'b', name: 'Code', engine: 'claude'),
      Agent(
        id: 'c',
        name: 'Scene',
        engine: 'claude',
        dsh: 'autonomous/blender',
      ),
      Agent(id: 'd', name: 'Scene', engine: 'codex', dsh: 'autonomous/blender'),
    ];
    final tab = app.activeSwarm;
    tab.panes.addAll([
      TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
      TerminalPane(id: 2, machineId: 'm', agentId: 'b'),
      TerminalPane(id: 3, machineId: 'm', agentId: 'c'),
      for (var index = 4; index < 8; index++)
        TerminalPane(
          id: index,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'c',
        ),
    ]);
    expect(tabHarnessType(app, tab), 'code');
    tab.panes.add(TerminalPane(id: 8, machineId: 'm', agentId: 'd'));
    for (final pane in tab.panes) {
      tab.focusedPaneId = pane.id;
      expect(tabHarnessType(app, tab), 'code');
    }
    tab.panes.removeAt(0);
    expect(tabHarnessType(app, tab), 'blender');
    tab.panes.removeWhere((pane) => !pane.isWeb);
    expect(tabHarnessType(app, tab), 'new');
    expect(tabHarnessType(app, Swarm(id: 'store', kind: 'store')), 'store');
  });

  test('focused viewers inherit owner context, using the compact project name and full path tooltip', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'a',
        name: 'Scene',
        engine: 'claude',
        dsh: 'autonomous/blender',
        project: AgentProject(
          name: 'scene',
          cwd: '/worktrees/scene-light',
          root: '/worktrees/scene-light',
          branch: 'lighting',
        ),
      ),
      Agent(
        id: 'b',
        name: 'Notes',
        engine: 'codex',
        project: AgentProject(name: 'notes', cwd: '/work/notes'),
      ),
    ];
    final tab = app.activeSwarm;
    tab.panes.addAll([
      TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
      TerminalPane(
        id: 2,
        machineId: 'm',
        kind: PaneKind.web,
        ownerAgentId: 'a',
      ),
      TerminalPane(id: 3, machineId: 'm', agentId: 'b'),
    ]);
    tab.focusedPaneId = 1;
    final owner = WorkspacePaneContext.focused(app)!;
    expect(owner.text, 'Test host:scene  (lighting)');
    tab.focusedPaneId = 2;
    expect(WorkspacePaneContext.focused(app)!.text, owner.text);
    expect(WorkspacePaneContext.focused(app)!.agentId, 'a');
    tab.focusedPaneId = 3;
    expect(WorkspacePaneContext.focused(app)!.text, 'Test host:notes');
    tab.panes.clear();
    expect(WorkspacePaneContext.focused(app), isNull);
  });

  testWidgets(
    'compact tabs sit to the left of one focused context and switch workspaces',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      final first = app.activeSwarm;
      app.newSwarm();
      app.adoptSessionForTest(terminal('a1', []));
      await mount(tester, app);
      expect(find.text('1:code'), findsOneWidget);
      expect(find.text('2:code'), findsOneWidget);
      final context = find.byKey(const ValueKey('workspace-pane-context'));
      expect(
        tester.getRect(context).left,
        greaterThan(tester.getRect(find.text('2:code')).right),
      );
      final secondTab = find.byKey(ValueKey(app.activeSwarmId));
      final barControls = find.byType(WorkspaceBarControl);
      for (final element in barControls.evaluate()) {
        expect(tester.getSize(find.byWidget(element.widget)).height, 28);
      }
      expect(tester.getSize(secondTab).width, lessThan(150));
      final harnesses = find.byKey(const ValueKey('swarm-harnesses-button'));
      final machines = find.byKey(const ValueKey('swarm-machines-button'));
      final models = find.byKey(const ValueKey('swarm-models-button'));
      final store = find.byKey(const ValueKey('swarm-store-button'));
      expect(harnesses, findsOneWidget);
      expect(machines, findsOneWidget);
      expect(models, findsOneWidget);
      expect(store, findsOneWidget);
      expect(find.byKey(const ValueKey('swarm-help-button')), findsNothing);
      final tools = [harnesses, machines, models, store];
      final symbols = ['>', '@', ':', '*'];
      for (var i = 0; i < tools.length; i++) {
        expect(
          find.descendant(of: tools[i], matching: find.text(symbols[i])),
          findsOneWidget,
        );
      }
      expect(
        find.descendant(
          of: find.byType(TerminalPanel),
          matching: find.byType(GridModelPicker),
        ),
        findsNothing,
      );
      await tester.tap(find.text('1:code'));
      await tester.pump(const Duration(milliseconds: 350));
      expect(app.activeSwarm, same(first));
      final originalFont = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = originalFont);
      for (final size in [originalFont.fontSize, 18.0]) {
        terminalFontStore.value = TerminalStyle(
          fontSize: size,
          fontFamily: originalFont.fontFamily,
          fontFamilyFallback: originalFont.fontFamilyFallback,
        );
        for (final width in [400.0, 480.0, 520.0, 880.0, 1280.0]) {
          tester.view.physicalSize = Size(width, 800);
          await tester.pump(const Duration(milliseconds: 100));
          expect(tester.takeException(), isNull);
          final rects = tools.map(tester.getRect).toList();
          expect(tester.getRect(context).right, lessThan(rects.first.left));
          expect(rects.last.right, lessThan(width));
          final paragraphs = tools
              .map(
                (tool) => tester.renderObject<RenderParagraph>(
                  find.descendant(of: tool, matching: find.byType(RichText)),
                ),
              )
              .toList();
          final baselines = paragraphs
              .map(
                (paragraph) => paragraph
                    .localToGlobal(
                      Offset(
                        0,
                        paragraph.getDryBaseline(
                          paragraph.constraints,
                          TextBaseline.alphabetic,
                        )!,
                      ),
                    )
                    .dy,
              )
              .toList();
          for (var i = 0; i < rects.length; i++) {
            expect(rects[i].width, closeTo(rects.first.width, .01));
            expect(rects[i].height, closeTo(rects.first.height, .01));
            expect(rects[i].width, greaterThanOrEqualTo(28));
            expect(rects[i].center.dy, rects.first.center.dy);
            expect(baselines[i], closeTo(baselines.first, .01));
            if (i > 0) {
              expect(rects[i].left, closeTo(rects[i - 1].right, .01));
              expect(
                rects[i].center.dx - rects[i - 1].center.dx,
                closeTo(rects.first.width, .01),
              );
            }
          }
        }
      }
      final symbol = find.descendant(of: machines, matching: find.text('@'));
      Color? color() => DefaultTextStyle.of(tester.element(symbol)).style.color;
      final resting = color();
      final pointer = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await pointer.addPointer(location: Offset.zero);
      await pointer.moveTo(tester.getCenter(machines));
      await tester.pump(const Duration(milliseconds: 800));
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.text('Machines'), findsOneWidget);
      expect(color(), isNot(resting));
      await pointer.removePointer();
      await tester.pumpAndSettle();
      final focus = Focus.of(tester.element(symbol));
      focus.requestFocus();
      await tester.pumpAndSettle();
      expect(focus.hasFocus, isTrue);
      expect(color(), isNot(resting));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'native status payload follows focus and keeps the type label short',
    (tester) async {
      final updates = <Map<String, dynamic>>[];
      const channel = MethodChannel('harness/swarm_tabs');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            if (call.method == 'update') {
              updates.add(Map<String, dynamic>.from(call.arguments as Map));
            }
            return null;
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      app.adoptSessionForTest(terminal('a1', []));
      await mount(tester, app, nativeTabs: true);
      final tab = (updates.last['tabs'] as List).single as Map;
      expect(tab['label'], '1:code');
      expect((updates.last['focusedContext'] as Map)['text'], 'Test host');
      expect(updates.last['barStyle'], containsPair('family', isA<String>()));
      final originalPrefs = appearancePrefsStore.value;
      addTearDown(() => appearancePrefsStore.value = originalPrefs);
      appearancePrefsStore.value = originalPrefs.copyWith(
        prompt: originalPrefs.prompt.copyWith(
          statusStyle: StatusLineStyle.pure,
          machine: false,
          color: false,
        ),
      );
      await tester.pump();
      expect((updates.last['focusedContext'] as Map)['text'], '');
      final colors = updates.last['barStyle'] as Map;
      final segments =
          (updates.last['focusedContext'] as Map)['segments'] as List;
      expect(
        segments.map((part) => (part as Map)['foreground']),
        everyElement(colors['foreground']),
      );
      app.newSwarm();
      await tester.pump();
      expect(updates.last['focusedContext'], isNull);
      expect(((updates.last['tabs'] as List).last as Map)['label'], '2:new');
      await tester.pumpWidget(const SizedBox());
    },
  );
}
