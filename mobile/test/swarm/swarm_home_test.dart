import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppFont;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_drawer.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_needs_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The person's computers as a test sets them.
class _Computers extends ChangeNotifier implements SwarmComputers {
  @override
  List<SwarmOwnComputer> get own => const [];

  @override
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  ) async => throw UnimplementedError();

  _Computers(this.computers);

  @override
  List<SwarmComputer>? computers;

  @override
  bool get rechecking => false;

  void set(List<SwarmComputer>? next) {
    computers = next;
    notifyListeners();
  }

  @override
  Future<void> recheck() async {}

  @override
  void add(BuildContext context) {}
}

/// Half an hour after the fixture's parts last changed (epoch milliseconds
/// 1 and on): every project moved 30 minutes ago, and none is quiet.
DateTime _halfHourIn() => DateTime.fromMillisecondsSinceEpoch(
  0,
  isUtc: true,
).add(const Duration(minutes: 30, seconds: 1));

/// Half a second of frames, for a screen that cannot settle.
Future<void> frames(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// Swarm Home and its drawer, over a scripted backend: one Swarm with two
/// projects. Mobile has River as its Product Manager, Nova waiting on the
/// person in g1, Atlas down, and the person's old Chat with PM, which a
/// server before #2090 still sends; Web has Cleo as its Product Manager.
/// With [buddy], Mobile has the person's Buddy chat and their Buddy Wren
/// running in it; Web has no Buddy chat yet, and opening one opens
/// `buddy-web`.
void main() {
  const web = 'project-2';
  const webLead = 'group-lead-web';

  FakeSwarm backend({bool buddy = false}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 1};
    Map<String, dynamic> inWeb(Map<String, dynamic> row) => {
      ...row,
      'projectId': web,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      derived: derived,
      head: headData(
        projects: [
          {
            'id': project,
            'name': 'Mobile',
            'ownerId': me,
            'leadConversationId': leadChat,
            'visibility': 'public',
            'members': <Object>[],
            'updateMinutes': 5,
          },
          {
            'id': web,
            'name': 'Web',
            'ownerId': me,
            'leadConversationId': webLead,
            'visibility': 'public',
            'members': <Object>[],
            'updateMinutes': 5,
          },
        ],
      ),
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'River'),
        agent('agent-builder', displayName: 'Nova'),
        {
          ...agent('agent-atlas', displayName: 'Atlas'),
          'downSince': '2026-10-27T01:00:00.000Z',
        },
        inWeb(agent('agent-cleo', name: 'Lead', displayName: 'Cleo')),
        if (buddy) buddyData('agent-wren', displayName: 'Wren'),
      ],
      groups: [
        groupData(
          'g1',
          title: 'Fix login',
          number: 4,
          agentIds: ['agent-lead', 'agent-builder'],
          status: 'needs_human',
          lastMessageSequence: 9,
        ),
        groupData(
          'g-atlas',
          title: 'Search page',
          number: 5,
          agentIds: ['agent-atlas'],
          status: 'lost',
          workerId: 'agent-atlas',
          lastMessageSequence: 3,
        ),
        groupData('g-busy', title: 'Sync', lastMessageSequence: 20),
        groupData(
          'g-private',
          title: 'Their chat',
          audience: ['person-other', 'person-third'],
        ),
        groupData('g-pm', title: 'me', audience: [me]),
        if (buddy) buddyChatData('buddy-me', agentIds: ['agent-wren']),
        inWeb(
          groupData(
            webLead,
            title: 'Web',
            agentIds: ['agent-cleo'],
            leadId: 'agent-cleo',
          ),
        ),
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [
        {
          'id': 'd1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'askerName': 'River',
          'question': 'Ship it behind a flag?',
          'options': ['Yes', 'No'],
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [
        {
          'id': 'm1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'messageId': 'msg-1',
          'leadName': 'River',
          'text': 'Can you check the copy?',
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (body) => {
      'result': switch (body?['command']) {
        {'type': 'buddy.chat', 'projectId': web} => {
          'conversationId': 'buddy-web',
        },
        _ => <String, dynamic>{},
      },
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  /// Swarm Home as the root of its own stack, Swarm on, on an iPhone's
  /// screen. Its route is the shell's kind, the kind of every page pushed
  /// over it: a push or pop builds nothing of Home again, as on the phone.
  /// [overPage] opens it over another page instead ([openSwarmHome]).
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    void Function(BuildContext context)? onSettings,
    SwarmComputers? computers,
    bool settle = true,
    bool overPage = false,
    DateTime Function()? now,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      computers: computers,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        onGenerateRoute: (_) => CupertinoPageRoute<void>(
          builder: (_) => overPage
              ? const SizedBox(key: ValueKey('page-under'))
              : SwarmPage(onSettings: onSettings, now: now ?? _halfHourIn),
        ),
      ),
    );
    if (overPage) {
      openSwarmHome(tester.element(find.byKey(const ValueKey('page-under'))));
    }
    // A skeleton breathes for as long as it shows: nothing settles under it.
    settle ? await tester.pumpAndSettle() : await frames(tester);
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  double y(WidgetTester tester, String k) => tester.getTopLeft(key(k)).dy;
  Finder inside(String k, Finder matching) =>
      find.descendant(of: key(k), matching: matching);
  double middle(WidgetTester tester, Finder finder) =>
      tester.getCenter(finder).dy;

  Future<void> openDrawer(WidgetTester tester) async {
    await tester.tap(key('swarm-menu'));
    await tester.pumpAndSettle();
  }

  /// Every need, from Home's See all.
  Future<void> openNeeds(WidgetTester tester) async {
    await tester.tap(key('swarm-needs-all'));
    await tester.pumpAndSettle();
  }

  /// Mobile's chats in [backend].
  const mobileChats = [
    leadChat,
    'g1',
    'g-atlas',
    'g-busy',
    'g-private',
    'g-pm',
  ];

  /// [fake]'s first load with each of [at]'s chats last changed then, in
  /// epoch milliseconds.
  void timed(FakeSwarm fake, Map<String, int> at) {
    final load = fake.routes['/api/super-tabs/$tab/parts']!;
    fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
      final answer = await load(body) as Map<String, dynamic>;
      return {
        ...answer,
        'groups': [
          for (final part in answer['groups'] as List)
            {...part as Map<String, dynamic>, 'changedAt': ?at[part['key']]},
        ],
      };
    };
  }

  /// The weight of the words in row [k] that hold [words].
  FontWeight? weightOf(WidgetTester tester, String k, String words) => tester
      .widget<Text>(inside(k, find.textContaining(words)))
      .style
      ?.fontWeight;

  /// A change read in which [groups] moved, by id.
  void moveOn(FakeSwarm fake, Map<String, Map<String, dynamic>> groups) =>
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        derived: const {'decisionsWaiting': 1, 'mentionsWaiting': 1},
        groups: [
          for (final MapEntry(:key, :value) in groups.entries)
            part(key, 30, value),
        ],
      );

  group('the drawer', () {
    testWidgets('slim, as B3 draws it: who you are, Swarm Home with what '
        'waits, the Swarms, the one shown ticked, Join or create, Your models '
        'and devices, Settings at its foot; no project in it', (tester) async {
      var settings = 0;
      await pump(
        tester,
        backend(),
        onSettings: (_) => settings++,
        computers: _Computers(const []),
      );
      await openDrawer(tester);

      expect(
        tester.getSize(find.byType(Drawer)).width,
        closeTo(390 * .86, .5),
        reason: "most of the screen, as the prototype's",
      );
      final order = [
        'swarm-drawer-you-$tab',
        'swarm-drawer-home',
        'swarm-drawer-swarm-$tab',
        'swarm-drawer-join',
        'swarm-drawer-models',
        'swarm-drawer-devices',
        'swarm-drawer-settings',
      ];
      for (final (i, k) in order.indexed.skip(1)) {
        expect(y(tester, order[i - 1]), lessThan(y(tester, k)), reason: k);
      }
      expect(
        inside('swarm-drawer-home', find.byType(SwarmBadge)),
        findsOneWidget,
        reason: 'what waits on the person, in a filled count',
      );
      expect(inside('swarm-drawer-home', find.text('3')), findsOneWidget);
      expect(
        inside('swarm-drawer-home', find.byIcon(LucideIcons.house300)),
        findsOneWidget,
      );
      expect(
        inside('swarm-drawer-swarm-$tab', find.text('Phone Swarm')),
        findsOneWidget,
      );
      expect(
        inside('swarm-drawer-swarm-$tab', find.byIcon(LucideIcons.check300)),
        findsOneWidget,
        reason: 'the only Swarm is the one Home shows',
      );
      final drawer = find.byType(SwarmDrawer);
      expect(
        find.descendant(of: drawer, matching: find.text('Swarms')),
        findsOneWidget,
      );
      for (final gone in ['Mobile', 'Web', 'Projects', 'Buddies']) {
        expect(
          find.descendant(of: drawer, matching: find.text(gone)),
          findsNothing,
          reason:
              'projects, their chats and Buddies are on Home and '
              "each project's page",
        );
      }

      await tester.tap(key('swarm-drawer-settings'));
      await tester.pumpAndSettle();
      expect(settings, 1);
    });

    testWidgets('its close button closes it', (tester) async {
      await pump(tester, backend());
      await openDrawer(tester);
      expect(
        middle(tester, key('swarm-drawer-close')),
        closeTo(middle(tester, find.text('Swarm').last), 2),
        reason: 'beside its title',
      );

      await tester.tap(key('swarm-drawer-close'));
      await tester.pumpAndSettle();

      expect(key('swarm-drawer-home'), findsNothing);
    });

    testWidgets('Join or create a Swarm says how, on the phone that makes '
        'none', (tester) async {
      await pump(tester, backend());
      await openDrawer(tester);

      await tester.tap(key('swarm-drawer-join'));
      await tester.pumpAndSettle();

      expect(key('swarm-drawer-home'), findsNothing, reason: 'it closed');
      expect(find.text('Join or create a Swarm'), findsOneWidget);
      expect(
        find.text('To join one, ask its owner to invite you. To start one:'),
        findsOneWidget,
      );
      await tester.tap(find.text('Got it'));
      await tester.pumpAndSettle();
      expect(find.text('Join or create a Swarm'), findsNothing);
    });
  });

  group('Swarm Home', () {
    testWidgets('Needs you first, two of it and See all, then the projects; '
        'no Buddies', (tester) async {
      await pump(tester, backend(buddy: true));

      expect(key('swarm-menu'), findsOneWidget);
      expect(key('tty-back'), findsNothing);
      expect(key('swarm-home-need-decision:d1'), findsOneWidget);
      expect(key('swarm-home-need-mention:m1'), findsOneWidget);
      expect(
        key('swarm-home-need-work:$tab:g1:attempt-g1:needs_human'),
        findsNothing,
        reason: 'two, then See all',
      );
      expect(inside('swarm-needs-all', find.text('See all 3')), findsOne);
      expect(
        y(tester, 'swarm-home-need-decision:d1'),
        lessThan(y(tester, 'swarm-home-need-mention:m1')),
      );
      expect(
        y(tester, 'swarm-needs-all'),
        lessThan(y(tester, 'swarm-project-$tab-$project')),
      );
      expect(find.text('Buddies'), findsNothing);
      expect(key('swarm-home-buddy-$tab-$project'), findsNothing);
      expect(find.text('Chat with PM'), findsNothing);
    });

    testWidgets('a need: a yellow dot, what is asked in bold, its project and '
        'who asks under it; a tap opens it among the rest', (tester) async {
      await pump(tester, backend());

      const row = 'swarm-home-need-decision:d1';
      expect(weightOf(tester, row, 'Ship it behind a flag?'), AppFont.semibold);
      expect(inside(row, find.text('Mobile · River')), findsOneWidget);
      expect(
        inside(
          'swarm-home-need-mention:m1',
          find.text('Can you check the copy?'),
        ),
        findsOneWidget,
      );
      expect(
        inside(row, find.byIcon(LucideIcons.chevronRight300)),
        findsOneWidget,
      );

      await tester.tap(key('swarm-home-need-mention:m1'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmNeedsPage), findsOneWidget);
      expect(key('swarm-done-m1'), findsOneWidget, reason: 'open there');
      expect(key('swarm-option-d1-0'), findsNothing);
      expect(key('swarm-need-row-decision:d1'), findsOneWidget);
    });

    testWidgets('See all lists every need, the first open', (tester) async {
      await pump(tester, backend());

      await openNeeds(tester);

      expect(find.text('Needs you'), findsOneWidget);
      expect(key('swarm-option-d1-0'), findsOneWidget);
      expect(key('swarm-need-row-mention:m1'), findsOneWidget);
      expect(
        key('swarm-need-row-work:$tab:g1:attempt-g1:needs_human'),
        findsOneWidget,
      );
      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(key('swarm-menu'), findsOneWidget);
    });

    testWidgets('a project the Lead tagged the person in is bold and bright '
        'with @N filled; the rest are quiet; each has its team in coloured '
        'dots and when it last moved', (tester) async {
      final semantics = tester.ensureSemantics();
      await pump(tester, backend());

      const mobileRow = 'swarm-project-$tab-$project';
      const webRow = 'swarm-project-$tab-$web';
      expect(weightOf(tester, mobileRow, 'Mobile'), AppFont.semibold);
      final tags = tester.widget<SwarmTags>(
        inside(mobileRow, find.byType(SwarmTags)),
      );
      expect((tags.count, tags.filled), (1, true));
      expect(find.bySemanticsLabel(RegExp('1 mention')), findsOneWidget);
      expect(weightOf(tester, webRow, 'Web'), isNot(AppFont.semibold));
      expect(inside(webRow, find.textContaining('@')), findsNothing);
      String team(String row) => tester
          .widget<RichText>(
            find.descendant(
              of: inside(row, find.byType(SwarmTeamDots)),
              matching: find.byType(RichText),
            ),
          )
          .text
          .toPlainText();
      expect(team(mobileRow), '● 1 waiting  ● 1 down');
      expect(team(webRow), 'All idle');
      expect(inside(mobileRow, find.text('30m')), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('a project with a chat read since is bold, with a dot and no '
        'count', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      moveOn(fake, {
        webLead: {
          ...groupData(
            webLead,
            title: 'Web',
            agentIds: ['agent-cleo'],
            leadId: 'agent-cleo',
            lastMessageSequence: 1,
          ),
          'projectId': web,
        },
      });
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      const webRow = 'swarm-project-$tab-$web';
      expect(weightOf(tester, webRow, 'Web'), AppFont.semibold);
      expect(inside(webRow, find.textContaining('@')), findsNothing);
      expect(inside(webRow, find.byType(SwarmTags)), findsNothing);
    });

    testWidgets('projects newest first, each with how long ago it moved', (
      tester,
    ) async {
      final now = DateTime.utc(2026, 10, 29, 10);
      int ago(int minutes) =>
          now.subtract(Duration(minutes: minutes)).millisecondsSinceEpoch;
      final fake = backend();
      timed(fake, {for (final id in mobileChats) id: ago(9), webLead: ago(2)});
      await pump(tester, fake, now: () => now);

      expect(
        y(tester, 'swarm-project-$tab-$web'),
        lessThan(y(tester, 'swarm-project-$tab-$project')),
      );
      expect(inside('swarm-project-$tab-$web', find.text('2m')), findsOne);
      expect(inside('swarm-project-$tab-$project', find.text('9m')), findsOne);
    });

    testWidgets('a project quiet for a day folds under Other projects, which '
        'a tap opens and closes', (tester) async {
      final now = DateTime.utc(2026, 10, 29, 10);
      int ago(int minutes) =>
          now.subtract(Duration(minutes: minutes)).millisecondsSinceEpoch;
      final fake = backend()
        ..routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
          'mentions': <Object>[],
        };
      timed(fake, {
        for (final id in mobileChats) id: ago(60 * 48),
        webLead: ago(5),
      });
      await pump(tester, fake, now: () => now);

      expect(key('swarm-project-$tab-$web'), findsOneWidget);
      expect(key('swarm-project-$tab-$project'), findsNothing);
      expect(
        inside('swarm-other-projects', find.text('Other projects (1)')),
        findsOneWidget,
      );
      expect(
        inside('swarm-other-projects', find.text('Quiet for 24h')),
        findsOneWidget,
      );

      await tester.tap(key('swarm-other-projects'));
      await tester.pumpAndSettle();
      expect(
        y(tester, 'swarm-other-projects'),
        lessThan(y(tester, 'swarm-project-$tab-$project')),
      );
      expect(inside('swarm-project-$tab-$project', find.text('2d')), findsOne);

      await tester.tap(key('swarm-other-projects'));
      await tester.pumpAndSettle();
      expect(key('swarm-project-$tab-$project'), findsNothing);
    });

    testWidgets('a long press pins a project at the top, under Pinned; '
        'Unpin puts it back', (tester) async {
      final host = await pump(tester, backend());
      expect(find.text('Pinned'), findsNothing);

      await tester.longPress(key('swarm-project-$tab-$web'));
      await tester.pumpAndSettle();
      expect(inside('swarm-pin', find.text('Pin to top')), findsOneWidget);
      await tester.tap(key('swarm-pin'));
      await tester.pumpAndSettle();

      expect(find.text('Pinned'), findsOneWidget);
      expect(
        y(tester, 'swarm-project-$tab-$web'),
        lessThan(tester.getTopLeft(find.text('Projects')).dy),
      );
      expect(host.session!.home.pinned(tab, web), isTrue);

      await tester.longPress(key('swarm-project-$tab-$web'));
      await tester.pumpAndSettle();
      expect(inside('swarm-pin', find.text('Unpin')), findsOneWidget);
      await tester.tap(key('swarm-pin'));
      await tester.pumpAndSettle();
      expect(find.text('Pinned'), findsNothing);
      expect(host.session!.home.pinned(tab, web), isFalse);
    });

    testWidgets("the prototype's top bar, captions and tiles", (tester) async {
      await pump(tester, backend());

      expect(
        middle(tester, key('swarm-title')),
        closeTo(middle(tester, key('swarm-menu')), 2),
        reason: 'the title beside the menu, in one bar',
      );
      expect(
        tester.getRect(key('swarm-menu')),
        const Rect.fromLTWH(
          4,
          0,
          44,
          44,
        ).shift(Offset(0, tester.getTopLeft(key('swarm-menu')).dy)),
        reason: "the prototype's 44-point menu, 4 points in",
      );
      expect(
        tester.getTopLeft(key('swarm-title')).dx,
        4 + 44 + 4,
        reason: 'the title 4 points beside it',
      );
      expect(find.text('Swarm'), findsOneWidget);
      for (final caption in ['Needs you', 'Projects']) {
        expect(find.text(caption), findsOneWidget, reason: 'sentence case');
      }
      expect(
        tester.widget<Text>(key('swarm-needs-count')).data,
        '3',
        reason: 'how many need the person, beside Needs you',
      );
      expect(
        tester.widget<Text>(key('swarm-needs-count')).style?.color,
        AppColors.warning,
      );
      expect(
        inside('swarm-project-$tab-$project', find.byType(SwarmProjectTile)),
        findsOneWidget,
        reason: "a project's initial in a tile",
      );
      expect(inside('swarm-project-$tab-$project', find.text('m')), findsOne);
    });

    testWidgets(
      'an open decision: its glyph, who asks and where, the question, '
      'its options side by side; who asks opens the chat',
      (tester) async {
        await pump(tester, backend());
        await openNeeds(tester);

        const card = 'swarm-need-decision:d1';
        expect(
          inside(card, find.byIcon(LucideIcons.circleQuestionMark300)),
          findsOneWidget,
        );
        expect(
          inside(
            card,
            find.text('River asks you · Mobile', findRichText: true),
          ),
          findsOneWidget,
        );
        expect(
          inside(card, find.text('Ship it behind a flag?')),
          findsOneWidget,
        );
        expect(
          middle(tester, key('swarm-option-d1-0')),
          middle(tester, key('swarm-option-d1-1')),
          reason: 'two options share a line',
        );
        expect(
          tester.getSize(key('swarm-option-d1-0')).height,
          greaterThanOrEqualTo(44),
        );
        expect(inside(card, find.text('Open chat')), findsNothing);

        await tester.tap(key('swarm-need-open-decision:d1'));
        await tester.pumpAndSettle();
        final page = tester.widget<SwarmConversationPage>(
          find.byType(SwarmConversationPage),
        );
        expect((page.swarmId, page.conversationId), (tab, 'g1'));
      },
    );

    testWidgets('a need card is set on the type roles: 17-point words, '
        '16 points in, its glyph level with the first line', (tester) async {
      await pump(tester, backend());
      await openNeeds(tester);

      const card = 'swarm-need-decision:d1';
      final title = find.descendant(
        of: key(card),
        matching: find.text('River asks you · Mobile', findRichText: true),
      );
      expect(
        tester.renderObject<RenderParagraph>(title).text.style?.fontSize,
        17,
        reason: 'the label role',
      );
      expect(
        tester
            .widget<Text>(inside(card, find.text('Ship it behind a flag?')))
            .style
            ?.fontSize,
        17,
        reason: 'the body role',
      );
      final glyph = inside(
        card,
        find.byIcon(LucideIcons.circleQuestionMark300),
      );
      expect(tester.getTopLeft(glyph).dx - tester.getTopLeft(key(card)).dx, 16);
      expect(
        tester.getCenter(glyph).dy,
        closeTo(tester.getTopLeft(title).dy + 17 * 1.3 / 2, .1),
        reason: "centred on the title's first line (17 points at 1.3)",
      );
    });

    testWidgets('an open tag has Done, filled, and Open chat; open work has '
        'Open chat', (tester) async {
      await pump(tester, backend());
      await openNeeds(tester);
      await tester.tap(key('swarm-need-row-mention:m1'));
      await tester.pumpAndSettle();

      expect(
        tester.widget<SwarmButton>(key('swarm-done-m1')).style,
        SwarmButtonStyle.fill,
      );
      expect(
        middle(tester, key('swarm-done-m1')),
        middle(tester, key('swarm-need-chat-mention:m1')),
      );
      expect(
        inside('swarm-need-mention:m1', find.byIcon(LucideIcons.atSign300)),
        findsOneWidget,
      );
      expect(
        inside(
          'swarm-need-row-decision:d1',
          find.byIcon(LucideIcons.circleQuestionMark300),
        ),
        findsOneWidget,
        reason: 'a closed need keeps its glyph',
      );

      const work = 'work:$tab:g1:attempt-g1:needs_human';
      await tester.tap(key('swarm-need-row-$work'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-need-chat-$work'));
      await tester.pumpAndSettle();
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g1'));
    });

    testWidgets('Needs you opens one thing at a time; a line opens the next', (
      tester,
    ) async {
      await pump(tester, backend());
      await openNeeds(tester);

      expect(key('swarm-option-d1-0'), findsOneWidget);
      expect(key('swarm-done-m1'), findsNothing);
      expect(key('swarm-need-row-mention:m1'), findsOneWidget);
      expect(
        key('swarm-need-row-work:$tab:g1:attempt-g1:needs_human'),
        findsOneWidget,
      );
      expect(find.text('River tagged you'), findsOneWidget);
      expect(find.text('Nova needs you'), findsOneWidget);

      await tester.tap(key('swarm-need-row-mention:m1'));
      await tester.pumpAndSettle();

      expect(key('swarm-done-m1'), findsOneWidget);
      expect(key('swarm-option-d1-0'), findsNothing);
      expect(key('swarm-need-row-decision:d1'), findsOneWidget);
      expect(find.text('River asks you'), findsOneWidget);
    });

    testWidgets('one tap answers, held for Undo, said on Home too; then the '
        'next need opens', (tester) async {
      final fake = backend();
      var answered = false;
      fake.routes['/api/super-tabs/$tab/commands'] = (body) {
        if (body?['command']?['type'] == 'decision.answer') answered = true;
        return {'result': <String, dynamic>{}};
      };
      final open = fake.routes['/api/super-tabs/$tab/decisions?state=open']!;
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (body) =>
          answered ? {'decisions': <Object>[]} : open(body);
      await pump(tester, fake);
      await openNeeds(tester);

      await tester.tap(key('swarm-option-d1-0'));
      await tester.pump();
      expect(find.text('Sending “Yes”'), findsOneWidget);
      expect(key('swarm-undo-d1'), findsOneWidget);
      double bar() => tester
          .widget<FractionallySizedBox>(
            inside('swarm-need-decision:d1', find.byType(FractionallySizedBox)),
          )
          .widthFactor!;
      expect(bar(), 1, reason: 'the Undo window, full');
      await tester.pump(const Duration(seconds: 2));
      expect(fake.commands, isEmpty, reason: 'still in its Undo window');
      expect(bar(), lessThan(.5), reason: 'draining');
      expect(
        find.descendant(
          of: find.byType(SwarmPage, skipOffstage: false),
          matching: find.text('Sending “Yes”', skipOffstage: false),
        ),
        findsOneWidget,
        reason: "Home's row says it too",
      );

      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(fake.commands.single, {
        'type': 'decision.answer',
        'decisionId': 'd1',
        'choice': 0,
      });
      expect(key('swarm-need-decision:d1'), findsNothing);
      expect(key('swarm-done-m1'), findsOneWidget, reason: 'the tag is next');
    });

    testWidgets('Done marks a tag done', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await tester.tap(key('swarm-home-need-mention:m1'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-done-m1'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {'type': 'mention.done', 'mentionId': 'm1'});
    });

    testWidgets('nothing waiting says so, and the rest of Home stays', (
      tester,
    ) async {
      final fake = backend();
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      await pump(tester, fake);

      expect(find.text('Nothing needs you.'), findsOneWidget);
      expect(key('swarm-needs-all'), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets('back from a project, Home still has its menu, and it opens '
        'the drawer', (tester) async {
      await pump(tester, backend());

      await tester.tap(key('swarm-project-$tab-$project'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectPage), findsOneWidget);

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(key('swarm-menu'), findsOneWidget);
      expect(key('tty-back'), findsNothing, reason: 'Home is the root');

      await openDrawer(tester);
      expect(find.byType(SwarmDrawer), findsOneWidget);
    });

    testWidgets('opened over another page, it has back instead of the menu, '
        'and back goes to that page', (tester) async {
      await pump(tester, backend(), overPage: true);
      expect(find.byType(SwarmPage), findsOneWidget);
      expect(key('swarm-menu'), findsNothing);

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmPage), findsNothing);
      expect(key('page-under'), findsOneWidget);
    });

    testWidgets('a project opens its page', (tester) async {
      await pump(tester, backend());

      await tester.tap(key('swarm-project-$tab-$web'));
      await tester.pumpAndSettle();

      final page = tester.widget<SwarmProjectPage>(
        find.byType(SwarmProjectPage),
      );
      expect((page.swarmId, page.projectId), (tab, web));
    });
  });

  group('several Swarms', () {
    const second = 'tab-2';

    /// The Swarm of [backend], and Work Swarm, whose one project has the
    /// same id as Mobile's, named Backend, and asks nothing of the person.
    FakeSwarm two() {
      final fake = backend();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
          {'id': second, 'name': 'Work Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$second/parts'] = (_) => firstLoad(
        tabId: second,
        head: headData(
          id: second,
          name: 'Work Swarm',
          projects: [
            {
              'id': project,
              'name': 'Backend',
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
            },
          ],
        ),
      );
      fake.routes['/api/super-tabs/$second/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$second/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$second/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      return fake;
    }

    testWidgets("every Swarm's projects on Home, each with its Swarm; the "
        'same project id in two Swarms is two rows, pinned apart', (
      tester,
    ) async {
      final host = await pump(tester, two());

      const mobileRow = 'swarm-project-$tab-$project';
      const backendRow = 'swarm-project-$second-$project';
      expect(inside(mobileRow, find.text('Mobile')), findsOneWidget);
      expect(inside(backendRow, find.text('Backend')), findsOneWidget);
      expect(
        inside(
          backendRow,
          find.textContaining('Work Swarm · ', findRichText: true),
        ),
        findsOneWidget,
      );

      await tester.longPress(key(backendRow));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-pin'));
      await tester.pumpAndSettle();

      expect(host.session!.home.pins, {'$second/$project'});
      expect(
        y(tester, backendRow),
        lessThan(tester.getTopLeft(find.text('Projects')).dy),
      );
      expect(
        y(tester, mobileRow),
        greaterThan(tester.getTopLeft(find.text('Projects')).dy),
      );
    });

    testWidgets('a Swarm picked in the drawer is Home alone, ticked; what '
        'waits in the other is counted on its row; Swarm Home shows all '
        'again', (tester) async {
      final host = await pump(tester, two());
      await openDrawer(tester);
      for (final id in [tab, second]) {
        expect(
          inside('swarm-drawer-swarm-$id', find.byIcon(LucideIcons.check300)),
          findsNothing,
          reason: 'Home shows both',
        );
      }

      await tester.tap(key('swarm-drawer-swarm-$second'));
      await tester.pumpAndSettle();

      expect(host.session!.home.swarmId, second);
      expect(key('swarm-project-$second-$project'), findsOneWidget);
      expect(key('swarm-project-$tab-$project'), findsNothing);
      expect(key('swarm-project-$tab-$web'), findsNothing);
      expect(find.text('Nothing needs you.'), findsOneWidget);
      expect(
        inside(
          'swarm-project-$second-$project',
          find.textContaining('Work Swarm', findRichText: true),
        ),
        findsNothing,
        reason: 'one Swarm: its name is not on each row',
      );

      await openDrawer(tester);
      expect(
        inside('swarm-drawer-swarm-$second', find.byIcon(LucideIcons.check300)),
        findsOneWidget,
      );
      expect(inside('swarm-drawer-swarm-$tab', find.text('3')), findsOneWidget);

      await tester.tap(key('swarm-drawer-home'));
      await tester.pumpAndSettle();
      expect(host.session!.home.swarmId, isNull);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(key('swarm-home-need-decision:d1'), findsOneWidget);
    });

    testWidgets('a Swarm the account loses while Home is open: its rows '
        'leave Home, and its pin and pick leave the phone', (tester) async {
      final fake = two();
      final host = await pump(tester, fake);
      host.session!.home
        ..pin(second, project, true)
        ..show(second);
      await tester.pumpAndSettle();
      expect(key('swarm-project-$second-$project'), findsOneWidget);

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(key('swarm-project-$second-$project'), findsNothing);
      expect(find.text('Backend'), findsNothing);
      expect(find.text('Pinned'), findsNothing);
      expect(host.session!.home.pins, isEmpty);
      expect(host.session!.home.swarmId, isNull);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets("a project's pin sheet whose Swarm refuses its read while it "
        'is open shows nothing of it at once, closes and pins nothing', (
      tester,
    ) async {
      final fake = two();
      final host = await pump(tester, fake);
      await tester.longPress(key('swarm-project-$second-$project'));
      await tester.pumpAndSettle();
      expect(inside('swarm-pin', find.text('Pin to top')), findsOneWidget);
      expect(find.text('Backend'), findsNWidgets(2), reason: 'row and sheet');

      Never refused(_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'You no longer have access to this Swarm.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$second/changes'] = refused;
      fake.routes['/api/super-tabs/$second/parts'] = refused;
      await host.session!.inbox.reader(second)!.refresh();
      expect(host.session!.inbox.reader(second)!.accessRevoked, isTrue);
      await tester.pump();
      expect(key('swarm-pin'), findsNothing, reason: 'blank at once');

      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.text('Backend'), findsNothing);
      expect(host.session!.home.pins, isEmpty);
    });

    testWidgets('Pin tapped as its Swarm leaves the list pins nothing: the '
        'pin the list took away does not come back', (tester) async {
      final fake = two();
      final host = await pump(tester, fake);
      await tester.longPress(key('swarm-project-$second-$project'));
      await tester.pumpAndSettle();

      final press = await tester.startGesture(
        tester.getCenter(key('swarm-pin')),
      );
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await press.up();
      await tester.pumpAndSettle();

      expect(host.session!.home.pins, isEmpty);
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.text('Backend'), findsNothing);
      expect(find.text('Pinned'), findsNothing);
    });

    testWidgets('a Swarm whose read is refused lists none of its projects '
        'and says why, with no row left on its way', (tester) async {
      final fake = two()
        ..routes['/api/super-tabs/$second/parts'] = (_) =>
            throw const SuperTabFailure(
              'FORBIDDEN',
              'You no longer have access to this Swarm.',
              statusCode: 403,
            );
      await pump(tester, fake);

      expect(key('swarm-project-$second-$project'), findsNothing);
      expect(find.text('Backend'), findsNothing);
      expect(key('swarm-projects-loading-$second'), findsNothing);
      expect(
        inside(
          'swarm-projects-error-$second',
          find.text('You no longer have access to this Swarm.'),
        ),
        findsOneWidget,
      );
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });
  });

  group('a project', () {
    Future<void> openProject(WidgetTester tester, String id) async {
      await tester.tap(key('swarm-project-$tab-$id'));
      await tester.pumpAndSettle();
    }

    /// One of the project's tabs.
    Future<void> openTab(WidgetTester tester, String name) async {
      await tester.tap(key('swarm-project-tab-$name'));
      await tester.pumpAndSettle();
    }

    /// The project's work and team, from the header's team button.
    Future<void> openSheet(WidgetTester tester) async {
      await tester.tap(key('swarm-project-team'));
      await tester.pumpAndSettle();
    }

    /// The words of the header's team line.
    TextSpan teamWords(WidgetTester tester) =>
        tester
                .widget<RichText>(
                  inside('swarm-project-team-line', find.byType(RichText)),
                )
                .text
            as TextSpan;
    String team(WidgetTester tester) => teamWords(tester).toPlainText();
    Color? colorOf(WidgetTester tester, String words) {
      Color? found;
      teamWords(tester).visitChildren((span) {
        if (span is TextSpan && span.text == words) found = span.style?.color;
        return true;
      });
      return found;
    }

    testWidgets('opens on its Chat tab as B2 draws it: its name over its '
        'team in dots, Team at the top right, then Chat, Buddy, Tasks and '
        'Leaderboard', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);

      final chat = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((chat.swarmId, chat.conversationId), (tab, leadChat));
      expect(chat.header, isFalse, reason: "under the project's own header");
      expect(key('swarm-chat-header'), findsNothing);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Mobile');
      expect(key('swarm-field'), findsOneWidget, reason: 'its composer');
      expect(
        team(tester),
        '● 1 waiting  ● 1 down',
        reason: 'Nova waits on the person; Atlas is down',
      );
      expect(colorOf(tester, '1 down'), AppColors.danger);

      final tabs = [
        for (final name in ['chat', 'buddy', 'tasks', 'leaderboard'])
          'swarm-project-tab-$name',
      ];
      for (final (i, name) in tabs.indexed.skip(1)) {
        expect(
          tester.getTopLeft(key(name)).dx,
          greaterThan(tester.getTopLeft(key(tabs[i - 1])).dx),
          reason: '$name after ${tabs[i - 1]}',
        );
        expect(y(tester, name), y(tester, tabs.first), reason: 'one row');
        expect(tester.getSize(key(name)).height, greaterThanOrEqualTo(44));
      }
      expect(
        y(tester, tabs.first),
        greaterThan(y(tester, 'swarm-title')),
        reason: 'under the header',
      );
      expect(
        tester.getSemantics(key('swarm-project-tab-chat')),
        matchesSemantics(
          label: 'Chat',
          isButton: true,
          hasSelectedState: true,
          isSelected: true,
        ),
      );

      final members = key('swarm-project-team');
      expect(tester.getSize(members), const Size(44, 44), reason: 'a thumb');
      expect(
        inside('swarm-project-team', find.byIcon(LucideIcons.users300)),
        findsOne,
      );
      expect(
        tester.getTopLeft(members).dx,
        greaterThan(tester.getTopRight(key('swarm-title')).dx),
        reason: 'at the end of the header',
      );
      expect(
        middle(tester, members),
        closeTo(middle(tester, key('tty-back')), 2),
        reason: 'in the one bar with back',
      );
      expect(key('swarm-project-menu'), findsNothing, reason: 'no ⋮ menu');
    });

    testWidgets('the team line follows the Swarm while the project is open', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openProject(tester, project);
      expect(team(tester), '● 1 waiting  ● 1 down');

      // Nova goes down too.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(
          cursor: 'c3',
          lastChangedAt: 200,
          derived: const {'decisionsWaiting': 1, 'mentionsWaiting': 1},
        ),
        'agents': [
          part('agent-builder', 2, {
            ...agent('agent-builder', displayName: 'Nova'),
            'downSince': '2026-10-29T01:00:00.000Z',
          }),
        ],
      };
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();

      expect(team(tester), '● 2 down', reason: 'Nova too');
    });

    testWidgets('only the tab shown is built: Tasks takes the chat away, and '
        'Chat brings it back', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);
      await openTab(tester, 'tasks');

      expect(find.byType(SwarmConversationPage), findsNothing);
      expect(key('swarm-project-tasks'), findsOneWidget);
      expect(
        tester.getSemantics(key('swarm-project-tab-tasks')),
        matchesSemantics(
          label: 'Tasks',
          isButton: true,
          hasSelectedState: true,
          isSelected: true,
        ),
      );

      await openTab(tester, 'chat');
      expect(
        tester
            .widget<SwarmConversationPage>(find.byType(SwarmConversationPage))
            .conversationId,
        leadChat,
      );
      expect(key('swarm-project-tasks'), findsNothing);
    });

    testWidgets('the Buddy tab is the Buddy chat under the project header, '
        'with Remove Buddy beside Team; back goes Home', (tester) async {
      await pump(tester, backend(buddy: true));
      await openProject(tester, project);
      await openTab(tester, 'buddy');

      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'buddy-me'));
      expect(page.header, isFalse);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Mobile');
      expect(key('swarm-buddy-menu'), findsOneWidget, reason: 'Wren runs');
      expect(
        tester.getTopRight(key('swarm-buddy-menu')).dx,
        lessThanOrEqualTo(tester.getTopLeft(key('swarm-project-team')).dx),
        reason: 'before Team',
      );

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(key('swarm-menu'), findsOneWidget, reason: 'back on Home');
    });

    testWidgets('a viewer with no Buddy chat in the project starts none from '
        'the Buddy tab', (tester) async {
      final fake = backend();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) => {
        ...parts(body)! as Map<String, dynamic>,
        'members': [part(me, 1, person(me, role: 'viewer'))],
      };
      await pump(tester, fake);
      await openProject(tester, project);
      await openTab(tester, 'buddy');

      expect(key('swarm-buddy-none'), findsOneWidget);
      expect(find.byType(SwarmConversationPage), findsNothing);
      expect(fake.commands, isEmpty, reason: 'nothing asked of the server');
    });

    testWidgets('the Buddy tab opens a chat the read does not hold: it says '
        'so meanwhile, asks once, and says why it did not open', (
      tester,
    ) async {
      final fake = backend();
      final answer = Completer<Object?>();
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => answer.future;
      await pump(tester, fake);
      await openProject(tester, web);

      await tester.tap(key('swarm-project-tab-buddy'));
      await frames(tester);
      expect(key('swarm-buddy-opening'), findsOneWidget);
      await tester.tap(key('swarm-project-tab-buddy'));
      await frames(tester);
      expect(fake.commands, [
        {'type': 'buddy.chat', 'projectId': web},
      ], reason: 'one tap, one chat');

      answer.complete({'result': <String, dynamic>{}});
      await tester.pumpAndSettle();
      expect(find.byType(SwarmConversationPage), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-buddy-error'),
          matching: find.text('Your Buddy chat is not ready yet. Try again.'),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(key('swarm-buddy-again'), findsOneWidget);
    });

    testWidgets("the Buddy tab opens the chat the server names, once it's "
        'there', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await openProject(tester, web);
      await openTab(tester, 'buddy');

      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'buddy-web'));
    });

    testWidgets('the Leaderboard tab is the board, under the project header', (
      tester,
    ) async {
      await pump(tester, backend());
      await openProject(tester, project);
      await openTab(tester, 'leaderboard');

      final board = tester.widget<SwarmLeaderboardPage>(
        find.byType(SwarmLeaderboardPage),
      );
      expect(
        (board.swarmId, board.projectId, board.header),
        (tab, project, false),
      );
      expect(tester.widget<Text>(key('swarm-title')).data, 'Mobile');
      expect(find.text('Leaderboard'), findsOneWidget, reason: 'the tab alone');
    });

    testWidgets('Team opens the sheet on its team; its Work lists waiting on '
        'you, then working on', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);
      await openSheet(tester);

      expect(find.byType(SwarmProjectSheet), findsOneWidget);
      expect(key('swarm-agent-agent-lead'), findsOneWidget, reason: 'Team');
      expect(find.byType(SwarmProjectPage), findsOneWidget, reason: 'under it');

      await tester.tap(key('swarm-sheet-work'));
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(find.text('Waiting on you')).dy,
        lessThan(y(tester, 'swarm-conversation-g1')),
      );
      expect(
        y(tester, 'swarm-conversation-g1'),
        lessThan(tester.getTopLeft(find.text('Working on')).dy),
        reason: 'Nova waits on the person, though Sync is newer',
      );
      expect(
        tester.getTopLeft(find.text('Working on')).dy,
        lessThan(y(tester, 'swarm-conversation-g-busy')),
      );
      expect(
        inside(
          'swarm-conversation-g1',
          find.text('#4 Fix login', findRichText: true),
        ),
        findsOneWidget,
      );
      expect(
        inside('swarm-conversation-g1', find.text('Nova · Needs human')),
        findsOneWidget,
      );
      expect(
        inside('swarm-conversation-g1', find.byType(SwarmAvatar)),
        findsOneWidget,
        reason: 'who holds it',
      );
      expect(
        tester
            .getTopLeft(inside('swarm-conversation-g-busy', find.text('Sync')))
            .dx,
        tester
            .getTopLeft(
              inside(
                'swarm-conversation-g1',
                find.text('#4 Fix login', findRichText: true),
              ),
            )
            .dx,
        reason: 'work nobody holds lines up with work an agent holds',
      );
      expect(
        key('swarm-conversation-$leadChat'),
        findsNothing,
        reason: 'the project chat is a tab, not a row',
      );
    });

    testWidgets("the sheet's Team lists each agent in a word", (tester) async {
      final fake = backend();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) {
        final load = parts(body)! as Map<String, dynamic>;
        return {
          ...load,
          'agents': [
            for (final row in load['agents'] as List)
              if ((row as Map)['key'] == 'agent-atlas')
                {
                  ...row,
                  'data': {...row['data'] as Map, 'role': 'reviewer'},
                }
              else
                row,
          ],
        };
      };
      await pump(tester, fake);
      await openProject(tester, project);
      await openSheet(tester);

      expect(key('swarm-conversation-g1'), findsNothing, reason: 'Team first');
      for (final id in ['agent-lead', 'agent-builder', 'agent-atlas']) {
        expect(key('swarm-agent-$id'), findsOneWidget);
      }
      expect(
        inside('swarm-agent-agent-lead', find.text('PM')),
        findsOneWidget,
        reason: 'the Product Manager is marked',
      );
      expect(
        inside('swarm-agent-agent-builder', find.text('Dev')),
        findsOneWidget,
        reason: "each agent's role in a tag, as the prototype",
      );
      expect(inside('swarm-agent-agent-atlas', find.text('Rev')), findsOne);
      expect(
        y(tester, 'swarm-agent-agent-lead'),
        lessThan(y(tester, 'swarm-agent-agent-builder')),
        reason: 'the Product Manager first, then who needs the person',
      );
      expect(
        y(tester, 'swarm-agent-agent-builder'),
        lessThan(y(tester, 'swarm-agent-agent-atlas')),
      );
      expect(
        inside(
          'swarm-agent-agent-atlas',
          find.textContaining('Lost', findRichText: true),
        ),
        findsOneWidget,
        reason: 'its state in a word',
      );

      await tester.tap(key('swarm-team-close'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectSheet), findsNothing);
      expect(key('swarm-project-team'), findsOneWidget, reason: 'back on it');
    });

    testWidgets('a task in the sheet opens over it, and back returns to the '
        'sheet', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);
      await openSheet(tester);
      await tester.tap(key('swarm-sheet-work'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-conversation-g-busy'));
      await tester.pumpAndSettle();
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g-busy'));

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectSheet), findsOneWidget);
      expect(key('swarm-conversation-g-busy'), findsOneWidget);
    });
  });

  group('the Tasks tab', () {
    Future<void> openTasks(WidgetTester tester) async {
      await tester.tap(key('swarm-project-$tab-$project'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-tab-tasks'));
      await tester.pumpAndSettle();
    }

    /// The key of Nova's work waiting on the person in g1.
    String workKey(SwarmHost host) =>
        host.session!.inbox.needs.whereType<SwarmWorkNeed>().single.key;

    /// [fake]'s first load with [groups] in place of theirs, by id, each
    /// last changed when its part says ([part]'s `changedAt`).
    void replace(FakeSwarm fake, Map<String, Map<String, dynamic>> groups) {
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final answer = await load(body) as Map<String, dynamic>;
        return {
          ...answer,
          'groups': [
            for (final row in answer['groups'] as List)
              if (groups[(row as Map)['key']] case final group?) group else row,
          ],
        };
      };
    }

    testWidgets('as B2 draws it: what waits on the person with its count, '
        'then what is worked on with its count, then what was done today', (
      tester,
    ) async {
      final host = await pump(tester, backend());
      await openTasks(tester);

      final waiting = [
        'swarm-waiting-decision:d1',
        'swarm-waiting-mention:m1',
        'swarm-waiting-${workKey(host)}',
      ];
      for (final k in waiting) {
        expect(key(k), findsOneWidget, reason: k);
      }
      expect(tester.widget<Text>(key('swarm-needs-count')).data, '3');
      expect(tester.widget<Text>(key('swarm-working-count')).data, '2');
      expect(
        tester.widget<Text>(key('swarm-working-count')).style?.color,
        AppColors.success,
      );
      expect(
        y(tester, 'swarm-task-g-busy'),
        lessThan(y(tester, 'swarm-task-g-atlas')),
        reason: 'Sync moved last',
      );
      expect(key('swarm-task-g1'), findsNothing, reason: 'it waits on you');
      for (final id in ['g-private', 'g-pm', leadChat, webLead]) {
        expect(key('swarm-task-$id'), findsNothing, reason: id);
      }
      expect(key('swarm-done-none'), findsOneWidget);
      final order = [
        tester.getTopLeft(find.text('Waiting on you')).dy,
        y(tester, waiting.first),
        tester.getTopLeft(find.text('Working')).dy,
        y(tester, 'swarm-task-g-busy'),
        tester.getTopLeft(find.text('Done today')).dy,
      ];
      expect(order, [...order]..sort(), reason: 'in the order B2 draws');

      expect(
        inside(
          'swarm-waiting-decision:d1',
          find.text('#4 Fix login', findRichText: true),
        ),
        findsOneWidget,
        reason: 'the task it is in',
      );
      expect(
        inside(
          'swarm-waiting-decision:d1',
          find.text('River · Ship it behind a flag?'),
        ),
        findsOneWidget,
        reason: 'who asks what',
      );
      expect(
        inside('swarm-approve-d1', find.text('Yes')),
        findsOneWidget,
        reason: 'its recommended answer',
      );
      expect(key('swarm-reply-mention:m1'), findsOneWidget);
      expect(key('swarm-reply-${workKey(host)}'), findsOneWidget);
      expect(
        find.textContaining('Their chat'),
        findsNothing,
        reason: "another's private chat",
      );
    });

    testWidgets('Approve holds the recommended answer with Undo, then sends '
        'it once', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await openTasks(tester);

      await tester.tap(key('swarm-approve-d1'));
      await tester.pump();
      expect(
        inside('swarm-waiting-decision:d1', find.text('Sending “Yes”')),
        findsOneWidget,
      );
      await tester.tap(key('swarm-undo-d1'));
      await tester.pump();
      expect(key('swarm-approve-d1'), findsOneWidget, reason: 'taken back');
      await tester.pump(const Duration(seconds: 4));
      expect(fake.commands, isEmpty);

      await tester.tap(key('swarm-approve-d1'));
      await tester.pump(const Duration(seconds: 2));
      expect(fake.commands, isEmpty, reason: 'Undo still can');
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(fake.commands.single, {
        'type': 'decision.answer',
        'decisionId': 'd1',
        'choice': 0,
      });
    });

    testWidgets('Reply opens where it was asked, and back returns to the '
        'tasks', (tester) async {
      await pump(tester, backend());
      await openTasks(tester);

      await tester.tap(key('swarm-reply-mention:m1'));
      await tester.pumpAndSettle();
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g1'));

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(key('swarm-project-tasks'), findsOneWidget);
    });

    testWidgets('a task opens its chat', (tester) async {
      await pump(tester, backend());
      await openTasks(tester);

      await tester.tap(key('swarm-task-g-busy'));
      await tester.pumpAndSettle();
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g-busy'));
    });

    /// Work [id] as the server sends it: its agent's [status], its last
    /// progress at [progress], archived or not, and its part last changed
    /// at [changed] (a message on it moves that, not its progress).
    Map<String, dynamic> work(
      String id,
      String title, {
      required String status,
      required DateTime changed,
      DateTime? progress,
      bool archived = false,
      bool dormant = false,
    }) {
      final data = groupData(
        id,
        title: title,
        status: status,
        dormant: dormant,
      );
      return {
        ...part(id, 2, {
          ...data,
          'archived': archived,
          'assignment': {
            ...data['assignment'] as Map<String, dynamic>,
            'progressAt': ?progress?.millisecondsSinceEpoch,
          },
        }),
        'changedAt': changed.millisecondsSinceEpoch,
      };
    }

    testWidgets('Done today folds the work its agent said Done today; work '
        'done before is in neither, even with a message today', (tester) async {
      final fake = backend();
      final now = DateTime.now();
      replace(fake, {
        'g-busy': work(
          'g-busy',
          'Sync',
          status: 'done',
          changed: now,
          progress: now,
        ),
        'g-atlas': work(
          'g-atlas',
          'Search page',
          status: 'done',
          progress: now.subtract(const Duration(days: 1, hours: 1)),
          changed: now,
        ),
      });
      await pump(tester, fake);
      await openTasks(tester);

      expect(key('swarm-tasks-none'), findsOneWidget, reason: 'none working');
      expect(
        inside('swarm-done-today', find.text('At least 1 task done')),
        findsOneWidget,
        reason: 'what the read shows is a floor',
      );
      expect(key('swarm-task-g-busy'), findsNothing, reason: 'folded');

      await tester.tap(key('swarm-done-today'));
      await tester.pumpAndSettle();
      expect(key('swarm-task-g-busy'), findsOneWidget);
      expect(
        key('swarm-task-g-atlas'),
        findsNothing,
        reason: 'done yesterday; only talked about today',
      );
    });

    testWidgets('archived work never done, and stopped or cancelled work, '
        'are not done today', (tester) async {
      final fake = backend();
      final now = DateTime.now();
      replace(fake, {
        'g-busy': work(
          'g-busy',
          'Sync',
          status: 'working',
          archived: true,
          changed: now,
          progress: now,
        ),
        'g-atlas': work(
          'g-atlas',
          'Search page',
          status: 'stopped',
          changed: now,
          progress: now,
        ),
      });
      await pump(tester, fake);
      await openTasks(tester);

      expect(key('swarm-done-today'), findsNothing);
      expect(
        tester.widget<Text>(key('swarm-done-none')).data,
        'Nothing done today in recent work.',
      );
      expect(key('swarm-task-g-busy'), findsNothing);
      expect(key('swarm-task-g-atlas'), findsNothing);
    });

    testWidgets('a fresh read holds no dormant work: the count says it is a '
        "floor, and grows when the project's older work is read", (
      tester,
    ) async {
      final fake = backend();
      final now = DateTime.now();
      // Done today too, but dormant: no first load has it.
      final shipped = work(
        'g-shipped',
        'Release notes',
        status: 'done',
        changed: now,
        progress: now,
        dormant: true,
      );
      replace(fake, {
        'g-busy': work(
          'g-busy',
          'Sync',
          status: 'done',
          changed: now,
          progress: now,
        ),
      });
      fake.routes['/api/super-tabs/$tab/groups?dormant=1&projectId=$project'] =
          (_) => {
            'groups': [shipped],
            'next': null,
          };
      final host = await pump(tester, fake);
      await openTasks(tester);

      expect(
        inside('swarm-done-today', find.text('At least 1 task done')),
        findsOneWidget,
      );
      expect(
        find.text('1 task done'),
        findsNothing,
        reason: 'not a whole count',
      );

      await host.session!.inbox.reader(tab)!.loadDormant(project);
      await tester.pumpAndSettle();
      expect(
        inside('swarm-done-today', find.text('At least 2 tasks done')),
        findsOneWidget,
      );
    });

    testWidgets('the Chat tab says its chat is unread while another tab '
        'shows, and not on its own', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openTasks(tester);
      expect(tester.getSemantics(key('swarm-project-tab-chat')).label, 'Chat');

      moveOn(fake, {
        leadChat: groupData(leadChat, title: 'Mobile', lastMessageSequence: 99),
      });
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();
      expect(
        tester.getSemantics(key('swarm-project-tab-chat')).label,
        'Chat, unread messages',
      );

      await tester.tap(key('swarm-project-tab-chat'));
      await tester.pumpAndSettle();
      expect(
        tester.getSemantics(key('swarm-project-tab-chat')).label,
        'Chat',
        reason: 'it is the chat shown',
      );
    });
  });

  group('while Home reads', () {
    /// [path] answers only once the returned gate is opened.
    Completer<void> hold(FakeSwarm fake, String path) {
      final gate = Completer<void>();
      final answer = fake.routes[path]!;
      fake.routes[path] = (body) async {
        await gate.future;
        return answer(body);
      };
      return gate;
    }

    double height(WidgetTester tester, String k) =>
        tester.getSize(key(k)).height;

    const decision = {
      'id': 'd1',
      'projectName': 'Mobile',
      'conversationId': leadChat,
      'conversationTitle': 'Mobile',
      'askerName': 'River',
      'question': 'Ship it behind a flag?',
      'options': ['Yes', 'No'],
    };

    /// One Swarm whose counts say a decision waits, with no work waiting:
    /// what waits on the person is the decision alone.
    FakeSwarm deciding() {
      final fake = backend();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          firstLoad(derived: const {'decisionsWaiting': 1});
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      return fake;
    }

    testWidgets('before the list answers, Needs you and the projects are '
        'skeleton rows, and nothing says it is reading', (tester) async {
      final fake = backend();
      final listed = hold(fake, '/api/super-tabs/list');
      await pump(tester, fake, settle: false);

      for (final k in ['swarm-needs-loading', 'swarm-projects-loading']) {
        expect(key(k), findsOneWidget, reason: k);
      }
      expect(
        y(tester, 'swarm-needs-loading'),
        lessThan(y(tester, 'swarm-projects-loading')),
      );
      expect(find.text('Buddies'), findsNothing);
      expect(find.text('Projects'), findsOneWidget);
      expect(find.text('Nothing needs you.'), findsNothing);
      expect(find.textContaining('Reading'), findsNothing);

      listed.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-needs-loading'), findsNothing);
      expect(key('swarm-projects-loading'), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    for (final scale in [1.0, 1.3]) {
      testWidgets('skeleton rows are as tall as the rows that replace them '
          '(text at $scale)', (tester) async {
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final fake = backend();
        final listed = hold(fake, '/api/super-tabs/list');
        await pump(tester, fake, settle: false);
        final need = height(tester, 'swarm-needs-loading-0');
        final row = height(tester, 'swarm-projects-loading-0');

        listed.complete();
        await tester.pumpAndSettle();

        expect(
          height(tester, 'swarm-home-need-decision:d1'),
          closeTo(need, .01),
        );
        expect(
          height(tester, 'swarm-project-$tab-$web'),
          closeTo(row, .01),
          reason: 'its title and its team, as the skeleton draws them',
        );
      });
    }

    testWidgets('of two Swarms, the one still to be read has its rows on '
        'their way; the drawer lists both', (tester) async {
      const second = 'tab-2';
      final fake = backend();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
          {'id': second, 'name': 'Second Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$second/parts'] = (_) => firstLoad(
        tabId: second,
        head: headData(id: second, name: 'Second Swarm'),
      );
      final read = hold(fake, '/api/super-tabs/$tab/parts');
      await pump(tester, fake, settle: false);

      expect(key('swarm-project-$second-$project'), findsOneWidget);
      expect(key('swarm-projects-loading-$tab'), findsOneWidget);
      expect(
        y(tester, 'swarm-projects-loading-$tab'),
        greaterThan(y(tester, 'swarm-project-$second-$project')),
        reason: 'after the rows read',
      );
      expect(key('swarm-needs-loading'), findsOneWidget);
      expect(find.text('Nothing needs you.'), findsNothing);
      await tester.tap(key('swarm-menu'));
      await frames(tester);
      expect(key('swarm-drawer-swarm-$tab'), findsOneWidget);
      expect(key('swarm-drawer-swarm-$second'), findsOneWidget);

      read.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-projects-loading-$tab'), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets('what waits is read before Home says nothing needs you', (
      tester,
    ) async {
      final fake = deciding()
        ..routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
          'decisions': [decision],
        };
      final asked = hold(fake, '/api/super-tabs/$tab/decisions?state=open');
      await pump(tester, fake, settle: false);

      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(key('swarm-needs-loading'), findsOneWidget);
      expect(find.text('Nothing needs you.'), findsNothing);

      asked.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-needs-loading'), findsNothing);
      expect(key('swarm-home-need-decision:d1'), findsOneWidget);
    });

    testWidgets('read again in full, what waits is read again before Home '
        'says nothing needs you; a failure ends the skeleton', (tester) async {
      final fake = deciding()
        ..routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
          'decisions': [decision],
        };
      final host = await pump(tester, fake);
      expect(key('swarm-home-need-decision:d1'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) =>
          throw SuperTabFailure('INTERNAL', 'Broken', statusCode: 500);
      final asked = hold(fake, '/api/super-tabs/$tab/decisions?state=open');
      unawaited(host.session!.inbox.refresh());
      await frames(tester);

      expect(key('swarm-home-need-decision:d1'), findsNothing);
      expect(key('swarm-needs-loading'), findsOneWidget);
      expect(find.text('Nothing needs you.'), findsNothing);

      asked.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-needs-loading'), findsNothing);
      expect(find.text('Nothing needs you.'), findsNothing);
      expect(key('swarm-needs-unread'), findsOneWidget);
    });

    testWidgets('a tag marked done leaves "Nothing needs you", with no '
        'skeleton between', (tester) async {
      final fake = deciding();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          firstLoad(derived: const {'mentionsWaiting': 1});
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      var waiting = true;
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': [
          if (waiting)
            {
              'id': 'm1',
              'projectName': 'Mobile',
              'conversationId': leadChat,
              'conversationTitle': 'Mobile',
              'messageId': 'msg-1',
              'leadName': 'River',
              'text': 'Can you check the copy?',
            },
        ],
      };
      final read = hold(fake, '/api/super-tabs/$tab/changes');
      fake.routes['/api/super-tabs/$tab/commands'] = (_) {
        waiting = false;
        return {'result': <String, dynamic>{}};
      };
      await pump(tester, fake);
      await tester.tap(key('swarm-home-need-mention:m1'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-done-m1'));
      await frames(tester);
      await tester.tap(key('tty-back'));
      await frames(tester);

      expect(
        key('swarm-needs-loading'),
        findsNothing,
        reason: 'what waits was read; only the Swarm count is behind',
      );
      expect(
        find.descendant(
          of: find.byType(SwarmPage),
          matching: find.text('Nothing needs you.'),
        ),
        findsOneWidget,
      );
      read.complete();
      await tester.pumpAndSettle();
    });

    testWidgets('what waits that could not be read says so, not that '
        'nothing needs you', (tester) async {
      final fake = deciding()
        ..routes['/api/super-tabs/$tab/decisions?state=open'] = (_) =>
            throw SuperTabFailure('INTERNAL', 'Broken', statusCode: 500);
      await pump(tester, fake);

      expect(key('swarm-needs-loading'), findsNothing);
      expect(find.text('Nothing needs you.'), findsNothing);
      expect(
        tester.widget<Text>(key('swarm-needs-unread')).data,
        'Could not load what is waiting for you. Try again.',
      );
    });

    testWidgets('a Swarm that could not be read says so, with no skeleton '
        'left and no "Nothing needs you"', (tester) async {
      final fake = backend()
        ..routes['/api/super-tabs/$tab/parts'] = (_) =>
            throw SuperTabFailure('INTERNAL', 'Broken', statusCode: 500);
      await pump(tester, fake);

      expect(key('swarm-needs-loading'), findsNothing);
      expect(key('swarm-projects-loading-$tab'), findsNothing);
      expect(find.text('Nothing needs you.'), findsNothing);
      expect(key('swarm-needs-unread'), findsOneWidget);
      expect(find.text('Pull down to try again.'), findsOneWidget);
    });
  });

  group('the start screens', () {
    const mac = (name: 'MacBook Pro', away: false);

    testWidgets('with no computer, Home draws its start screen in place of '
        'its body, under its own top bar', (tester) async {
      await pump(tester, backend(), computers: _Computers(const []));

      expect(find.byType(SwarmStartView), findsOneWidget);
      expect(key('swarm-menu'), findsOneWidget, reason: 'the drawer stays');
      expect(tester.widget<Text>(key('swarm-title')).data, 'Swarm');
      expect(find.text('Needs you'), findsNothing);
    });

    testWidgets('a computer coming back brings Home back', (tester) async {
      final computers = _Computers(const []);
      await pump(tester, backend(), computers: computers);
      expect(find.byType(SwarmStartView), findsOneWidget);

      computers.set(const [mac]);
      await tester.pumpAndSettle();

      expect(find.byType(SwarmStartView), findsNothing);
      expect(find.text('Needs you'), findsOneWidget);
    });

    testWidgets('with a computer and a Swarm, Home is as it was', (
      tester,
    ) async {
      await pump(tester, backend(), computers: _Computers(const [mac]));

      expect(find.byType(SwarmStartView), findsNothing);
      expect(find.text('Needs you'), findsOneWidget);
    });
  });
}
