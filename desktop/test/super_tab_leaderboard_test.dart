import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/leaderboard/column.dart';
import 'package:harness/super_tabs/leaderboard/model.dart';
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

String name(String id) => '${id[0].toUpperCase()}${id.substring(1)}';

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
      expect(board.goal.openRequests, 7);
      expect(board.goal.thisWeek.medianAskToShipMs, 3 * hour);
      expect(board.goal.lastWeek.shipped, 12);
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
        'GET /api/super-tabs/tab%201/leaderboard?projectId=lead',
        'GET /api/super-tabs/tab%201/leaderboard?projectId=lead&week=${week - 7 * 86400000}',
      ]);
      expect(reader.board?.week, week);
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

  group('the leaderboard column', () {
    Future<(SuperTabLeaderboardReader, List<String>)> mount(
      WidgetTester tester, {
      Map<String, dynamic>? waiting,
      String viewer = 'tony',
    }) async {
      final requests = FakeRequests()
        ..respond = (_) => answer(waiting: waiting);
      final reader = SuperTabLeaderboardReader(
        tabId: 'tab',
        request: requests.call,
      );
      addTearDown(reader.dispose);
      final answered = <String>[];
      await tester.binding.setSurfaceSize(const Size(400, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabLeaderboardColumn(
              reader: reader,
              projectId: 'lead',
              viewerId: viewer,
              nameOf: name,
              onAnswer: answered.add,
              now: () => DateTime.fromMillisecondsSinceEpoch(
                week + 3 * 86400000,
                isUtc: true,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return (reader, answered);
    }

    testWidgets(
      'gives the top three their medals and everyone their three numbers',
      (tester) async {
        await mount(tester);
        expect(find.text('Humans · this week'), findsOneWidget);
        expect(find.text('🏆'), findsOneWidget);
        expect(find.text('🥈'), findsOneWidget);
        expect(find.text('🥉'), findsOneWidget);
        expect(find.text('42 pts'), findsOneWidget);
        expect(
          find.text('🚀 9 shipped   🔓 14   ⚡ 2 machines'),
          findsOneWidget,
        );
        expect(find.text('🚀 6 shipped   🔓 5   ⚡ —'), findsOneWidget);
        expect(find.text('🚀 2 shipped   🔓 3   ⚡ 1 machine'), findsOneWidget);
        expect(find.text('Tony'), findsWidgets);
        expect(find.text('0 pts'), findsOneWidget);
      },
    );

    testWidgets(
      'shows each person\'s avatar beside their name, at the size the shared avatar takes',
      (tester) async {
        await mount(tester);
        final avatars = tester
            .widgetList<SuperTabAvatar>(find.byType(SuperTabAvatar))
            .toList();
        expect(avatars.map((a) => (a.identity, a.name, a.size)), [
          ('person:ken', 'Ken', 20.0),
          ('person:dee', 'Dee', 20.0),
          ('person:scholes', 'Scholes', 20.0),
          ('person:tony', 'Tony', 20.0),
        ]);
      },
    );

    testWidgets('shows the team goal against last week', (tester) async {
      await mount(tester);
      expect(find.text('Team goal · 7 open requests'), findsOneWidget);
      expect(
        find.text('19 shipped this week (12 last week) · 108 points'),
        findsOneWidget,
      );
      expect(
        find.text('Median ask to ship 3 h, down from 5 h'),
        findsOneWidget,
      );
    });

    testWidgets(
      'opens a person\'s week when their name is tapped, and closes it again',
      (tester) async {
        await mount(tester);
        await tester.tap(find.byKey(const ValueKey('leaderboard-person-ken')));
        await tester.pumpAndSettle();
        expect(
          find.text('9 asks landed · median 3.1 h to ship'),
          findsOneWidget,
        );
        expect(
          find.text('14 answered · median 6 min · 28 agent-hours freed'),
          findsOneWidget,
        );
        expect(find.text('2 machines · 31 slot-hours'), findsOneWidget);
        expect(find.text('5 days shipping'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('leaderboard-person-ken')));
        await tester.pumpAndSettle();
        expect(find.text('5 days shipping'), findsNothing);
      },
    );

    testWidgets(
      'names who agents wait on with counts only, never ranks or medals',
      (tester) async {
        await mount(tester);
        final line = find.byKey(const ValueKey('leaderboard-waiting'));
        expect(
          find.descendant(
            of: line,
            matching: find.text('⏳ Agents waiting on a person now: 3'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: line, matching: find.text('Ken 2 · Tony 1')),
          findsOneWidget,
        );
        for (final medal in ['🏆', '🥈', '🥉', 'pts']) {
          expect(
            find.descendant(of: line, matching: find.textContaining(medal)),
            findsNothing,
          );
        }
      },
    );

    testWidgets('takes the viewer straight to what waits on them', (
      tester,
    ) async {
      final (_, answered) = await mount(tester, viewer: 'tony');
      await tester.tap(find.text('Answer'));
      expect(answered, ['g3']);
    });

    testWidgets('takes anyone else to the first item waiting', (tester) async {
      final (_, answered) = await mount(tester, viewer: 'dee');
      await tester.tap(find.text('Answer'));
      expect(answered, ['g1']);
    });

    testWidgets(
      'says nobody is waiting, without an answer button, when none is',
      (tester) async {
        await mount(tester, waiting: {'total': 0, 'people': []});
        expect(find.text('No agent is waiting on a person.'), findsOneWidget);
        expect(find.text('Answer'), findsNothing);
      },
    );

    testWidgets('reads an earlier week when one is picked', (tester) async {
      final (reader, _) = await mount(tester);
      await tester.tap(find.byKey(const ValueKey('leaderboard-week')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Last week').last);
      await tester.pumpAndSettle();
      expect(reader.week, week - 7 * 86400000);
      expect(find.text('Humans · last week'), findsOneWidget);
    });
  });
}
