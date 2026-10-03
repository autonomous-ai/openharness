import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/agent_git_context.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

Map<String, dynamic> gitFixture({
  String state = 'observed',
  String branch = 'hn/preview-fix',
}) => {
  'state': state,
  'observedAt': '2026-09-27T13:00:00Z',
  'current': state == 'observed'
      ? {
          'name': 'app',
          'cwd': '/ship-hn',
          'root': '/ship-hn',
          'remote': 'github.com/acme/app',
          'branch': branch,
          'worktree': true,
        }
      : null,
  'locations': [
    {'cwd': '/ship-hn/tui', 'at': '2026-09-27T13:00:00Z'},
  ],
  'history': {
    'branches': [
      {
        'cwd': '/ship-hn',
        'remote': 'github.com/acme/app',
        'branch': branch,
        'at': '2026-09-27T13:00:00Z',
      },
    ],
    'pullRequests': [
      {
        'url': 'https://github.com/acme/app/pull/12',
        'cwd': '/ship-hn',
        'at': '2026-09-27T13:00:00Z',
        'checkedAt': '2026-09-27T13:01:00Z',
        'result': {
          'status': 'found',
          'url': 'https://github.com/acme/app/pull/12',
          'number': 12,
          'state': 'Open',
        },
      },
    ],
  },
};
Agent workAgent({Map<String, dynamic>? git}) => Agent.fromJson({
  'id': 'hn',
  'name': 'hn',
  'engine': 'claude',
  'project': {
    'name': 'app',
    'cwd': '/silent-beacon',
    'root': '/silent-beacon',
    'branch': 'original',
  },
  'gitContext': ?git,
});

Map<String, dynamic> manyPrFixture() {
  final git = gitFixture(
    branch: 'hn/fix-terminal-preview-and-nfc-session-ordering',
  );
  final history = git['history'] as Map;
  history['pullRequests'] = [
    for (var i = 0; i < 7; i++)
      {
        'url': 'https://github.com/acme/app/pull/${120 + i}',
        'cwd': '/ship-hn',
        'at': '2026-09-27T13:00:00Z',
        'checkedAt': '2026-09-27T13:01:00Z',
        'result': {
          'status': 'found',
          'url': 'https://github.com/acme/app/pull/${120 + i}',
          'number': 120 + i,
          'state': ['Open', 'Draft', 'Merged', 'Closed'][i % 4],
          'title': [
            'Preserve complete session previews',
            'Keep concurrent NFC sessions in order',
            'Resolve earlier transport failures',
            'Replace the original UI experiment',
          ][i % 4],
          'headBranch': 'hn/${['preview', 'nfc', 'transport', 'ui'][i % 4]}',
          'baseBranch': 'main',
        },
      },
  ];
  return git;
}

void main() {
  test('the recent Git branch leads the header and binds its PR request', () {
    final fixture = gitFixture();
    final recent = fixture['current'] as Map<String, dynamic>;
    fixture['state'] = 'multiple';
    fixture['current'] = null;
    fixture['checkouts'] = [
      {...recent, 'cwd': '/home', 'root': '/home', 'branch': 'original'},
      recent,
    ];
    fixture['recentWork'] = {'project': recent, 'at': '2026-09-27T13:00:00Z'};
    final context = AgentGitContext.fromJson(fixture)!;
    expect(context.branchLabel, 'hn/preview-fix +1');
    expect(context.displayProject(null)?.branch, 'hn/preview-fix');
    expect(context.requestIdentity?['cwd'], '/ship-hn');
    expect(
      context.branchRows.where(context.isRecentBranch).single.branch,
      'hn/preview-fix',
    );
    fixture['recentWork'] = {
      'project': {...recent, 'branch': 'unverified'},
      'at': '2026-09-27T13:00:00Z',
    };
    expect(AgentGitContext.fromJson(fixture)!.branchLabel, '2 branches');
  });
  test('multiple checked-out branches are named without exposing temporary folders', () {
    final fixture = gitFixture();
    final project = fixture['current'] as Map<String, dynamic>;
    fixture['state'] = 'multiple';
    fixture['current'] = null;
    fixture['checkouts'] = [
      project,
      {
        ...project,
        'cwd': '/other-temp',
        'root': '/other-temp',
        'branch': 'hn/nfc',
      },
      {...project, 'cwd': '/duplicate-temp', 'root': '/duplicate-temp'},
    ];
    final context = AgentGitContext.fromJson(fixture)!;
    expect(context.branchLabel, '2 branches');
    expect(context.requestIdentity, isNull);
    expect(context.branchRows.map((b) => b.branch), [
      'hn/preview-fix',
      'hn/nfc',
    ]);
    expect(context.branchRows.every((b) => b.checkedOut), isTrue);
    expect(context.explanation, 'Branches checked out for this harness.');
  });
  test(
    'GitHub keeps a merged branch in history after its checkout disappears',
    () {
      final fixture = gitFixture();
      fixture['checkouts'] = <Object>[];
      fixture['current'] = null;
      fixture['state'] = 'unavailable';
      (fixture['history']['branches'] as List).clear();
      fixture['history']['pullRequests'][0]['result'].addAll({
        'headBranch': 'hn/done',
        'headRepository': 'acme/app',
        'state': 'Merged',
      });
      final context = AgentGitContext.fromJson(fixture)!;
      expect(context.branchRows.single.branch, 'hn/done');
      expect(context.branchRows.single.checkedOut, isFalse);
      expect(context.branchRows.single.pullRequests.single.state, 'Merged');
      expect(context.branchLabel, 'Branches');
    },
  );
  test('unknown activity does not override a Git branch or its PR context', () {
    final fresh = AgentGitContext.fromJson(gitFixture())!;
    final saved = AgentGitContext.fromJson({
      ...gitFixture(),
      'activityUncertain': true,
    })!;
    expect(saved.branchLabel, 'hn/preview-fix');
    expect(saved.explanation, 'Branch checked out for this harness.');
    expect(saved.displayProject(null)?.branch, 'hn/preview-fix');
    expect(saved.requestIdentity?['cwd'], '/ship-hn');
    expect(saved.pullRequests.single.state, 'Open');
    expect(saved, isNot(fresh));
    expect(fresh.activityUncertain, isFalse);
  });
  test('renamed PR aliases do not duplicate the original creation receipt', () {
    final git = gitFixture();
    final row = (git['history']['pullRequests'] as List).single as Map;
    row['aliases'] = ['https://github.com/acme/old-name/pull/12'];
    git['pullRequests'] = [
      {
        'url': 'https://github.com/acme/old-name/pull/12',
        'cwd': '/ship-hn',
        'at': '2026-09-27T13:00:00Z',
      },
    ];
    expect(
      AgentGitContext.fromJson(git)!.pullRequests.single.url.toString(),
      'https://github.com/acme/app/pull/12',
    );
  });
  test(
    'older list/push context cannot undo newer work in the same session',
    () {
      Agent versioned(int revision, String branch, {String epoch = 'daemon'}) =>
          workAgent(
            git: {
              ...gitFixture(branch: branch),
              'version': {'epoch': epoch, 'revision': revision},
            },
          );
      final current = versioned(2, 'new');
      final stale = versioned(1, 'old');
      expect(
        retainNewerGitContext(stale, current).displayProject!.branch,
        'new',
      );
      expect(
        retainNewerGitContext(
          versioned(3, 'newest'),
          current,
        ).displayProject!.branch,
        'newest',
      );
      expect(
        retainNewerGitContext(
          versioned(1, 'restart', epoch: 'new-daemon'),
          current,
        ).displayProject!.branch,
        'restart',
      );
      expect(retainNewerGitContext(stale, null).displayProject!.branch, 'old');
      expect(
        retainNewerGitContext(workAgent(), current).displayProject!.branch,
        'original',
      );
    },
  );
  test(
    'current display changes while launch and copy identity stay intact',
    () {
      final agent = workAgent(git: gitFixture());
      expect(agent.displayProject!.branch, 'hn/preview-fix');
      expect(agent.project!.branch, 'original');
      expect(agent.copyWith(name: 'new name').gitContext, agent.gitContext);
      expect(agent.gitContext!.requestIdentity, {
        'cwd': '/ship-hn',
        'branch': 'hn/preview-fix',
        'remote': 'github.com/acme/app',
      });
      expect(
        AppNotifier.agentsEqual(
          [agent],
          [workAgent(git: gitFixture(branch: 'hn/next'))],
        ),
        isFalse,
      );
      expect(
        AppNotifier.agentsEqual([agent], [workAgent(git: gitFixture())]),
        isTrue,
      );
    },
  );
  test('uncertainty never presents the launch branch as current work', () {
    for (final state in ['multiple', 'uncertain', 'unavailable']) {
      final agent = workAgent(git: gitFixture(state: state));
      expect(agent.displayProject!.shownBranch, isNull);
      expect(agent.gitContext!.requestIdentity, isNull);
      expect(agent.gitContext!.branchLabel, isNotNull);
    }
    expect(workAgent().displayProject!.branch, 'original');
  });
  test(
    'saved links are bounded and only validated GitHub PRs become actionable',
    () {
      expect(
        AgentGitContext.fromJson(gitFixture())!.pullRequests.single.state,
        'Open',
      );
      for (final url in [
        'javascript:alert(1)',
        'https://evil.example/a/b/pull/1',
        'https://github.com/a/../pull/1',
        'https://user@github.com/a/b/pull/1',
        'https://github.com/a/b/pull/1?x=1',
      ]) {
        expect(AgentGitContext.validatedPrUrl(url), isNull);
      }
      expect(AgentGitContext.fromJson({'state': 'made-up'}), isNull);
    },
  );
}
