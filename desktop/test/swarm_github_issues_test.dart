import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/github_issues.dart';

/// A Swarm project's tasks are its GitHub issues, read with `gh` on this computer as its person (Swarm v4, anh Dee
/// 2026-11-09): what `gh` answers becomes tasks, and each way it fails says what to do in a few words.
void main() {
  SwarmGitHub answering(
    ProcessResult Function(List<String> arguments) answer,
  ) => SwarmGitHub(run: (arguments) async => answer(arguments));

  test('reads a GitHub address as owner/name, and nothing else', () {
    expect(
      SwarmGitHub.repositoryOf('https://github.com/autonomous-ai/lampOS'),
      'autonomous-ai/lampOS',
    );
    expect(
      SwarmGitHub.repositoryOf('https://github.com/autonomous-ai/lampOS.git'),
      'autonomous-ai/lampOS',
    );
    expect(
      SwarmGitHub.repositoryOf('git@github.com:autonomous-ai/open.harness.git'),
      'autonomous-ai/open.harness',
    );
    expect(SwarmGitHub.repositoryOf('https://gitlab.com/a/b'), isNull);
    expect(SwarmGitHub.repositoryOf(null), isNull);
  });

  Map<String, Object?> node(
    int number,
    String updated, {
    List<Map<String, String>> labels = const [],
    int comments = 0,
    String? author,
  }) => {
    'number': number,
    'title': 'Issue $number',
    'url': 'https://github.com/autonomous-ai/lampOS/issues/$number',
    'createdAt': '2026-11-09T01:00:00Z',
    'updatedAt': updated,
    'author': ?(author == null ? null : {'login': author}),
    'labels': {'nodes': labels},
    'comments': {'totalCount': comments},
  };

  ProcessResult page(List<Map<String, Object?>> nodes, {String? next}) =>
      ProcessResult(
        1,
        0,
        jsonEncode({
          'data': {
            'repository': {
              'issues': {
                'pageInfo': {'hasNextPage': next != null, 'endCursor': next},
                'nodes': nodes,
              },
            },
          },
        }),
        '',
      );

  String queryOf(List<String> arguments) =>
      arguments.firstWhere((a) => a.startsWith('query='));

  test('lists open issues newest activity first, with labels in their colours, who opened it, when, and its comments', () async {
    late List<String> asked;
    final github = answering((arguments) {
      asked = arguments;
      return page([
        node(1, '2026-11-01T00:00:00Z'),
        node(
          2,
          '2026-11-09T00:00:00Z',
          author: '69tc',
          comments: 4,
          labels: [
            {'name': 'status:taken', 'color': 'fbca04'},
            {'name': 'builder:jarvis', 'color': '0e8a16'},
          ],
        ),
        {'title': 'Not an issue'},
      ]);
    });
    final issues = await github.issues('autonomous-ai/lampOS');
    // One GraphQL read, which names the repository and asks for what the cards show.
    expect(asked.take(2), ['api', 'graphql']);
    expect(asked, containsAll(['owner=autonomous-ai', 'name=lampOS']));
    expect(queryOf(asked), contains('states:OPEN'));
    expect(queryOf(asked), contains('labels(first:100){nodes{name color}}'));
    expect(queryOf(asked), contains('comments{totalCount}'));
    expect(issues.map((i) => i.number), [2, 1]);
    final first = issues.first;
    expect(first.agent, 'jarvis');
    expect(first.taken, isTrue);
    expect(first.author, '69tc');
    expect(first.comments, 4);
    expect(first.createdAt, DateTime.utc(2026, 11, 9, 1));
    expect(first.labelColors, {
      'status:taken': 'fbca04',
      'builder:jarvis': '0e8a16',
    });
    expect(issues.last.agent, isNull);
    expect(issues.last.taken, isFalse);
    expect(issues.last.comments, 0);
  });

  test('reads a long list a page at a time, telling the newest at once, and keeps it to show again', () async {
    final asked = <List<String>>[];
    final github = answering((arguments) {
      asked.add(arguments);
      return arguments.any((a) => a == 'after=c1')
          ? page([node(3, '2026-11-02T00:00:00Z')])
          : page([
              node(1, '2026-11-09T00:00:00Z'),
              node(2, '2026-11-08T00:00:00Z'),
            ], next: 'c1');
    });
    expect(github.kept('autonomous-ai/lampOS'), isNull);
    final told = <List<int>>[];
    final issues = await github.issues(
      'autonomous-ai/lampOS',
      onPage: (sofar) => told.add([for (final i in sofar) i.number]),
    );
    expect(asked, hasLength(2));
    expect(told, [
      [1, 2],
    ]);
    expect(issues.map((i) => i.number), [1, 2, 3]);
    expect(github.kept('autonomous-ai/lampOS')!.map((i) => i.number), [
      1,
      2,
      3,
    ]);
  });

  Map<String, Object?> comment(int n, String who, String body) => {
    'author': {'login': who},
    'body': body,
    'createdAt': '2026-11-09T0$n:00:00Z',
    'url': 'u#$n',
  };

  ProcessResult thread(
    List<Map<String, Object?>> comments, {
    String state = 'CLOSED',
    int total = 3,
    String? earlier,
  }) => ProcessResult(
    1,
    0,
    jsonEncode({
      'data': {
        'repository': {
          'issue': {
            ...node(5759, '2026-11-09T05:00:00Z', comments: total),
            'body': 'Score them again.',
            'state': state,
            'comments': {
              'totalCount': total,
              'pageInfo': {
                'hasPreviousPage': earlier != null,
                'startCursor': earlier,
              },
              'nodes': comments,
            },
          },
        },
      },
    }),
    '',
  );

  test('reads an issue with its newest comments, each signed by its agent, and where the earlier ones start', () async {
    late List<String> asked;
    final github = answering((arguments) {
      asked = arguments;
      return thread([
        comment(2, '69tc', 'Migrate, 09:3x GMT+7: done.'),
        comment(3, 'deehw', '**First builder**, 09:4x: mine.'),
        {
          'author': {'login': 'leo'},
          'body': 'no signature here',
        },
      ], earlier: 'cursor-1');
    });
    final result = await github.thread('autonomous-ai/lampOS', 5759);
    // The newest 30 only: a thread of 1,576 comments took 22 s whole and 0.8 s this way.
    expect(asked, containsAll(['number=5759', 'last=30']));
    expect(queryOf(asked), contains(r'comments(last:$last)'));
    expect(result.body, 'Score them again.');
    expect(result.open, isFalse);
    expect(result.createdAt, DateTime.utc(2026, 11, 9, 1));
    expect(result.issue.comments, 3);
    expect(result.earlier, 'cursor-1');
    expect(result.comments.map((c) => c.signedBy), [
      'Migrate',
      'First builder',
      null,
    ]);
    expect(result.comments.map((c) => c.author), ['69tc', 'deehw', 'leo']);
  });

  test('reads the page of comments before a cursor, and where the page before that starts', () async {
    late List<String> asked;
    final github = answering((arguments) {
      asked = arguments;
      return ProcessResult(
        1,
        0,
        jsonEncode({
          'data': {
            'repository': {
              'issue': {
                'comments': {
                  'pageInfo': {'hasPreviousPage': true, 'startCursor': 'c0'},
                  'nodes': [comment(1, 'deehw', 'Opened.')],
                },
              },
            },
          },
        }),
        '',
      );
    });
    final page = await github.earlier('autonomous-ai/lampOS', 5759, 'c1');
    expect(asked, containsAll(['number=5759', 'last=100', 'before=c1']));
    expect(page.comments.map((c) => c.body), ['Opened.']);
    expect(page.earlier, 'c0');
  });

  test(
    'keeps the threads it read, and reads ahead only those that changed',
    () async {
      final asked = <List<String>>[];
      final github = answering((arguments) {
        asked.add(arguments);
        return thread([comment(1, 'deehw', 'Hi.')]);
      });
      final issues = [
        for (final n in [5759, 5760, 5761])
          SwarmIssue(
            number: n,
            title: 'Issue $n',
            labels: const [],
            url: 'u$n',
            updatedAt: DateTime.utc(2026, 11, 9, 5),
          ),
      ];
      expect(github.keptThread('autonomous-ai/lampOS', 5759), isNull);
      // The fixture's thread says it was last active at 05:00, as the issues do: 5759 reads, and the others read the same thread.
      await github.prefetch('autonomous-ai/lampOS', issues, count: 2);
      expect(asked, hasLength(2));
      expect(github.keptThread('autonomous-ai/lampOS', 5759), isNotNull);
      // Nothing changed: nothing is read.
      await github.prefetch('autonomous-ai/lampOS', issues.take(1).toList());
      expect(asked, hasLength(2));
      // 5759 was active again since: it is read again.
      final newer = SwarmIssue(
        number: 5759,
        title: 'Issue 5759',
        labels: const [],
        url: 'u',
        updatedAt: DateTime.utc(2026, 11, 9, 8),
      );
      await github.prefetch('autonomous-ai/lampOS', [newer]);
      expect(asked, hasLength(3));
    },
  );

  test('says how to fix each way gh fails', () async {
    Future<String> failure(SwarmGitHub github) async {
      try {
        await github.issues('autonomous-ai/lampOS');
      } on SwarmGitHubError catch (error) {
        return error.message;
      }
      return 'no failure';
    }

    expect(
      await failure(
        SwarmGitHub(run: (_) => throw const ProcessException('gh', [])),
      ),
      'Install the GitHub CLI (gh) to see tasks.',
    );
    expect(
      await failure(
        answering(
          (_) => ProcessResult(
            1,
            4,
            '',
            'To get started with GitHub CLI, please run:  gh auth login',
          ),
        ),
      ),
      'Sign in to GitHub: run gh auth login.',
    );
    expect(
      await failure(
        answering(
          (_) => ProcessResult(
            1,
            1,
            '',
            'GraphQL: Could not resolve to a Repository with the name',
          ),
        ),
      ),
      'You can\'t see autonomous-ai/lampOS on GitHub.',
    );
    expect(
      await failure(
        answering(
          (_) => ProcessResult(
            1,
            1,
            '',
            'the \'autonomous-ai/lampOS\' repository has disabled issues',
          ),
        ),
      ),
      'autonomous-ai/lampOS has issues turned off.',
    );
    expect(
      await failure(
        answering(
          (_) => ProcessResult(
            1,
            1,
            '',
            'gh: Could not resolve to an Issue with the number of 9.',
          ),
        ),
      ),
      'That issue is gone.',
    );
    expect(
      await failure(
        answering((_) => ProcessResult(1, 1, '', 'something else')),
      ),
      'GitHub didn\'t answer. Try again.',
    );
    expect(
      await failure(answering((_) => ProcessResult(1, 0, 'not json', ''))),
      'GitHub sent something unreadable. Try again.',
    );
    expect(
      await failure(
        SwarmGitHub(
          run: (_) => Completer<ProcessResult>().future,
          timeout: const Duration(milliseconds: 10),
        ),
      ),
      'GitHub didn\'t answer. Try again.',
    );
  });

  test('never runs a real gh under test', () async {
    expect(
      () => SwarmGitHub().issues('autonomous-ai/lampOS'),
      throwsA(
        isA<SwarmGitHubError>().having(
          (e) => e.message,
          'message',
          'Install the GitHub CLI (gh) to see tasks.',
        ),
      ),
    );
  });
}
