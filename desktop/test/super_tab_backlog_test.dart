import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/backlog.dart';
import 'package:harness/super_tabs/backlog_view.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/pull_request_facts.dart';

import 'support/super_tab_fixture.dart';

/// Manage ▸ Backlog (Scholes, task #2355): every task of the Swarm the reader
/// can read, across projects, in the groups of its state.
void main() {
  const now = 1793700000000;

  SuperTabConversation task({
    Map<String, dynamic>? assignment,
    Map<String, dynamic>? liveness,
    int? shippedAt,
  }) => SuperTabConversation.fromJson({
    ...conversationFixture('work', 'A task'),
    'number': 7,
    'assignment': ?assignment,
    'liveness': ?liveness,
    'shippedAt': ?shippedAt,
  });

  Map<String, dynamic> working(String status) => {
    'id': 'a1',
    'agentId': 'kestrel',
    'status': status,
  };

  group('each state lands in its group', () {
    for (final (name, built, expected) in [
      ('no assignment', task(), SuperTabBacklogGroup.waitingForMachine),
      (
        'queued for a machine',
        task(
          assignment: working('planned'),
          liveness: {'state': 'waiting', 'why': 'queued', 'since': now},
        ),
        SuperTabBacklogGroup.waitingForMachine,
      ),
      (
        'its agent lost',
        task(assignment: working('lost')),
        SuperTabBacklogGroup.waitingForMachine,
      ),
      (
        'stopped',
        task(assignment: working('stopped')),
        SuperTabBacklogGroup.waitingForMachine,
      ),
      // Review of #2776: the server marks these orphaned while the assignment
      // still reads working with an agent; each needs a new agent.
      for (final why in ['removed', 'unstarted', 'start-failed', 'lost'])
        (
          'orphaned: $why',
          task(
            assignment: working('working'),
            liveness: {'state': 'orphaned', 'why': why, 'since': now},
          ),
          SuperTabBacklogGroup.waitingForMachine,
        ),
      (
        'planned with an agent',
        task(assignment: working('planned')),
        SuperTabBacklogGroup.working,
      ),
      (
        'working',
        task(assignment: working('working')),
        SuperTabBacklogGroup.working,
      ),
      (
        'starting',
        task(
          assignment: working('working'),
          liveness: {'state': 'waiting', 'why': 'starting', 'since': now},
        ),
        SuperTabBacklogGroup.working,
      ),
      (
        'quiet',
        task(
          assignment: working('working'),
          liveness: {'state': 'quiet', 'since': now},
        ),
        SuperTabBacklogGroup.working,
      ),
      (
        'waiting on a person',
        task(
          assignment: working('working'),
          liveness: {
            'state': 'waiting',
            'why': 'person',
            'personId': 'scholes',
            'since': now,
          },
        ),
        SuperTabBacklogGroup.waitingOnSomeone,
      ),
      (
        'needs a person',
        task(assignment: working('needs_human')),
        SuperTabBacklogGroup.waitingOnSomeone,
      ),
      (
        'stuck',
        task(assignment: working('blocked')),
        SuperTabBacklogGroup.waitingOnSomeone,
      ),
      (
        'in review',
        task(assignment: working('review')),
        SuperTabBacklogGroup.inReview,
      ),
      (
        'fixing review findings',
        task(
          assignment: working('working'),
          liveness: {'state': 'waiting', 'why': 'revision', 'since': now},
        ),
        SuperTabBacklogGroup.inReview,
      ),
      (
        'done, not merged',
        task(assignment: working('done')),
        SuperTabBacklogGroup.readyToMerge,
      ),
      (
        'shipped',
        task(assignment: working('done'), shippedAt: now),
        SuperTabBacklogGroup.shipped,
      ),
      ('cancelled', task(assignment: working('cancelled')), null),
    ]) {
      test(name, () => expect(superTabBacklogGroupOf(built), expected));
    }
  });

  test('the groups read in order, as the mockup Scholes accepted', () {
    expect(SuperTabBacklogGroup.values.map((g) => g.label), [
      'Waiting for a machine',
      'Working',
      'Waiting on someone',
      'In review',
      'Ready to merge',
      'Shipped',
    ]);
  });

  test('lists every task across projects, newest first, and no project chat, '
      'Buddy chat, step or private chat', () async {
    final server = ConversationServer();
    server.state['projects'] = [
      projectFixture('lead', 'web-project', 'lead'),
      projectFixture('api', 'api', 'api-chat'),
    ];
    final conversations = server.state['conversations'] as List;
    (conversations[1] as Map)
      ..['projectId'] = 'lead'
      ..['number'] = 3;
    conversations.addAll(<Map<String, dynamic>>[
      {...conversationFixture('api-chat', 'api'), 'projectId': 'api'},
      {
        ...conversationFixture('api-task', 'Rate limits'),
        'projectId': 'api',
        'number': 9,
      },
      {
        ...conversationFixture('closed-task', 'Old fix'),
        'projectId': 'lead',
        'number': 1,
        'shippedAt': now,
      },
      {
        ...conversationFixture('review-step', 'Review: Rate limits'),
        'projectId': 'api',
        'number': 10,
        'reviewOf': 'api-task',
      },
      {
        ...conversationFixture('buddy', 'Wren'),
        'projectId': 'lead',
        'kind': 'buddy',
        'buddyOwnerId': 'owner',
      },
      {
        ...conversationFixture('private', 'Just us'),
        'projectId': 'lead',
        'audience': {
          'people': [
            {'id': 'owner'},
          ],
        },
      },
    ]);
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    expect(superTabBacklogTasks(c).map((t) => t.id), [
      'api-task',
      'offline',
      'closed-task',
    ]);
  });

  group('the Backlog view', () {
    final at = DateTime.fromMillisecondsSinceEpoch(now);

    /// A Swarm with two projects and a task in each group, Kestrel working on
    /// Mac Studio; Pilot asked for #12, the reader (owner) for the rest.
    ConversationServer swarm() {
      final server = ConversationServer();
      server.state['projects'] = [
        projectFixture('lead', 'web-project', 'lead'),
        projectFixture('api', 'api', 'api-chat'),
      ];
      (server.state['people'] as List).add({
        'id': 'pilot',
        'email': 'pilot@example.com',
        'username': 'pilot',
        'role': 'collaborator',
      });
      server.state['agents'] = [
        {
          'id': 'kestrel',
          'name': 'Builder',
          'displayName': 'Kestrel',
          'machineId': 'studio',
          'harnessId': 'h1',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      server.state['machines'] = [
        {'machineId': 'studio', 'name': 'Mac Studio'},
      ];
      final conversations = server.state['conversations'] as List;
      conversations.removeWhere((g) => (g as Map)['id'] == 'offline');
      Map<String, dynamic> work(
        String id,
        int number,
        String title, {
        String project = 'lead',
        String requester = 'owner',
        String? status,
        Map<String, dynamic>? liveness,
        int? shippedAt,
        String? pr,
      }) => {
        ...conversationFixture(id, title),
        'projectId': project,
        'number': number,
        'requesterId': requester,
        'agentIds': [if (status != null) 'kestrel'],
        if (status != null)
          'assignment': {
            'id': 'a-$id',
            'agentId': 'kestrel',
            'status': status,
            'progressAt': now,
            'execution': {'machineId': 'studio', 'harnessId': 'h1'},
          },
        'liveness': ?liveness,
        'shippedAt': ?shippedAt,
        if (pr != null) 'pullRequestUrls': [pr],
      };
      conversations.addAll(<Map<String, dynamic>>[
        {...conversationFixture('api-chat', 'api'), 'projectId': 'api'},
        work('queued', 10, 'New session starts on last project'),
        work(
          'working',
          11,
          'Sidebar task groups',
          status: 'working',
          pr: 'https://github.com/acme/app/pull/2733',
        ),
        work(
          'asking',
          12,
          'Machine names',
          project: 'api',
          requester: 'pilot',
          status: 'working',
          liveness: {
            'state': 'waiting',
            'why': 'person',
            'personId': 'pilot',
            'since': now,
          },
        ),
        work('review', 13, 'Thread reply bar', status: 'review'),
        work('done', 14, 'Status menu fixture', status: 'done'),
        work(
          'shipped',
          15,
          'GitHub line',
          status: 'done',
          shippedAt: now,
          pr: 'https://github.com/acme/app/pull/2713',
        ),
        {
          ...work('private', 16, 'Just us'),
          'audience': {
            'people': [
              {'id': 'owner'},
            ],
          },
        },
      ]);
      return server;
    }

    final opened = <String>[];
    late SuperTabController shown;

    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server, {
      SuperTabPullRequestFacts? facts,
    }) async {
      opened.clear();
      final c = shown = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await tester.binding.setSurfaceSize(const Size(1100, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: ListenableBuilder(
              listenable: c,
              builder: (context, _) => SuperTabBacklogView(
                controller: c,
                facts: facts,
                onOpenConversation: opened.add,
                // Five minutes after #11 last changed (the fixture's own
                // clock), for its row's age.
                now: () => (c.groupChangedAt('working') ?? at).add(
                  const Duration(minutes: 5),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return c;
    }

    Finder row(String id) => find.byKey(ValueKey('super-backlog-row-$id'));
    Finder header(SuperTabBacklogGroup g) =>
        find.byKey(ValueKey('super-backlog-group-${g.name}'));
    List<String> listed(WidgetTester tester) => [
      for (final e
          in find
              .byWidgetPredicate(
                (w) =>
                    w.key is ValueKey<String> &&
                    (w.key! as ValueKey<String>).value.startsWith(
                      'super-backlog-row-',
                    ),
              )
              .evaluate())
        (e.widget.key! as ValueKey<String>).value.substring(
          'super-backlog-row-'.length,
        ),
    ];
    String rowText(WidgetTester tester, String id) => [
      for (final t in tester.widgetList<Text>(
        find.descendant(of: row(id), matching: find.byType(Text)),
      ))
        t.data ?? t.textSpan?.toPlainText() ?? '',
    ].join(' | ');

    testWidgets('groups in order with their counts, each row its two lines', (
      tester,
    ) async {
      await show(tester, swarm());
      for (final (group, count) in [
        (SuperTabBacklogGroup.waitingForMachine, 1),
        (SuperTabBacklogGroup.working, 1),
        (SuperTabBacklogGroup.waitingOnSomeone, 1),
        (SuperTabBacklogGroup.inReview, 1),
        (SuperTabBacklogGroup.readyToMerge, 1),
        (SuperTabBacklogGroup.shipped, 1),
      ]) {
        expect(
          find.descendant(
            of: header(group),
            matching: find.text('${group.label} · $count'),
          ),
          findsOneWidget,
          reason: group.label,
        );
      }
      // The groups' order, top to bottom.
      final tops = [
        for (final g in SuperTabBacklogGroup.values)
          tester.getTopLeft(header(g)).dy,
      ];
      expect(tops, [...tops]..sort());
      expect(listed(tester), [
        'queued',
        'working',
        'asking',
        'review',
        'done',
        'shipped',
      ]);
      expect(find.text('6 tasks'), findsOneWidget);
      // Line one: number and title, project and who asked; line two: agent,
      // machine, pull request, what it waits on; then how long ago.
      final working = rowText(tester, 'working');
      expect(working, contains('#11 Sidebar task groups'));
      expect(working, contains('web-project · owner'));
      expect(working, contains('Kestrel · Mac Studio · PR #2733'));
      expect(working, contains('5m'));
      expect(rowText(tester, 'asking'), contains('api · pilot'));
      expect(rowText(tester, 'asking'), contains('Waiting on pilot'));
      expect(rowText(tester, 'queued'), contains('No agent yet'));
      expect(rowText(tester, 'shipped'), contains('PR #2713'));
    });

    testWidgets('a task the reader cannot read is absent, even when a server '
        'sends it', (tester) async {
      final server = swarm()..parts.leaksHiddenGroups = true;
      (server.state['conversations'] as List).add({
        ...conversationFixture('secret', 'Pilot only'),
        'projectId': 'lead',
        'number': 17,
        'audience': {
          'people': [
            {'id': 'pilot'},
          ],
        },
      });
      await show(tester, server);
      expect(shown.snapshot!.conversation('secret'), isNotNull);
      expect(row('secret'), findsNothing);
      expect(row('private'), findsNothing);
      expect(listed(tester), hasLength(6));
    });

    testWidgets('Mine shows only the tasks the reader asked for', (
      tester,
    ) async {
      await show(tester, swarm());
      await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
      await tester.pumpAndSettle();
      expect(listed(tester), isNot(contains('asking')));
      expect(listed(tester), hasLength(5));
      expect(find.text('5 tasks'), findsOneWidget);
    });

    testWidgets('the project and state filters narrow the list and the count', (
      tester,
    ) async {
      await show(tester, swarm());
      await tester.tap(find.byKey(const ValueKey('super-backlog-project')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('api').last);
      await tester.pumpAndSettle();
      expect(listed(tester), ['asking']);
      expect(find.text('1 task'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('super-backlog-project')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('All projects').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-backlog-state')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('In review').last);
      await tester.pumpAndSettle();
      expect(listed(tester), ['review']);
      expect(header(SuperTabBacklogGroup.working), findsNothing);
    });

    // Review of #2776: GitHub's answer lands after the first frame, in a quiet
    // Swarm where nothing else rebuilds the tab.
    testWidgets('a row shows its pull request\'s checks once GitHub answers', (
      tester,
    ) async {
      final answer = Completer<Map<String, dynamic>>();
      final facts = SuperTabPullRequestFacts((_) => answer.future);
      addTearDown(facts.dispose);
      await show(tester, swarm(), facts: facts);
      expect(rowText(tester, 'working'), isNot(contains('checks passed')));
      answer.complete({
        'account': 'ada',
        'rows': [
          {
            'url': 'https://github.com/acme/app/pull/2733',
            'status': 'found',
            'title': 'Sidebar task groups',
            'state': 'Open',
            'checks': {'passed': 12, 'failed': 0, 'pending': 0, 'total': 12},
          },
        ],
      });
      await tester.pump();
      await tester.pump();
      expect(rowText(tester, 'working'), contains('PR #2733 12 checks passed'));
    });

    testWidgets('clicking a row opens its chat', (tester) async {
      await show(tester, swarm());
      await tester.tap(row('review'));
      await tester.pump();
      expect(opened, ['review']);
    });

    testWidgets('a task that moves while it shows moves to its new group, and '
        'the filters keep their values', (tester) async {
      final server = swarm();
      await show(tester, server);
      await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
      await tester.pumpAndSettle();
      ((server.state['conversations'] as List).firstWhere(
        (g) => (g as Map)['id'] == 'working',
      ) as Map)['assignment']['status'] = 'review';
      server.revision++;
      await shown.refresh();
      await tester.pumpAndSettle();
      final review = tester.getTopLeft(header(SuperTabBacklogGroup.inReview));
      expect(tester.getTopLeft(row('working')).dy, greaterThan(review.dy));
      expect(find.text('5 tasks'), findsOneWidget);
    });

    testWidgets('no tasks, and none asked for by the reader, each say so', (
      tester,
    ) async {
      final server = ConversationServer();
      (server.state['conversations'] as List).removeWhere(
        (g) => (g as Map)['id'] == 'offline',
      );
      await show(tester, server);
      expect(find.text('No tasks'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      final other = swarm();
      for (final g in (other.state['conversations'] as List)) {
        (g as Map)['requesterId'] = 'pilot';
      }
      await show(tester, other);
      await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
      await tester.pumpAndSettle();
      expect(find.text('No tasks you asked for'), findsOneWidget);
      expect(find.text('0 tasks'), findsOneWidget);
    });

    testWidgets('a shipped task whose agent was removed still shows', (
      tester,
    ) async {
      final server = swarm();
      server.state['agents'] = <dynamic>[];
      await show(tester, server);
      expect(rowText(tester, 'shipped'), contains('Agent unavailable'));
    });
  });
}
