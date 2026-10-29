/// The leaderboard's Agents and Models rows as the backend answers them
/// (`backend/src/superTabs/leaderboard/contract.ts` `AgentScore`,
/// `ModelScore`), for the leaderboard's tests.
library;

Map<String, dynamic> agentScoreData(
  String agentId, {
  required String displayName,
  required int points,
  required int rank,
  String kind = 'pm',
  String? personId,
  String machineId = 'machine-1',
  int? shipped,
}) => {
  'agentId': agentId,
  'displayName': displayName,
  'kind': kind,
  'personId': personId,
  'machineId': machineId,
  'points': points,
  'rank': rank,
  'shipped': shipped ?? points ~/ 3,
};

Map<String, dynamic> modelScoreData(
  String engine, {
  String? model,
  String? effort,
  bool grid = false,
  required int points,
  required int rank,
  int shipped = 0,
  int? medianAttemptMs,
  int? medianRequestMs,
  int reviewed = 0,
  int passed = 0,
  int reviews = 0,
}) => {
  'engine': engine,
  'model': model,
  'effort': effort,
  'grid': grid,
  'points': points,
  'rank': rank,
  'shipped': {
    'count': shipped,
    'medianAttemptMs': medianAttemptMs,
    'medianRequestMs': medianRequestMs,
  },
  'firstReview': {'reviewed': reviewed, 'passed': passed},
  'reviews': reviews,
};
