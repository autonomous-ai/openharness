import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/git_worktree.dart';
import 'package:harness/core/models.dart';
import 'package:harness/e2ee/envelope.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
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
    {
      'ref': 'refs/remotes/origin/release',
      'name': 'origin/release',
      'remote': true,
    },
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
  final refreshes = <String>[];
  Completer<Map<String, dynamic>>? refreshing;
  final pending = <String, Completer<Map<String, dynamic>>>{};
  final answers = <String, Map<String, dynamic>>{};
  Map<String, dynamic>? failure;
  bool loseReply = false;
  int gitFailures = 0;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'git_project_info') {
      final path = payload['path'] as String;
      if (payload['refresh'] == true) {
        refreshes.add(path);
        return refreshing?.future ??
            Future.value({..._git, ...?answers[path], 'refreshed': true});
      }
      reads.add(path);
      if (gitFailures > 0) {
        gitFailures--;
        throw const WsRequestTimeout('git_project_info');
      }
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

  test('Branch opens immediately, discovers remote matches, and never queries on typing', () async {
    final connection = _Connection()..refreshing = Completer();
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
    box.focusField(NewHarnessField.branch);
    expect(box.refreshingBranches, true);
    expect(box.checkingGit, false);
    expect(box.options.any((row) => row.title == 'feature'), true);
    for (final query in ['t', 'to', 'toolbar']) {
      box.setQuery(query);
    }
    expect(connection.refreshes, ['/repo']);
    expect(
      box.options.any(
        (row) => row.id.startsWith(NewHarnessController.createBranchId),
      ),
      false,
    );
    connection.refreshing!.complete({
      ..._git,
      'refreshed': true,
      'branches': [
        ..._git['branches'] as List,
        {
          'ref': 'refs/remotes/origin/feat/toolbar-onboarding',
          'name': 'origin/feat/toolbar-onboarding',
          'remote': true,
        },
      ],
    });
    await settle();
    expect(box.query, 'toolbar');
    expect(box.selected!.title, 'origin/feat/toolbar-onboarding');
    expect(box.refreshingBranches, false);
    expect(box.branchRefreshError, isNull);
    box.accept();
    expect(
      box.projectFolderRequest!.payload['branchRef'],
      'refs/remotes/origin/feat/toolbar-onboarding',
    );
    expect(connection.starts, isEmpty);
  });

  test('failed branch refresh preserves usable choices and manual retry keeps the query', () async {
    final connection = _Connection()..refreshing = Completer();
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
    box.focusField(NewHarnessField.branch);
    box.setQuery('feature');
    connection.refreshing!.completeError(StateError('offline'));
    await settle();
    expect(box.selected!.title, 'feature');
    expect(box.branchRefreshError, contains('Showing saved branches'));
    expect(box.gitError, isNull);
    connection.refreshing = Completer();
    box.refreshChoices();
    box.refreshChoices();
    expect(connection.refreshes, ['/repo', '/repo']);
    connection.refreshing!.complete({..._git, 'refreshed': true});
    await settle();
    expect(box.query, 'feature');
    expect(box.selected!.title, 'feature');
    expect(box.branchRefreshError, isNull);
  });

  test('filtering 2000 branches stays local during a slow refresh', () async {
    final connection = _Connection()
      ..refreshing = Completer()
      ..answers['/repo'] = {
        ..._git,
        'branches': [
          for (var i = 0; i < 2000; i++)
            {
              'ref': 'refs/remotes/origin/feature/$i',
              'name': 'origin/feature/$i',
              'remote': true,
            },
        ],
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
    box.focusField(NewHarnessField.branch);
    final timings = <int>[];
    for (var i = 0; i < 100; i++) {
      final watch = Stopwatch()..start();
      box.setQuery('feature/$i');
      timings.add(watch.elapsedMicroseconds);
    }
    timings.sort();
    // A diagnostic, not a flaky wall-clock threshold on a shared build machine.
    debugPrint(
      'Branch search / 2000 refs / 100 queries: p50=${timings[50]}us p95=${timings[95]}us',
    );
    expect(connection.reads, ['/repo']);
    expect(connection.refreshes, ['/repo']);
    connection.refreshing!.complete({
      ...connection.answers['/repo']!,
      'refreshed': true,
    });
    await settle();
  });

  test('a late refresh from another project is discarded', () async {
    final connection = _Connection()..refreshing = Completer();
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
    box.focusField(NewHarnessField.branch);
    box.setFolder('/plain');
    await settle();
    connection.refreshing!.complete({..._git, 'refreshed': true});
    await settle();
    expect(box.project.folder, '/plain');
    expect(box.isGitProject, false);
    expect(box.refreshingBranches, false);
  });

  testWidgets(
    'Branch shows refresh progress and manual refresh keeps the typed query',
    (tester) async {
      final connection = _Connection()..refreshing = Completer();
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/repo',
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      await tester.binding.setSurfaceSize(const Size(1200, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              onClose: () {},
              onCreated: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('new-harness-field-branch')));
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('new-harness-query')),
        'toolbar',
      );
      await tester.pump();
      expect(find.text('Checking remote branches…'), findsOneWidget);
      expect(find.text('No matches'), findsNothing);
      connection.refreshing!.complete({..._git, 'refreshed': false});
      await tester.pumpAndSettle();
      expect(find.textContaining('Showing saved branches'), findsOneWidget);
      connection.refreshing = Completer();
      await tester.tap(find.byTooltip('Refresh results'));
      await tester.pump();
      expect(box.query, 'toolbar');
      expect(connection.refreshes, ['/repo', '/repo']);
      connection.refreshing!.complete({..._git, 'refreshed': true});
      await tester.pumpAndSettle();
      expect(find.textContaining('Showing saved branches'), findsNothing);
      for (final modifier in [
        LogicalKeyboardKey.metaLeft,
        LogicalKeyboardKey.controlLeft,
      ]) {
        final previous = connection.refreshes.length;
        connection.refreshing = Completer();
        await tester.tap(find.byKey(const ValueKey('new-harness-query')));
        await tester.sendKeyDownEvent(modifier);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
        await tester.sendKeyUpEvent(modifier);
        await tester.pump();
        expect(connection.refreshes.length, previous + 1);
        expect(box.query, 'toolbar');
        connection.refreshing!.complete({..._git, 'refreshed': true});
        await tester.pumpAndSettle();
      }
      await tester.pumpWidget(const SizedBox());
    },
  );

  test(
    'failed Git discovery blocks launch and the next Start retries it',
    () async {
      final connection = _Connection()..gitFailures = 2;
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
      expect(box.gitError, isNotNull);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('Could not check Git'));
      expect(box.busy, isFalse);
      expect(connection.starts, isEmpty);

      expect(await box.create(), NewHarnessOutcome.created);
      expect(connection.starts, hasLength(1));
      expect(connection.starts.single['projectSource'], 'worktree');
      expect(connection.reads, ['/repo', '/repo', '/repo']);
    },
  );

  test('a remote branch cannot launch in the main folder after Worktree is disabled', () async {
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
    box.focusField(NewHarnessField.branch);
    box.accept(box.options.firstWhere((row) => row.title == 'origin/release'));
    box.toggleWorktree();
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.error, 'Choose a local branch, or turn Worktree on.');
    expect(connection.starts, isEmpty);
    box.toggleWorktree();
    expect(await box.create(), NewHarnessOutcome.created);
    expect(
      connection.starts.single['branchRef'],
      'refs/remotes/origin/release',
    );
    expect(connection.starts.single['branchName'], 'release');
  });

  test('closing during Git discovery never sends a late create', () async {
    final connection = _Connection();
    final pending = connection.pending['/repo'] = Completer();
    final app = createApp(connectionForTest: (_) => connection);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/repo',
    );
    addTearDown(app.dispose);
    final creating = box.create();
    expect(box.busy, isTrue);
    box.dispose();
    pending.complete(_git);
    expect(await creating, NewHarnessOutcome.failed);
    expect(connection.starts, isEmpty);
  });

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
    expect(
      box.placeholder,
      matches(RegExp(r'^[a-z]+-[a-z]+$')),
      reason: 'No login reported: the session name alone, later.',
    );
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

  test('the form filters a field and takes what it landed on', () async {
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
    box.focusField(NewHarnessField.branch);
    await settle();
    expect(box.branchLabel, 'main');
    // Typing narrows the row, and the row takes what it narrowed to: on the
    // form there is no list to press Return in, so nothing else would.
    box.setQuery('feat');
    box.takeSelection();
    await settle();
    expect(box.branchLabel, 'feature');
    expect(box.matchCount, lessThan(box.total));

    // And the arrows step from the value the field HAS, through a stable
    // order — the displayed list re-ranks the chosen row to the front, which
    // is why stepping through THAT walked in circles.
    box.setQuery('');
    final wheel = box.stepValues();
    final at = wheel.indexWhere(box.isCurrent);
    expect(at, isNonNegative, reason: 'The taken branch must be on the wheel.');
    box.applyOption(wheel[(at + 1) % wheel.length]);
    await settle();
    expect(box.branchLabel, isNot('feature'));
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

  test('search finds remote-qualified and older Harness branches', () async {
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
    box.focusField(NewHarnessField.branch);
    await settle();
    for (final name in ['origin/main', 'harness/old']) {
      box.setQuery(name);
      expect(box.options.first.title, name);
      expect(box.options.first.enabled, true);
      expect(box.options.where((row) => row.synthetic), isEmpty);
    }
    box.setQuery('');
    expect(
      box.options.map((row) => row.title),
      isNot(anyOf(contains('origin/main'), contains('harness/old'))),
    );
  });

  test('a hidden local branch does not hide its remote counterpart', () async {
    final connection = _Connection()
      ..answers['/repo'] = {
        ...rich,
        'branches': [
          ...rich['branches'] as List,
          {
            'ref': 'refs/remotes/origin/harness/old',
            'name': 'origin/harness/old',
            'remote': true,
          },
        ],
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
    box.focusField(NewHarnessField.branch);
    expect(box.options.map((row) => row.title), contains('origin/harness/old'));
  });

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
        matches(RegExp(r'^[a-z]+-[a-z]+$')),
        reason: 'Two words until the session names it.',
      );
      expect(box.worktree, true);
      expect(
        box.branchRowLabel,
        'main',
        reason: 'The default branch; Start brings it up to origin/main.',
      );
      expect(box.worktreePlan!.branch, placeholder);
      expect(box.createLabel, 'Start Harness');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'worktree',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/main',
        'branchName': placeholder,
        'branchMode': 'placeholder',
      });

      box.focusField(NewHarnessField.branch);
      final rows = {for (final row in box.options) row.title: row.detail};
      expect(rows.keys.first, 'main');
      expect(
        rows.containsKey('origin/main'),
        false,
        reason: 'The local main stands for it.',
      );
      expect(rows['origin/fix-typo'], 'remote');
      expect(rows['main'], 'default · current');
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
      expect(box.branchRowLabel, 'feature');
      expect(box.worktreePlan!.kind, WorktreeStart.existingBranch);
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'worktree',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/feature',
        'branchName': 'feature',
        'branchMode': 'existing',
      });
      pick('feature/pay');
      expect(box.opensWorktree, true);
      expect(box.opensWorktree, true);
      expect(box.createLabel, 'Start Harness');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'branch',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/feature/pay',
      });
      pick('origin/fix-typo');
      expect(box.worktreePlan!.tracks, true);
      expect(box.projectFolderRequest!.payload['branchName'], 'fix-typo');
      pick('main');
      expect(box.worktreePlan!.branch, placeholder);
      expect(box.projectFolderRequest!.payload['branchRef'], 'refs/heads/main');

      // A name no branch has: a new branch in a new worktree, from the default.
      box.focusField(NewHarnessField.branch);
      box.setQuery('my work');
      await settle();
      expect(box.options.last.title, 'Create branch my-work');
      expect(box.options.last.detail, 'New branch from main');
      box.accept(box.options.last);
      expect(box.branchRowLabel, 'my-work · new from main');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'worktree',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/main',
        'branchName': 'my-work',
      });
      box.focusField(NewHarnessField.branch);
      box.setQuery('main');
      expect(
        box.options.map((row) => row.title),
        isNot(contains('Create branch main')),
      );
      pick('main');
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
      expect(box.opensWorktree, true);
      expect(
        box.branchRowLabel,
        'feature/pay · in its worktree',
        reason: 'The row says where Start goes; the button never changes.',
      );
      expect(box.createLabel, 'Start Harness');
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
      await settle();
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

  test('Create branch cleans up a typed name', () async {
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
    box.focusField(NewHarnessField.branch);
    box.setQuery('john smith');
    await settle();
    expect(box.options.last.title, 'Create branch john-smith');
    box.setQuery('fix: it');
    box.accept(box.options.last);
    expect(box.projectFolderRequest!.payload['branchName'], 'fix-it');
  });

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
    'setup branch and worktree choices are used by the explicit launch action',
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
            body: SizedBox(
              width: 820,
              height: 450,
              child: NewHarnessForm(
                controller: box,
                onClose: () {},
                onCreated: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await openLaunchRow(tester, 'branch');
      await typeHarnessQuery(tester, 'feature');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(box.branchLabel, 'feature');
      expect(connection.starts, isEmpty);
      await startHarness(tester);
      expect(connection.starts.single['branchRef'], 'refs/heads/feature');
      expect(connection.starts.single['projectSource'], 'worktree');
      expect(connection.starts.single.containsKey('prompt'), isFalse);
      expect(tester.takeException(), isNull);
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
                  child: NewHarnessForm(
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
      await openLaunchRow(tester, 'start');
      expect(find.text('[ New Harness ]').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      if (renderDir != null) {
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(Uri.file('$renderDir/launch-$scale.png')),
        );
      }
    }
    await openLaunchRow(tester, 'branch');
    expect(find.textContaining('Search branch'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('new-harness-query')).hitTestable(),
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
      findsOneWidget,
    );
    // Branch no longer lives behind Advanced, so reaching it opened nothing;
    // Worktree still does, and is opened here to be checked.
    await openLaunchRow(tester, 'advanced');
    expect(
      find.byKey(const ValueKey('new-harness-field-worktree')),
      findsOneWidget,
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
