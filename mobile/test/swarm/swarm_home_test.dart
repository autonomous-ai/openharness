import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppFont;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_drawer.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
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

    /// The project's ⋮ menu, open.
    Future<void> openMenu(WidgetTester tester) async {
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
    }

    /// The project's work and team, from its menu's status row.
    Future<void> openSheet(WidgetTester tester) async {
      await openMenu(tester);
      await tester.tap(key('swarm-project-menu-status'));
      await tester.pumpAndSettle();
    }

    /// The words of the menu's status row.
    TextSpan statusWords(WidgetTester tester) =>
        tester
                .widget<RichText>(
                  find.descendant(
                    of: inside(
                      'swarm-project-menu-status',
                      find.byType(SwarmStatusText),
                    ),
                    matching: find.byType(RichText),
                  ),
                )
                .text
            as TextSpan;
    String status(WidgetTester tester) => statusWords(tester).toPlainText();
    Color? colorOf(WidgetTester tester, String words) {
      Color? found;
      statusWords(tester).visitChildren((span) {
        if (span is TextSpan && span.text == words) found = span.style?.color;
        return true;
      });
      return found;
    }

    testWidgets('opens on its project chat, its name over who is in it, its '
        'menu at the top right, and nothing under the header', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);

      final chat = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((chat.swarmId, chat.conversationId), (tab, leadChat));
      expect(tester.widget<Text>(key('swarm-title')).data, 'Mobile');
      expect(find.text('River and everyone'), findsOneWidget);
      expect(key('swarm-field'), findsOneWidget, reason: 'its composer');
      expect(key('swarm-lead-chat'), findsNothing, reason: 'no row to open');
      expect(find.text('Working on'), findsNothing, reason: 'in the sheet');

      expect(
        key('swarm-team-line'),
        findsNothing,
        reason: 'no team strip under the header (Tony, 2026-10-29)',
      );
      expect(find.byType(SwarmAvatar), findsNothing, reason: 'no faces');
      expect(
        find.textContaining('waiting on you'),
        findsNothing,
        reason: 'the status is in the menu',
      );
      expect(
        key('swarm-project-menu-buddy-chat'),
        findsNothing,
        reason: 'in the menu',
      );
      expect(find.text('Chat with PM'), findsNothing);

      final menu = key('swarm-project-menu');
      expect(tester.getSize(menu), const Size(44, 44), reason: 'a thumb');
      final glyph = find.descendant(
        of: menu,
        matching: find.byIcon(LucideIcons.ellipsisVertical300),
      );
      expect(glyph, findsOneWidget);
      expect(
        tester.getTopLeft(menu).dx,
        greaterThan(tester.getTopRight(key('swarm-title')).dx),
        reason: 'at the end of the header',
      );
      expect(
        middle(tester, menu),
        closeTo(middle(tester, key('tty-back')), 2),
        reason: 'in the one bar with back',
      );
      expect(
        tester.getTopRight(glyph).dx,
        tester.getSize(find.byType(SwarmConversationPage)).width -
            AppSpace.screenInset,
        reason: "on the screen's side margin, not its edge",
      );
    });

    testWidgets('its menu has Buddy chat, then the team in words, each a '
        'row a thumb can press', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);
      await openMenu(tester);

      expect(
        inside('swarm-project-menu-buddy-chat', find.text('Buddy chat')),
        findsOneWidget,
      );
      expect(find.text('Chat with PM'), findsNothing, reason: 'closed (#2090)');
      expect(
        status(tester),
        '1 waiting on you · 1 down',
        reason: 'Fix login waits on the person; of the team, Atlas is down',
      );
      expect(colorOf(tester, '1 waiting on you'), AppColors.warning);
      expect(colorOf(tester, '1 down'), AppColors.danger);
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.byType(SwarmAvatar),
        ),
        findsNothing,
        reason: 'words only, no faces',
      );
      expect(
        inside(
          'swarm-project-menu-status',
          find.byIcon(LucideIcons.chevronRight300),
        ),
        findsOneWidget,
        reason: 'it opens more',
      );
      expect(
        y(tester, 'swarm-project-menu-buddy-chat'),
        lessThan(y(tester, 'swarm-project-menu-status')),
        reason: 'Buddy chat first, where Chat with PM was',
      );
      for (final row in [
        'swarm-project-menu-buddy-chat',
        'swarm-project-menu-status',
      ]) {
        expect(
          tester.getSize(key(row)).height,
          greaterThanOrEqualTo(44),
          reason: row,
        );
      }
    });

    testWidgets('with nothing waiting on the person, the menu says the team '
        'in one line', (tester) async {
      final fake = backend();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) {
        final load = parts(body)! as Map<String, dynamic>;
        return {
          ...load,
          'groups': [
            for (final row in load['groups'] as List)
              if ((row as Map)['key'] == 'g1')
                {
                  ...row,
                  'data': {
                    ...row['data'] as Map,
                    'assignment': {
                      ...(row['data'] as Map)['assignment'] as Map,
                      'status': 'working',
                    },
                  },
                }
              else
                row,
          ],
        };
      };
      await pump(tester, fake);
      await openProject(tester, project);
      await openMenu(tester);

      expect(status(tester), '1 working · 1 down', reason: 'Nova and Atlas');
      expect(colorOf(tester, '1 down'), AppColors.danger);
      expect(find.textContaining('waiting on you'), findsNothing);
    });

    testWidgets("the menu's counts follow the Swarm while it is open", (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openProject(tester, project);
      await openMenu(tester);
      expect(status(tester), '1 waiting on you · 1 down');

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

      expect(status(tester), '1 waiting on you · 2 down', reason: 'Nova too');
      expect(
        key('swarm-project-menu-buddy-chat'),
        findsOneWidget,
        reason: 'open',
      );
    });

    testWidgets("a viewer with no Buddy chat in the project has the menu's "
        'team alone: they start no Buddy', (tester) async {
      final fake = backend();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) => {
        ...parts(body)! as Map<String, dynamic>,
        'members': [part(me, 1, person(me, role: 'viewer'))],
      };
      await pump(tester, fake);
      await openProject(tester, project);
      await openMenu(tester);

      expect(key('swarm-project-menu-buddy-chat'), findsNothing);
      expect(status(tester), '1 waiting on you · 1 down');
    });

    testWidgets("the menu's status opens the project's work: waiting on you, "
        'then working on', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);
      await openSheet(tester);

      expect(find.byType(SwarmProjectSheet), findsOneWidget);
      expect(
        key('swarm-project-menu-status'),
        findsNothing,
        reason: 'the menu closed for it',
      );
      expect(find.byType(SwarmProjectPage), findsOneWidget, reason: 'under it');
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
        reason: 'the project chat is the screen, not a row',
      );
    });

    testWidgets("the menu's Buddy chat opens the person's Buddy chat, and back "
        'comes back to the project chat', (tester) async {
      await pump(tester, backend(buddy: true));
      await openProject(tester, project);
      await openMenu(tester);

      await tester.tap(key('swarm-project-menu-buddy-chat'));
      await tester.pumpAndSettle();
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'buddy-me'));

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(key('swarm-project-menu'), findsOneWidget, reason: 'back on it');
      expect(
        key('swarm-project-menu-buddy-chat'),
        findsNothing,
        reason: 'the menu closed as the chat opened',
      );
      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(key('swarm-menu'), findsOneWidget, reason: 'back on Home');
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
      expect(key('swarm-agent-agent-lead'), findsNothing, reason: 'Work first');
      await tester.tap(key('swarm-sheet-team'));
      await tester.pumpAndSettle();

      expect(key('swarm-conversation-g1'), findsNothing);
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

      await tester.tap(key('swarm-sheet-work'));
      await tester.pumpAndSettle();
      expect(key('swarm-conversation-g1'), findsOneWidget);

      await tester.tap(key('swarm-team-close'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectSheet), findsNothing);
      expect(
        key('swarm-project-menu'),
        findsOneWidget,
        reason: 'back on the chat',
      );
    });

    testWidgets('Buddy chat shows it is opening in place of the menu, and '
        'says why it did not open', (tester) async {
      final semantics = tester.ensureSemantics();
      final fake = backend();
      final answer = Completer<Object?>();
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => answer.future;
      await pump(tester, fake);
      await openProject(tester, web);

      await openMenu(tester);
      await tester.tap(key('swarm-project-menu-buddy-chat'));
      // A spinner turns until the answer: nothing settles.
      await frames(tester);
      expect(
        key('swarm-project-menu-buddy-chat'),
        findsNothing,
        reason: 'the menu closed',
      );
      expect(
        inside('swarm-project-menu', find.byType(CircularProgressIndicator)),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel('Opening Buddy chat…'), findsOneWidget);
      await tester.tap(key('swarm-project-menu'));
      await frames(tester);
      expect(
        key('swarm-project-menu-status'),
        findsNothing,
        reason: 'no menu while it opens',
      );
      expect(fake.commands, [
        {'type': 'buddy.chat', 'projectId': web},
      ], reason: 'one tap, one chat');

      answer.complete({'result': <String, dynamic>{}});
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<SwarmConversationPage>(find.byType(SwarmConversationPage))
            .conversationId,
        webLead,
        reason: 'no Buddy chat over the project chat',
      );
      expect(
        find.descendant(
          of: key('swarm-buddy-error'),
          matching: find.text('Your Buddy chat is not ready yet. Try again.'),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(
        inside(
          'swarm-project-menu',
          find.byIcon(LucideIcons.ellipsisVertical300),
        ),
        findsOneWidget,
        reason: 'the menu is back',
      );
      semantics.dispose();
    });

    testWidgets('a task in the sheet opens over it, and back returns to the '
        'sheet', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);
      await openSheet(tester);

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
