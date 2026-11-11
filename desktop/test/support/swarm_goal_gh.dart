import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:harness/super_tabs/github_issues.dart';

/// One check run of a milestone as GitHub's REST API lists it: named `goal: <milestone>`, with its id, how far it is, how
/// it ended, and its page.
Map<String, Object?> goalRun(
  int id,
  String milestone,
  String? conclusion, {
  String status = 'completed',
}) => {
  'id': id,
  'name': 'goal: $milestone',
  'status': status,
  'conclusion': conclusion,
  'html_url': 'https://github.com/acme/lampos/actions/runs/7/job/$id',
};

/// A commit of the default branch in these tests: its check runs, and the commits it stands on by their place in the list,
/// its first parent first. Without [parents] it stands on the one after it.
class FakeLanding {
  const FakeLanding(this.runs, {this.parents});
  final List<Map<String, Object?>> runs;
  final List<int>? parents;
}

/// A repository's goal as `gh api` answers the REST reads Desktop makes for it in these tests, the daemon's own: its goal
/// file, the repository (for its default branch), the branch's last hundred commits, and a commit's check runs a hundred a
/// page. Everything else a Swarm asks of `gh` fails as an unknown issue does.
class FakeGoalGitHub {
  FakeGoalGitHub({
    this.file,
    List<FakeLanding>? landings,
    this.branch = 'main',
    Duration timeout = const Duration(seconds: 30),
  }) : landings = landings ?? [] {
    github = SwarmGitHub(run: _run, timeout: timeout);
  }

  /// `agents/GOAL.md` on the default branch; null when the repository has none.
  String? file;

  /// The file is over 1 MB: GitHub answers for it with no content.
  bool tooBig = false;

  /// The default branch's commits, the newest first.
  List<FakeLanding> landings;

  /// The default branch's name.
  String branch;

  /// What `gh` exits with and prints until it is null again: a computer signed out, or GitHub limiting it. Only for the call
  /// at [failureAt] when that is given.
  (int, String)? failure;
  String? failureAt;

  /// This computer has no `gh`.
  bool missing = false;

  /// While set, a call for a commit's check runs waits for it, its answer already made: a slow GitHub, whose answer is old
  /// when it comes.
  Completer<void>? hold;

  /// Every goal call, as its place under the repository: `/contents/agents/GOAL.md`, `` (the repository itself),
  /// `/commits?...`, `/commits/<sha>/check-runs?...`.
  final calls = <String>[];

  /// The arguments of the last goal call.
  List<String> last = const [];

  late final SwarmGitHub github;

  /// How many times the goal was read: each read asks for the file once, first.
  int get reads => calls.where((path) => path.startsWith('/contents/')).length;

  /// A commit's id: forty hex digits that say its place in [landings].
  static String sha(int n) => (n + 1).toRadixString(16).padLeft(2, '0') * 20;

  static const signedOut = (
    4,
    'To get started with GitHub CLI, please run:  gh auth login',
  );
  static const notFound = (1, 'gh: Not Found (HTTP 404)');

  Future<ProcessResult> _run(List<String> arguments) async {
    final place = RegExp(r'^repos/[\w.-]+/[\w.-]+').firstMatch(arguments.last);
    if (arguments.first != 'api' ||
        arguments.contains('graphql') ||
        place == null) {
      return ProcessResult(
        1,
        1,
        '',
        'GraphQL: Could not resolve to an Issue with the number of 0.',
      );
    }
    if (missing) throw const ProcessException('gh', []);
    final path = arguments.last.substring(place.end);
    calls.add(path);
    last = arguments;
    if (failure case (final code, final said)?
        when failureAt == null || failureAt == path) {
      return ProcessResult(1, code, '', said);
    }
    final url = Uri.parse('https://api.github.com$path');
    ProcessResult ok(Object? body) => ProcessResult(1, 0, jsonEncode(body), '');
    if (path.isEmpty) return ok({'default_branch': branch});
    if (path == '/contents/agents/GOAL.md') {
      if (file == null) {
        return ProcessResult(
          1,
          notFound.$1,
          '{"message":"Not Found"}',
          notFound.$2,
        );
      }
      if (tooBig) return ok({'content': '', 'encoding': 'none'});
      // In lines of sixty, as GitHub sends it.
      final whole = base64.encode(utf8.encode(file!));
      return ok({
        'content': [
          for (var at = 0; at < whole.length; at += 60)
            '${whole.substring(at, at + 60 > whole.length ? whole.length : at + 60)}\n',
        ].join(),
        'encoding': 'base64',
      });
    }
    if (url.path == '/commits' &&
        url.queryParameters['sha'] == branch &&
        url.queryParameters['per_page'] == '100') {
      return ok([
        for (var n = 0; n < landings.length && n < 100; n++)
          {
            'sha': sha(n),
            'parents': [
              for (final parent in landings[n].parents ?? [n + 1])
                if (parent < landings.length) {'sha': sha(parent)},
            ],
          },
      ]);
    }
    final runs = RegExp(r'^/commits/([0-9a-f]{40})/check-runs$')
        .firstMatch(url.path);
    if (runs != null && url.queryParameters['per_page'] == '100') {
      final page = int.parse(url.queryParameters['page'] ?? '1');
      final of =
          landings[int.parse(runs[1]!.substring(0, 2), radix: 16) - 1].runs;
      final answer = ok({
        'total_count': of.length,
        'check_runs': of.skip((page - 1) * 100).take(100).toList(),
      });
      await hold?.future;
      return answer;
    }
    return ProcessResult(1, 1, '', 'gh: Server Error (HTTP 500)');
  }
}
