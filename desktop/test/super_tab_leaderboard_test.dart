import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/leaderboard/model.dart';
import 'package:harness/super_tabs/leaderboard/person_row.dart';
import 'package:harness/super_tabs/leaderboard/reader.dart';

// Monday 2026-10-26 00:00 UTC.
final week = DateTime.utc(2026, 10, 26).millisecondsSinceEpoch;
const hour = 3600000;

Map<String, dynamic> score(
  String id, {
  required int points,
  required int rank,
  String? medal,
  int shipped = 0,
  int unblocked = 0,
  int machines = 0,
  int lentMs = 0,
  int streak = 0,
}) => {
  'personId': id,
  'points': points,
  'rank': rank,
  'medal': medal,
  'shipped': {
    'count': shipped,
    'medianAskToShipMs': shipped > 0 ? 3.1 * hour : null,
  },
  'unblocked': {
    'count': unblocked,
    'agentMs': unblocked * 2 * hour,
    'medianAnswerMs': unblocked > 0 ? 6 * 60000 : null,
  },
  'lent': {'machines': machines, 'agentMs': lentMs},
  'streakDays': streak,
};

/// The read's answer for the layout mockup (numbers made up).
Map<String, dynamic> answer({Map<String, dynamic>? waiting}) => {
  'projectId': 'lead',
  'week': week,
  'goal': {
    'openRequests': 7,
    'thisWeek': {'shipped': 19, 'points': 108, 'medianAskToShipMs': 3 * hour},
    'lastWeek': {'shipped': 12, 'points': 80, 'medianAskToShipMs': 5 * hour},
  },
  'people': [
    score(
      'ken',
      points: 42,
      rank: 1,
      medal: 'gold',
      shipped: 9,
      unblocked: 14,
      machines: 2,
      lentMs: 31 * hour,
      streak: 5,
    ),
    score(
      'dee',
      points: 28,
      rank: 2,
      medal: 'silver',
      shipped: 6,
      unblocked: 5,
    ),
    score(
      'scholes',
      points: 19,
      rank: 3,
      medal: 'bronze',
      shipped: 2,
      unblocked: 3,
      machines: 1,
    ),
    score('tony', points: 0, rank: 4),
  ],
  'waiting':
      waiting ??
      {
        'total': 3,
        'people': [
          {
            'personId': 'ken',
            'count': 2,
            'conversationIds': ['g1', 'g2'],
          },
          {
            'personId': 'tony',
            'count': 1,
            'conversationIds': ['g3'],
          },
        ],
      },
};

class FakeRequests {
  final paths = <String>[];
  Object? Function(String path) respond = (_) => answer();
  Future<Map<String, dynamic>> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    paths.add('$method $path');
    final result = respond(path);
    if (result is Exception) throw result;
    return result as Map<String, dynamic>;
  }
}

void main() {
  group('the leaderboard read', () {
    test('parses every number the column shows', () {
      final board = SuperTabLeaderboard.fromJson(answer());
      expect(board.week, week);
      final ken = board.people.first;
      expect(
        [ken.personId, ken.points, ken.rank, ken.medal],
        ['ken', 42, 1, SuperTabMedal.gold],
      );
      expect(
        [
          ken.shipped,
          ken.unblocked,
          ken.lentMachines,
          ken.lentMs,
          ken.streakDays,
        ],
        [9, 14, 2, 31 * hour, 5],
      );
      expect(ken.medianAskToShipMs, (3.1 * hour).round());
      expect(board.people.last.medal, isNull);
      expect(board.waiting.total, 3);
      expect(board.waiting.people.map((w) => (w.personId, w.count)), [
        ('ken', 2),
        ('tony', 1),
      ]);
    });

    test(
      'parses the display name, last week and what each number is made of',
      () {
        final board = SuperTabLeaderboard.fromJson({
          ...answer(),
          'people': [
            {
              ...score('ken', points: 42, rank: 1, shipped: 1),
              'displayName': 'Ken Tran',
              'prevWeekPoints': 30,
              'details': {
                'shipped': [
                  {
                    'title': 'Desktop: a machine shows one count',
                    'prUrl': 'https://github.com/o/r/pull/1824',
                    'mergedAt': '2026-10-27T10:00:00.000Z',
                  },
                ],
                'unblocked': [
                  {
                    'title': 'Which sign-in page?',
                    'conversationId': 'g1',
                    'kind': 'decision',
                    'waitedMinutes': 95,
                  },
                ],
                'lent': [
                  {'machineName': 'MACs-Mac-Studio.local', 'busyHours': 12.5},
                ],
              },
            },
          ],
        });
        final ken = board.people.single;
        expect(ken.displayName, 'Ken Tran');
        expect(ken.prevWeekPoints, 30);
        final details = ken.details!;
        expect(details.shipped.map((s) => (s.title, s.prUrl)), [
          (
            'Desktop: a machine shows one count',
            'https://github.com/o/r/pull/1824',
          ),
        ]);
        expect(
          details.unblocked.map(
            (u) => (u.title, u.conversationId, u.kind, u.waitedMinutes),
          ),
          [('Which sign-in page?', 'g1', 'decision', 95)],
        );
        expect(details.lent.map((l) => (l.machineName, l.busyHours)), [
          ('MACs-Mac-Studio.local', 12.5),
        ]);
      },
    );

    test(
      'reads a server from before names, last week and details as unknown',
      () {
        final ken = SuperTabLeaderboard.fromJson(answer()).people.first;
        expect(ken.displayName, isNull);
        expect(ken.prevWeekPoints, isNull);
        expect(ken.details, isNull);
      },
    );

    test('skips detail items with no title rather than drawing them blank', () {
      final ken = SuperTabLeaderboard.fromJson({
        ...answer(),
        'people': [
          {
            ...score('ken', points: 1, rank: 1),
            'displayName': '',
            'details': {
              'shipped': [
                {'prUrl': 'https://github.com/o/r/pull/1'},
                {'title': 'Kept', 'prUrl': 7},
              ],
              'unblocked': 'not a list',
            },
          },
        ],
      }).people.single;
      expect(ken.displayName, isNull);
      expect(ken.details!.shipped.map((s) => (s.title, s.prUrl)), [
        ('Kept', null),
      ]);
      expect(ken.details!.unblocked, isEmpty);
      expect(ken.details!.lent, isEmpty);
    });

    test('writes the numbers in words, lent in hours, zeros left out', () {
      final board = SuperTabLeaderboard.fromJson(answer());
      expect(leaderboardNumbers(board.people[0]), [
        '9 shipped',
        '14 unblocked',
        '31 hours lent',
      ]);
      expect(leaderboardNumbers(board.people[1]), ['6 shipped', '5 unblocked']);
      expect(leaderboardNumbers(board.people[3]), isEmpty);
      final one = SuperTabPersonScore.fromJson(
        score('a', points: 1, rank: 1, lentMs: hour),
      );
      expect(leaderboardNumbers(one), ['1 hour lent']);
    });

    test('asks for the project and, once chosen, the week', () async {
      final requests = FakeRequests();
      final reader = SuperTabLeaderboardReader(
        tabId: 'tab 1',
        request: requests.call,
      );
      addTearDown(reader.dispose);
      await reader.show('lead');
      await reader.showWeek(week - 7 * 86400000);
      expect(requests.paths, [
        // Answered as a server before periods answers: by week, from then on.
        'GET /api/super-tabs/tab%201/leaderboard?projectId=lead&period=7d&scope=all',
        'GET /api/super-tabs/tab%201/leaderboard?projectId=lead&week=${week - 7 * 86400000}',
      ]);
      expect(reader.board?.week, week);
    });

    group('the rolling periods', () {
      Map<String, dynamic> rolling(String name, {bool all = true}) => {
        ...answer(),
        'period': {'name': name, 'start': 1, 'end': 2},
        if (all) 'allProjects': true,
      };
      const older = SuperTabFailure(
        'VALIDATION',
        'Unrecognized key',
        statusCode: 400,
      );

      test(
        'reads Last 7d of All projects first, and another by name',
        () async {
          final paths = <String>[];
          final reader = SuperTabLeaderboardReader(
            tabId: 't',
            request: (method, path, {body}) async {
              paths.add(path);
              return rolling(
                path.contains('period=30d') ? '30d' : '7d',
                all: path.contains('scope=all'),
              );
            },
          );
          addTearDown(reader.dispose);
          await reader.show('lead');
          expect(reader.period, '7d');
          expect(reader.board?.period, '7d');
          expect(reader.board?.allProjects, isTrue);
          var cleared = false;
          reader.addListener(() => cleared = cleared || reader.board == null);
          await reader.showPeriod('30d');
          expect(
            cleared,
            isTrue,
            reason: "another period's numbers never wear this one's name",
          );
          final narrowed = reader.showAllProjects(false);
          expect(
            reader.board,
            isNull,
            reason: 'whole-Swarm numbers under one project',
          );
          await narrowed;
          expect(reader.board?.allProjects, isFalse);
          expect(paths, [
            '/api/super-tabs/t/leaderboard?projectId=lead&period=7d&scope=all',
            '/api/super-tabs/t/leaderboard?projectId=lead&period=30d&scope=all',
            '/api/super-tabs/t/leaderboard?projectId=lead&period=30d',
          ]);
        },
      );

      test('a server before periods keeps the weeks, after one refusal, and asks no scope', () async {
        final paths = <String>[];
        final reader = SuperTabLeaderboardReader(
          tabId: 't',
          request: (method, path, {body}) async {
            paths.add(path);
            if (path.contains('period=')) {
              throw older;
            }
            return answer();
          },
        );
        addTearDown(reader.dispose);
        await reader.show('lead');
        expect(reader.period, isNull);
        expect(reader.error, isNull);
        expect(reader.board?.week, week);
        await reader.refresh();
        expect(paths, [
          '/api/super-tabs/t/leaderboard?projectId=lead&period=7d&scope=all',
          '/api/super-tabs/t/leaderboard?projectId=lead',
          '/api/super-tabs/t/leaderboard?projectId=lead',
        ]);
      });

      test('a failed first read leaves the periods on, and recovers', () async {
        var fail = true;
        final reader = SuperTabLeaderboardReader(
          tabId: 't',
          request: (method, path, {body}) async {
            if (fail) {
              throw const SuperTabFailure(
                'OFFLINE',
                'No connection.',
                statusCode: 503,
              );
            }
            return rolling('7d');
          },
        );
        addTearDown(reader.dispose);
        await reader.show('lead');
        expect(reader.period, '7d');
        expect(reader.error, 'No connection.');
        fail = false;
        await reader.refresh();
        expect(reader.board?.period, '7d');
        expect(reader.error, isNull);
      });

      test('an answer or a refusal left behind changes nothing', () async {
        final slow = Completer<Map<String, dynamic>>(),
            refused = Completer<Map<String, dynamic>>();
        final reader = SuperTabLeaderboardReader(
          tabId: 't',
          request: (method, path, {body}) {
            if (path.contains('period=7d')) return slow.future;
            if (path.contains('period=24h')) return refused.future;
            return Future.value(rolling('30d'));
          },
        );
        addTearDown(reader.dispose);
        final first = reader.show('lead');
        final second = reader.showPeriod('24h');
        await reader.showPeriod('30d');
        slow.complete(rolling('7d'));
        refused.completeError(older);
        await first;
        await second;
        expect(reader.board?.period, '30d');
        expect(reader.period, '30d');
      });

      test(
        'access lost: a read in flight is dropped and the board forgotten',
        () async {
          final slow = Completer<Map<String, dynamic>>();
          final reader = SuperTabLeaderboardReader(
            tabId: 't',
            request: (method, path, {body}) => slow.future,
          );
          addTearDown(reader.dispose);
          final first = reader.show('lead');
          reader.clear();
          slow.complete(rolling('7d'));
          await first;
          expect(reader.board, isNull);
        },
      );

      test('a period says itself in a person\'s words; a week as before', () {
        final score = SuperTabLeaderboard.fromJson(rolling('24h')).people.first;
        expect(score.spanName, 'in the last 24 hours');
        expect(score.earlierName, 'the 24 hours before');
        expect(
          SuperTabLeaderboard.fromJson(answer()).people.first.spanName,
          'this week',
        );
        expect(
          SuperTabLeaderboard.fromJson(rolling('7d')).spanName,
          'in the last 7 days',
        );
        expect(leaderboardPeriods.map(leaderboardPeriodLabel), [
          'Last 24h',
          'Last 7d',
          'Last 30d',
        ]);
      });
    });

    test('shows no numbers while another week is read, so one week never wears another\'s name', () async {
      final requests = FakeRequests();
      final pending = Completer<Map<String, dynamic>>();
      final reader = SuperTabLeaderboardReader(
        tabId: 'tab',
        request: (method, path, {body}) => path.contains('&week=')
            ? pending.future
            : requests.call(method, path),
      );
      addTearDown(reader.dispose);
      await reader.show('lead');
      final earlier = reader.showWeek(week - 7 * 86400000);
      expect(reader.board, isNull);
      pending.complete({...answer(), 'week': week - 7 * 86400000});
      await earlier;
      expect(reader.board?.week, week - 7 * 86400000);
    });

    test('keeps the last board when a refresh fails, and says it could not refresh', () async {
      final requests = FakeRequests();
      final reader = SuperTabLeaderboardReader(
        tabId: 'tab',
        request: requests.call,
      );
      addTearDown(reader.dispose);
      await reader.show('lead');
      requests.respond = (_) =>
          const SuperTabFailure('OFFLINE', 'No connection.');
      await reader.refresh();
      expect(reader.board, isNotNull);
      expect(reader.error, 'No connection.');
    });

    test(
      'reads a server without a leaderboard as no board, not as an error',
      () async {
        final requests = FakeRequests()
          ..respond = (_) =>
              const SuperTabFailure('NOT_FOUND', 'Not found.', statusCode: 404);
        final reader = SuperTabLeaderboardReader(
          tabId: 'tab',
          request: requests.call,
        );
        addTearDown(reader.dispose);
        await reader.show('lead');
        expect(reader.board, isNull);
        expect(reader.error, isNull);
      },
    );

    test('forgets the board once the reader may not read the project, without naming why', () async {
      final requests = FakeRequests();
      final reader = SuperTabLeaderboardReader(
        tabId: 'tab',
        request: requests.call,
      );
      addTearDown(reader.dispose);
      await reader.show('lead');
      expect(reader.board, isNotNull);
      requests.respond = (_) => const SuperTabFailure(
        'FORBIDDEN',
        'Not a member of Pilot.',
        statusCode: 403,
      );
      await reader.refresh();
      expect(reader.board, isNull);
      expect(reader.error, isNull);
    });

    test(
      'clears the board and drops a read in flight once no project is shown',
      () async {
        final late = Completer<Map<String, dynamic>>();
        var reads = 0;
        final reader = SuperTabLeaderboardReader(
          tabId: 'tab',
          request: (method, path, {body}) async {
            reads++;
            return reads == 1 ? answer() : late.future;
          },
        );
        addTearDown(reader.dispose);
        await reader.show('lead');
        final inFlight = reader.refresh();
        reader.clear();
        expect(reader.board, isNull);
        late.complete(answer());
        await inFlight;
        expect(reader.board, isNull);
      },
    );

    test(
      'drops a board read for another project once the project changes',
      () async {
        final requests = FakeRequests(),
            late = Completer<Map<String, dynamic>>();
        final reader = SuperTabLeaderboardReader(
          tabId: 'tab',
          request: (method, path, {body}) => path.contains('projectId=old')
              ? late.future
              : requests.call(method, path),
        );
        addTearDown(reader.dispose);
        final first = reader.show('old');
        await reader.show('new');
        late.complete({...answer(), 'projectId': 'old'});
        await first;
        expect(reader.board?.projectId, 'lead');
      },
    );

    test(
      'refreshes on its own every minute while shown, and stops once hidden',
      () {
        fakeAsync((async) {
          final requests = FakeRequests();
          final reader = SuperTabLeaderboardReader(
            tabId: 'tab',
            request: requests.call,
          );
          reader.show('lead');
          async.elapse(const Duration(minutes: 2, seconds: 1));
          expect(requests.paths, hasLength(3));
          reader.hide();
          async.elapse(const Duration(minutes: 5));
          expect(requests.paths, hasLength(3));
          reader.dispose();
        });
      },
    );
  });
}
