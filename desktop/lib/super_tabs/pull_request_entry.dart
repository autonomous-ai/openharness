/// GitHub facts and their presentation order in the Swarm PR pane.
enum PullRequestKind {
  failed,
  conflicts,
  changes,
  behind,
  ready,
  autoMerge,
  review,
  running,
  draft,
  open,
  merged,
  closed,
  unknown,
  checking,
}

class SuperTabPullRequestEntry {
  const SuperTabPullRequestEntry({
    required this.url,
    this.title = '',
    this.state = '',
    this.status = 'found',
    this.updatedAt,
    this.mergedAt,
    this.closedAt,
    this.additions = 0,
    this.deletions = 0,
    this.passed = 0,
    this.failed = 0,
    this.pending = 0,
    this.total = 0,
    this.mergeState = '',
    this.review = '',
    this.autoMerge = false,
  });
  final Uri url;
  final String title, state, status, mergeState, review;
  final DateTime? updatedAt, mergedAt, closedAt;
  final int additions, deletions, passed, failed, pending, total;
  final bool autoMerge;
  bool get finalState => state == 'Merged' || state == 'Closed';
  int get number => int.parse(url.pathSegments.last);
  String get repository => url.pathSegments.take(2).join('/');
  DateTime? get time => state == 'Merged'
      ? mergedAt
      : state == 'Closed'
      ? closedAt
      : updatedAt;

  PullRequestKind get kind {
    if (status == 'checking') return PullRequestKind.checking;
    if (status != 'found') return PullRequestKind.unknown;
    if (state == 'Merged') return PullRequestKind.merged;
    if (state == 'Closed') return PullRequestKind.closed;
    if (failed > 0) return PullRequestKind.failed;
    if (mergeState == 'DIRTY') return PullRequestKind.conflicts;
    if (review == 'CHANGES_REQUESTED') return PullRequestKind.changes;
    if (mergeState == 'BEHIND') return PullRequestKind.behind;
    if (state == 'Draft') return PullRequestKind.draft;
    if (total > 0 &&
        pending == 0 &&
        mergeState == 'CLEAN' &&
        review != 'REVIEW_REQUIRED') {
      return PullRequestKind.ready;
    }
    if (autoMerge) return PullRequestKind.autoMerge;
    if (review == 'REVIEW_REQUIRED') return PullRequestKind.review;
    if (pending > 0) return PullRequestKind.running;
    // No checks or an unresolved GitHub merge state is not evidence of readiness.
    return PullRequestKind.open;
  }

  String get label => switch (kind) {
    PullRequestKind.failed => '$failed of $total checks failed',
    PullRequestKind.conflicts => 'Conflicts with main',
    PullRequestKind.changes => 'Changes requested',
    PullRequestKind.behind => 'Behind main',
    PullRequestKind.ready => 'Ready to merge',
    PullRequestKind.autoMerge => 'Merges when checks pass',
    PullRequestKind.review => 'Waiting for review',
    PullRequestKind.running =>
      'Checks running · ${passed + failed} of $total done',
    PullRequestKind.draft => 'Draft',
    PullRequestKind.open => 'Open',
    PullRequestKind.merged => '',
    PullRequestKind.closed => 'Not merged',
    PullRequestKind.unknown =>
      status == 'no_access'
          ? "Can't read status: this computer's GitHub account has no access"
          : 'Status unknown',
    PullRequestKind.checking => 'Checking GitHub…',
  };
  String get checksLabel => total == 0
      ? 'No checks yet'
      : pending > 0
      ? '${passed + failed} of $total checks done'
      : failed > 0
      ? '$failed of $total checks failed'
      : '$passed ${passed == 1 ? 'check' : 'checks'} passed';

  static SuperTabPullRequestEntry? fromJson(Map<String, dynamic> json) {
    final url = Uri.tryParse(json['url'] is String ? json['url'] : '');
    if (url == null ||
        !RegExp(r'^https://github\.com/[\w-]+/[\w.-]+/pull/[1-9]\d*$')
            .hasMatch(url.toString())) {
      return null;
    }
    final checks = json['checks'] is Map ? json['checks'] as Map : const {};
    int count(dynamic n) => n is int && n >= 0 ? n : 0;
    DateTime? date(dynamic s) => s is String ? DateTime.tryParse(s) : null;
    final state = json['state'];
    final found =
        json['status'] == 'found' &&
        const ['Open', 'Draft', 'Merged', 'Closed'].contains(state) &&
        json['title'] is String;
    return SuperTabPullRequestEntry(
      url: url,
      status: found
          ? 'found'
          : json['status'] == 'no_access'
          ? 'no_access'
          : 'unavailable',
      title: found ? json['title'] : '',
      state: found ? state : '',
      updatedAt: date(json['updatedAt']),
      mergedAt: date(json['mergedAt']),
      closedAt: date(json['closedAt']),
      additions: count(json['additions']),
      deletions: count(json['deletions']),
      passed: count(checks['passed']),
      failed: count(checks['failed']),
      pending: count(checks['pending']),
      total: count(checks['total']),
      mergeState: json['mergeStateStatus'] is String
          ? json['mergeStateStatus']
          : '',
      review: json['reviewDecision'] is String ? json['reviewDecision'] : '',
      autoMerge: json['autoMerge'] == true,
    );
  }
}

String pullRequestAge(DateTime? time, DateTime now) {
  if (time == null) return '';
  final minutes = now.difference(time).inMinutes.clamp(0, 99999999);
  return minutes < 1
      ? 'just now'
      : minutes < 60
      ? '$minutes min ago'
      : minutes < 1440
      ? '${(minutes / 60).round()} h ago'
      : '${(minutes / 1440).round()} d ago';
}
