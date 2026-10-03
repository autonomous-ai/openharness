import 'package:flutter/foundation.dart';

import 'models.dart';

bool sameGitConversation(Agent a, Agent? b) =>
    b != null &&
    a.id == b.id &&
    a.sessionId == b.sessionId &&
    a.engine == b.engine &&
    a.codexHome == b.codexHome &&
    a.project?.cwd == b.project?.cwd;

/// List and push messages can cross in flight. Scope ordering to this machine's same
/// conversation and daemon incarnation; a restarted daemon establishes a new epoch.
Agent retainNewerGitContext(Agent incoming, Agent? previous) {
  final old = previous?.gitContext, next = incoming.gitContext;
  if (sameGitConversation(incoming, previous) &&
      old?.epoch != null &&
      old!.epoch == next?.epoch &&
      old.revision > next!.revision) {
    return incoming.copyWith(gitContext: old);
  }
  return incoming;
}

String localWorkTime(DateTime timestamp) {
  final at = timestamp.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${at.year}-${two(at.month)}-${two(at.day)} ${two(at.hour)}:${two(at.minute)}';
}

typedef AgentWorkLocation = ({String cwd, DateTime at});
typedef AgentWorkBranch = ({
  String cwd,
  String? remote,
  String branch,
  DateTime at,
});
typedef AgentWorkPr = ({
  Uri url,
  String? cwd,
  DateTime at,
  String? state,
  DateTime? checkedAt,
  DateTime? createdAt,
  DateTime? updatedAt,
  DateTime? mergedAt,
  DateTime? closedAt,
  String? title,
  String? headBranch,
  String? baseBranch,
  String? headRepository,
});

DateTime? pullRequestTime(AgentWorkPr pr) => switch (pr.state) {
  'Merged' => pr.mergedAt,
  'Closed' => pr.closedAt,
  'Open' || 'Draft' => pr.updatedAt ?? pr.createdAt,
  _ => null,
};

typedef AgentBranchRow = ({
  String branch,
  String? repository,
  String repositoryKey,
  bool checkedOut,
  List<AgentWorkPr> pullRequests,
});

/// Display evidence from the owning machine. It never changes launch/resume cwd.
class AgentGitContext {
  const AgentGitContext({
    required this.state,
    this.current,
    this.checkouts,
    this.recentWork,
    this.recentWorkAt,
    this.observedAt,
    this.activityUncertain = false,
    this.locations = const [],
    this.branches = const [],
    this.pullRequests = const [],
    this.truncated = false,
    this.epoch,
    this.revision = 0,
  });
  final String state;
  final AgentProject? current;
  final List<AgentProject>? checkouts;
  final AgentProject? recentWork;
  final DateTime? recentWorkAt;
  final DateTime? observedAt;
  final bool activityUncertain;
  final List<AgentWorkLocation> locations;
  final List<AgentWorkBranch> branches;
  final List<AgentWorkPr> pullRequests;
  final bool truncated;
  final String? epoch;
  final int revision;

  List<AgentProject> get checkedOut => checkouts ?? [?current];
  AgentProject? get focusedProject => recentWork ?? current;
  bool isRecentBranch(AgentBranchRow row) =>
      recentWork != null &&
      row.branch == recentWork!.shownBranch &&
      row.repositoryKey ==
          (recentWork!.remote ?? recentWork!.root ?? recentWork!.cwd);

  /// Repository + branch is the visible identity. Paths only disambiguate local
  /// repositories without a remote; temporary folder names never become labels.
  List<AgentBranchRow> get branchRows {
    final rows = <(String, String), AgentBranchRow>{};
    void add(String branch, String? repository, String local, bool checkedOut) {
      final key = (repository ?? local, branch);
      final previous = rows[key];
      rows[key] = (
        branch: branch,
        repository: repository,
        repositoryKey: key.$1,
        checkedOut: checkedOut || previous?.checkedOut == true,
        pullRequests: previous?.pullRequests ?? <AgentWorkPr>[],
      );
    }

    for (final project in checkedOut) {
      if (project.shownBranch case final branch?) {
        add(branch, project.remote, project.root ?? project.cwd, true);
      }
    }
    for (final branch in branches) {
      add(branch.branch, branch.remote, branch.cwd, false);
    }
    for (final pr in pullRequests) {
      final branch = pr.headBranch;
      if (branch == null) continue;
      final repository =
          'github.com/${pr.headRepository ?? pr.url.pathSegments.take(2).join('/')}'
              .toLowerCase();
      add(branch, repository, pr.cwd ?? '', false);
      rows[(repository, branch)]!.pullRequests.add(pr);
    }
    return rows.values.toList();
  }

  String? get branchLabel {
    final checked = branchRows.where((row) => row.checkedOut).toList();
    if (recentWork?.shownBranch case final branch?) {
      return checked.length > 1 ? '$branch +${checked.length - 1}' : branch;
    }
    if (checked.length > 1) return '${checked.length} branches';
    if (checked.length == 1) return checked.single.branch;
    if (current?.detached == true) return 'Detached';
    if (branchRows.isNotEmpty || state == 'multiple' || state == 'uncertain') {
      return 'Branches';
    }
    return state == 'unavailable' ? 'Git unavailable' : null;
  }

  String get explanation => recentWork != null
      ? 'Branch in the most recent confirmed work location${recentWorkAt == null ? '.' : ' · ${localWorkTime(recentWorkAt!)}'}'
      : switch (state) {
          'multiple' => 'Branches checked out for this harness.',
          'uncertain' || 'unavailable' =>
            'Git is unavailable. Showing saved branches and pull requests.',
          _ => 'Branch checked out for this harness.',
        };

  AgentProject? displayProject(AgentProject? launch) {
    if (focusedProject != null) return focusedProject;
    if (launch == null) return null;
    // Keep useful repository context without presenting the launch branch as current work.
    return AgentProject(
      name: launch.name,
      cwd: launch.cwd,
      root: launch.root,
      remote: launch.remote,
      worktree: launch.worktree,
    );
  }

  Map<String, Object?>? get requestIdentity {
    final project = focusedProject;
    if (project == null || project.shownBranch == null) return null;
    return {
      'cwd': project.cwd,
      'branch': project.branch,
      'remote': project.remote,
    };
  }

  @override
  bool operator ==(Object other) =>
      other is AgentGitContext &&
      state == other.state &&
      current == other.current &&
      listEquals(checkouts, other.checkouts) &&
      recentWork == other.recentWork &&
      recentWorkAt == other.recentWorkAt &&
      observedAt == other.observedAt &&
      activityUncertain == other.activityUncertain &&
      truncated == other.truncated &&
      epoch == other.epoch &&
      revision == other.revision &&
      listEquals(locations, other.locations) &&
      listEquals(branches, other.branches) &&
      listEquals(pullRequests, other.pullRequests);
  @override
  int get hashCode => Object.hash(
    state,
    current,
    checkouts == null ? null : Object.hashAll(checkouts!),
    recentWork,
    recentWorkAt,
    observedAt,
    activityUncertain,
    truncated,
    epoch,
    revision,
    Object.hashAll(locations),
    Object.hashAll(branches),
    Object.hashAll(pullRequests),
  );

  static AgentGitContext? fromJson(Object? raw) {
    if (raw is! Map ||
        !const [
          'workspace',
          'observed',
          'multiple',
          'uncertain',
          'unavailable',
        ].contains(raw['state'])) {
      return null;
    }
    String? label(Object? v, [int max = 4096]) =>
        v is String &&
            v.isNotEmpty &&
            v.length <= max &&
            !RegExp(r'[\x00-\x1f\x7f]').hasMatch(v)
        ? v
        : null;
    DateTime? date(Object? v) => v is String ? DateTime.tryParse(v) : null;
    List<dynamic> rows(Object? value) =>
        value is List ? value.take(128).toList() : const [];
    final locations = <AgentWorkLocation>[];
    for (final row in rows(raw['locations'])) {
      if (row is! Map) continue;
      final cwd = label(row['cwd']), at = date(row['at']);
      if (cwd != null && at != null) locations.add((cwd: cwd, at: at));
    }
    final history = raw['history'] is Map ? raw['history'] as Map : const {};
    final branches = <AgentWorkBranch>[];
    for (final row in rows(history['branches'])) {
      if (row is! Map) continue;
      final cwd = label(row['cwd']),
          branch = label(row['branch'], 256),
          at = date(row['at']);
      if (cwd != null && branch != null && at != null) {
        branches.add((
          cwd: cwd,
          branch: branch,
          remote: label(row['remote']),
          at: at,
        ));
      }
    }
    final prs = <AgentWorkPr>[];
    final seen = <String>{};
    for (final row in [
      ...rows(history['pullRequests']),
      ...rows(raw['pullRequests']),
    ]) {
      if (row is! Map) continue;
      final url = validatedPrUrl(row['url']), at = date(row['at']);
      if (url == null || at == null || !seen.add(url.toString())) continue;
      for (final alias in rows(row['aliases'])) {
        final valid = validatedPrUrl(alias);
        if (valid != null) seen.add(valid.toString());
      }
      final result = row['result'];
      final state =
          result is Map &&
              result['status'] == 'found' &&
              result['url'] == url.toString() &&
              const [
                'Draft',
                'Open',
                'Merged',
                'Closed',
              ].contains(result['state'])
          ? result['state'] as String
          : null;
      prs.add((
        url: url,
        cwd: label(row['cwd']),
        at: at,
        state: state,
        checkedAt: date(row['checkedAt']),
        createdAt: state != null ? date(result['createdAt']) : null,
        updatedAt: state != null ? date(result['updatedAt']) : null,
        mergedAt: state != null ? date(result['mergedAt']) : null,
        closedAt: state != null ? date(result['closedAt']) : null,
        title: result is Map ? label(result['title'], 512) : null,
        headBranch: result is Map ? label(result['headBranch'], 256) : null,
        baseBranch: result is Map ? label(result['baseBranch'], 256) : null,
        headRepository: result is Map
            ? label(result['headRepository'], 512)
            : null,
      ));
      if (prs.length == 128) break;
    }
    final version = raw['version'];
    final checkouts = raw['checkouts'] is List
        ? List<AgentProject>.unmodifiable(
            rows(raw['checkouts'])
                .map(AgentProject.fromJson)
                .whereType<AgentProject>(),
          )
        : null;
    final recent = raw['recentWork'];
    final recentProject = recent is Map
        ? AgentProject.fromJson(recent['project'])
        : null;
    final recentAt = recent is Map ? date(recent['at']) : null;
    final verifiedRecent =
        recentProject?.shownBranch != null &&
        recentAt != null &&
        (checkouts?.any((project) => project == recentProject) ?? false);
    return AgentGitContext(
      state: raw['state'] as String,
      current: const ['workspace', 'observed'].contains(raw['state'])
          ? AgentProject.fromJson(raw['current'])
          : null,
      checkouts: checkouts,
      recentWork: verifiedRecent ? recentProject : null,
      recentWorkAt: verifiedRecent ? recentAt : null,
      observedAt: date(raw['observedAt']),
      activityUncertain: raw['activityUncertain'] == true,
      locations: List.unmodifiable(locations),
      branches: List.unmodifiable(branches),
      pullRequests: List.unmodifiable(prs),
      truncated: raw['truncated'] == true || history['truncated'] == true,
      epoch: version is Map ? label(version['epoch'], 128) : null,
      revision:
          version is Map &&
              version['revision'] is int &&
              version['revision'] > 0
          ? version['revision'] as int
          : 0,
    );
  }

  static Uri? validatedPrUrl(Object? value) {
    if (value is! String ||
        !RegExp(r'^https://github\.com/[\w-]+/[\w.-]+/pull/[1-9]\d*$')
            .hasMatch(value)) {
      return null;
    }
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.toString() != value ||
        uri.pathSegments.any((part) => part == '.' || part == '..')) {
      return null;
    }
    return uri;
  }
}
