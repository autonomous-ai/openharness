import 'support/launch_menu.dart';

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/core/repository_clone.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:path/path.dart' as p;

import 'support/mixed_agents.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _Request {
  _Request(this.type, this.payload);
  final String type;
  final Map<String, dynamic> payload;
}

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final calls = <_Request>[];

  /// The first create's reply is lost, as a dropped connection loses it.
  bool loseFirstReply = false;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'fs_list_dir') return {};
    calls.add(_Request(type, Map.of(payload)));
    if (type == 'agent_create' && loseFirstReply) {
      loseFirstReply = false;
      throw const WsRequestTimeout('agent_create');
    }
    if (type == 'agent_create' || type == 'agent_create_status') {
      return {
        'creationId': payload['creationId'],
        'state': 'created',
        'agent': {'id': 'made', 'name': 'Made', 'engine': payload['engine']},
      };
    }
    return {};
  }
}

/// The rows of a list without the ever-present way out by mouse.
Iterable<String> found(NewHarnessController box) => box.options
    .where(
      (option) =>
          option.id != NewHarnessController.browseId &&
          option.id != NewHarnessController.changeMachineId,
    )
    .map((option) => option.title);

void main() {
  test('a named new project gets that folder, and never a changed name', () async {
    final root = await Directory.systemTemp.createTemp('harness-named-test-');
    addTearDown(() => root.delete(recursive: true));
    const request = ProjectFolderRequest.newProject(name: 'My Game! v2');
    expect(request.folderName, 'My-Game-v2');
    expect(request.payload, {
      'projectSource': 'new',
      'projectName': 'My-Game-v2',
    });
    final folder = await request.prepareLocal(projectHome: root.path);
    expect(p.basename(folder), 'My-Game-v2');
    expect(Directory(folder).existsSync(), isTrue);
    // Asking again is refused rather than answered with "My-Game-v2-2".
    await expectLater(
      request.prepareLocal(projectHome: root.path),
      throwsA(
        isA<RepositoryCloneException>().having(
          (error) => error.message,
          'message',
          contains('already exists'),
        ),
      ),
    );
    // A name with nothing usable in it is no name: the clock names the folder.
    expect(projectFolderSlug('  ../..  '), isNull);
    expect(projectFolderSlug('~/x'), 'x');
    expect(const ProjectFolderRequest.newProject(name: '///').payload, {
      'projectSource': 'new',
    });
  });

  test('the line starts as another of the pane you were in', () {
    final app = createApp();
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/auth',
      home: '/work',
    );
    addTearDown(box.dispose);
    expect(box.engine, 'codex');
    expect(box.machineId, 'm');
    expect(box.project, const NewHarnessProject.folder('/work/auth'));
    // The inherited arguments are ready to launch immediately.
    expect(box.field, NewHarnessField.launch);
    expect(box.options, isEmpty);
    expect(box.returnCreates, isTrue);
    box.focusField(NewHarnessField.task);
    box.setQuery('fix the flaky login test');
    expect(box.task, 'fix the flaky login test');
    expect(box.returnCreates, isTrue);
    // Tab steps out to who; the task is kept, and is back on the way round.
    box.nextField();
    expect(box.field, NewHarnessField.agent);
    expect(box.query, isEmpty);
    // The highlight opens on the line's own answer, which wears the ✓. In a
    // list Return chooses — one verb per field — and ⌘↵ makes it from here.
    expect(box.selected?.id, 'codex');
    expect(box.isCurrent(box.selected!), isTrue);
    expect(box.returnCreates, isFalse);
    box.nextField(-1);
    expect(box.field, NewHarnessField.task);
    expect(box.query, 'fix the flaky login test');
  });

  test('the main loop follows Agent, Project, Task and modes remain available to advanced drafts', () {
    final app = createApp();
    final box = NewHarnessController(app, machineId: 'm', engine: 'claude');
    addTearDown(box.dispose);
    expect(box.fields, [
      NewHarnessField.agent,
      NewHarnessField.machine,
      NewHarnessField.projectMenu,
      NewHarnessField.task,
    ]);
    box.focusField(NewHarnessField.mode);
    expect(box.options.where(box.isCurrent).single.id, 'auto');
    box.setQuery('plan');
    box.accept();
    expect(box.mode, 'plan');
    // A destination is still required before this command can launch.
    expect(box.field, NewHarnessField.projectMenu);
    // A terminal is a shell: nothing to tell it, nothing to permit.
    box.focusField(NewHarnessField.agent);
    box.setQuery('terminal');
    box.accept();
    expect(box.isTerminal, isTrue);
    expect(box.fields, [
      NewHarnessField.agent,
      NewHarnessField.machine,
      NewHarnessField.projectMenu,
    ]);
  });

  test('the project field offers a clone, and a way in without typing', () {
    final app = createApp();
    final box = NewHarnessController(app, machineId: 'm', engine: 'claude');
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.project);
    expect(
      box.options.any((row) => row.id == NewHarnessController.browseId),
      isTrue,
    );
    expect(box.options.any((row) => row.id == 'project:new'), isFalse);
    box.focusField(NewHarnessField.projectRepository);
    box.setQuery('acme/rocket');
    // Repository input is dedicated to cloning, never creating a blank folder.
    expect(box.options.any((row) => row.id == 'project:new'), isFalse);
    expect(box.options.first.title, 'Clone rocket');
    box.accept(box.options.first);
    expect(box.project.repository?.name, 'rocket');
    expect(box.projectLabel, '~/harnesses/rocket');
    // The system chooser's answer lands as the folder.
    box.setFolder('/work/picked');
    expect(box.project, const NewHarnessProject.folder('/work/picked'));
  });

  test('typing filters the field, Return takes the row and moves along', () {
    final app = createApp();
    final box = NewHarnessController(app, machineId: 'm', engine: 'codex');
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.agent);
    box.setQuery('clau');
    expect(box.selected!.id, 'claude');
    expect(box.returnCreates, isFalse);
    box.accept();
    expect(box.engine, 'claude');
    // With no destination yet, ask for the missing project.
    expect(box.field, NewHarnessField.projectMenu);
    expect(box.returnCreates, isFalse);
    box.focusField(NewHarnessField.projectName);
    expect(box.query, isEmpty);
    // A plain word names a new project; it is the first thing offered when
    // no folder matches it.
    box.setQuery('my game');
    expect(box.options.first.title, 'Create my-game');
    box.accept();
    expect(box.project, const NewHarnessProject.fresh('my game'));
    expect(box.projectLabel, '~/harnesses/my-game');
    expect(box.field, NewHarnessField.launch);
  });

  test('Tab completes a machine without committing it, including repeats', () {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final box = NewHarnessController(
      app,
      machineId: 'elsewhere',
      engine: 'codex',
      folder: '/work/repo',
    );
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.machine);
    for (var i = 0; i < 12; i++) {
      box.complete();
      expect(box.machineId, 'elsewhere');
      expect(box.project.folder, '/work/repo');
      expect(box.field, NewHarnessField.machine);
    }
    box.accept();
    expect(box.machineId, 'm');
    expect(box.field, NewHarnessField.launch);
    expect(box.needsProject, isTrue);
  });

  test(
    'Escape gives a Tab walk its typed stem back before it closes',
    () async {
      final root = await Directory.systemTemp.createTemp('box-walk');
      addTearDown(() => root.delete(recursive: true));
      for (final name in ['alpha', 'beta']) {
        await Directory('${root.path}/$name').create();
      }
      final app = createApp();
      app.machineStates['m']!.localOnly = true;
      final box = NewHarnessController(app, machineId: 'm', home: root.path);
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.project);
      box.setQuery('~/');
      // The listing is read off the disk, then the field refreshes itself.
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(box.endCompletion(), isFalse);
      // A bare `~/` is what is IN home, not home's own row in its parent.
      expect(
        [
          for (final option in box.options)
            if (!option.synthetic) option.title,
        ],
        ['alpha', 'beta'],
      );
      expect(box.complete(), '~/alpha');
      expect(box.endCompletion(), isTrue);
      expect(box.query, '~/');
      expect(box.endCompletion(), isFalse);
    },
  );

  test('a typed path completes like a shell', () async {
    final root = await Directory.systemTemp.createTemp('harness-path-test-');
    addTearDown(() => root.delete(recursive: true));
    await Directory(p.join(root.path, 'auth', 'api')).create(recursive: true);
    await Directory(p.join(root.path, 'authz')).create();
    await Directory(p.join(root.path, 'billing')).create();
    await Directory(p.join(root.path, '.hidden')).create();
    final app = createApp();
    app.machineStates['m']!.localOnly = true;
    final box = NewHarnessController(app, machineId: 'm', home: root.path);
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.project);
    box.setQuery('~/au');
    // The listing is read off the disk, then the field refreshes itself.
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(found(box), ['auth', 'authz']);
    expect((box.matchCount, box.total), (2, 3));
    // zsh's Tab: first as much as every candidate agrees on…
    expect(box.complete(), '~/auth');
    expect(found(box), ['auth', 'authz']);
    // …then, with nothing more to agree on, Tab walks a completion menu: each
    // candidate goes INTO the line while the list stays the stem's list…
    expect(box.complete(), '~/auth');
    expect(box.selected!.title, 'auth');
    expect(box.complete(), '~/authz');
    expect(box.selected!.title, 'authz');
    expect(found(box), ['auth', 'authz']);
    // …⇧⇥ walks it backwards…
    expect(box.complete(-1), '~/auth');
    expect(box.selected!.title, 'auth');
    // …and a slash goes into the one in the line, as a completion menu's does.
    box.setQuery('~/auth/');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(found(box), ['auth', 'api']);
    // One folder left: Tab goes into it.
    box.setQuery('~/auth/a');
    expect(box.complete(), '~/auth/api/');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    box.setQuery('~/auth/');
    box.accept(box.options.firstWhere((option) => option.title == 'api'));
    expect(
      box.project,
      NewHarnessProject.folder(p.join(root.path, 'auth', 'api')),
    );
    expect(box.projectLabel, '~/auth/api');
  });

  test('Return sends one create, with the project name when there is one', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'claude',
      projectName: 'my game',
    );
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.task);
    box.setQuery('  write the README  ');
    box.focusField(NewHarnessField.mode);
    box.setQuery('plan');
    box.accept();
    expect(await box.create(), NewHarnessOutcome.created);
    final create = connection.calls.singleWhere(
      (call) => call.type == 'agent_create',
    );
    // What was typed is the first message, exactly; the mode is the one picked.
    expect(create.payload['prompt'], 'write the README');
    expect(create.payload['permissionMode'], 'plan');
    expect(create.payload['bypassPermission'], isFalse);
    expect(create.payload['engine'], 'claude');
    expect(create.payload['projectSource'], 'new');
    expect(create.payload['projectName'], 'my-game');
    expect(create.payload.containsKey('cwd'), isFalse);
  });

  test(
    'a lost reply is checked on, never answered with a second harness',
    () async {
      final connection = _Connection()..loseFirstReply = true;
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'claude',
        folder: '/work',
      );
      addTearDown(box.dispose);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.checking, isTrue);
      expect(box.error, isNotNull);
      // The answers are frozen: what may already exist cannot be re-aimed.
      box.setQuery('codex');
      expect(box.query, isEmpty);
      expect(box.returnCreates, isTrue);
      expect(await box.create(), NewHarnessOutcome.created);
      expect(connection.calls.map((call) => call.type), [
        'agent_create',
        'agent_create_status',
      ]);
    },
  );

  testWidgets('⌘N opens the box over live panes, and Escape closes it', (
    tester,
  ) async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final app = createApp();
    seedMixedAgents(app);
    app.adoptSessionForTest(terminal('a0', []));
    await app.addAgentToSwarm('m', 'a0');
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pump();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byKey(const ValueKey('new-harness-box')), findsOneWidget);
    // Attached to the workspace's bottom edge, without dimming or resizing it.
    final dock = tester.getRect(find.byKey(const ValueKey('new-harness-box')));
    expect(dock.left, 6);
    expect(dock.right, tester.view.physicalSize.width - 6);
    expect(dock.bottom, tester.view.physicalSize.height - 6);
    expect(find.byKey(const ValueKey('new-harness-input')), findsNothing);
    expect(
      FocusManager.instance.primaryFocus!.debugLabel,
      'New harness launch',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byKey(const ValueKey('new-harness-box')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  test('a typed task is never dropped without being said, on any path', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'claude',
      folder: '/work',
      task: 'fix the login test',
    );
    addTearDown(box.dispose);
    // ⌘↵ from the agent list, a shell highlighted: it used to go straight past
    // the notice and make the terminal with the task silently gone.
    box.focusField(NewHarnessField.agent);
    box.setQuery('terminal');
    expect(await box.createNow(), NewHarnessOutcome.failed);
    expect(box.error, contains('will not be sent'));
    expect(connection.calls.where((c) => c.type == 'agent_create'), isEmpty);
    // The second press means it.
    expect(await box.create(), NewHarnessOutcome.created);
    expect(
      connection.calls.singleWhere((c) => c.type == 'agent_create').payload,
      isNot(contains('prompt')),
    );
    // Opening on an agent that cannot take the seeded task says so at once.
    final shell = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'terminal',
      task: 'do the thing',
    );
    addTearDown(shell.dispose);
    expect(shell.error, contains('will not be sent'));
  });

  test('Return and ⌘↵ are never silent, and a dropped task is said', () async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = false;
    final box = NewHarnessController(app, machineId: 'm', engine: 'claude');
    addTearDown(box.dispose);
    // Nothing matches: Return says so instead of doing nothing.
    box.focusField(NewHarnessField.agent);
    box.setQuery('zzzz');
    expect(box.matchCount, 0);
    expect(box.selected, isNull);
    box.accept();
    expect(box.error, contains('Nothing matches'));
    expect(await box.createNow(), NewHarnessOutcome.failed);
    expect(box.error, contains('Nothing matches'));
    expect(box.engine, 'claude');
    // An offline machine: Return says why, and ⌘↵ will not quietly make the
    // harness with the OLD answer while this one is lit.
    box.focusField(NewHarnessField.machine);
    box.setQuery('test');
    expect(box.selected!.enabled, isFalse);
    box.accept();
    expect(box.error, contains('offline'));
    expect(await box.createNow(), NewHarnessOutcome.failed);
    expect(box.error, contains('offline'));
    // A task typed for an agent that cannot take one is not dropped in silence.
    box.focusField(NewHarnessField.task);
    box.setQuery('fix the login test');
    box.focusField(NewHarnessField.agent);
    box.setQuery('terminal');
    box.accept();
    expect(box.error, contains('will not be sent'));
  });

  test('the arrows end a Tab walk', () async {
    final root = await Directory.systemTemp.createTemp('harness-cycle-test-');
    addTearDown(() => root.delete(recursive: true));
    for (final name in ['auth', 'authz', 'authn']) {
      await Directory(p.join(root.path, name)).create();
    }
    final app = createApp();
    app.machineStates['m']!.localOnly = true;
    final box = NewHarnessController(app, machineId: 'm', home: root.path);
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.project);
    box.setQuery('~/auth');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(box.complete(), '~/auth');
    expect(box.complete(), '~/authn');
    // Down leaves the walk: the line is what was typed again, and the
    // highlight stays where the arrow put it through the next refresh.
    box.move(1);
    expect(box.query, '~/auth');
    final moved = box.selected!.title;
    app.renameSwarm(app.activeSwarmId, 'a tick');
    expect(box.selected!.title, moved);
  });

  test(
    'the palette opens on what was run last, until something is typed',
    () async {
      final store = _MemoryStore();
      final history = SwarmNavigationHistory(storage: store);
      addTearDown(history.dispose);
      history.rememberCommand('pane.zoom');
      history.rememberCommand('app.settings');
      SwarmDestination command(String id, String title) => SwarmDestination(
        id: 'command:$id',
        title: title,
        detail: '',
        swarmId: null,
        current: false,
        commandId: id,
        searchFields: [id],
      );
      final app = createApp();
      final search = SwarmSearchController(
        app,
        const [],
        commandsOnly: true,
        commands: () => [
          command('agent.new', 'New Harness'),
          command('app.settings', 'Customize Harness'),
          command('pane.zoom', 'Zoom pane'),
        ],
        recentCommands: () => history.recentCommands,
      );
      addTearDown(search.dispose);
      expect(search.rows.map((row) => row.commandId), [
        'app.settings',
        'pane.zoom',
        'agent.new',
      ]);
      // Typing hands the order back to the match.
      search.setQuery('new');
      expect(search.rows.first.commandId, 'agent.new');
      // And it outlives a restart.
      await Future<void>.delayed(const Duration(milliseconds: 700));
      final next = SwarmNavigationHistory(storage: store);
      addTearDown(next.dispose);
      await next.load();
      expect(next.recentCommands, ['app.settings', 'pane.zoom']);
    },
  );

  test(
    'recent harnesses outlive a restart, and never reorder the present',
    () async {
      final store = _MemoryStore();
      await store.write(
        'swarm_recent_v1',
        '["agent:m\\u0000old","swarm:tab-7","agent:m\\u0000older",42]',
      );
      final history = SwarmNavigationHistory(storage: store);
      addTearDown(history.dispose);
      await history.load();
      // Harnesses only: a tab's id need not survive a launch, and junk is dropped.
      expect(history.recent, ['agent:m\u0000old', 'agent:m\u0000older']);
      // A second load adds nothing twice.
      await history.load();
      expect(history.recent, hasLength(2));
    },
  );

  test('? lists what the box can do, and the count says how much matches', () {
    final app = createApp();
    SwarmDestination mode(String id, String title) => SwarmDestination(
      id: 'command:$id',
      title: title,
      detail: 'where it goes',
      swarmId: null,
      current: false,
      commandId: id,
      searchFields: [id],
    );
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      offersCreate: true,
      modes: () => [
        mode('navigation.commands', '>  Commands'),
        mode('agent.new', 'New Harness'),
      ],
    );
    addTearDown(search.dispose);
    search.setQuery('?');
    expect(search.isHelpMode, isTrue);
    // In the order they are taught, with no create row and no preview.
    expect(search.rows.map((row) => row.title), ['>  Commands', 'New Harness']);
    expect(search.hasPreview, isFalse);
    expect(search.canAccept, isTrue);
    expect(search.actionLabel(search.selected), 'Open');
    expect(search.submit()?.destination.commandId, 'navigation.commands');
    // What follows `?` narrows them.
    search.setQuery('? new');
    expect(search.rows.single.commandId, 'agent.new');
    expect((search.matchCount, search.total), (1, 2));
    // Leaving `?` is leaving the mode.
    search.setQuery('zzz');
    expect(search.isHelpMode, isFalse);
    expect(search.matchCount, 0);
  });

  test('the box ends in a row that makes what was typed', () {
    final app = createApp();
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      offersCreate: true,
    );
    addTearDown(search.dispose);
    // Nothing typed: it leads, where the mouse can always find it — but the
    // box never opens WITH it selected when there is a harness to go back to.
    expect(search.rows.first.isCreate, isTrue);
    expect(search.rows.first.title, 'New Harness');
    expect(search.rows.length == 1 || !search.selected!.isCreate, isTrue);
    search.setQuery('zzz no such thing');
    expect(search.rows.single.isCreate, isTrue);
    // What was typed is what the new harness starts on, as an editor's
    // `New agent: "…"` row does.
    expect(search.rows.single.title, 'New Harness');
    expect(search.rows.single.detail, 'zzz no such thing');
    expect(search.createTask, 'zzz no such thing');
    expect(search.canAccept, isTrue);
    expect(search.actionLabel(search.selected), 'New Harness');
    // Commands never offer it.
    search.setQuery('> split');
    expect(search.rows.any((row) => row.isCreate), isFalse);
  });

  testWidgets('the box is driven from the keyboard', (tester) async {
    final app = createApp();
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/auth',
    );
    var closed = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 720,
              height: 420,
              child: NewHarnessBox(
                controller: box,
                onClose: () => closed++,
                onCreated: () {},
                onNeedsForm: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    final input = find.byKey(const ValueKey('new-harness-input'));
    expect(box.field, NewHarnessField.launch);
    expect(input, findsNothing);
    await openLaunchRow(tester, 'agent');
    await tester.pump();
    expect(box.field, NewHarnessField.agent);
    expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
    await tester.enterText(input, 'clau');
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(box.query, 'Claude Code');
    expect(box.engine, 'codex');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(box.engine, 'claude');
    expect(box.field, NewHarnessField.launch);
    await openLaunchRow(tester, 'task');
    await tester.pump();
    await tester.enterText(input, 'a project to test');
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(box.field, NewHarnessField.launch);
    expect(box.task, 'a project to test');
    expect(closed, 0);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    expect(closed, 1);
    await tester.pumpWidget(const SizedBox());
    box.dispose();
    app.dispose();
  });
}
