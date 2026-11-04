import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
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
      test(
        name,
        () => expect(
          superTabBacklogGroupOf(
            built,
            DateTime.fromMillisecondsSinceEpoch(now),
          ),
          expected,
        ),
      );
    }
  });

  group('Shipped means merged, as the server tells it (task #2558)', () {
    final at = DateTime.fromMillisecondsSinceEpoch(now);
    const day = 86400000;
    const own = 'https://github.com/acme/app/pull/7';
    const batch = 'https://github.com/acme/app/pull/8';

    /// A task as the read path answers it (backend superTabRead.test.ts): the
    /// first Done sets shippedAt; only a recorded merge sets a card's mergedAt.
    SuperTabBacklogGroup? placed(
      String status, {
      int? shippedAt = now,
      List<String> urls = const [own],
      List<Map<String, dynamic>>? cards,
      bool archived = false,
      bool dormant = false,
    }) => superTabBacklogGroupOf(
      SuperTabConversation.fromJson({
        ...conversationFixture('work', 'A task'),
        'assignment': working(status),
        'shippedAt': ?shippedAt,
        'pullRequestUrls': urls,
        'cards': {
          'pullRequests':
              cards ??
              [
                for (final url in urls) {'url': url, 'messageId': 'm-$url'},
              ],
        },
        if (archived) 'archived': true,
        if (dormant) 'dormant': true,
      }),
      at,
    );
    Map<String, dynamic> merged(String url, {int at = now}) => {
      'url': url,
      'messageId': 'm-$url',
      'mergedAt': at,
    };

    test('a Done task with an open pull request is Ready to merge', () {
      expect(placed('done'), SuperTabBacklogGroup.readyToMerge);
    });

    test('a Done task whose link has no card yet is Ready to merge', () {
      expect(
        placed('done', cards: const []),
        SuperTabBacklogGroup.readyToMerge,
      );
    });

    test('a task whose pull request merged is Shipped', () {
      expect(
        placed('done', cards: [merged(own)]),
        SuperTabBacklogGroup.shipped,
      );
    });

    test('a merge recorded on a batch pull request counts, its own closed', () {
      expect(
        placed(
          'done',
          urls: const [own, batch],
          cards: [
            {'url': own, 'messageId': 'm1'},
            merged(batch),
          ],
        ),
        SuperTabBacklogGroup.shipped,
      );
    });

    test('a Done task with no pull request has nothing to merge: Shipped', () {
      expect(placed('done', urls: const []), SuperTabBacklogGroup.shipped);
    });

    test('Ready to merge stays after a day quiet, while its window lasts', () {
      expect(placed('done', dormant: true), SuperTabBacklogGroup.readyToMerge);
      expect(placed('done', dormant: true, shippedAt: now - 8 * day), isNull);
    });

    test('an archived task whose pull request never merged is not listed', () {
      expect(placed('done', archived: true), isNull);
    });

    test('work back on after its first Done goes by its state', () {
      expect(placed('working'), SuperTabBacklogGroup.working);
      expect(placed('working', urls: const []), SuperTabBacklogGroup.working);
    });

    test('merged long ago and back at work is listed as Working', () {
      expect(
        placed(
          'working',
          shippedAt: now - 8 * day,
          cards: [merged(own, at: now - 8 * day)],
        ),
        SuperTabBacklogGroup.working,
      );
    });
  });

  group('Shipped looks back 7 days, and a closed task only counts shipped', () {
    final at = DateTime.fromMillisecondsSinceEpoch(now);
    const day = 86400000;

    test('a task shipped within 7 days is listed, an older one is not', () {
      expect(
        superTabBacklogGroupOf(
          task(assignment: working('done'), shippedAt: now - 7 * day),
          at,
        ),
        SuperTabBacklogGroup.shipped,
      );
      expect(
        superTabBacklogGroupOf(
          task(assignment: working('done'), shippedAt: now - 7 * day - 1),
          at,
        ),
        isNull,
      );
    });

    test('a task closed without shipping is on its way nowhere', () {
      for (final closed in const [
        {'archived': true},
        {'dormant': true},
      ]) {
        final group = SuperTabConversation.fromJson({
          ...conversationFixture('work', 'A task'),
          'assignment': working('stopped'),
          ...closed,
        });
        expect(superTabBacklogGroupOf(group, at), isNull);
      }
    });

    test('an archived task that shipped stays in Shipped', () {
      final group = SuperTabConversation.fromJson({
        ...conversationFixture('work', 'A task'),
        'assignment': working('done'),
        'archived': true,
        'shippedAt': now,
      });
      expect(superTabBacklogGroupOf(group, at), SuperTabBacklogGroup.shipped);
    });
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

  // Task #2774 (Scholes's mockup): tasks carry no priority field; the badge
  // reads the title's own marker, which the row then drops.
  test('a title\'s URGENT or "(Name, high)" marker is its priority badge', () {
    for (final (title, priority, shown) in [
      (
        'URGENT: agents\' GitHub tokens also carry workflows',
        SuperTabTaskPriority.urgent,
        'Agents\' GitHub tokens also carry workflows',
      ),
      (
        'URGENT bug in #2608: the date pill crashes',
        SuperTabTaskPriority.urgent,
        'Bug in #2608: the date pill crashes',
      ),
      (
        'Manage Backlog tab redesigned (Scholes, high)',
        SuperTabTaskPriority.high,
        'Manage Backlog tab redesigned',
      ),
      (
        'Round dial fix (Huy, urgent)',
        SuperTabTaskPriority.urgent,
        'Round dial fix',
      ),
      ('Thread tags (Dee, 2026-11-04)', null, 'Thread tags (Dee, 2026-11-04)'),
      ('Urgently needed docs', null, 'Urgently needed docs'),
      ('A high bar for review', null, 'A high bar for review'),
    ]) {
      final read = superTabTitlePriority(title);
      expect(read.priority, priority, reason: title);
      expect(read.title, shown, reason: title);
    }
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
        if (pr != null && shippedAt != null)
          'cards': {
            'pullRequests': [
              {'url': pr, 'messageId': 'card-$id', 'mergedAt': shippedAt},
            ],
          },
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
      DateTime? today,
      VoidCallback? beforeBuild,
      SuperTabController? held,
    }) async {
      opened.clear();
      final c = shown = held ?? server.controller();
      if (held == null) {
        addTearDown(c.dispose);
        await c.refresh();
      }
      beforeBuild?.call();
      await tester.binding.setSurfaceSize(const Size(1100, 2000));
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
                now: () =>
                    today ??
                    (c.groupChangedAt('working') ?? at).add(
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
    ({int working, int review, int shipped}) summary(WidgetTester tester) {
      int count(String name) => int.parse(
        tester
            .widget<Text>(
              find.byKey(ValueKey('super-backlog-summary-$name-count')),
            )
            .data!,
      );
      return (
        working: count('working'),
        review: count('inReview'),
        shipped: count('shipped'),
      );
    }

    Future<void> search(WidgetTester tester, String text) async {
      await tester.enterText(
        find.descendant(
          of: find.byKey(const ValueKey('super-backlog-search')),
          matching: find.byType(EditableText),
        ),
        text,
      );
      await tester.pumpAndSettle();
    }

    Future<void> chooseProject(WidgetTester tester, String name) async {
      await tester.tap(find.byKey(const ValueKey('super-backlog-project')));
      await tester.pumpAndSettle();
      // The menu's row, not a project chip in the list.
      await tester.tap(find.widgetWithText(AppMenuItem, name).last);
      await tester.pumpAndSettle();
    }

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
            matching: find.text(group.label.toUpperCase()),
          ),
          findsOneWidget,
          reason: group.label,
        );
        expect(
          find.descendant(of: header(group), matching: find.text('$count')),
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
      expect(summary(tester), (working: 1, review: 1, shipped: 1));
      // Scholes's mockup (#2774): number and title; then agent, machine and
      // state with a project chip; the pull request's chip and how long ago
      // at the right.
      final working = rowText(tester, 'working');
      expect(working, contains('#11 | Sidebar task groups'));
      expect(working, contains('Kestrel · Mac Studio · Working'));
      expect(working, contains('web-project'));
      expect(working, contains('PR 2733'));
      expect(working, contains('5m'));
      expect(rowText(tester, 'asking'), contains('api'));
      expect(rowText(tester, 'asking'), contains('Waiting on pilot'));
      expect(rowText(tester, 'queued'), contains('No agent yet'));
      expect(rowText(tester, 'shipped'), contains('PR 2713 · merged'));
    });

    testWidgets('who asked and who it waits on read by the name they set '
        '(#2794)', (tester) async {
      final server = swarm();
      (server.state['people'] as List).cast<Map>().firstWhere(
        (p) => p['id'] == 'pilot',
      )['name'] = 'Pilot Pham';
      await show(tester, server);
      expect(rowText(tester, 'asking'), contains('Waiting on Pilot Pham'));
      expect(rowText(tester, 'asking'), isNot(contains('pilot')));
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
      await tester.tap(find.byKey(const ValueKey('super-backlog-everyone')));
      await tester.pumpAndSettle();
      expect(listed(tester), hasLength(6));
    });

    testWidgets('the summary counts what the filters show', (tester) async {
      await show(tester, swarm());
      expect(summary(tester), (working: 1, review: 1, shipped: 1));
      await chooseProject(tester, 'api');
      expect(listed(tester), ['asking']);
      expect(summary(tester), (working: 0, review: 0, shipped: 0));
      await chooseProject(tester, 'All projects');
      await search(tester, 'thread');
      expect(summary(tester), (working: 0, review: 1, shipped: 0));
    });

    testWidgets('search reads title, number or agent, with Mine and the '
        'project menu together', (tester) async {
      await show(tester, swarm());
      await search(tester, 'Thread reply');
      expect(listed(tester), ['review']);
      await search(tester, '#14');
      expect(listed(tester), ['done']);
      await search(tester, '15');
      expect(listed(tester), ['shipped']);
      // Every task Kestrel holds, and none without an agent.
      await search(tester, 'kestrel');
      expect(listed(tester), [
        'working',
        'asking',
        'review',
        'done',
        'shipped',
      ]);
      await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
      await tester.pumpAndSettle();
      expect(listed(tester), ['working', 'review', 'done', 'shipped']);
      await tester.tap(find.byKey(const ValueKey('super-backlog-everyone')));
      await tester.pumpAndSettle();
      await chooseProject(tester, 'api');
      expect(listed(tester), ['asking']);
      await search(tester, 'nothing like this');
      expect(listed(tester), isEmpty);
      expect(find.text('No tasks match “nothing like this”'), findsOneWidget);
    });

    testWidgets('each group says what it means, and folds to its heading', (
      tester,
    ) async {
      await show(tester, swarm());
      for (final line in [
        'An agent is on it right now',
        'Pull request open, waiting on a human',
        'Merged in the last 7 days',
      ]) {
        expect(find.text(line), findsOneWidget, reason: line);
      }
      await tester.tap(header(SuperTabBacklogGroup.working));
      await tester.pumpAndSettle();
      expect(row('working'), findsNothing);
      expect(
        find.descendant(
          of: header(SuperTabBacklogGroup.working),
          matching: find.text('1'),
        ),
        findsOneWidget,
      );
      expect(summary(tester), (working: 1, review: 1, shipped: 1));
      await tester.tap(header(SuperTabBacklogGroup.working));
      await tester.pumpAndSettle();
      expect(row('working'), findsOneWidget);
    });

    testWidgets('Shipped shows its newest 7, then Show N more shipped', (
      tester,
    ) async {
      final server = swarm();
      final conversations = server.state['conversations'] as List;
      for (var i = 0; i < 9; i++) {
        final pr = 'https://github.com/acme/app/pull/${3000 + i}';
        conversations.add(<String, dynamic>{
          ...conversationFixture('ship-$i', 'Shipped $i'),
          'projectId': 'lead',
          'number': 40 + i,
          'requesterId': 'owner',
          'assignment': {'id': 'a-s$i', 'agentId': 'kestrel', 'status': 'done'},
          // Newest is ship-0, an hour apart; the number order is the other way.
          'shippedAt': now - (i + 1) * 3600000,
          'pullRequestUrls': [pr],
          'cards': {
            'pullRequests': [
              {'url': pr, 'messageId': 'card-s$i', 'mergedAt': now},
            ],
          },
        });
      }
      await show(tester, server);
      expect(summary(tester).shipped, 10);
      final shipped = [
        for (final id in listed(tester))
          if (id == 'shipped' || id.startsWith('ship-')) id,
      ];
      expect(shipped, [
        'shipped',
        'ship-0',
        'ship-1',
        'ship-2',
        'ship-3',
        'ship-4',
        'ship-5',
      ]);
      final more = find.byKey(const ValueKey('super-backlog-shipped-more'));
      expect(
        find.descendant(of: more, matching: find.text('Show 3 more shipped')),
        findsOneWidget,
      );
      await tester.tap(more);
      await tester.pumpAndSettle();
      expect(row('ship-8'), findsOneWidget);
      expect(more, findsNothing);
    });

    testWidgets('a row shows the title\'s priority as a badge', (tester) async {
      final server = swarm();
      final conversations = (server.state['conversations'] as List).cast<Map>();
      conversations.firstWhere((g) => g['id'] == 'working')['title'] =
          'URGENT: sidebar task groups';
      conversations.firstWhere((g) => g['id'] == 'review')['title'] =
          'Thread reply bar (Scholes, high)';
      await show(tester, server);
      expect(
        rowText(tester, 'working'),
        contains('URGENT | Sidebar task groups'),
      );
      expect(rowText(tester, 'review'), contains('HIGH | Thread reply bar'));
      expect(rowText(tester, 'review'), isNot(contains('Scholes')));
    });

    testWidgets('says when the Swarm was last read', (tester) async {
      await show(tester, swarm(), today: DateTime.now());
      expect(find.text('Synced just now'), findsOneWidget);
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
      expect(
        rowText(tester, 'working'),
        contains('PR 2733 · 12 checks passed'),
      );
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
      expect(listed(tester), hasLength(5));
      expect(summary(tester), (working: 0, review: 2, shipped: 1));
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
      expect(find.text('No open tasks of yours'), findsOneWidget);
      expect(summary(tester), (working: 0, review: 0, shipped: 0));
    });

    group('closed tasks the app does not hold', () {
      const day = 86400000;

      /// A task of the project that shipped [daysAgo] days ago and was archived
      /// since, so a first read leaves it out as the backend does.
      Map<String, dynamic> archived(
        String id,
        int number, {
        double daysAgo = 2,
        String requester = 'owner',
        String status = 'done',
        bool shipped = true,
      }) => {
        ...conversationFixture(id, 'Archived $id'),
        'projectId': 'lead',
        'number': number,
        'requesterId': requester,
        'archived': true,
        'assignment': {'id': 'a-$id', 'agentId': 'kestrel', 'status': status},
        if (shipped) 'shippedAt': now - (daysAgo * day).round(),
      };

      /// [swarm] with nothing open: every task of it asked for by someone else.
      ConversationServer nothingOpen() {
        final server = swarm();
        for (final g in (server.state['conversations'] as List)) {
          (g as Map)['requesterId'] = 'pilot';
        }
        return server;
      }

      void add(
        ConversationServer server,
        Iterable<Map<String, dynamic>> tasks,
      ) {
        (server.state['conversations'] as List).addAll(tasks);
      }

      testWidgets('Shipped lists archived tasks from the last 7 days, not '
          'older ones, and they stay out of what the app holds', (
        tester,
      ) async {
        final server = swarm();
        // Time runs as the app does: what is read counts as changed just now.
        server.parts.clock = now;
        add(server, [
          archived('recent', 30),
          archived('week-old', 31, daysAgo: 6.9),
          archived('too-old', 32, daysAgo: 8),
          archived('gave-up', 33, status: 'stopped', shipped: false),
        ]);
        final c = await show(tester, server, today: at);
        expect(row('recent'), findsOneWidget);
        expect(row('week-old'), findsOneWidget);
        expect(row('too-old'), findsNothing);
        expect(row('gave-up'), findsNothing);
        expect(
          tester.getTopLeft(row('recent')).dy,
          greaterThan(
            tester.getTopLeft(header(SuperTabBacklogGroup.shipped)).dy,
          ),
        );
        expect(summary(tester).shipped, 3);
        // The snapshot is built again on every change: these never join it.
        expect(c.snapshot!.conversation('recent'), isNull);
      });

      testWidgets('a quiet Done task with an open pull request is Ready to '
          'merge, read as the closed list answers it', (tester) async {
        final server = swarm();
        server.parts.clock = now;
        add(server, [
          {
            ...archived('waiting', 90),
            'archived': false,
            'dormant': true,
            'pullRequestUrls': ['https://github.com/acme/app/pull/90'],
            'cards': {
              'pullRequests': [
                {
                  'url': 'https://github.com/acme/app/pull/90',
                  'messageId': 'card-90',
                },
              ],
            },
          },
        ]);
        await show(tester, server, today: at);
        expect(row('waiting'), findsOneWidget);
        expect(
          tester.getTopLeft(row('waiting')).dy,
          lessThan(tester.getTopLeft(header(SuperTabBacklogGroup.shipped)).dy),
        );
        expect(
          tester.getTopLeft(row('waiting')).dy,
          greaterThan(
            tester.getTopLeft(header(SuperTabBacklogGroup.readyToMerge)).dy,
          ),
        );
      });

      testWidgets('it reads on through every page of the last 7 days', (
        tester,
      ) async {
        final server = swarm()..parts.dormantPage = 2;
        server.parts.clock = now;
        add(server, [for (var i = 0; i < 5; i++) archived('page$i', 40 + i)]);
        await show(tester, server, today: at);
        for (var i = 0; i < 5; i++) {
          expect(row('page$i'), findsOneWidget);
        }
      });

      testWidgets('it reads each project through that project\'s index, never '
          'the whole Swarm\'s list, which no index can sort', (tester) async {
        final server = swarm();
        server.parts.clock = now;
        add(server, [
          archived('here', 80),
          {...archived('there', 81), 'projectId': 'api'},
        ]);
        await show(tester, server, today: at);
        expect(row('here'), findsOneWidget);
        expect(row('there'), findsOneWidget);
        final pages = server.parts.reads.where((p) => p.contains('dormant=1'));
        expect(pages, isNotEmpty);
        expect(pages.where((p) => !p.contains('projectId=')), isEmpty);
      });

      testWidgets('a project that cannot be read does not stop the others', (
        tester,
      ) async {
        final server = swarm();
        server.parts.clock = now;
        add(server, [
          archived('here', 80),
          {...archived('there', 81), 'projectId': 'api'},
        ]);
        await show(
          tester,
          server,
          today: at,
          beforeBuild: () => server.failReadsOf = 'projectId=lead',
        );
        expect(row('here'), findsNothing);
        expect(row('there'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-backlog-shipped-retry')),
          findsOneWidget,
        );
      });

      Iterable<String> closedReads(ConversationServer server) =>
          server.parts.reads.where((p) => p.contains('dormant=1'));

      testWidgets('opening the tab again reads nothing again and keeps the '
          'rows', (tester) async {
        final server = swarm();
        server.parts.clock = now;
        add(server, [archived('recent', 30)]);
        final c = await show(tester, server, today: at);
        expect(row('recent'), findsOneWidget);
        final reads = closedReads(server).length;
        await tester.pumpWidget(const SizedBox());
        await show(tester, server, today: at, held: c);
        expect(row('recent'), findsOneWidget);
        expect(closedReads(server), hasLength(reads));
      });

      testWidgets('a task that closes while the app is open stays listed '
          'after the tab opens again', (tester) async {
        final server = swarm();
        server.parts.clock = now;
        final c = await show(tester, server, today: at);
        await tester.pumpWidget(const SizedBox());
        (server.state['conversations'] as List).cast<Map>().firstWhere(
          (g) => g['id'] == 'shipped',
        )['archived'] = true;
        await c.refresh();
        await show(tester, server, today: at, held: c);
        expect(row('shipped'), findsOneWidget);
      });

      testWidgets('trying again reads only the project that failed', (
        tester,
      ) async {
        final server = swarm();
        server.parts.clock = now;
        add(server, [
          archived('here', 80),
          {...archived('there', 81), 'projectId': 'api'},
        ]);
        await show(
          tester,
          server,
          today: at,
          beforeBuild: () => server.failReadsOf = 'projectId=lead',
        );
        server.parts.reads.clear();
        server.failReadsOf = null;
        await tester.tap(
          find.byKey(const ValueKey('super-backlog-shipped-retry')),
        );
        await tester.pumpAndSettle();
        expect(row('here'), findsOneWidget);
        expect(row('there'), findsOneWidget);
        expect(
          closedReads(server).where((p) => p.contains('projectId=api')),
          isEmpty,
        );
      });

      testWidgets('a reload forgets what the reader may no longer read', (
        tester,
      ) async {
        final server = swarm();
        server.parts.clock = now;
        add(server, [archived('recent', 30), archived('kept', 31)]);
        final c = await show(tester, server, today: at);
        expect(row('recent'), findsOneWidget);
        (server.state['conversations'] as List).cast<Map>().firstWhere(
          (g) => g['id'] == 'recent',
        )['audience'] = {
          'people': [
            {'id': 'pilot'},
          ],
        };
        server.parts.epoch++;
        await c.refresh();
        await tester.pumpAndSettle();
        expect(row('recent'), findsNothing);
        expect(row('kept'), findsOneWidget);
      });

      testWidgets('a page that reaches past 7 days ends the read', (
        tester,
      ) async {
        final server = swarm()..parts.dormantPage = 1;
        add(server, [
          archived('oldest', 50, daysAgo: 20),
          archived('older', 51, daysAgo: 19),
        ]);
        server.parts.clock = now - 30 * day;
        await show(
          tester,
          server,
          today: at,
          beforeBuild: () {
            server.parts.clock = now;
            add(server, [archived('fresh', 52)]);
            server.parts.reads.clear();
          },
        );
        expect(row('fresh'), findsOneWidget);
        final pages = server.parts.reads.where(
          (p) => p.contains('dormant=1') && p.contains('projectId=lead'),
        );
        // The fresh task's page, then the first whose task is past the window.
        expect(pages, hasLength(2));
      });

      testWidgets(
        'a task that is back at work shows as the app holds it, once',
        (tester) async {
          final server = swarm();
          server.parts.clock = now;
          add(server, [archived('woken', 60)]);
          final c = await show(tester, server, today: at);
          expect(
            find.byKey(const ValueKey('super-backlog-row-woken')),
            findsOne,
          );
          final woken = (server.state['conversations'] as List).firstWhere(
            (g) => (g as Map)['id'] == 'woken',
          );
          woken
            ..remove('archived')
            ..remove('shippedAt')
            ..['assignment'] = {
              'id': 'a-woken',
              'agentId': 'kestrel',
              'status': 'working',
            };
          await c.refresh();
          await tester.pumpAndSettle();
          expect(row('woken'), findsOneWidget);
          expect(
            tester.getTopLeft(row('woken')).dy,
            lessThan(
              tester.getTopLeft(header(SuperTabBacklogGroup.shipped)).dy,
            ),
          );
        },
      );

      testWidgets('clicking an archived row reads it and opens its chat', (
        tester,
      ) async {
        final server = swarm();
        server.parts.clock = now;
        add(server, [archived('recent', 30)]);
        final c = await show(tester, server, today: at);
        await tester.tap(row('recent'));
        await tester.pumpAndSettle();
        expect(opened, ['recent']);
        expect(c.snapshot!.conversation('recent'), isNotNull);
      });

      testWidgets(
        'an empty Mine says so and links to what the reader shipped',
        (tester) async {
          final server = nothingOpen();
          server.parts.clock = now;
          add(server, [
            archived('mine-a', 30),
            archived('mine-b', 31),
            archived('theirs', 32, requester: 'pilot'),
          ]);
          await show(tester, server, today: at);
          await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
          await tester.pumpAndSettle();
          expect(find.text('No open tasks of yours'), findsOneWidget);
          expect(row('mine-a'), findsNothing);
          // The cards still count what Mine shipped.
          expect(summary(tester), (working: 0, review: 0, shipped: 2));
          final link = find.byKey(const ValueKey('super-backlog-mine-shipped'));
          expect(
            find.descendant(
              of: link,
              matching: find.text(
                'Your shipped tasks from the last 7 days · 2',
              ),
            ),
            findsOneWidget,
          );
          await tester.tap(link);
          await tester.pumpAndSettle();
          expect(find.text('No open tasks of yours'), findsNothing);
          expect(row('mine-a'), findsOneWidget);
          expect(row('mine-b'), findsOneWidget);
          expect(row('theirs'), findsNothing);
          expect(summary(tester), (working: 0, review: 0, shipped: 2));
        },
      );

      testWidgets('an empty Mine with nothing shipped has no link', (
        tester,
      ) async {
        await show(tester, nothingOpen(), today: at);
        await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
        await tester.pumpAndSettle();
        expect(find.text('No open tasks of yours'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-backlog-mine-shipped')),
          findsNothing,
        );
      });

      testWidgets('Mine goes by who asked, not who worked on it', (
        tester,
      ) async {
        final server = nothingOpen();
        server.parts.clock = now;
        final conversations = server.state['conversations'] as List;
        conversations.add({
          ...archived('no-one-asked', 70),
          'requesterId': null,
        });
        // The reader's own machine and agent did this one; Pilot asked for it.
        add(server, [archived('theirs', 71, requester: 'pilot')]);
        add(server, [archived('asked', 72)]);
        await show(tester, server, today: at);
        await tester.tap(find.byKey(const ValueKey('super-backlog-mine')));
        await tester.pumpAndSettle();
        expect(
          find.text('Your shipped tasks from the last 7 days · 1'),
          findsOneWidget,
        );
      });

      testWidgets('a failed read says so, and trying again reads it', (
        tester,
      ) async {
        final server = swarm();
        server.parts.clock = now;
        add(server, [archived('recent', 30)]);
        await show(
          tester,
          server,
          today: at,
          beforeBuild: () => server.failReads = true,
        );
        expect(row('recent'), findsNothing);
        final retry = find.byKey(const ValueKey('super-backlog-shipped-retry'));
        expect(retry, findsOneWidget);
        expect(
          find.text('Some shipped tasks could not be read.'),
          findsOneWidget,
        );
        server.failReads = false;
        await tester.tap(retry);
        await tester.pumpAndSettle();
        expect(retry, findsNothing);
        expect(row('recent'), findsOneWidget);
      });
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
