import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/tasks_view.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_tasks_view_test.dart' show taskFixture, tasksServer;
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

/// Audit findings 5 and 13 of task #4211 (task #4251): in a 1500 window the
/// Board's middle is about 860 wide. An empty column is a slim lane, the rest
/// share the width in whole columns, a pill names the columns out of view, and
/// a card's mark says what it means.

final _now = DateTime(2026, 11, 4, 9);

Finder _key(String k) => find.byKey(ValueKey(k));
Finder _column(String name) => _key('super-tasks-column-$name');
final _board = _key('super-tasks-board');

/// No proposal, two Next up, three Working (one in review), one Done, one
/// Merged waiting for its release and five Shipped.
ConversationServer _server() {
  final server = tasksServer();
  server.proposals['lead'] = <Map<String, dynamic>>[];
  (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
    taskFixture(
      'review',
      'Rename a Swarm from the phone',
      20,
      requester: 'tony',
      status: 'review',
      pullRequest: 3772,
      liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
    ),
    taskFixture(
      'repair',
      'Repair the release notes',
      21,
      requester: 'scholes',
      status: 'done',
      pullRequest: 3773,
    ),
    taskFixture(
      'releasing',
      'Board fits the middle',
      22,
      requester: 'owner',
      status: 'done',
      pullRequest: 3774,
      merged: true,
      releasing: ['desktop'],
    ),
    for (var i = 0; i < 4; i++)
      taskFixture(
        'shipped-$i',
        'Shipped task $i',
        30 + i,
        requester: 'ken',
        status: 'done',
        pullRequest: 3780 + i,
        merged: true,
        shippedAt: _now.subtract(Duration(hours: i + 1)),
      ),
  ]);
  return server;
}

Future<SuperTabController> _show(
  WidgetTester tester,
  ConversationServer server, {
  double width = 860,
}) async {
  await tester.binding.setSurfaceSize(Size(width, 860));
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
          storage: MemoryKeyValueStore(),
          needsHuman: (_) => 0,
          onOpenTask: (_) {},
          onOpenProposal: (_) {},
          onOpenMessage: (_, _) {},
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

/// Audit finding 12 (task #4445): two proposals, two Next up, two Working, empty Done and Merged, one Shipped.
ConversationServer crewServer() {
  final server = swarm();
  final now = DateTime.now();
  server.proposals['lead'] = [
    for (final (i, title) in [
      'Rename a Swarm from the phone',
      'Backlog shows nothing in Mine',
    ].indexed)
      {
        'messageId': 'p-$i',
        'title': title,
        'personId': 'owner',
        'at': now.subtract(Duration(hours: i + 1)).millisecondsSinceEpoch,
      },
  ];
  final conversations = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  conversations.removeWhere((g) => g['id'] == 'offline');
  conversations.addAll([
    taskFixture('hotfix', 'Sign-in loops forever after a token refresh', 30),
    taskFixture('lanes', 'Document the crew lanes', 31),
    taskFixture(
      'composer',
      'Composer keeps its draft across tabs',
      32,
      status: 'working',
      agent: 'kestrel',
    ),
    taskFixture(
      'machines',
      'Machines list sorts by load',
      33,
      status: 'working',
      agent: 'kestrel',
    ),
    taskFixture(
      'invite',
      'Invite link expires in a week',
      34,
      status: 'done',
      agent: 'kestrel',
      pullRequest: 3700,
      merged: true,
      shippedAt: now.subtract(const Duration(hours: 1)),
    ),
  ]);
  return server;
}

/// The whole Desktop Swarm view in a [width] × 860 window, [server]'s project's Board open.
Future<SuperTabController> showWindow(
  WidgetTester tester,
  ConversationServer server, {
  double width = 1500,
  Brightness brightness = Brightness.light,
}) async {
  await tester.binding.setSurfaceSize(Size(width, 860));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  final c = server.controller(
    account: 'owner',
    initial: {
      'tabId': 'tab',
      'projectsGroupOpen': true,
      'accountId': 'owner',
      'selectedId': 'lead',
    },
  );
  await tester.runAsync(c.refresh);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac Studio',
          paneStore: MemoryKeyValueStore(),
          board: true,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(_key('super-group-lead'));
  await tester.pumpAndSettle();
  expect(_key('super-tasks-lead'), findsOneWidget);
  return c;
}

Future<void> closeWindow(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  c.dispose();
  await tester.pump(const Duration(seconds: 5));
}

const _names = ['proposals', 'nextUp', 'working', 'done', 'merged', 'shipped'];

/// Whether every column that starts inside the Board's view ends inside it.
void _expectWhole(WidgetTester tester) {
  final view = tester.getRect(_board);
  for (final name in _names) {
    final rect = tester.getRect(_column(name));
    if (rect.right <= view.left + .5 || rect.left >= view.right - .5) continue;
    expect(rect.left, greaterThanOrEqualTo(view.left - .5), reason: name);
    expect(rect.right, lessThanOrEqualTo(view.right + .5), reason: name);
  }
}

void main() {
  testWidgets('an empty column is a slim lane with its name and 0, no '
      '"No tasks" panel', (tester) async {
    final c = await _show(tester, _server());
    expect(
      tester.getSize(_column('proposals')).width,
      SuperTabTasksView.slimColumnWidth,
    );
    expect(
      find.descendant(
        of: _column('proposals'),
        matching: find.text('No tasks'),
      ),
      findsNothing,
    );
    final heading = _key('super-tasks-heading-proposals');
    expect(
      find.descendant(of: heading, matching: find.text('Proposal')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: heading, matching: find.text('0')),
      findsOneWidget,
    );
    await _close(tester, c);
  });

  testWidgets('a slim lane that gets a task is a full column at once', (
    tester,
  ) async {
    final server = tasksServer();
    final c = await _show(tester, server, width: 1500);
    expect(
      tester.getSize(_column('done')).width,
      SuperTabTasksView.slimColumnWidth,
    );
    (server.state['conversations'] as List).add(
      taskFixture('repair', 'Repair the release notes', 21, status: 'done'),
    );
    await c.refresh();
    await tester.pumpAndSettle();
    expect(
      tester.getSize(_column('done')).width,
      greaterThanOrEqualTo(SuperTabTasksView.minColumnWidth),
    );
    expect(
      find.descendant(
        of: _column('done'),
        matching: _key('super-task-card-repair'),
      ),
      findsOneWidget,
    );
    await _close(tester, c);
  });

  testWidgets('in an 860 middle every column in view is whole, never under '
      'the least width', (tester) async {
    final c = await _show(tester, _server());
    _expectWhole(tester);
    for (final name in _names.skip(1)) {
      expect(
        tester.getSize(_column(name)).width,
        greaterThanOrEqualTo(SuperTabTasksView.minColumnWidth),
        reason: name,
      );
    }
    expect(tester.getTopLeft(_column('done')).dx, lessThan(860));
    await _close(tester, c);
  });

  testWidgets('a pill names the columns out of view and scrolls them in', (
    tester,
  ) async {
    final c = await _show(tester, _server());
    final more = _key('super-tasks-board-more-right');
    expect(
      find.descendant(of: more, matching: find.text('Merged 1 · Shipped 5')),
      findsOneWidget,
    );
    expect(_key('super-tasks-board-more-left'), findsNothing);
    await tester.tap(more);
    await tester.pumpAndSettle();
    final view = tester.getRect(_board);
    for (final name in ['merged', 'shipped']) {
      final rect = tester.getRect(_column(name));
      expect(rect.left, greaterThanOrEqualTo(view.left), reason: name);
      expect(rect.right, lessThanOrEqualTo(view.right), reason: name);
    }
    expect(more, findsNothing, reason: 'nothing is out of view on the right');
    // The columns now out of view on the left are named there.
    final back = _key('super-tasks-board-more-left');
    expect(
      find.descendant(of: back, matching: find.textContaining('Next up 2')),
      findsOneWidget,
    );
    await tester.tap(back);
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(_column('nextUp')).dx, greaterThanOrEqualTo(0));
    await _close(tester, c);
  });

  testWidgets('Mine keeps the fit: what it empties turns slim', (tester) async {
    final c = await _show(tester, _server());
    await tester.tap(_key('super-tasks-mine'));
    await tester.pumpAndSettle();
    // Only the owner's two asks are left, in Working and Merged.
    for (final name in ['proposals', 'nextUp', 'done', 'shipped']) {
      expect(
        tester.getSize(_column(name)).width,
        SuperTabTasksView.slimColumnWidth,
        reason: name,
      );
    }
    _expectWhole(tester);
    expect(_key('super-tasks-board-more-right'), findsNothing);
    await _close(tester, c);
  });

  testWidgets("a card's mark names its state in a tooltip", (tester) async {
    final c = await _show(tester, _server(), width: 2400);
    for (final (card, word) in [
      ('review', 'In review'),
      ('tag', 'Working'),
      ('test-copy', 'Waiting on a person'),
      ('preview', 'Queued'),
      ('shipped-0', 'Shipped'),
    ]) {
      expect(
        find.descendant(
          of: _key('super-task-card-$card'),
          matching: find.byTooltip(word),
        ),
        findsOneWidget,
        reason: card,
      );
    }
    await _close(tester, c);
  });

  testWidgets('a 1500 window shows Proposal, Next up and Working whole, the '
      'empty lanes after Working at the edge, never cut', (tester) async {
    final c = await showWindow(tester, crewServer());
    final view = tester.getRect(_board);
    for (final name in ['proposals', 'nextUp', 'working']) {
      final rect = tester.getRect(_column(name));
      expect(rect.left, greaterThanOrEqualTo(view.left - .5), reason: name);
      expect(rect.right, lessThanOrEqualTo(view.right + .5), reason: name);
      expect(
        rect.width,
        greaterThanOrEqualTo(SuperTabTasksView.minColumnWidth),
        reason: name,
      );
    }
    _expectWhole(tester);
    expect(
      find.descendant(
        of: _key('super-tasks-board-more-right'),
        matching: find.text('Shipped 1'),
      ),
      findsOneWidget,
    );
    await closeWindow(tester, c);
  });
}
