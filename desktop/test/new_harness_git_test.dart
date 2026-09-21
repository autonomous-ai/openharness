import 'dart:async';
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
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
          Future.value(path == '/plain' ? {'isGit': false} : _git);
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
          'project': {'cwd': payload['cwd'] ?? '/worktrees/new'},
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
    expect(box.draft.projectFolderRequest!.payload, {
      'projectSource': 'worktree',
      'gitSource': '/repo',
      'branchRef': 'refs/heads/main',
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
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
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
