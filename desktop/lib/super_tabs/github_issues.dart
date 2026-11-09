import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../core/hidden_process.dart';
import '../core/home_dir.dart';
import '../core/test_run.dart';
import '../logging/app_log.dart';
import 'github_pulls.dart';

/// A Swarm project's tasks are its repository's GitHub issues (Swarm v4, anh Dee 2026-11-09), read with the GitHub CLI
/// on this computer, signed in as its person: each person sees exactly what github.com shows them, and nothing goes
/// through our server. One open issue, as `gh issue list` and `gh issue view` describe it.
class SwarmIssue {
  const SwarmIssue({
    required this.number,
    required this.title,
    required this.labels,
    required this.url,
    this.labelColors = const {},
    this.author,
    this.createdAt,
    this.updatedAt,
    this.comments = 0,
  });

  final int number;
  final String title;
  final List<String> labels;
  final String url;

  /// Each label's colour as GitHub gives it, six hex digits with no `#`: the chips are drawn in it, as github.com draws them.
  final Map<String, String> labelColors;

  /// Its GitHub author's login.
  final String? author;

  /// When it was opened, as github.com's "opened 6h ago".
  final DateTime? createdAt;
  final DateTime? updatedAt;

  /// How many comments it has.
  final int comments;

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
    final labels = _nodes(value['labels']);
    final comments = value['comments'];
    return SwarmIssue(
      number: number,
      title: title,
      url: url,
      labels: [
        for (final label in labels)
          if (label is Map && label['name'] is String) label['name'] as String,
      ],
      labelColors: {
        for (final label in labels)
          if (label is Map &&
              label['name'] is String &&
              label['color'] is String)
            label['name'] as String: label['color'] as String,
      },
      author: _login(value['author']),
      createdAt: _time(value['createdAt']),
      updatedAt: _time(value['updatedAt']),
      comments: comments is Map && comments['totalCount'] is int
          ? comments['totalCount'] as int
          : 0,
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
    this.earlier,
  });

  final SwarmIssue issue;
  final String body;

  /// The newest comments, oldest first: [SwarmGitHub.lastComments] of them, the rest through [SwarmGitHub.earlierComments].
  final List<SwarmIssueComment> comments;
  final bool open;
  final DateTime? createdAt;

  /// Where the comments before [comments] start, or null when it holds them all.
  final String? earlier;
}

/// A page of the comments before the ones a thread holds, oldest first.
class SwarmIssueEarlier {
  const SwarmIssueEarlier({required this.comments, this.earlier});
  final List<SwarmIssueComment> comments;

  /// Where the page before this one starts, or null when there is none.
  final String? earlier;
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

  /// How many of a thread's newest comments are read at once. Reading all of one (lampOS #5385: 1,576 comments, 1.8 MB) took
  /// 22 s with `gh issue view`; its newest 30 take 0.7 s (2026-11-09).
  static const lastComments = 30;

  /// How many comments one "earlier" read brings.
  static const earlierComments = 100;

  /// How many threads are kept to open again at once.
  static const threadsKept = 60;

  /// How many repositories' issue lists are kept to show again at once.
  static const listsKept = 20;

  /// `owner/name` of a GitHub repository address (https or ssh, with or without `.git`). Null for anything else.
  static String? repositoryOf(String? url) {
    if (url == null) return null;
    final match = RegExp(r'github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$')
        .firstMatch(url.trim());
    return match == null ? null : '${match.group(1)}/${match.group(2)}';
  }

  /// At most this many open pull requests are read for a board: newest activity first, a team's open ones at once.
  static const pullsMax = 50;

  final _lists = <String, List<SwarmIssue>>{};
  final _pulls = <String, Map<int, SwarmPull>>{};
  final _threads = <String, SwarmIssueThread>{};
  final _reading = <String>{};

  /// [repository]'s issues as they were last read, to show at once while [issues] reads them again. Null before the first.
  List<SwarmIssue>? kept(String repository) => _lists[repository];

  /// [repository]'s open pull requests by the task each is for, as they were last read. Null before the first.
  Map<int, SwarmPull>? keptPulls(String repository) => _pulls[repository];

  /// Issue [number]'s thread as it was last read, to show at once while [thread] reads it again. Null before the first.
  SwarmIssueThread? keptThread(String repository, int number) =>
      _threads['$repository#$number'];

  /// [repository]'s open issues, newest activity first, each with its labels in their colours, who opened it and when, and how
  /// many comments it has: one GraphQL read of up to 100 a page, [onPage] told the issues so far after each, so the newest show
  /// while the rest are read.
  Future<List<SwarmIssue>> issues(
    String repository, {
    void Function(List<SwarmIssue> sofar)? onPage,
  }) async {
    final (owner, name) = _split(repository);
    final issues = <SwarmIssue>[];
    String? after;
    do {
      final answer = await _call([
        'api',
        'graphql',
        '-f',
        'query=$_issuesQuery',
        '-f',
        'owner=$owner',
        '-f',
        'name=$name',
        '-F',
        'first=${min(100, issuesMax - issues.length)}',
        if (after != null) ...['-f', 'after=$after'],
      ], repository);
      final page = _data(answer, ['repository', 'issues']);
      for (final row in _nodes(page)) {
        if (SwarmIssue.read(row) case final issue?) issues.add(issue);
      }
      final info = page['pageInfo'];
      after = info is Map && info['hasNextPage'] == true
          ? info['endCursor'] as String?
          : null;
      if (after != null && issues.length < issuesMax) {
        onPage?.call(_newestFirst([...issues]));
      }
    } while (after != null && issues.length < issuesMax);
    final list = _newestFirst(issues);
    _lists.remove(repository);
    _lists[repository] = list;
    while (_lists.length > listsKept) {
      _lists.remove(_lists.keys.first);
    }
    return list;
  }

  /// [repository]'s open pull requests, by the task each is for ([SwarmPull.tasks]); a task with two has the one with the
  /// newest activity. One GraphQL read of the newest [pullsMax], each with its head's checks, whether it conflicts, and its
  /// newest comments, where its readers' verdicts are.
  Future<Map<int, SwarmPull>> pulls(String repository) async {
    final (owner, name) = _split(repository);
    final answer = await _call([
      'api',
      'graphql',
      '-f',
      'query=$_pullsQuery',
      '-f',
      'owner=$owner',
      '-f',
      'name=$name',
      '-F',
      'first=$pullsMax',
    ], repository);
    final map = _data(answer, ['repository']);
    final branch = map['defaultBranchRef'];
    final defaultBranch = branch is Map && branch['name'] is String
        ? branch['name'] as String
        : null;
    final byTask = <int, SwarmPull>{};
    for (final row in _nodes(map['pullRequests'])) {
      final pull = SwarmPull.read(row, defaultBranch: defaultBranch);
      if (pull == null) continue;
      for (final task in pull.tasks) {
        byTask.putIfAbsent(task, () => pull);
      }
    }
    _pulls.remove(repository);
    _pulls[repository] = byTask;
    while (_pulls.length > listsKept) {
      _pulls.remove(_pulls.keys.first);
    }
    return byTask;
  }

  /// Issue [number] of [repository]: its text, and its newest [lastComments] comments, oldest first.
  Future<SwarmIssueThread> thread(String repository, int number) async {
    final (owner, name) = _split(repository);
    final answer = await _call([
      'api',
      'graphql',
      '-f',
      'query=$_threadQuery',
      '-f',
      'owner=$owner',
      '-f',
      'name=$name',
      '-F',
      'number=$number',
      '-F',
      'last=$lastComments',
    ], repository);
    final map = _data(answer, ['repository', 'issue']);
    final issue =
        SwarmIssue.read(map) ??
        (throw const SwarmGitHubError(
          'GitHub sent something unreadable. Try again.',
        ));
    final comments = _commentsOf(map['comments']);
    final thread = SwarmIssueThread(
      issue: issue,
      body: map['body'] is String ? map['body'] as String : '',
      open: map['state'] != 'CLOSED',
      createdAt: issue.createdAt,
      comments: comments.comments,
      earlier: comments.earlier,
    );
    final key = '$repository#$number';
    _threads.remove(key);
    _threads[key] = thread;
    while (_threads.length > threadsKept) {
      _threads.remove(_threads.keys.first);
    }
    return thread;
  }

  /// The [earlierComments] comments before [cursor] (a thread's or an earlier page's `earlier`), oldest first.
  Future<SwarmIssueEarlier> earlier(
    String repository,
    int number,
    String cursor,
  ) async {
    final (owner, name) = _split(repository);
    final answer = await _call([
      'api',
      'graphql',
      '-f',
      'query=$_earlierQuery',
      '-f',
      'owner=$owner',
      '-f',
      'name=$name',
      '-F',
      'number=$number',
      '-F',
      'last=$earlierComments',
      '-f',
      'before=$cursor',
    ], repository);
    final page = _commentsOf(
      _data(answer, ['repository', 'issue'])['comments'],
    );
    return SwarmIssueEarlier(comments: page.comments, earlier: page.earlier);
  }

  /// Reads the threads of the first [count] of [issues] that are not kept as they stand (their newest activity is newer than
  /// the kept copy), two at a time, so opening one is instant. A read that fails is left for when the person opens it.
  Future<void> prefetch(
    String repository,
    List<SwarmIssue> issues, {
    int count = 6,
  }) async {
    final wanted = [
      for (final issue in issues.take(count))
        if (!_reading.contains('$repository#${issue.number}') &&
            (keptThread(repository, issue.number)?.issue.updatedAt !=
                issue.updatedAt))
          issue.number,
    ];
    Future<void> work() async {
      while (wanted.isNotEmpty) {
        final number = wanted.removeAt(0);
        final key = '$repository#$number';
        _reading.add(key);
        try {
          await thread(repository, number);
        } on SwarmGitHubError {
          // Opening it reads it again and says why it could not be read.
        } catch (error) {
          // A thread GitHub sent in a shape this app does not read: opening it says so; the others are still read ahead.
          appLog.warn(
            'super-tabs',
            'GitHub thread not read ahead: ${error.runtimeType}',
          );
        } finally {
          _reading.remove(key);
        }
      }
    }

    await Future.wait([work(), work()]);
  }

  static List<SwarmIssue> _newestFirst(List<SwarmIssue> issues) => issues
    ..sort(
      (a, b) =>
          (b.updatedAt ?? DateTime(0)).compareTo(a.updatedAt ?? DateTime(0)),
    );

  static (String, String) _split(String repository) {
    final at = repository.indexOf('/');
    return (repository.substring(0, at), repository.substring(at + 1));
  }

  static ({List<SwarmIssueComment> comments, String? earlier}) _commentsOf(
    Object? value,
  ) {
    final info = value is Map ? value['pageInfo'] : null;
    return (
      comments: [
        for (final row in _nodes(value))
          if (row is Map && row['body'] is String)
            SwarmIssueComment(
              body: row['body'] as String,
              author: _login(row['author']),
              createdAt: _time(row['createdAt']),
              url: row['url'] is String ? row['url'] as String : null,
            ),
      ],
      earlier: info is Map && info['hasPreviousPage'] == true
          ? info['startCursor'] as String?
          : null,
    );
  }

  /// The value [path] names in a GraphQL answer's `data`; unreadable when the answer, or it, is not what was asked for.
  static Map<Object?, Object?> _data(String answer, List<String> path) {
    Object? value;
    try {
      value = jsonDecode(answer);
    } on FormatException {
      throw const SwarmGitHubError(
        'GitHub sent something unreadable. Try again.',
      );
    }
    if (value is Map) value = value['data'];
    for (final key in path) {
      value = value is Map ? value[key] : null;
    }
    if (value is Map) return value;
    throw const SwarmGitHubError(
      'GitHub sent something unreadable. Try again.',
    );
  }

  static const _issueFields =
      'number title url createdAt updatedAt author{login} '
      'labels(first:100){nodes{name color}}';

  static const _issuesQuery =
      r'query($owner:String!,$name:String!,$first:Int!,$after:String){'
      r'repository(owner:$owner,name:$name){issues(first:$first,after:$after,'
      r'states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){'
      'pageInfo{hasNextPage endCursor} nodes{$_issueFields comments{totalCount}}}}}';

  /// A repository's open pull requests for its board ([pulls]): each one's head, checks, conflict and labels, the issues it
  /// closes, and its newest comments, where lampOS's readers write `READ-OK <sha>` as a first line.
  static const _pullsQuery =
      r'query($owner:String!,$name:String!,$first:Int!){'
      r'repository(owner:$owner,name:$name){defaultBranchRef{name} '
      r'pullRequests(states:OPEN,first:$first,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{'
      'number title url isDraft headRefName headRefOid baseRefName body mergeable '
      'labels(first:20){nodes{name}} closingIssuesReferences(first:5){nodes{number}} '
      'commits(last:1){nodes{commit{statusCheckRollup{state}}}} '
      'comments(last:30){nodes{body createdAt authorAssociation author{login}}}}}}}';

  static const _commentFields =
      'pageInfo{hasPreviousPage startCursor} nodes{body createdAt url author{login}}';

  static const _threadQuery =
      r'query($owner:String!,$name:String!,$number:Int!,$last:Int!){'
      r'repository(owner:$owner,name:$name){issue(number:$number){'
      '$_issueFields body state '
      'comments(last:\$last){totalCount $_commentFields}}}}';

  static const _earlierQuery =
      r'query($owner:String!,$name:String!,$number:Int!,$last:Int!,$before:String){'
      r'repository(owner:$owner,name:$name){issue(number:$number){'
      'comments(last:\$last,before:\$before){$_commentFields}}}}';

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
    if (said.contains('Could not resolve to an Issue')) {
      throw const SwarmGitHubError('That issue is gone.');
    }
    // GitHub answered, so trying again at once only meets the same limit.
    if (said.contains('rate limit') || said.contains('HTTP 429')) {
      throw const SwarmGitHubError(
        'GitHub is limiting requests. Try again in a few minutes.',
      );
    }
    if (said.contains('SAML')) {
      throw const SwarmGitHubError(
        'Allow gh in this organisation\'s SSO on github.com.',
      );
    }
    if (said.contains('disabled issues') ||
        said.contains('has disabled issues')) {
      throw SwarmGitHubError('$repository has issues turned off.');
    }
    throw const SwarmGitHubError('GitHub didn\'t answer. Try again.');
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

/// A GraphQL connection's `nodes`, or a plain list: what both shapes of a list of rows hold.
List<Object?> _nodes(Object? value) {
  if (value is List) return value;
  if (value is Map && value['nodes'] is List) return value['nodes'] as List;
  return const [];
}

String? _login(Object? author) => author is Map && author['login'] is String
    ? author['login'] as String
    : null;

DateTime? _time(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
