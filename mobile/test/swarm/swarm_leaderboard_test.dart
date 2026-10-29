import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/swarm_leaderboard_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'leaderboard_fixture.dart';
import 'swarm_fixture.dart';

void main() {
  group('the board as read', () {
    test('keeps the order, places, cups and counts the backend sends', () {
      final read = SwarmLeaderboard.fromJson(leaderboardData());

      expect(read.week, 1792454400000);
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

      final kim = read.people.single;
      expect(kim.points, 0);
      expect(kim.medal, isNull);
      expect(kim.shipped, 0);
      expect(kim.lentMs, 0);
      expect(kim.medianAskToShipMs, isNull);
      expect(kim.medianAnswerMs, isNull);
      expect(kim.streakDays, 0);
    });

    test("the project's PM and Buddies, in the backend's order", () {
      final read = SwarmLeaderboard.fromJson({
        ...leaderboardData(),
        'agents': [
          agentScoreData('pm-1', displayName: 'River', points: 12, rank: 1),
          agentScoreData(
            'buddy-1',
            displayName: 'Aria',
            kind: 'buddy',
            personId: 'ken',
            points: 3,
            rank: 2,
            shipped: 1,
          ),
        ],
      });

      expect([for (final a in read.agents) a.agentId], ['pm-1', 'buddy-1']);
      final pm = read.agents.first;
      expect(pm.displayName, 'River');
      expect(pm.buddy, isFalse);
      expect(pm.personId, isNull);
      expect(pm.points, 12);
      expect(pm.rank, 1);
      expect(pm.shipped, 4);
      final buddy = read.agents.last;
      expect(buddy.buddy, isTrue);
      expect(buddy.personId, 'ken');
      expect(buddy.shipped, 1);
    });

    test('every model that worked, in the backend\'s order', () {
      final read = SwarmLeaderboard.fromJson({
        ...leaderboardData(),
        'byModel': [
          modelScoreData(
            'claude',
            model: 'claude-opus-5-5',
            effort: 'high',
            points: 31,
            rank: 1,
            shipped: 31,
            medianAttemptMs: 47 * 60000,
            medianRequestMs: 2 * 3600000,
            reviewed: 11,
            passed: 9,
            reviews: 5,
          ),
          modelScoreData('codex', grid: true, points: 2, rank: 2),
        ],
      });

      final opus = read.byModel.first;
      expect(opus.engine, 'claude');
      expect(opus.model, 'claude-opus-5-5');
      expect(opus.effort, 'high');
      expect(opus.grid, isFalse);
      expect(opus.points, 31);
      expect(opus.rank, 1);
      expect(opus.shipped, 31);
      expect(opus.medianAttemptMs, 47 * 60000);
      expect(opus.medianRequestMs, 2 * 3600000);
      expect(opus.reviewed, 11);
      expect(opus.passed, 9);
      expect(opus.reviews, 5);
      final codex = read.byModel.last;
      expect(codex.model, isNull);
      expect(codex.effort, isNull);
      expect(codex.grid, isTrue);
      expect(codex.medianAttemptMs, isNull);
      // One key per row: engine, model and effort.
      expect(opus.key, isNot(codex.key));
      expect(
        SwarmModelScore.fromJson(
          modelScoreData(
            'claude',
            model: 'claude-opus-5-5',
            points: 1,
            rank: 3,
          ),
        ).key,
        isNot(opus.key),
        reason: 'another effort of the same model is another row',
      );
    });

    test('a server before the Agents and Models lists reads them empty', () {
      final read = SwarmLeaderboard.fromJson(leaderboardData());
      expect(read.agents, isEmpty);
      expect(read.byModel, isEmpty);

      final odd = SwarmLeaderboard.fromJson({
        ...leaderboardData(),
        'agents': 'none',
        'byModel': [
          'not a row',
          {'engine': 7, 'points': 'many', 'shipped': 3, 'firstReview': null},
        ],
      });
      expect(odd.agents, isEmpty);
      final row = odd.byModel.single;
      expect(row.engine, '');
      expect(row.points, 0);
      expect(row.shipped, 0);
      expect(row.reviewed, 0);
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

    test('a model by the name people know it, else its engine', () {
      expect(swarmModelLabel('claude', 'opus'), 'Opus');
      expect(swarmModelLabel('claude', 'claude-opus-5-5'), 'Opus 5.5');
      expect(
        swarmModelLabel('claude', 'claude-sonnet-5-5[1m]'),
        'Sonnet 5.5[1m]',
      );
      expect(swarmModelLabel('codex', 'gpt-5.5'), 'GPT-5.5');
      expect(swarmModelLabel('codex', 'gpt-5.6-sol'), 'GPT-5.6 Sol');
      // Unknown and provider-qualified names stay exact.
      expect(
        swarmModelLabel('opencode', 'qwen/qwen3-coder'),
        'qwen/qwen3-coder',
      );
      // No model reported: the engine's name.
      expect(swarmModelLabel('codex', null), 'Codex');
    });

    // The desktop's Models list (10-29): each model's share of work approved
    // at its first review, the number alone.
    test("models by the share of their work approved at its first review, "
        'the most approved first', () {
      SwarmModelScore score(
        String engine,
        String? model, {
        String? effort,
        int reviewed = 0,
        int passed = 0,
      }) => SwarmModelScore.fromJson(
        modelScoreData(
          engine,
          model: model,
          effort: effort,
          reviewed: reviewed,
          passed: passed,
        ),
      );
      final approvals = swarmModelApprovals([
        score('codex', 'gpt-5.6-sol', reviewed: 16, passed: 13),
        // One model at two efforts, on two engines, is one row: 11 of 12.
        score(
          'claude',
          'claude-opus-5-5',
          effort: 'high',
          reviewed: 8,
          passed: 7,
        ),
        score(
          'cursor',
          'claude-opus-5-5',
          effort: 'xhigh',
          reviewed: 4,
          passed: 4,
        ),
        score('claude', 'claude-sonnet-5-5', reviewed: 10, passed: 7),
        // Three first reviews across its efforts: enough, at 2 and 1.
        score('codex', 'gpt-5.6-luna', effort: 'low', reviewed: 2, passed: 1),
        score('codex', 'gpt-5.6-luna', effort: 'high', reviewed: 1),
        // Two first reviews say nothing yet, even all passed.
        score('claude', 'claude-haiku-5-5', reviewed: 2, passed: 2),
        // Nothing reviewed yet: no share to show.
        score('codex', 'gpt-5.5', effort: 'medium'),
      ]);
      expect(approvals, [
        (name: 'Opus 5.5', reviewed: 12, passed: 11, percent: 92),
        (name: 'GPT-5.6 Sol', reviewed: 16, passed: 13, percent: 81),
        (name: 'Sonnet 5.5', reviewed: 10, passed: 7, percent: 70),
        (name: 'GPT-5.6 Luna', reviewed: 3, passed: 1, percent: 33),
      ]);
      expect(swarmModelApprovals(const []), isEmpty);
    });

    test('an equal share puts the most reviewed first, then the name', () {
      SwarmModelScore score(String model, int reviewed, int passed) =>
          SwarmModelScore.fromJson(
            modelScoreData(
              'codex',
              model: model,
              reviewed: reviewed,
              passed: passed,
            ),
          );
      expect(
        [
          for (final a in swarmModelApprovals([
            score('b-model', 6, 3),
            score('a-model', 6, 3),
            score('c-model', 8, 4),
          ]))
            a.name,
        ],
        ['c-model', 'a-model', 'b-model'],
      );
    });

    test('the share orders, not its rounding', () {
      SwarmModelScore score(String model, int reviewed, int passed) =>
          SwarmModelScore.fromJson(
            modelScoreData(
              'codex',
              model: model,
              reviewed: reviewed,
              passed: passed,
            ),
          );
      // Both read 67%; 67 of 100 is the higher share, though reviewed less.
      expect(
        swarmModelApprovals([score('more', 200, 133), score('less', 100, 67)]),
        [
          (name: 'less', reviewed: 100, passed: 67, percent: 67),
          (name: 'more', reviewed: 200, passed: 133, percent: 67),
        ],
      );
    });

    test('a share never reads over 100%, whatever a count says', () {
      expect(
        swarmModelApprovals([
          SwarmModelScore.fromJson(
            modelScoreData('claude', model: 'opus', reviewed: 3, passed: 5),
          ),
        ]).single,
        (name: 'Opus', reviewed: 3, passed: 3, percent: 100),
      );
    });

    test("a person's crown: first place, and only with points", () {
      expect(swarmCrowned(rank: 1, points: 28), isTrue);
      expect(swarmCrowned(rank: 2, points: 21), isFalse);
      // At the start of a week everyone ties at 0: no one has taken #1 yet.
      expect(swarmCrowned(rank: 1, points: 0), isFalse);
    });

    test('a duration in minutes under an hour, then in hours', () {
      expect(swarmDuration(6 * 60000), '6 min');
      expect(swarmDuration(3 * 3600000), '3 h');
      expect(swarmDuration(3 * 3600000 + 6 * 60000), '3.1 h');
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
      expect(read.board!.week, lastWeek);
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
      slow.complete(leaderboardData());
      await first;

      expect(read.board!.week, lastWeek);
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
      expect(read.board!.people.first.personId, 'diego');
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
      // What the CLI hands on for a backend with no such route: Fastify's
      // own 404 carries no code (cli/src/superTabs/wire.ts).
      final read = reader(
        FakeSwarm()
          ..routes[path] = (_) => throw const SuperTabFailure(
            'BACKEND_UNAVAILABLE',
            'Route GET:/api/super-tabs/$tab/leaderboard not found',
            statusCode: 404,
          ),
      );

      await read.refresh();

      expect(read.unavailable, isTrue);
      expect(read.board, isNull);
      expect(read.error, isNull);
      expect(read.loading, isFalse);
    });

    for (final (why, refusal) in [
      (
        'removed from the Swarm',
        const SuperTabFailure(
          'FORBIDDEN',
          'You no longer have access to this Super Tab.',
          statusCode: 403,
        ),
      ),
      (
        'the project is no longer theirs to read',
        const SuperTabFailure(
          'NOT_FOUND',
          'This project is unavailable.',
          statusCode: 404,
        ),
      ),
    ]) {
      test('a refusal ($why) clears the board at once and says why', () async {
        var refuse = false;
        final fake = FakeSwarm()
          ..routes[path] = (_) => refuse ? throw refusal : leaderboardData();
        final read = reader(fake);
        await read.refresh();
        expect(read.board, isNotNull);

        refuse = true;
        await read.refresh();

        expect(read.board, isNull, reason: 'no row of it stays on screen');
        expect(read.error, refusal.message);
        expect(read.unavailable, isFalse, reason: 'not a server without one');
        expect(read.loading, isFalse);
      });
    }

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
