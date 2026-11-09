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

  test('lists open issues newest activity first, with their agent and whether someone is on it', () async {
    late List<String> asked;
    final github = answering((arguments) {
      asked = arguments;
      return ProcessResult(
        1,
        0,
        jsonEncode([
          {
            'number': 1,
            'title': 'Old',
            'labels': [],
            'url': 'u1',
            'updatedAt': '2026-11-01T00:00:00Z',
          },
          {
            'number': 2,
            'title': 'New',
            'url': 'u2',
            'updatedAt': '2026-11-09T00:00:00Z',
            'author': {'login': '69tc'},
            'labels': [
              {'name': 'status:taken'},
              {'name': 'builder:jarvis'},
            ],
          },
          {'title': 'Not an issue'},
        ]),
        '',
      );
    });
    final issues = await github.issues('autonomous-ai/lampOS');
    expect(asked.take(6), [
      'issue',
      'list',
      '--repo',
      'autonomous-ai/lampOS',
      '--state',
      'open',
    ]);
    expect(issues.map((i) => i.number), [2, 1]);
    expect(issues.first.agent, 'jarvis');
    expect(issues.first.taken, isTrue);
    expect(issues.first.author, '69tc');
    expect(issues.last.agent, isNull);
    expect(issues.last.taken, isFalse);
  });

  test('reads an issue with its comments, each signed by its agent', () async {
    final github = answering(
      (_) => ProcessResult(
        1,
        0,
        jsonEncode({
          'number': 5759,
          'title': 'Rows',
          'body': 'Score them again.',
          'url': 'u',
          'state': 'CLOSED',
          'labels': [],
          'createdAt': '2026-11-09T01:00:00Z',
          'comments': [
            {
              'author': {'login': '69tc'},
              'body': 'Migrate, 09:3x GMT+7: done.',
              'createdAt': '2026-11-09T02:00:00Z',
            },
            {
              'author': {'login': 'deehw'},
              'body': '**First builder**, 09:4x: mine.',
              'createdAt': '2026-11-09T03:00:00Z',
            },
            {
              'author': {'login': 'leo'},
              'body': 'no signature here',
            },
          ],
        }),
        '',
      ),
    );
    final thread = await github.thread('autonomous-ai/lampOS', 5759);
    expect(thread.body, 'Score them again.');
    expect(thread.open, isFalse);
    expect(thread.createdAt, DateTime.utc(2026, 11, 9, 1));
    expect(thread.comments.map((c) => c.signedBy), [
      'Migrate',
      'First builder',
      null,
    ]);
    expect(thread.comments.map((c) => c.author), ['69tc', 'deehw', 'leo']);
  });

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
