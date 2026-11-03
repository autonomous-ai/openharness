import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/task_groups.dart';

import 'support/super_tab_fixture.dart';

/// Two projects: web-project (chat `lead`) with one task in each group and two
/// working, and alpha (chat `alpha-chat`) with one working task. Every chat is
/// read unless a test says otherwise.
ConversationServer groupedServer() {
  final server = ConversationServer();
  server.state['projects'] = [
    projectFixture('lead', 'web-project', 'lead'),
    projectFixture('alpha', 'alpha', 'alpha-chat'),
  ];
  Map<String, dynamic> task(
    String id,
    String projectId,
    int number, {
    String? status,
    Map<String, dynamic>? liveness,
  }) => {
    ...conversationFixture(id, id),
    'projectId': projectId,
    'number': number,
    if (status != null)
      'assignment': {'agentId': 'a1', 'status': status, 'progressAt': 1},
    'liveness': ?liveness,
  };
  (server.state['conversations'] as List)
    ..removeWhere((g) => (g as Map)['id'] == 'offline')
    ..addAll(<Map<String, dynamic>>[
      task(
        'mine',
        'lead',
        15,
        status: 'needs_human',
        liveness: {
          'state': 'waiting',
          'why': 'person',
          'personId': 'owner',
          'since': 1,
        },
      ),
      task('busy-old', 'lead', 13, status: 'working'),
      task('busy-new', 'lead', 16, status: 'working'),
      task(
        'review',
        'lead',
        14,
        status: 'review',
        liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
      ),
      task('quiet-chat', 'lead', 12),
      {...conversationFixture('alpha-chat', 'alpha'), 'projectId': 'alpha'},
      task('alpha-busy', 'alpha', 3, status: 'working'),
    ]);
  return server;
}

Future<SuperTabController> pumpGrouped(
  WidgetTester tester,
  ConversationServer server, {
  Size size = const Size(1300, 1600),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  await c.refresh();
  for (final project in ['lead', 'alpha']) {
    if (!c.expandedProjects.contains(project)) c.toggleProject(project);
  }
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: ListenableBuilder(
          listenable: c,
          builder: (context, _) => ProjectSidebar(
            controller: c,
            needsHuman: (_) => 0,
            onSelect: c.select,
            attention: SuperTabAttention.of(c),
            activity: SuperTabActivity.of(c),
            onNotifications: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> closeGrouped(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

Finder heading(String project, SuperTabTaskGroup group) =>
    find.byKey(ValueKey('super-task-group-$project-${group.name}'));
Finder row(String id) => find.byKey(ValueKey('super-group-$id'));

/// A project's open tasks in the sidebar, in four foldable groups (Huy, #2309): Needs you, Working, Waiting on
/// others, The rest.
void main() {
  SuperTabConversation task({String? status, Map<String, dynamic>? liveness}) =>
      SuperTabConversation.fromJson({
        ...conversationFixture('t', 'Task'),
        if (status != null)
          'assignment': {'agentId': 'a1', 'status': status, 'progressAt': 1},
        'liveness': ?liveness,
      });
  Map<String, dynamic> waiting(String why, {String? personId}) => {
    'state': 'waiting',
    'why': why,
    'since': 1,
    'personId': ?personId,
  };

  group('which group a task is in', () {
    SuperTabTaskGroup of(
      SuperTabConversation g, {
      int mentions = 0,
      int needsHuman = 0,
    }) => superTabTaskGroupOf(
      g,
      readerId: 'me',
      mentions: mentions,
      needsHuman: needsHuman,
    );

    test('the groups read in the sidebar\'s order, The rest folded', () {
      expect(SuperTabTaskGroup.values.map((g) => g.label), [
        'Needs you',
        'Working',
        'Waiting on others',
        'The rest',
      ]);
      expect(SuperTabTaskGroup.values.where((g) => g.foldedByDefault), [
        SuperTabTaskGroup.rest,
      ]);
    });

    test(
      'a task that tags the reader needs them, whatever else it waits on',
      () {
        expect(of(task(), mentions: 1), SuperTabTaskGroup.needsYou);
        expect(
          of(
            task(
              status: 'needs_human',
              liveness: waiting('person', personId: 'other'),
            ),
            mentions: 2,
          ),
          SuperTabTaskGroup.needsYou,
        );
      },
    );

    test('a wait on the reader, or on no one named, needs them', () {
      expect(
        of(
          task(
            status: 'needs_human',
            liveness: waiting('person', personId: 'me'),
          ),
        ),
        SuperTabTaskGroup.needsYou,
      );
      expect(
        of(task(status: 'needs_human', liveness: waiting('person'))),
        SuperTabTaskGroup.needsYou,
      );
    });

    test('a question left unanswered past quiet still needs the reader', () {
      // An agent at a question makes no progress: after 30 minutes the
      // backend marks its task quiet (liveness.ts TASK_QUIET_MS).
      expect(
        of(
          task(status: 'working', liveness: {'state': 'quiet', 'since': 1}),
          needsHuman: 1,
        ),
        SuperTabTaskGroup.needsYou,
      );
    });

    test('a question in a working task\'s terminal needs the reader', () {
      expect(
        of(task(status: 'working'), needsHuman: 1),
        SuperTabTaskGroup.needsYou,
      );
    });

    test('a wait on another person, a review, a revision, a block or a machine waits on others', () {
      for (final g in [
        task(
          status: 'needs_human',
          liveness: waiting('person', personId: 'other'),
        ),
        task(status: 'review', liveness: waiting('review')),
        task(status: 'working', liveness: waiting('revision')),
        task(status: 'blocked', liveness: waiting('blocked')),
        task(status: 'working', liveness: waiting('queued')),
      ]) {
        expect(
          of(g, needsHuman: 1),
          SuperTabTaskGroup.waitingOnOthers,
          reason: '${g.liveness}',
        );
      }
    });

    test('a stuck task waits on others: the PM hands it on', () {
      expect(
        of(task(status: 'working', liveness: {'state': 'quiet', 'since': 1})),
        SuperTabTaskGroup.waitingOnOthers,
      );
      expect(
        of(
          task(
            status: 'working',
            liveness: {'state': 'orphaned', 'why': 'lost', 'since': 1},
          ),
        ),
        SuperTabTaskGroup.waitingOnOthers,
      );
    });

    test('a task moving or starting its agent is working', () {
      expect(of(task(status: 'working')), SuperTabTaskGroup.working);
      expect(of(task(status: 'planned')), SuperTabTaskGroup.working);
      expect(
        of(task(status: 'working', liveness: waiting('starting'))),
        SuperTabTaskGroup.working,
      );
    });

    test('anything else is the rest', () {
      expect(of(task()), SuperTabTaskGroup.rest);
      expect(of(task(status: 'done')), SuperTabTaskGroup.rest);
      expect(of(task(status: 'stopped')), SuperTabTaskGroup.rest);
      expect(
        of(
          task(
            status: 'working',
            liveness: {'state': 'unheard-of', 'since': 1},
          ),
        ),
        SuperTabTaskGroup.rest,
      );
    });
  });

  group('the sidebar lists a project\'s tasks in its groups', () {
    testWidgets(
      'headings in order with their counts, each task under its own, newest first',
      (tester) async {
        final c = await pumpGrouped(tester, groupedServer());
        final top = {
          for (final g in SuperTabTaskGroup.values)
            g: tester.getTopLeft(heading('lead', g)).dy,
        };
        expect(
          SuperTabTaskGroup.values.map((g) => top[g]).toList(),
          orderedEquals([...top.values]..sort()),
        );
        for (final (g, count) in [
          (SuperTabTaskGroup.needsYou, '1'),
          (SuperTabTaskGroup.working, '2'),
          (SuperTabTaskGroup.waitingOnOthers, '1'),
          (SuperTabTaskGroup.rest, '1'),
        ]) {
          expect(
            find.descendant(
              of: heading('lead', g),
              matching: find.text(g.label),
            ),
            findsOneWidget,
          );
          expect(
            find.descendant(of: heading('lead', g), matching: find.text(count)),
            findsOneWidget,
            reason: g.label,
          );
        }
        double y(String id) => tester.getTopLeft(row(id)).dy;
        expect(y('mine'), greaterThan(top[SuperTabTaskGroup.needsYou]!));
        expect(y('mine'), lessThan(top[SuperTabTaskGroup.working]!));
        expect(y('busy-new'), greaterThan(top[SuperTabTaskGroup.working]!));
        expect(y('busy-new'), lessThan(y('busy-old')));
        expect(
          y('busy-old'),
          lessThan(top[SuperTabTaskGroup.waitingOnOthers]!),
        );
        expect(
          y('review'),
          greaterThan(top[SuperTabTaskGroup.waitingOnOthers]!),
        );
        expect(y('review'), lessThan(top[SuperTabTaskGroup.rest]!));
        await closeGrouped(tester, c);
      },
    );

    testWidgets(
      'The rest starts folded; its heading shows and hides its tasks',
      (tester) async {
        final c = await pumpGrouped(tester, groupedServer());
        expect(heading('lead', SuperTabTaskGroup.rest), findsOneWidget);
        expect(row('quiet-chat'), findsNothing);
        await tester.tap(heading('lead', SuperTabTaskGroup.rest));
        await tester.pumpAndSettle();
        expect(row('quiet-chat'), findsOneWidget);
        await tester.tap(heading('lead', SuperTabTaskGroup.rest));
        await tester.pumpAndSettle();
        expect(row('quiet-chat'), findsNothing);
        await closeGrouped(tester, c);
      },
    );

    testWidgets(
      'a fold is the project\'s own, and outlasts hiding the project',
      (tester) async {
        final c = await pumpGrouped(tester, groupedServer());
        await tester.tap(heading('lead', SuperTabTaskGroup.working));
        await tester.pumpAndSettle();
        expect(row('busy-new'), findsNothing);
        expect(row('alpha-busy'), findsOneWidget);
        c.toggleProject('lead');
        await tester.pumpAndSettle();
        expect(heading('lead', SuperTabTaskGroup.working), findsNothing);
        c.toggleProject('lead');
        await tester.pumpAndSettle();
        expect(heading('lead', SuperTabTaskGroup.working), findsOneWidget);
        expect(row('busy-new'), findsNothing);
        await closeGrouped(tester, c);
      },
    );

    testWidgets(
      'the open chat in a folded group still shows under its heading',
      (tester) async {
        final c = await pumpGrouped(tester, groupedServer());
        await c.select('quiet-chat');
        await tester.pumpAndSettle();
        expect(row('quiet-chat'), findsOneWidget);
        expect(
          tester.getTopLeft(row('quiet-chat')).dy,
          greaterThan(
            tester.getTopLeft(heading('lead', SuperTabTaskGroup.rest)).dy,
          ),
        );
        await closeGrouped(tester, c);
      },
    );

    testWidgets(
      'under the unread filter, groups list only unread tasks and count those',
      (tester) async {
        final server = groupedServer();
        for (final g
            in (server.state['conversations'] as List)
                .cast<Map<String, dynamic>>()) {
          if (g['id'] == 'busy-old' || g['id'] == 'quiet-chat')
            g['lastMessageSequence'] = 5;
        }
        final c = await pumpGrouped(tester, server);
        c.toggleUnreadOnly();
        await tester.pumpAndSettle();
        expect(heading('lead', SuperTabTaskGroup.needsYou), findsNothing);
        expect(
          heading('lead', SuperTabTaskGroup.waitingOnOthers),
          findsNothing,
        );
        expect(row('busy-old'), findsOneWidget);
        expect(row('busy-new'), findsNothing);
        expect(
          find.descendant(
            of: heading('lead', SuperTabTaskGroup.working),
            matching: find.text('1'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: heading('lead', SuperTabTaskGroup.rest),
            matching: find.text('1'),
          ),
          findsOneWidget,
        );
        expect(row('quiet-chat'), findsNothing);
        await closeGrouped(tester, c);
      },
    );

    testWidgets('Tab reaches a heading, and Enter folds it', (tester) async {
      final c = await pumpGrouped(tester, groupedServer());
      const key = ValueKey('super-task-group-lead-needsYou');
      bool onHeading() {
        final focused = tester.binding.focusManager.primaryFocus?.context;
        if (focused == null) return false;
        var found = focused.widget.key == key;
        focused.visitAncestorElements((e) {
          if (e.widget.key == key) found = true;
          return !found;
        });
        return found;
      }

      for (var i = 0; i < 60 && !onHeading(); i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
      }
      expect(onHeading(), isTrue);
      expect(row('mine'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(row('mine'), findsNothing);
      await closeGrouped(tester, c);
    });

    testWidgets(
      'a phone-wide sidebar, as the web app draws it on a phone, shows the same groups',
      (tester) async {
        final c = await pumpGrouped(
          tester,
          groupedServer(),
          size: const Size(390, 844),
        );
        for (final g in SuperTabTaskGroup.values) {
          expect(heading('lead', g), findsOneWidget, reason: g.label);
        }
        expect(tester.takeException(), isNull);
        await closeGrouped(tester, c);
      },
    );
  });

  group('next unread follows the groups', () {
    testWidgets(
      'each project\'s chat, then its tasks in group order, each group newest first',
      (tester) async {
        final server = groupedServer();
        final c = server.controller();
        await c.refresh();
        expect(superTabSidebarOrder(c), [
          'alpha-chat',
          'alpha-busy',
          'lead',
          'mine',
          'busy-new',
          'busy-old',
          'review',
          'quiet-chat',
        ]);
        await c.flush();
        c.dispose();
      },
    );
  });
}
