/// The spread of a subsequence match, or null when the query does not match.
/// Both arguments should already be normalized for case. [from] is where in
/// [text] the match may begin.
///
/// Ported from the desktop's `core/fuzzy_match.dart` unchanged, so a query that
/// finds an agent there finds the same agent here. The two apps rank the same
/// rows off this one primitive; letting them drift would mean "mbp" reaching a
/// machine on the laptop and nothing on the phone.
int? subsequenceSpread(
  String text,
  String query, {
  int from = 0,
  void Function(int start, int end)? onMatch,
}) {
  if (query.isEmpty) return 0;
  var at = from - 1;
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

final _wordCharacter = RegExp(r'[\p{L}\p{N}]', unicode: true);

/// Whether [index] begins a word: the start of [text], or just after a
/// character that is neither a letter nor a digit, as in "fix-auth".
bool startsWord(String text, int index) {
  if (index <= 0) return true;
  final unit = text.codeUnitAt(index - 1);
  if (unit < 0x80) {
    return !(unit >= 0x30 && unit <= 0x39 ||
        unit >= 0x41 && unit <= 0x5a ||
        unit >= 0x61 && unit <= 0x7a);
  }
  // Separators every row carries ("·", "…", "—", no-break space) and emoji
  // halves, without a regex per character.
  if (unit == 0xa0 ||
      unit == 0xb7 ||
      unit >= 0x2000 && unit <= 0x206f ||
      unit >= 0xd800 && unit <= 0xdfff) {
    return true;
  }
  return !_wordCharacter.hasMatch(text[index - 1]);
}

/// The first occurrence of [term] at or after [start] that begins a word, or
/// -1: "port" is a word in "windows port" and only a fragment of "support".
int wordStartIndexOf(String text, String term, [int start = 0]) {
  if (term.isEmpty) return start.clamp(0, text.length);
  for (
    var at = text.indexOf(term, start);
    at >= 0;
    at = text.indexOf(term, at + 1)
  ) {
    if (startsWord(text, at)) return at;
  }
  return -1;
}

/// A scattered-letter match that starts on a word and stays close together:
/// "ath" finds "fix authentication" and "cmd" finds "command", but "auth" no
/// longer finds every folder under ".../autonomous-harness/...". Returns the
/// tightest such spread, or null; [onMatch] receives the letters it used.
int? wordSubsequenceSpread(
  String text,
  String query, {
  void Function(int start, int end)? onMatch,
}) {
  if (query.isEmpty) return 0;
  final letters = _lettersOf(query);
  // Two scattered letters match nearly everything ("hn" in every "harness"):
  // they count only as initials, each starting a word ("ns" for New Split).
  if (letters.length < 3) return _initials(text, letters, onMatch: onMatch);
  final first = letters.first;
  final limit = query.length * 2;
  int? bestStart, bestSpread;
  for (
    var at = text.indexOf(first);
    at >= 0;
    at = text.indexOf(first, at + first.length)
  ) {
    if (!startsWord(text, at)) continue;
    final spread = _spreadWithin(text, letters, at, limit);
    // A later start sees less of the text, so it cannot match either.
    if (spread == _absent) break;
    if (spread != null && (bestSpread == null || spread < bestSpread)) {
      bestStart = at;
      bestSpread = spread;
      if (spread == query.length - 1) break;
    }
  }
  if (bestStart != null && onMatch != null) {
    subsequenceSpread(text, query, from: bestStart, onMatch: onMatch);
  }
  return bestSpread;
}

/// No subsequence at all from here on.
const _absent = -1;

/// The spread of [query] as a subsequence of [text] starting at [start],
/// giving up as soon as it passes [limit] (null) rather than scanning on to the
/// end of a long field; [_absent] when a letter never occurs again.
int? _spreadWithin(String text, List<String> letters, int start, int limit) {
  var at = start;
  for (var index = 1; index < letters.length; index++) {
    final found = text.indexOf(letters[index], at + 1);
    if (found < 0) return _absent;
    if (found - start > limit) return null;
    at = found;
  }
  return at - start;
}

/// A query's letters, as strings: worked out once per query, not once per
/// field of every row it is matched against.
List<String> _lettersOf(String query) {
  if (identical(query, _lettersQuery) || query == _lettersQuery) {
    return _letters;
  }
  _lettersQuery = query;
  return _letters = [for (final rune in query.runes) String.fromCharCode(rune)];
}

String? _lettersQuery;
List<String> _letters = const [];

int? _initials(
  String text,
  List<String> letters, {
  void Function(int start, int end)? onMatch,
}) {
  var at = -1;
  var first = -1;
  final found = <(int, int)>[];
  for (final character in letters) {
    var next = text.indexOf(character, at + 1);
    while (next >= 0 && !startsWord(text, next)) {
      next = text.indexOf(character, next + 1);
    }
    if (next < 0) return null;
    if (first < 0) first = next;
    at = next;
    found.add((next, next + character.length));
  }
  if (onMatch != null) {
    for (final (start, end) in found) {
      onMatch(start, end);
    }
  }
  return at - first;
}
