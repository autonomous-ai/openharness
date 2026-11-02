import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_home_prefs.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_status.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/waiting_work.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The project's status (Tony 11-01, task 1; moved 11-02): the coordinator's
/// last report and the decisions in this project waiting on the person, in the
/// sheet the project menu's Status row opens. The chat itself shows no box.
void main() {
  const other = 'project-2', otherChat = 'group-lead-2';
  const today = '2026-11-01T09:52:00.000Z';

  /// The signed-in account of the host last pumped.
  late ValueNotifier<String?> account;

  Map<String, dynamic> projectData(
    String id,
    String chat, {
    Map<String, dynamic>? status,
  }) => {
    'id': id,
    'name': id == project ? 'Mobile' : 'Backend',
    'ownerId': me,
    'leadConversationId': chat,
    'visibility': 'public',
    'members': <Object>[],
    'updateMinutes': 5,
    'status': ?status,
  };

  Map<String, dynamic> head({Map<String, dynamic>? status}) => headData(
    projects: [
      projectData(project, leadChat, status: status),
      projectData(other, otherChat),
    ],
  );

  /// A decision asked of the person by River (the Lead of both projects:
  /// the same agent id and name in each) in [chat] of [projectId].
  Map<String, dynamic> decision(
    String id, {
    String projectId = project,
    String chat = leadChat,
    String question = 'Show status by default?',
  }) => {
    'id': id,
    'projectId': projectId,
    'projectName': projectId == project ? 'Mobile' : 'Backend',
    'conversationId': chat,
    'conversationTitle': 'Secret title $id',
    'askerName': 'River',
    'question': question,
    'options': ['Yes', 'No'],
    'recommended': 0,
    'unblocks': 'The card',
    'createdAt': '2026-11-01T09:00:00.000Z',
  };

  /// The Swarm with [status] on project Mobile and [decisions] open; its
  /// other project Backend has its own Lead chat, and the person's Buddy chat
  /// and a private chat they cannot read sit in Mobile.
  FakeSwarm backend({
    Map<String, dynamic>? status,
    List<Map<String, dynamic>> decisions = const [],
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      head: head(status: status),
      groups: [
        {
          ...groupData(otherChat, title: 'Backend', agentIds: ['agent-lead']),
          'projectId': other,
        },
        buddyChatData('buddy-me'),
      ],
      derived: {'decisionsWaiting': decisions.length},
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: {'decisionsWaiting': decisions.length});
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': decisions,
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  /// A change read whose head carries [status] on Mobile.
  Map<String, dynamic> statusChange(
    Map<String, dynamic>? status, {
    int version = 2,
  }) => {
    ...changes(cursor: 'c$version', lastChangedAt: 100 + version),
    'head': part('head', version, head(status: status)),
  };

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    LocalKeyValueStore? marks,
    Widget? home,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: marks ?? MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home:
            home ??
            const SwarmProjectPage(
              swarmId: tab,
              projectId: project,
              tabs: SwarmProjectTab.homeC,
            ),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  final card = key('swarm-project-status-$project');
  final empty = key('swarm-project-status-empty-$project');
  final heading = key('swarm-project-status-heading-$project');
  final menu = key('swarm-project-menu');
  final statusRow = key('swarm-project-menu-status');
  final sheet = key('swarm-status-close');

  /// ⋮, then Status.
  Future<void> openStatus(WidgetTester tester) async {
    await tester.tap(menu);
    await tester.pumpAndSettle();
    await tester.tap(statusRow);
    await tester.pumpAndSettle();
  }

  Future<SwarmHost> pumpStatus(WidgetTester tester, FakeSwarm fake) async {
    final session = await pump(tester, fake);
    await openStatus(tester);
    return session;
  }

  group('the chat', () {
    testWidgets('shows no status box, whatever the project reported or '
        'waits on', (tester) async {
      await pump(
        tester,
        backend(
          status: {'text': 'Running: phone status', 'at': today},
          decisions: [decision('d1')],
        ),
      );
      expect(key('swarm-project-chat-$leadChat'), findsOneWidget);
      expect(card, findsNothing);
      expect(heading, findsNothing);
      expect(find.text('Running: phone status'), findsNothing);
      expect(find.text('River asks you'), findsNothing);
      expect(find.text('Status'), findsNothing);
    });

    testWidgets('keeps its status one tap into ⋮: a Status row that opens it, '
        'closing returns to the chat', (tester) async {
      await pump(
        tester,
        backend(status: {'text': 'Running: phone status', 'at': today}),
      );
      await tester.tap(menu);
      await tester.pumpAndSettle();
      expect(statusRow, findsOneWidget);
      expect(
        find.descendant(of: statusRow, matching: find.text('Status')),
        findsOneWidget,
      );
      await tester.tap(statusRow);
      await tester.pumpAndSettle();
      expect(sheet, findsOneWidget);
      expect(find.text('Running: phone status'), findsOneWidget);
      expect(tester.widget<Text>(heading).data, startsWith('updated '));

      await tester.tap(sheet);
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
      expect(key('swarm-project-chat-$leadChat'), findsOneWidget);
    });
  });

  group('states', () {
    testWidgets('empty: no report and nothing waiting says so', (tester) async {
      await pumpStatus(tester, backend());
      expect(card, findsNothing);
      expect(empty, findsOneWidget);
    });

    testWidgets('running: the report word for word under updated', (
      tester,
    ) async {
      await pumpStatus(
        tester,
        backend(
          status: {
            'text': 'Running: phone status card\nDone today: #2459',
            'at': today,
          },
        ),
      );
      expect(card, findsOneWidget);
      expect(tester.widget<Text>(heading).data, startsWith('updated '));
      expect(
        find.text('Running: phone status card\nDone today: #2459'),
        findsOneWidget,
      );
      expect(key('swarm-project-status-need-decision:d1'), findsNothing);
    });

    testWidgets('needs you: a decision here, with no report, still shows; a '
        'tap opens Activity at it', (tester) async {
      await pumpStatus(tester, backend(decisions: [decision('d1')]));
      expect(card, findsOneWidget);
      expect(heading, findsNothing);
      final row = key('swarm-project-status-need-decision:d1');
      expect(row, findsOneWidget);
      expect(
        find.descendant(of: row, matching: find.text('River asks you')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: row,
          matching: find.text('Show status by default?'),
        ),
        findsOneWidget,
      );
      await tester.tap(row);
      await tester.pumpAndSettle();
      final activity = tester.widget<SwarmActivityPage>(
        find.byType(SwarmActivityPage),
      );
      expect(activity.focus, 'decision:d1');
      expect(activity.swarmId, tab);
    });

    testWidgets('done and waiting: the report, then each decision, newest '
        'first as Activity orders them', (tester) async {
      await pumpStatus(
        tester,
        backend(
          status: {'text': 'Done today: #2459, #2460', 'at': today},
          decisions: [
            decision('d1', question: 'First?'),
            {
              ...decision('d2', question: 'Second?'),
              'createdAt': '2026-11-01T09:30:00.000Z',
            },
          ],
        ),
      );
      final text = tester.getTopLeft(find.text('Done today: #2459, #2460'));
      final d2 = tester.getTopLeft(
        key('swarm-project-status-need-decision:d2'),
      );
      final d1 = tester.getTopLeft(
        key('swarm-project-status-need-decision:d1'),
      );
      expect(text.dy, lessThan(d2.dy));
      expect(d2.dy, lessThan(d1.dy));
    });

    testWidgets('a long report scrolls inside the sheet, which keeps its '
        'height', (tester) async {
      final long = List.generate(80, (i) => 'Line $i of the report').join('\n');
      await pumpStatus(tester, backend(status: {'text': long, 'at': today}));
      final scrollable = find.descendant(
        of: card,
        matching: find.byType(Scrollable),
      );
      expect(
        tester.state<ScrollableState>(scrollable).position.maxScrollExtent,
        greaterThan(0),
      );
      expect(
        tester.getSize(card).height,
        lessThan(
          tester.view.physicalSize.height / tester.view.devicePixelRatio,
        ),
      );
    });
  });

  group('arrives late, fails, recovers', () {
    testWidgets('a report that arrives with a later read shows then, in place '
        'of none, and a newer one replaces it', (tester) async {
      final fake = backend();
      final host = await pumpStatus(tester, fake);
      expect(empty, findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          statusChange({'text': 'Building the card', 'at': today});
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Building the card'), findsOneWidget);
      expect(empty, findsNothing);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          statusChange({'text': 'Card shipped', 'at': today}, version: 3);
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Card shipped'), findsOneWidget);
      expect(find.text('Building the card'), findsNothing);
    });

    testWidgets('a first read that fails shows no menu and no endless '
        'loading; the read that recovers brings the Status row', (
      tester,
    ) async {
      final fake = backend(status: {'text': 'Building', 'at': today});
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw const SuperTabFailure('UNAVAILABLE', 'Down.', statusCode: 503);
      final host = await pump(tester, fake);
      expect(menu, findsNothing);
      expect(find.text('Down.'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/parts'] = parts;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      await openStatus(tester);
      expect(find.text('Building'), findsOneWidget);
    });

    testWidgets('decisions that fail to load leave the report, and come when '
        'a later read gets through', (tester) async {
      final fake = backend(
        status: {'text': 'Building', 'at': today},
        decisions: [decision('d1')],
      );
      final open = fake.routes['/api/super-tabs/$tab/decisions?state=open']!;
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) =>
          throw const SuperTabFailure('UNAVAILABLE', 'Down.', statusCode: 503);
      final host = await pumpStatus(tester, fake);
      expect(find.text('Building'), findsOneWidget);
      expect(key('swarm-project-status-need-decision:d1'), findsNothing);

      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = open;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(key('swarm-project-status-need-decision:d1'), findsOneWidget);
    });
  });

  group('cold start, on the Home kept', () {
    final updating = key('swarm-project-status-updating-$project');
    final failed = key('swarm-project-status-error-$project');

    /// The phone opens on the Home kept, which holds neither report nor
    /// decisions; the Swarm's read is [parts], the list's is [list].
    Future<SwarmHost> coldStatus(
      WidgetTester tester,
      FakeSwarm fake, {
      FutureOr<Object?> Function(Map<String, dynamic>? body)? list,
    }) async {
      final cache = memoryHomeCache();
      final state = SuperTabParts.firstLoad(firstLoad(head: head())).state;
      await tester.runAsync(
        () => cache.write(me, [
          (
            id: tab,
            name: 'Phone Swarm',
            view: swarmHomeSwarm(
              SuperTabSnapshot.fromJson(state),
              swarmPartners(state),
            ),
          ),
        ]),
      );
      // No computer answers the list, as on a cold start in a tunnel.
      fake.routes['/api/super-tabs/list'] =
          list ?? (_) => Completer<Object?>().future;
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        homeCache: cache,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: const SwarmPage(),
        ),
      );
      for (var i = 0; i < 100 && host.session!.inbox.swarms.isEmpty; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
        await tester.pump();
      }
      await tester.pump();
      // Opened from the Home kept, as the phone does on a cold start.
      await tester.tap(key('swarm-project-$tab-$project'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      return host;
    }

    testWidgets('while the Swarm is still being read, Status says Updating… '
        'and never "Nothing to report"; the report replaces it', (
      tester,
    ) async {
      final fake = backend(
        status: {'text': 'Report on the server', 'at': today},
      );
      final read = Completer<Object?>();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => read.future;
      await coldStatus(tester, fake);
      await openStatus(tester);
      expect(updating, findsOneWidget);
      expect(empty, findsNothing);
      expect(find.text('Nothing to report yet.'), findsNothing);

      read.complete(parts(null));
      await tester.pumpAndSettle();
      expect(find.text('Report on the server'), findsOneWidget);
      expect(updating, findsNothing);
    });

    testWidgets('when the read fails, Status says so and never "Nothing to '
        'report"; the read that recovers brings the report', (tester) async {
      final fake = backend(
        status: {'text': 'Report on the server', 'at': today},
      );
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw const SuperTabFailure('UNAVAILABLE', 'Down.', statusCode: 503);
      final host = await coldStatus(tester, fake);
      await openStatus(tester);
      await tester.pumpAndSettle();
      expect(empty, findsNothing);
      expect(find.text('Nothing to report yet.'), findsNothing);
      expect(failed, findsOneWidget);
      expect(find.text('Down.'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/parts'] = parts;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Report on the server'), findsOneWidget);
      expect(failed, findsNothing);
    });

    testWidgets('a report that read fine with decisions that fail to load '
        'says so, not "Nothing to report"', (tester) async {
      final fake = backend(decisions: [decision('d1')]);
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) =>
          throw const SuperTabFailure('UNAVAILABLE', 'Down.', statusCode: 503);
      await pumpStatus(tester, fake);
      await tester.pumpAndSettle();
      expect(empty, findsNothing);
      expect(find.text('Nothing to report yet.'), findsNothing);
    });
  });

  group('privacy', () {
    testWidgets('a decision from another project, or from a chat of this '
        'project the person does not read, never shows, nor its title', (
      tester,
    ) async {
      await pumpStatus(
        tester,
        backend(
          decisions: [
            // Another project, by the same River.
            decision('other', projectId: other, chat: otherChat),
            // Claims this project, asked in another project's chat.
            decision('claims', chat: otherChat),
            // A private chat of this project the read does not carry.
            decision('private', chat: 'group-private'),
            // Another person's Buddy chat, not in the read either.
            decision('buddy', chat: 'buddy-theirs'),
          ],
        ),
      );
      expect(card, findsNothing);
      expect(empty, findsOneWidget);
      expect(find.textContaining('Secret title'), findsNothing);
      expect(find.text('River asks you'), findsNothing);
    });

    Map<String, dynamic> privateHead({required bool member}) => headData(
      projects: [
        {
          ...projectData(
            project,
            leadChat,
            status: {'text': 'Private plans', 'at': today},
          ),
          'ownerId': 'diego',
          'visibility': 'private',
          'members': [
            if (member) {'id': me, 'generation': 'gen-$me'},
          ],
        },
        projectData(other, otherChat),
      ],
    );

    testWidgets('a private project the person is not a member of shows '
        'nothing in Status, as the server reads it; made a member, it '
        'shows', (tester) async {
      final fake = backend(decisions: [decision('d1')]);
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        head: privateHead(member: false),
        derived: {'decisionsWaiting': 1},
      );
      final host = await pump(tester, fake);
      // The sheet is taken down as it opens: nothing of the project shows.
      await openStatus(tester);
      expect(sheet, findsNothing);
      expect(card, findsNothing);
      expect(find.text('Private plans'), findsNothing);
      expect(find.text('River asks you'), findsNothing);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(
          cursor: 'c2',
          lastChangedAt: 102,
          derived: {'decisionsWaiting': 1},
        ),
        'head': part('head', 2, privateHead(member: true)),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      await openStatus(tester);
      expect(find.text('Private plans'), findsOneWidget);
    });

    testWidgets('a project made private to others while Status is open '
        'closes it, with what it held', (tester) async {
      final fake = backend(
        status: {'text': 'Private plans', 'at': today},
        decisions: [decision('d1')],
      );
      final host = await pumpStatus(tester, fake);
      expect(find.text('Private plans'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(
          cursor: 'c2',
          lastChangedAt: 102,
          derived: {'decisionsWaiting': 1},
        ),
        'head': part('head', 2, privateHead(member: false)),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
      expect(find.text('Private plans'), findsNothing);
      expect(find.text('River asks you'), findsNothing);
    });

    testWidgets('access lost while Status is open closes it, with what it '
        'held', (tester) async {
      final host = await pumpStatus(
        tester,
        backend(
          status: {'text': 'Building', 'at': today},
          decisions: [decision('d1')],
        ),
      );
      expect(find.text('Building'), findsOneWidget);
      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
      expect(card, findsNothing);
      expect(find.text('Building'), findsNothing);
      expect(find.text('River asks you'), findsNothing);
    });

    testWidgets('a project taken away by a later read closes its Status', (
      tester,
    ) async {
      final fake = backend(status: {'text': 'Building', 'at': today});
      final host = await pumpStatus(tester, fake);
      expect(card, findsOneWidget);
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c2', lastChangedAt: 102),
        'head': part(
          'head',
          2,
          headData(projects: [projectData(other, otherChat)]),
        ),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
      expect(card, findsNothing);
      expect(find.text('Building'), findsNothing);
    });

    testWidgets('signing out while Status is open closes it', (tester) async {
      await pumpStatus(
        tester,
        backend(status: {'text': 'Building', 'at': today}),
      );
      expect(find.text('Building'), findsOneWidget);
      account.value = null;
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
      expect(find.text('Building'), findsNothing);
    });

    testWidgets('decisions read before access was lost, answered after, are '
        'never drawn', (tester) async {
      final fake = backend(
        status: {'text': 'Building', 'at': today},
        decisions: [decision('d1')],
      );
      final held = Completer<Object?>();
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) =>
          held.future;
      final host = await pumpStatus(tester, fake);
      expect(find.text('Building'), findsOneWidget);
      host.session!.inbox.reader(tab)!.revoke();
      await tester.pump();
      held.complete({
        'decisions': [decision('d1')],
      });
      await tester.pumpAndSettle();
      expect(card, findsNothing);
      expect(find.text('River asks you'), findsNothing);
    });

    testWidgets('a Status opened for one project never shows another '
        "project's report under the same Lead", (tester) async {
      final fake = backend(status: {'text': 'Mobile report', 'at': today});
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        head: headData(
          projects: [
            projectData(
              project,
              leadChat,
              status: {'text': 'Mobile report', 'at': today},
            ),
            projectData(
              other,
              otherChat,
              status: {'text': 'Backend secrets', 'at': today},
            ),
          ],
        ),
        groups: [
          {
            ...groupData(otherChat, title: 'Backend', agentIds: ['agent-lead']),
            'projectId': other,
          },
        ],
      );
      await pumpStatus(tester, fake);
      expect(find.text('Mobile report'), findsOneWidget);
      expect(find.text('Backend secrets'), findsNothing);
    });
  });

  group('text', () {
    testWidgets('web links open; a sentence\'s full stop is not part of one; '
        'a link with no host stays text', (tester) async {
      final opened = <Uri>[];
      final was = swarmOpenStatusLink;
      swarmOpenStatusLink = (url) async {
        opened.add(url);
        return true;
      };
      addTearDown(() => swarmOpenStatusLink = was);
      await pumpStatus(
        tester,
        backend(
          status: {
            'text': 'PR https://github.com/o/r/pull/1. Not http:///etc/passwd',
            'at': today,
          },
        ),
      );
      final text = tester.widget<Text>(key('swarm-project-status-text'));
      final spans = <TextSpan>[];
      text.textSpan!.visitChildren((span) {
        if (span is TextSpan && span.recognizer != null) spans.add(span);
        return true;
      });
      expect(
        [for (final s in spans) s.text],
        ['https://github.com/o/r/pull/1'],
      );
      (spans.single.recognizer! as dynamic).onTap();
      expect(opened, [Uri.parse('https://github.com/o/r/pull/1')]);
    });

    test('updated: the time alone today, the date before, the year in '
        'another year', () {
      final now = DateTime(2026, 11, 1, 18);
      expect(swarmStatusUpdatedAt(DateTime(2026, 11, 1, 9, 5), now), '09:05');
      expect(
        swarmStatusUpdatedAt(DateTime(2026, 10, 30, 16, 52), now),
        'Oct 30, 16:52',
      );
      expect(
        swarmStatusUpdatedAt(DateTime(2025, 12, 31, 23, 59), now),
        'Dec 31 2025, 23:59',
      );
    });
  });

  group('kept folds', () {
    String keyOf(int i) => '$tab/p$i';

    test('kept from before folds existed, read back and folded, it saves '
        'with its pins and Swarm intact', () async {
      final store = MemoryKeyValueStore();
      await store.write(
        'swarm_home.$me',
        jsonEncode({
          'pins': ['$tab/$project'],
          'swarm': tab,
        }),
      );
      final prefs = SwarmHomePrefs(accountId: me, store: store);
      await until(() => prefs.loaded);
      expect(prefs.folds, isEmpty);
      prefs.fold(tab, project, true);
      await settle();
      final saved = jsonDecode((await store.read('swarm_home.$me'))!) as Map;
      expect(saved['pins'], ['$tab/$project']);
      expect(saved['swarm'], tab);
      expect(saved['folded'], ['$tab/$project']);
      prefs.dispose();
    });

    test(
      'at the limit the oldest fold goes; read back, it still saves',
      () async {
        final store = MemoryKeyValueStore();
        final prefs = SwarmHomePrefs(accountId: me, store: store);
        await until(() => prefs.loaded);
        for (var i = 0; i <= SwarmHomePrefs.keptFolds; i++) {
          prefs.fold(tab, 'p$i', true);
        }
        await settle();
        expect(prefs.folds, hasLength(SwarmHomePrefs.keptFolds));
        expect(prefs.folded(tab, 'p0'), isFalse);
        prefs.dispose();

        final again = SwarmHomePrefs(accountId: me, store: store);
        await until(() => again.loaded);
        expect(again.folds, hasLength(SwarmHomePrefs.keptFolds));
        expect(again.folds.first, keyOf(1));
        again.fold(tab, 'new', true);
        await settle();
        final saved = jsonDecode((await store.read('swarm_home.$me'))!) as Map;
        expect(saved['folded'], hasLength(SwarmHomePrefs.keptFolds));
        expect((saved['folded'] as List).last, '$tab/new');
        expect(saved['folded'], isNot(contains(keyOf(1))));
        again.dispose();
      },
    );

    test('a fold chosen before the kept ones are read joins them; one opened '
        'meanwhile stays open; a Swarm gone takes its folds', () async {
      final store = MemoryKeyValueStore();
      await store.write(
        'swarm_home.$me',
        jsonEncode({
          'pins': <String>[],
          'folded': ['$tab/a', '$tab/b', 'gone/c'],
        }),
      );
      final prefs = SwarmHomePrefs(accountId: me, store: store)
        ..fold(tab, 'b', false)
        ..fold(tab, 'd', true)
        ..keepOnly({tab});
      await until(() => prefs.loaded);
      expect(prefs.folds, ['$tab/a', '$tab/d']);
      prefs.dispose();
    });
  });

  group('Activity from Status', () {
    /// River asks the same question in both projects: one decision in
    /// Mobile's chat, one in Backend's.
    List<Map<String, dynamic>> both() => [
      decision('d1'),
      decision('other', projectId: other, chat: otherChat),
    ];

    /// Activity shows [project]'s decision alone, under its name, counted
    /// once.
    void expectMobileOnly(WidgetTester tester) {
      final page = tester.widget<SwarmActivityPage>(
        find.byType(SwarmActivityPage),
      );
      expect((page.swarmId, page.projectId), (tab, project));
      expect(find.text('#Mobile'), findsOneWidget);
      expect(
        key('swarm-activity-row-decision:d1').evaluate().length +
            key('swarm-activity-open-decision:d1').evaluate().length,
        1,
      );
      expect(key('swarm-activity-row-decision:other'), findsNothing);
      expect(key('swarm-activity-open-decision:other'), findsNothing);
      expect(find.textContaining('Backend'), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-activity-filter-needsYou'),
          matching: find.text('1'),
        ),
        findsOneWidget,
      );
    }

    testWidgets('the project chat with open decisions shows none among its '
        'messages; Status holds them', (tester) async {
      await pump(
        tester,
        backend(
          status: {'text': 'Building', 'at': today},
          decisions: [decision('d1')],
        ),
      );
      expect(key('swarm-project-status-need-decision:d1'), findsNothing);
      expect(key('swarm-ask-d1'), findsNothing);
      expect(key('swarm-option-d1-0'), findsNothing);
      await openStatus(tester);
      expect(key('swarm-project-status-need-decision:d1'), findsOneWidget);
      expect(key('swarm-ask-d1'), findsNothing);
    });

    testWidgets('a waiting line opens Activity at it, on this project alone', (
      tester,
    ) async {
      await pumpStatus(tester, backend(decisions: both()));
      await tester.tap(key('swarm-project-status-need-decision:d1'));
      await tester.pumpAndSettle();

      expect(key('swarm-activity-open-decision:d1'), findsOneWidget);
      expectMobileOnly(tester);
    });

    testWidgets('answering in Activity takes it off Status', (tester) async {
      final fake = backend(
        status: {'text': 'Building', 'at': today},
        decisions: both(),
      );
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
        'result': <String, dynamic>{},
      };
      await pumpStatus(tester, fake);
      final session = host(tester);
      expect(key('swarm-project-status-need-decision:d1'), findsOneWidget);

      await tester.tap(key('swarm-project-status-need-decision:d1'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-option-d1-0'));
      await tester.pump(const Duration(seconds: 10));
      await tester.pumpAndSettle();
      expect(fake.commands.single, {
        'type': 'decision.answer',
        'decisionId': 'd1',
        'choice': 0,
      });
      // The server: d1 answered, one decision left in the Swarm.
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [decision('other', projectId: other, chat: otherChat)],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        lastChangedAt: 103,
        derived: {'decisionsWaiting': 1},
      );
      await session.inbox.reader(tab)!.refresh();
      await session.inbox.refresh();
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('tty-back')).first);
      await tester.pumpAndSettle();
      expect(find.byType(SwarmActivityPage), findsNothing);
      expect(key('swarm-project-status-need-decision:d1'), findsNothing);
      expect(card, findsOneWidget);
    });

    testWidgets('access lost while its Activity is open: the rows and the '
        "project's name go, nothing stuck loading", (tester) async {
      await pumpStatus(tester, backend(decisions: both()));
      final session = host(tester);
      await tester.tap(key('swarm-project-status-need-decision:d1'));
      await tester.pumpAndSettle();
      expect(find.text('Show status by default?'), findsWidgets);

      session.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(find.text('#Mobile'), findsNothing);
      expect(find.text('Show status by default?'), findsNothing);
      expect(find.textContaining('River'), findsNothing);
      expect(key('swarm-activity-loading'), findsNothing);
    });

    testWidgets('the project made private to others while its Activity is '
        'open: its rows and name go', (tester) async {
      final fake = backend(decisions: both());
      await pumpStatus(tester, fake);
      final session = host(tester);
      await tester.tap(key('swarm-project-status-need-decision:d1'));
      await tester.pumpAndSettle();
      expect(find.text('#Mobile'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(
          cursor: 'c2',
          lastChangedAt: 102,
          derived: {'decisionsWaiting': 2},
        ),
        'head': part(
          'head',
          2,
          headData(
            projects: [
              {
                ...projectData(project, leadChat),
                'ownerId': 'diego',
                'visibility': 'private',
              },
              projectData(other, otherChat),
            ],
          ),
        ),
      };
      await session.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text('#Mobile'), findsNothing);
      expect(key('swarm-activity-open-decision:d1'), findsNothing);
      expect(key('swarm-activity-row-decision:other'), findsNothing);
      expect(find.text('Show status by default?'), findsNothing);
    });
  });
}

/// The session of the host the page was pumped under.
SwarmSession host(WidgetTester tester) =>
    SwarmScope.of(tester.element(find.byType(SwarmProjectPage)))!;
