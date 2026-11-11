import 'dart:convert';
import 'dart:io';

import 'package:harness/super_tabs/github_issues.dart';

/// One check run of a milestone as GitHub's GraphQL names it: `goal: <milestone>`, its REST id, how far it is and how it ended.
Map<String, Object?> goalRun(
  int id,
  String milestone,
  String? conclusion, {
  String status = 'COMPLETED',
}) => {
  'databaseId': id,
  'name': 'goal: $milestone',
  'status': status,
  'conclusion': conclusion,
  'url': 'https://github.com/acme/lampos/runs/$id',
};

/// A commit of the default branch in these tests: its check runs, and the commits it stands on by their place in the list,
/// its first parent first. Without [parents] it stands on the one after it.
class FakeLanding {
  const FakeLanding(this.runs, {this.parents});
  final List<Map<String, Object?>> runs;
  final List<int>? parents;
}

/// A repository's goal as `gh api graphql` answers Desktop's one read of it in these tests: its goal file, its default
/// branch's last hundred commits and the tip's first-parent line five deep, each commit with its first hundred check runs;
/// then a commit's further checks, a page at a time. Everything else a Swarm asks of `gh` fails as an unknown issue does.
class FakeGoalGitHub {
  FakeGoalGitHub({this.file, List<FakeLanding>? landings})
    : landings = landings ?? [];

  /// `agents/GOAL.md` on the default branch; null when the repository has none.
  String? file;

  /// The default branch's commits, the newest first.
  List<FakeLanding> landings;

  /// What `gh` exits with and prints until it is null again: a computer signed out, or GitHub limiting it.
  (int, String)? failure;

  /// Every `gh` call that read the goal, as its arguments.
  final calls = <List<String>>[];

  late final github = SwarmGitHub(run: _run);

  /// A commit's id: forty hex digits that say its place in [landings].
  static String oid(int n) => (n + 1).toRadixString(16).padLeft(2, '0') * 20;

  static const signedOut = (
    4,
    'To get started with GitHub CLI, please run:  gh auth login',
  );

  Map<String, Object?> _contexts(int n, int from) {
    final runs = landings[n].runs;
    return {
      'pageInfo': {
        'hasNextPage': runs.length > from + 100,
        'endCursor': '${from + 100}',
      },
      // A commit status is among them too, with none of a check run's fields.
      'nodes': [
        if (from == 0) <String, Object?>{},
        ...runs.skip(from).take(100),
      ],
    };
  }

  Map<String, Object?> _commit(int n, int depth) {
    final parents = landings[n].parents ?? [n + 1];
    final first = parents.isEmpty || parents.first >= landings.length
        ? null
        : parents.first;
    return {
      'oid': oid(n),
      // A commit nothing ran on has no rollup at all.
      'statusCheckRollup': landings[n].runs.isEmpty
          ? null
          : {'contexts': _contexts(n, 0)},
      if (depth < 4)
        'parents': {
          'nodes': [if (first != null) _commit(first, depth + 1)],
        },
    };
  }

  Future<ProcessResult> _run(List<String> arguments) async {
    final query = arguments
        .firstWhere((a) => a.startsWith('query='), orElse: () => '')
        .substring(6);
    final goal = query.contains('agents/GOAL.md');
    final more = query.contains('object(oid:');
    if (!goal && !more) {
      return ProcessResult(
        1,
        1,
        '',
        'GraphQL: Could not resolve to an Issue with the number of 0.',
      );
    }
    calls.add(arguments);
    if (failure case (final code, final said)?) {
      return ProcessResult(1, code, '', said);
    }
    String value(String name) => arguments
        .firstWhere((a) => a.startsWith('$name='))
        .substring(name.length + 1);
    if (more) {
      final n = int.parse(value('oid').substring(0, 2), radix: 16) - 1;
      return _answer({
        'object': {
          'statusCheckRollup': {
            'contexts': _contexts(n, int.parse(value('after'))),
          },
        },
      });
    }
    return _answer({
      'goal': file == null ? null : {'text': file},
      'defaultBranchRef': landings.isEmpty
          ? null
          : {
              'name': 'main',
              'target': {
                'history': {
                  'nodes': [
                    for (var n = 0; n < landings.length && n < 100; n++)
                      {'oid': oid(n)},
                  ],
                },
                ..._commit(0, 0),
              },
            },
    });
  }

  static ProcessResult _answer(Map<String, Object?> repository) =>
      ProcessResult(
        1,
        0,
        jsonEncode({
          'data': {'repository': repository},
        }),
        '',
      );
}
