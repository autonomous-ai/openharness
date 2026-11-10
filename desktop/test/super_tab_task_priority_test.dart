import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/task_priority.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

Finder _key(String key) => find.byKey(ValueKey(key));
Finder _in(Finder of, String text) =>
    find.descendant(of: of, matching: find.text(text, findRichText: true));

List<Map<String, dynamic>> _groups(ConversationServer server) =>
    (server.state['conversations'] as List).cast<Map<String, dynamic>>();

/// A task of project `lead`, numbered [number].
Map<String, dynamic> _task(String id, String title, int number) => {
  ...conversationFixture(id, title),
  'projectId': 'lead',
  'number': number,
};

/// Project openharness with one task, `preview` (#11), which the server says is P2.
ConversationServer _server() {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
  _groups(server).add({
    ..._task('preview', 'Remove the old preview route', 11),
    'priority': 'P2',
  });
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

Iterable<Map> _commands(ConversationServer server, String type) => [
  for (final post in server.posts)
    if ((post['command'] as Map?)?['type'] == type) post['command'] as Map,
];

/// Task priorities P0–P3 on Desktop (task #3117): the task header's badge and
/// its menu.
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
      _groups(server).add(_task('legacy', 'Round dial crashes (urgent)', 31));
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
        ..._task('review-step', 'Review', 32),
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
}
