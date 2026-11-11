/// How the leaderboard writes its numbers.
library;

String plural(int count, String one, [String? many]) =>
    '$count ${count == 1 ? one : many ?? '${one}s'}';
