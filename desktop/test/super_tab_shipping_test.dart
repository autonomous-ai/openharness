import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/leaderboard/shipping.dart';

// The leaderboard as the backend answers it (backend superTabs/shipping/contract.ts) and the reader that keeps it.
Map<String, dynamic> person(
  String id,
  int rank,
  double points, {
  int agents = 1,
  int level = 1,
  String? name,
}) => {
  'personId': id,
  'displayName': name ?? id,
  'agentsShipping': agents,
  'level': level,
  'points': points,
  'rank': rank,
};

void main() {
  group('the board', () {
    test('lists its people as the server ranks them, and a failed reading', () {
      final board = SuperTabShipping.fromJson({
        'week': 1793577600000,
        'people': [
          person('ann', 1, 3.4, agents: 2, level: 2, name: 'Ann Lee'),
          person('bob', 2, 2.8),
        ],
        'failures': [
          {'machineId': 'mac-1', 'code': 'GH_SIGNED_OUT'},
        ],
      });
      expect(board.week, 1793577600000);
      expect(board.people.map((p) => (p.rank, p.displayName, p.points)), [
        (1, 'Ann Lee', 3.4),
        (2, 'bob', 2.8),
      ]);
      expect(board.people.first.agentsShipping, 2);
      expect(board.people.first.level, 2);
      expect(board.failures.single.machineId, 'mac-1');
      expect(board.failures.single.code, 'GH_SIGNED_OUT');
    });

    test('is all time when the server says week 0, and takes whole points as numbers', () {
      for (final week in [0, null]) {
        final board = SuperTabShipping.fromJson({
          'week': week,
          'people': [person('ann', 1, 10)],
          'failures': <dynamic>[],
        });
        expect(board.week, isNull, reason: '$week');
        expect(board.people.single.points, 10.0);
      }
    });

    test('skips a row that is not one, and reads a missing list as none', () {
      final board = SuperTabShipping.fromJson({
        'week': 1,
        'people': [
          person('ann', 1, 1),
          'ann',
          {'personId': 'bob'},
          {...person('cy', 3, 1), 'rank': '3'},
          {...person('di', 4, 1), 'points': 'many'},
        ],
        'failures': [
          {'machineId': 'mac-1'},
          5,
          {'machineId': 'mac-2', 'code': 'TIMEOUT'},
        ],
      });
      expect(board.people.map((p) => p.personId), ['ann']);
      expect(board.failures.map((f) => f.machineId), ['mac-2']);
      final none = SuperTabShipping.fromJson({'week': 0});
      expect(none.people, isEmpty);
      expect(none.failures, isEmpty);
    });

    test('says points to one decimal, and a failed reading in a few words', () {
      expect([0.0, 1.0, 3.4, 12.25].map(shippingPoints), [
        '0.0',
        '1.0',
        '3.4',
        '12.3',
      ]);
      expect(
        [
          'GH_MISSING',
          'GH_SIGNED_OUT',
          'RATE_LIMITED',
          'TIMEOUT',
          'TOO_MANY',
          'GH_FAILED',
          'SOMETHING_NEW',
        ].map(shippingFailureText),
        [
          'GitHub CLI missing',
          'GitHub signed out',
          'GitHub is limiting reads',
          'GitHub did not answer',
          'Too many issues to read',
          'GitHub read failed',
          'GitHub read failed',
        ],
      );
    });
  });

  group('the reader', () {
    late List<String> asked;
    late Future<Map<String, dynamic>> Function(String path) answer;
    SuperTabShippingReader make({Duration every = const Duration(minutes: 5)}) {
      asked = [];
      answer = (path) async => {
        'week': path.contains('all=1') ? 0 : 1793577600000,
        'people': [person('ann', 1, path.contains('all=1') ? 9 : 2.8)],
        'failures': <dynamic>[],
      };
      return SuperTabShippingReader(
        tabId: 'tab 1',
        every: every,
        request: (method, path, {body}) {
          asked.add('$method $path');
          return answer(path);
        },
      );
    }

    test('reads this week when shown, and all time when asked', () async {
      final reader = make();
      await reader.show();
      expect(asked, ['GET /api/super-tabs/tab%201/shipping']);
      expect(reader.board!.people.single.points, 2.8);
      expect(reader.loading, isFalse);
      final all = reader.showAllTime(true);
      // The week's numbers under all time's name would mislead until its read lands.
      expect(reader.board, isNull);
      expect(reader.allTime, isTrue);
      expect(reader.loading, isTrue);
      await all;
      expect(asked.last, 'GET /api/super-tabs/tab%201/shipping?all=1');
      expect(reader.board!.people.single.points, 9.0);
      expect(reader.board!.week, isNull);
      await reader.showAllTime(true);
      expect(asked, hasLength(2));
      reader.dispose();
    });

    test(
      'reads again every few minutes with one timer, and not once disposed',
      () {
        fakeAsync((time) {
          final reader = make(every: const Duration(minutes: 5));
          unawaited(reader.show());
          unawaited(reader.show());
          time.flushMicrotasks();
          expect(asked, hasLength(2));
          time.elapse(const Duration(minutes: 5));
          time.flushMicrotasks();
          expect(asked, hasLength(3));
          reader.dispose();
          time.elapse(const Duration(minutes: 20));
          expect(asked, hasLength(3));
        });
      },
    );

    test(
      'keeps this week\'s board for Top Teams while all time is shown',
      () async {
        final reader = make();
        await reader.show();
        final week = reader.week;
        expect(week!.people.single.points, 2.8);
        await reader.showAllTime(true);
        expect(reader.board!.week, isNull);
        expect(reader.week, same(week));
        await reader.showAllTime(false);
        expect(reader.week!.people.single.points, 2.8);
        reader.dispose();
      },
    );

    test('a read that does not answer has failed, and says so', () {
      fakeAsync((time) {
        final reader = make();
        answer = (_) => Completer<Map<String, dynamic>>().future;
        unawaited(reader.refresh());
        time.flushMicrotasks();
        expect(reader.loading, isTrue);
        time.elapse(SuperTabShippingReader.timeout);
        time.flushMicrotasks();
        expect(reader.loading, isFalse);
        expect(reader.error, "Couldn't read the leaderboard.");
        reader.dispose();
      });
    });

    test('never shows an answer that a later read has passed', () async {
      final reader = make();
      final first = Completer<Map<String, dynamic>>();
      answer = (_) => first.future;
      final slow = reader.show();
      answer = (path) async => {
        'week': 0,
        'people': [person('bob', 1, 1)],
        'failures': <dynamic>[],
      };
      await reader.refresh();
      first.complete({
        'week': 1,
        'people': [person('ann', 1, 5)],
        'failures': <dynamic>[],
      });
      await slow;
      expect(reader.board!.people.single.personId, 'bob');
      expect(reader.loading, isFalse);
      reader.dispose();
    });

    test('shows nothing from a server or a Swarm that has no board', () async {
      final reader = make();
      await reader.show();
      expect(reader.board, isNotNull);
      for (final status in [403, 404]) {
        answer = (_) => throw SuperTabFailure(
          'NOT_FOUND',
          'Not found.',
          statusCode: status,
        );
        await reader.refresh();
        expect(reader.board, isNull, reason: '$status');
        expect(reader.error, isNull, reason: '$status');
      }
      reader.dispose();
    });

    test('keeps the last board when a read fails, and says why', () async {
      final reader = make();
      await reader.show();
      answer = (_) => throw const SuperTabFailure(
        'OFFLINE',
        'No connection.',
        statusCode: 503,
      );
      await reader.refresh();
      expect(reader.board!.people.single.personId, 'ann');
      expect(reader.error, 'No connection.');
      expect(reader.loading, isFalse);
      answer = (_) => throw StateError('boom');
      await reader.refresh();
      expect(reader.error, "Couldn't read the leaderboard.");
      answer = (path) async => {
        'week': 1,
        'people': <dynamic>[],
        'failures': <dynamic>[],
      };
      await reader.refresh();
      expect(reader.error, isNull);
      expect(reader.board!.people, isEmpty);
      reader.dispose();
    });

    test('says nothing once disposed, even for a read in flight', () async {
      final reader = make();
      final pending = Completer<Map<String, dynamic>>();
      answer = (_) => pending.future;
      var heard = 0;
      reader.addListener(() => heard++);
      final read = reader.show();
      final before = heard;
      reader.dispose();
      pending.complete({
        'week': 1,
        'people': <dynamic>[],
        'failures': <dynamic>[],
      });
      await read;
      expect(heard, before);
      await reader.refresh();
      expect(asked, hasLength(1));
    });
  });
}
