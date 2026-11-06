import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
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
  List<String>? releasing,
  Map<String, dynamic>? released,
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
  'releasing': ?releasing,
  'released': ?released,
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
  Set<String> asking = const {},
  Size size = const Size(1400, 900),
  String? selectedId,
  double textScale = 1,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          disableAnimations: true,
          textScaler: TextScaler.linear(textScale),
        ),
        child: child!,
      ),
      home: Scaffold(
        body: SuperTabTasksView(
          controller: c,
          project: c.snapshot!.projects.single,
          storage: storage ?? MemoryKeyValueStore(),
          needsHuman: (task) => asking.contains(task.id) ? 1 : 0,
          onOpenTask: (id) => opened?.add(id),
          onOpenProposal: (id) => openedProposals?.add(id),
          onOpenMessage: (_, _) {},
          selectedId: selectedId,
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
  testWidgets('Board shows the six columns in order, each with its count', (
    tester,
  ) async {
    final c = await _show(tester, tasksServer());
    final names = [
      'proposals',
      'nextUp',
      'working',
      'done',
      'merged',
      'shipped',
    ];
    final lefts = [for (final n in names) tester.getTopLeft(_column(n)).dx];
    expect(lefts, orderedEquals([...lefts]..sort()));
    for (final (name, label, count) in [
      ('proposals', 'Proposal', '2'),
      ('nextUp', 'Next up', '2'),
      ('working', 'Working', '2'),
      ('done', 'Done', '0'),
      ('merged', 'Merged', '0'),
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

  testWidgets('each column is a 280-wide tinted lane, rounded 12, with no rim '
      'or shadow (task #3787)', (tester) async {
    final c = await _show(tester, tasksServer());
    for (final name in [
      'proposals',
      'nextUp',
      'working',
      'done',
      'merged',
      'shipped',
    ]) {
      expect(tester.getSize(_column(name)).width, 280, reason: name);
      final panel = tester.widget<DecoratedBox>(_column(name));
      final decoration = panel.decoration as BoxDecoration;
      // A step off the page, as Trello's lists: darker under white cards in
      // light, darker under lifted ones in dark.
      expect(
        decoration.color,
        grid.AppTheme.pick(grid.AppSurface.wellFill, grid.AppPalette.panelBg),
        reason: name,
      );
      expect(
        decoration.borderRadius,
        BorderRadius.circular(grid.AppCard.radius),
      );
      expect(decoration.border, isNull, reason: name);
      expect(decoration.boxShadow, isNull, reason: name);
      // Its name is the lane's bold title.
      final label = find.descendant(
        of: find.byKey(ValueKey('super-tasks-heading-$name')),
        matching: find.byType(Text),
      );
      expect(
        tester.widget<Text>(label.first).style?.fontWeight,
        grid.AppFont.semibold,
        reason: name,
      );
    }
    await _close(tester, c);
  });

  testWidgets('columns that do not fit scroll sideways', (tester) async {
    final c = await _show(tester, tasksServer(), size: const Size(900, 800));
    expect(tester.getTopLeft(_column('shipped')).dx, greaterThan(900));
    await tester.drag(
      find.byKey(const ValueKey('super-tasks-board')),
      const Offset(-1200, 0),
    );
    await tester.pumpAndSettle();
    expect(tester.getTopRight(_column('shipped')).dx, lessThanOrEqualTo(900));
    expect(tester.takeException(), isNull);
    await _close(tester, c);
  });

  testWidgets('a long title gets three lines on the Board, one in List', (
    tester,
  ) async {
    const long =
        'A long title that takes all three of its lines on the board, and then '
        'goes on with more words than three lines of a column can hold, so '
        'the rest of it is cut';
    final server = tasksServer();
    (server.state['conversations'] as List).add(
      taskFixture('long', long, 17, requester: 'tony'),
    );
    final c = await _show(tester, server);
    Finder title(String id, String text) =>
        find.descendant(of: _card(id), matching: find.text(text));
    expect(tester.widget<Text>(title('long', long)).maxLines, 3);
    final board = tester.getSize(title('long', long)).height;
    // Three of the tile title's lines.
    final style = tester.widget<Text>(title('long', long)).style!;
    expect(
      board,
      moreOrLessEquals(style.fontSize! * style.height! * 3, epsilon: 2),
    );
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(title('long', long)).maxLines, 1);
    await _close(tester, c);
  });

  testWidgets('a Board card is raised card material, rounded 8, with a soft '
      'shadow that lifts under the pointer (task #3787)', (tester) async {
    final c = await _show(tester, tasksServer());
    BoxDecoration decoration(String id) =>
        tester
                .widget<Ink>(
                  find.descendant(of: _card(id), matching: find.byType(Ink)),
                )
                .decoration!
            as BoxDecoration;
    for (final id in ['tag', 'preview', 'p-old', 'sender']) {
      expect(decoration(id).color, grid.AppCard.base, reason: id);
      expect(
        decoration(id).borderRadius,
        BorderRadius.circular(grid.AppCard.insetRadius),
      );
      expect(decoration(id).border, Border.all(color: grid.AppCard.insetHair));
      expect(decoration(id).boxShadow, grid.AppGlass.cardShadow, reason: id);
    }
    // Padding of 12 around its text.
    final preview = tester.getRect(_card('preview'));
    final previewTitle = tester.getRect(
      find.descendant(
        of: _card('preview'),
        matching: find.text('Remove the old preview route'),
      ),
    );
    expect(previewTitle.left - preview.left, moreOrLessEquals(12, epsilon: 1));
    expect(previewTitle.top - preview.top, moreOrLessEquals(12, epsilon: 1));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(_card('preview')));
    await tester.pumpAndSettle();
    expect(decoration('preview').boxShadow, grid.AppGlass.shadow);
    expect(decoration('tag').boxShadow, grid.AppGlass.cardShadow);
    await mouse.moveTo(Offset.zero);
    await tester.pumpAndSettle();
    expect(decoration('preview').boxShadow, grid.AppGlass.cardShadow);
    // List keeps its plain rows.
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: _card('tag'), matching: find.byType(Ink)),
      findsNothing,
    );
    await _close(tester, c);
  });

  testWidgets('a Board card wears its lane as a label on top; List does not '
      '(task #3787)', (tester) async {
    final server = tasksServer();
    (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((g) => g['id'] == 'tag')['handOutLane'] =
        'Desktop';
    final c = await _show(tester, server);
    final label = find.descendant(
      of: _card('tag'),
      matching: find.byKey(const ValueKey('super-task-lane-Desktop')),
    );
    expect(label, findsOneWidget);
    expect(
      find.descendant(of: label, matching: find.text('Desktop')),
      findsOneWidget,
    );
    final title = find.descendant(
      of: _card('tag'),
      matching: find.text('One tag per ask'),
    );
    expect(tester.getTopLeft(label).dy, lessThan(tester.getTopLeft(title).dy));
    // The caption keeps its words.
    expect(
      find.descendant(
        of: _card('tag'),
        matching: find.text('dee · Finch2 · PR #2867'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _card('preview'),
        matching: find.byKey(const ValueKey('super-task-lane-Desktop')),
      ),
      findsNothing,
    );
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
    await tester.pumpAndSettle();
    expect(label, findsNothing);
    await _close(tester, c);
  });

  testWidgets('an empty column keeps its heading with 0', (tester) async {
    final c = await _show(tester, tasksServer());
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-tasks-heading-done')),
        matching: find.text('0'),
      ),
      findsOneWidget,
    );
    await _close(tester, c);
  });

  testWidgets('the open task has the sidebar\'s selected fill and says so', (
    tester,
  ) async {
    final c = await _show(tester, tasksServer(), selectedId: 'tag');
    Color? fill(String id) =>
        (tester
                    .widget<Ink>(
                      find.descendant(
                        of: _card(id),
                        matching: find.byType(Ink),
                      ),
                    )
                    .decoration!
                as BoxDecoration)
            .color;
    expect(
      fill('tag'),
      Color.alphaBlend(grid.AppSurface.selectedFill, grid.AppCard.base),
    );
    expect(tester.getSemantics(_card('tag')), isSemantics(isSelected: true));
    for (final id in ['preview', 'test-copy', 'p-old']) {
      expect(fill(id), grid.AppCard.base, reason: id);
      expect(
        tester.getSemantics(_card(id)),
        isNot(isSemantics(isSelected: true)),
        reason: id,
      );
    }
    // The List shows the same row selected; the others stay plain.
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
    await tester.pumpAndSettle();
    expect(fill('tag'), grid.AppSurface.selectedFill);
    expect(
      find.descendant(of: _card('preview'), matching: find.byType(Ink)),
      findsNothing,
    );
    await _close(tester, c);
  });

  testWidgets('an empty column says No tasks in the caption color', (
    tester,
  ) async {
    final c = await _show(tester, tasksServer());
    final empty = find.descendant(
      of: _column('done'),
      matching: find.text('No tasks'),
    );
    expect(empty, findsOneWidget);
    expect(
      find.descendant(of: _column('merged'), matching: find.text('No tasks')),
      findsOneWidget,
    );
    expect(
      tester.widget<Text>(empty).style?.color,
      grid.AppPalette.textSecondary,
    );
    for (final name in ['proposals', 'nextUp', 'working', 'shipped']) {
      expect(
        find.descendant(of: _column(name), matching: find.text('No tasks')),
        findsNothing,
        reason: name,
      );
    }
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
    expect(inCard('test-copy', 'ken15 · Finch2 · Needs you'), findsOneWidget);
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
    expect(_cardsIn(tester, 'working'), ['test-copy', 'later', 'tag']);
    expect(
      find.descendant(
        of: _card('test-copy'),
        matching: find.textContaining('Needs you'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _card('later'),
        matching: find.textContaining('Needs you'),
      ),
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
    final names = [
      'proposals',
      'nextUp',
      'working',
      'done',
      'merged',
      'shipped',
    ];
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

  testWidgets('a new proposal shows once the chat moves, at most a read a '
      'minute', (tester) async {
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
    // Within a minute of the last read: it waits (PM, 2026-11-04).
    expect(server.proposalReads.length, reads);
    expect(_cardsIn(tester, 'proposals'), ['p-old', 'p-new']);
    server.append('and another');
    await c.refresh();
    await tester.pump(const Duration(minutes: 1));
    await tester.pumpAndSettle();
    // One read for both moves.
    expect(server.proposalReads.length, reads + 1);
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

    testWidgets('a drop under a Needs-you card lands where it was dropped, '
        'in the shared order too', (tester) async {
      final server = queued();
      // `preview` needs the reader, so it shows first though it is second in
      // the queue.
      var c = await _show(tester, server, asking: {'preview'});
      expect(_cardsIn(tester, 'nextUp'), ['preview', 'shipped-means', 'third']);
      await dragTo(
        tester,
        'third',
        tester.getTopLeft(_card('shipped-means')) + const Offset(20, 2),
      );
      // Before `shipped-means`, the card under the drop: the queue's top.
      expect(moves(server), [
        {'type': 'work.queue', 'conversationId': 'third', 'after': null},
      ]);
      await _close(tester, c);
      c = await _show(tester, server, asking: {'preview'});
      expect(_cardsIn(tester, 'nextUp'), ['preview', 'third', 'shipped-means']);
      await _close(tester, c);
    });

    testWidgets('a drop above a Needs-you card ranked last goes to the top of '
        'the rest', (tester) async {
      final server = queued();
      // `third` needs the reader: it shows first, though it is last in the
      // queue.
      var c = await _show(tester, server, asking: {'third'});
      expect(_cardsIn(tester, 'nextUp'), ['third', 'shipped-means', 'preview']);
      await dragTo(
        tester,
        'preview',
        tester.getTopLeft(_card('third')) + const Offset(20, 2),
      );
      expect(moves(server), [
        {'type': 'work.queue', 'conversationId': 'preview', 'after': null},
      ]);
      await _close(tester, c);
      c = await _show(tester, server, asking: {'third'});
      expect(_cardsIn(tester, 'nextUp'), ['third', 'preview', 'shipped-means']);
      await _close(tester, c);
      // Without the lift, as everyone else sees it.
      c = await _show(tester, server);
      expect(_cardsIn(tester, 'nextUp'), ['preview', 'shipped-means', 'third']);
      await _close(tester, c);
    });

    testWidgets('a card dropped on another column goes back', (tester) async {
      final server = queued();
      final c = await _show(tester, server);
      await dragTo(tester, 'preview', tester.getCenter(_column('working')));
      expect(moves(server), isEmpty);
      expect(_cardsIn(tester, 'nextUp'), ['shipped-means', 'preview', 'third']);
      expect(_cardsIn(tester, 'working'), ['test-copy', 'tag']);
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

  testWidgets('a merged task waits under Merged, with its parts, until its '
      'release, in Board and in List; a merge the server has no release list '
      'for stays Shipped (tasks #3452, #3812)', (tester) async {
    final server = tasksServer();
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      taskFixture(
        'releasing',
        'Round dial recap',
        20,
        requester: 'owner',
        status: 'done',
        pullRequest: 3401,
        merged: true,
        shippedAt: _now.subtract(const Duration(hours: 1)),
        releasing: ['desktop', 'cli'],
      ),
      taskFixture(
        'fresh',
        'Reminder opens no thread',
        21,
        requester: 'owner',
        status: 'done',
        pullRequest: 3234,
        merged: true,
        shippedAt: _now.subtract(const Duration(minutes: 2)),
        releasing: [],
      ),
    ]);
    final c = await _show(tester, server);
    expect(_cardsIn(tester, 'merged'), containsAll(['releasing', 'fresh']));
    expect(_cardsIn(tester, 'working'), isNot(contains('releasing')));
    expect(_cardsIn(tester, 'shipped'), ['sender']);
    expect(
      find.descendant(
        of: _card('releasing'),
        matching: find.textContaining('waiting for Desktop, CLI'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _card('fresh'),
        matching: find.textContaining('waiting for a release'),
      ),
      findsOneWidget,
    );
    // List agrees: under the Merged heading, above Shipped's.
    await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
    await tester.pumpAndSettle();
    double top(Finder f) => tester.getTopLeft(f).dy;
    final merged = top(
      find.byKey(const ValueKey('super-tasks-heading-merged')),
    );
    final shipped = top(
      find.byKey(const ValueKey('super-tasks-heading-shipped')),
    );
    expect(top(_card('releasing')), inExclusiveRange(merged, shipped));
    expect(top(_card('fresh')), inExclusiveRange(merged, shipped));
    expect(
      find.byKey(const ValueKey('super-tasks-heading-waiting')),
      findsNothing,
    );
    await _close(tester, c);
  });

  testWidgets('a task done and waiting for its merge is under Done with how '
      'long it has waited, a warning past an hour; work with no code stays '
      'Done (task #3812)', (tester) async {
    final server = tasksServer();
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      taskFixture(
        'fresh-done',
        'Just reviewed',
        30,
        requester: 'owner',
        status: 'done',
        pullRequest: 3500,
        shippedAt: _now.subtract(const Duration(minutes: 12)),
      ),
      taskFixture(
        'stuck-done',
        'Waiting on the merge',
        31,
        requester: 'owner',
        status: 'done',
        pullRequest: 3501,
        shippedAt: _now.subtract(const Duration(minutes: 90)),
      ),
      taskFixture(
        'no-code',
        'A research note',
        32,
        requester: 'owner',
        status: 'done',
        shippedAt: _now.subtract(const Duration(hours: 2)),
      ),
    ]);
    final c = await _show(tester, server);
    expect(
      _cardsIn(tester, 'done'),
      unorderedEquals(['fresh-done', 'stuck-done', 'no-code']),
    );
    Finder line(String id, String text) =>
        find.descendant(of: _card(id), matching: find.textContaining(text));
    expect(line('fresh-done', 'waiting to merge for 12 min'), findsOneWidget);
    expect(
      tester
          .widget<Text>(line('fresh-done', 'waiting to merge for 12 min'))
          .style
          ?.color,
      isNot(grid.AppPalette.warn),
    );
    final stuck = line('stuck-done', 'waiting to merge for 1 h 30 min');
    expect(stuck, findsOneWidget);
    expect(tester.widget<Text>(stuck).style?.color, grid.AppPalette.warn);
    // How long it has waited is what the column is for: never cut off.
    expect(
      tester.renderObject<RenderParagraph>(stuck).didExceedMaxLines,
      isFalse,
    );
    expect(line('no-code', 'Done'), findsOneWidget);
    // Finished with no pull request waits for no merge: never the warning,
    // however long ago it was done.
    expect(
      tester.widget<Text>(line('no-code', 'Done')).style?.color,
      isNot(grid.AppPalette.warn),
    );
    expect(_cardsIn(tester, 'shipped'), ['sender']);
    await _close(tester, c);
  });

  testWidgets(
    'a released task is under Shipped with its version (task #3812)',
    (tester) async {
      final server = tasksServer();
      (server.state['conversations'] as List).add(
        taskFixture(
          'released',
          'Out in a release',
          33,
          requester: 'owner',
          status: 'done',
          pullRequest: 3400,
          merged: true,
          shippedAt: _now.subtract(const Duration(hours: 3)),
          released: {
            'at': _now.millisecondsSinceEpoch,
            'tags': ['v1.3.84_desktop'],
          },
        ),
      );
      final c = await _show(tester, server);
      expect(_cardsIn(tester, 'shipped'), contains('released'));
      expect(
        find.descendant(
          of: _card('released'),
          matching: find.textContaining('Desktop 1.3.84'),
        ),
        findsOneWidget,
      );
      await _close(tester, c);
    },
  );

  for (final scale in [1.0, 1.5]) {
    testWidgets('all four release parts show in full on a board card, at text '
        'scale $scale (task #3452)', (tester) async {
      final server = tasksServer();
      (server.state['conversations'] as List).add(
        taskFixture(
          'all-four',
          'Round dial recap',
          20,
          requester: 'scholes',
          status: 'done',
          pullRequest: 3401,
          merged: true,
          shippedAt: _now.subtract(const Duration(hours: 1)),
          releasing: ['backend', 'cli', 'desktop', 'web'],
        ),
      );
      final c = await _show(
        tester,
        server,
        size: const Size(1500, 900),
        textScale: scale,
      );
      final caption = find.descendant(
        of: _card('all-four'),
        matching: find.textContaining('waiting for Backend, CLI, Desktop, Web'),
      );
      expect(caption, findsOneWidget);
      expect(
        tester.renderObject<RenderParagraph>(caption).didExceedMaxLines,
        isFalse,
      );
      // The whole text is laid out: it takes as many lines as it needs.
      expect(tester.getSize(caption).height, greaterThan(16));
      await _close(tester, c);
    });
  }
}
