import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/tasks_view.dart';

import 'super_tab_tasks_view_test.dart' show taskFixture, tasksServer;
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

final _now = DateTime(2026, 11, 4, 9);

/// A project's process preset (task #3897, the contract of #3896): `process`
/// and `columns` in the head, nothing from an older server.
Map<String, dynamic> _project([Map<String, dynamic> extra = const {}]) => {
  'id': 'scout',
  'name': 'scout',
  'ownerId': 'owner',
  'leadConversationId': 'scout-lead',
  ...extra,
};

void main() {
  group('the model reads a project\'s process', () {
    test('no process, from an older server, is Full with the six columns', () {
      final project = SuperTabProject.fromJson(_project());
      expect(project.process, SuperTabProcess.full);
      expect(project.isSimple, isFalse);
      expect(project.columnTitle('nextUp'), isNull);
    });

    test('simple reads with the server\'s three columns and their titles', () {
      final project = SuperTabProject.fromJson(
        _project({
          'process': 'simple',
          'columns': [
            {'id': 'todo', 'title': 'To do'},
            {'id': 'doing', 'title': 'Doing'},
            {'id': 'done', 'title': 'Done'},
          ],
        }),
      );
      expect(project.process, SuperTabProcess.simple);
      expect(project.isSimple, isTrue);
      expect(project.columnIds, ['todo', 'doing', 'done']);
      expect(project.columnTitle('doing'), 'Doing');
    });

    test('an unknown value, or a column without an id, is Full', () {
      expect(
        SuperTabProject.fromJson(_project({'process': 'custom'})).process,
        SuperTabProcess.full,
      );
      final project = SuperTabProject.fromJson(
        _project({
          'process': 'full',
          'columns': [
            {'title': 'No id'},
            'junk',
            {'id': 'working', 'title': 'Working'},
          ],
        }),
      );
      expect(project.columnIds, ['working']);
    });
  });

  group('the Board draws the project\'s preset', () {
    /// The tasks of the Tasks view's mockup, plus one in review and one done
    /// and waiting for its merge: what Full words and Simple does not.
    ConversationServer boardServer({required bool simple}) {
      final server = tasksServer();
      (server.state['conversations'] as List<Map<String, dynamic>>).addAll([
        taskFixture(
          'reviewing',
          'Reading a change',
          14,
          requester: 'owner',
          status: 'working',
          liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
        ),
        taskFixture(
          'waiting-merge',
          'Done, not merged yet',
          15,
          requester: 'owner',
          status: 'done',
          pullRequest: 2880,
        ),
      ]);
      if (simple) {
        final project = (server.state['projects'] as List).single as Map;
        project['process'] = 'simple';
        project['columns'] = [
          {'id': 'todo', 'title': 'To do'},
          {'id': 'doing', 'title': 'Doing'},
          {'id': 'done', 'title': 'Done'},
        ];
      }
      return server;
    }

    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server,
    ) async {
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

    Finder column(String name) =>
        find.byKey(ValueKey('super-tasks-column-$name'));
    Finder card(String id) => find.byKey(ValueKey('super-task-card-$id'));
    Finder inColumn(String name, String id) =>
        find.descendant(of: column(name), matching: card(id));

    Future<void> close(WidgetTester tester, SuperTabController c) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }

    testWidgets('a Simple project has To do, Doing and Done, and no more', (
      tester,
    ) async {
      final c = await show(tester, boardServer(simple: true));
      for (final name in ['nextUp', 'working', 'done']) {
        expect(column(name), findsOneWidget, reason: name);
      }
      for (final name in ['proposals', 'merged', 'shipped']) {
        expect(column(name), findsNothing, reason: name);
      }
      for (final (name, title) in [
        ('nextUp', 'To do'),
        ('working', 'Doing'),
        ('done', 'Done'),
      ]) {
        expect(
          find.descendant(of: column(name), matching: find.text(title)),
          findsOneWidget,
          reason: title,
        );
      }
      expect(find.text('Next up'), findsNothing);
      expect(find.text('Working'), findsNothing);
      await close(tester, c);
    });

    testWidgets('a Simple Board loses no card: proposals wait in To do, '
        'merged and shipped work is Done', (tester) async {
      final c = await show(tester, boardServer(simple: true));
      for (final id in ['shipped-means', 'preview', 'p-new', 'p-old']) {
        expect(inColumn('nextUp', id), findsOneWidget, reason: id);
      }
      for (final id in ['tag', 'test-copy', 'reviewing']) {
        expect(inColumn('working', id), findsOneWidget, reason: id);
      }
      for (final id in ['waiting-merge', 'sender']) {
        expect(inColumn('done', id), findsOneWidget, reason: id);
      }
      await close(tester, c);
    });

    testWidgets('a Simple card says nothing of review or merge; a Full one '
        'does', (tester) async {
      var c = await show(tester, boardServer(simple: true));
      expect(find.text('in review'), findsNothing);
      expect(find.textContaining('waiting to merge'), findsNothing);
      await close(tester, c);
      c = await show(tester, boardServer(simple: false));
      expect(find.textContaining('in review'), findsOneWidget);
      expect(find.textContaining('waiting to merge'), findsOneWidget);
      await close(tester, c);
    });

    testWidgets('a Full project, and one from an older server, keeps the six '
        'columns', (tester) async {
      final c = await show(tester, boardServer(simple: false));
      for (final (name, title) in [
        ('proposals', 'Proposal'),
        ('nextUp', 'Next up'),
        ('working', 'Working'),
        ('done', 'Done'),
        ('merged', 'Merged'),
        ('shipped', 'Shipped'),
      ]) {
        expect(
          find.descendant(of: column(name), matching: find.text(title)),
          findsOneWidget,
          reason: title,
        );
      }
      await close(tester, c);
    });

    testWidgets('List follows the preset too', (tester) async {
      final c = await show(tester, boardServer(simple: true));
      await tester.tap(find.byKey(const ValueKey('super-tasks-layout-list')));
      await tester.pumpAndSettle();
      for (final name in ['nextUp', 'working', 'done']) {
        expect(
          find.byKey(ValueKey('super-tasks-heading-$name')),
          findsOneWidget,
          reason: name,
        );
      }
      for (final name in ['proposals', 'merged', 'shipped']) {
        expect(
          find.byKey(ValueKey('super-tasks-heading-$name')),
          findsNothing,
          reason: name,
        );
      }
      await close(tester, c);
    });
  });
}
