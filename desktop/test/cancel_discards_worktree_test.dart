import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:path/path.dart' as p;

import 'swarm_state_test.dart' show createApp;

class _Request {
  _Request(this.type, this.payload);
  final String type;
  final Map<String, dynamic> payload;
  final reply = Completer<Map<String, dynamic>>();
  void held() => reply.complete({
    'creationId': payload['creationId'],
    'state': 'pending',
    'held': {
      'service': 'native',
      'detail': 'Waiting to confirm the engine search path and its aliases.',
    },
  });
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
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'engines_probe') return Future.value({'engines': []});
    if (type == 'dsh_list') return Future.value({'dsh': []});
    final request = _Request(type, Map.of(payload));
    calls.add(request);
    return request.reply.future;
  }
}

class _App extends AppNotifier {
  _App(_Connection connection, {required bool local, this.discardFails = false})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        connectionForTest: (_) => connection,
      ) {
    const machine = Machine(
      machineId: 'm',
      name: 'Studio',
      authMode: MachineAuthMode.remote,
    );
    machineStates['m'] = MachineState(machine)..localOnly = local;
  }
  final bool discardFails;
  final discarded = <(String, bool)>[];
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
  @override
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) async => '/harnesses/worktrees/x4/witty-finch';
  @override
  Future<bool> discardLocalWorktree(
    String folder, {
    bool keepBranch = false,
  }) async {
    if (discardFails) throw StateError('git went away');
    discarded.add((folder, keepBranch));
    return true;
  }
}

const _worktree = ProjectFolderRequest.worktree(
  '/repo/x4',
  branchRef: 'refs/heads/main',
  branchName: 'witty-finch',
  placeholder: true,
);

/// Starts [project] on [app], has the machine hold it, then cancels it with
/// the machine answering [receipt].
Future<String?> _holdThenCancel(
  _App app,
  _Connection connection, {
  ProjectFolderRequest? project = _worktree,
  String receipt = 'cancelled',
}) async {
  final attempt = AgentCreationAttempt();
  final create = app.createAgent(
    'm',
    engine: 'claude',
    folder: project == null ? '/repo/x4' : null,
    projectFolder: project,
    attempt: attempt,
  );
  await pumpEventQueue();
  connection.calls.last.held();
  await create;
  expect(attempt.canCancelPending, isTrue);
  final cancel = app.cancelAgentCreation(attempt);
  await pumpEventQueue();
  final request = connection.calls.last;
  expect(request.type, 'agent_create_cancel');
  request.reply.complete({
    'creationId': request.payload['creationId'],
    'state': receipt,
  });
  return cancel;
}

void main() {
  // Desktop 1.3.41, 2026-10-30: New Harness made witty-finch's worktree and
  // branch here, the machine held the start, Cancel request was confirmed, and
  // both stayed behind; the next press was refused for the branch they kept.
  test(
    'a confirmed cancel removes the worktree this computer made for it',
    () async {
      final connection = _Connection();
      final app = _App(connection, local: true);
      addTearDown(app.dispose);
      expect(await _holdThenCancel(app, connection), isNull);
      expect(app.discarded, [('/harnesses/worktrees/x4/witty-finch', false)]);
    },
  );

  test('a branch that was there before the start keeps its branch', () async {
    final connection = _Connection();
    final app = _App(connection, local: true);
    addTearDown(app.dispose);
    const existing = ProjectFolderRequest.worktree(
      '/repo/x4',
      branchRef: 'refs/heads/topic',
      branchName: 'topic',
      existingBranch: true,
    );
    expect(await _holdThenCancel(app, connection, project: existing), isNull);
    expect(app.discarded, [('/harnesses/worktrees/x4/witty-finch', true)]);
  });

  test('a cancel the machine did not confirm keeps the worktree', () async {
    final connection = _Connection();
    final app = _App(connection, local: true);
    addTearDown(app.dispose);
    expect(
      await _holdThenCancel(app, connection, receipt: 'created'),
      contains('Check status'),
    );
    expect(app.discarded, isEmpty);
  });

  test('a folder that is not a new worktree is never removed', () async {
    final connection = _Connection();
    final app = _App(connection, local: true);
    addTearDown(app.dispose);
    expect(await _holdThenCancel(app, connection, project: null), isNull);
    expect(app.discarded, isEmpty);
  });

  test(
    'another machine removes its own worktree; this computer does not',
    () async {
      final connection = _Connection();
      final app = _App(connection, local: false);
      addTearDown(app.dispose);
      expect(await _holdThenCancel(app, connection), isNull);
      expect(app.discarded, isEmpty);
    },
  );

  test(
    'a worktree that cannot be removed still leaves the cancel confirmed',
    () async {
      final connection = _Connection();
      final app = _App(connection, local: true, discardFails: true);
      addTearDown(app.dispose);
      expect(await _holdThenCancel(app, connection), isNull);
    },
  );

  group('New Harness on this computer', () {
    late Directory root;
    late String repo;
    Future<String> git(List<String> args, [String? at]) async {
      final result = await Process.run('git', ['-C', at ?? repo, ...args]);
      expect(result.exitCode, 0, reason: '${args.join(' ')}: ${result.stderr}');
      return (result.stdout as String).trim();
    }

    setUp(() async {
      root = await Directory.systemTemp.createTemp('harness-cancel-');
      repo = p.join(root.path, 'x4');
      await Directory(repo).create();
      await git(['init', '-b', 'main']);
      await git(['config', 'user.name', 'Test']);
      await git(['config', 'user.email', 'test@example.invalid']);
      await git(['config', 'commit.gpgsign', 'false']);
      await git(['commit', '--allow-empty', '-m', 'initial']);
    });
    tearDown(() => root.delete(recursive: true));

    // The whole of the 2026-10-30 report: press, the machine holds the start,
    // Cancel request, press again.
    test('starts again after a cancelled held start, from main, with nothing left behind', () async {
      final connection = _Machine();
      final app = createApp(
        connectionForTest: (_) => connection,
        connected: true,
        prepareFolder: (request) =>
            request.prepareLocal(projectHome: p.join(root.path, 'harnesses')),
      );
      app.machineStates['m']!.localOnly = true;
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'claude',
        folder: repo,
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      await _gitRead(box);
      expect(box.isGitProject, isTrue);
      expect(box.worktree, isTrue);

      connection.hold = true;
      expect(await box.create(), NewHarnessOutcome.failed);
      final first = connection.starts.single['cwd'] as String;
      expect(await Directory(first).exists(), isTrue);
      expect(box.canCancelPending, isTrue);

      await box.cancelPending();
      await _gitRead(box);
      expect(box.status, 'Creation cancelled.');
      expect(await Directory(first).exists(), isFalse);
      expect(await git(['branch', '--format=%(refname:short)']), 'main');

      connection.hold = false;
      expect(
        await box.create(),
        NewHarnessOutcome.created,
        reason: '${box.error}',
      );
      final second = connection.starts.last['cwd'] as String;
      expect(await Directory(second).exists(), isTrue);
      expect(
        await git(['rev-parse', 'HEAD'], second),
        await git(['rev-parse', 'main']),
      );
      expect(
        await git([
          'config',
          '--get',
          'branch.${await git(['branch', '--show-current'], second)}.harness',
        ]),
        'placeholder',
      );
    });
  });
}

/// The box reads Git with real processes: waits until it has an answer.
Future<void> _gitRead(NewHarnessController box) async {
  for (var i = 0; i < 200; i++) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
    if (!box.checkingGit) return;
  }
}

/// A machine that holds a start while [hold], confirms a cancel, and
/// otherwise makes the harness.
class _Machine extends WsConn {
  _Machine()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  bool hold = false;
  final starts = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final id = payload['creationId'];
    switch (type) {
      case 'agent_create':
        starts.add(Map.of(payload));
        if (hold) {
          return {
            'creationId': id,
            'state': 'pending',
            'held': {
              'service': 'native',
              'detail':
                  'Waiting to confirm the engine search path and its aliases.',
            },
          };
        }
        return {
          'creationId': id,
          'state': 'created',
          'agent': {
            'id': 'made',
            'name': 'Made',
            'engine': 'claude',
            'project': {'name': 'x4', 'cwd': payload['cwd']},
          },
        };
      case 'agent_create_cancel':
        return {'creationId': id, 'state': 'cancelled'};
      case 'engines_probe':
        return {'engines': []};
      case 'dsh_list':
        return {'dsh': []};
    }
    return {};
  }
}
