import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/pm_chat_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Buddies (Ken's spec, 10-28): a person's private agent per project. Since
/// 10-29 they are on in every Swarm and replace Chat with PM: each person's
/// Buddy chat is where the PM's private lines to them land.
void main() {
  List<Map<String, dynamic>> commands(ConversationServer server, String type) =>
      [
        for (final post in server.posts)
          if ((post['command'] as Map)['type'] == type)
            Map<String, dynamic>.from(post['command'] as Map),
      ];

  group('the controller', () {
    test("the reader's Buddy chat and Buddy are theirs, whatever an older server says of Buddies", () async {
      final server = buddySwarm(enabled: false);
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(c.buddyChat('lead')?.id, 'buddy-peer-lead');
      expect(c.buddy('lead')?.id, 'wren');
    });

    test("another person's Buddy is not the reader's", () async {
      final server = buddySwarm();
      giveBuddy(server, person: 'owner', id: 'moss', name: 'Moss');
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(c.buddy('lead'), isNull);
      expect(c.buddyChat('lead'), isNull);
    });

    test(
      'adding a Buddy sends the project, machine and engine and opens its chat',
      () async {
        final server = buddySwarm();
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();

        expect(
          await c.addBuddy(
            projectId: 'lead',
            machineId: 'ken-mac',
            engine: 'claude',
          ),
          isTrue,
        );

        expect(commands(server, 'buddy.create'), [
          {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'ken-mac',
            'engine': 'claude',
          },
        ]);
        expect(c.buddy('lead'), isNotNull);
        expect(c.selectedId, 'buddy-peer-lead');
      },
    );

    // Ken, 11-04 (#2832): a Buddy runs with its owner's full access on their
    // own machine, Codex as Claude Code.
    test('a Codex Buddy is added as a Claude one is', () async {
      final server = buddySwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(
        await c.addBuddy(
          projectId: 'lead',
          machineId: 'ken-mac',
          engine: 'codex',
        ),
        isTrue,
      );
      expect(c.operationError, isNull);
      expect(commands(server, 'buddy.create').single['engine'], 'codex');
      expect(c.buddy('lead'), isNotNull);
    });

    test('a refused add says why and opens nothing', () async {
      final server = buddySwarm();
      server.refuse = {
        'code': 'BUDDY_EXISTS',
        'message': 'You already have a Buddy in this project.',
      };
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      final before = c.selectedId;

      expect(
        await c.addBuddy(
          projectId: 'lead',
          machineId: 'ken-mac',
          engine: 'claude',
        ),
        isFalse,
      );
      expect(c.operationError, 'You already have a Buddy in this project.');
      expect(c.selectedId, before);
    });

    test('adding a second Buddy while one runs in the project is refused, as the backend does', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(
        await c.addBuddy(
          projectId: 'lead',
          machineId: 'studio',
          engine: 'claude',
        ),
        isFalse,
      );
      expect(c.operationError, 'You already have a Buddy in this project.');
      expect(c.buddy('lead')?.id, 'wren');
    });

    test('removing a Buddy sends its project and keeps its chat', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(await c.removeBuddy('lead'), isTrue);

      expect(commands(server, 'buddy.remove'), [
        {'type': 'buddy.remove', 'projectId': 'lead'},
      ]);
      expect(c.buddy('lead'), isNull);
      expect(c.buddyChat('lead'), isNotNull);
    });

    test(
      'renaming the Buddy sends its chat and the name, and the Swarm shows it',
      () async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();

        expect(await c.renameBuddy('lead', '  Sparky '), isTrue);

        expect(commands(server, 'buddy.rename'), [
          {
            'type': 'buddy.rename',
            'conversationId': 'buddy-peer-lead',
            'name': 'Sparky',
          },
        ]);
        expect(c.snapshot!.agentName('wren'), 'Sparky');
        expect(c.buddyChat('lead')?.buddyName, 'Sparky');
      },
    );

    // Task #4568: the server then gives it a fresh real name, never "<person>'s Buddy".
    test('clearing the name sends none, for a fresh one', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.renameBuddy('lead', 'Sparky');

      expect(await c.renameBuddy('lead', '   '), isTrue);

      expect(commands(server, 'buddy.rename').last['name'], isNull);
      expect(c.snapshot!.agentName('wren'), 'Atlas');
      expect(c.buddyChat('lead')?.buddyName, 'Atlas');
    });

    test('a refused rename says why and keeps the name', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      server.refuse = {
        'code': 'BUDDY_NAME_TAKEN',
        'message': 'Lead is taken in this Swarm. Choose another.',
      };

      expect(await c.renameBuddy('lead', 'Lead'), isFalse);

      expect(c.operationError, 'Lead is taken in this Swarm. Choose another.');
      expect(c.snapshot!.agentName('wren'), 'Wren');
    });

    test('the shortcut opens the Buddy chat and never creates a private conversation', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(await c.openCurrentBuddyChat(), isTrue);

      expect(c.selectedId, 'buddy-peer-lead');
      expect(commands(server, 'conversation.create'), isEmpty);
    });

    test('with no Buddy chat yet, the shortcut opens one on the server, with no Buddy in it', () async {
      final server = buddySwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(await c.openCurrentBuddyChat(), isTrue);

      expect(commands(server, 'buddy.chat'), [
        {'type': 'buddy.chat', 'projectId': 'lead'},
      ]);
      expect(c.selectedId, 'buddy-peer-lead');
      expect(c.buddy('lead'), isNull);
      expect(commands(server, 'conversation.create'), isEmpty);
      expect(commands(server, 'buddy.create'), isEmpty);
    });

    /// Ken's Chat with PM from before Buddies replaced it, with an unread PM
    /// reply, as a server from before 10-29 still sends it.
    Future<(ConversationServer, SuperTabController, String)> oldPmChat() async {
      final server = buddySwarm(enabled: false);
      (server.state['conversations'] as List).add({
        ...conversationFixture('old-pm-chat', 'ken.tran'),
        'projectId': 'lead',
        'leadId': 'lead-agent',
        'agentIds': ['lead-agent'],
        'audience': {
          'people': [
            {'id': 'peer', 'generation': 'fixture'},
          ],
        },
      });
      pmReply(server, 'old-pm-chat', 'Earlier answer from the PM');
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      return (server, c, 'old-pm-chat');
    }

    test(
      'an old Chat with PM opened by id opens the project chat instead',
      () async {
        final (_, c, id) = await oldPmChat();

        expect(await c.select(id), isTrue);

        expect(c.selectedId, 'lead');
      },
    );

    test('an old Chat with PM counts nothing on the Swarm tab', () async {
      final (_, c, _) = await oldPmChat();
      expect(c.buddyUnread, 0);
    });

    test(
      "the PM's unread lines in the reader's Buddy chat count on the Swarm tab",
      () async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();
        await c.select('lead');
        pmReply(server, 'buddy-peer-lead', 'Your fix is merged.');
        pmReply(server, 'buddy-peer-lead', 'And released.');
        await c.refresh();

        expect(c.buddyUnread, 2);
      },
    );
  });

  group('the sidebar', () {
    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server, {
      String account = 'peer',
      Brightness brightness = Brightness.light,
      AppNotifier? app,
    }) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = server.controller(account: account);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              app: app,
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return c;
    }

    Future<void> close(WidgetTester tester, SuperTabController c) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }

    testWidgets(
      'the shortcut with no Buddy in the project opens its chat, which offers to start one',
      (tester) async {
        final server = buddySwarm();
        final c = await show(tester, server);
        expect(await c.buddyChatOpener!('lead'), isTrue);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'buddy-peer-lead');
        expect(
          find.text('Start your agent to brainstorm here'),
          findsOneWidget,
        );
        expect(find.text('Add a Buddy'), findsNothing);
        expect(commands(server, 'conversation.create'), isEmpty);
        await close(tester, c);
      },
    );

    group('no Chat with PM', () {
      testWidgets('no other private chat is listed or opened either', (
        tester,
      ) async {
        final server = buddySwarm();
        giveBuddy(server);
        (server.state['conversations'] as List).add({
          ...conversationFixture('private', 'Pricing talk'),
          'projectId': 'lead',
          'agentIds': ['lead-agent'],
          'audience': {
            'people': [
              {'id': 'peer', 'generation': 'fixture'},
              {'id': 'owner', 'generation': 'fixture'},
            ],
          },
        });
        final c = await show(tester, server);
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('super-group-private')), findsNothing);
        expect(find.text('Pricing talk'), findsNothing);
        expect(await c.select('private'), isTrue);
        expect(c.selectedId, 'lead');
        await close(tester, c);
      });
    });

    group('a proposal in the project chat', () {
      testWidgets(
        "legacy content stays complete and opens with ordinary Reply",
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          buddyReply(
            server,
            'lead',
            'Proposal from ken.tran\'s Buddy, on ken.tran\'s behalf\nGoal: Offline mode\nScope: Desktop only\nPriority: high',
            source: {
              'kind': 'buddy-proposal',
              'personId': 'peer',
              'ownerMessageId': 'message-1',
            },
          );
          // The server gives a top-level message itself as its thread.
          final proposal = server.messages.last;
          proposal['thread'] = proposal['id'];
          // A Buddy's ordinary message carries no label, whatever it says.
          buddyReply(server, 'lead', 'Proposal · on ken.tran\'s behalf');
          final c = await show(tester, server);
          await c.select('lead');
          await tester.pumpAndSettle();

          expect(find.textContaining('Scope: Desktop only'), findsOneWidget);
          final row = find.byKey(ValueKey('super-message-${proposal['id']}'));
          await tester.tap(
            find.descendant(of: row, matching: find.byTooltip('Reply')),
          );
          await tester.pumpAndSettle();
          expect(c.openedThread?.root, proposal['id']);
          expect(
            find.byKey(const ValueKey('super-proposal-label')),
            findsNothing,
          );
          expect(find.textContaining('Scope: Desktop only'), findsNWidgets(2));
          await close(tester, c);
        },
      );
    });
  });
}
