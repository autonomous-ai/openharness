import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/task_groups.dart';

import 'support/super_tab_fixture.dart';

final _now = DateTime(2026, 11, 4, 9);
final _pr = 'https://github.com/autonomous-ai/openharness/pull/12';

SuperTabConversation _task({
  String id = 't',
  int number = 1,
  String? status,
  Map<String, dynamic>? liveness,
  bool archived = false,
  bool merged = false,
  bool linked = false,
  DateTime? shippedAt,
  num? queueRank,
  String? notBefore,
}) => SuperTabConversation.fromJson({
  ...conversationFixture(id, 'Task $id'),
  'number': number,
  'archived': archived,
  if (status != null)
    'assignment': {'agentId': 'a1', 'status': status, 'progressAt': 1},
  'liveness': ?liveness,
  if (linked || merged) 'pullRequestUrls': [_pr],
  if (linked || merged)
    'cards': {
      'pullRequests': [
        {'url': _pr, 'messageId': 'm-$id', if (merged) 'mergedAt': 1},
      ],
    },
  if (shippedAt != null) 'shippedAt': shippedAt.millisecondsSinceEpoch,
  'queueRank': ?queueRank,
  'notBefore': ?notBefore,
});

Map<String, dynamic> _waiting(String why, {String? personId}) => {
  'state': 'waiting',
  'why': why,
  'since': 1,
  'personId': ?personId,
};

SuperTabTaskPlace? _place(
  SuperTabConversation task, {
  int mentions = 0,
  int needsHuman = 0,
}) => superTabTaskPlaceOf(
  task,
  readerId: 'me',
  now: _now,
  mentions: mentions,
  needsHuman: needsHuman,
  personName: (id) => const {'ken': 'Ken', 'me': 'Dee'}[id],
);

/// The Tasks view's columns (Dee, task #2569): one function places every task
/// for Board, List and the badge alike.
void main() {
  test('the columns read in the board\'s order', () {
    expect(SuperTabTaskColumn.values.map((c) => c.label), [
      'Proposals',
      'Next up',
      'Working',
      'Waiting',
      'Shipped',
    ]);
  });

  test('every state has its column and caption', () {
    final cases = <(String, SuperTabConversation, int, SuperTabTaskPlace?)>[
      (
        'nobody on it',
        _task(),
        0,
        (column: .nextUp, needsYou: false, state: null),
      ),
      (
        'not before a date',
        _task(notBefore: '2026-12-04'),
        0,
        (column: .nextUp, needsYou: false, state: 'not before Dec 4'),
      ),
      (
        'working',
        _task(status: 'working'),
        0,
        (column: .working, needsYou: false, state: null),
      ),
      (
        'planned',
        _task(status: 'planned'),
        0,
        (column: .working, needsYou: false, state: null),
      ),
      (
        'working with its pull request',
        _task(status: 'working', linked: true),
        0,
        (column: .working, needsYou: false, state: 'PR #12'),
      ),
      (
        'starting its agent',
        _task(status: 'working', liveness: _waiting('starting')),
        0,
        (column: .working, needsYou: false, state: null),
      ),
      (
        'in review',
        _task(status: 'review', liveness: _waiting('review')),
        0,
        (column: .waiting, needsYou: false, state: 'in review'),
      ),
      (
        'changes requested',
        _task(status: 'working', liveness: _waiting('revision')),
        0,
        (column: .waiting, needsYou: false, state: 'changes requested'),
      ),
      (
        'waiting on Ken',
        _task(
          status: 'needs_human',
          liveness: _waiting('person', personId: 'ken'),
        ),
        0,
        (column: .waiting, needsYou: false, state: 'Ken to decide'),
      ),
      (
        'waiting on the reader',
        _task(
          status: 'needs_human',
          liveness: _waiting('person', personId: 'me'),
        ),
        0,
        (column: .waiting, needsYou: true, state: 'Dee to decide'),
      ),
      (
        'needs_human, no one named',
        _task(status: 'needs_human', liveness: _waiting('person')),
        0,
        (column: .waiting, needsYou: true, state: 'someone to decide'),
      ),
      (
        'quiet with a question in its terminal',
        _task(status: 'working', liveness: {'state': 'quiet', 'since': 1}),
        1,
        (column: .waiting, needsYou: true, state: 'quiet'),
      ),
      (
        'quiet',
        _task(status: 'working', liveness: {'state': 'quiet', 'since': 1}),
        0,
        (column: .waiting, needsYou: false, state: 'quiet'),
      ),
      (
        'a question in a working task\'s terminal',
        _task(status: 'working'),
        1,
        (column: .working, needsYou: true, state: null),
      ),
      (
        'its agent lost',
        _task(
          status: 'working',
          liveness: {'state': 'orphaned', 'why': 'lost', 'since': 1},
        ),
        0,
        (column: .waiting, needsYou: false, state: 'agent lost'),
      ),
      (
        'queued for a machine',
        _task(status: 'working', liveness: _waiting('queued')),
        0,
        (column: .waiting, needsYou: false, state: 'waiting for a machine'),
      ),
      (
        'blocked',
        _task(status: 'blocked', liveness: _waiting('blocked')),
        0,
        (column: .waiting, needsYou: false, state: 'blocked'),
      ),
      (
        'done, its pull request not merged',
        _task(
          status: 'done',
          linked: true,
          shippedAt: _now.subtract(const Duration(hours: 1)),
        ),
        0,
        (column: .waiting, needsYou: false, state: 'ready to merge'),
      ),
      (
        'finished with no pull request',
        _task(
          status: 'done',
          shippedAt: _now.subtract(const Duration(hours: 1)),
        ),
        0,
        (column: .shipped, needsYou: false, state: 'Done'),
      ),
      (
        'merged 2 days ago, archived',
        _task(
          status: 'done',
          merged: true,
          archived: true,
          shippedAt: _now.subtract(const Duration(days: 2)),
        ),
        0,
        (column: .shipped, needsYou: false, state: 'PR #12'),
      ),
      (
        'merged 8 days ago',
        _task(
          status: 'done',
          merged: true,
          archived: true,
          shippedAt: _now.subtract(const Duration(days: 8)),
        ),
        0,
        null,
      ),
      ('cancelled', _task(status: 'cancelled'), 0, null),
      ('stopped', _task(status: 'stopped'), 0, null),
      (
        'closed without shipping',
        _task(status: 'working', archived: true),
        0,
        null,
      ),
    ];
    for (final (name, task, needsHuman, expected) in cases) {
      expect(_place(task, needsHuman: needsHuman), expected, reason: name);
    }
  });

  test('a tag of the reader marks the task in its own column', () {
    expect(_place(_task(), mentions: 1), (
      column: SuperTabTaskColumn.nextUp,
      needsYou: true,
      state: null,
    ));
    expect(
      _place(
        _task(
          status: 'done',
          merged: true,
          shippedAt: _now.subtract(const Duration(days: 1)),
        ),
        mentions: 1,
      ),
      (column: SuperTabTaskColumn.shipped, needsYou: true, state: 'PR #12'),
    );
  });

  group('the board', () {
    Map<SuperTabTaskColumn, List<String>> ids(
      Iterable<SuperTabConversation> tasks, {
      Iterable<SuperTabProposal> proposals = const [],
      Set<String> tagged = const {},
    }) => {
      for (final MapEntry(:key, :value) in superTabTaskBoard(
        tasks,
        proposals: proposals,
        readerId: 'me',
        now: _now,
        mentions: (t) => tagged.contains(t.id) ? 1 : 0,
      ).entries)
        key: [for (final e in value) e.task?.id ?? e.proposal!.messageId],
    };

    test('every column is there, empty or not', () {
      expect(ids(const []).keys, SuperTabTaskColumn.values);
      expect(ids(const []).values.every((c) => c.isEmpty), isTrue);
    });

    test('Next up keeps the shared order; a new task joins the bottom', () {
      final board = ids([
        _task(id: 'new', number: 30),
        _task(id: 'third', number: 10, queueRank: 25.5),
        _task(id: 'first', number: 20, queueRank: 1),
        _task(id: 'second', number: 5),
      ]);
      expect(board[SuperTabTaskColumn.nextUp], [
        'first',
        'second',
        'third',
        'new',
      ]);
    });

    test('a task that needs the reader comes first in its column', () {
      final board = ids(
        [
          _task(id: 'a', number: 1, status: 'working'),
          _task(id: 'b', number: 2, status: 'working'),
          _task(id: 'c', number: 3, status: 'working'),
        ],
        tagged: {'a'},
      );
      expect(board[SuperTabTaskColumn.working], ['a', 'c', 'b']);
    });

    test('Shipped is newest first; Proposals oldest first', () {
      final board = ids(
        [
          _task(
            id: 'old',
            status: 'done',
            merged: true,
            shippedAt: _now.subtract(const Duration(days: 3)),
          ),
          _task(
            id: 'new',
            status: 'done',
            shippedAt: _now.subtract(const Duration(hours: 3)),
          ),
        ],
        proposals: [
          SuperTabProposal.fromJson({
            'messageId': 'p2',
            'title': 'Later',
            'at': _now.millisecondsSinceEpoch,
          }),
          SuperTabProposal.fromJson({
            'messageId': 'p1',
            'title': 'Earlier',
            'personId': 'scholes',
            'at': _now.subtract(const Duration(days: 9)).millisecondsSinceEpoch,
          }),
        ],
      );
      expect(board[SuperTabTaskColumn.shipped], ['new', 'old']);
      expect(board[SuperTabTaskColumn.proposals], ['p1', 'p2']);
    });

    test('the badge counts the tasks that need the reader', () {
      final board = superTabTaskBoard(
        [
          _task(id: 'a', status: 'working'),
          _task(
            id: 'b',
            status: 'needs_human',
            liveness: _waiting('person', personId: 'me'),
          ),
          _task(id: 'c'),
          _task(id: 'gone', status: 'cancelled'),
        ],
        readerId: 'me',
        now: _now,
        mentions: (t) => t.id == 'c' || t.id == 'gone' ? 1 : 0,
      );
      expect(superTabTasksNeedingYouIn(board), 2);
    });
  });
}
