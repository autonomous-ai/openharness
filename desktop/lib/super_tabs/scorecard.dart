import 'package:flutter/foundation.dart';

import 'controller.dart';

/// One project's scorecard for one local day, as the server computed it
/// overnight from the Swarm's own records (backend superTabs/scorecard,
/// task #3386).
class SuperTabScorecardDay {
  SuperTabScorecardDay.fromJson(Map<String, dynamic> row)
    : projectId = row['projectId'] as String? ?? '',
      on = row['on'] as String? ?? '',
      figures = Map.unmodifiable(
        (row['figures'] as Map?)?.cast<String, dynamic>() ?? const {},
      );

  final String projectId;

  /// The local date, YYYY-MM-DD.
  final String on;
  final Map<String, dynamic> figures;

  int? number(String key) => (figures[key] as num?)?.round();

  /// A figure with parts, such as crewWake's median and slowest (task #3462).
  Map<String, dynamic> parts(String key) =>
      (figures[key] as Map?)?.cast<String, dynamic>() ?? const {};
}

/// "–" for no figure, "45m" under an hour, "3h10" or "10h" above.
String scorecardDuration(int? minutes) {
  if (minutes == null) return '–';
  if (minutes < 60) return '${minutes}m';
  final hours = minutes ~/ 60, rest = minutes % 60;
  return rest == 0
      ? '${hours}h'
      : '${hours}h${rest.toString().padLeft(2, '0')}';
}

/// "–" for no figure, "12s" under a minute, "3m30" or "5m" above.
String scorecardSeconds(int? seconds) {
  if (seconds == null) return '–';
  if (seconds < 60) return '${seconds}s';
  final minutes = seconds ~/ 60, rest = seconds % 60;
  return rest == 0
      ? '${minutes}m'
      : '${minutes}m${rest.toString().padLeft(2, '0')}';
}

/// A crew time's median · slowest of the day, or "–" with none (task #3462).
String _crewTime(SuperTabScorecardDay day, String key) {
  final figure = day.parts(key);
  final median = (figure['medianSeconds'] as num?)?.round();
  final slowest = (figure['slowestSeconds'] as num?)?.round();
  if (median == null || slowest == null) return '–';
  return '${scorecardSeconds(median)} · ${scorecardSeconds(slowest)}';
}

/// One row of the table: its label, the figure it reads and how it says it.
class SuperTabScorecardRow {
  const SuperTabScorecardRow(this.key, this.label, this._say);

  /// The figure's name in the stored row, which also keys the row's widget.
  final String key;
  final String label;
  final String Function(SuperTabScorecardDay day) _say;

  /// The cell for [day]; a day with no row says "–", never 0.
  String cell(SuperTabScorecardDay? day) => day == null ? '–' : _say(day);
}

String _count(SuperTabScorecardDay day, String key) =>
    day.number(key)?.toString() ?? '–';

/// The table's rows, in the mockup's order (task #3386).
final scorecardRows = <SuperTabScorecardRow>[
  SuperTabScorecardRow(
    'asksShipped',
    'Asks shipped',
    (d) => _count(d, 'asksShipped'),
  ),
  SuperTabScorecardRow(
    'askToShipMedianMinutes',
    'Ask to ship (median)',
    (d) => scorecardDuration(d.number('askToShipMedianMinutes')),
  ),
  SuperTabScorecardRow(
    'oldestUnansweredAskMinutes',
    'Oldest unanswered ask',
    (d) => scorecardDuration(d.number('oldestUnansweredAskMinutes')),
  ),
  SuperTabScorecardRow(
    'idleMinutes',
    'Nobody working, work waiting',
    (d) => scorecardDuration(d.number('idleMinutes')),
  ),
  SuperTabScorecardRow(
    'lostLeftAlone',
    'Lost tasks left >10 min',
    (d) => _count(d, 'lostLeftAlone'),
  ),
  SuperTabScorecardRow(
    'fixesAfterMerge',
    'Fixes after merge',
    (d) => _count(d, 'fixesAfterMerge'),
  ),
  SuperTabScorecardRow(
    'corrections',
    'Corrections of the PM',
    (d) => _count(d, 'corrections'),
  ),
  SuperTabScorecardRow(
    'starts',
    'Agent starts (failed)',
    (d) => '${_count(d, 'starts')} (${_count(d, 'startsFailed')})',
  ),
  SuperTabScorecardRow(
    'routeDecisions',
    'Route decisions',
    (d) => _count(d, 'routeDecisions'),
  ),
  SuperTabScorecardRow(
    'typedIntoPm',
    'Typed into the PM',
    (d) => _count(d, 'typedIntoPm'),
  ),
  SuperTabScorecardRow(
    'ackPosts',
    'Ack-only posts',
    (d) => _count(d, 'ackPosts'),
  ),
  SuperTabScorecardRow(
    'crewWake',
    'Crew wake time',
    (d) => _crewTime(d, 'crewWake'),
  ),
  SuperTabScorecardRow(
    'crewMove',
    'Crew move time',
    (d) => _crewTime(d, 'crewMove'),
  ),
];

/// The table's columns: [newest] and the 6 days before it, newest first.
List<String> scorecardColumns(String newest) {
  final day = DateTime.parse('${newest}T00:00:00Z');
  return [
    for (var i = 0; i < 7; i++)
      day.subtract(Duration(days: i)).toIso8601String().substring(0, 10),
  ];
}

/// Reads one project's stored days when shown or when the project changes:
/// they change once a night, so nothing polls.
class SuperTabScorecardReader extends ChangeNotifier {
  SuperTabScorecardReader({required this.tabId, required this.request});

  final String tabId;
  final SuperTabRequest request;

  List<SuperTabScorecardDay> days = const [];

  /// The last day the project should have a row for (yesterday in its zone),
  /// as the server says it; the table ends there even when that row is
  /// missing.
  String? through;
  String? error;
  bool loading = false;
  String? _projectId;
  int _read = 0;
  bool _disposed = false;

  String? get projectId => _projectId;

  Future<void> show(String projectId) {
    if (projectId != _projectId) {
      _projectId = projectId;
      days = const [];
      through = null;
      error = null;
    }
    return refresh();
  }

  Future<void> refresh() async {
    final projectId = _projectId;
    if (projectId == null || _disposed) return;
    final read = ++_read;
    loading = true;
    _notify();
    try {
      final answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/scorecard'
            '?projectId=${Uri.encodeQueryComponent(projectId)}',
      );
      if (read != _read) return;
      days = [
        for (final row in answer['days'] as List? ?? const [])
          SuperTabScorecardDay.fromJson((row as Map).cast<String, dynamic>()),
      ];
      through = answer['through'] as String?;
      error = null;
    } on SuperTabFailure catch (failure) {
      if (read != _read) return;
      days = const [];
      error = failure.statusCode == 404
          ? 'The scorecard needs a newer Harness server.'
          : failure.message;
    } catch (_) {
      if (read != _read) return;
      error = "Couldn't read the scorecard.";
    }
    loading = false;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
