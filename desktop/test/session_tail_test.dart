import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/session_tail.dart';

Map<String, dynamic> page(
  List<int> turns, {
  bool hasMore = true,
  int total = 40,
}) => {
  'rows': [
    for (final turn in turns)
      {
        'turn': turn,
        'at': 1000 * turn,
        'ask': turn.isEven ? 'ask $turn' : '',
        'answer': 'answer $turn\nsecond line',
        'tools': 'Edit a.dart\n\nBash make $turn',
      },
  ],
  'hasMore': hasMore,
  'total': total,
};

void main() {
  const key = (machineId: 'm', sessionId: 's1');
  late DateTime now;
  late List<int?> asked;
  late Map<String, dynamic>? Function(int? beforeTurn) answer;

  SessionTails tails({int capacity = 20}) => SessionTails(
    (machineId, sessionId, {beforeTurn}) async {
      asked.add(beforeTurn);
      return answer(beforeTurn);
    },
    now: () => now,
    capacity: capacity,
  );

  setUp(() {
    now = DateTime(2026, 9, 27, 12);
    asked = [];
    answer = (before) => before == null
        ? page([37, 38, 39])
        : page([34, 35, 36], hasMore: false);
  });

  test('reads a reply: rows oldest first, tools one per line, times', () {
    final tail = SessionTail.fromReply(page([38, 39]), now)!;
    expect(tail.rows.map((row) => row.turn), [38, 39]);
    expect(tail.rows.first.ask, 'ask 38');
    expect(tail.rows.first.answer, 'answer 38\nsecond line');
    expect(tail.rows.first.tools, ['Edit a.dart', 'Bash make 38']);
    expect(tail.rows.first.at, DateTime.fromMillisecondsSinceEpoch(38000));
    expect(tail.hasMore, isTrue);
    expect(SessionTail.fromReply({'rows': 'nope'}, now), isNull);
    expect(
      SessionTail.fromReply({
        'rows': [
          {'turn': 'x'},
          {'turn': 1},
        ],
      }, now)!.rows.map((row) => row.turn),
      [1],
    );
  });

  test(
    'asks once per Cmd-P opening, and never refreshes while it stays open',
    () async {
      final store = tails();
      addTearDown(store.dispose);
      await Future.wait([store.want(key), store.want(key)]);
      expect(asked, [null]);
      expect(store.read(key)!.rows.map((row) => row.turn), [37, 38, 39]);

      now = now.add(const Duration(minutes: 5));
      await store.want(key);
      expect(asked, [null], reason: 'nothing refreshes while Cmd-P is open');
      store.opened();
      expect(store.read(key), isNotNull, reason: 'shown until the answer');
      await store.want(key);
      expect(asked, [null, null], reason: 'a new opening asks again');
    },
  );

  test(
    'pages up, and a refreshed last page keeps what was paged in above it',
    () async {
      final store = tails();
      addTearDown(store.dispose);
      await store.want(key);
      await store.older(key);
      expect(asked, [null, 37]);
      expect(store.read(key)!.rows.map((row) => row.turn), [
        34,
        35,
        36,
        37,
        38,
        39,
      ]);
      expect(store.read(key)!.hasMore, isFalse);
      await store.older(key);
      expect(asked, [
        null,
        37,
      ], reason: 'nothing above the start of the session');

      // The open turn grew into a continuation.
      answer = (_) => page([38, 39, 40]);
      store.opened();
      await store.want(key);
      expect(store.read(key)!.rows.map((row) => row.turn), [
        34,
        35,
        36,
        37,
        38,
        39,
        40,
      ]);
      expect(store.read(key)!.hasMore, isFalse);
    },
  );

  test('leaves a machine that cannot answer alone for a minute', () async {
    final store = tails();
    addTearDown(store.dispose);
    answer = (_) => null;
    await store.want(key);
    expect(store.unavailable(key), isTrue);
    store.opened();
    await store.want(key);
    expect(asked, [null], reason: 'not asked again for a minute');
    now = now.add(const Duration(minutes: 2));
    expect(store.unavailable(key), isFalse);
    store.opened();
    answer = (_) => page([39]);
    await store.want(key);
    expect(store.read(key)!.rows.single.turn, 39);
  });

  test(
    'keeps the last sessions it was asked for, and forgets them all on clear',
    () async {
      final store = tails(capacity: 2);
      addTearDown(store.dispose);
      for (final id in ['a', 'b', 'c']) {
        await store.want((machineId: 'm', sessionId: id));
      }
      expect(store.read((machineId: 'm', sessionId: 'a')), isNull);
      expect(store.read((machineId: 'm', sessionId: 'c')), isNotNull);
      store.clear();
      expect(store.read((machineId: 'm', sessionId: 'c')), isNull);
    },
  );

  test(
    'carries the latest ask, however far up a long turn has pushed it',
    () async {
      final reply = page([37, 38, 39])
        ..['lastAsk'] = {'turn': 30, 'at': 30000, 'ask': 'rebuild the dial'};
      final tail = SessionTail.fromReply(reply, now)!;
      expect(tail.lastAsk!.ask, 'rebuild the dial');
      expect(tail.lastAsk!.turn, 30);
      expect(tail.lastAsk!.at, DateTime.fromMillisecondsSinceEpoch(30000));
      expect(SessionTail.fromReply(page([39]), now)!.lastAsk, isNull);

      // Kept through paging up, replaced by the next last page.
      answer = (before) =>
          before == null ? reply : page([34, 35, 36], hasMore: false);
      final store = tails();
      addTearDown(store.dispose);
      await store.want(key);
      await store.older(key);
      expect(store.read(key)!.lastAsk!.ask, 'rebuild the dial');
      answer = (_) =>
          page([38, 39, 40])..['lastAsk'] = {'turn': 40, 'ask': 'now flash it'};
      store.opened();
      await store.want(key);
      expect(store.read(key)!.lastAsk!.ask, 'now flash it');
    },
  );
}
