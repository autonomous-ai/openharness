/// The spread of a subsequence match, or null when the query does not match.
/// Both arguments should already be normalized for case.
///
/// Ported from the desktop's `core/fuzzy_match.dart` unchanged, so a query that
/// finds an agent there finds the same agent here. The two apps rank the same
/// rows off this one primitive; letting them drift would mean "mbp" reaching a
/// machine on the laptop and nothing on the phone.
int? subsequenceSpread(
  String text,
  String query, {
  void Function(int start, int end)? onMatch,
}) {
  if (query.isEmpty) return 0;
  var at = -1;
  var first = -1;
  for (final rune in query.runes) {
    final character = String.fromCharCode(rune);
    final found = text.indexOf(character, at + 1);
    if (found < 0) return null;
    if (first < 0) first = found;
    at = found;
    onMatch?.call(found, found + character.length);
  }
  return at - first;
}
