import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

void main() {
  group('the board as read', () {
    test('keeps the order, places, cups and counts the backend sends', () {
      final read = SwarmLeaderboard.fromJson(leaderboardData());

      expect(read.week, 1792454400000);
      expect(read.shipped, 19);
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
      final kim = read.people.single;
      expect(kim.points, 0);
      expect(kim.medal, isNull);
      expect(kim.shipped, 0);
      expect(kim.lentMs, 0);
      expect(kim.medianAskToShipMs, isNull);
      expect(kim.medianAnswerMs, isNull);
      expect(kim.streakDays, 0);
    });
  });

  group('how the board writes', () {
    test('a cup for each medal', () {
      expect(swarmCup(SwarmMedal.gold), '🥇');
      expect(swarmCup(SwarmMedal.silver), '🥈');
      expect(swarmCup(SwarmMedal.bronze), '🥉');
    });

    test('a duration in minutes under an hour, then in hours', () {
      expect(swarmDuration(6 * 60000), '6 min');
      expect(swarmDuration(3 * 3600000), '3 h');
      expect(swarmDuration(3 * 3600000 + 6 * 60000), '3.1 h');
    });

    test('lent time in whole agent-hours', () {
      expect(swarmLentHours(0), '0h');
      expect(swarmLentHours(40 * 3600000), '40h');
      expect(swarmLentHours(123 * 3600000 + 29 * 60000), '123h');
      expect(swarmLentHours(30 * 60000), '1h');
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

      expect(fake.paths, [path]);
      expect(read.loading, isFalse);
      expect(read.board!.people.first.personId, 'diego');
      expect(read.week, isNull);
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
      final fake = FakeSwarm()
        ..routes[path] = ((_) => slow.future)
        ..routes['$path&week=$lastWeek'] = (_) =>
            leaderboardData(week: lastWeek, shipped: 11);
      final read = reader(fake);
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
