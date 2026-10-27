import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_team_line.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

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

  /// Swarm Home as the root of its own stack, Swarm on.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    VoidCallback? onHarness,
    void Function(BuildContext context)? onSettings,
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
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmPage(onHarness: onHarness, onSettings: onSettings),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  double y(WidgetTester tester, String k) => tester.getTopLeft(key(k)).dy;

  Future<void> openDrawer(WidgetTester tester) async {
    await tester.tap(key('swarm-menu'));
    await tester.pumpAndSettle();
  }

  group('the drawer', () {
    testWidgets('Swarm Home, Chat with PM for each project, the projects, '
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
        find.descendant(of: key('swarm-drawer-home'), matching: find.text('3')),
        findsOneWidget,
        reason: 'what waits on the person',
      );
      expect(
        y(tester, 'swarm-drawer-home'),
        lessThan(y(tester, 'swarm-drawer-pm-$tab-$project')),
      );
      expect(
        y(tester, 'swarm-drawer-pm-$tab-$project'),
        lessThan(y(tester, 'swarm-drawer-pm-$tab-$web')),
      );
      expect(
        y(tester, 'swarm-drawer-pm-$tab-$web'),
        lessThan(y(tester, 'swarm-drawer-project-$tab-$project')),
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
        find.descendant(
          of: key('swarm-drawer-pm-$tab-$web'),
          matching: find.text('Cleo'),
        ),
        findsOneWidget,
        reason: 'the Product Manager it is with',
      );
      for (final matching in [
        find.text('Mobile'),
        find.byIcon(LucideIcons.hash300),
      ]) {
        expect(
          find.descendant(
            of: key('swarm-drawer-project-$tab-$project'),
            matching: matching,
          ),
          findsOneWidget,
          reason: 'a project is a # channel',
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
        y(tester, 'swarm-drawer-chat-$leadChat'),
        lessThan(y(tester, 'swarm-drawer-chat-g-busy')),
        reason: 'the project chat first',
      );
      expect(
        y(tester, 'swarm-drawer-chat-g-busy'),
        lessThan(y(tester, 'swarm-drawer-chat-g1')),
        reason: 'then work, the latest activity first',
      );
      expect(
        find.descendant(
          of: key('swarm-drawer-chat-$leadChat'),
          matching: find.text('Project chat'),
        ),
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

      await tester.tap(key('swarm-drawer-pm-$tab-$project'));
      await tester.pumpAndSettle();

      final page = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect((page.swarmId, page.conversationId), (tab, 'g-pm'));
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
      final tty = Tty.of(tester.element(line));
      Color? colorOf(String words) {
        Color? found;
        tester
            .widget<RichText>(
              find.descendant(of: line, matching: find.byType(RichText)),
            )
            .text
            .visitChildren((span) {
              if (span is TextSpan && span.text == words)
                found = span.style?.color;
              return true;
            });
        return found;
      }

      expect(colorOf('1 down'), tty.red);
      expect(colorOf('1 waiting'), isNot(tty.red));
      expect(find.textContaining('Atlas'), findsNothing);
    });
  });
}
