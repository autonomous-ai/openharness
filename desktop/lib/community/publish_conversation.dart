import 'dart:math';

import 'hub_contract.dart';

/// The session tail as Hub turns: each ask and answer, split to the Hub's turn length, keeping the
/// newest turns when there are more than it takes. The end of a session is usually what made the result.
List<Map<String, String>> publicationTurns(Map<String, dynamic>? tail) {
  final turns = <Map<String, String>>[];
  for (final row in (tail?['rows'] as List? ?? const [])) {
    if (row is! Map) continue;
    for (final (key, role) in [('ask', 'user'), ('answer', 'assistant')]) {
      final text = row[key];
      if (text is! String || text.trim().isEmpty) continue;
      for (var start = 0; start < text.length; start += hubMaxTurnChars) {
        turns.add({
          'role': role,
          'text': text.substring(
            start,
            min(start + hubMaxTurnChars, text.length),
          ),
        });
      }
    }
  }
  return turns.length > hubMaxTurns
      ? turns.sublist(turns.length - hubMaxTurns)
      : turns;
}
