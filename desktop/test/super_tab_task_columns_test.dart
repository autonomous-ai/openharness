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
  Map<String, String>? checks,
  String? alsoLinked,
}) => SuperTabConversation.fromJson({
  ...conversationFixture(id, 'Task $id'),
  'number': number,
  'archived': archived,
  if (status != null)
    'assignment': {'agentId': 'a1', 'status': status, 'progressAt': 1},
  'liveness': ?liveness,
  if (linked || merged) 'pullRequestUrls': [_pr, ?alsoLinked],
  if (linked || merged)
    'cards': {
      'pullRequests': [
        {'url': _pr, 'messageId': 'm-$id', if (merged) 'mergedAt': 1},
      ],
    },
  if (shippedAt != null) 'shippedAt': shippedAt.millisecondsSinceEpoch,
  'queueRank': ?queueRank,
  'notBefore': ?notBefore,
  'pullRequestChecks': ?checks,
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
  Map<String, int> releaseTimes = const {},
}) => superTabTaskPlaceOf(
  task,
  readerId: 'me',
  now: _now,
  mentions: mentions,
  needsHuman: needsHuman,
  releaseTimes: releaseTimes,
  personName: (id) => const {'ken': 'Ken', 'me': 'Dee'}[id],
);

/// The Tasks view's columns (Dee, task #2569): one function places every task
/// for Board, List and the badge alike.
void main() {
  test('the columns read in the board\'s order', () {
    expect(SuperTabTaskColumn.values.map((c) => c.label), [
      'Proposal',
      'Next up',
      'Working',
      'Done',
      'Merged',
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
        (column: .working, needsYou: false, state: 'in review'),
      ),
      (
        'changes requested',
        _task(status: 'working', liveness: _waiting('revision')),
        0,
        (column: .working, needsYou: false, state: 'changes requested'),
      ),
      (
        'waiting on Ken',
        _task(
          status: 'needs_human',
          liveness: _waiting('person', personId: 'ken'),
        ),
        0,
        (column: .working, needsYou: false, state: 'Ken to decide'),
      ),
      (
        'waiting on the reader',
        _task(
          status: 'needs_human',
          liveness: _waiting('person', personId: 'me'),
        ),
        0,
        (column: .working, needsYou: true, state: 'Dee to decide'),
      ),
      (
        'needs_human, no one named',
        _task(status: 'needs_human', liveness: _waiting('person')),
        0,
        (column: .working, needsYou: true, state: 'someone to decide'),
      ),
      (
        'quiet with a question in its terminal',
        _task(status: 'working', liveness: {'state': 'quiet', 'since': 1}),
        1,
        (column: .working, needsYou: true, state: 'quiet'),
      ),
      (
        'quiet',
        _task(status: 'working', liveness: {'state': 'quiet', 'since': 1}),
        0,
        (column: .working, needsYou: false, state: 'quiet'),
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
        (column: .working, needsYou: false, state: 'agent lost'),
      ),
      (
        'queued for a machine',
        _task(status: 'working', liveness: _waiting('queued')),
        0,
        (column: .working, needsYou: false, state: 'waiting for a machine'),
      ),
      (
        'blocked',
        _task(status: 'blocked', liveness: _waiting('blocked')),
        0,
        (column: .working, needsYou: false, state: 'blocked'),
      ),
      (
        'done, its pull request not merged',
        _task(
          status: 'done',
          linked: true,
          shippedAt: _now.subtract(const Duration(minutes: 12)),
        ),
        0,
        (column: .done, needsYou: false, state: 'waiting to merge for 12 min'),
      ),
      (
        'done 90 minutes ago, still not merged',
        _task(
          status: 'done',
          linked: true,
          shippedAt: _now.subtract(const Duration(minutes: 90)),
        ),
        0,
        (
          column: .done,
          needsYou: false,
          state: 'waiting to merge for 1 h 30 min',
        ),
      ),
      (
        'done, its first Done not known',
        _task(status: 'done', linked: true),
        0,
        (column: .done, needsYou: false, state: 'waiting to merge'),
      ),
      (
        'finished with no pull request',
        _task(
          status: 'done',
          shippedAt: _now.subtract(const Duration(hours: 1)),
        ),
        0,
        (column: .done, needsYou: false, state: 'Done'),
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

  // Task #3827: the server records each linked pull request's check state and each component's next release time.
  group('what the server says of checks and releases', () {
    SuperTabConversation done(Map<String, String> checks, {int minutes = 12}) =>
        _task(
          status: 'done',
          linked: true,
          checks: checks,
          shippedAt: _now.subtract(Duration(minutes: minutes)),
        );

    test('a done task says its checks and how long it has waited', () {
      expect(_place(done({_pr: 'green'}))!.state, 'green, waiting 12 min');
      expect(
        _place(done({_pr: 'running'}))!.state,
        'CI running, waiting 12 min',
      );
      expect(
        _place(done({_pr: 'green'}, minutes: 90))!.state,
        'green, waiting 1 h 30 min',
      );
      expect(_place(done({_pr: 'green'}))!.column, SuperTabTaskColumn.done);
    });

    test('a done task with no state recorded reads as before', () {
      expect(_place(done({}))!.state, 'waiting to merge for 12 min');
      expect(
        _place(done({'https://github.com/acme/app/pull/99': 'green'}))!.state,
        'waiting to merge for 12 min',
      );
    });

    test('red checks put a done task back in Working, as CI red', () {
      expect(_place(done({_pr: 'red'})), (
        column: SuperTabTaskColumn.working,
        needsYou: false,
        state: 'CI red',
      ));
    });

    test('the worst state of its pull requests is the task\'s', () {
      final two = _task(
        status: 'done',
        linked: true,
        alsoLinked: 'https://github.com/acme/app/pull/13',
        checks: {
          _pr: 'green',
          'https://github.com/acme/app/pull/13': 'running',
        },
        shippedAt: _now.subtract(const Duration(minutes: 5)),
      );
      expect(_place(two)!.state, 'CI running, waiting 5 min');
    });

    SuperTabConversation releasing(List<String> parts) =>
        SuperTabConversation.fromJson({
          ...conversationFixture('t', 'Task t'),
          'assignment': {'agentId': 'a1', 'status': 'done'},
          'releasing': parts,
        });
    int at(int day, int hour, [int minute = 0]) =>
        DateTime(2026, 11, day, hour, minute).millisecondsSinceEpoch;

    test(
      'a merged task says when the next release is due, in the reader\'s time',
      () {
        final times = {'desktop': at(4, 15, 30), 'cli': at(4, 15, 30)};
        expect(
          _place(releasing(['desktop', 'cli']), releaseTimes: times)!.state,
          'waiting for Desktop, CLI · next release about 15:30',
        );
        expect(
          _place(releasing(['desktop']), releaseTimes: times)!.column,
          SuperTabTaskColumn.merged,
        );
      },
    );

    test(
      'it names the earliest of the parts it waits for, and now as due now',
      () {
        final times = {'desktop': at(4, 15, 30), 'cli': at(4, 11)};
        expect(
          _place(releasing(['desktop', 'cli']), releaseTimes: times)!.state,
          'waiting for Desktop, CLI · next release about 11:00',
        );
        expect(
          _place(releasing(['desktop']), releaseTimes: {'desktop': 0})!.state,
          'waiting for Desktop · next release due now',
        );
      },
    );

    test('tomorrow and later days say so', () {
      expect(
        _place(
          releasing(['backend']),
          releaseTimes: {'backend': at(5, 9)},
        )!.state,
        'waiting for Backend · next release about 09:00 tomorrow',
      );
      expect(
        _place(
          releasing(['backend']),
          releaseTimes: {'backend': at(9, 9)},
        )!.state,
        'waiting for Backend · next release about 09:00 Nov 9',
      );
    });

    test('no time for its parts, or none known, reads as before', () {
      expect(_place(releasing(['desktop']))!.state, 'waiting for Desktop');
      expect(
        _place(releasing(['desktop']), releaseTimes: {'cli': at(4, 15)})!.state,
        'waiting for Desktop',
      );
      expect(
        _place(releasing([]), releaseTimes: {'desktop': at(4, 15)})!.state,
        'waiting for a release',
      );
    });
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
            merged: true,
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
