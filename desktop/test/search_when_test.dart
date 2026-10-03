import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/search_when.dart';

void main() {
  // Saturday 26 September 2026, 14:30 local.
  final now = DateTime(2026, 9, 26, 14, 30);
  DateTime day(int d) => DateTime(2026, 9, d);

  ({String words, DateTime? from, DateTime? to}) read(String query) {
    final parsed = parseSearchWhen(query, now);
    return (words: parsed.words, from: parsed.when?.from, to: parsed.when?.to);
  }

  test(
    'reads the common ways of saying when, and takes them out of the words',
    () {
      expect(read('dial today'), (words: 'dial', from: day(26), to: now));
      expect(read('yesterday dial'), (
        words: 'dial',
        from: day(25),
        to: day(26),
      ));
      expect(read('dial this week'), (words: 'dial', from: day(21), to: now));
      expect(read('dial LAST WEEK scroll'), (
        words: 'dial scroll',
        from: day(14),
        to: day(21),
      ));
      expect(read('cohorts last month'), (
        words: 'cohorts',
        from: DateTime(2026, 8),
        to: DateTime(2026, 9),
      ));
    },
  );

  test('keeps "ago" loose, the way memory is', () {
    expect(read('dial 3 days ago'), (
      words: 'dial',
      from: day(22),
      to: day(25),
    ));
    expect(read('a few days ago mobile'), (
      words: 'mobile',
      from: day(20),
      to: day(25),
    ));
    expect(read('two weeks ago'), (words: '', from: day(8), to: day(17)));
    expect(read('a week ago dial'), (
      words: 'dial',
      from: day(15),
      to: day(24),
    ));
  });

  test('a weekday is its most recent one; "last" skips today', () {
    // 26 September 2026 is a Saturday.
    expect(read('dial on monday'), (words: 'dial', from: day(21), to: day(22)));
    expect(read('on friday'), (words: '', from: day(25), to: day(26)));
    expect(read('dial on saturday'), (words: 'dial', from: day(26), to: now));
    expect(read('dial last saturday'), (
      words: 'dial',
      from: day(19),
      to: day(20),
    ));
  });

  test('"0 days ago" is today, as the CLI reads it', () {
    expect(read('dial 0 days ago'), (words: 'dial', from: day(25), to: now));
  });

  test('leaves words alone that only look like time', () {
    for (final query in [
      'dial',
      'todays menu',
      'sundays',
      'weekday parser',
      'lastweek',
      'sun mon',
      'days ago',
      'friday deploy',
    ]) {
      expect(parseSearchWhen(query, now).when, isNull, reason: query);
      expect(parseSearchWhen(query, now).words, query);
    }
  });
}
