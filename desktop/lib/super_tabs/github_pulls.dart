import 'github_issues.dart';
import 'model.dart';

/// One agent's name however it is written: as it signs a comment ("Pip Two"), as its builder label has it (`pip-two`), or
/// cased otherwise: in lower case, letters and digits only. The merger's rule (cli superTabs/githubMerge.ts `sameKey`), so the
/// board finds the agent a label or a signature names, and counts a read as the merger does.
String swarmSameKey(String name) =>
    name.toLowerCase().replaceAll(_notLetterOrDigit, '');
final _notLetterOrDigit = RegExp(r'[^\p{L}\p{N}]', unicode: true);

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
    this.author,
    this.updatedAt,
    this.readOk = false,
  });

  final int number;
  final String title;
  final String url;

  /// Its head branch, `pip/14` by the team's rule.
  final String branch;
  final SwarmPullStatus status;

  /// The issues it closes when it merges ("Closes #14").
  final List<int> closes;

  /// The agent it is by, in lowercase ([authorOf]): its builder label, else its branch's first part. Null when neither names one.
  final String? author;

  /// When anything last happened on it, as its row in Pull requests says.
  final DateTime? updatedAt;

  /// It has the READ-OK it needs on its head, as the merger counts them: with its checks still running, Harness merges it
  /// once they pass, as lampOS's train bot takes a read PR whose own run is not red (train-bot.sh `eligible`).
  final bool readOk;

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
  static final _notAName = RegExp(r'^(?:READ-OK|HOLD|LGTM)\b');

  /// Who wrote it, as the merger counts writers (none of them is its reader): each builder label's name, in any case, and
  /// its branch's first part (`pip/12`).
  static Set<String> writersOf(List<String> labels, String branch) => {
    for (final label in labels)
      if (label.toLowerCase().startsWith('builder:') && label.length > 8)
        swarmSameKey(label.substring(8)),
    if (branch.contains('/')) swarmSameKey(branch.split('/').first),
  };

  /// The agents of the Swarm's projects on [repository], by [swarmSameKey]: from the login that opened a pull request, only their
  /// signed READ-OK is a read. Null before the Swarm is read.
  static Set<String>? teamOf(SuperTabSnapshot? snapshot, String repository) {
    if (snapshot == null) return null;
    final projects = {
      for (final project in snapshot.projects)
        if (SwarmGitHub.repositoryOf(
              project.repository?['repositoryUrl'] as String?,
            ) ==
            repository)
          project.id,
    };
    return {
      for (final agent in snapshot.agents)
        if (projects.contains(agent.projectId))
          swarmSameKey(agent.displayName ?? agent.name),
    };
  }

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
    // Harness's train (cli/src/superTabs/githubTrain.ts): it carries pull requests that were read, so nobody reads it and
    // no agent wrote it. Its checks run on the combined change, and it lands when they pass. By its branch and its title:
    // anyone can push a branch under the prefix, and one not titled as a train is a builder's, still to read.
    final train =
        branch.startsWith(_trainBranch) && title.startsWith(_trainTitle);
    final author = train ? null : authorOf(labels, branch);
    final standing = standingOf(
      draft: row['isDraft'] == true,
      head: head,
      author: author,
      writers: train ? const {} : writersOf(labels, branch),
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
    );
    return SwarmPull(
      number: number,
      title: title,
      url: url,
      branch: branch,
      author: author,
      updatedAt: DateTime.tryParse(row['updatedAt'] as String? ?? ''),
      closes: [
        for (final issue in _nodes(row['closingIssuesReferences']))
          if (issue is Map && issue['number'] is int) issue['number'] as int,
      ],
      status: train && standing.status == SwarmPullStatus.review
          ? SwarmPullStatus.merging
          : standing.status,
      readOk: train || standing.read,
    );
  }

  /// The branches Harness's train builds on, and how it titles its pull request (cli/src/superTabs/githubTrain.ts
  /// TRAIN_BRANCH, TITLE).
  static const _trainBranch = 'harness-train/', _trainTitle = 'Train: ';

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
    Set<String> writers = const {},
    String? opener,
    Set<String>? team,
  }) => standingOf(
    draft: draft,
    head: head,
    author: author,
    body: body,
    comments: comments,
    checks: checks,
    mergeable: mergeable,
    intoDefault: intoDefault,
    writers: writers,
    opener: opener,
    team: team,
  ).status;

  /// [statusOf], and whether it has the READ-OK it needs on its head whatever its checks are doing ([SwarmPull.readOk]).
  static ({SwarmPullStatus status, bool read}) standingOf({
    required bool draft,
    required String head,
    required String? author,
    required String body,
    required List<Map<Object?, Object?>> comments,
    required String? checks,
    required String? mergeable,
    bool intoDefault = true,
    Set<String> writers = const {},
    String? opener,
    Set<String>? team,
  }) {
    var twoReads = RegExp(r'\bTWO READS\b').hasMatch(body);
    final notReaders = {
      ...writers,
      ?(author == null ? null : swarmSameKey(author)),
    };
    // Each reader's last verdict, by comment time: GitHub lists them oldest first. [own] marks one from the opener's login
    // that no teammate signed: it may be its author's, so it is never a read, but it still replaces that login's last word.
    final last =
        <String, ({String verdict, String sha, String at, bool own})>{};
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
      // Every agent of a person posts as that person's login, which opened the pull request: from it, only a teammate's
      // signature names a reader (Harness's merger, cli githubMerge.ts). Before the team is known, none does.
      final own =
          opener != null &&
          login.toLowerCase() == opener.toLowerCase() &&
          (signed == null ||
              team == null ||
              !team.map(swarmSameKey).contains(swarmSameKey(signed)));
      final reader = own ? login : signed ?? login;
      if (reader.isEmpty || reader == _harness) continue;
      final at = comment['createdAt'] is String
          ? comment['createdAt'] as String
          : '';
      final key = own ? 'login:${login.toLowerCase()}' : swarmSameKey(reader);
      final before = last[key];
      if (before == null || at.compareTo(before.at) >= 0) {
        last[key] = (
          verdict: found.group(1)!,
          sha: found.group(2)!,
          at: at,
          own: own,
        );
      }
    }
    final reads = last.entries
        .where(
          (e) =>
              e.value.verdict == 'READ-OK' &&
              !e.value.own &&
              head.startsWith(e.value.sha) &&
              !notReaders.contains(e.key),
        )
        .length;
    final held = last.values.any((v) => v.verdict == 'HOLD');
    final read = !draft && !held && intoDefault && reads >= (twoReads ? 2 : 1);
    final status = draft
        ? SwarmPullStatus.draft
        : held
        ? SwarmPullStatus.held
        : mergeable == 'CONFLICTING'
        ? SwarmPullStatus.conflict
        : checks == 'FAILURE' || checks == 'ERROR'
        ? SwarmPullStatus.failing
        : checks == 'PENDING' || checks == 'EXPECTED'
        ? SwarmPullStatus.checks
        : read
        ? SwarmPullStatus.merging
        : SwarmPullStatus.review;
    return (status: status, read: read);
  }
}

/// A GraphQL connection's `nodes`, or a plain list.
List<Object?> _nodes(Object? value) {
  if (value is List) return value;
  if (value is Map && value['nodes'] is List) return value['nodes'] as List;
  return const [];
}
