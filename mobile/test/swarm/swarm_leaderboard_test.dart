import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/swarm_leaderboard_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

void main() {
  group('the board as read', () {
    test('keeps the order, places, cups and counts the backend sends', () {
      final read = SwarmLeaderboard.fromJson(leaderboardData());

      expect(read.week, 1792454400000);
      expect(read.shipped, 19);
      expect(read.shippedBefore, 11);
      expect(
        [for (final p in read.people) p.personId],
        ['diego', 'ken', 'dee'],
      );
      final diego = read.people.first;
      expect(diego.points, 28);
      expect(diego.rank, 1);
      expect(diego.medal, SwarmMedal.gold);
      expect(diego.shipped, 8);
      expect(diego.medianAskToShipMs, 3 * 3600000);
      expect(diego.unblocked, 1);
      expect(diego.unblockedMs, 6 * 60000);
      expect(diego.medianAnswerMs, 4 * 60000);
      expect(diego.lentMachines, 2);
      expect(diego.lentMs, 40 * 3600000);
      expect(diego.streakDays, 3);
      expect(read.people[1].medal, SwarmMedal.silver);
      expect(read.people[2].medal, isNull);
      expect(read.people[2].rank, 4);
    });

    test('a field missing or of another type reads as nothing', () {
      final read = SwarmLeaderboard.fromJson({
        'week': 1792454400000,
        'people': [
          {'personId': 'kim', 'points': 'many', 'medal': 'platinum'},
        ],
      });

      expect(read.shipped, 0);
      expect(read.shippedBefore, 0);
      final kim = read.people.single;
      expect(kim.points, 0);
      expect(kim.medal, isNull);
      expect(kim.shipped, 0);
      expect(kim.lentMs, 0);
      expect(kim.medianAskToShipMs, isNull);
      expect(kim.medianAnswerMs, isNull);
      expect(kim.streakDays, 0);
      expect(kim.details, isNull, reason: 'a server before details');
    });

    test("keeps a person's details in the order the backend sends", () {
      final details = SwarmScore.fromJson({
        ...scoreData('a', points: 9, rank: 1),
        'details': {
          'shipped': [
            {
              'title': 'Phone: the board shows details',
              'prUrl': 'https://github.com/o/r/pull/2',
              'mergedAt': 2,
            },
            {'title': 'Desktop: one count', 'prUrl': 'http://x.dev/pull/1'},
          ],
          'unblocked': [
            {
              'title': 'Which sign-in page ships first?',
              'conversationId': 'c1',
              'kind': 'decision',
              'waitedMinutes': 96,
            },
          ],
          'lent': [
            {'machineName': 'MACs-Mac-Studio.local', 'busyHours': 12.5},
            {'machineName': 'build-box', 'busyHours': 7},
          ],
        },
      }).details!;

      expect(details.shipped.map((s) => s.title), [
        'Phone: the board shows details',
        'Desktop: one count',
      ]);
      expect(
        details.shipped.first.link,
        Uri.parse('https://github.com/o/r/pull/2'),
      );
      expect(details.shipped.last.link, Uri.parse('http://x.dev/pull/1'));
      expect(details.unblocked.single.title, 'Which sign-in page ships first?');
      expect(details.unblocked.single.waitedMinutes, 96);
      // The machine as it calls itself, without .local; a whole number of
      // hours reads as one.
      expect(details.lent.map((l) => (l.machineName, l.busyHours)), [
        ('MACs-Mac-Studio', 12.5),
        ('build-box', 7.0),
      ]);
    });

    test('a detail without a title or a web link, or of another type, is '
        'left out or kept as text', () {
      final details = SwarmScore.fromJson({
        ...scoreData('a', points: 1, rank: 1),
        'details': {
          'shipped': [
            {'title': '', 'prUrl': 'https://x.dev/pull/1'},
            {'prUrl': 'https://x.dev/pull/2'},
            {'title': 'A file', 'prUrl': 'file:///etc/hosts'},
            {'title': 'A script', 'prUrl': 'javascript:alert(1)'},
            {'title': 'An app', 'prUrl': 'x-harness://open'},
            {'title': 'No host', 'prUrl': 'https:pull/3'},
            {'title': 'No link'},
            'not a map',
          ],
          'unblocked': [
            {'title': 'Asked', 'waitedMinutes': 'long'},
            {'waitedMinutes': 4},
          ],
          'lent': [
            {'machineName': '', 'busyHours': 2},
            {'machineName': '.local', 'busyHours': 'many'},
          ],
        },
      }).details!;

      expect(details.shipped.map((s) => (s.title, s.link)), [
        ('A file', null),
        ('A script', null),
        ('An app', null),
        ('No host', null),
        ('No link', null),
      ]);
      expect(details.unblocked.map((u) => (u.title, u.waitedMinutes)), [
        ('Asked', 0),
      ]);
      // A name that is only the suffix stays whole.
      expect(details.lent.map((l) => (l.machineName, l.busyHours)), [
        ('.local', 0.0),
      ]);

      final empty = SwarmScore.fromJson({
        ...scoreData('b', points: 0, rank: 2),
        'details': {'shipped': 'none', 'lent': null},
      }).details!;
      expect(empty.shipped, isEmpty);
      expect(empty.unblocked, isEmpty);
      expect(empty.lent, isEmpty);
      expect(
        SwarmScore.fromJson({
          ...scoreData('c', points: 0, rank: 3),
          'details': ['not', 'a', 'map'],
        }).details,
        isNull,
      );
    });
  });

  group('how the board writes', () {
    test('the numbers in words, each that would read zero left out', () {
      SwarmScore score(Map<String, dynamic> json) => SwarmScore.fromJson(json);
      expect(
        swarmNumbers(
          score(
            scoreData(
              'a',
              points: 9,
              rank: 1,
              shipped: 8,
              unblocked: 1,
              lentMs: 40 * 3600000,
            ),
          ),
        ),
        ['8 shipped', '1 unblocked', '40 hours lent'],
      );
      expect(
        swarmNumbers(score(scoreData('b', points: 2, rank: 2, unblocked: 2))),
        ['2 unblocked'],
      );
      expect(
        swarmNumbers(
          score(scoreData('d', points: 1, rank: 4, lentMs: 3600000)),
        ),
        ['1 hour lent'],
      );
      // Under half an hour lent reads 0 hours, so it is left out.
      expect(
        swarmNumbers(score(scoreData('c', points: 0, rank: 3, lentMs: 60000))),
        isEmpty,
      );
    });

    test('the profile name when the board has one', () {
      expect(
        SwarmScore.fromJson({
          ...scoreData('a', points: 1, rank: 1),
          'displayName': 'Diego M',
        }).displayName,
        'Diego M',
      );
      expect(
        SwarmScore.fromJson({
          ...scoreData('a', points: 1, rank: 1),
          'displayName': '',
        }).displayName,
        isNull,
      );
    });

    test('the change against last week, none when level or unknown', () {
      SwarmScore score(int points, int? before) => SwarmScore.fromJson({
        ...scoreData('a', points: points, rank: 1),
        'prevWeekPoints': ?before,
      });
      expect(swarmTrend(score(28, 20)), 'up 8 from last week');
      expect(swarmTrend(score(21, 25)), 'down 4 from last week');
      expect(swarmTrend(score(5, 5)), isNull);
      expect(swarmTrend(score(5, null)), isNull);
    });

    test('a duration in minutes under an hour, then in hours', () {
      expect(swarmDuration(6 * 60000), '6 min');
      expect(swarmDuration(3 * 3600000), '3 h');
      expect(swarmDuration(3 * 3600000 + 6 * 60000), '3.1 h');
    });

    test("a person's points with the time before beside them", () {
      SwarmScore score(int points, int? before, {String? period}) =>
          SwarmScore.fromJson({
            ...scoreData('a', points: points, rank: 1),
            'prevWeekPoints': ?before,
          }, period: period);
      expect(
        swarmPersonPoints(score(21, 15, period: '7d')),
        '21 points in the last 7 days · 15 the 7 days before',
      );
      expect(swarmPersonPoints(score(1, 0)), '1 point this week · 0 last week');
      // Last 30d has no comparison.
      expect(
        swarmPersonPoints(score(30, null, period: '30d')),
        '30 points in the last 30 days',
      );
    });

    test('how long an answer waited and a machine was busy', () {
      expect(swarmWaited(6), 'waited 6 min');
      expect(swarmWaited(96), 'waited 1.6 h');
      expect(swarmWaited(0), 'waited 0 min');
      expect(swarmBusy(12.5), '12.5 h busy');
      expect(swarmBusy(7), '7 h busy');
      expect(swarmBusy(0.1), '6 min busy');
    });

    test('lent time in whole agent-hours', () {
      expect(swarmHours(0), 0);
      expect(swarmHours(40 * 3600000), 40);
      expect(swarmHours(123 * 3600000 + 29 * 60000), 123);
      expect(swarmHours(30 * 60000), 1);
    });

    test("a week is named from this week's Monday", () {
      // Wednesday 28 October 2026, 02:00 in Hanoi: still Tuesday in UTC.
      final now = DateTime.utc(2026, 10, 27, 19);
      final monday = DateTime.utc(2026, 10, 26).millisecondsSinceEpoch;
      expect(swarmWeekOf(now), monday);
      expect(swarmWeekOf(DateTime.utc(2026, 10, 26)), monday);
      expect(swarmWeekOf(DateTime.utc(2026, 11, 1, 23, 59)), monday);

      expect(swarmWeekName(null, monday), 'This week');
      expect(swarmWeekName(monday, monday), 'This week');
      expect(swarmWeekName(monday - swarmWeekMs, monday), 'Last week');
      expect(swarmWeekName(monday - 3 * swarmWeekMs, monday), '3 weeks ago');
    });
  });

  group('the reader', () {
    const path = '/api/super-tabs/$tab/leaderboard?projectId=$project';
    const lastWeek = 1792454400000 - swarmWeekMs;

    SwarmLeaderboardReader reader(FakeSwarm fake, {bool inFront = true}) {
      final read = SwarmLeaderboardReader(
        tabId: tab,
        projectId: project,
        request: fake.request,
        inFront: () => inFront,
      );
      addTearDown(read.dispose);
      return read;
    }

    test("reads this week's board of the project", () async {
      final fake = FakeSwarm()..routes[path] = (_) => leaderboardData();
      final read = reader(fake);
      expect(read.loading, isTrue);

      await read.refresh();

      expect(fake.paths, ['$path&period=7d']);
      expect(read.loading, isFalse);
      expect(read.board!.people.first.personId, 'diego');
      expect(read.week, isNull);
    });

    group('the rolling periods', () {
      Map<String, dynamic> period(String name, {int shipped = 19}) => {
        ...leaderboardData(shipped: shipped),
        'period': {'name': name, 'start': 1, 'end': 2},
      };
      const older = SuperTabFailure(
        'VALIDATION',
        'Unrecognized key',
        statusCode: 400,
      );

      test('reads Last 7d first, and another period by name', () async {
        final fake = FakeSwarm()
          ..routes['$path&period=7d'] = ((_) => period('7d'))
          ..routes['$path&period=30d'] = (_) => period('30d', shipped: 40);
        final read = reader(fake);
        await read.refresh();
        expect(read.period, '7d');
        expect(read.board!.period, '7d');

        final told = <SwarmLeaderboard?>[];
        read.addListener(() => told.add(read.board));
        final shown = read.showPeriod('30d');
        expect(read.board, isNull, reason: "another period's numbers");
        await shown;
        expect(told.first, isNull);
        expect(fake.paths.last, '$path&period=30d');
        expect(read.board!.shipped, 40);
      });

      test(
        'a server before periods keeps the weeks, after one refusal',
        () async {
          final fake = FakeSwarm()
            ..routes['$path&period=7d'] = ((_) => throw older)
            ..routes[path] = (_) => leaderboardData();
          final read = reader(fake);
          await read.refresh();
          expect(read.period, isNull);
          expect(read.error, isNull);
          expect(read.board!.shipped, isNot(0));
          await read.refresh();
          expect(fake.paths, ['$path&period=7d', path, path]);
        },
      );

      test('a failed first read leaves the periods on, and recovers', () async {
        var fail = true;
        final fake = FakeSwarm()
          ..routes[path] = (_) => fail
              ? throw const SuperTabFailure('OFFLINE', 'No computer answered.')
              : period('7d');
        final read = reader(fake);
        await read.refresh();
        expect(read.period, '7d');
        expect(read.error, 'No computer answered.');
        fail = false;
        await read.refresh();
        expect(read.period, '7d');
        expect(read.board!.period, '7d');
        expect(read.error, isNull);
      });

      test('an answer for the period left behind is not shown, a refusal '
          'included', () async {
        final slow = Completer<Object?>(), refused = Completer<Object?>();
        final fake = FakeSwarm()
          ..routes['$path&period=7d'] = ((_) => slow.future)
          ..routes['$path&period=24h'] = ((_) => refused.future)
          ..routes['$path&period=30d'] = (_) => period('30d', shipped: 40);
        final read = reader(fake);
        final first = read.refresh();
        final second = read.showPeriod('24h');
        await read.showPeriod('30d');
        slow.complete(period('7d', shipped: 1));
        refused.completeError(older);
        await first;
        await second;
        expect(read.board!.shipped, 40);
        expect(read.period, '30d', reason: 'a stale refusal changes nothing');
      });

      test('says the period in words, and no comparison for Last 30d', () {
        final week = SwarmLeaderboard.fromJson(period('7d'));
        final score = week.people.first;
        expect(score.spanName, 'in the last 7 days');
        expect(score.earlierName, 'the 7 days before');
        expect(swarmPersonWeek(score).first.$2, contains('in the last 7 days'));
        expect(swarmPeriodEarlier('24h'), 'the 24 hours before');
        expect(swarmPeriodEarlier('30d'), isNull);
        final old = SwarmLeaderboard.fromJson(leaderboardData()).people.first;
        expect(old.spanName, 'this week');
      });

      test('says a trend against the time before', () {
        final score = SwarmLeaderboard.fromJson({
          ...period('24h'),
          'people': [
            {'personId': 'a', 'points': 9, 'rank': 1, 'prevWeekPoints': 4},
          ],
        }).people.first;
        expect(swarmTrend(score), 'up 5 from the 24 hours before');
      });
    });

    test('another week clears the board until its own read lands', () async {
      final fake = FakeSwarm()
        ..routes[path] = ((_) => leaderboardData())
        ..routes['$path&week=$lastWeek'] = (_) =>
            leaderboardData(week: lastWeek, shipped: 11);
      final read = reader(fake);
      await read.refresh();
      final told = <SwarmLeaderboard?>[];
      read.addListener(() => told.add(read.board));

      final shown = read.showWeek(lastWeek);
      expect(read.board, isNull, reason: "this week's numbers under its name");
      expect(read.week, lastWeek);
      await shown;

      expect(fake.paths.last, '$path&week=$lastWeek');
      expect(read.board!.shipped, 11);
      expect(told.first, isNull);
    });

    test('an answer for the week left behind is not shown', () async {
      final slow = Completer<Object?>();
      var reads = 0;
      final fake = FakeSwarm()
        ..routes[path] = ((_) => reads++ == 0 ? leaderboardData() : slow.future)
        ..routes['$path&week=$lastWeek'] = (_) =>
            leaderboardData(week: lastWeek, shipped: 11);
      final read = reader(fake);
      await read.refresh();
      final first = read.refresh();

      await read.showWeek(lastWeek);
      slow.complete(leaderboardData(shipped: 19));
      await first;

      expect(read.board!.shipped, 11);
    });

    test('a failed refresh keeps the board and says why', () async {
      var fail = false;
      final fake = FakeSwarm()
        ..routes[path] = (_) => fail
            ? throw const SuperTabFailure('OFFLINE', 'No computer answered.')
            : leaderboardData();
      final read = reader(fake);
      await read.refresh();

      fail = true;
      await read.refresh();
      expect(read.board!.shipped, 19);
      expect(read.error, 'No computer answered.');

      fail = false;
      await read.refresh();
      expect(read.error, isNull);
    });

    test('an answer it cannot read says so', () async {
      final fake = FakeSwarm()..routes[path] = (_) => 'not a board';
      final read = reader(fake);

      await read.refresh();

      expect(read.board, isNull);
      expect(read.error, "Couldn't read the leaderboard.");
      expect(read.loading, isFalse);
    });

    test('a server without a leaderboard says it has none', () async {
      // FakeSwarm answers 404 for a path it has no route for.
      final read = reader(FakeSwarm());

      await read.refresh();

      expect(read.unavailable, isTrue);
      expect(read.board, isNull);
      expect(read.error, isNull);
      expect(read.loading, isFalse);
    });

    test('reads again every five minutes, only while the app is in '
        'front', () {
      fakeAsync((async) {
        var inFront = true;
        final fake = FakeSwarm()..routes[path] = (_) => leaderboardData();
        final read = SwarmLeaderboardReader(
          tabId: tab,
          projectId: project,
          request: fake.request,
          inFront: () => inFront,
        );
        read.start();
        async.flushMicrotasks();
        expect(fake.paths, hasLength(1), reason: 'read at once');

        async.elapse(const Duration(minutes: 5));
        expect(fake.paths, hasLength(2));

        inFront = false;
        async.elapse(const Duration(minutes: 10));
        expect(fake.paths, hasLength(2));

        read.dispose();
        inFront = true;
        async.elapse(const Duration(minutes: 10));
        expect(fake.paths, hasLength(2), reason: 'none after it is gone');
      });
    });
  });
}
