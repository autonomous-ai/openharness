import 'support/open_harness.dart';
import 'support/launch_menu.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/codex_profiles.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_interactions_test.dart' as interactions;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_screen_test.dart' as workspace;
import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection({this.profiles = const []})
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final List<Map<String, dynamic>> profiles;
  final requests =
      <
        ({
          String type,
          Map<String, dynamic> payload,
          Completer<Map<String, dynamic>> reply,
        })
      >[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'engines_probe') {
      return Future.value({
        'engines': [
          {
            'engine': 'codex',
            'installed': true,
            'supportsCodexHome': profiles.isNotEmpty,
          },
        ],
      });
    }
    if (type == 'codex_profiles_list') {
      return Future.value({'profiles': profiles});
    }
    if (type == 'fs_list_dir') {
      return Future.value({
        'path': payload['path'],
        'entries': [
          if (payload['path'] == '/work')
            {'name': 'space project', 'isDir': true},
        ],
      });
    }
    if (type != 'agent_create' && type != 'agent_create_status') {
      return Future.value({});
    }
    final reply = Completer<Map<String, dynamic>>();
    requests.add((type: type, payload: payload, reply: reply));
    return reply.future;
  }

  void created() {
    final request = requests.last;
    request.reply.complete({
      'creationId': request.payload['creationId'],
      'state': 'created',
      'agent': {'id': 'made', 'name': 'Made', 'engine': 'codex'},
    });
  }
}

SwarmSearchController picker(AppNotifier app, HarnessPlacement placement) =>
    SwarmSearchController(
      app,
      [],
      adding: true,
      offersCreate: true,
      placement: placement,
    );

AppNotifier? fixtureApp;

Future<void> mount(WidgetTester tester, AppNotifier app) async {
  fixtureApp = app;
  addTearDown(() => fixtureApp = null);
  app.gitProjectReaderForTest ??= (_, _) async => {'isGit': false};
  await app.agentPreference.remember('codex');
  await app.projectHistory.select('m', '/work/project');
  await workspace.mount(tester, app);
}

// Cmd-N resolves this computer first. The remaining placement fixture uses
// the fake daemon, so it must not prepare real folders or open native terminals.
Future<void> chord(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool shift = false,
}) async {
  final machine = fixtureApp?.machineStates['m'];
  if (key == LogicalKeyboardKey.keyN) machine?.localOnly = true;
  await interactions.chord(tester, key, shift: shift);
  if (key == LogicalKeyboardKey.keyN) machine?.localOnly = false;
}

void main() {
  for (final field in [NewHarnessField.agent, NewHarnessField.machine]) {
    test(
      'changing ${field.name} clears the profile before the next launch',
      () async {
        final connection = _Connection();
        final app = createApp(connectionForTest: (_) => connection);
        app.machineStates['m']!.nodeOnline = true;
        addTearDown(app.dispose);
        app.machineStates['remote'] = MachineState(
          const Machine(
            machineId: 'remote',
            name: 'Remote',
            authMode: MachineAuthMode.remote,
          ),
        )..nodeOnline = true;
        final box = NewHarnessController(
          app,
          machineId: 'm',
          draft: const NewHarnessDraft(
            machineId: 'm',
            engine: 'codex',
            project: NewHarnessProject.folder('/work/project'),
            task: 'Check the project',
            permissionMode: 'readOnly',
            profile: LocalCodexProfile('/work/.codex-work', 'Work'),
            profileChosen: true,
          ),
        );
        addTearDown(box.dispose);
        expect(box.profileLabel, 'Work');
        box.focusField(field);
        box.accept(
          NewHarnessOption(
            id: field == NewHarnessField.agent ? 'opencode' : 'remote',
            title: 'Other',
          ),
        );
        if (field == NewHarnessField.agent) {
          box.focusField(field);
          box.accept(const NewHarnessOption(id: 'codex', title: 'Codex'));
        }
        expect(box.profileLabel, isNull);
        expect(box.draft.profile, isNull);
        if (field == NewHarnessField.machine) {
          expect(box.needsProject, isTrue);
          box.setFolder('/work/remote-project');
        }
        await Future<void>.delayed(Duration.zero);
        final result = box.create();
        await Future<void>.delayed(Duration.zero);
        expect(
          connection.requests.single.payload.containsKey('codexHome'),
          isFalse,
        );
        connection.created();
        expect(await result, NewHarnessOutcome.created);
      },
    );
  }

  for (final (dismiss, profile) in [
    ('escape', 'Work'),
    ('outside', 'Default'),
    ('chooser', 'Work'),
  ]) {
    testWidgets(
      'setup with $profile profile handles $dismiss without starting',
      (tester) async {
        newHarnessOpensInBox = true;
        addTearDown(() => newHarnessOpensInBox = false);
        final connection = _Connection(
          profiles: [
            {'path': '/work/.codex-work', 'label': 'Work'},
          ],
        );
        final app = createApp(connectionForTest: (_) => connection);
        addTearDown(app.dispose);
        app.machineStates['m']!.nodeOnline = true;
        app.adoptSessionForTest(terminal('a0', []));
        final original = app.activeSwarm;
        await mount(tester, app);
        await chord(tester, LogicalKeyboardKey.keyN);
        var box = tester
            .widget<NewHarnessForm>(find.byType(NewHarnessForm))
            .controller;
        box.setFolder('/work/source');
        await tester.pump();
        final input = find.byKey(const ValueKey('new-harness-query'));
        box.task = '  Review before changing anything\nKeep the patch small  ';
        await tester.pump();
        await openLaunchRow(tester, 'mode');
        await tester.tap(
          find.byKey(const ValueKey('new-harness-option-readOnly')),
        );
        await tester.pump();
        await openLaunchRow(tester, 'profile');
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(
            ValueKey(
              profile == 'Default'
                  ? 'new-harness-option-${NewHarnessController.defaultProfileId}'
                  : 'new-harness-option-profile:/work/.codex-work',
            ),
          ),
        );
        await tester.pump();
        await openLaunchRow(tester, 'project');
        await tester.tap(
          find.byKey(
            const ValueKey(
              'new-harness-option-${NewHarnessController.repositoryId}',
            ),
          ),
        );
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        await tester.enterText(input, 'acme/terminal-tools');
        await tester.pump(const Duration(milliseconds: 250));
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(
          box.project.repository?.url,
          'https://github.com/acme/terminal-tools.git',
        );
        expect(find.byType(AlertDialog), findsNothing);
        if (dismiss == 'chooser') {
          await openLaunchRow(tester, 'model');
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pump();
          expect(harnessChoicesActive(tester), isFalse);
        } else {
          if (dismiss == 'escape') {
            await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          } else {
            await tester.tapAt(const Offset(4, 10));
          }
          await tester.pumpAndSettle();
          expect(find.byType(NewHarnessForm), findsNothing);
          await chord(tester, LogicalKeyboardKey.keyN);
          box = tester
              .widget<NewHarnessForm>(find.byType(NewHarnessForm))
              .controller;
          expect(box.task, isEmpty);
          expect(box.mode, 'auto');
          expect(box.profileLabel, isNot('Work'));
          expect(box.project.repository, isNull);
          expect(connection.requests, isEmpty);
          await tester.pumpWidget(const SizedBox());
          return;
        }
        expect(
          box.task,
          '  Review before changing anything\nKeep the patch small  ',
        );
        expect(box.mode, 'readOnly');
        expect(box.profileLabel, profile);
        expect(
          box.project.repository?.url,
          'https://github.com/acme/terminal-tools.git',
        );
        expect(connection.requests, isEmpty);
        await startHarness(tester);
        await tester.pump();
        final request = connection.requests.single;
        expect(request.payload['permissionMode'], 'readOnly');
        expect(
          request.payload['repositoryUrl'],
          'https://github.com/acme/terminal-tools.git',
        );
        expect(
          request.payload['prompt'],
          'Review before changing anything\nKeep the patch small',
        );
        expect(
          request.payload['codexHome'],
          profile == 'Default' ? null : '/work/.codex-work',
        );
        connection.created();
        await tester.pumpAndSettle();
        expect(app.swarms, contains(original));
        await chord(tester, LogicalKeyboardKey.keyN);
        expect(
          tester
              .widget<NewHarnessForm>(find.byType(NewHarnessForm))
              .controller
              .task,
          isEmpty,
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'an unresolved inline launch keeps its receipt and locks the draft',
    (tester) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      app.machineStates['m']!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      final box = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      box.setFolder('/work/source');
      await tester.pump();
      box.task = 'Keep this first task';
      await tester.pump();
      await startHarness(tester);
      await tester.pump();
      final request = connection.requests.single;
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.tapAt(const Offset(4, 10));
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsOneWidget);
      request.reply.completeError(const WsRequestTimeout('agent_create'));
      await tester.pumpAndSettle();
      expect(box.checking, isTrue);
      expect(box.field, NewHarnessField.launch);
      expect(harnessChoicesActive(tester), isFalse);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyW);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyU);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();
      expect(box.task, 'Keep this first task');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(connection.requests, hasLength(2));
      expect(connection.requests.last.type, 'agent_create_status');
      expect(
        connection.requests.last.payload['creationId'],
        request.payload['creationId'],
      );
      connection.created();
      await tester.pumpAndSettle();
      expect(find.byType(NewHarnessForm), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final (projectQuery, detail, preparation) in [
    (
      'Keyboard tools',
      'Keyboard-tools',
      {'projectSource': 'new', 'projectName': 'Keyboard-tools'},
    ),
    (
      'acme/super-terminal',
      'super-terminal',
      {
        'projectSource': 'remote',
        'repositoryUrl': 'https://github.com/acme/super-terminal.git',
      },
    ),
    ('/work/space project', 'space project', {'cwd': '/work/space project'}),
  ]) {
    testWidgets('settings retain the task, read-only mode, and $projectQuery', (
      tester,
    ) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      app.machineStates['m']!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', []));
      final original = app.activeSwarm;
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyT);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();
      final input = find.byKey(const ValueKey('new-harness-query'));
      tester
              .widget<NewHarnessForm>(find.byType(NewHarnessForm))
              .controller
              .task =
          'Review the project before changing anything';
      await tester.tap(find.byKey(const ValueKey('new-harness-field-project')));
      await tester.pump();
      await tester.tap(
        find.byKey(
          ValueKey(
            projectQuery.startsWith('/')
                ? 'new-harness-option-${NewHarnessController.existingProjectId}'
                : projectQuery.contains('/')
                ? 'new-harness-option-${NewHarnessController.repositoryId}'
                : 'new-harness-option-${NewHarnessController.newProjectId}',
          ),
        ),
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.enterText(input, projectQuery);
      await tester.pump(const Duration(milliseconds: 250));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await openLaunchRow(tester, 'mode');
      await tester.tap(
        find.byKey(const ValueKey('new-harness-option-readOnly')),
      );
      await tester.pumpAndSettle();
      final box = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      expect(box.mode, 'readOnly');
      await openLaunchRow(tester, 'mode');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AlertDialog), findsNothing);
      expect(box.projectLabel, contains(detail));
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('new-harness-field-approvals')),
          matching: find.text('Read only'),
        ),
        findsOneWidget,
      );
      expect(app.swarms, contains(original));
      expect(app.swarms, hasLength(2));
      await startHarness(tester);
      await tester.pump();
      final request = connection.requests.single;
      for (final field in preparation.entries) {
        expect(request.payload[field.key], field.value);
      }
      expect(request.payload['permissionMode'], 'readOnly');
      expect(request.payload['bypassPermission'], false);
      expect(
        request.payload['prompt'],
        'Review the project before changing anything',
      );
      connection.created();
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();
      expect(app.swarms, hasLength(2));
      expect(app.activeSwarm.name, 'Made');
      await chord(tester, LogicalKeyboardKey.keyN);
      expect(
        tester
            .widget<NewHarnessForm>(find.byType(NewHarnessForm))
            .controller
            .task,
        isEmpty,
        reason: 'A completed task must not reappear as a draft',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpWidget(const SizedBox());
    });
  }

  test('placement picker pins creation, searches only harnesses and focuses matches', () {
    final app = createApp();
    final search = picker(app, HarnessPlacement.currentTab);
    addTearDown(search.dispose);
    addTearDown(app.dispose);
    expect(search.selected!.isCreate, isTrue);
    expect(
      search.rows.every((row) => row.isCreate || row.agentId != null),
      isTrue,
    );
    search.setQuery('Agent 12');
    expect(search.rows.first.isCreate, isTrue);
    expect(search.selected!.agentId, 'a12');
    for (final query in ['> commands', '# projects', '@ machines']) {
      search.setQuery(query);
      expect(search.isCommandMode, query.startsWith('>'));
      expect(search.isHelpMode, isFalse);
      expect(search.createTask, isNull);
      expect(search.rows.any((row) => row.isCreate), query.startsWith('@'));
      if (query.startsWith('@')) {
        expect(search.rows.first.title, 'New Machine');
      }
    }
    search.setQuery('');
    expect(search.selected!.isCreate, isTrue);
  });

  test('new tab can open from a full tab; current tab can still focus an existing pane', () async {
    final app = createApp();
    addTearDown(app.dispose);
    for (var i = 0; i < AppNotifier.maxPanes; i++) {
      await app.addAgentToSwarm('m', 'a$i');
    }
    final pane = picker(app, HarnessPlacement.currentTab);
    final tab = picker(app, HarnessPlacement.newTab);
    addTearDown(pane.dispose);
    addTearDown(tab.dispose);
    expect(pane.canCreate, isFalse);
    pane.setQuery('Agent 0');
    expect(pane.canAccept, isTrue);
    expect(pane.actionLabel(pane.selected), 'Focus pane');
    expect(tab.canCreate, isTrue);
    expect(tab.selected!.isCreate, isTrue);
    expect(tab.capacity, AppNotifier.maxPanes);
    tab.setQuery('Agent 0');
    final selected = tab.selected!.id;
    expect(tab.changePlacement(HarnessPlacement.currentTab), isTrue);
    expect(tab.query, 'Agent 0');
    expect(tab.selected!.id, selected);
    expect(tab.capacity, 0);
    expect(tab.canCreate, isFalse);
    expect(tab.canAccept, isTrue);
    expect(tab.actionLabel(tab.selected), 'Focus pane');
    expect(tab.changePlacement(HarnessPlacement.newTab), isTrue);
    expect(tab.selected!.id, selected);
    expect(tab.capacity, AppNotifier.maxPanes);
    expect(tab.canCreate, isTrue);
    expect(tab.actionLabel(tab.selected), 'Open in new tab');
  });

  test(
    'new tab shares the running view; new pane focuses it without a duplicate',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final original = app.activeSwarm;
      await app.addAgentToSwarm('m', 'a0');
      final firstPane = original.panes.single;
      final search = picker(app, HarnessPlacement.newTab)..setQuery('Agent 0');
      final choice = search.submit()!;
      search.dispose();
      expect(
        await activateSwarmSearchSelection(
          app,
          choice,
          destinationSwarmId: original.id,
          placement: HarnessPlacement.newTab,
        ),
        isTrue,
      );
      expect(app.swarms, hasLength(2));
      expect(app.activeSwarm.name, 'Agent 0');
      expect(app.activeSwarm.toJson()['name'], 'Agent 0');
      expect(original.panes.single, same(firstPane));
      expect(app.panes.single, same(firstPane));
      final target = app.activeSwarmId;
      app.renameSwarm(target, 'Feature work');
      expect(
        await activateSwarmSearchSelection(
          app,
          choice,
          destinationSwarmId: target,
          placement: HarnessPlacement.currentTab,
        ),
        isTrue,
      );
      expect(app.panes, hasLength(1));
      expect(app.activeSwarm.name, 'Feature work');
      await app.closePane(firstPane.id);
      expect(original.panes.single, same(firstPane));
    },
  );

  test('a stale new-tab selection does not allocate a tab', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await app.addAgentToSwarm('m', 'a0');
    final original = app.activeSwarm;
    final search = picker(app, HarnessPlacement.newTab)..setQuery('Agent 12');
    final choice = search.submit()!;
    search.dispose();
    app.machineStates['m']!.agents.removeWhere((agent) => agent.id == 'a12');
    expect(
      await activateSwarmSearchSelection(
        app,
        choice,
        destinationSwarmId: original.id,
        placement: HarnessPlacement.newTab,
      ),
      isFalse,
    );
    expect(app.swarms, [original]);
  });

  test('harnesses on different machines auto tile in one tab', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await app.addAgentToSwarm('m', 'a0');
    const remote = Machine(
      machineId: 'remote',
      name: 'Build host',
      authMode: MachineAuthMode.remote,
    );
    app.machineStates['remote'] = MachineState(remote)
      ..nodeOnline = false
      ..agents = [
        Agent(
          id: 'a0',
          name: 'Remote feature',
          engine: 'codex',
          terminalAvailable: true,
        ),
      ];
    app.activeSwarm.presets[2] = PanePreset.rows;
    final search = picker(app, HarnessPlacement.currentTab)
      ..setQuery('Build host');
    final choice = search.submit()!;
    search.dispose();
    expect(
      await activateSwarmSearchSelection(
        app,
        choice,
        destinationSwarmId: app.activeSwarmId,
        placement: HarnessPlacement.currentTab,
      ),
      isTrue,
    );
    expect(app.panes.map((pane) => pane.machineId), ['m', 'remote']);
    expect(app.presetFor(2), PanePreset.defaultFor(2));
  });

  test(
    'new tab waits for a confirmed creation and recovery allocates once',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      await app.addAgentToSwarm('m', 'a0');
      final original = app.activeSwarm;
      final attempt = AgentCreationAttempt();
      Future<String?> create() => app.createAgent(
        'm',
        engine: 'codex',
        folder: '/work',
        swarmId: original.id,
        placement: HarnessPlacement.newTab,
        attempt: attempt,
      );
      final first = create();
      expect(app.swarms, [original]);
      connection.requests.single.reply.completeError(
        const WsRequestTimeout('agent_create'),
      );
      expect(await first, contains('Check status'));
      expect(app.swarms, [original]);
      final recovery = create();
      expect(connection.requests.last.type, 'agent_create_status');
      connection.created();
      expect(await recovery, isNull);
      expect(app.swarms, hasLength(2));
      expect(app.activeSwarm.name, 'Made');
      expect(app.panes.single.agentId, 'made');
      expect(await create(), isNull);
      expect(app.swarms, hasLength(2));
      expect(connection.requests, hasLength(2));
    },
  );

  test(
    'explicit pane placement also keeps domain harnesses in this tab',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      await app.addAgentToSwarm('m', 'a0');
      final original = app.activeSwarm;
      final creating = app.createAgent(
        'm',
        engine: 'codex',
        folder: '/work',
        dsh: 'blender',
        swarmId: original.id,
        placement: HarnessPlacement.currentTab,
      );
      connection.created();
      expect(await creating, isNull);
      expect(app.swarms, [original]);
      expect(app.panes.map((pane) => pane.agentId), ['a0', 'made']);
    },
  );

  test('a failed new-tab creation leaves the original layout intact', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    await app.addAgentToSwarm('m', 'a0');
    final original = app.activeSwarm;
    final creating = app.createAgent(
      'm',
      engine: 'codex',
      folder: '/missing',
      placement: HarnessPlacement.newTab,
    );
    final request = connection.requests.single;
    request.reply.complete({
      'creationId': request.payload['creationId'],
      'state': 'failed',
      'failure': {'code': 'CWD_NOT_FOUND'},
    });
    expect(await creating, contains('folder is unavailable'));
    expect(app.swarms, [original]);
    expect(original.panes.single.agentId, 'a0');
  });

  testWidgets(
    'new-tab creation keeps the task and pending receipt through picker shortcuts',
    (tester) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      app.machineStates['m']!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', []));
      final original = app.activeSwarm;
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyT);
      await openHarnessPicker(tester);
      final search = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(search, 'fix the login regression');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(connection.requests, isEmpty);
      await chord(tester, LogicalKeyboardKey.keyN);
      final box = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      expect(box.task, 'fix the login regression');
      expect(box.placement, HarnessPlacement.currentTab);
      box.setFolder('/work/project');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(box.busy, isTrue);
      expect(
        connection.requests.single.payload['prompt'],
        'fix the login regression',
      );

      Future<void> keepsPendingBox() async {
        expect(box.field, NewHarnessField.launch);
        expect(box.locked, isTrue);
        final task = box.task;
        await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyW);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyU);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await tester.pump();
        expect(box.task, task);
        for (final key in [
          LogicalKeyboardKey.keyP,
          LogicalKeyboardKey.keyT,
          LogicalKeyboardKey.period,
        ]) {
          await chord(tester, key);
          await tester.pump();
          expect(search, findsNothing);
          expect(find.byType(AlertDialog), findsNothing);
          expect(
            tester
                .widget<NewHarnessForm>(find.byType(NewHarnessForm))
                .controller,
            same(box),
          );
          expect(app.swarms, contains(original));
          expect(app.swarms, hasLength(2));
        }
        await tester.tapAt(const Offset(12, 650));
        await tester.pump();
        expect(
          tester.widget<NewHarnessForm>(find.byType(NewHarnessForm)).controller,
          same(box),
          reason:
              'Clicking outside must preserve an active or unresolved creation',
        );
      }

      await keepsPendingBox();
      connection.requests.single.reply.completeError(
        const WsRequestTimeout('agent_create'),
      );
      await tester.pump();
      expect(box.busy, isFalse);
      expect(box.checking, isTrue);
      await keepsPendingBox();
      expect(connection.requests, hasLength(1));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(connection.requests.last.type, 'agent_create_status');
      connection.created();
      await tester.pump();
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(app.swarms, hasLength(2));
      expect(app.activeSwarm.name, 'Made');
      expect(app.panes.single.agentId, 'made');
      expect(original.panes.single.agentId, 'a0');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    },
  );

  testWidgets(
    'a dismissed pending creation resumes its receipt even without a task',
    (tester) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      app.machineStates['m']!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', []));
      final original = app.activeSwarm;
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyT);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();
      tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller
          .setFolder('/work/project');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      final request = connection.requests.single;
      expect(request.payload.containsKey('prompt'), isFalse);
      request.reply.completeError(const WsRequestTimeout('agent_create'));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsNothing);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();
      final box = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      expect(box.task, isEmpty);
      expect(box.checking, isTrue);
      expect(find.text('pending harness'), findsNothing);
      expect(
        find.textContaining('Check status', findRichText: true),
        findsOneWidget,
      );
      // The restored "Escape again" warning keeps its meaning; it must not
      // require another invisible acknowledgement before closing.
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsNothing);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(connection.requests, hasLength(2));
      expect(connection.requests.last.type, 'agent_create_status');
      expect(
        connection.requests.last.payload['creationId'],
        request.payload['creationId'],
      );
      connection.created();
      await tester.pumpAndSettle();
      // A submitted request keeps its original destination; this was a status
      // check, not another launch with the new chooser's placement.
      expect(app.swarms, hasLength(2));
      expect(app.activeSwarm.name, 'Made');
      expect(original.panes.single.agentId, 'a0');
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final placement in HarnessPlacement.values) {
    testWidgets(
      '${placement.title} keeps its tab on Escape and uses the saved local creation context',
      (tester) async {
        newHarnessOpensInBox = true;
        addTearDown(() => newHarnessOpensInBox = false);
        final app = createApp();
        addTearDown(app.dispose);
        app.machineStates['m']!.agents[0] = Agent(
          id: 'a0',
          name: 'Feature',
          engine: 'codex',
          terminalAvailable: true,
          project: const AgentProject(name: 'Project', cwd: '/work/project'),
        );
        app.adoptSessionForTest(terminal('a0', []));
        await app.addAgentToSwarm('m', 'a0');
        final original = app.activeSwarm;
        await mount(tester, app);
        if (placement == HarnessPlacement.newTab) {
          await chord(tester, LogicalKeyboardKey.keyT);
        }
        await openHarnessPicker(tester);
        await tester.pump();
        expect(app.swarms, contains(original));
        expect(app.swarms.length, placement == HarnessPlacement.newTab ? 2 : 1);
        // No chooser titled after the placement. An empty tab is itself
        // called "New Tab", so its own name in the strip does not count.
        bool inTab(Element element) {
          var inside = false;
          element.visitAncestorElements((ancestor) {
            final key = ancestor.widget.key;
            inside =
                key is ValueKey<String> &&
                app.swarms.any((swarm) => swarm.id == key.value);
            return !inside;
          });
          return inside;
        }

        expect(
          find.text(placement.title).evaluate().where((e) => !inTab(e)),
          isEmpty,
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(app.swarms.length, placement == HarnessPlacement.newTab ? 2 : 1);
        if (placement == HarnessPlacement.newTab) {
          await chord(tester, LogicalKeyboardKey.keyW);
        }
        expect(app.swarms, [original]);
        if (placement == HarnessPlacement.newTab) {
          await chord(tester, LogicalKeyboardKey.keyT);
        }
        await openHarnessPicker(tester);
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(find.byType(NewHarnessForm), findsNothing);
        await chord(tester, LogicalKeyboardKey.keyN);
        final box = tester
            .widget<NewHarnessForm>(find.byType(NewHarnessForm))
            .controller;
        expect(box.placement, HarnessPlacement.currentTab);
        expect(box.engine, 'codex');
        expect(box.machineId, 'm');
        expect(box.project.folder, '/work/project');
        expect(app.swarms, contains(original));
        expect(app.swarms.length, placement == HarnessPlacement.newTab ? 2 : 1);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(app.swarms.length, placement == HarnessPlacement.newTab ? 2 : 1);
        expect(app.swarms, contains(original));
        // The creation box was opened from a search editor that is now gone.
        // Returning focus to that detached editor would disable shortcuts.
        expect(find.byType(NewHarnessForm), findsNothing);
        await chord(tester, LogicalKeyboardKey.keyP);
        expect(
          find.byKey(const ValueKey('swarm-search-input')),
          findsOneWidget,
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'Cmd-N starts from the default branch, not the pane\'s, which is one pick away',
    (tester) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final app = createApp();
      addTearDown(app.dispose);
      app.gitProjectReaderForTest = (_, _) async => {
        'isGit': true,
        'root': '/work/project',
        'branch': 'main',
        'defaultRef': 'refs/remotes/origin/main',
        'branches': [
          {
            'ref': 'refs/heads/main',
            'name': 'main',
            'worktree': '/work/project',
          },
          {
            'ref': 'refs/heads/feature/pay',
            'name': 'feature/pay',
            'worktree': '/wt/pay',
          },
          {
            'ref': 'refs/remotes/origin/main',
            'name': 'origin/main',
            'remote': true,
          },
        ],
      };
      // The focused agent works on a branch of its own, in its own worktree.
      app.machineStates['m']!.agents[0] = Agent(
        id: 'a0',
        name: 'Payments',
        engine: 'codex',
        terminalAvailable: true,
        project: const AgentProject(
          name: 'project',
          cwd: '/work/project',
          root: '/work/project',
          branch: 'feature/pay',
        ),
      );
      app.adoptSessionForTest(terminal('a0', []));
      await app.addAgentToSwarm('m', 'a0');
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();
      await tester.pump();
      final box = tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller;
      expect(
        box.engine,
        'codex',
        reason: 'The successful local defaults are used.',
      );
      expect(box.project.folder, '/work/project');
      expect(box.branchRef, 'refs/heads/main', reason: 'New work, from main.');
      expect(box.createLabel, 'Start Harness');
      box.focusField(NewHarnessField.branch);
      box.accept(box.options.firstWhere((row) => row.title == 'feature/pay'));
      expect(box.opensWorktree, true);
      expect(box.createLabel, 'Start Harness');
      await tester.pumpWidget(const SizedBox());
    },
  );
}
