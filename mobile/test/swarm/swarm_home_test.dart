import 'dart:async';
import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_drawer.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/swarm/swarm_team_line.dart';
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

/// A list that counts how often what it holds is read, in turn or one by one;
/// its length is not a read.
class _Reads<E> extends ListBase<E> {
  _Reads(this._items);

  final List<E> _items;
  var reads = 0;

  @override
  int get length => _items.length;

  @override
  set length(int value) => throw UnsupportedError('Read only');

  @override
  E operator [](int index) {
    reads++;
    return _items[index];
  }

  @override
  void operator []=(int index, E value) => throw UnsupportedError('Read only');

  @override
  Iterator<E> get iterator {
    reads++;
    return _items.iterator;
  }
}

/// Half a second of frames, for a screen that cannot settle.
Future<void> frames(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// Swarm Home and its drawer, over a scripted backend: one Swarm with two
/// projects. Mobile has River as its Product Manager, Nova waiting on the
/// person in g1, Atlas down, and the person's Chat with PM; Web has Cleo as
/// its Product Manager and no Chat with PM yet.
void main() {
  const web = 'project-2';
  const webLead = 'group-lead-web';

  FakeSwarm backend() {
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
    fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  /// Swarm Home as the root of its own stack, Swarm on, on an iPhone's
  /// screen.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    VoidCallback? onHarness,
    void Function(BuildContext context)? onSettings,
    SwarmComputers? computers,
    bool settle = true,
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
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmPage(onHarness: onHarness, onSettings: onSettings),
      ),
    );
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

  group('the drawer', () {
    testWidgets('its title and close, Swarm Home with a count, the projects, '
        'then Harness, and Settings at its foot', (tester) async {
      var harness = 0, settings = 0;
      await pump(
        tester,
        backend(),
        onHarness: () => harness++,
        onSettings: (_) => settings++,
      );
      await openDrawer(tester);

      expect(
        tester.getSize(find.byType(Drawer)).width,
        closeTo(390 * .86, .5),
        reason: "most of the screen, as the prototype's",
      );
      expect(
        inside('swarm-drawer-home', find.byType(SwarmBadge)),
        findsOneWidget,
        reason: 'what waits on the person, in a filled count',
      );
      expect(inside('swarm-drawer-home', find.text('3')), findsOneWidget);
      expect(
        y(tester, 'swarm-drawer-home'),
        lessThan(y(tester, 'swarm-drawer-project-$tab-$project')),
      );
      expect(
        y(tester, 'swarm-drawer-project-$tab-$project'),
        lessThan(y(tester, 'swarm-drawer-project-$tab-$web')),
      );
      expect(
        y(tester, 'swarm-drawer-project-$tab-$web'),
        lessThan(y(tester, 'swarm-drawer-harness')),
      );
      expect(
        y(tester, 'swarm-drawer-harness'),
        lessThan(y(tester, 'swarm-drawer-settings')),
      );
      expect(
        inside('swarm-drawer-settings', find.byIcon(LucideIcons.settings2300)),
        findsOneWidget,
        reason: "the prototype's two sliders",
      );
      final drawer = find.byType(SwarmDrawer);
      expect(
        find.descendant(of: drawer, matching: find.text('Projects')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: drawer, matching: find.text('Chat with PM')),
        findsNothing,
        reason: "Chat with PM is in each project's chats, not a section",
      );
      for (final matching in [
        find.text('Mobile'),
        find.byType(SwarmProjectTile),
        find.byType(SwarmTeamLine),
      ]) {
        expect(
          inside('swarm-drawer-project-$tab-$project', matching),
          findsOneWidget,
          reason: 'a project: its initial, its name, its team',
        );
      }

      await tester.tap(key('swarm-drawer-harness'));
      await tester.pumpAndSettle();
      expect(harness, 1);
      expect(key('swarm-drawer-home'), findsNothing, reason: 'it closed');

      await openDrawer(tester);
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

    testWidgets("a project's name opens its page", (tester) async {
      await pump(tester, backend());
      await openDrawer(tester);

      await tester.tap(key('swarm-drawer-project-$tab-$web'));
      await tester.pumpAndSettle();

      final page = tester.widget<SwarmProjectPage>(
        find.byType(SwarmProjectPage),
      );
      expect((page.swarmId, page.projectId), (tab, web));
    });

    testWidgets("a project's arrow lists its chats, and a chat opens", (
      tester,
    ) async {
      await pump(tester, backend());
      await openDrawer(tester);
      expect(key('swarm-drawer-chat-g1'), findsNothing);

      await tester.tap(key('swarm-drawer-chats-$tab-$project'));
      await tester.pumpAndSettle();

      expect(
        y(tester, 'swarm-drawer-pm-$tab-$project'),
        lessThan(y(tester, 'swarm-drawer-chat-$leadChat')),
        reason: 'Chat with PM first',
      );
      expect(
        inside('swarm-drawer-pm-$tab-$project', find.text('Chat with PM')),
        findsOneWidget,
      );
      expect(
        y(tester, 'swarm-drawer-chat-$leadChat'),
        lessThan(y(tester, 'swarm-drawer-chat-g1')),
        reason: 'then the project chat',
      );
      expect(
        y(tester, 'swarm-drawer-chat-g1'),
        lessThan(y(tester, 'swarm-drawer-chat-g-busy')),
        reason: 'then work: what waits on the person, then the latest',
      );
      expect(
        inside('swarm-drawer-chat-$leadChat', find.text('Project chat')),
        findsOneWidget,
      );
      expect(
        key('swarm-drawer-chat-g-private'),
        findsNothing,
        reason: 'a private chat is for its people only',
      );
      expect(
        key('swarm-drawer-chat-g-pm'),
        findsNothing,
        reason: 'Chat with PM has its own row',
      );
      expect(key('swarm-drawer-pm-$tab-$web'), findsNothing, reason: 'closed');
      expect(key('swarm-drawer-chat-$webLead'), findsNothing);

      await tester.tap(key('swarm-drawer-chat-g1'));
      await tester.pumpAndSettle();
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g1'));
    });

    testWidgets("Chat with PM opens the person's own chat with that "
        'Product Manager', (tester) async {
      await pump(tester, backend());
      await openDrawer(tester);
      await tester.tap(key('swarm-drawer-chats-$tab-$project'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-drawer-pm-$tab-$project'));
      await tester.pumpAndSettle();

      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g-pm'));
    });
  });

  group('Swarm Home', () {
    testWidgets('Needs you first, then Chat with PM, then the projects', (
      tester,
    ) async {
      await pump(tester, backend());

      expect(key('swarm-menu'), findsOneWidget);
      expect(key('tty-back'), findsNothing);
      expect(
        y(tester, 'swarm-need-decision:d1'),
        lessThan(y(tester, 'swarm-home-pm-$tab-$project')),
      );
      expect(
        y(tester, 'swarm-home-pm-$tab-$project'),
        lessThan(y(tester, 'swarm-home-pm-$tab-$web')),
      );
      expect(
        y(tester, 'swarm-home-pm-$tab-$web'),
        lessThan(y(tester, 'swarm-project-$tab-$project')),
      );
      expect(
        find.descendant(
          of: key('swarm-home-pm-$tab-$project'),
          matching: find.text('River'),
        ),
        findsOneWidget,
        reason: 'the Product Manager it is with',
      );
      expect(
        find.descendant(
          of: key('swarm-project-$tab-$project'),
          matching: find.byType(SwarmTeamLine),
        ),
        findsOneWidget,
      );
    });

    testWidgets("the prototype's top bar, captions, avatars and tiles", (
      tester,
    ) async {
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
      for (final caption in ['Needs you', 'Chat with PM', 'Projects']) {
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
        inside('swarm-home-pm-$tab-$project', find.byType(SwarmAvatar)),
        findsOneWidget,
        reason: 'the Product Manager, in a round mark',
      );
      expect(
        inside('swarm-home-pm-$tab-$project', find.text('R')),
        findsOneWidget,
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

    testWidgets('an open tag has Done, filled, and Open chat; open work has '
        'Open chat', (tester) async {
      await pump(tester, backend());
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

    testWidgets('one tap answers, held for Undo; then the next need opens', (
      tester,
    ) async {
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
      await tester.tap(key('swarm-need-row-mention:m1'));
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
      expect(key('swarm-home-pm-$tab-$project'), findsOneWidget);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets('Chat with PM opens it; one not ready says so', (tester) async {
      final fake = backend();
      await pump(tester, fake);

      await tester.tap(key('swarm-home-pm-$tab-$web'));
      await tester.pumpAndSettle();
      expect(fake.commands.single['type'], 'conversation.create');
      expect(find.byType(SwarmConversationPage), findsNothing);
      expect(key('swarm-pm-error'), findsOneWidget);
      expect(
        find.text('Chat with PM is not ready yet. Try again.'),
        findsOneWidget,
      );

      await tester.tap(key('swarm-home-pm-$tab-$project'));
      await tester.pumpAndSettle();
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g-pm'));
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

  group('a project', () {
    Future<void> openProject(WidgetTester tester, String id) async {
      await tester.tap(key('swarm-project-$tab-$id'));
      await tester.pumpAndSettle();
    }

    testWidgets('Chat with PM is its one main button, then the project chat, '
        'then work by latest', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);

      final main = tester.widget<SwarmButton>(key('swarm-pm-chat'));
      expect((main.style, main.wide), (SwarmButtonStyle.fill, true));
      expect(
        find.byWidgetPredicate(
          (w) => w is SwarmButton && w.style == SwarmButtonStyle.fill,
        ),
        findsOneWidget,
        reason: 'its one main button',
      );
      expect(
        find.descendant(
          of: key('swarm-pm-chat'),
          matching: find.byWidgetPredicate(
            (w) => w is Material && w.color == AppPalette.accent,
          ),
        ),
        findsOneWidget,
        reason: "the app's blue, as the prototype",
      );
      expect(
        find.descendant(
          of: key('swarm-pm-chat'),
          matching: find.text('Chat with PM'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('swarm-team-line'),
          matching: find.byType(SwarmTeamLine),
        ),
        findsOneWidget,
        reason: 'the team in one line, down in red',
      );
      expect(
        y(tester, 'swarm-team-line'),
        lessThan(y(tester, 'swarm-pm-chat')),
      );
      expect(
        y(tester, 'swarm-pm-chat'),
        lessThan(y(tester, 'swarm-lead-chat')),
      );
      expect(
        y(tester, 'swarm-lead-chat'),
        lessThan(y(tester, 'swarm-conversation-g-busy')),
      );
      for (final words in ['Project chat', 'River and everyone', 'R']) {
        expect(
          find.descendant(
            of: key('swarm-lead-chat'),
            matching: find.text(words),
          ),
          findsOneWidget,
        );
      }

      await tester.tap(key('swarm-pm-chat'));
      await tester.pumpAndSettle();
      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g-pm'));
    });

    testWidgets("the prototype's top bar, team card, and work in two groups: "
        'waiting on you, then working on', (tester) async {
      await pump(tester, backend());
      await openProject(tester, project);

      expect(tester.widget<Text>(key('swarm-title')).data, 'Mobile');
      expect(
        middle(tester, key('swarm-title')),
        closeTo(middle(tester, key('tty-back')), 2),
        reason: 'the name beside back, in one bar',
      );
      expect(
        tester.getTopLeft(key('tty-back')).dx,
        4,
        reason: "the prototype's 44-point back, 4 points in",
      );
      expect(tester.getSize(key('tty-back')), const Size(44, 44));
      expect(tester.getTopLeft(key('swarm-title')).dx, 4 + 44 + 4);
      expect(find.text('Team'), findsNothing, reason: 'fewer words');
      expect(find.text('Phone Swarm'), findsNothing, reason: 'one Swarm');
      expect(
        inside('swarm-team-line', find.byType(SwarmAvatar)),
        findsNWidgets(3),
        reason: 'River, Nova and Atlas',
      );
      expect(
        y(tester, 'swarm-lead-chat'),
        lessThan(tester.getTopLeft(find.text('Waiting on you')).dy),
      );
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
    });

    testWidgets('the team card opens each agent in a sheet', (tester) async {
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
      expect(
        tester
            .widget<SwarmAvatar>(
              inside('swarm-team-line', find.byType(SwarmAvatar)).first,
            )
            .id,
        'agent-lead',
        reason: 'the Product Manager first, as the prototype stacks them',
      );

      await tester.tap(key('swarm-team-line'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmTeamSheet), findsOneWidget);
      expect(find.byType(SwarmProjectPage), findsOneWidget, reason: 'under it');
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
      expect(find.byType(SwarmTeamSheet), findsNothing);
    });

    testWidgets('Chat with PM says Opening… while it opens, and says why it '
        'did not', (tester) async {
      final fake = backend();
      final answer = Completer<Object?>();
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => answer.future;
      await pump(tester, fake);
      await openProject(tester, web);

      await tester.tap(key('swarm-pm-chat'));
      await tester.pump();
      expect(
        find.descendant(
          of: key('swarm-pm-chat'),
          matching: find.text('Opening…'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-pm-chat'));
      await tester.pump();
      expect(fake.commands, hasLength(1), reason: 'one tap, one chat');

      answer.complete({'result': <String, dynamic>{}});
      await tester.pumpAndSettle();
      expect(find.byType(SwarmConversationPage), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-pm-error'),
          matching: find.text('Chat with PM is not ready yet. Try again.'),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('swarm-pm-chat'),
          matching: find.text('Chat with PM'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('the project chat opens', (tester) async {
      await pump(tester, backend());
      await openProject(tester, web);

      await tester.tap(key('swarm-lead-chat'));
      await tester.pumpAndSettle();

      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, webLead));
    });
  });

  group('the team line', () {
    testWidgets('down is red, dot and words; Needs you never shows it', (
      tester,
    ) async {
      await pump(tester, backend());
      await openDrawer(tester);

      final line = find.descendant(
        of: key('swarm-drawer-project-$tab-$project'),
        matching: find.byType(SwarmTeamLine),
      );
      expect(line, findsOneWidget);
      Color? colorOf(String words) {
        Color? found;
        tester
            .widget<RichText>(
              find.descendant(of: line, matching: find.byType(RichText)),
            )
            .text
            .visitChildren((span) {
              // A part's words never part: its spaces do not break.
              if (span is TextSpan &&
                  span.text?.replaceAll('\u00A0', ' ').trim() == words) {
                found = span.style?.color;
              }
              return true;
            });
        return found;
      }

      expect(colorOf('1 down'), AppColors.danger);
      expect(colorOf('1 waiting'), isNot(AppColors.danger));
      Color? dotOf(String words) {
        Color? found, dot;
        tester
            .widget<RichText>(
              find.descendant(of: line, matching: find.byType(RichText)),
            )
            .text
            .visitChildren((span) {
              if (span is TextSpan && span.text == '●') {
                dot = span.style?.color;
              } else if (span is TextSpan &&
                  span.text?.replaceAll('\u00A0', ' ').trim() == words) {
                found = dot;
              }
              return true;
            });
        return found;
      }

      expect(dotOf('1 waiting'), AppColors.warning, reason: "the app's yellow");
      expect(dotOf('1 down'), AppColors.danger);
      expect(find.textContaining('Atlas'), findsNothing);
    });

    testWidgets("the prototype's small dots, its parts a space apart; wider "
        'apart on the team card', (tester) async {
      await pump(tester, backend());

      TextSpan spans(Finder line) =>
          tester
                  .widget<RichText>(
                    find.descendant(of: line, matching: find.byType(RichText)),
                  )
                  .text
              as TextSpan;
      final row = find.descendant(
        of: key('swarm-project-$tab-$project'),
        matching: find.byType(SwarmTeamLine),
      );
      final dots = <double?>[];
      spans(row).visitChildren((span) {
        if (span is TextSpan && span.text == '●') {
          dots.add(span.style?.fontSize);
        }
        return true;
      });
      expect(dots, isNotEmpty);
      expect(
        dots,
        everyElement(closeTo(13.5 * .8, .01)),
        reason: 'about 8 points across, smaller than the words',
      );
      expect(
        spans(row).toPlainText(),
        contains('waiting ●'),
        reason: 'one space between parts',
      );

      await tester.tap(key('swarm-project-$tab-$project'));
      await tester.pumpAndSettle();
      expect(
        spans(
          find.descendant(
            of: key('swarm-team-line'),
            matching: find.byType(SwarmTeamLine),
          ),
        ).toPlainText(),
        contains('waiting  ●'),
        reason: "the team card spreads them, as the prototype's gap",
      );
    });

    testWidgets('too long for its row, it wraps between its parts and never '
        'cuts one: down always shows', (tester) async {
      final fake = backend();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) {
        final load = parts(body)! as Map<String, dynamic>;
        return {
          ...load,
          'agents': [
            ...load['agents'] as List,
            part('agent-kai', 1, agent('agent-kai', displayName: 'Kai')),
          ],
          'groups': [
            ...load['groups'] as List,
            part(
              'g-kai',
              40,
              groupData('g-kai', status: 'working', workerId: 'agent-kai'),
            ),
          ],
        };
      };
      await pump(tester, fake);
      await openDrawer(tester);

      final text = find.descendant(
        of: find.descendant(
          of: key('swarm-drawer-project-$tab-$project'),
          matching: find.byType(SwarmTeamLine),
        ),
        matching: find.byType(RichText),
      );
      final paragraph = tester.renderObject<RenderParagraph>(text);
      expect(paragraph.didExceedMaxLines, isFalse, reason: 'nothing cut');
      expect(
        paragraph.text.toPlainText(),
        allOf(contains('1\u00A0working'), contains('1\u00A0down')),
        reason: 'each part whole, on one line',
      );
      // And each dot on the line of its words.
      final plain = paragraph.text.toPlainText();
      expect('●'.allMatches(plain), hasLength(3));
      double middle(int offset) => paragraph
          .getBoxesForSelection(
            TextSelection(baseOffset: offset, extentOffset: offset + 1),
          )
          .first
          .toRect()
          .center
          .dy;
      for (final dot in '●'.allMatches(plain)) {
        final words = plain.indexOf('1', dot.start);
        expect(middle(dot.start), closeTo(middle(words), 4), reason: plain);
      }
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

    testWidgets('before the list answers, Needs you, Chat with PM and the '
        'projects are skeleton rows, and nothing says it is reading', (
      tester,
    ) async {
      final fake = backend();
      final listed = hold(fake, '/api/super-tabs/list');
      await pump(tester, fake, settle: false);

      for (final k in [
        'swarm-needs-loading',
        'swarm-pm-loading',
        'swarm-projects-loading',
      ]) {
        expect(key(k), findsOneWidget, reason: k);
      }
      expect(
        y(tester, 'swarm-needs-loading'),
        lessThan(y(tester, 'swarm-pm-loading')),
      );
      expect(
        y(tester, 'swarm-pm-loading'),
        lessThan(y(tester, 'swarm-projects-loading')),
      );
      expect(find.text('Chat with PM'), findsOneWidget);
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
        final pm = height(tester, 'swarm-pm-loading-0');
        final row = height(tester, 'swarm-projects-loading-0');

        listed.complete();
        await tester.pumpAndSettle();

        expect(height(tester, 'swarm-home-pm-$tab-$project'), closeTo(pm, .01));
        expect(
          height(tester, 'swarm-project-$tab-$web'),
          closeTo(row, .01),
          reason: 'a team line on one line, as the skeleton draws it',
        );
      });
    }

    testWidgets('of two Swarms, the one still to be read has its rows on '
        'their way under its name, on Home and in the drawer', (tester) async {
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
      expect(key('swarm-home-pm-$second-$project'), findsOneWidget);
      expect(key('swarm-pm-loading-$tab'), findsOneWidget);
      expect(key('swarm-projects-loading-$tab'), findsOneWidget);
      expect(
        y(tester, 'swarm-projects-loading-$tab'),
        greaterThan(tester.getTopLeft(find.text('Phone Swarm').first).dy),
        reason: 'under its own name',
      );
      expect(key('swarm-needs-loading'), findsOneWidget);
      expect(find.text('Nothing needs you.'), findsNothing);
      await tester.tap(key('swarm-menu'));
      await frames(tester);
      expect(key('swarm-drawer-loading-$tab'), findsOneWidget);
      expect(key('swarm-drawer-project-$second-$project'), findsOneWidget);

      read.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-drawer-loading-$tab'), findsNothing);
      expect(key('swarm-drawer-project-$tab-$project'), findsOneWidget);
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
      expect(key('swarm-need-decision:d1'), findsOneWidget);
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

      await tester.tap(key('swarm-done-m1'));
      await frames(tester);

      expect(
        key('swarm-needs-loading'),
        findsNothing,
        reason: 'what waits was read; only the Swarm count is behind',
      );
      expect(find.text('Nothing needs you.'), findsOneWidget);
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

    testWidgets('the drawer has skeleton project rows before the list, as '
        'tall as the rows that replace them', (tester) async {
      final fake = backend();
      final listed = hold(fake, '/api/super-tabs/list');
      await pump(tester, fake, settle: false);
      await tester.tap(key('swarm-menu'));
      await frames(tester);

      expect(
        find.descendant(
          of: find.byType(SwarmDrawer),
          matching: find.text('Projects'),
        ),
        findsOneWidget,
      );
      final row = height(tester, 'swarm-drawer-loading-0');
      listed.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-drawer-loading'), findsNothing);
      expect(
        height(tester, 'swarm-drawer-project-$tab-$web'),
        closeTo(row, .01),
      );
    });

    testWidgets("a closed project in the drawer works out none of its chats", (
      tester,
    ) async {
      final host = await pump(tester, backend());
      final inbox = host.session!.inbox;
      final needs = _Reads(inbox.needs);
      inbox.needs = needs;

      await openDrawer(tester);
      expect(needs.reads, 0, reason: 'both projects are closed');

      await tester.tap(key('swarm-drawer-chats-$tab-$project'));
      await tester.pumpAndSettle();
      expect(
        needs.reads,
        greaterThan(0),
        reason: 'the open one lists what waits on the person first',
      );
      expect(
        y(tester, 'swarm-drawer-chat-g1'),
        lessThan(y(tester, 'swarm-drawer-chat-g-busy')),
      );
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
