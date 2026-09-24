import 'support/launch_menu.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_history.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp, MemoryStore;

class _Folders extends WsConn {
  _Folders(String id)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: id,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final paths = <String?>[];
  Completer<Map<String, dynamic>>? pendingHome;
  final pending = <String, Completer<Map<String, dynamic>>>{};

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    if (type != 'fs_list_dir') throw StateError('Unexpected request: $type');
    final path = payload['path'] as String?;
    paths.add(path);
    if (pending[path] case final reply?) return reply.future;
    if (path == null && pendingHome != null) return pendingHome!.future;
    return {
      'path': path ?? '/home/$machineId',
      'entries': [
        if (path == '/home/$machineId/harnesses')
          {'name': 'payments-processing', 'isDir': true},
        if (path == '/home/$machineId/work')
          {'name': 'payments', 'isDir': true},
      ],
    };
  }
}

void main() {
  final input = find.byKey(const ValueKey('new-harness-input'));

  testWidgets(
    'remote folders refresh on revisit, retain matches, and never read on each keystroke',
    (tester) async {
      final folders = _Folders('m');
      final app = createApp(connectionForTest: (_) => folders);
      final box = NewHarnessController(app, machineId: 'm', engine: 'codex');
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.project);
      box.setQuery('/home/m/work/pa');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();
      expect(box.options.any((row) => row.title == 'payments'), true);
      final firstReads = folders.paths
          .where((path) => path == '/home/m/work')
          .length;
      for (final query in ['pay', 'paym', 'payments']) {
        box.setQuery('/home/m/work/$query');
      }
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        folders.paths.where((path) => path == '/home/m/work').length,
        firstReads,
      );
      final reply = folders.pending['/home/m/work'] = Completer();
      box.focusField(NewHarnessField.projectMenu);
      box.focusField(NewHarnessField.project);
      box.setQuery('/home/m/work/pay');
      expect(box.options.any((row) => row.title == 'payments'), true);
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        folders.paths.where((path) => path == '/home/m/work').length,
        firstReads + 1,
      );
      reply.complete({
        'path': '/home/m/work',
        'entries': [
          {'name': 'payments', 'isDir': true},
          {'name': 'payments-api', 'isDir': true},
        ],
      });
      await tester.pump();
      expect(box.query, '/home/m/work/pay');
      expect(box.selected!.title, 'payments');
      expect(box.options.any((row) => row.title == 'payments-api'), true);
      final failed = folders.pending['/home/m/work'] = Completer();
      box.refreshChoices();
      await tester.pump(const Duration(milliseconds: 100));
      failed.complete({'error': 'UNREACHABLE'});
      await tester.pump();
      expect(box.options.any((row) => row.title == 'payments-api'), true);
      expect(box.choicesStatus, contains('Couldn’t refresh folders'));
      box.setQuery('');
      expect(box.canRefreshChoices, false);
      expect(box.choicesStatus, isNull);
    },
  );

  testWidgets('new project names refresh their parent folder on revisit', (
    tester,
  ) async {
    final folders = _Folders('m');
    final app = createApp(connectionForTest: (_) => folders);
    final box = NewHarnessController(app, machineId: 'm', engine: 'codex');
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    box.focusField(NewHarnessField.projectName);
    box.setQuery('toolbar');
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(box.options.single.title, 'Create toolbar');
    final firstReads = folders.paths
        .where((path) => path == '/home/m/harnesses')
        .length;
    final reply = folders.pending['/home/m/harnesses'] = Completer();
    box.focusField(NewHarnessField.projectMenu);
    box.focusField(NewHarnessField.projectName);
    for (final name in ['tool', 'toolba', 'toolbar']) {
      box.setQuery(name);
    }
    await tester.pump(const Duration(milliseconds: 100));
    expect(
      folders.paths.where((path) => path == '/home/m/harnesses').length,
      firstReads + 1,
    );
    reply.complete({
      'path': '/home/m/harnesses',
      'entries': [
        {'name': 'toolbar', 'isDir': true},
      ],
    });
    await tester.pump();
    expect(box.query, 'toolbar');
    expect(box.options.single.title, 'Open existing toolbar');
  });

  Future<void> mount(WidgetTester tester, NewHarnessController box) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 760,
              height: 420,
              child: NewHarnessForm(
                controller: box,
                onClose: () {},
                onCreated: () =>
                    fail('Reviewing a project must not create an agent'),
                onNeedsForm: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  void chooseMachine(NewHarnessController box) {
    box.focusField(NewHarnessField.projectMenu);
    box.focusField(NewHarnessField.machine);
  }

  testWidgets('the proposed project name can be replaced before accepting', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    addTearDown(app.dispose);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      autoProject: true,
      now: () => DateTime(2026, 9, 20, 17, 22, 19),
    );
    addTearDown(box.dispose);
    await mount(tester, box);
    await openLaunchRow(tester, 'project');
    box.accept(
      box.options.firstWhere(
        (row) => row.id == NewHarnessController.newProjectId,
      ),
    );
    await tester.pump();
    expect(box.query, 'codex-2026-09-20-17-22');
    await typeHarnessQuery(tester, 'design-system');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(box.projectLabel, '~/harnesses/design-system');
    expect(box.project.generated, isNull);
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'saved project history loads on first opening without replacing the draft',
    (tester) async {
      final store = MemoryStore();
      await ProjectHistory(store).select('m', '/work/last-session');
      final app = createApp(store: store);
      seedMixedAgents(app);
      addTearDown(app.dispose);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/current',
        task: 'Keep this task',
      );
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.projectMenu);
      await mount(tester, box);
      expect(
        box.options
            .where((row) => !row.synthetic)
            .map((row) => row.project?.folder)
            .take(2),
        ['/work/current', '/work/last-session'],
      );
      expect(box.project.folder, '/work/current');
      expect(box.task, 'Keep this task');
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpWidget(const SizedBox());
    },
  );

  test('recent projects include existing agents before any picker history', () {
    final app = createApp();
    seedMixedAgents(app);
    addTearDown(app.dispose);
    final machine = app.machineStates['m']!;
    machine.agents = [
      ...machine.agents,
      const Agent(id: 'local-metadata', name: 'Local project'),
      const Agent(id: 'duplicate', name: 'Same folder'),
      const Agent(id: 'worktree', name: 'Another checkout'),
      const Agent(id: 'missing-path', name: 'Unknown folder'),
    ];
    machine.localProjects = const {
      'local-metadata': AgentProject(name: 'website', cwd: '/work/website'),
      'duplicate': AgentProject(name: 'same', cwd: '/work/openharness/'),
      'worktree': AgentProject(
        name: 'openharness',
        cwd: '/work/openharness/.worktrees/design',
        root: '/work/openharness',
      ),
      'missing-path': AgentProject(name: 'unknown', cwd: ''),
    };
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/openharness',
    );
    addTearDown(box.dispose);
    expect(app.projectHistory.recent('m'), isEmpty);
    box.focusField(NewHarnessField.projectMenu);
    final recent = box.options.where((row) => !row.synthetic).toList();
    expect(recent.map((row) => row.project?.folder), [
      '/work/openharness',
      '/work/openharness/.worktrees/design',
      '/work/website',
      '/work/robotics',
      '/work/release-notes',
    ]);
    expect(recent.every((row) => row.machineId == 'm'), isTrue);
    box.focusField(NewHarnessField.project);
    // All recents live in the menu; the folder prompt does not repeat them.
    box.setQuery('release');
    expect(box.options.single.id, NewHarnessController.browseId);
    chooseMachine(box);
    box.setQuery('Office');
    box.accept();
    expect(
      box.options
          .where((row) => !row.synthetic)
          .map((row) => row.project?.folder),
      ['/work/helmet', '/work/openharness/.worktrees/keyboard'],
    );
  });

  testWidgets(
    'late project discovery refreshes an open menu without losing selection',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await app.projectHistory.select('m', '/work/chosen');
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/openharness',
      );
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.projectMenu);
      await mount(tester, box);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      final selected = box.selected?.id;
      final machine = app.machineStates['m']!;
      machine.agents = [
        ...machine.agents,
        const Agent(id: 'late', name: 'Late'),
      ];
      machine.localProjects = const {
        'late': AgentProject(name: 'product-video', cwd: '/work/product-video'),
      };
      app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 200));
      expect(
        box.options
            .where((row) => !row.synthetic)
            .map((row) => row.project?.folder),
        [
          '/work/openharness',
          '/work/chosen',
          '/work/product-video',
          '/work/robotics',
          '/work/release-notes',
        ],
      );
      expect(find.text('product-video'), findsOneWidget);
      expect(box.selected?.id, selected);
      var changes = 0;
      box.addListener(() => changes++);
      app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 200));
      expect(changes, 0);
      await typeHarnessQuery(tester, 'product video');
      await tester.pump();
      expect(box.selected!.project!.folder, '/work/product-video');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(box.project.folder, '/work/product-video');
      expect(find.byType(NewHarnessForm), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  test(
    'Project filters names and paths and restores the query after a child',
    () async {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await app.projectHistory.select('m', '/work/team/payments-processing');
      await app.projectHistory.select('m', '/work/notes-19');
      await app.projectHistory.select('studio', '/work/remote-payments');
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/current',
      );
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.projectMenu);
      final total = box.total;
      for (final query in [
        'PAYMENTS PROCESSING',
        'payments_processing',
        '/work/team/payments',
      ]) {
        box.setQuery(query);
        expect(box.selected!.project!.folder, '/work/team/payments-processing');
        expect(box.matchCount, 1);
        expect(box.total, total);
        expect(box.options.where((row) => row.synthetic), hasLength(3));
      }
      box.setQuery('19');
      expect(box.selected!.project!.folder, '/work/notes-19');
      box.setQuery('no-matching-project');
      expect(box.matchCount, 0);
      expect(box.selected!.id, NewHarnessController.existingProjectId);
      box.accept();
      expect(box.field, NewHarnessField.project);
      box.setQuery('/some/other/path');
      box.back();
      expect(box.field, NewHarnessField.projectMenu);
      expect(box.query, 'no-matching-project');
      expect(box.project.folder, '/work/current');
      box.focusField(NewHarnessField.machine);
      box.setQuery('Office');
      box.accept();
      expect(box.field, NewHarnessField.projectMenu);
      expect(box.query, isEmpty);
      box.setQuery('payments');
      expect(box.selected!.project!.folder, '/work/remote-payments');
      expect(
        box.options
            .where((row) => !row.synthetic)
            .every((row) => row.machineId == 'studio'),
        isTrue,
      );
    },
  );

  testWidgets(
    'missing project asks once, names it explicitly, and returns to launch',
    (tester) async {
      final app = createApp(connectionForTest: (id) => _Folders(id));
      seedMixedAgents(app);
      final box = NewHarnessController(app, machineId: 'm', engine: 'codex');
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      await mount(tester, box);
      expect(box.field, NewHarnessField.projectMenu);
      expect(box.needsProject, isTrue);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('Choose a project'));
      box.accept(
        box.options.firstWhere(
          (row) => row.id == NewHarnessController.newProjectId,
        ),
      );
      await tester.pump();
      expect(box.field, NewHarnessField.projectName);
      expect(box.query, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(box.error, 'Type a project name.');
      await typeHarnessQuery(tester, 'payments processing');
      await tester.pump();
      expect(find.text('Create payments-processing'), findsOneWidget);
      expect(box.query, 'payments processing');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(box.project.name, 'payments processing');
      expect(
        box.projectFolderRequest!.payload['projectName'],
        'payments-processing',
      );
      expect(box.needsProject, isFalse);
      // Clearing the prefilled name cannot launch in the old project.
      await openLaunchRow(tester, 'project');
      await tester.pump();
      box.accept(
        box.options.firstWhere(
          (row) => row.id == NewHarnessController.newProjectId,
        ),
      );
      await tester.pump();
      expect(box.query, 'payments processing');
      await typeHarnessQuery(tester, '');
      await tester.pump();
      expect(await box.createNow(), NewHarnessOutcome.failed);
      expect(box.error, 'Type a project name.');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(box.field, NewHarnessField.projectMenu);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(box.project.name, 'payments processing');
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpWidget(const SizedBox());
    },
  );

  test(
    'recent projects are chosen directly and invalid names cannot create',
    () async {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await app.projectHistory.select('studio', '/work/payments-processing');
      final box = NewHarnessController(
        app,
        machineId: 'studio',
        engine: 'codex',
      );
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.projectMenu);
      final recent = box.options.singleWhere(
        (row) => row.project?.folder == '/work/payments-processing',
      );
      expect(recent.title, 'payments-processing');
      box.accept(recent);
      expect(box.machineId, 'studio');
      expect(box.project.folder, '/work/payments-processing');
      box.focusField(NewHarnessField.projectName);
      box.setQuery('---');
      final fresh = box.options.singleWhere((row) => row.id == 'project:new');
      expect(fresh.enabled, isFalse);
      box.accept(fresh);
      expect(box.field, NewHarnessField.projectName);
      expect(box.project.folder, '/work/payments-processing');
      expect(box.error, contains('letters or numbers'));
    },
  );

  testWidgets(
    'launch rows open focused prompts and Enter returns to the launch summary',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'claude',
        folder: '/work/payments',
        task: 'Review the retry path',
      );
      addTearDown(box.dispose);
      addTearDown(app.dispose);
      await mount(tester, box);
      final agent = find.byKey(const ValueKey('new-harness-field-agent'));
      final project = find.byKey(const ValueKey('new-harness-field-project'));
      expect(
        tester.getRect(agent).top,
        greaterThan(tester.getRect(project).top),
      );
      expect(input, findsNothing);
      expect(find.text(box.projectLabel), findsOneWidget);
      expect(find.text('M2'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('new-harness-field-machine')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('new-harness-field-mode')),
        findsNothing,
      );
      expect(find.text('Auto-approve'), findsOneWidget);
      for (final (name, field) in [
        ('agent', NewHarnessField.agent),
        ('machine', NewHarnessField.machine),
        ('project', NewHarnessField.projectMenu),
      ]) {
        await openLaunchRow(tester, name);
        await tester.pump();
        expect(box.field, field);
        expect(
          FocusManager.instance.primaryFocus?.debugLabel,
          'new-harness-query',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(find.byType(NewHarnessForm), findsOneWidget);
      }
      await openLaunchRow(tester, 'project');
      await tester.pump();
      box.move(
        box.options.indexWhere(
              (row) => row.id == NewHarnessController.newProjectId,
            ) -
            box.cursor,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await typeHarnessQuery(tester, 'payments processing');
      await tester.pump();
      expect(find.text('Create payments-processing'), findsOneWidget);
      expect(box.query, 'payments processing');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(box.task, 'Review the retry path');
      expect(
        box.projectFolderRequest!.payload['projectName'],
        'payments-processing',
      );
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('machine changes retain each machine’s folder in the draft', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/payments',
      task: 'Keep this task',
    );
    addTearDown(box.dispose);
    addTearDown(app.dispose);
    await mount(tester, box);
    box.focusField(NewHarnessField.project);
    box.setQuery('payments processing');
    chooseMachine(box);
    await tester.pump();
    expect(box.field, NewHarnessField.machine);
    box.back();
    await tester.pump();
    expect(box.field, NewHarnessField.projectMenu);
    expect(box.query, isEmpty);
    chooseMachine(box);
    box.setQuery('Office');
    await tester.pump();
    box.accept();
    await tester.pump();
    expect(box.field, NewHarnessField.projectMenu);
    expect(box.machineId, 'studio');
    expect(box.project.folder, isNull);
    expect(box.query, isEmpty);
    expect(box.task, 'Keep this task');
    box.setFolder('/work/remote-payments');
    expect(find.byType(NewHarnessForm), findsOneWidget);
    box.focusField(NewHarnessField.project);
    chooseMachine(box);
    box.setQuery('M2');
    box.accept();
    expect(box.machineId, 'm');
    expect(box.project.folder, '/work/payments');
    // This cache travels with the draft through Escape and More options.
    final restored = NewHarnessController(
      app,
      machineId: 'm',
      draft: box.draft,
    );
    addTearDown(restored.dispose);
    restored.focusField(NewHarnessField.machine);
    restored.setQuery('Office');
    restored.accept();
    expect(restored.project.folder, '/work/remote-payments');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pumpWidget(const SizedBox());
  });

  test(
    'project choices belong only to the selected machine, including stale rows',
    () async {
      final app = createApp();
      seedMixedAgents(app);
      await app.projectHistory.select('m', '/work/payments');
      await app.projectHistory.select('studio', '/work/payments');
      await app.projectHistory.select('build', '/work/payments');
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/payments',
      );
      addTearDown(box.dispose);
      addTearDown(app.dispose);
      box.focusField(NewHarnessField.projectMenu);
      final recents = box.options
          .where((row) => row.project?.folder == '/work/payments')
          .toList();
      expect(recents, hasLength(1));
      expect(recents.single.machineId, 'm');
      chooseMachine(box);
      box.setQuery('build');
      box.accept();
      expect(box.field, NewHarnessField.machine);
      expect(box.error, contains('offline'));
      box.setQuery('Office');
      box.accept();
      expect(box.machineId, 'studio');
      expect(box.field, NewHarnessField.projectMenu);
      final remote = box.options.singleWhere(
        (row) => row.project?.folder == '/work/payments',
      );
      expect(remote.machineId, 'studio');
      expect(remote.detail, 'iMac · Office:/work/payments');
      box.accept(recents.single);
      expect(box.machineId, 'studio');
      expect(box.error, contains('machine has changed'));
      box.accept(remote);
      expect(box.project.folder, '/work/payments');
      expect(box.field, NewHarnessField.launch);
    },
  );

  testWidgets(
    'remote home resolves tilde completion and an existing named project',
    (tester) async {
      final connections = <String, _Folders>{};
      final app = createApp(
        connectionForTest: (id) =>
            connections.putIfAbsent(id, () => _Folders(id)),
      );
      seedMixedAgents(app);
      final box = NewHarnessController(
        app,
        machineId: 'studio',
        engine: 'claude',
        folder: '/home/studio/work/payments',
        home: '/local-only-home',
      );
      addTearDown(box.dispose);
      addTearDown(app.dispose);
      await mount(tester, box);
      expect(box.projectLocation, 'iMac · Office:~/work/payments');
      box.focusField(NewHarnessField.project);
      box.setQuery('~/work/pa');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();
      expect(box.options.first.id, NewHarnessController.browseId);
      expect(box.selected!.project!.folder, '/home/studio/work/payments');
      expect(box.complete(), '~/work/payments/');
      box.focusField(NewHarnessField.projectName);
      box.setQuery('payments processing');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();
      final row = box.options.firstWhere((row) => row.id == 'project:new');
      expect(row.title, 'Open existing payments-processing');
      expect(row.detail, 'iMac · Office:~/harnesses/payments-processing');
      box.accept(row);
      expect(box.project.folder, '/home/studio/harnesses/payments-processing');
      expect(box.projectFolderRequest, isNull);
      expect(connections['studio']!.paths, contains('/home/studio/work'));
      expect(
        connections['studio']!.paths.any(
          (path) => path?.startsWith('/local-only-home') == true,
        ),
        isFalse,
      );
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a late home answer does not move a project to the previous machine',
    (tester) async {
      final local = _Folders('m')
        ..pendingHome = Completer<Map<String, dynamic>>();
      final remote = _Folders('studio');
      final app = createApp(
        connectionForTest: (id) => id == 'm' ? local : remote,
      );
      seedMixedAgents(app);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/home/m/payments',
      );
      addTearDown(box.dispose);
      addTearDown(app.dispose);
      await mount(tester, box);
      box.focusField(NewHarnessField.machine);
      box.setQuery('Office');
      box.accept();
      box.setFolder('/home/studio/payments');
      await tester.pump();
      local.pendingHome!.complete({'path': '/home/m', 'entries': []});
      await tester.pump();
      expect(box.machineId, 'studio');
      expect(box.projectLocation, 'iMac · Office:~/payments');
      expect(find.byType(NewHarnessForm), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpWidget(const SizedBox());
    },
  );
}
