/// A Swarm project's goal, as its repository states it and its default branch's checks score it (Swarm plan, rule 1: "a goal
/// that can be checked").
///
/// The project lists its milestones in `agents/GOAL.md`, a table of what must be true and the command that checks it, and
/// its own CI runs each on the default branch as a check named `goal: <milestone>`. The daemon reads both and tells the PM
/// how many pass (cli/src/superTabs/goal.ts). Desktop shows the same number in the project's bar, so everything here reads
/// as that file does, step for step: the same rows, the same choice of commit and the same reading of a run. The rows'
/// cases are one fixture both are held to (cli/src/superTabs/__fixtures__/goal-rows.json).
library;

import 'dart:convert';
import 'dart:math';

/// Where a project states its goal, from its repository's root.
const goalFile = 'agents/GOAL.md';

/// How a milestone's check is named on GitHub, before the milestone as its row writes it.
const goalCheck = 'goal: ';

/// The most milestones read, and the most each may be long: the daemon's limits.
const _goalMax = 100, _milestoneMax = 100;

/// The longest line read as a row, in UTF-16 units as the daemon counts them: it bounds a check's command.
const _lineMax = 1000;

/// How many of the branch's last landings are looked at for one whose goal checks have all ended.
const _landings = 5;

/// A milestone and the command that checks it.
typedef SwarmGoalRow = ({String milestone, String check});

final _spaces = RegExp(r'\s+');
final _lineEnd = RegExp(r'\r?\n');
final _lineBreak = RegExp(r'[\r\u2028\u2029]');
final _sha = RegExp(r'^[0-9a-f]{40}$');

/// What a row or a tooltip must not draw: control characters, and the marks that turn a line's direction, which would show
/// a milestone as other words than its file's.
final _unshown = RegExp(
  r'[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]',
);

/// The control characters `gh` hands over in caret notation (U+0007 as `^G`), whatever GitHub answers, so that no answer
/// can drive a terminal (go-gh's asciisanitizer): C0 but tab, line feed, vertical tab and return, and C1.
final _ghRewrites = RegExp(r'[\u0000-\u0008\u000C\u000E-\u001F\u0080-\u009F]');

/// The same characters' escapes written out as text, a backslash, u and four hex digits in either case: `gh` reads its
/// answer's JSON text, so it takes `\u001b` written out for the escape and hands it over as `\^[` (review of the Desktop
/// score, 2026-11-11, on gh 2.83.2).
final _ghEscapes = RegExp(r'\\u00([0-9A-Fa-f]{2})');

String _caret(int unit) => '^${String.fromCharCode((unit & 0x1F) | 0x40)}';

/// [name] as `gh` hands a name over. The daemon asks GitHub itself and reads a check's name as it is; Desktop reads it
/// through `gh`, and a milestone's own name from its file, which gh leaves alone. So the two are compared written gh's
/// way: on a real repository the milestone `A bell <U+0007> in a name` passed for the daemon and was not run here
/// (2026-11-11). A name with `^G` written and one with U+0007 come to the same: gh leaves no way to tell them apart.
String _asGhWrites(String name) => name
    .replaceAllMapped(_ghEscapes, (found) {
      final unit = int.parse(found[1]!, radix: 16);
      return _ghRewrites.hasMatch(String.fromCharCode(unit))
          ? '\\${_caret(unit)}'
          : found[0]!;
    })
    .replaceAllMapped(_ghRewrites, (found) => _caret(found[0]!.codeUnitAt(0)));

/// Whether [unit] is space to JavaScript's `trim`, the daemon's: Dart's own `trim` also takes U+0085, which the daemon
/// leaves in a milestone's name.
bool _isSpace(int unit) =>
    (unit >= 0x09 && unit <= 0x0D) ||
    unit == 0x20 ||
    unit == 0xA0 ||
    unit == 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200A) ||
    unit == 0x2028 ||
    unit == 0x2029 ||
    unit == 0x202F ||
    unit == 0x205F ||
    unit == 0x3000 ||
    unit == 0xFEFF;

/// JavaScript's `trimEnd`.
String _trimEnd(String text) {
  var end = text.length;
  while (end > 0 && _isSpace(text.codeUnitAt(end - 1))) {
    end--;
  }
  return text.substring(0, end);
}

/// JavaScript's `trim`.
String _trim(String text) {
  final ended = _trimEnd(text);
  var start = 0;
  while (start < ended.length && _isSpace(ended.codeUnitAt(start))) {
    start++;
  }
  return ended.substring(start);
}

/// The rows of a goal file: each table row whose second cell is one command in backticks, in the file's order. A header, a
/// rule, a row with no command and any other line are none; a milestone named twice counts once, as its check has one name.
///
/// The daemon's reader (goal.ts `goalRows`), step for step and under its names, so the two cannot drift: a row is found
/// from its end by plain searches, in time by its line's length. As one pattern it took time by the cube of that: a
/// 1,000-character line of spaces took 2 s in the built app, on the isolate that draws it (review, 2026-11-11).
List<SwarmGoalRow> goalRows(String? text) {
  final rows = <String, SwarmGoalRow>{};
  for (final line in (text ?? '').split(_lineEnd)) {
    if (line.length > _lineMax) continue;
    // `| milestone | \`check\` |`: the check is between the row's last two backticks, with a bar after them and a bar
    // before. Each test stands before the cut it guards, where JavaScript cuts first and tests after: Dart's `substring`
    // throws where `slice` answers nothing.
    final row = _trim(line);
    if (!row.startsWith('|') || !row.endsWith('|')) continue;
    final cell = _trimEnd(row.substring(0, row.length - 1));
    final open = cell.lastIndexOf('`', max(0, cell.length - 2));
    if (!cell.endsWith('`') || open < 0) continue;
    final head = _trimEnd(cell.substring(0, open));
    if (!head.endsWith('|')) continue;
    final named = _trim(
      head.length < 2 ? '' : head.substring(1, head.length - 1),
    );
    // A milestone is one line's words: one with a line's end inside it is none.
    final milestone = named.contains(_lineBreak)
        ? ''
        : named.replaceAll(_spaces, ' ');
    final check = _trim(cell.substring(open + 1, cell.length - 1));
    if (milestone.isEmpty ||
        check.isEmpty ||
        milestone.length > _milestoneMax ||
        rows.containsKey(milestone)) {
      continue;
    }
    rows[milestone] = (milestone: milestone, check: check);
    if (rows.length >= _goalMax) break;
  }
  return rows.values.toList();
}

/// The text of a goal file as GitHub's contents API answers for it, or null when it holds none: the file is not there, or
/// is over 1 MB, which GitHub answers with no content. Null is no goal, as in the daemon (githubRest.ts `file`).
String? goalFileText(Object? contents) {
  if (contents is! Map ||
      contents['content'] is! String ||
      contents['encoding'] != 'base64') {
    return null;
  }
  try {
    // GitHub breaks the content into lines. Taken out as plain text, not by a pattern: near the 1 MB a file may hold, the
    // pattern alone took 50 ms of the screen's thread on every read (review, 2026-11-11).
    final bytes = base64.decode(
      (contents['content'] as String).replaceAll('\n', '').replaceAll('\r', ''),
    );
    final text = utf8.decode(bytes, allowMalformed: true);
    // Dart leaves a file's byte-order mark out of its text, and the daemon's reader keeps it, where it counts toward the
    // first line's length.
    final marked =
        bytes.length >= 3 &&
        bytes[0] == 0xEF &&
        bytes[1] == 0xBB &&
        bytes[2] == 0xBF;
    return marked ? '\uFEFF$text' : text;
  } on FormatException {
    return null;
  }
}

/// The last landings of a branch among its last commits as GitHub lists them ([commits], the newest first), by their ids,
/// the newest first: its tip, then each one's first parent, as far as five and no further than the commits listed. A
/// landing is a commit on the branch's first-parent line: a train that lands as a merge commit brings its members' commits
/// with it, which were never pushed to the branch and carry no check of it.
List<String> goalLandingsOf(Object? commits) {
  final listed = [
    for (final commit in commits is List ? commits : const <Object?>[])
      if (commit is Map)
        if (commit['sha'] case final String sha when _sha.hasMatch(sha))
          (sha: sha, parents: commit['parents']),
  ];
  final parent = {
    for (final commit in listed)
      commit.sha: switch (commit.parents) {
        [{'sha': final String sha}, ...] => sha,
        _ => '',
      },
  };
  final landings = <String>[];
  for (
    var sha = listed.firstOrNull?.sha ?? '';
    parent.containsKey(sha) && landings.length < _landings;
    sha = parent[sha]!
  ) {
    landings.add(sha);
  }
  return landings;
}

/// How a milestone stands on the commit its goal is scored on.
enum SwarmMilestoneState { passes, fails, notRun }

/// One milestone of a goal: its name as the file writes it, how it stands, and its check run's page on GitHub when one ran.
class SwarmMilestone {
  const SwarmMilestone({required this.name, required this.state, this.url});

  /// As its row writes it, which its check is named by.
  final String name;
  final SwarmMilestoneState state;
  final String? url;

  /// [name] as the screen shows it. The name is the repository's text: a control character draws as nothing, and a mark
  /// that turns the line's direction makes a row read as other words.
  String get shown => name.replaceAll(_unshown, '');
}

/// A project's goal as it stands on one commit of its default branch: every milestone of its file, in the file's order.
class SwarmGoal {
  const SwarmGoal({required this.milestones, required this.branch});

  /// Its branch as a tooltip may show it: a branch's name is the repository's text, and git takes a mark that turns a line's
  /// direction in one.
  String get shownBranch => branch.replaceAll(_unshown, '');

  /// [rows] scored by the check [runs] of one commit, as GitHub's REST API lists them: each milestone by the newest run of
  /// its name. A run that has not completed, or was skipped or neutral, says nothing of its milestone; one that concluded
  /// success passes it, and any other conclusion fails it. Cancelled fails too: GitHub ends a check that ran past its time
  /// limit as cancelled, and a hang must not read as a check still to run (goal.ts `scoreOf`).
  factory SwarmGoal.on(
    List<SwarmGoalRow> rows,
    List<Object?> runs, {
    required String branch,
  }) {
    final newest = <String, Map<Object?, Object?>>{};
    int id(Map<Object?, Object?>? run) => switch (run?['id']) {
      final int id => id,
      _ => 0,
    };
    for (final run in runs) {
      if (run is! Map) continue;
      final name = _asGhWrites(
        run['name'] is String ? run['name'] as String : '',
      );
      if (id(run) >= id(newest[name])) newest[name] = run;
    }
    return SwarmGoal(
      branch: branch,
      milestones: [
        for (final row in rows)
          if (newest[_asGhWrites('$goalCheck${row.milestone}')] case final run?)
            SwarmMilestone(
              name: row.milestone,
              state: switch ((run['status'], run['conclusion'])) {
                ('completed', 'success') => SwarmMilestoneState.passes,
                ('completed', 'skipped' || 'neutral') =>
                  SwarmMilestoneState.notRun,
                ('completed', _) => SwarmMilestoneState.fails,
                _ => SwarmMilestoneState.notRun,
              },
              url: _page(run['html_url']),
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

  /// A check run's page, when it is one a browser may be sent to: GitHub's answer is text from outside, and a row opens
  /// only a page of github.com over https.
  static String? _page(Object? url) {
    final page = url is String ? Uri.tryParse(url) : null;
    return page != null && page.scheme == 'https' && page.host == 'github.com'
        ? url as String
        : null;
  }
}
