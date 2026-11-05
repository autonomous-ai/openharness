import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/member_groups.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/tasks_view.dart';

import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

final _now = DateTime(2026, 11, 5, 9);
int _ago(Duration d) => _now.subtract(d).millisecondsSinceEpoch;

Map<String, dynamic> _task(
  String id,
  String title,
  int number, {
  String? lane,
  String? status,
  String? agent,
  String? priority,
  String? notBefore,
  int? lostAt,
  int? orphanedSince,
  bool archived = false,
}) => {
  ...conversationFixture(id, title),
  'projectId': 'lead',
  'number': number,
  'brief': 'Do it',
  'task': {'goal': title, 'changes': '', 'constraints': '', 'owns': <String>[]},
  'archived': archived,
  'priority': ?priority,
  'notBefore': ?notBefore,
  // Absent on a task from an older server; null when no lane owns it.
  'handOutLane': ?lane,
  if (status != null)
    'assignment': {
      'id': 'as-$id',
      'agentId': agent,
      'status': status,
      'progressAt': 1,
      if (lostAt != null) 'lost': {'at': lostAt, 'reason': 'agent lost'},
    },
  if (orphanedSince != null)
    'liveness': {'state': 'orphaned', 'since': orphanedSince},
};

Map<String, dynamic> _agent(
  String id,
  String name, {
  String? displayName,
  Map<String, dynamic>? crew,
}) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'displayName': ?displayName,
  'machineId': 'studio',
  'harnessId': 'h-$id',
  'contributorId': 'owner',
  'configuration': {'engine': 'claude'},
  'crew': ?crew,
};

/// A project with four crew members (Desktop, backend, docs with three tasks
/// handed over, and one with no lane), an agent that is not crew, and the
/// open tasks nobody holds: two lost, one P0, one not before tomorrow, one no
/// lane owns. With [lanes] off, the server is one from before hand-out lanes.
ConversationServer _server({bool lanes = true}) {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
  server.state['people'] = [
    {'id': 'owner', 'email': 'dee@example.com', 'role': 'owner'},
  ];
  server.state['agents'] = [
    _agent(
      'finch',
      'Engineer',
      displayName: 'Finch2',
      crew: {'role': 'Engineer', 'lane': 'Desktop', 'at': 1, 'by': 'owner'},
    ),
    _agent(
      'heron',
      'Heron',
      crew: {'role': 'Engineer', 'lane': 'backend', 'at': 1, 'by': 'owner'},
    ),
    _agent(
      'robin',
      'Robin',
      crew: {'role': 'Engineer', 'at': 1, 'by': 'owner'},
    ),
    _agent(
      'wren',
      'Wren',
      crew: {'role': 'Engineer', 'lane': 'docs', 'at': 1, 'by': 'owner'},
    ),
    _agent('plover', 'Plover'),
  ];
  String? lane(String name) => lanes ? name : null;
  Map<String, dynamic> task(
    String id,
    String title,
    int number, {
    String? lane,
    String? status,
    String? agent,
    String? priority,
    String? notBefore,
    int? lostAt,
    int? orphanedSince,
    bool archived = false,
  }) {
    final t = _task(
      id,
      title,
      number,
      lane: lane,
      status: status,
      agent: agent,
      priority: priority,
      notBefore: notBefore,
      lostAt: lostAt,
      orphanedSince: orphanedSince,
      archived: archived,
    );
    // A lane no table owns is null on a newer server, absent on an older.
    if (lanes && lane == null) t['handOutLane'] = null;
    return t;
  }

  (server.state['conversations'] as List)
    ..removeWhere((g) => (g as Map)['id'] == 'offline')
    ..addAll(<Map<String, dynamic>>[
      task(
        'd-work',
        'Members on the board',
        30,
        lane: lane('Desktop'),
        status: 'working',
        agent: 'finch',
      ),
      task(
        'd-hand',
        'Lane line',
        31,
        lane: lane('Desktop'),
        status: 'review',
        agent: 'finch',
      ),
      task(
        'b-block',
        'Dispatch pass',
        32,
        lane: lane('backend'),
        status: 'blocked',
        agent: 'heron',
      ),
      task(
        'p-work',
        'Not crew work',
        33,
        lane: lane('backend'),
        status: 'working',
        agent: 'plover',
      ),
      for (final n in [1, 2, 3])
        task(
          'w-h$n',
          'Guide part $n',
          40 + n,
          lane: lane('docs'),
          status: 'review',
          agent: 'wren',
        ),
      task('b-early', 'Pass log', 20, lane: lane('backend')),
      task('u1', 'Tray icon', 21, lane: lane('Desktop')),
      task(
        'u-orph',
        'Sidebar order',
        23,
        lane: lane('Desktop'),
        status: 'lost',
        agent: 'finch',
        lostAt: _ago(const Duration(minutes: 30)),
        orphanedSince: _ago(const Duration(hours: 2, minutes: 10)),
      ),
      task(
        'u4',
        'Pick check',
        24,
        lane: lane('backend'),
        status: 'lost',
        agent: 'heron',
        lostAt: _ago(const Duration(hours: 2, minutes: 40)),
      ),
      task('u5', 'Nobody owns it', 25),
      task(
        'd-urgent',
        'Crash on open',
        26,
        lane: lane('Desktop'),
        priority: 'P0',
      ),
      task(
        'tomorrow',
        'Later work',
        27,
        lane: lane('Desktop'),
        notBefore: '2026-11-06',
      ),
      task(
        'd-done',
        'Ready to merge',
        28,
        lane: lane('Desktop'),
        status: 'done',
        agent: 'finch',
      ),
      task('d-archived', 'Put away', 29, lane: lane('Desktop'), archived: true),
    ]);
  return server;
}

const _line =
    'backend: 2 waiting, 2 busy, oldest 2 h · '
    'Desktop: 3 waiting, 2 busy, oldest 2 h · '
    'docs: 0 waiting, 3 busy';
const _handOut = [
  'd-urgent',
  'b-early',
  'u1',
  'u-orph',
  'u4',
  'u5',
  'tomorrow',
];

Finder _member(String id) => find.byKey(ValueKey('super-tasks-member-$id'));
Finder _unassigned() => find.byKey(const ValueKey('super-tasks-unassigned'));
Finder _card(String id) => find.byKey(ValueKey('super-task-card-$id'));
final _capacity = find.byKey(const ValueKey('super-tasks-capacity'));
final _members = find.byKey(const ValueKey('super-tasks-layout-members'));

Future<SuperTabController> _show(
  WidgetTester tester,
  ConversationServer server, {
  MemoryKeyValueStore? storage,
  List<String>? opened,
  bool members = true,
}) async {
  await tester.binding.setSurfaceSize(const Size(1900, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: Scaffold(
        body: SuperTabTasksView(
          controller: c,
          project: c.snapshot!.projects.single,
          storage: storage ?? MemoryKeyValueStore(),
          needsHuman: (_) => 0,
          onOpenTask: (id) => opened?.add(id),
          onOpenProposal: (_) {},
          now: () => _now,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  if (members) {
    await tester.tap(_members);
    await tester.pumpAndSettle();
  }
  return c;
}

Future<void> _close(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

/// The cards and the texts [names] in [column], top to bottom.
List<String> _top(
  WidgetTester tester,
  Finder column, {
  Set<String> names = const {},
}) {
  final found = [
    for (final e
        in find
            .descendant(
              of: column,
              matching: find.byWidgetPredicate(
                (w) =>
                    w.key is ValueKey<String> &&
                        (w.key as ValueKey<String>).value.startsWith(
                          'super-task-card-',
                        ) ||
                    w is Text && names.contains(w.data),
              ),
            )
            .evaluate())
      (
        switch (e.widget) {
          Text(:final data) => data!,
          final w => (w.key as ValueKey<String>).value.substring(
            'super-task-card-'.length,
          ),
        },
        tester.getTopLeft(find.byWidget(e.widget)).dy,
      ),
  ]..sort((a, b) => a.$2.compareTo(b.$2));
  return [for (final (id, _) in found) id];
}

Finder _text(Finder of, String text) =>
    find.descendant(of: of, matching: find.text(text));

Finder _containing(Finder of, String text) =>
    find.descendant(of: of, matching: find.textContaining(text));

/// The board's Group by Member (task #3400): a column per crew member with
/// its lane, what it holds and what it handed over, then Unassigned in the
/// order the Swarm hands work out, under one line of lane capacity worked out
/// from the tasks the app holds.
void main() {
  testWidgets('the Tasks view still opens on the Board', (tester) async {
    final c = await _show(tester, _server(), members: false);
    expect(find.byKey(const ValueKey('super-tasks-board')), findsOneWidget);
    expect(_members, findsOneWidget);
    expect(_member('finch'), findsNothing);
    expect(_unassigned(), findsNothing);
    final pills = [
      for (final key in ['board', 'list', 'members'])
        tester.getTopLeft(find.byKey(ValueKey('super-tasks-layout-$key'))).dx,
    ];
    expect(pills, orderedEquals([...pills]..sort()));
    expect(
      tester.getTopLeft(_members).dx,
      lessThan(
        tester.getTopLeft(find.byKey(const ValueKey('super-tasks-mine'))).dx,
      ),
    );
    await _close(tester, c);
  });

  testWidgets('Members lists each crew member with its lane, what it holds, '
      'then what it handed over', (tester) async {
    final c = await _show(tester, _server());
    expect(find.byKey(const ValueKey('super-tasks-board')), findsNothing);

    expect(_text(_member('finch'), 'Finch2 · Desktop'), findsOneWidget);
    expect(_text(_member('finch'), 'Working'), findsOneWidget);
    expect(_top(tester, _member('finch'), names: {'handed:'}), [
      'd-work',
      'handed:',
      'd-hand',
    ]);

    expect(_text(_member('heron'), 'Heron · backend'), findsOneWidget);
    expect(_text(_member('heron'), 'Working'), findsOneWidget);
    expect(_top(tester, _member('heron'), names: {'handed:'}), ['b-block']);

    // No lane: its name alone; nothing in its hands: Free.
    expect(_text(_member('robin'), 'Robin'), findsOneWidget);
    expect(_text(_member('robin'), 'Free'), findsOneWidget);
    expect(_top(tester, _member('robin')), isEmpty);

    // Three handed over and nothing in its hands: Full, not Free.
    expect(_text(_member('wren'), 'Wren · docs'), findsOneWidget);
    expect(_text(_member('wren'), 'Full'), findsOneWidget);
    expect(_text(_member('wren'), 'Free'), findsNothing);
    expect(_top(tester, _member('wren'), names: {'handed:'}), [
      'handed:',
      'w-h1',
      'w-h2',
      'w-h3',
    ]);

    // An agent that is not crew gets no column, and its task is not
    // anybody's to take.
    expect(_member('plover'), findsNothing);
    expect(_card('p-work'), findsNothing);

    // Members in roster order, Unassigned last.
    final lefts = [
      for (final f in [
        _member('finch'),
        _member('heron'),
        _member('robin'),
        _member('wren'),
        _unassigned(),
      ])
        tester.getTopLeft(f).dx,
    ];
    expect(lefts, orderedEquals([...lefts]..sort()));
    await _close(tester, c);
  });

  testWidgets('Unassigned goes in the Swarm\'s hand-out order, P0 first, each '
      'card with its lane and priority', (tester) async {
    final c = await _show(tester, _server());
    expect(_text(_unassigned(), 'Unassigned'), findsOneWidget);
    expect(_text(_unassigned(), '${_handOut.length}'), findsOneWidget);
    // The P0 Desktop task goes before the earlier backend P2 one; then the
    // shared queue, lanes not interleaved. Done, archived and held work is
    // nobody's to take.
    expect(_top(tester, _unassigned()), _handOut);
    expect(_text(_card('d-urgent'), 'Desktop'), findsOneWidget);
    expect(_text(_card('d-urgent'), 'P0'), findsOneWidget);
    expect(_text(_card('b-early'), 'backend'), findsOneWidget);
    expect(_text(_card('b-early'), 'P2'), findsOneWidget);
    expect(_text(_card('u1'), 'Desktop'), findsOneWidget);
    for (final lane in ['Desktop', 'backend', 'docs']) {
      expect(_containing(_card('u5'), lane), findsNothing, reason: lane);
    }
    await _close(tester, c);
  });

  testWidgets('the lanes\' capacity, worked out from the tasks, reads as one '
      'line above the columns', (tester) async {
    final c = await _show(tester, _server());
    // Not before tomorrow, done and archived tasks wait in no lane.
    expect(tester.widget<Text>(_capacity).data, _line);
    expect(
      tester.widget<Text>(_capacity).style?.color,
      grid.AppPalette.textSecondary,
    );
    expect(
      tester.getBottomLeft(_capacity).dy,
      lessThanOrEqualTo(tester.getTopLeft(_member('finch')).dy),
    );
    await _close(tester, c);
  });

  testWidgets('a change to one task moves the line and the member', (
    tester,
  ) async {
    final server = _server();
    final c = await _show(tester, server);
    expect(_text(_member('robin'), 'Free'), findsOneWidget);
    final u1 = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'u1');
    u1['assignment'] = {
      'id': 'as-u1',
      'agentId': 'robin',
      'status': 'working',
      'progressAt': 1,
    };
    await c.refresh();
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(_capacity).data,
      'backend: 2 waiting, 2 busy, oldest 2 h · '
      'Desktop: 2 waiting, 3 busy, oldest 2 h · '
      'docs: 0 waiting, 3 busy',
    );
    expect(_text(_member('robin'), 'Working'), findsOneWidget);
    expect(_top(tester, _member('robin')), ['u1']);
    expect(_top(tester, _unassigned()), isNot(contains('u1')));
    await _close(tester, c);
  });

  testWidgets('Search hides cards, never a member\'s state', (tester) async {
    final c = await _show(tester, _server());
    await tester.enterText(
      find.byKey(const ValueKey('super-tasks-search')),
      'Lane line',
    );
    await tester.pumpAndSettle();
    // Its in-hand task is hidden; it still holds it.
    expect(_card('d-work'), findsNothing);
    expect(_top(tester, _member('finch'), names: {'handed:'}), [
      'handed:',
      'd-hand',
    ]);
    expect(_text(_member('finch'), 'Working'), findsOneWidget);
    expect(_top(tester, _member('heron')), isEmpty);
    expect(_text(_member('heron'), 'Working'), findsOneWidget);
    expect(_top(tester, _member('wren')), isEmpty);
    expect(_text(_member('wren'), 'Full'), findsOneWidget);
    // The lanes count every task too.
    expect(tester.widget<Text>(_capacity).data, _line);
    await _close(tester, c);
  });

  testWidgets('a card opens its task as the Board\'s do', (tester) async {
    final opened = <String>[];
    final c = await _show(tester, _server(), opened: opened);
    await tester.tap(_card('u1'));
    await tester.tap(_card('d-hand'));
    expect(opened, ['u1', 'd-hand']);
    await _close(tester, c);
  });

  testWidgets('an older server without hand-out lanes: Unassigned in the same '
      'order without lanes, and no lane line', (tester) async {
    final c = await _show(tester, _server(lanes: false));
    expect(_capacity, findsNothing);
    expect(_text(_member('finch'), 'Finch2 · Desktop'), findsOneWidget);
    expect(_top(tester, _unassigned()), _handOut);
    for (final id in _handOut) {
      for (final lane in ['Desktop', 'backend', 'docs']) {
        expect(_containing(_card(id), lane), findsNothing, reason: '$id $lane');
      }
    }
    expect(tester.takeException(), isNull);
    await _close(tester, c);
  });

  testWidgets('Members is remembered for the reader on this Mac', (
    tester,
  ) async {
    final storage = MemoryKeyValueStore();
    var c = await _show(tester, _server(), storage: storage);
    await _close(tester, c);
    c = await _show(tester, _server(), storage: storage, members: false);
    expect(_member('finch'), findsOneWidget);
    expect(find.byKey(const ValueKey('super-tasks-board')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-board')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-tasks-board')), findsOneWidget);
    await _close(tester, c);
  });

  group('superTabLaneCapacity', () {
    SuperTabConversation task(
      String id,
      String? lane, {
      String? status,
      String? notBefore,
    }) => SuperTabConversation.fromJson(
      _task(
        id,
        id,
        1,
        lane: lane,
        status: status,
        agent: 'finch',
        notBefore: notBefore,
      ),
    );

    test('lanes in the table\'s order, only those with work', () {
      final lanes = superTabLaneCapacity([
        task('a', 'docs'),
        task('b', 'Desktop', status: 'planned'),
        task('c', 'backend', status: 'reconciling'),
        task('d', 'mobile', status: 'done'),
        task('e', 'CLI', status: 'cancelled'),
        task('f', 'Desktop', notBefore: '2026-11-05'),
        task('g', null),
      ], _now);
      expect(
        [for (final l in lanes) (l.lane, l.waiting, l.busy, l.oldestAt)],
        [
          ('backend', 0, 1, null),
          ('Desktop', 1, 1, null),
          ('docs', 1, 0, null),
        ],
      );
    });
  });

  group('superTabCapacityLine', () {
    SuperTabLaneCapacity lane(String name, Duration? age) =>
        SuperTabLaneCapacity(
          lane: name,
          waiting: 3,
          busy: 1,
          oldestAt: age == null ? null : _now.subtract(age),
        );

    test('whole hours, rounded down', () {
      expect(
        superTabCapacityLine([
          lane('Desktop', const Duration(hours: 5, minutes: 59)),
        ], _now),
        'Desktop: 3 waiting, 1 busy, oldest 5 h',
      );
    });

    test('minutes under an hour, and no oldest when none was recorded', () {
      expect(
        superTabCapacityLine([
          lane('CLI', const Duration(minutes: 45)),
          lane('docs', null),
        ], _now),
        'CLI: 3 waiting, 1 busy, oldest 45 min · docs: 3 waiting, 1 busy',
      );
    });

    test('no lanes, no line', () {
      expect(superTabCapacityLine(const [], _now), isNull);
    });
  });

  test('a task reads its hand-out lane, and none from an older server', () {
    expect(
      SuperTabConversation.fromJson(_task('t', 'T', 1, lane: 'Desktop'))
          .handOutLane,
      'Desktop',
    );
    expect(SuperTabConversation.fromJson(_task('t', 'T', 1)).handOutLane, null);
  });

  test('an agent record reads its crew, and none from an older server', () {
    final crew = SuperTabAgent.fromJson(
      _agent(
        'finch',
        'Engineer',
        crew: {'role': 'Engineer', 'lane': 'Desktop', 'at': 5, 'by': 'owner'},
      ),
    ).crew!;
    expect((crew.role, crew.lane, crew.by), ('Engineer', 'Desktop', 'owner'));
    expect(SuperTabAgent.fromJson(_agent('plover', 'Plover')).crew, isNull);
    expect(
      SuperTabAgent.fromJson({..._agent('odd', 'Odd'), 'crew': 'yes'}).crew,
      isNull,
    );
  });
}
