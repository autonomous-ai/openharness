import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_home_prefs.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_status.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_activity_fixture.dart' show activityMessage;
import 'swarm_fixture.dart';

/// The project status card at the top of a project's chat (Tony 11-01, task
/// 1), as the desktop draws it (project_status_card.dart): the coordinator's
/// last report and the decisions in this project waiting on the person.
void main() {
  const other = 'project-2', otherChat = 'group-lead-2';
  const today = '2026-11-01T09:52:00.000Z';

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
    String question = 'Fold the card by default?',
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
    final account = ValueNotifier<String?>(me);
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
  final heading = key('swarm-project-status-heading-$project');
  final fold = key('swarm-project-status-fold-$project');
  final needsYou = key('swarm-project-status-needs-you-$project');

  /// The heading as read: Status, when, and how many wait while folded.
  String headingText(WidgetTester tester) => [
    tester.widget<Text>(heading).textSpan!.toPlainText(),
    if (tester.any(needsYou))
      tester
          .widget<Text>(
            find.descendant(of: needsYou, matching: find.byType(Text)),
          )
          .data!,
  ].join();

  group('states', () {
    testWidgets('empty: no report and nothing waiting draws no card', (
      tester,
    ) async {
      await pump(tester, backend());
      expect(key('swarm-project-chat-$leadChat'), findsOneWidget);
      expect(card, findsNothing);
    });

    testWidgets('running: the report word for word under Status · updated', (
      tester,
    ) async {
      await pump(
        tester,
        backend(
          status: {
            'text': 'Running: phone status card\nDone today: #2459',
            'at': today,
          },
        ),
      );
      expect(card, findsOneWidget);
      expect(headingText(tester), startsWith('Status · updated '));
      expect(
        find.text('Running: phone status card\nDone today: #2459'),
        findsOneWidget,
      );
      expect(key('swarm-project-status-need-decision:d1'), findsNothing);
    });

    testWidgets('needs you: a decision here, with no report, still shows; a '
        'tap opens Activity at it', (tester) async {
      await pump(tester, backend(decisions: [decision('d1')]));
      expect(card, findsOneWidget);
      expect(headingText(tester), 'Status');
      final row = key('swarm-project-status-need-decision:d1');
      expect(row, findsOneWidget);
      expect(
        find.descendant(of: row, matching: find.text('River asks you')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: row,
          matching: find.text('Fold the card by default?'),
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
      await pump(
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

    testWidgets('long text scrolls inside the card, which never grows past '
        'its limit', (tester) async {
      final fake = backend(status: {'text': 'Short', 'at': today});
      await pump(tester, fake);
      final shortCard = tester.getSize(card).height;

      final long = List.generate(60, (i) => 'Line $i of the report').join('\n');
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          statusChange({'text': long, 'at': today});
      await host(tester).inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      final longCard = tester.getSize(card).height;
      expect(longCard, greaterThan(shortCard));
      expect(
        longCard,
        lessThanOrEqualTo(SwarmProjectStatusCard.maxBody + 44 + 8 + 2),
      );
      final body = key('swarm-project-status-body-$project');
      final scrollable = find.descendant(
        of: body,
        matching: find.byType(Scrollable),
      );
      expect(
        tester.state<ScrollableState>(scrollable).position.maxScrollExtent,
        greaterThan(0),
      );
    });
  });

  testWidgets('the card takes its room from the chat alone: folding it gives '
      'the chat exactly what the card gave up, and the composer stays put', (
    tester,
  ) async {
    final long = List.generate(30, (i) => 'Line $i of the report').join('\n');
    final fake = backend(
      status: {'text': long, 'at': today},
      decisions: [decision('d1')],
    );
    // A message, so the chat has its list: decisions are not in it.
    fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
      'messages': [activityMessage('m1', 1)],
      'next': null,
    };
    await pump(tester, fake);
    final chat = key('swarm-messages');
    final composer = find.byType(EditableText);
    final openCard = tester.getSize(card).height;
    final openChat = tester.getSize(chat).height;
    final openComposer = tester.getTopLeft(composer).dy;

    await tester.tap(fold);
    await tester.pumpAndSettle();
    final foldedCard = tester.getSize(card).height;
    final foldedChat = tester.getSize(chat).height;

    expect(openCard - foldedCard, greaterThan(100));
    expect(foldedChat - openChat, moreOrLessEquals(openCard - foldedCard));
    expect(tester.getTopLeft(composer).dy, openComposer);
  });

  testWidgets('on a 320-point phone a one-line report leaves its room to the '
      'decisions: at least two of three show in full', (tester) async {
    tester.view
      ..physicalSize = const Size(320, 568) * 3
      ..devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await pump(
      tester,
      backend(
        status: {'text': 'Building the card', 'at': today},
        decisions: [
          for (final (i, at) in ['09:10', '09:20', '09:30'].indexed)
            {
              ...decision('d$i', question: 'Question $i?'),
              'createdAt': '2026-11-01T$at:00.000Z',
            },
        ],
      ),
    );
    final box = tester.getRect(card);
    final shown = [
      for (final i in [0, 1, 2])
        if (tester.getRect(key('swarm-project-status-need-decision:d$i'))
            case final row when row.top >= box.top && row.bottom <= box.bottom)
          i,
    ];
    expect(shown.length, greaterThanOrEqualTo(2));
    expect(find.text('Building the card'), findsOneWidget);
  });

  testWidgets('a long report never hides what waits: the decision shows in '
      'full inside the card', (tester) async {
    final long = List.generate(30, (i) => 'Line $i of the report').join('\n');
    await pump(
      tester,
      backend(status: {'text': long, 'at': today}, decisions: [decision('d1')]),
    );
    final row = tester.getRect(key('swarm-project-status-need-decision:d1'));
    final box = tester.getRect(card);
    expect(row.top, greaterThanOrEqualTo(box.top));
    expect(row.bottom, lessThanOrEqualTo(box.bottom));
    expect(row.height, greaterThanOrEqualTo(56));
  });

  group('arrives late, fails, recovers', () {
    testWidgets('a report that arrives with a later read shows then, in place '
        'of none, and a newer one replaces it', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      expect(card, findsNothing);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          statusChange({'text': 'Building the card', 'at': today});
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Building the card'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          statusChange({'text': 'Card shipped', 'at': today}, version: 3);
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Card shipped'), findsOneWidget);
      expect(find.text('Building the card'), findsNothing);
    });

    testWidgets('a first read that fails shows no card and no endless '
        'loading; the read that recovers brings the card', (tester) async {
      final fake = backend(status: {'text': 'Building', 'at': today});
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw const SuperTabFailure('UNAVAILABLE', 'Down.', statusCode: 503);
      final host = await pump(tester, fake);
      expect(card, findsNothing);
      expect(find.text('Down.'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/parts'] = parts;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
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
      final host = await pump(tester, fake);
      expect(find.text('Building'), findsOneWidget);
      expect(key('swarm-project-status-need-decision:d1'), findsNothing);

      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = open;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(key('swarm-project-status-need-decision:d1'), findsOneWidget);
    });
  });

  group('privacy', () {
    testWidgets('a decision from another project, or from a chat of this '
        'project the person does not read, never shows, nor its title', (
      tester,
    ) async {
      await pump(
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
      expect(find.textContaining('Secret title'), findsNothing);
      expect(find.text('River asks you'), findsNothing);
    });

    testWidgets('a private project the person is not a member of shows no '
        'card, as the server reads it; made a member, it shows', (
      tester,
    ) async {
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
      final fake = backend(decisions: [decision('d1')]);
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        head: privateHead(member: false),
        derived: {'decisionsWaiting': 1},
      );
      final host = await pump(tester, fake);
      expect(key('swarm-project-chat-$leadChat'), findsOneWidget);
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
      expect(find.text('Private plans'), findsOneWidget);
    });

    testWidgets('access lost while the card is open takes it away, with what '
        'it held', (tester) async {
      final host = await pump(
        tester,
        backend(
          status: {'text': 'Building', 'at': today},
          decisions: [decision('d1')],
        ),
      );
      expect(find.text('Building'), findsOneWidget);
      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(card, findsNothing);
      expect(find.text('Building'), findsNothing);
      expect(find.text('River asks you'), findsNothing);
    });

    testWidgets('a project taken away by a later read takes its card with it', (
      tester,
    ) async {
      final fake = backend(status: {'text': 'Building', 'at': today});
      final host = await pump(tester, fake);
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
      expect(card, findsNothing);
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
      final host = await pump(tester, fake);
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
  });

  group('fold', () {
    testWidgets('folds to its heading, which still says what waits, and stays '
        'folded when the project opens again', (tester) async {
      final marks = MemoryKeyValueStore();
      final fake = backend(
        status: {'text': 'Building', 'at': today},
        decisions: [decision('d1')],
      );
      await pump(tester, fake, marks: marks);
      expect(find.text('Building'), findsOneWidget);

      await tester.tap(fold);
      await tester.pumpAndSettle();
      expect(find.text('Building'), findsNothing);
      expect(key('swarm-project-status-need-decision:d1'), findsNothing);
      expect(headingText(tester), endsWith(' · 1 needs you'));

      // Opened again, with the same phone's store.
      await tester.pumpWidget(const SizedBox());
      await pump(tester, fake, marks: marks);
      expect(card, findsOneWidget);
      expect(find.text('Building'), findsNothing);
      await tester.tap(fold);
      await tester.pumpAndSettle();
      expect(find.text('Building'), findsOneWidget);
    });

    testWidgets('a report that arrives while folded changes only the heading: '
        'the card keeps its height, so the chat does not jump', (tester) async {
      final fake = backend(status: {'text': 'Building', 'at': today});
      final host = await pump(tester, fake);
      await tester.tap(fold);
      await tester.pumpAndSettle();
      final height = tester.getSize(card).height;
      final composer = tester.getTopLeft(find.byType(EditableText)).dy;
      final before = headingText(tester);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => statusChange({
        'text': List.filled(40, 'A much longer report').join('\n'),
        'at': '2026-11-01T10:07:00.000Z',
      });
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.textContaining('A much longer report'), findsNothing);
      expect(headingText(tester), isNot(before));
      expect(tester.getSize(card).height, height);
      expect(tester.getTopLeft(find.byType(EditableText)).dy, composer);
    });

    testWidgets('folds while the keyboard is up, so it never pushes the '
        'composer, and opens again when it goes', (tester) async {
      await pump(tester, backend(status: {'text': 'Building', 'at': today}));
      expect(find.text('Building'), findsOneWidget);
      tester.view.viewInsets = const FakeViewPadding(bottom: 900);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      expect(card, findsOneWidget);
      expect(find.text('Building'), findsNothing);
      tester.view.resetViewInsets();
      await tester.pumpAndSettle();
      expect(find.text('Building'), findsOneWidget);
    });

    testWidgets('while the keyboard folds it there is no fold button, so no '
        'tap saves a fold the person never saw', (tester) async {
      final host = await pump(
        tester,
        backend(status: {'text': 'Building', 'at': today}),
      );
      tester.view.viewInsets = const FakeViewPadding(bottom: 900);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      expect(fold, findsNothing);
      final byKeyboard = tester.getSize(card).height;
      expect(host.session!.home.folded(tab, project), isFalse);

      // Folded by the person, then the keyboard: still no button.
      tester.view.resetViewInsets();
      await tester.pumpAndSettle();
      await tester.tap(fold);
      await tester.pumpAndSettle();
      // Folded either way, the card is as tall: no jump as the button goes.
      expect(tester.getSize(card).height, byKeyboard);
      tester.view.viewInsets = const FakeViewPadding(bottom: 900);
      await tester.pumpAndSettle();
      expect(fold, findsNothing);
      expect(host.session!.home.folded(tab, project), isTrue);
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
      await pump(
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

  group('Activity from the card', () {
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
        'messages; the card holds them', (tester) async {
      await pump(
        tester,
        backend(
          status: {'text': 'Building', 'at': today},
          decisions: [decision('d1')],
        ),
      );
      expect(key('swarm-project-status-need-decision:d1'), findsOneWidget);
      expect(key('swarm-ask-d1'), findsNothing);
      expect(key('swarm-option-d1-0'), findsNothing);
    });

    testWidgets('folded, "N need you" is a tap target that opens Activity on '
        'this project alone', (tester) async {
      await pump(
        tester,
        backend(status: {'text': 'Building', 'at': today}, decisions: both()),
      );
      await tester.tap(fold);
      await tester.pumpAndSettle();
      expect(needsYou, findsOneWidget);
      expect(tester.getSize(needsYou).height, greaterThanOrEqualTo(44));

      await tester.tap(needsYou);
      await tester.pumpAndSettle();
      expect(
        tester.widget<SwarmActivityPage>(find.byType(SwarmActivityPage)).focus,
        isNull,
      );
      expectMobileOnly(tester);
    });

    testWidgets('a waiting line opens Activity at it, on this project alone', (
      tester,
    ) async {
      await pump(tester, backend(decisions: both()));
      await tester.tap(key('swarm-project-status-need-decision:d1'));
      await tester.pumpAndSettle();

      expect(key('swarm-activity-open-decision:d1'), findsOneWidget);
      expectMobileOnly(tester);
    });

    testWidgets("answering in Activity takes it off the card's count", (
      tester,
    ) async {
      final fake = backend(
        status: {'text': 'Building', 'at': today},
        decisions: both(),
      );
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
        'result': <String, dynamic>{},
      };
      await pump(tester, fake);
      final session = host(tester);
      await tester.tap(fold);
      await tester.pumpAndSettle();
      expect(headingText(tester), endsWith(' · 1 needs you'));

      await tester.tap(needsYou);
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-activity-row-decision:d1'));
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
      expect(card, findsOneWidget);
      expect(needsYou, findsNothing);
      expect(headingText(tester), isNot(contains('need')));
    });

    testWidgets('access lost while its Activity is open: the rows and the '
        "project's name go, nothing stuck loading", (tester) async {
      await pump(tester, backend(decisions: both()));
      final session = host(tester);
      await tester.tap(key('swarm-project-status-need-decision:d1'));
      await tester.pumpAndSettle();
      expect(find.text('Fold the card by default?'), findsWidgets);

      session.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(find.text('#Mobile'), findsNothing);
      expect(find.text('Fold the card by default?'), findsNothing);
      expect(find.textContaining('River'), findsNothing);
      expect(key('swarm-activity-loading'), findsNothing);
    });

    testWidgets('the project made private to others while its Activity is '
        'open: its rows and name go', (tester) async {
      final fake = backend(decisions: both());
      await pump(tester, fake);
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
      expect(find.text('Fold the card by default?'), findsNothing);
    });
  });
}

/// The session of the host the page was pumped under.
SwarmSession host(WidgetTester tester) =>
    SwarmScope.of(tester.element(find.byType(SwarmProjectPage)))!;
