import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/section_heading.dart';
import 'package:harness/super_tabs/threads_view.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// One Buddy per person per Swarm (Dee, 10-31; spec
/// 2026-10-31-one-buddy-per-swarm): `# buddy` is the first row under
/// Projects, with no Buddies section; New session picks a project; older
/// project Buddy chats read only.
void main() {
  List<Map<String, dynamic>> commands(ConversationServer server, String type) =>
      [
        for (final post in server.posts)
          if ((post['command'] as Map)['type'] == type)
            Map<String, dynamic>.from(post['command'] as Map),
      ];

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.light,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(account: 'peer');
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Kens-MacBook',
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

  final buddyRow = find.byKey(const ValueKey('super-swarm-buddy'));

  /// A line in the reader's older Buddy chat in the lead project, so it has
  /// history to keep.
  void oldLine(ConversationServer server) {
    server.append('An older word', conversationId: 'buddy-peer-lead');
    final chat = (server.state['conversations'] as List).cast<Map>().firstWhere(
      (g) => g['id'] == 'buddy-peer-lead',
    );
    chat['lastMessageSequence'] = 1;
  }

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(buddyRow);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Buddy options'));
    await tester.pumpAndSettle();
  }

  final headings = find.byType(SuperTabSectionHeading);
  List<String> titles(WidgetTester tester) => [
    for (final h in tester.widgetList<SuperTabSectionHeading>(headings))
      h.title,
  ];

  group('the controller', () {
    test('keys the one Buddy and its chat by the empty id, and adds and removes it naming no project', () async {
      final server = oneBuddySwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      expect(c.oneBuddy, isTrue);
      expect(c.buddyChat(SuperTabController.kSwarmBuddyKey), isNull);

      expect(await c.openBuddyChat(SuperTabController.kSwarmBuddyKey), isTrue);
      expect(commands(server, 'buddy.chat'), [
        {'type': 'buddy.chat'},
      ]);
      expect(c.selectedId, 'swarm-buddy-peer');
      expect(
        c.buddyChat(SuperTabController.kSwarmBuddyKey)?.isSwarmBuddyChat,
        isTrue,
      );

      expect(
        await c.addBuddy(
          projectId: SuperTabController.kSwarmBuddyKey,
          machineId: 'ken-mac',
          engine: 'claude',
        ),
        isTrue,
      );
      expect(commands(server, 'buddy.create'), [
        {'type': 'buddy.create', 'machineId': 'ken-mac', 'engine': 'claude'},
      ]);
      expect(c.buddy(SuperTabController.kSwarmBuddyKey), isNotNull);
      // No project's Buddy: the one Buddy belongs to none.
      expect(c.buddy('lead'), isNull);

      expect(await c.removeBuddy(SuperTabController.kSwarmBuddyKey), isTrue);
      expect(commands(server, 'buddy.remove'), [
        {'type': 'buddy.remove'},
      ]);
      expect(c.buddy(SuperTabController.kSwarmBuddyKey), isNull);
    });

    test(
      'never lists the one Buddy chat among a project\'s conversations',
      () async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();
        final chat = c.buddyChat(SuperTabController.kSwarmBuddyKey)!;
        expect(chat.projectId, '');
        expect(c.snapshot!.projects.map((p) => p.id), isNot(contains('')));
      },
    );
  });

  group('the sidebar', () {
    testWidgets('shows # buddy first under Projects and no Buddies section', (
      tester,
    ) async {
      final server = oneBuddySwarm();
      giveSwarmBuddy(server);
      final c = await show(tester, server);

      expect(buddyRow, findsOneWidget);
      expect(
        find.descendant(of: buddyRow, matching: find.text('buddy')),
        findsOneWidget,
      );
      expect(titles(tester), isNot(contains('Buddies')));
      expect(titles(tester), contains('Projects'));
      // First under Projects: above every project's row.
      final projectsHeading = tester.getBottomLeft(find.text('Projects')).dy;
      final top = tester.getTopLeft(buddyRow).dy;
      expect(top, greaterThan(projectsHeading));
      expect(
        top,
        lessThan(
          tester
              .getTopLeft(find.byKey(const ValueKey('super-project-lead')))
              .dy,
        ),
      );

      await tester.tap(buddyRow);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'swarm-buddy-peer');
      // Its chat says it reads every project, and only its person reads it.
      expect(find.textContaining('reads all your projects'), findsOneWidget);
      await close(tester, c);
    });

    testWidgets(
      'opens the one Buddy chat on the server before any Buddy, from the row',
      (tester) async {
        final server = oneBuddySwarm();
        final c = await show(tester, server);
        await tester.tap(buddyRow);
        await tester.pumpAndSettle();
        expect(commands(server, 'buddy.chat'), [
          {'type': 'buddy.chat'},
        ]);
        expect(c.selectedId, 'swarm-buddy-peer');
        await close(tester, c);
      },
    );

    testWidgets(
      'keeps the Buddies section on an older server, with no # buddy row',
      (tester) async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = await show(tester, server);
        expect(buddyRow, findsNothing);
        expect(titles(tester), contains('Buddies'));
        await close(tester, c);
      },
    );
  });

  group('older project Buddy chats', () {
    testWidgets('are listed in the one chat\'s menu and open read only', (
      tester,
    ) async {
      final server = oneBuddySwarm();
      giveSwarmBuddy(server);
      giveBuddy(server, id: 'old', name: 'Old');
      oldLine(server);
      final c = await show(tester, server);
      await tester.tap(buddyRow);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Buddy options'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Earlier chat in'));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'buddy-peer-lead');
      expect(
        find.byKey(const ValueKey('super-earlier-buddy-chat')),
        findsOneWidget,
      );
      expect(
        find.text('This is an earlier chat, kept to read.'),
        findsOneWidget,
      );
      expect(find.textContaining('Earlier Buddy chat · '), findsOneWidget);
      // Nothing looks typeable: no box, no attach or send (Lead's review).
      expect(
        find.byKey(const ValueKey('super-message-composer')),
        findsNothing,
      );
      expect(find.byTooltip('Send message'), findsNothing);
      // Its one action opens the one Buddy chat.
      await tester.tap(find.byKey(const ValueKey('super-open-swarm-buddy')));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'swarm-buddy-peer');
      await close(tester, c);
    });

    testWidgets(
      'drop out of the menu once their project is gone from the reader\'s Swarm',
      (tester) async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        giveBuddy(server, id: 'old', name: 'Old');
        oldLine(server);
        final c = await show(tester, server);
        // The person lost the project: the server no longer lists it to them.
        server.state['projects'] = <dynamic>[];
        await c.refresh();
        await tester.tap(buddyRow);
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Buddy options'));
        await tester.pumpAndSettle();
        expect(find.textContaining('Earlier chat in'), findsNothing);
        await close(tester, c);
      },
    );
  });

  group('security review 1 of #2437', () {
    testWidgets('lists no earlier chat with nothing in it', (tester) async {
      final server = oneBuddySwarm();
      giveSwarmBuddy(server);
      giveBuddy(server, id: 'old', name: 'Old');
      final c = await show(tester, server);
      await openMenu(tester);
      expect(find.textContaining('Earlier chat in'), findsNothing);
      await close(tester, c);
    });

    testWidgets(
      'takes no reply in a thread of an earlier chat, and says it is kept to read',
      (tester) async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        giveBuddy(server, id: 'old', name: 'Old');
        oldLine(server);
        final c = await show(tester, server);
        await c.select('buddy-peer-lead');
        await tester.pumpAndSettle();
        final root = c.messages('buddy-peer-lead').last;
        c.openThread(root.id);
        await tester.pumpAndSettle();
        final field = tester.widget<TextField>(
          find.byKey(const ValueKey('super-thread-composer')),
        );
        expect(field.enabled, isFalse);
        expect(
          field.decoration?.hintText,
          'This is an earlier chat, kept to read.',
        );
        await close(tester, c);
      },
    );

    testWidgets(
      'says it knows one Buddy on each post, so the server refuses one into an earlier chat',
      (tester) async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        final c = await show(tester, server);
        await tester.tap(buddyRow);
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('super-message-composer')),
          'Hello',
        );
        await tester.pump();
        await tester.tap(find.byTooltip('Send message'));
        await tester.pumpAndSettle();
        expect(commands(server, 'message.send').last['oneBuddy'], isTrue);
        await close(tester, c);
      },
    );

    testWidgets(
      'shows every project\'s decisions asked of the reader above # buddy',
      (tester) async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        server.decisions.add({
          'id': 'd1',
          'projectId': 'lead',
          'projectName': 'Pilot',
          'conversationId': 'lead',
          'conversationTitle': 'Lead',
          'askerName': 'Lead',
          'question': 'Ship the Buddy?',
          'options': ['Yes', 'No'],
          'recommended': 0,
          'unblocks': 'The release',
          'createdAt': '2026-10-28T09:00:00Z',
        });
        server.state['decisionsWaiting'] = 1;
        final c = await show(tester, server);
        await tester.tap(buddyRow);
        await tester.pumpAndSettle();
        expect(find.text('Ship the Buddy?'), findsOneWidget);
        await close(tester, c);
      },
    );

    testWidgets('never sends a project the reader lost for New session', (
      tester,
    ) async {
      final server = oneBuddySwarm();
      giveSwarmBuddy(server);
      final c = await show(tester, server);
      await tester.tap(buddyRow);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-chat-new-session')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('super-chat-session-project')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('super-chat-session-in-lead')).last,
      );
      await tester.pumpAndSettle();
      // The reader loses the project before sending: the server lists another in its place.
      server.state['projects'] = [projectFixture('other', 'Other', 'lead')];
      await c.refresh();
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('super-message-composer')),
        'Hand this off',
      );
      await tester.pump();
      await tester.tap(find.byTooltip('Send message'));
      await tester.pumpAndSettle();
      final sent = commands(server, 'message.send').last;
      expect(sent['newSession'], isTrue);
      expect(sent.containsKey('sessionProjectId'), isFalse);
      await close(tester, c);
    });
  });

  group('New session', () {
    testWidgets(
      'in the one chat picks a project, and sends it with the message',
      (tester) async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        final c = await show(tester, server);
        await tester.tap(buddyRow);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-chat-new-session')));
        await tester.pumpAndSettle();
        final menu = find.byKey(const ValueKey('super-chat-session-project'));
        expect(
          find.descendant(of: menu, matching: find.text('All projects')),
          findsOneWidget,
        );
        await tester.tap(menu);
        await tester.pumpAndSettle();
        // What each choice lets people do, its reason a hover away (Lead's review).
        expect(find.text('All projects · ask anything'), findsWidgets);
        expect(find.textContaining('· ask and hand off work'), findsWidgets);
        expect(
          find.byTooltip(
            'Reads every project you read. Sends no work to a PM.',
          ),
          findsWidgets,
        );
        await tester.tap(
          find.byKey(const ValueKey('super-chat-session-in-lead')).last,
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('super-message-composer')),
          'Turn the login fix into a proposal',
        );
        await tester.pump();
        await tester.tap(find.byTooltip('Send message'));
        await tester.pumpAndSettle();
        final sent = commands(server, 'message.send').last;
        expect(sent['newSession'], isTrue);
        expect(sent['sessionProjectId'], 'lead');
        await close(tester, c);
      },
    );
  });

  testWidgets('the Threads list offers no reply in an earlier Buddy chat, '
      'and still offers one in # buddy (merge with #2434)', (tester) async {
    final server = oneBuddySwarm()..threads = true;
    giveSwarmBuddy(server);
    giveBuddy(server, id: 'old', name: 'Wren');
    Map<String, dynamic> thread(String chat) {
      server.append('Root in $chat', conversationId: chat);
      final root = server.messages.last['id'] as String;
      server.append('New reply in $chat', conversationId: chat);
      server.messages.last['thread'] = root;
      return {
        'conversationId': chat,
        'rootId': root,
        'root': {
          'id': root,
          'sequence': 1,
          'author': {'kind': 'agent', 'id': 'wren', 'name': 'Wren'},
          'text': 'Root in $chat',
          'createdAt': '2026-10-31T01:00:00Z',
          'attachments': 0,
        },
        'lastReplyAt': '2026-10-31T02:00:00Z',
        'lastReplySequence': 2,
        'lastReplier': {'kind': 'agent', 'id': 'wren', 'name': 'Wren'},
        'unreadReplies': 1,
        'follow': null,
      };
    }

    final earlier = thread('buddy-peer-lead');
    final current = thread('swarm-buddy-peer');
    server.followedThreads = {
      'unread': [earlier, current],
      'read': [],
      'more': false,
    };
    final c = server.controller(account: 'peer');
    await c.refresh();
    final attention = SuperTabAttention.of(c);
    await attention.load();
    expect(attention.shown, hasLength(2));
    await tester.binding.setSurfaceSize(const Size(700, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabThreadsView(attention: attention, onOpen: (_, _) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Root in buddy-peer-lead'), findsOneWidget);
    expect(
      find.byKey(
        ValueKey(
          'super-thread-open-reply-buddy-peer-lead/${earlier['rootId']}',
        ),
      ),
      findsNothing,
    );
    expect(
      find.byKey(
        ValueKey(
          'super-thread-open-reply-swarm-buddy-peer/${current['rootId']}',
        ),
      ),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  });
}
