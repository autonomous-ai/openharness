import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/new_agent_draft.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'edge_fixture.dart';

/// A machine that holds every Git read until the test answers it — a laptop slow to say what its
/// folder is, which is what a Start pressed as New opens runs into.
class _SlowGitConn extends EdgeConn {
  _SlowGitConn([Map<String, Map<String, dynamic>> answers = const {}])
    : super(answers, startsAgents);

  /// Every Git read asked for, in order: the folder, and the answer the test gives it.
  final reads = <({String path, Completer<Map<String, dynamic>> answer})>[];

  /// Every `agent_create` sent.
  List<Map<String, dynamic>> get created =>
      payloads['agent_create'] ?? const [];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'git_project_info') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    requests.add(type);
    (payloads[type] ??= []).add(payload);
    final answer = Completer<Map<String, dynamic>>();
    reads.add((path: payload['path'] as String, answer: answer));
    return answer.future;
  }
}

/// A checkout on `main`, with `origin/main` to start new work from.
Map<String, dynamic> _repository(String root) => {
  'isGit': true,
  'branch': 'main',
  'root': root,
  'defaultRef': 'refs/remotes/origin/main',
  'branches': [
    {'ref': 'refs/heads/main', 'name': 'main'},
    {'ref': 'refs/remotes/origin/main', 'name': 'origin/main', 'remote': true},
  ],
};

/// What the machine says about a folder that is not a repository: an answer, not a failure.
const _notARepository = {'isGit': false, 'branches': <Object>[]};

const _refusal =
    '✗ Could not check Git on studio. Check the connection and Harness CLI, '
    'then retry.';

/// Start pressed while the form is still reading its folder's Git: it waits for the answer and
/// starts from it, the desktop's `create`. Before, it went without — a bare `cwd`, no worktree.
void main() {
  setUp(() => newAgentDraft = null);
  tearDown(() => newAgentDraft = null);

  /// New, pushed over a page the way Focus pushes it, with its default folder's Git read still
  /// out. `/code/web` is the default: the folder of the machine's latest harness.
  Future<({AppNotifier app, _SlowGitConn conn})> openNew(
    WidgetTester tester, {
    String? folder,
    List<Agent>? agents,
    Map<String, Map<String, dynamic>> answers = const {},
  }) async {
    setPhone(tester, largePhone);
    final conn = _SlowGitConn(answers);
    final app = edgeApp(conn: conn, agents: agents ?? [edgeAgent('a')]);
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

  testWidgets('Start during the read waits for it and starts in a worktree, '
      'once', (tester) async {
    final (:app, :conn) = await openNew(tester);
    expect(conn.reads.single.path, '/code/web');
    expect(conn.reads.single.answer.isCompleted, isFalse);

    await tapInView(tester, find.text('Start'));
    await frames(tester);
    // Waiting, in the form's own busy state: nothing sent yet, and no second Start to press.
    expect(find.text('Starting…'), findsOneWidget);
    await tester.tap(find.text('Starting…'), warnIfMissed: false);
    await frames(tester);
    expect(conn.created, isEmpty);
    expect(conn.reads, hasLength(1));

    conn.reads.single.answer.complete(_repository('/code/web'));
    await frames(tester, count: 20);

    final payload = conn.created.single;
    expect(payload['projectSource'], 'worktree');
    expect(payload['gitSource'], '/code/web');
    expect(payload['branchRef'], 'refs/heads/main');
    expect(payload.containsKey('cwd'), isFalse);
    await close(tester, app);
  });

  testWidgets('a read the computer could not answer refuses Start; the next '
      'Start asks again', (tester) async {
    final (:app, :conn) = await openNew(tester);
    await tapInView(tester, find.text('Start'));
    await frames(tester);
    conn.reads.single.answer.complete({'error': 'UNAVAILABLE'});
    await frames(tester, count: 20);

    expect(find.text(_refusal), findsOneWidget);
    expect(conn.created, isEmpty);
    expect(find.text('Start'), findsOneWidget);

    // Try again: the machine is asked again rather than the failure being taken as an answer.
    await tapInView(tester, find.text('Start'));
    await frames(tester);
    expect(conn.reads, hasLength(2));
    expect(conn.created, isEmpty);
    conn.reads.last.answer.complete(_repository('/code/web'));
    await frames(tester, count: 20);

    expect(find.text(_refusal), findsNothing);
    final payload = conn.created.single;
    expect(payload['projectSource'], 'worktree');
    expect(payload.containsKey('cwd'), isFalse);
    await close(tester, app);
  });

  testWidgets('a folder that is not a repository still starts in it, plainly', (
    tester,
  ) async {
    final (:app, :conn) = await openNew(tester);
    await tapInView(tester, find.text('Start'));
    await frames(tester);
    expect(conn.created, isEmpty);
    conn.reads.single.answer.complete(_notARepository);
    await frames(tester, count: 20);

    expect(find.text(_refusal), findsNothing);
    final payload = conn.created.single;
    expect(payload['cwd'], '/code/web');
    expect(payload.containsKey('projectSource'), isFalse);
    await close(tester, app);
  });

  testWidgets('an answer that moves the folder to its repository starts '
      'there', (tester) async {
    const worktree = '/home/u/harnesses/worktrees/web/silent-beacon';
    const main = '/home/u/code/web';
    final (:app, :conn) = await openNew(tester, folder: worktree);
    await tapInView(tester, find.text('Start'));
    await frames(tester);
    expect(conn.reads.single.path, worktree);
    conn.reads.single.answer.complete({
      ..._repository(worktree),
      'branch': 'silent-beacon',
      'mainFolder': main,
      'mainBranch': 'main',
      'branches': [
        {'ref': 'refs/heads/main', 'name': 'main', 'worktree': main},
        {
          'ref': 'refs/heads/silent-beacon',
          'name': 'silent-beacon',
          'worktree': worktree,
          'harness': true,
        },
        {
          'ref': 'refs/remotes/origin/main',
          'name': 'origin/main',
          'remote': true,
        },
      ],
    });
    await frames(tester, count: 20);

    final payload = conn.created.single;
    expect(payload['gitSource'], main);
    expect(payload['projectSource'], 'worktree');
    expect(payload['branchRef'], 'refs/heads/main');
    await close(tester, app);
  });

  testWidgets('a worktree browsed to stays the project and starts on its '
      'branch', (tester) async {
    const worktree = '/home/u/harnesses/worktrees/web/silent-beacon';
    const main = '/home/u/code/web';
    final (:app, :conn) = await openNew(
      tester,
      answers: {
        'fs_list_dir': {'path': worktree, 'entries': <Object>[]},
      },
    );
    conn.reads.single.answer.complete(_repository('/code/web'));
    await frames(tester);
    await tapInView(tester, find.text('project'));
    await frames(tester);
    await tapInView(tester, find.text('+ Open Folder', findRichText: true));
    await frames(tester);
    await tester.tap(find.byType(FilledButton));
    await frames(tester);
    expect(conn.reads.last.path, worktree);
    // The computer did not answer: Start reads the browsed folder again, still as itself.
    conn.reads.last.answer.complete({'error': 'UNAVAILABLE'});
    await frames(tester);
    await tapInView(tester, find.text('Start'));
    await frames(tester);
    expect(conn.reads.last.path, worktree);
    conn.reads.last.answer.complete({
      ..._repository(worktree),
      'branch': 'silent-beacon',
      'mainFolder': main,
      'mainBranch': 'main',
      'branches': [
        {'ref': 'refs/heads/main', 'name': 'main', 'worktree': main},
        {
          'ref': 'refs/heads/silent-beacon',
          'name': 'silent-beacon',
          'worktree': worktree,
        },
        {
          'ref': 'refs/remotes/origin/main',
          'name': 'origin/main',
          'remote': true,
        },
      ],
    });
    await frames(tester, count: 20);
    final payload = conn.created.single;
    expect(payload['gitSource'], worktree);
    expect(payload['projectSource'], 'branch');
    expect(payload['branchRef'], 'refs/heads/silent-beacon');
    await close(tester, app);
  });

  testWidgets('another folder chosen while the first read is out: Start '
      'waits for that folder, and the late answer is not used', (tester) async {
    final (:app, :conn) = await openNew(
      tester,
      agents: [
        edgeAgent('a'),
        edgeAgent('b', project: 'api', minutesAgo: 10),
      ],
    );
    expect(conn.reads.single.path, '/code/web');
    await tapInView(tester, find.text('project'));
    await frames(tester);
    await tapInView(tester, find.text('api', findRichText: true).last);
    await frames(tester);
    expect(conn.reads.map((read) => read.path), ['/code/web', '/code/api']);

    await tapInView(tester, find.text('Start'));
    await frames(tester);
    // The folder the form has left answers late, as a repository: not the answer Start waits for.
    conn.reads.first.answer.complete(_repository('/code/web'));
    await frames(tester);
    expect(conn.created, isEmpty);

    conn.reads.last.answer.complete(_notARepository);
    await frames(tester, count: 20);
    final payload = conn.created.single;
    expect(payload['cwd'], '/code/api');
    expect(payload.containsKey('projectSource'), isFalse);
    expect(payload.containsKey('gitSource'), isFalse);
    await close(tester, app);
  });

  testWidgets('a form left before its read answered asks again on Start', (
    tester,
  ) async {
    final (:app, :conn) = await openNew(tester);
    await tester.binding.handlePopRoute();
    await frames(tester, count: 6);
    expect(newAgentDraft?.folder, '/code/web');
    expect(newAgentDraft?.gitFolder, isNull);
    // The answer arrives with nobody left to take it.
    conn.reads.single.answer.complete(_repository('/code/web'));
    await frames(tester);

    await tester.tap(find.text('focus'));
    await frames(tester);
    await tapInView(tester, find.text('Start'));
    await frames(tester);
    expect(conn.reads, hasLength(2));
    expect(conn.created, isEmpty);
    conn.reads.last.answer.complete(_repository('/code/web'));
    await frames(tester, count: 20);

    final payload = conn.created.single;
    expect(payload['projectSource'], 'worktree');
    expect(payload.containsKey('cwd'), isFalse);
    await close(tester, app);
  });
}
