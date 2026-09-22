import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/git_worktree.dart';
import 'package:harness/core/models.dart';
import 'package:harness/e2ee/envelope.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/ws/ws_conn.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/launch_menu.dart';
import 'swarm_state_test.dart' show createApp;

const _git = <String, dynamic>{
  'isGit': true,
  'branch': 'main',
  'branches': [
    {'ref': 'refs/heads/main', 'name': 'main'},
    {'ref': 'refs/heads/feature', 'name': 'feature'},
    {'ref': 'refs/remotes/origin/main', 'name': 'origin/main', 'remote': true},
  ],
};

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
  final starts = <Map<String, dynamic>>[];
  final reads = <String>[];
  final pending = <String, Completer<Map<String, dynamic>>>{};
  final answers = <String, Map<String, dynamic>>{};
  Map<String, dynamic>? failure;
  bool loseReply = false;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'git_project_info') {
      final path = payload['path'] as String;
      reads.add(path);
      return pending[path]?.future ??
          Future.value(
            answers[path] ?? (path == '/plain' ? {'isGit': false} : _git),
          );
    }
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'fs_list_dir') return {'path': '/home/user', 'entries': []};
    if (type == 'agent_create') {
      starts.add(Map.of(payload));
      if (loseReply) {
        loseReply = false;
        throw const WsRequestTimeout('agent_create');
      }
      if (failure != null) {
        return {
          'creationId': payload['creationId'],
          'state': 'failed',
          ...failure!,
        };
      }
    }
    if (type == 'agent_create' || type == 'agent_create_status') {
      return {
        'creationId': payload['creationId'],
        'state': 'created',
        'agent': {
          'id': 'created',
          'name': 'Created',
          'engine': 'codex',
          'project': {
            'name': 'repo',
            'cwd':
                payload['cwd'] ??
                '/home/user/harnesses/worktrees/repo/codex-0922-1136',
          },
        },
      };
    }
    return {};
  }
}

void main() {
  test(
    'Git metadata uses encrypted requests on clients without a local CLI',
    () {
      expect(encryptedDownTypes, contains('git_project_info'));
    },
  );

  Future<void> settle() => Future<void>.delayed(Duration.zero);
  test('Git defaults follow the project, late replies are ignored, and draft choices survive', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/repo',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    await settle();
    expect(box.worktree, true);
    expect(box.branchRef, 'refs/heads/main');
    expect(box.placeholder, matches(RegExp(r'^harness/[a-z]+-[a-z]+$')));
    expect(box.draft.projectFolderRequest!.payload, {
      'projectSource': 'worktree',
      'gitSource': '/repo',
      'branchRef': 'refs/heads/main',
      'branchName': box.placeholder,
      'branchMode': 'placeholder',
    });
    box.toggleWorktree();
    expect(box.worktree, false);
    box.focusField(NewHarnessField.branch);
    box.setQuery('feature');
    box.accept();
    expect(box.projectFolderRequest!.payload, {
      'projectSource': 'branch',
      'gitSource': '/repo',
      'branchRef': 'refs/heads/feature',
    });
    final restored = NewHarnessController(
      app,
      machineId: 'm',
      draft: box.draft,
    );
    addTearDown(restored.dispose);
    await settle();
    expect(restored.worktree, false);
    expect(restored.branchLabel, 'feature');
    expect(
      restored.projectFolderRequest!.payload,
      box.draft.projectFolderRequest!.payload,
    );
    final slow = connection.pending['/slow'] = Completer();
    box.setFolder('/slow');
    box.setFolder('/plain');
    await settle();
    expect(box.worktree, false);
    expect(box.isGitProject, false);
    slow.complete(_git);
    await settle();
    expect(box.isGitProject, false);
    box.setFolder('/repo');
    await settle();
    expect(
      box.worktree,
      true,
      reason: 'Each Git project starts with Worktree on.',
    );
    expect(box.branchRef, 'refs/heads/main');
  });

  test('one Start waits for Git detection and lost replies reuse the original receipt', () async {
    final connection = _Connection()..loseReply = true;
    final ready = connection.pending['/repo'] = Completer();
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/repo',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    final starting = box.create();
    expect(box.busy, true);
    expect(connection.starts, isEmpty);
    ready.complete(_git);
    expect(await starting, NewHarnessOutcome.failed);
    expect(box.checking, true);
    expect(connection.starts.single, containsPair('projectSource', 'worktree'));
    final restored = NewHarnessController(
      app,
      machineId: 'm',
      draft: box.draft,
    );
    addTearDown(restored.dispose);
    expect(await restored.create(), NewHarnessOutcome.created);
    expect(connection.starts, hasLength(1));
    expect(connection.reads, ['/repo']);
  });

  test('a refused launch reuses its prepared worktree on retry', () async {
    final connection = _Connection()
      ..failure = {
        'preparedFolder': '/prepared',
        'failure': {'code': 'TMUX_UNAVAILABLE'},
      };
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/repo',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    await settle();
    expect(await box.create(), NewHarnessOutcome.failed);
    await settle();
    expect(box.project.folder, '/prepared');
    expect(box.worktree, false);
    connection.failure = null;
    expect(await box.create(), NewHarnessOutcome.created);
    expect(connection.starts, hasLength(2));
    expect(connection.starts.last['projectSource'], 'branch');
    expect(connection.starts.last['gitSource'], '/prepared');
  });

  Map<String, dynamic> linked(String branch) => {
    ..._git,
    'branch': branch,
    'mainFolder': '/repo',
    'mainBranch': 'main',
  };

  test(
    'a worktree folder opens as its repository, on the repository branch',
    () async {
      const folder = '/harnesses/worktrees/repo/claude-0922-1136';
      final connection = _Connection()
        ..answers[folder] = linked('harness/claude-0922-1136');
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: folder,
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      await settle();
      expect(box.project.folder, '/repo');
      expect(box.worktree, true);
      expect(box.branchLabel, 'main');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'worktree',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/main',
        'branchName': box.placeholder,
        'branchMode': 'placeholder',
      });
      expect(connection.reads, [folder], reason: 'Branches are shared.');
      expect(await box.create(), NewHarnessOutcome.created);
      expect(app.projectHistory.recent('m'), ['/repo']);
      final next = NewHarnessController(app, machineId: 'm', engine: 'codex');
      addTearDown(next.dispose);
      await settle();
      next.focusField(NewHarnessField.projectMenu);
      final folders = [for (final row in next.options) ?row.project?.folder];
      expect(folders, contains('/repo'));
      expect(
        folders.where((folder) => folder.contains('/harnesses/worktrees/')),
        isEmpty,
        reason: 'A worktree Start made is not a project to pick again.',
      );
    },
  );

  test('a refused launch in a new worktree retries on its branch', () async {
    const prepared = '/harnesses/worktrees/repo/codex-0922-1136';
    final connection = _Connection()
      ..answers[prepared] = linked('harness/codex-0922-1136')
      ..failure = {
        'preparedFolder': prepared,
        'failure': {'code': 'TMUX_UNAVAILABLE'},
      };
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/repo',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    await settle();
    expect(await box.create(), NewHarnessOutcome.failed);
    await settle();
    expect(box.project.folder, '/repo');
    expect(box.worktree, false);
    expect(box.branchLabel, 'harness/codex-0922-1136');
    connection.failure = null;
    expect(await box.create(), NewHarnessOutcome.created);
    expect(connection.starts.last, containsPair('projectSource', 'branch'));
    expect(connection.starts.last, containsPair('gitSource', '/repo'));
    expect(
      connection.starts.last,
      containsPair('branchRef', 'refs/heads/harness/codex-0922-1136'),
    );
  });

  const rich = <String, dynamic>{
    'isGit': true,
    'root': '/repo',
    'branch': 'main',
    'owner': 'deehw',
    'defaultRef': 'refs/remotes/origin/main',
    'branches': [
      {'ref': 'refs/heads/main', 'name': 'main', 'worktree': '/repo'},
      {'ref': 'refs/heads/feature', 'name': 'feature'},
      {
        'ref': 'refs/heads/feature/pay',
        'name': 'feature/pay',
        'worktree': '/wt/pay',
      },
      {'ref': 'refs/heads/harness/old', 'name': 'harness/old'},
      {
        'ref': 'refs/heads/harness/live',
        'name': 'harness/live',
        'worktree': '/wt/live',
      },
      {
        'ref': 'refs/remotes/origin/main',
        'name': 'origin/main',
        'remote': true,
      },
      {
        'ref': 'refs/remotes/origin/fix-typo',
        'name': 'origin/fix-typo',
        'remote': true,
      },
    ],
  };

  test(
    'From is where new work starts; Branch is the branch it is on',
    () async {
      final connection = _Connection()..answers['/repo'] = rich;
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/repo',
        random: Random(7),
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      await settle();
      final placeholder = box.placeholder;
      expect(
        placeholder,
        matches(RegExp(r'^deehw/[a-z]+-[a-z]+$')),
        reason: 'Made up under the GitHub login the machine reported.',
      );
      expect(box.worktree, true);
      expect(box.branchLabel, 'origin/main', reason: 'The remote default.');
      expect(box.worktreeBranchLabel, 'deehw/<session name>');
      expect(box.createLabel, 'Start Harness');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'worktree',
        'gitSource': '/repo',
        'branchRef': 'refs/remotes/origin/main',
        'branchName': placeholder,
        'branchMode': 'placeholder',
      });

      box.focusField(NewHarnessField.branch);
      final rows = {for (final row in box.options) row.title: row.detail};
      expect(rows.keys.take(2), ['main', 'origin/main']);
      expect(rows['main'], 'default · current');
      expect(rows['origin/main'], 'default · remote');
      expect(rows['feature/pay'], 'worktree');
      expect(rows['harness/live'], 'worktree');
      expect(
        rows.containsKey('harness/old'),
        false,
        reason: 'Nobody chose it.',
      );

      void pick(String title) {
        box.focusField(NewHarnessField.branch);
        box.accept(box.options.firstWhere((row) => row.title == title));
      }

      pick('feature');
      expect(box.worktreeBranchLabel, 'feature · existing');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'worktree',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/feature',
        'branchName': 'feature',
        'branchMode': 'existing',
      });
      pick('feature/pay');
      expect(box.opensWorktree, true);
      expect(box.createLabel, 'Start in Worktree');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'branch',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/feature/pay',
      });
      pick('origin/fix-typo');
      expect(box.worktreeBranchLabel, 'fix-typo · tracks origin/fix-typo');
      expect(box.projectFolderRequest!.payload['branchName'], 'fix-typo');
      pick('main');
      expect(box.worktreeBranchLabel, 'deehw/<session name>');
      expect(box.projectFolderRequest!.payload['branchRef'], 'refs/heads/main');

      box.focusField(NewHarnessField.branchName);
      expect(
        box.query,
        '',
        reason: 'Nothing typed means the session names it.',
      );
      expect(box.options.single.title, 'deehw/<session name>');
      box.setQuery('my/work');
      expect(box.options.single.detail, 'New branch from main');
      box.accept();
      expect(box.field, NewHarnessField.launch);
      expect(box.worktreeBranchLabel, 'my/work');
      expect(box.projectFolderRequest!.payload['branchName'], 'my/work');
      box.focusField(NewHarnessField.branchName);
      box.setQuery('main');
      expect(box.options.single.enabled, false);
      box.accept();
      expect(box.error, contains('Turn Worktree off'));
      box.setQuery('');
      box.accept();
      expect(box.worktreeBranchLabel, 'deehw/<session name>');
      expect(box.projectFolderRequest!.payload['branchMode'], 'placeholder');

      box.toggleWorktree();
      expect(box.worktree, false);
      expect(box.branchLabel, 'main');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'branch',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/main',
      });
      pick('feature/pay');
      expect(box.createLabel, 'Start in Worktree');
    },
  );

  test(
    'Worktree off can make a new branch for the folder, from its branch',
    () async {
      final connection = _Connection()..answers['/repo'] = rich;
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/repo',
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      await settle();
      box.toggleWorktree();
      box.focusField(NewHarnessField.branch);
      box.setQuery('feature');
      expect(
        box.options.map((row) => row.title),
        isNot(contains('Create branch feature')),
        reason: 'It exists: pick it instead.',
      );
      box.setQuery('login fix');
      expect(box.options.last.title, 'Create branch login-fix');
      expect(box.options.last.detail, 'New branch from main');
      box.accept(box.options.last);
      expect(box.branchRowLabel, 'login-fix · new from main');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'branch',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/login-fix',
        'branchName': 'login-fix',
      });
      box.focusField(NewHarnessField.branch);
      box.accept(box.options.firstWhere((row) => row.title == 'feature'));
      expect(box.branchRowLabel, 'feature');
      expect(box.projectFolderRequest!.payload['branchName'], isNull);
    },
  );

  test('typed branch names become valid ones as they are typed', () {
    expect(branchNameFrom('john smith'), 'john-smith');
    expect(branchNameFrom('  fix: login~bug?  '), 'fix-loginbug');
    expect(branchNameFrom('a..b//c/.d.lock'), 'a.b/c/d');
    expect(branchNameFrom('-.lead'), 'lead');
    expect(branchNameFrom('~^:'), '');
  });

  test(
    'the branch name field joins words and previews the valid name',
    () async {
      final connection = _Connection()..answers['/repo'] = rich;
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/repo',
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      await settle();
      box.focusField(NewHarnessField.branchName);
      box.setQuery('john smith');
      expect(box.query, 'john-smith');
      box.setQuery('fix: it');
      expect(box.options.single.title, 'fix-it');
      box.accept();
      expect(box.projectFolderRequest!.payload['branchName'], 'fix-it');
    },
  );

  test(
    'Worktree off never switches a folder a harness is working in',
    () async {
      final connection = _Connection()..answers['/repo'] = rich;
      final app = createApp(connectionForTest: (_) => connection);
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'busy',
          name: 'Busy',
          engine: 'codex',
          project: AgentProject(name: 'repo', cwd: '/repo/cli', root: '/repo'),
        ),
      ];
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/repo',
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      await settle();
      box.toggleWorktree();
      box.focusField(NewHarnessField.branch);
      box.accept(box.options.firstWhere((row) => row.title == 'feature'));
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('A harness is working in this folder'));
      expect(connection.starts, isEmpty);
    },
  );

  test('a repository with no commit starts without a worktree', () async {
    final connection = _Connection()
      ..answers['/empty'] = {'isGit': true, 'branch': 'main', 'branches': []};
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/empty',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    await settle();
    expect(box.isGitProject, true);
    expect(box.worktree, false);
  });

  testWidgets(
    'compact launch, checkbox controls, hover selection, branch search and Cmd-Enter start',
    (tester) async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/home/user/code/autonomous-harness',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 680,
                height: 440,
                child: NewHarnessBox(
                  controller: box,
                  onClose: () {},
                  onCreated: () {},
                  onNeedsForm: () {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('New Harness'), findsNothing);
      expect(find.text('Start Harness'), findsOneWidget);
      for (final name in ['task', 'placement']) {
        expect(find.byKey(ValueKey('new-harness-field-$name')), findsNothing);
      }
      expect(find.text('[x]'), findsOneWidget);
      // Worktree, then From and Branch, sit above Start.
      for (var row = 0; row < 3; row++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pump();
      expect(box.worktree, false);
      expect(find.text('[ ]'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('new-harness-field-worktree')),
      );
      await tester.pump();
      expect(find.text('[x]'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(box.worktree, false);
      final branchRow = find.byKey(const ValueKey('new-harness-field-branch'));
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(branchRow));
      await mouse.moveBy(const Offset(4, 0));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(box.field, NewHarnessField.branch);
      await mouse.removePointer();
      expect(box.options.where(box.isCurrent).single.title, 'main');
      expect(
        box.options.firstWhere((row) => row.title == 'origin/main').enabled,
        false,
      );
      final input = find.byKey(const ValueKey('new-harness-input'));
      await tester.enterText(input, 'feature');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(box.branchLabel, 'feature');
      expect(connection.starts, isEmpty);
      await openLaunchRow(tester, 'worktree');
      expect(box.worktree, true);
      await openLaunchRow(tester, 'branch');
      await tester.enterText(input, 'origin/main');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pump();
      expect(
        connection.starts.single,
        containsPair('branchRef', 'refs/remotes/origin/main'),
      );
      expect(connection.starts.single['projectSource'], 'worktree');
      expect(connection.starts.single.containsKey('prompt'), false);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      box.dispose();
      app.dispose();
      await tester.pump(const Duration(milliseconds: 200));
    },
  );
  testWidgets(
    'Git errors retry without losing isolation, and advanced options wait for detection',
    (tester) async {
      final connection = _Connection();
      final ready = connection.pending['/repo'] = Completer();
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/repo',
      );
      var advanced = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewHarnessBox(
              controller: box,
              onClose: () {},
              onCreated: () {},
              onNeedsForm: () => advanced++,
            ),
          ),
        ),
      );
      Future<void> options() async {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.period);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
        await tester.pump();
      }

      await options();
      expect(advanced, 0);
      ready.complete({'error': 'GIT_UNAVAILABLE'});
      await tester.pump();
      expect(advanced, 0);
      expect(box.error, contains('Retry Worktree'));
      final start = find.byKey(const ValueKey('new-harness-field-create'));
      await tester.tap(start);
      await tester.pump();
      expect(box.error, contains('Could not check Git'));
      expect(connection.starts, isEmpty);
      connection.pending.remove('/repo');
      await tester.tap(
        find.byKey(const ValueKey('new-harness-field-worktree')),
      );
      await tester.pump();
      expect(box.error, isNull);
      expect(box.worktree, true);
      expect(find.text('[x]'), findsOneWidget);
      await options();
      expect(advanced, 1);
      await openLaunchRow(tester, 'branch');
      await tester.enterText(
        find.byKey(const ValueKey('new-harness-input')),
        'origin/main',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.tap(
        find.byKey(const ValueKey('new-harness-field-worktree')),
      );
      await tester.pump();
      expect(box.worktree, false);
      await tester.tap(start);
      await tester.pump();
      expect(box.error, contains('Choose a local branch'));
      expect(connection.starts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      box.dispose();
      app.dispose();
      await tester.pump(const Duration(milliseconds: 200));
    },
  );

  testWidgets('Git and non-Git launch layouts fit at large text sizes', (
    tester,
  ) async {
    final renderDir = Platform.environment['HARNESS_LAUNCH_RENDER_DIR'];
    if (renderDir != null) await tester.runAsync(loadPreviewFonts);
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/home/user/code/autonomous-harness',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    tester.view.physicalSize = const Size(760, 520);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    for (final scale in [1.0, 1.7]) {
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData.dark(),
          home: MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(scale)),
            child: Scaffold(
              backgroundColor: const Color(0xff252525),
              body: Align(
                alignment: Alignment.bottomCenter,
                child: SizedBox(
                  width: 720,
                  child: NewHarnessBox(
                    docked: true,
                    controller: box,
                    onClose: () {},
                    onCreated: () {},
                    onNeedsForm: () {},
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Start Harness').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      if (renderDir != null) {
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(Uri.file('$renderDir/launch-$scale.png')),
        );
      }
    }
    await openLaunchRow(tester, 'branch');
    expect(
      find.byKey(const ValueKey('new-harness-input')).hitTestable(),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    if (renderDir != null) {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$renderDir/branches.png')),
      );
    }
    box.setFolder('/plain');
    await tester.pump();
    expect(
      find.byKey(const ValueKey('new-harness-field-branch')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('new-harness-field-worktree')),
      findsNothing,
    );
    if (renderDir != null) {
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$renderDir/non-git.png')),
      );
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 200));
  });
}
