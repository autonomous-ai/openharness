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

Map<String, dynamic> _task(
  String id,
  String title,
  int number, {
  String? status,
  String? agent,
  String? priority,
}) => {
  ...conversationFixture(id, title),
  'projectId': 'lead',
  'number': number,
  'brief': 'Do it',
  'priority': ?priority,
  if (status != null)
    'assignment': {
      'id': 'as-$id',
      'agentId': agent,
      'status': status,
      'progressAt': 1,
    },
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

/// A project with three crew members (Desktop, backend, and one with no lane),
/// an agent that is not crew, and five open tasks nobody has, one of them lost
/// by its agent; the server's lanes order four of them.
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
    _agent('plover', 'Plover'),
  ];
  (server.state['conversations'] as List)
    ..removeWhere((g) => (g as Map)['id'] == 'offline')
    ..addAll(<Map<String, dynamic>>[
      _task(
        'd-work',
        'Members on the board',
        30,
        status: 'working',
        agent: 'finch',
      ),
      _task('d-hand', 'Lane line', 31, status: 'review', agent: 'finch'),
      _task('b-block', 'Dispatch pass', 32, status: 'blocked', agent: 'heron'),
      _task('p-work', 'Not crew work', 33, status: 'working', agent: 'plover'),
      _task('u1', 'Desktop second', 21),
      _task('u2', 'Desktop first', 22),
      _task('u3', 'Backend first', 23, priority: 'P1'),
      _task('u4', 'Backend second', 24, status: 'lost', agent: 'heron'),
      _task('u5', 'Nobody ordered it', 25),
    ]);
  if (lanes) {
    server.state['lanes'] = {
      'lead': [
        {
          'lane': 'backend',
          'waiting': 4,
          'busy': 2,
          'oldestAt': _now
              .subtract(const Duration(hours: 2, minutes: 40))
              .millisecondsSinceEpoch,
          'taskIds': ['u3', 'u4'],
        },
        {
          'lane': 'Desktop',
          'waiting': 6,
          'busy': 2,
          'oldestAt': _now
              .subtract(const Duration(hours: 2))
              .millisecondsSinceEpoch,
          'taskIds': ['u2', 'u1'],
        },
      ],
    };
  }
  return server;
}

Finder _member(String id) => find.byKey(ValueKey('super-tasks-member-$id'));
Finder _unassigned() => find.byKey(const ValueKey('super-tasks-unassigned'));
Finder _card(String id) => find.byKey(ValueKey('super-task-card-$id'));
final _members = find.byKey(const ValueKey('super-tasks-layout-members'));

Future<SuperTabController> _show(
  WidgetTester tester,
  ConversationServer server, {
  MemoryKeyValueStore? storage,
  List<String>? opened,
}) async {
  await tester.binding.setSurfaceSize(const Size(1600, 900));
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

/// The board's Group by Member (task #3400): a column per crew member with
/// its lane, what it holds and what it handed over, then Unassigned in the
/// order the server hands work out, under one line of lane capacity.
void main() {
  testWidgets('the Tasks view still opens on the Board', (tester) async {
    final c = await _show(tester, _server());
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
    await tester.tap(_members);
    await tester.pumpAndSettle();
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
        _unassigned(),
      ])
        tester.getTopLeft(f).dx,
    ];
    expect(lefts, orderedEquals([...lefts]..sort()));
    await _close(tester, c);
  });

  testWidgets('Unassigned goes in the order the lanes hand work out, each card '
      'with its lane and priority', (tester) async {
    final c = await _show(tester, _server());
    await tester.tap(_members);
    await tester.pumpAndSettle();
    expect(_text(_unassigned(), 'Unassigned'), findsOneWidget);
    expect(_text(_unassigned(), '5'), findsOneWidget);
    // The lanes' first tasks, then their second ones, then one no lane lists.
    expect(_top(tester, _unassigned()), ['u3', 'u2', 'u4', 'u1', 'u5']);
    expect(_text(_card('u3'), 'backend'), findsOneWidget);
    expect(_text(_card('u3'), 'P1'), findsOneWidget);
    expect(_text(_card('u2'), 'Desktop'), findsOneWidget);
    expect(_text(_card('u2'), 'P2'), findsOneWidget);
    expect(_text(_card('u1'), 'Desktop'), findsOneWidget);
    expect(
      find.descendant(
        of: _card('u5'),
        matching: find.textContaining('Desktop'),
      ),
      findsNothing,
    );
    await _close(tester, c);
  });

  testWidgets('the lanes\' capacity reads as one line above the columns', (
    tester,
  ) async {
    final c = await _show(tester, _server());
    await tester.tap(_members);
    await tester.pumpAndSettle();
    final line = find.byKey(const ValueKey('super-tasks-capacity'));
    expect(
      tester.widget<Text>(line).data,
      'backend: 4 waiting, 2 busy, oldest 2 h · '
      'Desktop: 6 waiting, 2 busy, oldest 2 h',
    );
    expect(
      tester.widget<Text>(line).style?.color,
      grid.AppPalette.textSecondary,
    );
    expect(
      tester.getBottomLeft(line).dy,
      lessThanOrEqualTo(tester.getTopLeft(_member('finch')).dy),
    );
    await _close(tester, c);
  });

  testWidgets('a card opens its task as the Board\'s do', (tester) async {
    final opened = <String>[];
    final c = await _show(tester, _server(), opened: opened);
    await tester.tap(_members);
    await tester.pumpAndSettle();
    await tester.tap(_card('u3'));
    await tester.tap(_card('d-hand'));
    expect(opened, ['u3', 'd-hand']);
    await _close(tester, c);
  });

  testWidgets('a server without lanes: Unassigned in the board\'s order, no '
      'lane lines', (tester) async {
    final c = await _show(tester, _server(lanes: false));
    await tester.tap(_members);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-tasks-capacity')), findsNothing);
    expect(_text(_member('finch'), 'Finch2 · Desktop'), findsOneWidget);
    // P1 first, then Next up's order, then the lost one from Waiting.
    expect(_top(tester, _unassigned()), ['u3', 'u1', 'u2', 'u5', 'u4']);
    for (final id in ['u1', 'u2', 'u3', 'u4', 'u5']) {
      for (final lane in ['Desktop', 'backend']) {
        expect(
          find.descendant(of: _card(id), matching: find.textContaining(lane)),
          findsNothing,
          reason: '$id $lane',
        );
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
    await tester.tap(_members);
    await tester.pumpAndSettle();
    await _close(tester, c);
    c = await _show(tester, _server(), storage: storage);
    expect(_member('finch'), findsOneWidget);
    expect(find.byKey(const ValueKey('super-tasks-board')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-board')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-tasks-board')), findsOneWidget);
    await _close(tester, c);
  });

  group('superTabCapacityLine', () {
    SuperTabLaneCapacity lane(String name, Duration? age) =>
        SuperTabLaneCapacity(
          lane: name,
          waiting: 3,
          busy: 1,
          oldestAt: age == null ? null : _now.subtract(age),
          taskIds: const [],
        );

    test('whole hours, rounded down', () {
      expect(
        superTabCapacityLine([
          lane('Desktop', const Duration(hours: 5, minutes: 59)),
        ], _now),
        'Desktop: 3 waiting, 1 busy, oldest 5 h',
      );
    });

    test('minutes under an hour, and no oldest when none waits', () {
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
