import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/pm_chat_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Each person's private chat with a project's Product Manager: one per person
/// and project, read by that person and the Lead alone.
void main() {
  List<Map<String, dynamic>> creates(ConversationServer server) => [
    for (final post in server.posts)
      if ((post['command'] as Map)['type'] == 'conversation.create') post,
  ];

  group('the controller', () {
    test('the first open creates a private conversation for the person alone, named after them', () async {
      final server = pmChatSwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      expect(c.pmChat('lead'), isNull);

      expect(await c.openPmChat('lead'), isTrue);

      expect(creates(server), hasLength(1));
      expect(creates(server).single['command'], {
        'type': 'conversation.create',
        'projectId': 'lead',
        'title': 'ken.tran',
        'brief': '',
        'checks': <dynamic>[],
        'audience': {
          'personIds': ['peer'],
        },
      });
      final chat = c.pmChat('lead');
      expect(chat, isNotNull);
      expect(chat!.audience, ['peer']);
      expect(chat.agentIds, ['lead-agent']);
      expect(c.selectedId, chat.id);
    });

    test(
      'a later open reopens the same conversation and sends nothing',
      () async {
        final server = pmChatSwarm();
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();
        await c.openPmChat('lead');
        final id = c.pmChat('lead')!.id;
        await c.select('lead');
        final sent = server.posts.length;

        expect(await c.openPmChat('lead'), isTrue);

        expect(server.posts, hasLength(sent));
        expect(c.selectedId, id);
      },
    );

    test('two windows opening it at once get one conversation: the create repeats one request', () async {
      final server = pmChatSwarm();
      final first = server.controller(account: 'peer');
      final second = server.controller(account: 'peer');
      addTearDown(first.dispose);
      addTearDown(second.dispose);
      await first.refresh();
      await second.refresh();

      // The second window read before the first one's create landed.
      await first.openPmChat('lead');
      await second.openPmChat('lead');

      expect(creates(server), hasLength(2));
      expect(
        creates(server).map((p) => p['operationId']).toSet(),
        hasLength(1),
      );
      final groups = (server.state['conversations'] as List).where(
        (g) => (g as Map)['audience'] != null,
      );
      expect(groups, hasLength(1));
      expect(second.selectedId, first.pmChat('lead')!.id);
      expect(second.pmChat('lead')!.id, first.pmChat('lead')!.id);
    });

    test('each person and project has its own create request', () async {
      final server = pmChatSwarm();
      final peer = server.controller(account: 'peer');
      final owner = server.controller(account: 'owner');
      addTearDown(peer.dispose);
      addTearDown(owner.dispose);
      await peer.refresh();
      await owner.refresh();
      await peer.openPmChat('lead');
      await owner.openPmChat('lead');

      final ids = creates(server).map((p) => p['operationId']).toList();
      expect(ids, hasLength(2));
      expect(ids.toSet(), hasLength(2));
      expect(peer.pmChat('lead')!.id, isNot(owner.pmChat('lead')!.id));
    });

    test('a person who left and rejoined gets a new chat, not the one they can no longer read', () async {
      final server = pmChatSwarm();
      final people = (server.state['people'] as List).cast<Map>();
      people.firstWhere((p) => p['id'] == 'peer')['generation'] = 'first';
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      expect(await c.openPmChat('lead'), isTrue);
      final before = c.pmChat('lead')!.id;

      // Removed and invited back: the same person at a new membership, which
      // the old chat's audience no longer lets read it. A rejoin has readers
      // reload in full (backend parts/commit.ts visibilityChanged).
      people.firstWhere((p) => p['id'] == 'peer')['generation'] = 'second';
      server.parts.epoch++;
      await c.refresh();
      expect(c.snapshot!.conversation(before), isNull);
      expect(c.pmChat('lead'), isNull);

      expect(await c.openPmChat('lead'), isTrue);

      final after = c.pmChat('lead')!;
      expect(after.id, isNot(before));
      expect(c.selectedId, after.id);
      expect(
        creates(server).map((p) => p['operationId']).toSet(),
        hasLength(2),
      );
    });

    test("another member, the owner included, does not see a person's chat and opens their own", () async {
      final server = pmChatSwarm();
      final peer = server.controller(account: 'peer');
      addTearDown(peer.dispose);
      await peer.refresh();
      await peer.openPmChat('lead');
      final mine = peer.pmChat('lead')!.id;

      final owner = server.controller(account: 'owner');
      addTearDown(owner.dispose);
      await owner.refresh();

      expect(owner.snapshot!.conversation(mine), isNull);
      expect(owner.pmChat('lead'), isNull);
    });

    test(
      'a private conversation shared with someone else too is not the PM chat',
      () async {
        final server = pmChatSwarm();
        (server.state['conversations'] as List).add({
          ...conversationFixture('pair', 'Ken and owner'),
          'projectId': 'lead',
          'audience': {
            'people': [
              {'id': 'peer', 'generation': 'g'},
              {'id': 'owner', 'generation': 'g'},
            ],
          },
        });
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();

        expect(c.snapshot!.conversation('pair')!.audience, ['peer', 'owner']);
        expect(c.pmChat('lead'), isNull);
      },
    );
  });

  group('the sidebar', () {
    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server, {
      String account = 'peer',
    }) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = server.controller(account: account);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      if (!c.expandedProjects.contains('lead')) c.toggleProject('lead');
      await tester.pumpAndSettle();
      return c;
    }

    Future<void> close(WidgetTester tester, SuperTabController c) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }

    final entry = find.byKey(const ValueKey('super-pm-chat-lead'));

    testWidgets('Chat with PM is listed below a project\'s workgroups', (
      tester,
    ) async {
      final c = await show(tester, pmChatSwarm());
      expect(entry, findsOneWidget);
      expect(
        find.descendant(of: entry, matching: find.text('Lead')),
        findsOneWidget,
      );
      final workgroup = find.byKey(const ValueKey('super-group-offline'));
      expect(
        tester.getTopLeft(workgroup).dy,
        lessThan(tester.getTopLeft(entry).dy),
      );
      await close(tester, c);
    });

    testWidgets(
      'the first click opens a new chat, named Chat with PM in the header, not listed again among the workgroups',
      (tester) async {
        final server = pmChatSwarm();
        final c = await show(tester, server);
        await tester.tap(entry);
        await tester.pumpAndSettle();

        expect(creates(server), hasLength(1));
        final chat = c.pmChat('lead')!;
        expect(c.selectedId, chat.id);
        expect(find.byKey(ValueKey('super-group-${chat.id}')), findsNothing);
        // The header names the chat; the sidebar names its Product Manager.
        expect(find.text('Chat with PM'), findsOneWidget);
        expect(find.text('Message Lead'), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey('super-group-offline')));
        await tester.pumpAndSettle();
        await tester.tap(entry);
        await tester.pumpAndSettle();
        expect(creates(server), hasLength(1));
        expect(c.selectedId, chat.id);
        await close(tester, c);
      },
    );

    testWidgets(
      'the chat lists only its own people: the person and the Product Manager',
      (tester) async {
        final server = pmChatSwarm();
        (server.state['agents'] as List).add({
          'id': 'builder',
          'name': 'Builder',
          'machineId': 'm1',
          'harnessId': 'h2',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude', 'model': 'opus'},
        });
        final c = await show(tester, server);
        expect(
          find.byKey(const ValueKey('super-person-owner')),
          findsOneWidget,
        );
        await tester.tap(entry);
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('super-person-peer')), findsOneWidget);
        expect(find.byKey(const ValueKey('super-person-owner')), findsNothing);
        expect(find.text('Lead'), findsWidgets);
        expect(find.text('Builder'), findsNothing);
        await close(tester, c);
      },
    );

    testWidgets(
      'the chat offers no Add agent: the Product Manager is its only agent',
      (tester) async {
        final c = await show(tester, pmChatSwarm());
        final addAgent = find.byTooltip('Add agent');
        expect(addAgent, findsOneWidget);
        await tester.tap(entry);
        await tester.pumpAndSettle();

        expect(c.selectedId, c.pmChat('lead')!.id);
        expect(addAgent, findsNothing);
        await close(tester, c);
      },
    );

    testWidgets('a reply from the Product Manager counts on the entry', (
      tester,
    ) async {
      final server = pmChatSwarm();
      final c = await show(tester, server);
      await tester.tap(entry);
      await tester.pumpAndSettle();
      final chat = c.pmChat('lead')!;
      await tester.tap(find.byKey(const ValueKey('super-group-offline')));
      await tester.pumpAndSettle();

      server.append('Here is the plan.', conversationId: chat.id);
      await c.refresh();
      await tester.pumpAndSettle();

      expect(c.unread(c.pmChat('lead')!), isTrue);
      expect(find.descendant(of: entry, matching: find.text('1')), findsOne);
      expect(
        find.descendant(
          of: entry,
          matching: find.byTooltip('1 new in Chat with PM'),
        ),
        findsOneWidget,
      );
      await close(tester, c);
    });

    testWidgets(
      "a Product Manager's tag in the chat is in Notifications under Chat with PM, and opens it",
      (tester) async {
        final server = pmChatSwarm();
        final c = await show(tester, server);
        await tester.tap(entry);
        await tester.pumpAndSettle();
        final chat = c.pmChat('lead')!.id;
        await tester.tap(find.byKey(const ValueKey('super-group-offline')));
        await tester.pumpAndSettle();
        server.append('Which build should I ship?', conversationId: chat);
        server.tag(
          'message-${server.revision}',
          conversationId: chat,
          text: 'Which build should I ship?',
        );
        server.mentions.last['conversationTitle'] = 'ken.tran';
        await c.refresh();
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const ValueKey('super-notifications')));
        await tester.pumpAndSettle();
        final row = find.byKey(const ValueKey('super-mention-mention-1'));
        expect(
          find.descendant(
            of: row,
            matching: find.text('web-project · Chat with PM'),
          ),
          findsOneWidget,
        );
        await tester.tap(row);
        await tester.pumpAndSettle();
        expect(c.selectedId, chat);
        await close(tester, c);
      },
    );

    testWidgets("the owner's sidebar never lists a member's chat", (
      tester,
    ) async {
      final server = pmChatSwarm();
      final peer = server.controller(account: 'peer');
      await peer.refresh();
      await peer.openPmChat('lead');
      final id = peer.pmChat('lead')!.id;
      peer.dispose();

      final c = await show(tester, server, account: 'owner');
      expect(find.byKey(ValueKey('super-group-$id')), findsNothing);
      expect(
        find.descendant(
          of: find.byType(ProjectSidebar),
          matching: find.text('ken.tran'),
        ),
        findsNothing,
      );
      expect(entry, findsOneWidget);
      await close(tester, c);
    });
  });
}
