/// A task's pull request on its project's board (Swarm v4, anh Dee 2026-11-09: "show PR status on task cards"): the open
/// pull request that closes the issue ("Closes #14"), else the one on its builder's branch for it (`pip/14`), and where it
/// stands by the rule Harness merges by (cli/src/superTabs/githubMerge.ts), so a card says what happens next.
enum SwarmPullStatus {
  /// Its builder is still building it.
  draft('Draft'),

  /// Its checks are running.
  checks('Checks'),

  /// Its checks passed, and it waits for a READ-OK on its head.
  review('Review'),

  /// A check on its head failed.
  failing('Failing'),

  /// A reader's last word on it is a HOLD, which stands until that reader's later READ-OK.
  held('Held'),

  /// It conflicts with the branch it goes into.
  conflict('Conflict'),

  /// A READ-OK on its head and its checks green: Harness merges it.
  merging('Merging');

  const SwarmPullStatus(this.word);

  /// The one word its chip says.
  final String word;
}

/// One open pull request of a project, as the tasks it is for show it.
class SwarmPull {
  const SwarmPull({
    required this.number,
    required this.title,
    required this.url,
    required this.branch,
    required this.status,
    this.closes = const [],
  });

  final int number;
  final String title;
  final String url;

  /// Its head branch, `pip/14` by the team's rule.
  final String branch;
  final SwarmPullStatus status;

  /// The issues it closes when it merges ("Closes #14").
  final List<int> closes;

  /// The tasks it is for: those it closes, else the issue its branch is named for (`pip/14`).
  List<int> get tasks {
    if (closes.isNotEmpty) return closes;
    final match = RegExp(r'^[^/]+/(\d+)$').firstMatch(branch);
    final number = match == null ? null : int.tryParse(match.group(1)!);
    return [?number];
  }

  /// A verdict as lampOS's readers write it, the first line of a comment: `READ-OK <sha>` or `HOLD <sha>`.
  static final _verdict = RegExp(
    r'(?<![\w-])(READ-OK|HOLD)\s+([0-9a-f]{7,40})(?![0-9a-f])',
  );

  /// The name a comment is signed with in its first words ("Juno, 14:20, to **Pip**: …").
  static final _signature = RegExp(
    r'^\W*([A-Za-z][\w-]*(?: [A-Za-z][\w-]*)?)\**\s*[,:(]',
  );

  /// What a first line opens with that is no reader's name: a verdict, or a reader's shorthand for one.
  static final _notAName = RegExp(
    r'^(?:READ-OK|HOLD|LGTM)\b',
    caseSensitive: false,
  );

  /// Who may give a verdict: the repository's people, as GitHub names them.
  static const _team = {'OWNER', 'MEMBER', 'COLLABORATOR'};

  /// Harness's own posts, which say what it merged and never judge.
  static const _harness = 'Harness';

  /// A pull request as the GraphQL read in [SwarmGitHub.pulls] answers it (its default branch beside it), or null for
  /// anything else.
  static SwarmPull? read(
    Object? row, {
    String? defaultBranch,
    Set<String>? team,
  }) {
    if (row is! Map) return null;
    final number = row['number'], title = row['title'], url = row['url'];
    final head = row['headRefOid'], branch = row['headRefName'];
    if (number is! int ||
        title is! String ||
        url is! String ||
        head is! String ||
        branch is! String) {
      return null;
    }
    final labels = [
      for (final label in _nodes(row['labels']))
        if (label is Map && label['name'] is String) label['name'] as String,
    ];
    final commits = _nodes(row['commits']);
    final last = commits.isEmpty ? null : commits.last;
    final commit = last is Map ? last['commit'] : null;
    final rollup = commit is Map ? commit['statusCheckRollup'] : null;
    final base = row['baseRefName'];
    return SwarmPull(
      number: number,
      title: title,
      url: url,
      branch: branch,
      closes: [
        for (final issue in _nodes(row['closingIssuesReferences']))
          if (issue is Map && issue['number'] is int) issue['number'] as int,
      ],
      status: statusOf(
        draft: row['isDraft'] == true,
        head: head,
        author: authorOf(labels, branch),
        body: row['body'] is String ? row['body'] as String : '',
        comments: [
          for (final comment in _nodes(row['comments']))
            if (comment is Map) comment,
        ],
        checks: rollup is Map ? rollup['state'] as String? : null,
        mergeable: row['mergeable'] as String?,
        intoDefault: defaultBranch == null || base == defaultBranch,
        opener: switch (row['author']) {
          {'login': final String login} => login,
          _ => null,
        },
        team: team,
      ),
    );
  }

  /// Its author by name, as the merger finds it: its builder label, else its branch's first part (`pip/12`).
  static String? authorOf(List<String> labels, String branch) {
    for (final label in labels) {
      if (label.startsWith('builder:') && label.length > 8) {
        return label.substring(8).toLowerCase();
      }
    }
    return branch.contains('/') ? branch.split('/').first.toLowerCase() : null;
  }

  /// Where a pull request stands, in the order the merger asks: a draft is not read; a HOLD stands over everything; a
  /// conflict or a failed check must be fixed before a READ-OK counts; then its checks must finish; then a READ-OK on its head
  /// from someone other than its author (two, from two readers, when its text or a comment says TWO READS) merges it; from
  /// [opener], the login that opened it, a READ-OK counts only signed with the name of one of [team] (the Swarm's agents, in
  /// lowercase; any name when unknown) that is not its author. A
  /// pull request into another branch than the default one is never merged by rule, so it stays in review.
  static SwarmPullStatus statusOf({
    required bool draft,
    required String head,
    required String? author,
    required String body,
    required List<Map<Object?, Object?>> comments,
    required String? checks,
    required String? mergeable,
    bool intoDefault = true,
    String? opener,
    Set<String>? team,
  }) {
    if (draft) return SwarmPullStatus.draft;
    var twoReads = RegExp(r'\bTWO READS\b').hasMatch(body);
    // Each reader's last verdict, by comment time: GitHub lists them oldest first.
    final last = <String, ({String verdict, String sha, String at})>{};
    for (final comment in comments) {
      if (!_team.contains(comment['authorAssociation'])) continue;
      final text = comment['body'] is String ? comment['body'] as String : '';
      final first = text
          .split('\n')
          .firstWhere((line) => line.trim().isNotEmpty, orElse: () => '');
      if (RegExp(r'\bTWO READS\b').hasMatch(first)) twoReads = true;
      final found = _verdict.firstMatch(first);
      if (found == null) continue;
      final author = comment['author'];
      final login = author is Map && author['login'] is String
          ? author['login'] as String
          : '';
      var signed = _signature.firstMatch(first)?.group(1);
      // A verdict's own words ("READ-OK f6edb44: looks good") are no name.
      if (signed != null && _notAName.hasMatch(signed)) signed = null;
      // Every agent of a person posts as that person's login, which opened the pull request: from it, a READ-OK counts only
      // signed by a teammate, never unsigned (it may be its author's own). An unsigned HOLD from it still holds.
      final fromOpener =
          opener != null && login.toLowerCase() == opener.toLowerCase();
      if (fromOpener &&
          (signed == null ||
              (team != null && !team.contains(signed.toLowerCase())))) {
        if (found.group(1) != 'HOLD') continue;
        signed = null;
      }
      final reader = signed ?? login;
      if (reader.isEmpty || reader == _harness) continue;
      final at = comment['createdAt'] is String
          ? comment['createdAt'] as String
          : '';
      final key = reader.toLowerCase();
      final before = last[key];
      if (before == null || at.compareTo(before.at) >= 0) {
        last[key] = (verdict: found.group(1)!, sha: found.group(2)!, at: at);
      }
    }
    if (last.values.any((v) => v.verdict == 'HOLD')) {
      return SwarmPullStatus.held;
    }
    if (mergeable == 'CONFLICTING') return SwarmPullStatus.conflict;
    if (checks == 'FAILURE' || checks == 'ERROR') {
      return SwarmPullStatus.failing;
    }
    if (checks == 'PENDING' || checks == 'EXPECTED') {
      return SwarmPullStatus.checks;
    }
    final reads = last.entries
        .where(
          (e) =>
              e.value.verdict == 'READ-OK' &&
              head.startsWith(e.value.sha) &&
              e.key != author,
        )
        .length;
    return intoDefault && reads >= (twoReads ? 2 : 1)
        ? SwarmPullStatus.merging
        : SwarmPullStatus.review;
  }
}

/// A GraphQL connection's `nodes`, or a plain list.
List<Object?> _nodes(Object? value) {
  if (value is List) return value;
  if (value is Map && value['nodes'] is List) return value['nodes'] as List;
  return const [];
}
