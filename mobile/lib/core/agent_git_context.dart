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
  String? title,
  String? headBranch,
  String? baseBranch,
});

/// Display evidence from the owning machine. It never changes launch/resume cwd.
class AgentGitContext {
  const AgentGitContext({
    required this.state,
    this.current,
    this.observedAt,
    this.locations = const [],
    this.branches = const [],
    this.pullRequests = const [],
    this.truncated = false,
    this.epoch,
    this.revision = 0,
  });
  final String state;
  final AgentProject? current;
  final DateTime? observedAt;
  final List<AgentWorkLocation> locations;
  final List<AgentWorkBranch> branches;
  final List<AgentWorkPr> pullRequests;
  final bool truncated;
  final String? epoch;
  final int revision;

  String? get branchLabel => switch (state) {
    'multiple' => 'Multiple workspaces',
    'uncertain' => 'Work location unknown',
    'unavailable' => 'Workspace unavailable',
    _ =>
      current?.shownBranch ?? (current?.detached == true ? 'Detached' : null),
  };

  String get explanation => switch (state) {
    'observed' => 'Most recently observed work',
    'multiple' => 'The operation used more than one workspace.',
    'uncertain' => 'The current work location could not be confirmed.',
    'unavailable' => 'The observed workspace is no longer readable.',
    _ => 'Harness workspace; no other work location has been observed.',
  };

  AgentProject? displayProject(AgentProject? launch) {
    if (current != null) return current;
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
    final project = current;
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
      observedAt == other.observedAt &&
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
    observedAt,
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
        title: result is Map ? label(result['title'], 512) : null,
        headBranch: result is Map ? label(result['headBranch'], 256) : null,
        baseBranch: result is Map ? label(result['baseBranch'], 256) : null,
      ));
      if (prs.length == 128) break;
    }
    final version = raw['version'];
    return AgentGitContext(
      state: raw['state'] as String,
      current: const ['workspace', 'observed'].contains(raw['state'])
          ? AgentProject.fromJson(raw['current'])
          : null,
      observedAt: date(raw['observedAt']),
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
