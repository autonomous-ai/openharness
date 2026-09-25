import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/shared/theme/workspace_bar_style.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/widgets/workspace_bar_control.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'support/resource_picker.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_interactions_test.dart' show chord;
import 'swarm_state_test.dart' show createApp;

AppNotifier fixture() {
  final app = createApp();
  app.stateOf('m')!.agents = [
    for (final (id, remote, branch) in [
      ('a0', 'acme/api', 'main'),
      ('a1', 'acme/api', 'feature'),
      ('a2', 'different/api', 'main'),
      ('a3', 'acme/api', 'Main'),
      ('a4', 'acme/api', 'main-fix'),
    ])
      Agent(
        id: id,
        name: id,
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(
          name: 'api',
          cwd: '/worktrees/$id',
          root: '/worktrees/$id',
          remote: remote,
          branch: branch,
          worktree: true,
        ),
      ),
  ];
  const remote = Machine(
    machineId: 'n',
    name: 'Test host',
    authMode: MachineAuthMode.remote,
  );
  app.machines = [...app.machines, remote];
  app.machineStates['n'] = MachineState(remote)
    ..agents = const [
      Agent(
        id: 'remote',
        name: 'remote',
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(
          name: 'api',
          cwd: '/api',
          root: '/api',
          remote: 'acme/api',
          branch: 'main',
        ),
      ),
    ];
  return app;
}

void main() {
  test(
    'projects with open panes across all tabs lead; each group is alphabetical',
    () async {
      final app = fixture();
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = [
        ...app.stateOf('m')!.agents,
        for (final name in ['beta', 'zeta'])
          Agent(
            id: name,
            name: name,
            engine: 'codex',
            terminalAvailable: true,
            project: AgentProject(
              name: name,
              cwd: '/$name',
              root: '/$name',
              remote: 'acme/$name',
            ),
          ),
      ];
      app.adoptSessionForTest(terminal('zeta', []));
      final firstTab = app.activeSwarmId;
      app.newSwarm();
      final second = app.adoptSessionForTest(terminal('a2', []));
      final secondTab = app.activeSwarmId;
      final search = SwarmSearchController(app, [
        agentDestinationId('m', 'beta'),
      ], offersCreate: true)..setQuery('#');
      addTearDown(search.dispose);
      List<String> order() => search.rows.map((row) => row.id).toList();
      const expected = [
        'project:repo:different/api',
        'project:repo:acme/zeta',
        'project:repo:acme/api',
        'project:repo:acme/beta',
      ];
      expect(order(), expected);
      expect(search.rows.any((row) => row.isCreate), isFalse);
      app.selectSwarm(firstTab);
      expect(order(), expected);
      app.selectSwarm(secondTab);
      await app.closePane(second.id);
      expect(order(), [
        'project:repo:acme/zeta',
        'project:repo:acme/api',
        'project:repo:different/api',
        'project:repo:acme/beta',
      ]);
      search.setQuery('#beta');
      expect(order(), ['project:repo:acme/beta']);
      search.setQuery('#missing-project');
      expect(search.rows, isEmpty);
      expect(search.canAccept, isFalse);
    },
  );

  test(
    'identity scopes distinguish duplicate labels and exact branch names',
    () {
      final app = fixture();
      addTearDown(app.dispose);
      final search = SwarmSearchController(
        app,
        [],
        adding: true,
        activityFirst: true,
        offersCreate: true,
      );
      addTearDown(search.dispose);
      Set<String?> ids() => search.rows
          .where((r) => r.agentId != null)
          .map((r) => r.agentId)
          .toSet();
      expect(search.scopeToGroup('machine:m'), isTrue);
      expect(ids(), {'a0', 'a1', 'a2', 'a3', 'a4'});
      expect(search.scopeToGroup('project:repo:acme/api'), isTrue);
      expect(ids(), {'a0', 'a1', 'a3', 'a4', 'remote'});
      expect(
        search.scopeToGroup('project:repo:acme/api', branch: 'main'),
        isTrue,
      );
      expect(ids(), {'a0', 'remote'});
      expect(search.rows.any((r) => r.isCreate), isFalse);
      search.setQuery('remote');
      expect(ids(), {'remote'});
      expect(search.back(), isTrue);
      expect(search.scopedBranch, isNull);
      expect(ids(), {'a0', 'a1', 'a3', 'a4', 'remote'});
      expect(search.back(), isTrue);
      expect(search.isProjectMode, isTrue);
      search.scopeToGroup('project:repo:acme/api', branch: 'main');
      search.setQuery('@');
      expect(search.canGoBack, isFalse);
      expect(
        search.scopeToGroup('project:repo:missing', branch: 'main'),
        isFalse,
      );
      expect(search.isMachineMode, isTrue);
    },
  );

  test('folders and detached commits retain exact identity and stale scopes stay empty', () {
    final app = fixture();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'folder',
        name: 'folder',
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(name: 'api', cwd: '/notes'),
      ),
      Agent(
        id: 'detached',
        name: 'detached',
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(
          name: 'api',
          cwd: '/api',
          root: '/api',
          remote: 'acme/api',
          branch: 'Detached deadbeef',
        ),
      ),
      Agent(
        id: 'named',
        name: 'named',
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(
          name: 'api',
          cwd: '/other',
          root: '/other',
          remote: 'acme/api',
          branch: 'deadbeef',
        ),
      ),
    ];
    final search = SwarmSearchController(
      app,
      [],
      adding: true,
      activityFirst: true,
    );
    addTearDown(search.dispose);
    search.scopeToGroup('project:folder:m:/notes');
    expect(search.rows.map((r) => r.agentId), ['folder']);
    search.scopeToGroup('project:repo:acme/api', branch: 'Detached deadbeef');
    expect(search.rows.map((r) => r.agentId), ['detached']);
    final saved = search.draft;
    search.setQuery('@');
    search.restoreDraft(saved);
    expect(search.scopedBranch, 'Detached deadbeef');
    app.stateOf('m')!.agents = [];
    app.renameSwarm(app.activeSwarmId, 'refresh');
    expect(search.rows, isEmpty);
    expect(search.scopedBranch, 'Detached deadbeef');
  });

  for (final native in [false, true]) {
    testWidgets(
      'context opens scoped Cmd-P without changing the terminal (native=$native)',
      (tester) async {
        final original = appearancePrefsStore.value;
        addTearDown(() => appearancePrefsStore.value = original);
        appearancePrefsStore.value = original.copyWith(
          prompt: const PromptPrefs(),
        );
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
        final app = fixture();
        addTearDown(app.dispose);
        final input = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a0', input));
        final session = pane.session;
        await mount(tester, app, nativeTabs: native);
        for (final field in StatusLineField.values) {
          if (field == StatusLineField.machine) {
            await chord(tester, LogicalKeyboardKey.keyR);
            expect(resourceSearch(tester).split, isNotNull);
            // Flutter's modal barrier covers its bar; AppKit's native bar
            // remains available while a picker is open.
            if (!native) {
              await tester.sendKeyEvent(LogicalKeyboardKey.escape);
              await tester.pump();
            }
          }
          if (native) {
            final fields =
                ((updates.last['focusedContext'] as Map)['fields'] as List)
                    .cast<Map>();
            final payload = fields.singleWhere((p) => p['field'] == field.name);
            expect(payload['interactive'], isTrue);
            await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
              channel.name,
              const StandardMethodCodec().encodeMethodCall(
                MethodCall('focusedContext', payload),
              ),
              (_) {},
            );
          } else {
            await tester.tap(
              find.byKey(ValueKey('workspace-context-${field.name}')),
            );
          }
          await tester.pump();
          expect(resourceField, findsOneWidget);
          final search = resourceSearch(tester);
          expect(search.canGoBack, isTrue);
          expect(search.split, isNull);
          expect(search.activityFirst, isTrue);
          final ids = search.rows
              .where((r) => r.agentId != null)
              .map((r) => r.agentId)
              .toSet();
          expect(ids, switch (field) {
            StatusLineField.machine => {'a0', 'a1', 'a2', 'a3', 'a4'},
            StatusLineField.project => {'a0', 'a1', 'a3', 'a4', 'remote'},
            StatusLineField.branch => {'a0', 'remote'},
          });
          expect(pane.session, same(session));
          expect(input, isEmpty);
          // Escape leaves branch, project, and finally the picker.
          for (var i = 0; i < 3 && resourceField.evaluate().isNotEmpty; i++) {
            await tester.sendKeyEvent(LogicalKeyboardKey.escape);
            await tester.pump();
          }
          expect(resourceField, findsNothing);
        }
        if (native) {
          // Delayed native messages must not act on a new or empty focused pane.
          app.newSwarm();
          await tester.pump();
          for (final args in [
            {'field': 'branch', 'paneId': pane.id},
            {'field': 'invalid', 'paneId': pane.id},
          ]) {
            await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
              channel.name,
              const StandardMethodCodec().encodeMethodCall(
                MethodCall('focusedContext', args),
              ),
              (_) {},
            );
            await tester.pump();
            expect(resourceField, findsNothing);
          }
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'status links emphasize text without a fill and activate from keyboard',
    (tester) async {
      final previousHighlight = FocusManager.instance.highlightStrategy;
      FocusManager.instance.highlightStrategy =
          FocusHighlightStrategy.alwaysTraditional;
      addTearDown(
        () => FocusManager.instance.highlightStrategy = previousHighlight,
      );
      var calls = 0;
      var enabled = true;
      late StateSetter rebuild;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                rebuild = setState;
                return WorkspaceBarControl(
                  label: 'Find harnesses on M2',
                  onPressed: enabled ? () => calls++ : null,
                  builder: (context, emphasized) => SizedBox(
                    width: 100,
                    height: 28,
                    child: Text(
                      'M2',
                      style: workspaceBarTextStyle(emphasized: emphasized),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      );
      final control = find.byType(WorkspaceBarControl);
      Finder highlights() =>
          find.descendant(of: control, matching: find.byType(ColoredBox));
      expect(highlights(), findsNothing);
      FontWeight? weight() =>
          tester.widget<Text>(find.text('M2')).style?.fontWeight;
      expect(weight(), FontWeight.normal);
      final rect = tester.getRect(control);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(control));
      await tester.pump();
      expect(highlights(), findsNothing);
      expect(weight(), FontWeight.bold);
      expect(tester.getRect(control), rect);
      await mouse.moveTo(const Offset(400, 400));
      await tester.pump();
      expect(highlights(), findsNothing);
      expect(weight(), FontWeight.normal);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(highlights(), findsNothing);
      expect(weight(), FontWeight.bold);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(calls, 1);
      rebuild(() => enabled = false);
      await tester.pump();
      expect(highlights(), findsNothing);
      expect(weight(), FontWeight.normal);
      await mouse.moveTo(tester.getCenter(control));
      await tester.pump();
      expect(weight(), FontWeight.normal);
      expect(tester.getRect(control), rect);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(calls, 1);
      await mouse.removePointer();
    },
  );
}
