import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:harness/super_tabs/github_issues.dart';

/// A repository's GitHub as `gh api -i` answers its three REST lists in these tests (Swarm v4, the agents' channel): comments on
/// issues and pull requests, pull requests, and what happened to issues, each newest first and a page at a time, each answer
/// with an ETag that moves when its rows do, and a 304 for one read again unchanged, as GitHub answers. It also fails as a
/// computer's gh does: missing, signed out, limited, unable to see the repository, or down.
class FakeGitHubFeeds {
  FakeGitHubFeeds({this.repository = 'autonomous-ai/lampOS'});

  final String repository;

  /// Each list's rows as GitHub sends them, newest first.
  final comments = <Map<String, Object?>>[];
  final pulls = <Map<String, Object?>>[];
  final events = <Map<String, Object?>>[];

  /// Every `gh` call, as its arguments.
  final calls = <List<String>>[];

  /// What every call fails with until it is null.
  FakeGitHubFailure? failure;

  /// While set, every call waits for it: a slow GitHub.
  Completer<void>? hold;

  /// While set, every call for a page after the first waits for it: an older page still on its way.
  Completer<void>? holdOlder;

  /// When a limited call may ask again, as GitHub's `X-RateLimit-Reset` says it, in epoch seconds.
  int resetAt = 0;

  /// The issues a task's panel reads, by number: their titles. Any other issue is unknown, as GitHub says.
  final titles = <int, String>{};

  final _moved = {'issues/comments': 0, 'pulls': 0, 'issues/events': 0};
  var _next = 1000;

  late final github = SwarmGitHub(run: _run);

  /// How many calls asked for [list] (`issues/comments`, `pulls`, `issues/events`), of page [page] when given.
  int reads(String list, {int? page}) => [
    for (final call in calls)
      if (call.last.contains('repos/$repository/$list?') &&
          (page == null || call.last.endsWith('&page=$page')))
        call,
  ].length;

  /// The calls that carried an ETag.
  int get conditional => [
    for (final call in calls)
      if (call.contains('-H')) call,
  ].length;

  /// A comment [body] on issue or pull request [number], written at [at] by [by].
  void comment(
    int number,
    String body, {
    required String at,
    bool pull = false,
    String by = 'deehw',
    String association = 'MEMBER',
  }) {
    final id = _next++;
    comments.insert(0, {
      'id': id,
      'html_url':
          'https://github.com/$repository/${pull ? 'pull' : 'issues'}/$number#issuecomment-$id',
      'issue_url': 'https://api.github.com/repos/$repository/issues/$number',
      'user': {'login': by},
      'author_association': association,
      'body': body,
      'created_at': at,
      'updated_at': at,
    });
    _moved['issues/comments'] = _moved['issues/comments']! + 1;
  }

  /// Deletes the comment at [index] of [comments] (newest first), as GitHub's list then says.
  void deleteComment(int index) {
    comments.removeAt(index);
    _moved['issues/comments'] = _moved['issues/comments']! + 1;
  }

  /// A pull request [number], opened at [opened] from [branch], merged at [merged] when it was.
  void pull(
    int number,
    String title, {
    required String branch,
    required String opened,
    String? merged,
    List<String> labels = const [],
    String by = 'deehw',
    String association = 'MEMBER',
  }) {
    pulls.insert(0, {
      'number': number,
      'title': title,
      'html_url': 'https://github.com/$repository/pull/$number',
      'created_at': opened,
      'updated_at': merged ?? opened,
      'merged_at': merged,
      'head': {'ref': branch},
      'labels': [
        for (final label in labels) {'name': label},
      ],
      'user': {'login': by},
      'author_association': association,
    });
    _moved['pulls'] = _moved['pulls']! + 1;
  }

  /// Issue [number], [title], labelled [label] at [at].
  void labelled(
    int number,
    String title,
    String label, {
    required String at,
    bool pull = false,
  }) {
    titles[number] = title;
    events.insert(0, {
      'id': _next++,
      'event': 'labeled',
      'created_at': at,
      'label': {'name': label},
      'issue': {
        'number': number,
        'title': title,
        'html_url':
            'https://github.com/$repository/${pull ? 'pull' : 'issues'}/$number',
        if (pull) 'pull_request': {'url': 'x'},
      },
    });
    _moved['issues/events'] = _moved['issues/events']! + 1;
  }

  Future<ProcessResult> _run(List<String> arguments) async {
    calls.add(arguments);
    await hold?.future;
    if (arguments.last.contains('&page=') &&
        !arguments.last.endsWith('&page=1')) {
      await holdOlder?.future;
    }
    switch (failure) {
      case FakeGitHubFailure.missing:
        throw const ProcessException('gh', [], 'No such file or directory');
      case FakeGitHubFailure.signedOut:
        return ProcessResult(
          1,
          4,
          '',
          'To get started with GitHub CLI, please run:  gh auth login',
        );
      case FakeGitHubFailure.limited:
        return ProcessResult(
          1,
          1,
          'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\n'
              'X-Ratelimit-Reset: $resetAt\r\n\r\n{"message":"API rate limit exceeded"}',
          'gh: API rate limit exceeded (HTTP 403)',
        );
      case FakeGitHubFailure.hidden:
        return ProcessResult(
          1,
          1,
          'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}',
          'gh: Not Found (HTTP 404)',
        );
      case FakeGitHubFailure.down:
        return ProcessResult(1, 1, '', 'error connecting to api.github.com');
      case null:
        break;
    }
    // A task's panel reads its issue with GraphQL: its title and no comments.
    if (arguments.contains('graphql')) {
      final at = arguments.indexWhere((a) => a.startsWith('number='));
      final number = at < 0 ? null : int.tryParse(arguments[at].substring(7));
      final title = titles[number];
      if (number == null || title == null) {
        return ProcessResult(
          1,
          1,
          '',
          'GraphQL: Could not resolve to an Issue with the number of $number.',
        );
      }
      return ProcessResult(
        1,
        0,
        jsonEncode({
          'data': {
            'repository': {
              'issue': {
                'number': number,
                'title': title,
                'url': 'https://github.com/$repository/issues/$number',
                'createdAt': '2026-11-09T01:00:00Z',
                'updatedAt': '2026-11-09T07:00:00Z',
                'author': {'login': 'deehw'},
                'labels': {'nodes': <Object?>[]},
                'body': 'The text of $title.',
                'state': 'OPEN',
                'comments': {
                  'totalCount': 0,
                  'pageInfo': {'hasPreviousPage': false, 'startCursor': null},
                  'nodes': <Object?>[],
                },
              },
            },
          },
        }),
        '',
      );
    }
    final path = arguments.last;
    final prefix = 'repos/$repository/';
    if (!path.startsWith(prefix)) {
      return ProcessResult(1, 1, '', 'gh: Not Found (HTTP 404)');
    }
    final rest = path.substring(prefix.length);
    final list = rest.split('?').first;
    final query = Uri.splitQueryString(rest.split('?').last);
    final rows = switch (list) {
      'issues/comments' => comments,
      'pulls' => pulls,
      'issues/events' => events,
      _ => null,
    };
    if (rows == null) {
      return ProcessResult(1, 1, '', 'gh: Not Found (HTTP 404)');
    }
    final perPage = int.parse(query['per_page'] ?? '30');
    final page = int.parse(query['page'] ?? '1');
    final slice = rows.skip((page - 1) * perPage).take(perPage).toList();
    final etag = 'W/"$list-${_moved[list]}-$page"';
    final at = arguments.indexOf('-H');
    final given = at < 0
        ? null
        : arguments[at + 1].replaceFirst('If-None-Match: ', '');
    if (given == etag) {
      return ProcessResult(
        1,
        1,
        'HTTP/2.0 304 Not Modified\r\nEtag: $etag\r\n\r\n',
        'gh: HTTP 304',
      );
    }
    return ProcessResult(
      1,
      0,
      'HTTP/2.0 200 OK\r\nEtag: $etag\r\nContent-Type: application/json\r\n\r\n${jsonEncode(slice)}',
      '',
    );
  }
}

/// How a computer's `gh` fails.
enum FakeGitHubFailure { missing, signedOut, limited, hidden, down }
