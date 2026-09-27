/// When a search is about, read from its words: "dial last week", "yesterday",
/// "3 days ago", "on monday". People remember a session by roughly when as
/// often as by what; the phrase narrows the search to sessions worked on then
/// and is taken out of the words matched against names and conversations.
///
/// Parsed here rather than by each machine so every machine searches the same
/// window, in this computer's time zone.
typedef SearchWhen = ({DateTime from, DateTime to, String phrase});

const _numbers = {
  'a': 1,
  'an': 1,
  'one': 1,
  'two': 2,
  'three': 3,
  'four': 4,
  'five': 5,
  'six': 6,
  'seven': 7,
  'eight': 8,
  'nine': 9,
  'ten': 10,
};

const _weekdays = {
  'monday': DateTime.monday,
  'tuesday': DateTime.tuesday,
  'wednesday': DateTime.wednesday,
  'thursday': DateTime.thursday,
  'friday': DateTime.friday,
  'saturday': DateTime.saturday,
  'sunday': DateTime.sunday,
};

final _phrases = RegExp(
  r'(?<![\p{L}\p{N}])(?:'
  r'(?<today>today)'
  r'|(?<yesterday>yesterday)'
  r'|(?<thisweek>this week)'
  r'|(?<lastweek>last week)'
  r'|(?<thismonth>this month)'
  r'|(?<lastmonth>last month)'
  r'|(?<few>(?:a )?few days ago|(?:a )?couple(?: of)? days ago)'
  r'|(?<count>\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (?<unit>days?|weeks?) ago'
  // A weekday only with "on" or "last": "friday deploy" is a harness's name,
  // "on friday" is a time.
  r'|(?<last>last|on) (?<weekday>monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
  r')(?![\p{L}\p{N}])',
  caseSensitive: false,
  unicode: true,
);

/// The words with any time phrase taken out, and the window it names.
({String words, SearchWhen? when}) parseSearchWhen(String query, DateTime now) {
  final match = _phrases.firstMatch(query);
  if (match == null) return (words: query, when: null);
  final midnight = DateTime(now.year, now.month, now.day);
  DateTime day(int offset) =>
      DateTime(midnight.year, midnight.month, midnight.day + offset);
  late DateTime from, to;
  if (match.namedGroup('today') != null) {
    (from, to) = (midnight, now);
  } else if (match.namedGroup('yesterday') != null) {
    (from, to) = (day(-1), midnight);
  } else if (match.namedGroup('thisweek') != null) {
    (from, to) = (day(1 - now.weekday), now);
  } else if (match.namedGroup('lastweek') != null) {
    (from, to) = (day(1 - now.weekday - 7), day(1 - now.weekday));
  } else if (match.namedGroup('thismonth') != null) {
    (from, to) = (DateTime(now.year, now.month), now);
  } else if (match.namedGroup('lastmonth') != null) {
    (from, to) = (
      DateTime(now.year, now.month - 1),
      DateTime(now.year, now.month),
    );
  } else if (match.namedGroup('few') != null) {
    // Two to five days back, loosely.
    (from, to) = (day(-6), day(-1));
  } else if (match.namedGroup('count') case final count?) {
    final n = int.tryParse(count) ?? _numbers[count.toLowerCase()] ?? 1;
    final weeks = match.namedGroup('unit')!.toLowerCase().startsWith('week');
    // Memory is loose: a day either side, or half a week either side.
    final back = weeks ? n * 7 : n;
    final slack = weeks ? 4 : 1;
    (from, to) = (day(-back - slack), day(-back + slack + 1));
  } else {
    final weekday = _weekdays[match.namedGroup('weekday')!.toLowerCase()]!;
    final strictlyBefore = match.namedGroup('last')!.toLowerCase() == 'last';
    var back = (now.weekday - weekday) % 7;
    if (back == 0 && strictlyBefore) back = 7;
    (from, to) = (day(-back), day(-back + 1));
  }
  if (to.isAfter(now)) to = now;
  final words = query
      .replaceRange(match.start, match.end, ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return (words: words, when: (from: from, to: to, phrase: match[0]!));
}
