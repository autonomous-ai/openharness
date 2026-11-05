import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/backlog.dart';
import 'package:harness/super_tabs/backlog_view.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/tasks_view.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_tasks_view_test.dart' show tasksServer, taskFixture;
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

final _now = DateTime(2026, 11, 4, 9);

Finder _key(String key) => find.byKey(ValueKey(key));
Finder _column(String name) => _key('super-tasks-column-$name');
Finder _card(String id) => _key('super-task-card-$id');
Finder _row(String id) => _key('super-backlog-row-$id');
Finder _in(Finder of, String text) =>
    find.descendant(of: of, matching: find.text(text, findRichText: true));

List<Map<String, dynamic>> _groups(ConversationServer server) =>
    (server.state['conversations'] as List).cast<Map<String, dynamic>>();

Map<String, dynamic> _group(ConversationServer server, String id) =>
    _groups(server).firstWhere((g) => g['id'] == id);

/// The mockup's project with a hotfix asked after the P2 work: `hotfix` (#30,
/// P0) is the newest task in Next up, and `crash` (#8, P0) the oldest in
/// Working.
ConversationServer _server() {
  final server = tasksServer();
  _groups(server).addAll([
    taskFixture('third', 'Rename the round dial', 14),
    {...taskFixture('hotfix', 'Sign-in loops forever', 30), 'priority': 'P0'},
    {
      ...taskFixture('crash', 'Settings crash on open', 8, status: 'working'),
      'priority': 'P0',
    },
  ]);
  // A task the server says is P2 reads as one with no field.
  _group(server, 'preview')['priority'] = 'P2';
  return server;
}

Widget _app(Widget body) => MaterialApp(
  theme: grid.buildAppTheme(brightness: Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(disableAnimations: true),
    child: child!,
  ),
  home: Scaffold(body: body),
);

Future<SuperTabController> _board(
  WidgetTester tester,
  ConversationServer server,
) async {
  await tester.binding.setSurfaceSize(const Size(1500, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    _app(
      SuperTabTasksView(
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
  );
  await tester.pumpAndSettle();
  return c;
}

Future<SuperTabController> _view(
  WidgetTester tester,
  ConversationServer server,
  String open,
) async {
  await tester.binding.setSurfaceSize(const Size(1500, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    _app(
      SuperTabView(
        controller: c,
        onInvite: () {},
        onAddAgent: (_) {},
        onOpenTerminal: (_) {},
        machineName: (_) => 'Team Mac',
      ),
    ),
  );
  await tester.pumpAndSettle();
  await c.select(open);
  await tester.pumpAndSettle();
  return c;
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

Iterable<Map> _commands(ConversationServer server, String type) => [
  for (final post in server.posts)
    if ((post['command'] as Map?)?['type'] == type) post['command'] as Map,
];

/// Task priorities P0–P3 on Desktop (task #3117): a badge on every card, the
/// Backlog's rows and the task header; P0 first wherever work is ordered.
void main() {
  test('each priority says what it means, and a task reads its effective '
      'one: the field, else the title marker, else P2', () {
    expect(
      [for (final p in SuperTabTaskPriority.values) (p.badge, p.meaning)],
      [
        ('P0', 'Hotfix: something shipped is broken'),
        ('P1', 'Needed by users soon'),
        ('P2', 'Planned goal'),
        ('P3', 'Tools, docs or process'),
      ],
    );
    SuperTabConversation task(String title, [String? priority]) =>
        SuperTabConversation.fromJson({
          ...conversationFixture('t', title),
          'priority': ?priority,
        });
    expect(task('A', 'P3').priority, 'P3');
    expect(task('A').priority, isNull);
    for (final (built, expected) in [
      (task('Fix it (urgent)', 'P3'), SuperTabTaskPriority.p3),
      (task('Fix it (urgent)'), SuperTabTaskPriority.p0),
      (task('URGENT: fix it'), SuperTabTaskPriority.p0),
      (task('Polish it (Scholes, high)'), SuperTabTaskPriority.p1),
      (task('Polish it'), SuperTabTaskPriority.p2),
      (task('Polish it', 'P9'), SuperTabTaskPriority.p2),
    ]) {
      expect(superTabTaskPriority(built), expected, reason: built.title);
    }
  });

  group('Tasks board', () {
    testWidgets('a P0 task created after a P2 task shows P0 on its card and '
        'leads Next up and Working', (tester) async {
      await _board(tester, _server());
      expect(_in(_card('hotfix'), 'P0'), findsOneWidget);
      expect(_in(_card('crash'), 'P0'), findsOneWidget);
      expect(_in(_card('preview'), 'P2'), findsOneWidget);
      expect(_in(_card('shipped-means'), 'P2'), findsOneWidget);
      // Today's order after the priority: the shared queue, newest first.
      expect(_cardsIn(tester, 'nextUp'), [
        'hotfix',
        'shipped-means',
        'preview',
        'third',
      ]);
      expect(_cardsIn(tester, 'working'), ['crash', 'tag']);
      // The badge leads the caption, which keeps its words.
      expect(
        tester.getTopLeft(_in(_card('crash'), 'P0')).dx,
        lessThan(tester.getTopLeft(_in(_card('crash'), 'Finch2')).dx),
      );
    });

    testWidgets('a legacy "(urgent)" title with no field shows P0, without '
        'its marker', (tester) async {
      final server = _server();
      _groups(server)
          .add(taskFixture('legacy', 'Round dial crashes (urgent)', 31));
      await _board(tester, server);
      expect(_in(_card('legacy'), 'P0'), findsOneWidget);
      expect(_in(_card('legacy'), 'Round dial crashes'), findsOneWidget);
      expect(find.textContaining('(urgent)'), findsNothing);
      expect(_cardsIn(tester, 'nextUp').take(2), ['hotfix', 'legacy']);
    });

    testWidgets('a proposal card shows its mapped badge and sorts by it', (
      tester,
    ) async {
      final server = _server();
      server.proposals['lead']!.first['priority'] = 'P1';
      await _board(tester, server);
      expect(_in(_card('p-new'), 'P1'), findsOneWidget);
      // None sent reads P2.
      expect(_in(_card('p-old'), 'P2'), findsOneWidget);
      expect(_cardsIn(tester, 'proposals'), ['p-new', 'p-old']);
    });
  });

  group('Next up moves stay inside their priority', () {
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

    testWidgets('a P2 card dragged above a P0 card goes first among the P2s', (
      tester,
    ) async {
      final server = _server();
      await _board(tester, server);
      await dragTo(
        tester,
        'third',
        tester.getTopLeft(_card('hotfix')) + const Offset(20, 2),
      );
      // Before `shipped-means`, the first P2 in the shared queue.
      expect(_commands(server, 'work.queue'), [
        {'type': 'work.queue', 'conversationId': 'third', 'after': null},
      ]);
      expect(_cardsIn(tester, 'nextUp'), [
        'hotfix',
        'third',
        'shipped-means',
        'preview',
      ]);
    });

    testWidgets('a P2 card dropped at the end of its band lands after the '
        'last P2, not before a P3 ranked between them', (tester) async {
      final server = _server();
      _groups(server).add({
        ...taskFixture('docs', 'Docs for the dial', 12),
        'priority': 'P3',
        'queueRank': 10.5,
      });
      await _board(tester, server);
      expect(_cardsIn(tester, 'nextUp'), [
        'hotfix',
        'shipped-means',
        'preview',
        'third',
        'docs',
      ]);
      Focus.of(tester.element(find.text('Shipped means merged')))
          .requestFocus();
      await tester.pump();
      for (var i = 0; i < 2; i++) {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.alt);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.alt);
        await tester.pumpAndSettle();
        Focus.of(tester.element(find.text('Shipped means merged')))
            .requestFocus();
        await tester.pump();
      }
      // A third ⌥↓ would leave the P2s: it does nothing.
      await tester.sendKeyDownEvent(LogicalKeyboardKey.alt);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.alt);
      await tester.pumpAndSettle();
      expect(_commands(server, 'work.queue'), [
        {
          'type': 'work.queue',
          'conversationId': 'shipped-means',
          'after': 'preview',
        },
        {
          'type': 'work.queue',
          'conversationId': 'shipped-means',
          'after': 'third',
        },
      ]);
      expect(_cardsIn(tester, 'nextUp'), [
        'hotfix',
        'preview',
        'third',
        'shipped-means',
        'docs',
      ]);
    });

    testWidgets('⌥↑ on the first P2 does not pass the P0 above it', (
      tester,
    ) async {
      final server = _server();
      await _board(tester, server);
      Focus.of(tester.element(find.text('Shipped means merged')))
          .requestFocus();
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.alt);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.alt);
      await tester.pumpAndSettle();
      expect(_commands(server, 'work.queue'), isEmpty);
      expect(_cardsIn(tester, 'nextUp').first, 'hotfix');
    });
  });

  group('Task header', () {
    final button = _key('super-task-priority');
    final header = _key('super-task-title');

    testWidgets('a task shows its badge between its number and title, and '
        'its menu lists the four meanings with the current one checked', (
      tester,
    ) async {
      await _view(tester, _server(), 'preview');
      expect(_in(button, 'P2'), findsOneWidget);
      final number = _in(header, '11');
      final title = _in(header, 'Remove the old preview route');
      expect(
        tester.getCenter(button).dx,
        greaterThan(tester.getTopLeft(number).dx),
      );
      expect(
        tester.getCenter(button).dx,
        lessThan(tester.getTopLeft(title).dx),
      );
      await tester.tap(button);
      await tester.pumpAndSettle();
      for (final meaning in [
        'Hotfix: something shipped is broken',
        'Needed by users soon',
        'Planned goal',
        'Tools, docs or process',
      ]) {
        expect(find.text(meaning), findsOneWidget, reason: meaning);
      }
      for (final p in ['p0', 'p1', 'p2', 'p3']) {
        expect(_key('super-task-priority-$p'), findsOneWidget, reason: p);
      }
    });

    testWidgets('choosing P0 sends work.priority and the badge follows', (
      tester,
    ) async {
      final server = _server();
      await _view(tester, server, 'preview');
      await tester.tap(button);
      await tester.pumpAndSettle();
      await tester.tap(_key('super-task-priority-p0'));
      await tester.pumpAndSettle();
      expect(_commands(server, 'work.priority'), [
        {
          'type': 'work.priority',
          'conversationId': 'preview',
          'priority': 'P0',
        },
      ]);
      expect(_in(button, 'P0'), findsOneWidget);
      expect(_key('super-task-priority-error'), findsNothing);
    });

    testWidgets('a refusal shows inline beside the title', (tester) async {
      final server = _server();
      await _view(tester, server, 'preview');
      server.refuse = {
        'code': 'COORDINATOR_REQUIRED',
        'message': 'Only a person or the PM can change a priority.',
      };
      await tester.tap(button);
      await tester.pumpAndSettle();
      await tester.tap(_key('super-task-priority-p1'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(_key('super-task-priority-error')).data,
        'Only a person or the PM can change a priority.',
      );
      expect(_in(button, 'P2'), findsOneWidget);
    });

    testWidgets('a legacy "(urgent)" title shows P0 without its marker', (
      tester,
    ) async {
      final server = _server();
      _groups(server)
          .add(taskFixture('legacy', 'Round dial crashes (urgent)', 31));
      await _view(tester, server, 'legacy');
      expect(_in(button, 'P0'), findsOneWidget);
      expect(_in(header, 'Round dial crashes'), findsOneWidget);
      expect(
        find.descendant(
          of: header,
          matching: find.textContaining('(urgent)', findRichText: true),
        ),
        findsNothing,
      );
    });

    testWidgets('the project chat and a step show no priority', (tester) async {
      final server = _server();
      _groups(server).add({
        ...taskFixture('review-step', 'Review', 32),
        'reviewOf': 'preview',
        'step': 'Review',
      });
      final c = await _view(tester, server, 'lead');
      expect(button, findsNothing);
      await c.select('review-step');
      await tester.pumpAndSettle();
      expect(button, findsNothing);
    });
  });

  group('Backlog', () {
    testWidgets('each row shows its Px badge, and P0 leads its group', (
      tester,
    ) async {
      final server = _server();
      // Waiting for a machine, newest first today: preview, shipped-means,
      // ask.
      _group(server, 'shipped-means')['priority'] = 'P0';
      _groups(server).add(taskFixture('ask', 'An old ask (Scholes, high)', 5));
      await tester.binding.setSurfaceSize(const Size(1100, 2000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await tester.pumpWidget(
        _app(
          SuperTabBacklogView(
            controller: c,
            onOpenConversation: (_) {},
            now: () => _now,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(_in(_row('shipped-means'), 'P0'), findsOneWidget);
      expect(_in(_row('ask'), 'P1'), findsOneWidget);
      expect(_in(_row('ask'), 'An old ask'), findsOneWidget);
      expect(_in(_row('preview'), 'P2'), findsOneWidget);
      expect(find.text('URGENT'), findsNothing);
      expect(find.text('HIGH'), findsNothing);
      double top(String id) => tester.getTopLeft(_row(id)).dy;
      expect(top('shipped-means'), lessThan(top('ask')));
      expect(top('ask'), lessThan(top('preview')));
    });
  });
}
