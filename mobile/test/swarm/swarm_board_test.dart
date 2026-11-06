import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_board.dart';

import 'swarm_fixture.dart';

/// The project's Board on the phone (task #3821): six columns, one place for
/// every task, by the rules of Desktop's Tasks board
/// (`desktop/test/super_tab_task_columns_test.dart`, task #3812), so the same
/// read puts the same task in the same column on both.
void main() {
  final now = DateTime.utc(2026, 11, 6, 9);
  const pr = 'https://github.com/autonomous-ai/openharness/pull/12';

  SuperTabConversation task({
    String id = 't',
    int number = 1,
    String? status,
    Map<String, dynamic>? liveness,
    bool archived = false,
    bool merged = false,
    bool linked = false,
    DateTime? shippedAt,
    List<String>? releasing,
    List<String>? releasedTags,
    String? notBefore,
    String? priority,
    num? queueRank,
  }) => SuperTabConversation.fromJson({
    ...groupData(id, title: 'Task $id', number: number, status: status),
    'archived': archived,
    'liveness': ?liveness,
    if (linked || merged) 'pullRequestUrls': [pr],
    if (linked || merged)
      'cards': {
        'pullRequests': [
          {'url': pr, 'messageId': 'm-$id', if (merged) 'mergedAt': 1},
        ],
      },
    'shippedAt': ?shippedAt?.millisecondsSinceEpoch,
    'releasing': ?releasing,
    if (releasedTags != null) 'released': {'at': 1, 'tags': releasedTags},
    'notBefore': ?notBefore,
    'priority': ?priority,
    'queueRank': ?queueRank,
  });

  Map<String, dynamic> waiting(String why, {String? personId}) => {
    'state': 'waiting',
    'why': why,
    'since': 1,
    'personId': ?personId,
  };

  SwarmBoardPlace? place(SuperTabConversation task, {bool needsYou = false}) =>
      swarmBoardPlaceOf(
        task,
        now: now,
        needsYou: needsYou,
        personName: (id) => const {'ken': 'Ken'}[id],
      );

  test(
    'the columns read Proposal, Next up, Working, Done, Merged, Shipped',
    () {
      expect(SwarmBoardColumn.values.map((c) => c.label), [
        'Proposal',
        'Next up',
        'Working',
        'Done',
        'Merged',
        'Shipped',
      ]);
    },
  );

  group('Next up and Working', () {
    test('a task nobody has taken is Next up, with the day it may not start before', () {
      expect(place(task())?.column, SwarmBoardColumn.nextUp);
      expect(place(task())?.state, isNull);
      expect(
        place(task(notBefore: '2026-11-09T00:00:00.000Z'))?.state,
        'not before Nov 9',
      );
    });

    test('a task being worked on is Working, with its pull request when it has one', () {
      expect(place(task(status: 'working'))?.column, SwarmBoardColumn.working);
      expect(place(task(status: 'working', linked: true))?.state, 'PR #12');
    });

    test('a wait on review, changes, a person, a block, a machine or quiet is a mark in Working', () {
      Map<String, String?> marks(Map<String, Map<String, dynamic>> byWait) => {
        for (final MapEntry(:key, :value) in byWait.entries)
          key: place(task(status: 'working', liveness: value))?.state,
      };
      expect(
        marks({
          'review': waiting('review'),
          'revision': waiting('revision'),
          'person': waiting('person', personId: 'ken'),
          'blocked': waiting('blocked'),
          'queued': waiting('queued'),
          'quiet': {'state': 'quiet', 'why': 'x', 'since': 1},
          'orphaned': {'state': 'orphaned', 'why': 'x', 'since': 1},
        }),
        {
          'review': 'in review',
          'revision': 'changes requested',
          'person': 'Ken to decide',
          'blocked': 'blocked',
          'queued': 'waiting for a machine',
          'quiet': 'quiet',
          'orphaned': 'agent lost',
        },
      );
      for (final wait in [waiting('review'), waiting('person')]) {
        expect(
          place(task(status: 'working', liveness: wait))?.column,
          SwarmBoardColumn.working,
        );
      }
    });

    test('a task whose assignment says review, blocked or lost is Working with that mark', () {
      expect(place(task(status: 'review'))?.state, 'in review');
      expect(place(task(status: 'blocked'))?.state, 'blocked');
      expect(place(task(status: 'lost'))?.state, 'agent lost');
      expect(place(task(status: 'needs_human'))?.state, 'someone to decide');
    });

    test(
      'a task that waits on the reader keeps its column and carries the mark',
      () {
        final p = place(task(status: 'needs_human'), needsYou: true);
        expect(p?.column, SwarmBoardColumn.working);
        expect(p?.needsYou, isTrue);
        expect(place(task(status: 'working'))?.needsYou, isFalse);
      },
    );
  });

  group('Done, Merged and Shipped', () {
    test('a task set done with its pull request still to merge is Done with how long it has waited', () {
      final done = task(
        status: 'done',
        linked: true,
        shippedAt: now.subtract(const Duration(minutes: 12)),
      );
      expect(place(done)?.column, SwarmBoardColumn.done);
      expect(place(done)?.state, 'waiting to merge for 12 min');
      expect(
        place(
          task(
            status: 'done',
            linked: true,
            shippedAt: now.subtract(const Duration(minutes: 135)),
          ),
        )?.state,
        'waiting to merge for 2 h 15 min',
      );
      expect(
        place(task(status: 'done', linked: true))?.state,
        'waiting to merge',
      );
    });

    test('a task done with no code to merge stays Done, never Shipped', () {
      final done = task(
        status: 'done',
        shippedAt: now.subtract(const Duration(days: 1)),
      );
      expect(place(done)?.column, SwarmBoardColumn.done);
      expect(place(done)?.state, 'Done');
    });

    test(
      'a merged task still releasing is Merged with the parts it waits for',
      () {
        final merged = task(
          status: 'done',
          merged: true,
          releasing: ['desktop', 'backend'],
        );
        expect(place(merged)?.column, SwarmBoardColumn.merged);
        expect(place(merged)?.state, 'waiting for Desktop, Backend');
        expect(
          place(task(status: 'done', merged: true, releasing: []))?.state,
          'waiting for a release',
        );
      },
    );

    test('a merged task is Merged even when it is already closed', () {
      expect(
        place(
          task(
            status: 'done',
            merged: true,
            releasing: ['cli'],
            archived: true,
          ),
        )?.column,
        SwarmBoardColumn.merged,
      );
    });

    test('a released task is Shipped with its versions, or its pull request when none is recorded', () {
      final shipped = task(
        status: 'done',
        merged: true,
        shippedAt: now.subtract(const Duration(days: 2)),
        releasedTags: ['v1.3.84_desktop', 'v1.4.20_backend'],
      );
      expect(place(shipped)?.column, SwarmBoardColumn.shipped);
      expect(place(shipped)?.state, 'Desktop 1.3.84, Backend 1.4.20');
      expect(
        place(
          task(
            status: 'done',
            merged: true,
            shippedAt: now.subtract(const Duration(days: 2)),
          ),
        )?.state,
        'PR #12',
      );
    });

    test('Shipped keeps seven days; past them the task is not listed', () {
      SuperTabConversation shippedDaysAgo(int days) => task(
        status: 'done',
        merged: true,
        shippedAt: now.subtract(Duration(days: days)),
      );
      expect(place(shippedDaysAgo(7))?.column, SwarmBoardColumn.shipped);
      expect(place(shippedDaysAgo(8)), isNull);
    });
  });

  group('not listed', () {
    test(
      'a cancelled, stopped or closed task that shipped nothing has no place',
      () {
        expect(place(task(status: 'cancelled')), isNull);
        expect(place(task(status: 'stopped')), isNull);
        expect(place(task(status: 'working', archived: true)), isNull);
      },
    );
  });

  group('the board of a project', () {
    SwarmProposal proposal(String id, {String priority = 'P2', int at = 1}) =>
        SwarmProposal.fromJson({
          'messageId': id,
          'title': 'Proposal $id',
          'personId': 'ken',
          'priority': priority,
          'at': at,
        });

    Map<SwarmBoardColumn, List<String>> ids(
      Map<SwarmBoardColumn, List<SwarmBoardEntry>> board,
    ) => {
      for (final MapEntry(:key, :value) in board.entries)
        key: [for (final e in value) e.task?.id ?? e.proposal!.messageId],
    };

    Map<SwarmBoardColumn, List<SwarmBoardEntry>> board(
      List<SuperTabConversation> tasks, {
      List<SwarmProposal> proposals = const [],
      Set<String> waiting = const {},
    }) => swarmBoardOf(tasks, proposals: proposals, waiting: waiting, now: now);

    test('every column is there, in order, empty or not', () {
      expect(board(const []).keys, SwarmBoardColumn.values);
      expect(board(const []).values.every((c) => c.isEmpty), isTrue);
    });

    test('each task is in exactly one column and one that is not listed is in none', () {
      final tasks = [
        task(id: 'next', number: 1),
        task(id: 'work', number: 2, status: 'working'),
        task(id: 'done', number: 3, status: 'done', linked: true),
        task(
          id: 'merged',
          number: 4,
          status: 'done',
          merged: true,
          releasing: [],
        ),
        task(
          id: 'shipped',
          number: 5,
          status: 'done',
          merged: true,
          shippedAt: now.subtract(const Duration(days: 1)),
        ),
        task(id: 'gone', number: 6, status: 'cancelled'),
      ];
      expect(ids(board(tasks, proposals: [proposal('p')])), {
        SwarmBoardColumn.proposal: ['p'],
        SwarmBoardColumn.nextUp: ['next'],
        SwarmBoardColumn.working: ['work'],
        SwarmBoardColumn.done: ['done'],
        SwarmBoardColumn.merged: ['merged'],
        SwarmBoardColumn.shipped: ['shipped'],
      });
    });

    test('a column lists P0 first, then what waits on the reader, then its own order', () {
      final tasks = [
        task(id: 'w1', number: 1, status: 'working'),
        task(id: 'w2', number: 2, status: 'working'),
        task(id: 'w3', number: 3, status: 'working', priority: 'P1'),
        task(id: 'w4', number: 4, status: 'working', priority: 'P0'),
        task(id: 'w5', number: 5, status: 'working', priority: 'P3'),
      ];
      expect(ids(board(tasks, waiting: {'w1'}))[SwarmBoardColumn.working], [
        'w4',
        'w3',
        'w1',
        'w2',
        'w5',
      ]);
    });

    test('Next up keeps the shared queue, Shipped the newest first, proposals the oldest first', () {
      final shipped = [
        for (final (id, days) in [('s1', 5), ('s2', 1), ('s3', 3)])
          task(
            id: id,
            number: 10,
            status: 'done',
            merged: true,
            shippedAt: now.subtract(Duration(days: days)),
          ),
      ];
      final queued = [
        task(id: 'q1', number: 1, queueRank: 30),
        task(id: 'q2', number: 2, queueRank: 10),
        task(id: 'q3', number: 20),
      ];
      final b = ids(
        board(
          [...shipped, ...queued],
          proposals: [proposal('late', at: 9), proposal('early', at: 2)],
        ),
      );
      expect(b[SwarmBoardColumn.shipped], ['s2', 's3', 's1']);
      expect(b[SwarmBoardColumn.nextUp], ['q2', 'q3', 'q1']);
      expect(b[SwarmBoardColumn.proposal], ['early', 'late']);
    });

    test('a proposal lists by its priority too, and one the server gives none reads P2', () {
      final p = SwarmProposal.fromJson({'messageId': 'x', 'at': 1});
      expect(p.priority, 'P2');
      expect(p.title, '');
      expect(
        ids(
          board(
            const [],
            proposals: [
              proposal('a'),
              proposal('b', priority: 'P1'),
            ],
          ),
        )[SwarmBoardColumn.proposal],
        ['b', 'a'],
      );
    });

    test(
      'the cards that wait on the reader are counted, a proposal never is',
      () {
        final b = board(
          [
            task(id: 'a', number: 1, status: 'working'),
            task(id: 'b', number: 2, status: 'working'),
          ],
          proposals: [proposal('p')],
          waiting: {'a'},
        );
        expect(swarmBoardNeedingYou(b), 1);
        expect(
          b[SwarmBoardColumn.working]!
              .firstWhere((e) => e.task!.id == 'a')
              .needsYou,
          isTrue,
        );
      },
    );
  });
}
