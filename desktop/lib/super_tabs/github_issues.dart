import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/hidden_process.dart';
import '../core/home_dir.dart';
import '../core/test_run.dart';
import '../logging/app_log.dart';

/// A Swarm project's tasks are its repository's GitHub issues (Swarm v4, anh Dee 2026-11-09), read with the GitHub CLI
/// on this computer, signed in as its person: each person sees exactly what github.com shows them, and nothing goes
/// through our server. One open issue, as `gh issue list` and `gh issue view` describe it.
class SwarmIssue {
  const SwarmIssue({
    required this.number,
    required this.title,
    required this.labels,
    required this.url,
    this.author,
    this.updatedAt,
  });

  final int number;
  final String title;
  final List<String> labels;
  final String url;

  /// Its GitHub author's login.
  final String? author;
  final DateTime? updatedAt;

  /// The agent it is for: its `builder:<name>` label, as lampOS's first builder labels them. Null when none.
  String? get agent {
    for (final label in labels) {
      if (label.startsWith('builder:') && label.length > 8) {
        return label.substring(8);
      }
    }
    return null;
  }

  /// Someone is on it: its `status:taken` label, which an agent adds when it claims the issue.
  bool get taken => labels.contains('status:taken');

  /// Null for anything that is not a whole issue.
  static SwarmIssue? read(Object? value) {
    if (value is! Map) return null;
    final number = value['number'], title = value['title'];
    final url = value['url'];
    if (number is! int || title is! String || url is! String) return null;
    return SwarmIssue(
      number: number,
      title: title,
      url: url,
      labels: [
        for (final label
            in value['labels'] is List ? value['labels'] as List : const [])
          if (label is Map && label['name'] is String) label['name'] as String,
      ],
      author: _login(value['author']),
      updatedAt: _time(value['updatedAt']),
    );
  }
}

/// One comment on an issue: an agent's post, signed by its name in its first words ("Migrate, 09:3x GMT+7: …"), as
/// lampOS's builders sign theirs, under its person's GitHub account.
class SwarmIssueComment {
  const SwarmIssueComment({
    required this.body,
    this.author,
    this.createdAt,
    this.url,
  });

  final String body;
  final String? author;
  final DateTime? createdAt;
  final String? url;

  /// The name it is signed with: the words before its first comma, when they read as a name. Null otherwise.
  String? get signedBy {
    final match = RegExp(r'^\**([A-Z][\w-]*(?: [A-Za-z][\w-]*)?)\**,')
        .firstMatch(body.trimLeft());
    return match?.group(1);
  }
}

/// An issue opened beside its project's channel: its text and its comments, oldest first.
class SwarmIssueThread {
  const SwarmIssueThread({
    required this.issue,
    required this.body,
    required this.comments,
    required this.open,
    this.createdAt,
  });

  final SwarmIssue issue;
  final String body;
  final List<SwarmIssueComment> comments;
  final bool open;
  final DateTime? createdAt;
}

/// Why GitHub could not be read, in the words the person sees.
class SwarmGitHubError implements Exception {
  const SwarmGitHubError(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Runs `gh` with these arguments; tests give their own.
typedef SwarmGhRun = Future<ProcessResult> Function(List<String> arguments);

/// Reads a project's issues with `gh` (see [SwarmIssue]).
class SwarmGitHub {
  SwarmGitHub({SwarmGhRun? run, this.timeout = const Duration(seconds: 30)})
    : _run = run ?? _runGh;

  final SwarmGhRun _run;

  /// How long one `gh` call may take before the person is told GitHub did not answer.
  final Duration timeout;

  /// At most this many open issues: lampOS had 144 open on 2026-11-09.
  static const issuesMax = 500;

  /// `owner/name` of a GitHub repository address (https or ssh, with or without `.git`). Null for anything else.
  static String? repositoryOf(String? url) {
    if (url == null) return null;
    final match = RegExp(r'github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$')
        .firstMatch(url.trim());
    return match == null ? null : '${match.group(1)}/${match.group(2)}';
  }

  /// [repository]'s open issues, newest activity first.
  Future<List<SwarmIssue>> issues(String repository) async {
    final answer = await _call([
      'issue',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--limit',
      '$issuesMax',
      '--json',
      'number,title,labels,author,updatedAt,url',
    ], repository);
    final issues = [for (final row in _list(answer)) ?SwarmIssue.read(row)];
    issues.sort(
      (a, b) =>
          (b.updatedAt ?? DateTime(0)).compareTo(a.updatedAt ?? DateTime(0)),
    );
    return issues;
  }

  /// Issue [number] of [repository] with its comments.
  Future<SwarmIssueThread> thread(String repository, int number) async {
    final answer = await _call([
      'issue',
      'view',
      '$number',
      '--repo',
      repository,
      '--json',
      'number,title,body,labels,author,createdAt,updatedAt,url,state,comments',
    ], repository);
    final Object? value;
    try {
      value = jsonDecode(answer);
    } on FormatException {
      throw const SwarmGitHubError(
        'GitHub sent something unreadable. Try again.',
      );
    }
    final issue =
        SwarmIssue.read(value) ??
        (throw const SwarmGitHubError(
          'GitHub sent something unreadable. Try again.',
        ));
    final map = value as Map;
    return SwarmIssueThread(
      issue: issue,
      body: map['body'] is String ? map['body'] as String : '',
      open: map['state'] != 'CLOSED',
      createdAt: _time(map['createdAt']),
      comments: [
        for (final row
            in map['comments'] is List ? map['comments'] as List : const [])
          if (row is Map && row['body'] is String)
            SwarmIssueComment(
              body: row['body'] as String,
              author: _login(row['author']),
              createdAt: _time(row['createdAt']),
              url: row['url'] is String ? row['url'] as String : null,
            ),
      ],
    );
  }

  Future<String> _call(List<String> arguments, String repository) async {
    final ProcessResult result;
    try {
      result = await _run(arguments).timeout(timeout);
    } on ProcessException {
      appLog.warn('super-tabs', 'GitHub issues not read: gh is not installed');
      throw const SwarmGitHubError('Install the GitHub CLI (gh) to see tasks.');
    } on TimeoutException {
      appLog.warn(
        'super-tabs',
        'GitHub issues not read: gh did not answer in ${timeout.inSeconds} s',
      );
      throw const SwarmGitHubError('GitHub didn\'t answer. Try again.');
    }
    if (result.exitCode == 0) return '${result.stdout}';
    final said = '${result.stderr}';
    appLog.warn(
      'super-tabs',
      'GitHub issues not read: gh exited ${result.exitCode}',
    );
    if (result.exitCode == 4 ||
        said.contains('gh auth login') ||
        said.contains('not logged in')) {
      throw const SwarmGitHubError('Sign in to GitHub: run gh auth login.');
    }
    if (said.contains('Could not resolve to a Repository') ||
        said.contains('HTTP 404')) {
      throw SwarmGitHubError('You can\'t see $repository on GitHub.');
    }
    if (said.contains('disabled issues') ||
        said.contains('has disabled issues')) {
      throw SwarmGitHubError('$repository has issues turned off.');
    }
    throw const SwarmGitHubError('GitHub didn\'t answer. Try again.');
  }

  static List<Object?> _list(String answer) {
    try {
      final value = jsonDecode(answer);
      if (value is List) return value;
    } on FormatException {
      // Read as unreadable below.
    }
    throw const SwarmGitHubError(
      'GitHub sent something unreadable. Try again.',
    );
  }

  /// `gh` where its installers put it: a Finder launch has only launchd's bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
  /// so Homebrew's and the user's own folders are tried first. Windows finds `gh.exe` on PATH, where its installer adds it.
  static String _gh() {
    if (Platform.isWindows) return 'gh';
    final home = homeDir();
    for (final path in [
      '/opt/homebrew/bin/gh',
      '/usr/local/bin/gh',
      '$home/.local/bin/gh',
      '/home/linuxbrew/.linuxbrew/bin/gh',
      '/usr/bin/gh',
    ]) {
      if (File(path).existsSync()) return path;
    }
    return 'gh';
  }

  static Future<ProcessResult> _runGh(List<String> arguments) {
    // A widget test never reaches a real gh: it gives its own runner.
    if (kUnderTest) throw const ProcessException('gh', [], 'not under test');
    return runHidden(
      _gh(),
      arguments,
      environment: const {'GH_PROMPT_DISABLED': '1', 'NO_COLOR': '1'},
    );
  }
}

String? _login(Object? author) => author is Map && author['login'] is String
    ? author['login'] as String
    : null;

DateTime? _time(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
