import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/agent_git_context.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/tty_controls.dart' show TtyFormRow;
import 'package:harness_mobile/state/app_state.dart';

import 'edge_fixture.dart';

/// `/code/web` as its machine reads it: on `fix/login`, with `main` to start new work from — the
/// branch row's default while Worktree is on — `feature` to switch to, and `docs`, which already
/// has a worktree of its own.
Map<String, dynamic> _repository({
  String root = '/code/web',
  String? branch = 'fix/login',
}) => {
  'isGit': true,
  'branch': branch,
  'root': root,
  'defaultRef': 'refs/remotes/origin/main',
  'branches': [
    {'ref': 'refs/heads/main', 'name': 'main'},
    {'ref': 'refs/heads/fix/login', 'name': 'fix/login'},
    {'ref': 'refs/heads/feature', 'name': 'feature'},
    {
      'ref': 'refs/heads/docs',
      'name': 'docs',
      'worktree': '/home/u/harnesses/worktrees/web/docs',
    },
    {'ref': 'refs/remotes/origin/main', 'name': 'origin/main', 'remote': true},
  ],
};

/// The desktop's words (`state/new_harness.dart`), naming the branch the folder stays on.
String _refusal([String branch = 'fix/login']) =>
    '✗ A harness is working in this folder, so its branch can’t be switched. '
    'Turn Worktree on, or stay on $branch.';

/// A harness started in [cwd] — and, with [seenIn], one its machine has since seen working in
/// [seenIn] instead.
Agent _harness(String id, String cwd, {String? seenIn}) => Agent(
  id: id,
  name: id,
  engine: 'claude',
  sessionId: 'session-$id',
  status: 'active',
  project: AgentProject(name: cwd.split('/').last, cwd: cwd),
  gitContext: seenIn == null
      ? null
      : AgentGitContext(
          state: 'observed',
          current: AgentProject(name: seenIn.split('/').last, cwd: seenIn),
        ),
  updatedAt: DateTime.now().subtract(const Duration(minutes: 5)),
  terminalAvailable: true,
);

/// With Worktree off, Start switches the folder's own branch: the machine runs `git switch` there
/// (`cli/src/lib/gitProject.ts`) and does not look at what else is working in it. A harness already
/// at work in that checkout had its files change branch under it. New refuses before sending
/// anything, as the desktop does — and every choice that moves nothing still starts as before.
void main() {
  setUp(() => newAgentDraft = null);
  tearDown(() => newAgentDraft = null);

  /// New for [folder] on `m`, pushed over a page the way Focus pushes it, with [agents] running on
  /// `m` — and [elsewhere] on a second computer, `mini`.
  Future<({AppNotifier app, EdgeConn conn})> openNew(
    WidgetTester tester, {
    String folder = '/code/web',
    required List<Agent> agents,
    List<Agent> elsewhere = const [],
    Map<String, dynamic>? repository,
  }) async {
    setPhone(tester, largePhone);
    final conn = EdgeConn({
      'git_project_info': repository ?? _repository(),
    }, startsAgents);
    final app = edgeApp(conn: conn, agents: agents);
    app.stateOf('m')!
      ..projectFolderAvailable = true
      ..terminalCapabilityLoaded = true;
    if (elsewhere.isNotEmpty) {
      const other = Machine(
        machineId: 'mini',
        authMode: MachineAuthMode.remote,
        name: 'mini',
      );
      app.machines = [...app.machines, other];
      app.machineStates['mini'] = MachineState(other)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = elsewhere;
    }
    await tester.pumpWidget(
      phoneApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => NewAgentPage(
                  notifier: app,
                  machineId: 'm',
                  folder: folder,
                  voice: edgeVoice().voice,
                ),
              ),
            ),
            child: const Text('focus'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('focus'));
    await frames(tester);
    return (app: app, conn: conn);
  }

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  TtyFormRow formRow(WidgetTester tester, String label) =>
      tester.widget<TtyFormRow>(
        find.byWidgetPredicate(
          (widget) => widget is TtyFormRow && widget.label == label,
        ),
      );

  Future<void> choose(WidgetTester tester, String row, String item) async {
    await tapInView(tester, find.text(row));
    await frames(tester);
    await tapInView(tester, find.text(item, findRichText: true).last);
    await frames(tester);
  }

  /// Options open, Worktree turned off — and, with [branch], that branch picked.
  Future<void> worktreeOff(WidgetTester tester, {String? branch}) async {
    await tapInView(tester, find.text('options'));
    await frames(tester);
    // Below the fold when nothing is running yet: the first-task suggestions take the room.
    if (find.text('worktree').evaluate().isEmpty) {
      await tester.scrollUntilVisible(
        find.text('worktree'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
    }
    expect(formRow(tester, 'worktree').value, '[x]');
    await tapInView(tester, find.text('worktree'));
    await frames(tester);
    expect(formRow(tester, 'worktree').value, '[ ]');
    if (branch != null) await choose(tester, 'branch', branch);
  }

  Future<void> start(WidgetTester tester) async {
    await tapInView(tester, find.text('Start'));
    await frames(tester, count: 20);
  }

  List<Map<String, dynamic>> created(EdgeConn conn) =>
      conn.payloads['agent_create'] ?? const [];

  /// Refused on the form: the reason under the task, nothing sent, and the button still saying
  /// Start — nothing went out, so there is nothing to try again.
  void expectRefused(EdgeConn conn, [String branch = 'fix/login']) {
    expect(find.text(_refusal(branch)), findsOneWidget);
    expect(created(conn), isEmpty);
    expect(find.text('Start'), findsOneWidget);
    expect(find.text('Try Again'), findsNothing);
  }

  group('Worktree off, a harness at work in the checkout: Start refuses', () {
    testWidgets('the default branch Worktree on chose, kept when it is turned '
        'off; Worktree back on then starts', (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
      );
      await worktreeOff(tester);
      // The trigger: the row still says the default it had with Worktree on, and Start would
      // have switched a folder on fix/login to main under the harness there.
      expect(formRow(tester, 'branch').value, 'main');
      await start(tester);
      expectRefused(conn);

      // The advice works: with Worktree on the folder is left alone, and the harness starts.
      await tapInView(tester, find.text('worktree'));
      await frames(tester);
      expect(find.text(_refusal()), findsNothing);
      await start(tester);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'worktree');
      expect(payload['gitSource'], '/code/web');
      expect(payload['branchRef'], 'refs/heads/main');
      await close(tester, app);
    });

    testWidgets('another existing branch picked', (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
      );
      await worktreeOff(tester, branch: 'feature');
      expect(formRow(tester, 'branch').value, 'feature');
      await start(tester);
      expectRefused(conn);
      await close(tester, app);
    });

    testWidgets('a new branch name typed for the folder', (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
      );
      await worktreeOff(tester, branch: 'New branch…');
      await tester.enterText(find.byType(TextField).last, 'try it');
      await tester.pump();
      await tester.tap(find.text('Use'));
      await frames(tester);
      expect(formRow(tester, 'branch').value, 'try-it');
      await start(tester);
      expectRefused(conn);
      await close(tester, app);
    });

    testWidgets('the harness is in a subfolder of the checkout', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web/api')],
      );
      await worktreeOff(tester, branch: 'feature');
      await start(tester);
      expectRefused(conn);
      await close(tester, app);
    });

    testWidgets('the folder is a subfolder, and the harness is at the top of '
        'its checkout', (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        folder: '/code/web/api',
        agents: [_harness('a', '/code/web')],
      );
      await worktreeOff(tester, branch: 'feature');
      await start(tester);
      expectRefused(conn);
      await close(tester, app);
    });

    testWidgets('a harness started elsewhere that its machine has seen working '
        'in the checkout', (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/api', seenIn: '/code/web/cli')],
      );
      await worktreeOff(tester, branch: 'feature');
      await start(tester);
      expectRefused(conn);
      await close(tester, app);
    });

    testWidgets('a folder on no branch is said to be on Detached HEAD', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
        repository: _repository(branch: null),
      );
      await worktreeOff(tester);
      await start(tester);
      expectRefused(conn, 'Detached HEAD');
      await close(tester, app);
    });

    testWidgets(
      'opened on a worktree\'s subfolder: its main checkout counts as '
      'a whole, top included',
      (tester) async {
        const worktree = '/home/u/harnesses/worktrees/web/silent-beacon';
        final (:app, :conn) = await openNew(
          tester,
          folder: '$worktree/api',
          // Working at the top of the main checkout, above the folder New moves to.
          agents: [_harness('a', '/code/web')],
          repository: {
            ..._repository(root: worktree, branch: 'silent-beacon'),
            'mainFolder': '/code/web/api',
            'mainBranch': 'main',
            'branches': [
              {
                'ref': 'refs/heads/main',
                'name': 'main',
                'worktree': '/code/web',
              },
              {
                'ref': 'refs/heads/silent-beacon',
                'name': 'silent-beacon',
                'worktree': worktree,
                'harness': true,
              },
              {'ref': 'refs/heads/feature', 'name': 'feature'},
            ],
          },
        );
        await worktreeOff(tester, branch: 'feature');
        await start(tester);
        expectRefused(conn, 'main');
        await close(tester, app);
      },
    );
  });

  group('everything that moves nothing starts as before', () {
    testWidgets('harnesses in other folders, one whose path only begins like '
        'the checkout\'s', (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/api'), _harness('b', '/code/website')],
      );
      await worktreeOff(tester, branch: 'feature');
      await start(tester);
      expect(find.text(_refusal()), findsNothing);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'branch');
      expect(payload['gitSource'], '/code/web');
      expect(payload['branchRef'], 'refs/heads/feature');
      expect(payload.containsKey('cwd'), isFalse);
      await close(tester, app);
    });

    testWidgets('the branch the folder is already on', (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
      );
      await worktreeOff(tester, branch: 'fix/login');
      await start(tester);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'branch');
      expect(payload['branchRef'], 'refs/heads/fix/login');
      await close(tester, app);
    });

    testWidgets('a branch with a worktree of its own, which opens there', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
      );
      await worktreeOff(tester, branch: 'docs');
      await start(tester);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'branch');
      expect(payload['branchRef'], 'refs/heads/docs');
      await close(tester, app);
    });

    testWidgets('Worktree on', (tester) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
      );
      await tapInView(tester, find.text('options'));
      await frames(tester);
      await choose(tester, 'branch', 'feature');
      expect(formRow(tester, 'worktree').value, '[x]');
      await start(tester);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'worktree');
      expect(payload['branchRef'], 'refs/heads/feature');
      await close(tester, app);
    });

    testWidgets('a New Folder chosen after the switch was set up', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
      );
      await worktreeOff(tester, branch: 'feature');
      await choose(tester, 'project', '+ New Folder');
      await start(tester);
      expect(find.text(_refusal()), findsNothing);
      expect(created(conn).single['projectSource'], 'new');
      await close(tester, app);
    });

    testWidgets('a repository to clone chosen after the switch was set up', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/web')],
      );
      await worktreeOff(tester, branch: 'feature');
      await choose(tester, 'project', '+ Clone Repository');
      await tester.enterText(
        find.byType(TextField).last,
        'https://github.com/ada/engine',
      );
      await tester.tap(find.text('Select'));
      await frames(tester);
      await start(tester);
      expect(find.text(_refusal()), findsNothing);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'remote');
      expect(payload['repositoryUrl'], 'https://github.com/ada/engine.git');
      await close(tester, app);
    });

    testWidgets('no harness running on the computer', (tester) async {
      final (:app, :conn) = await openNew(tester, agents: []);
      await worktreeOff(tester, branch: 'feature');
      await start(tester);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'branch');
      expect(payload['branchRef'], 'refs/heads/feature');
      await close(tester, app);
    });

    testWidgets('a harness at the same path on another computer', (
      tester,
    ) async {
      final (:app, :conn) = await openNew(
        tester,
        agents: [_harness('a', '/code/api')],
        elsewhere: [_harness('x', '/code/web')],
      );
      await worktreeOff(tester, branch: 'feature');
      await start(tester);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'branch');
      expect(payload['gitSource'], '/code/web');
      expect(payload['branchRef'], 'refs/heads/feature');
      await close(tester, app);
    });

    testWidgets('opened on a worktree\'s subfolder: a harness in that worktree '
        'is not in the main checkout', (tester) async {
      const worktree = '/home/u/harnesses/worktrees/web/silent-beacon';
      final (:app, :conn) = await openNew(
        tester,
        folder: '$worktree/api',
        agents: [_harness('a', '$worktree/api')],
        repository: {
          ..._repository(root: worktree, branch: 'silent-beacon'),
          'mainFolder': '/code/web/api',
          'mainBranch': 'main',
          'branches': [
            {'ref': 'refs/heads/main', 'name': 'main', 'worktree': '/code/web'},
            {
              'ref': 'refs/heads/silent-beacon',
              'name': 'silent-beacon',
              'worktree': worktree,
              'harness': true,
            },
            {'ref': 'refs/heads/feature', 'name': 'feature'},
          ],
        },
      );
      await worktreeOff(tester, branch: 'feature');
      await start(tester);
      final payload = created(conn).single;
      expect(payload['projectSource'], 'branch');
      expect(payload['gitSource'], '/code/web/api');
      expect(payload['branchRef'], 'refs/heads/feature');
      await close(tester, app);
    });
  });
}
