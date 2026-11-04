import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/tasks_view.dart';

import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

final _now = DateTime(2026, 11, 4, 9);
const _repo = 'https://github.com/autonomous-ai/openharness/pull';

Map<String, dynamic> taskFixture(
  String id,
  String title,
  int number, {
  String? requester,
  String? status,
  String? agent,
  Map<String, dynamic>? liveness,
  int? pullRequest,
  bool merged = false,
  bool archived = false,
  DateTime? shippedAt,
}) => {
  ...conversationFixture(id, title),
  'projectId': 'lead',
  'number': number,
  'archived': archived,
  'requesterId': ?requester,
  if (status != null)
    'assignment': {
      'id': 'as-$id',
      'agentId': agent ?? 'finch',
      'status': status,
      'progressAt': 1,
    },
  'liveness': ?liveness,
  if (pullRequest != null) ...{
    'pullRequestUrls': ['$_repo/$pullRequest'],
    'cards': {
      'pullRequests': [
        {
          'url': '$_repo/$pullRequest',
          'messageId': 'pr-$id',
          if (merged) 'mergedAt': 1,
        },
      ],
    },
  },
  if (shippedAt != null) 'shippedAt': shippedAt.millisecondsSinceEpoch,
};

/// The project of the mockup Dee confirmed: a proposal, two tasks nobody is on
/// yet, one working with its pull request, one waiting on the reader, and one
/// shipped two days ago and archived since.
ConversationServer tasksServer({bool empty = false}) {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
  // The backend's read of the project's unanswered proposals (#2867's rule).
  if (!empty) {
    server.proposals['lead'] = [
      {
        'messageId': 'p-new',
        'title': 'Rename a Swarm from the phone',
        'personId': 'tony',
        'at': _now.subtract(const Duration(minutes: 23)).millisecondsSinceEpoch,
      },
      {
        'messageId': 'p-old',
        'title': 'Backlog shows nothing in Mine',
        'personId': 'scholes',
        'at': _now
            .subtract(const Duration(minutes: 3, days: 2))
            .millisecondsSinceEpoch,
      },
    ];
  }
  server.state['people'] = [
    {'id': 'owner', 'email': 'dee@example.com', 'role': 'owner'},
    {'id': 'scholes', 'email': 'scholes@example.com', 'role': 'member'},
    {'id': 'tony', 'email': 'tony@example.com', 'role': 'member'},
    {'id': 'ken', 'email': 'ken15@example.com', 'role': 'member'},
  ];
  server.state['agents'] = [
    {
      'id': 'finch',
      'name': 'Engineer',
      'displayName': 'Finch2',
      'machineId': 'studio',
      'harnessId': 'h1',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude'},
    },
  ];
  (server.state['conversations'] as List).removeWhere(
    (g) => (g as Map)['id'] == 'offline',
  );
  if (!empty) {
    (server.state['conversations'] as List)..addAll(<Map<String, dynamic>>[
      taskFixture(
        'shipped-means',
        'Shipped means merged',
        10,
        requester: 'scholes',
      ),
      taskFixture('preview', 'Remove the old preview route', 11),
      taskFixture(
        'tag',
        'One tag per ask',
        12,
        requester: 'owner',
        status: 'working',
        pullRequest: 2867,
      ),
      taskFixture(
        'test-copy',
        'First run of the test copy',
        13,
        requester: 'ken',
        status: 'needs_human',
        liveness: {
          'state': 'waiting',
          'why': 'person',
          'personId': 'owner',
          'since': 1,
        },
      ),
      taskFixture(
        'sender',
        'Task chat keeps its sender',
        9,
        requester: 'scholes',
        status: 'done',
        pullRequest: 2870,
        merged: true,
        archived: true,
        shippedAt: _now.subtract(const Duration(days: 2)),
      ),
    ]);
  }
  return server;
}

Finder _column(String name) => find.byKey(ValueKey('super-tasks-column-$name'));
Finder _card(String id) => find.byKey(ValueKey('super-task-card-$id'));

Future<SuperTabController> _show(
  WidgetTester tester,
  ConversationServer server, {
  MemoryKeyValueStore? storage,
  List<String>? opened,
  List<String>? openedProposals,
}) async {
  await tester.binding.setSurfaceSize(const Size(1400, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: SuperTabTasksView(
          controller: c,
          project: c.snapshot!.projects.single,
          storage: storage ?? MemoryKeyValueStore(),
          needsHuman: (_) => 0,
          onOpenTask: (id) => opened?.add(id),
          onOpenProposal: (id) => openedProposals?.add(id),
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

List<String> _cardsIn(WidgetTester tester, String column) {
  final cards = find.descendant(
    of: _column(column),
    matching: find.byWidgetPredicate(
      (w) =>
          w.key is ValueKey<String> &&
          (w.key as ValueKey<String>).value.startsWith('super-task-card-'),
    ),
  );
  final found = [
    for (final e in cards.evaluate())
      (
        (e.widget.key as ValueKey<String>).value.substring(
          'super-task-card-'.length,
        ),
        tester.getTopLeft(find.byWidget(e.widget)).dy,
      ),
  ]..sort((a, b) => a.$2.compareTo(b.$2));
  return [for (final (id, _) in found) id];
}

/// A project's Tasks view (Dee, task #2569): Board by default, or List, with
/// Mine and Search, every ask from proposal to shipped.
void main() {
  testWidgets('Board shows the five columns in order, each with its count', (
    tester,
  ) async {
    final c = await _show(tester, tasksServer());
    final names = ['proposals', 'nextUp', 'working', 'waiting', 'shipped'];
    final lefts = [for (final n in names) tester.getTopLeft(_column(n)).dx];
    expect(lefts, orderedEquals([...lefts]..sort()));
    for (final (name, label, count) in [
      ('proposals', 'Proposals', '2'),
      ('nextUp', 'Next up', '2'),
      ('working', 'Working', '1'),
      ('waiting', 'Waiting', '1'),
      ('shipped', 'Shipped', '1'),
    ]) {
      final heading = find.byKey(ValueKey('super-tasks-heading-$name'));
      expect(
        find.descendant(of: heading, matching: find.text(label)),
        findsOneWidget,
      );
      expect(
        find.descendant(of: heading, matching: find.text(count)),
        findsOneWidget,
        reason: label,
      );
    }
    await _close(tester, c);
  });

  testWidgets('an empty column keeps its heading with 0', (tester) async {
    final server = tasksServer();
    (server.state['conversations'] as List).removeWhere(
      (g) => (g as Map)['id'] == 'tag',
    );
    final c = await _show(tester, server);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-tasks-heading-working')),
        matching: find.text('0'),
      ),
      findsOneWidget,
    );
    await _close(tester, c);
  });

  testWidgets('a project with no tasks says so', (tester) async {
    final c = await _show(tester, tasksServer(empty: true));
    expect(find.text('No tasks yet'), findsOneWidget);
    expect(_column('proposals'), findsNothing);
    await _close(tester, c);
  });

  testWidgets('cards read the title, then requester · agent · state', (
    tester,
  ) async {
    final c = await _show(tester, tasksServer());
    Finder inCard(String id, String text) =>
        find.descendant(of: _card(id), matching: find.text(text));
    expect(inCard('tag', 'One tag per ask'), findsOneWidget);
    expect(inCard('tag', 'dee · Finch2 · PR #2867'), findsOneWidget);
    expect(inCard('shipped-means', 'scholes'), findsOneWidget);
    expect(inCard('sender', 'scholes · Finch2 · PR #2870'), findsOneWidget);
    expect(
      inCard('test-copy', 'ken15 · Finch2 · dee to decide'),
      findsOneWidget,
    );
    // No task numbers, machines or models.
    expect(find.textContaining('#12'), findsNothing);
    expect(find.textContaining('studio'), findsNothing);
    expect(find.textContaining('claude'), findsNothing);
    await _close(tester, c);
  });

  testWidgets('a task that needs the reader says so, first in its column', (
    tester,
  ) async {
    final server = tasksServer();
    (server.state['conversations'] as List).add(
      taskFixture(
        'later',
        'Dial thread alerts',
        20,
        status: 'review',
        liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
      ),
    );
    final c = await _show(tester, server);
    expect(_cardsIn(tester, 'waiting'), ['test-copy', 'later']);
    expect(
      find.descendant(of: _card('test-copy'), matching: find.text('Needs you')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: _card('later'), matching: find.text('Needs you')),
      findsNothing,
    );
    await _close(tester, c);
  });

  testWidgets('Proposals lists the unanswered ones oldest first', (
    tester,
  ) async {
    final opened = <String>[];
    final c = await _show(tester, tasksServer(), openedProposals: opened);
    expect(_cardsIn(tester, 'proposals'), ['p-old', 'p-new']);
    expect(
      find.descendant(of: _card('p-new'), matching: find.text('tony · 23m')),
      findsOneWidget,
    );
    await tester.tap(_card('p-old'));
    expect(opened, ['p-old']);
    await _close(tester, c);
  });

  testWidgets('a card click opens its task', (tester) async {
    final opened = <String>[];
    final c = await _show(tester, tasksServer(), opened: opened);
    await tester.tap(_card('tag'));
    expect(opened, ['tag']);
    await _close(tester, c);
  });

  testWidgets('List shows the same groups as sections, Shipped folded', (
    tester,
  ) async {
    final c = await _show(tester, tasksServer());
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
    await tester.pumpAndSettle();
    final names = ['proposals', 'nextUp', 'working', 'waiting', 'shipped'];
    final tops = [
      for (final n in names)
        tester.getTopLeft(find.byKey(ValueKey('super-tasks-heading-$n'))).dy,
    ];
    expect(tops, orderedEquals([...tops]..sort()));
    expect(_card('tag'), findsOneWidget);
    expect(_card('sender'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('super-tasks-heading-shipped')));
    await tester.pumpAndSettle();
    expect(_card('sender'), findsOneWidget);
    await _close(tester, c);
  });

  testWidgets('Mine keeps the reader\'s asks; Search keeps matching titles', (
    tester,
  ) async {
    final c = await _show(tester, tasksServer());
    await tester.tap(find.byKey(const ValueKey('super-tasks-mine')));
    await tester.pumpAndSettle();
    expect(_card('tag'), findsOneWidget);
    expect(_card('test-copy'), findsNothing);
    expect(_card('p-old'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('super-tasks-mine')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('super-tasks-search')),
      'preview',
    );
    await tester.pumpAndSettle();
    expect(_card('preview'), findsOneWidget);
    expect(_card('tag'), findsNothing);
    expect(_card('p-old'), findsNothing);
    await _close(tester, c);
  });

  testWidgets('List and Mine are remembered for the reader on this Mac', (
    tester,
  ) async {
    final storage = MemoryKeyValueStore();
    var c = await _show(tester, tasksServer(), storage: storage);
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
    await tester.tap(find.byKey(const ValueKey('super-tasks-mine')));
    await tester.pumpAndSettle();
    await _close(tester, c);
    c = await _show(tester, tasksServer(), storage: storage);
    // List draws Shipped folded and the board's columns not at all.
    expect(_column('working'), findsNothing);
    expect(_card('tag'), findsOneWidget);
    expect(_card('test-copy'), findsNothing);
    await _close(tester, c);
  });

  testWidgets('a card moves as its work moves, with no reload', (tester) async {
    final server = tasksServer();
    final c = await _show(tester, server);
    expect(_cardsIn(tester, 'nextUp'), contains('preview'));
    final preview = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'preview');
    preview['assignment'] = {
      'id': 'as-preview',
      'agentId': 'finch',
      'status': 'working',
      'progressAt': 1,
    };
    await c.refresh();
    await tester.pumpAndSettle();
    expect(_cardsIn(tester, 'nextUp'), isNot(contains('preview')));
    expect(_cardsIn(tester, 'working'), contains('preview'));
    await _close(tester, c);
  });

  testWidgets('a new proposal shows once the project chat moves', (
    tester,
  ) async {
    final server = tasksServer();
    final c = await _show(tester, server);
    final reads = server.proposalReads.length;
    await c.refresh();
    await tester.pumpAndSettle();
    // Nothing moved in the chat: nothing is read again.
    expect(server.proposalReads.length, reads);
    server.proposals['lead']!.add({
      'messageId': 'p-newest',
      'title': 'Device as your Buddy',
      'personId': 'owner',
      'at': _now.millisecondsSinceEpoch,
    });
    server.append('Device as your Buddy');
    await c.refresh();
    await tester.pumpAndSettle();
    expect(_cardsIn(tester, 'proposals'), ['p-old', 'p-new', 'p-newest']);
    await _close(tester, c);
  });

  testWidgets(
    'an older server with no proposals read leaves the column empty',
    (tester) async {
      final server = tasksServer()..proposalsUnsupported = true;
      final c = await _show(tester, server);
      expect(_cardsIn(tester, 'proposals'), isEmpty);
      expect(_card('tag'), findsOneWidget);
      await _close(tester, c);
    },
  );

  group('Next up, in the shared order', () {
    ConversationServer queued() {
      final server = tasksServer();
      (server.state['conversations'] as List).add(
        taskFixture('third', 'Rename the round dial', 14),
      );
      return server;
    }

    Iterable<Map> moves(ConversationServer server) => [
      for (final post in server.posts)
        if ((post['command'] as Map?)?['type'] == 'work.queue')
          post['command'] as Map,
    ];

    Future<void> dragTo(WidgetTester tester, String id, Offset to) async {
      final gesture = await tester.startGesture(tester.getCenter(_card(id)));
      await tester.pump(kLongPressTimeout);
      for (var i = 1; i <= 10; i++) {
        final from = tester.getCenter(_card(id));
        await gesture.moveTo(Offset.lerp(from, to, i / 10)!);
        await tester.pump(const Duration(milliseconds: 16));
      }
      await gesture.up();
      await tester.pumpAndSettle();
    }

    testWidgets('a drag to the top sets the order for everyone, and it holds', (
      tester,
    ) async {
      final server = queued();
      var c = await _show(tester, server);
      expect(_cardsIn(tester, 'nextUp'), ['shipped-means', 'preview', 'third']);
      await dragTo(
        tester,
        'third',
        tester.getTopLeft(_card('shipped-means')) + const Offset(20, 2),
      );
      expect(moves(server), [
        {'type': 'work.queue', 'conversationId': 'third', 'after': null},
      ]);
      expect(_cardsIn(tester, 'nextUp'), ['third', 'shipped-means', 'preview']);
      await _close(tester, c);
      // Read again, as another person or a restart reads it.
      c = await _show(tester, server);
      expect(_cardsIn(tester, 'nextUp'), ['third', 'shipped-means', 'preview']);
      await _close(tester, c);
    });

    testWidgets('a card dropped on another column goes back', (tester) async {
      final server = queued();
      final c = await _show(tester, server);
      await dragTo(tester, 'preview', tester.getCenter(_column('working')));
      expect(moves(server), isEmpty);
      expect(_cardsIn(tester, 'nextUp'), ['shipped-means', 'preview', 'third']);
      expect(_cardsIn(tester, 'working'), ['tag']);
      await _close(tester, c);
    });

    testWidgets('only Next up can be dragged', (tester) async {
      final c = await _show(tester, queued());
      expect(
        find.byKey(const ValueKey('super-task-drag-preview')),
        findsOneWidget,
      );
      for (final id in ['tag', 'test-copy', 'sender', 'p-old']) {
        expect(find.byKey(ValueKey('super-task-drag-$id')), findsNothing);
      }
      await _close(tester, c);
    });

    testWidgets('a focused card moves up with ⌥↑ and down with ⌥↓', (
      tester,
    ) async {
      final server = queued();
      final c = await _show(tester, server);
      Focus.of(tester.element(find.text('Rename the round dial')))
          .requestFocus();
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.alt);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.alt);
      await tester.pumpAndSettle();
      expect(_cardsIn(tester, 'nextUp'), ['shipped-means', 'third', 'preview']);
      Focus.of(tester.element(find.text('Shipped means merged')))
          .requestFocus();
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.alt);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.alt);
      await tester.pumpAndSettle();
      expect(moves(server), [
        {
          'type': 'work.queue',
          'conversationId': 'third',
          'after': 'shipped-means',
        },
        {
          'type': 'work.queue',
          'conversationId': 'shipped-means',
          'after': 'third',
        },
      ]);
      expect(_cardsIn(tester, 'nextUp'), ['third', 'shipped-means', 'preview']);
      await _close(tester, c);
    });

    testWidgets('a refused move puts the card back and says why', (
      tester,
    ) async {
      final server = queued()
        ..refuse = {
          'code': 'COORDINATOR_REQUIRED',
          'message': 'Only a person or the PM can reorder tasks.',
        };
      final c = await _show(tester, server);
      await dragTo(
        tester,
        'third',
        tester.getTopLeft(_card('shipped-means')) + const Offset(20, 2),
      );
      expect(_cardsIn(tester, 'nextUp'), ['shipped-means', 'preview', 'third']);
      expect(
        find.text('Only a person or the PM can reorder tasks.'),
        findsOneWidget,
      );
      await _close(tester, c);
    });
  });
}
