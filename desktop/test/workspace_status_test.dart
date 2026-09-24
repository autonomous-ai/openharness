import 'package:flutter/material.dart';
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
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/widgets/status_line.dart';
import 'package:harness/widgets/pull_request_badge.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp, MemoryStore;
import 'swarm_screen_test.dart' show mount, terminal;

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

void main() {
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
        app.stateOf('m')!.agents = const [
          Agent(
            id: 'a0',
            name: 'Feature',
            engine: 'codex',
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
            expect(pr['text'], 'PR #298 · Merged');
            expect(pr['url'], 'https://github.com/acme/repo/pull/298');
            expect(pr['segmented'], style.segmented);
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
            expect(rendered.parts.text, 'PR #298 · Merged');
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
      expect(context.text, 'OpenAI  Test host:api  (fix)');
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
      StatusLineStyle.powerlevel10k: 'OpenAI  M2  app  main',
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
    expect(owner.text, 'Anthropic  Test host:scene  (lighting)');
    tab.focusedPaneId = 2;
    expect(WorkspacePaneContext.focused(app)!.text, owner.text);
    expect(WorkspacePaneContext.focused(app)!.agentId, 'a');
    tab.focusedPaneId = 3;
    expect(WorkspacePaneContext.focused(app)!.text, 'OpenAI  Test host:notes');
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
      expect(tester.getSize(secondTab).width, lessThan(150));
      expect(find.byKey(const ValueKey('swarm-models-button')), findsNothing);
      expect(find.byKey(const ValueKey('swarm-machines-button')), findsNothing);
      expect(find.byKey(const ValueKey('swarm-store-button')), findsNothing);
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
      for (final width in [520.0, 1280.0]) {
        tester.view.physicalSize = Size(width, 800);
        await tester.pump(const Duration(milliseconds: 100));
        expect(tester.takeException(), isNull);
      }
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
      expect(
        (updates.last['focusedContext'] as Map)['text'],
        'OpenAI  Test host',
      );
      expect(
        updates.last['terminalStyle'],
        containsPair('family', isA<String>()),
      );
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
      expect((updates.last['focusedContext'] as Map)['text'], 'OpenAI');
      final colors = updates.last['terminalStyle'] as Map;
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
