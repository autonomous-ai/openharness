/// A Swarm project's goal, as its repository states it and its default branch's checks score it (Swarm plan, rule 1: "a goal
/// that can be checked").
///
/// The project lists its milestones in `agents/GOAL.md`, a table of what must be true and the command that checks it, and
/// its own CI runs each on the default branch as a check named `goal: <milestone>`. The daemon reads both and tells the PM
/// how many pass (cli/src/superTabs/goal.ts). Desktop shows the same number in the project's bar, so everything here reads
/// as that file does: the same rows, the same choice of commit and the same reading of a run. The rows' cases are one
/// fixture both are held to (cli/src/superTabs/__fixtures__/goal-rows.json).
library;

/// Where a project states its goal, from its repository's root.
const goalFile = 'agents/GOAL.md';

/// How a milestone's check is named on GitHub, before the milestone as its row writes it.
const goalCheck = 'goal: ';

/// The most milestones read, and the most each may be long: the daemon's limits.
const goalMax = 100, goalMilestoneMax = 100;

/// The longest line read as a row. The row's pattern takes time by the square of a line's length, and the file is the
/// repository's text.
const goalLineMax = 1000;

/// How many of the branch's last landings are looked at for one whose goal checks have all ended, among how many of its
/// last commits.
const goalLandings = 5, goalCommits = 100;

/// A milestone and the command that checks it.
typedef SwarmGoalRow = ({String milestone, String check});

final _row = RegExp(r'^\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|\s*$');
final _space = RegExp(r'\s');
final _spaces = RegExp(r'\s+');
final _lineEnd = RegExp(r'\r?\n');

/// [text] without the spaces at its ends, as JavaScript's `trim` takes them: Dart's own also takes U+0085, which the daemon
/// leaves in place.
String _trimmed(String text) {
  var start = 0, end = text.length;
  while (start < end && _space.hasMatch(text[start])) {
    start++;
  }
  while (end > start && _space.hasMatch(text[end - 1])) {
    end--;
  }
  return text.substring(start, end);
}

/// The rows of a goal file: each table row whose second cell is one command in backticks, in the file's order. A header, a
/// rule, a row with no command and any other line are none; a milestone named twice counts once, as its check has one name.
List<SwarmGoalRow> goalRows(String? text) {
  final rows = <String, SwarmGoalRow>{};
  for (final line in (text ?? '').split(_lineEnd)) {
    if (line.length > goalLineMax) continue;
    final found = _row.firstMatch(_trimmed(line));
    if (found == null) continue;
    final milestone = found.group(1)!.replaceAll(_spaces, ' ');
    final check = _trimmed(found.group(2)!);
    if (check.isEmpty ||
        milestone.length > goalMilestoneMax ||
        rows.containsKey(milestone)) {
      continue;
    }
    rows[milestone] = (milestone: milestone, check: check);
    if (rows.length >= goalMax) break;
  }
  return rows.values.toList();
}

/// How a milestone stands on the commit its goal is scored on.
enum SwarmMilestoneState { passes, fails, notRun }

/// One milestone of a goal: its name as the file writes it, how it stands, and its check run's page on GitHub when one ran.
class SwarmMilestone {
  const SwarmMilestone({required this.name, required this.state, this.url});
  final String name;
  final SwarmMilestoneState state;
  final String? url;
}

/// A project's goal as it stands on one commit of its default branch: every milestone of its file, in the file's order.
class SwarmGoal {
  const SwarmGoal({required this.milestones, required this.branch});

  /// [rows] scored by the check [runs] of one commit, as GitHub's GraphQL describes a check run: each milestone by the
  /// newest run of its name. A run that has not completed, or was skipped or neutral, says nothing of its milestone; one
  /// that concluded success passes it, and any other conclusion fails it. Cancelled fails too: GitHub ends a check that
  /// ran past its time limit as cancelled, and a hang must not read as a check still to run.
  factory SwarmGoal.on(
    List<SwarmGoalRow> rows,
    List<Object?> runs, {
    required String branch,
  }) {
    final newest = <String, Map<Object?, Object?>>{};
    int id(Map<Object?, Object?>? run) => switch (run?['databaseId']) {
      final int id => id,
      _ => 0,
    };
    for (final run in runs) {
      if (run is! Map) continue;
      final name = run['name'] is String ? run['name'] as String : '';
      if (id(run) >= id(newest[name])) newest[name] = run;
    }
    return SwarmGoal(
      branch: branch,
      milestones: [
        for (final row in rows)
          if (newest['$goalCheck${row.milestone}'] case final run?)
            SwarmMilestone(
              name: row.milestone,
              state: switch ((run['status'], run['conclusion'])) {
                ('COMPLETED', 'SUCCESS') => SwarmMilestoneState.passes,
                ('COMPLETED', 'SKIPPED' || 'NEUTRAL') =>
                  SwarmMilestoneState.notRun,
                ('COMPLETED', _) => SwarmMilestoneState.fails,
                _ => SwarmMilestoneState.notRun,
              },
              url: _page(run['url']),
            )
          else
            SwarmMilestone(
              name: row.milestone,
              state: SwarmMilestoneState.notRun,
            ),
      ],
    );
  }

  final List<SwarmMilestone> milestones;

  /// The default branch it was scored on, by name.
  final String branch;

  int get total => milestones.length;
  int get passed => _count(SwarmMilestoneState.passes);
  int get failed => _count(SwarmMilestoneState.fails);
  int get notRun => _count(SwarmMilestoneState.notRun);

  int _count(SwarmMilestoneState state) =>
      milestones.where((m) => m.state == state).length;

  /// The milestones that do not pass yet: those that fail, then those not run, each in the file's order.
  List<SwarmMilestone> get notPassing => [
    for (final state in const [
      SwarmMilestoneState.fails,
      SwarmMilestoneState.notRun,
    ])
      for (final milestone in milestones)
        if (milestone.state == state) milestone,
  ];

  /// A check run's page, when it is one a browser may be sent to: GitHub's answer is text from outside.
  static String? _page(Object? url) =>
      url is String && Uri.tryParse(url)?.scheme == 'https' ? url : null;
}

/// The last landings of a default branch as one read of it describes them ([branchRef], GraphQL's `defaultBranchRef`), the
/// newest first: its tip, then each one's first parent, as far as [goalLandings] and no further than the branch's last
/// [goalCommits] commits, which the daemon lists to follow the same line. A landing is a commit on the branch's
/// first-parent line: a train that lands as a merge commit brings its members' commits with it, which carry no check of
/// the branch.
List<Map<Object?, Object?>> goalLandingsOf(Object? branchRef) {
  final tip = branchRef is Map ? branchRef['target'] : null;
  if (tip is! Map) return const [];
  final listed = {
    for (final commit in _nodes(tip['history']))
      if (commit is Map && commit['oid'] is String) commit['oid'] as String,
  };
  final landings = <Map<Object?, Object?>>[];
  Object? commit = tip;
  while (commit is Map &&
      listed.contains(commit['oid']) &&
      landings.length < goalLandings) {
    landings.add(commit);
    commit = _nodes(commit['parents']).firstOrNull;
  }
  return landings;
}

List<Object?> _nodes(Object? connection) =>
    connection is Map && connection['nodes'] is List
    ? connection['nodes'] as List
    : const [];
