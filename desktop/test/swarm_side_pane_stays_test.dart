import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/places.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart' show ConversationServer;
import 'support/swarm_v4_data.dart';

/// An agent's chat keeps what is open beside it (anh Dee, 2026-11-12: "i open the terminal side by side and i go to another
/// chat and come back and the terminal is closed"): its terminal, its Info, its instructions, each per chat, until its person
/// closes it. The terminal here is wired as the workspace wires it (super_tabs/workspace.dart): shown while the controller holds
/// one open for the chat on screen, opened and closed for that chat.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  late SuperTabController controller;
  late ConversationServer server;

  /// lampOS's Swarm at [size], the first builder's chat open, or as the saved view [saved] left it.
  Future<void> show(
    WidgetTester tester, {
    Size size = const Size(1600, 1000),
    Map<String, dynamic>? saved,
    ConversationServer? swarm,
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    server = swarm ?? swarmV4Server();
    controller = server.controller(
      account: 'owner',
      initial:
          saved ??
          {
            'tabId': 'tab',
            'accountId': 'owner',
            'selectedId': 'agent-chat-first builder',
          },
    );
    addTearDown(controller.dispose);
    await tester.runAsync(controller.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: ListenableBuilder(
            listenable: controller,
            builder: (context, _) {
              final open = controller
                  .terminalAgents(controller.selectedId)
                  .isNotEmpty;
              return SuperTabView(
                controller: controller,
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
                github: swarmV4GitHub(),
                instructions: SwarmV4Computer().link,
                terminalsVisible: open,
                terminal: open
                    ? const Center(child: Text('Terminal fixture'))
                    : null,
                onOpenGroupTerminals: () =>
                    controller.selectGroupTerminals(controller.selectedId),
                onCloseTerminal: () =>
                    controller.selectTerminal(controller.selectedId, null),
              );
            },
          ),
        ),
      ),
    );
    await settle(tester);
  }

  Future<void> tap(WidgetTester tester, Finder what) async {
    await tester.tap(what);
    await settle(tester);
  }

  /// Goes to the second agent's chat and back to the first builder's, by their rows in Your Team.
  Future<void> awayAndBack(WidgetTester tester) async {
    await tap(tester, key('super-agent-second'));
    expect(controller.selectedId, 'agent-chat-second');
    await tap(tester, key('super-agent-first builder'));
    expect(controller.selectedId, 'agent-chat-first builder');
  }

  testWidgets(
    'the terminal opened beside a chat is there again when its person comes back, until they close it',
    (tester) async {
      await show(tester);
      await tap(tester, key('swarm-terminal-button'));
      expect(find.text('Terminal fixture'), findsOneWidget);

      await tap(tester, key('super-agent-second'));
      // The other chat has none of its own open.
      expect(find.text('Terminal fixture'), findsNothing);
      await tap(tester, key('super-agent-first builder'));
      expect(find.text('Terminal fixture'), findsOneWidget);

      // Closed, it stays closed.
      await tap(tester, key('swarm-terminal-button'));
      expect(find.text('Terminal fixture'), findsNothing);
      await awayAndBack(tester);
      expect(find.text('Terminal fixture'), findsNothing);
    },
  );

  testWidgets(
    'Info and the instructions opened beside a chat are there again when its person comes back, each per chat',
    (tester) async {
      await show(tester);
      await tap(tester, key('swarm-info-button'));
      expect(key('swarm-agent-info'), findsOneWidget);

      await tap(tester, key('super-agent-second'));
      // Its Info was opened beside the first builder's chat, not this one.
      expect(key('swarm-agent-info'), findsNothing);
      await tap(tester, key('swarm-instructions-button'));
      final instructionsHere = find.byWidgetPredicate(
        (w) => w.runtimeType.toString() == 'SwarmAgentInstructions',
      );
      expect(instructionsHere, findsOneWidget);

      await tap(tester, key('super-agent-first builder'));
      expect(key('swarm-agent-info'), findsOneWidget);
      expect(instructionsHere, findsNothing);
      await tap(tester, key('super-agent-second'));
      expect(instructionsHere, findsOneWidget);

      // Closed, it stays closed; and a terminal opened in its place takes it.
      await tap(tester, key('super-agent-first builder'));
      await tap(tester, key('swarm-info-button'));
      expect(key('swarm-agent-info'), findsNothing);
      await awayAndBack(tester);
      expect(key('swarm-agent-info'), findsNothing);
      await tap(tester, key('swarm-info-button'));
      await tap(tester, key('swarm-terminal-button'));
      expect(key('swarm-agent-info'), findsNothing);
      expect(find.text('Terminal fixture'), findsOneWidget);
      await awayAndBack(tester);
      expect(key('swarm-agent-info'), findsNothing);
      expect(find.text('Terminal fixture'), findsOneWidget);
    },
  );

  // The review of #4213: back in a chat with its terminal open, Back stepped to that same chat, closed its terminal and went
  // nowhere. A chat with its terminal open is a place, and a step never closes a terminal.
  testWidgets(
    'Back and Forward go between chats with their terminals as they were',
    (tester) async {
      await show(tester);
      await tap(tester, key('swarm-terminal-button'));
      await awayAndBack(tester);
      expect(find.text('Terminal fixture'), findsOneWidget);
      SuperTabPlaces.of(controller).step(-1);
      await settle(tester);
      expect(controller.selectedId, 'agent-chat-second');
      expect(find.text('Terminal fixture'), findsNothing);
      SuperTabPlaces.of(controller).step(1);
      await settle(tester);
      expect(controller.selectedId, 'agent-chat-first builder');
      expect(find.text('Terminal fixture'), findsOneWidget);
    },
  );

  // The review of #4213: a terminal opened from outside the bar (a Waiting on you notice, Manage, My agents) was hidden behind
  // the Info its chat had kept, as a pane comes before a terminal.
  testWidgets(
    'a terminal opened for a chat from outside its bar takes the place of the pane the chat kept',
    (tester) async {
      await show(tester);
      await tap(tester, key('swarm-info-button'));
      await awayAndBack(tester);
      expect(key('swarm-agent-info'), findsOneWidget);
      controller.selectTerminal(controller.selectedId, 'first builder');
      await settle(tester);
      expect(find.text('Terminal fixture'), findsOneWidget);
      expect(key('swarm-agent-info'), findsNothing);
      controller.selectTerminal(controller.selectedId, null);
      await tap(tester, key('swarm-instructions-button'));
      controller.selectGroupTerminals(controller.selectedId);
      await settle(tester);
      expect(find.text('Terminal fixture'), findsOneWidget);
      expect(controller.besidePane(controller.selectedId), isNull);
    },
  );

  // The second review of #4213: Manage and a page never change the chat on screen, so coming back by the chat's own row read as
  // a move within it and closed its terminal; pressing the row of the chat on screen closed it too.
  testWidgets(
    'the terminal is there again on coming back from Manage, a page or My agents, and when its own row is pressed',
    (tester) async {
      final swarm = swarmV4Server()
        ..shippingAnswer = (_) => {
          'week': 1793577600000,
          'people': [
            {
              'personId': 'owner',
              'displayName': 'Dee',
              'agentsShipping': 2,
              'level': 2,
              'points': 2.4,
              'rank': 1,
            },
          ],
          'failures': <dynamic>[],
        };
      await show(tester, swarm: swarm);
      await tap(tester, key('swarm-terminal-button'));
      expect(find.text('Terminal fixture'), findsOneWidget);

      await tap(tester, key('super-agent-first builder'));
      expect(
        find.text('Terminal fixture'),
        findsOneWidget,
        reason: 'its own row',
      );

      await tap(tester, key('super-manage'));
      expect(find.text('Terminal fixture'), findsNothing);
      await tap(tester, key('super-agent-first builder'));
      expect(
        find.text('Terminal fixture'),
        findsOneWidget,
        reason: 'back from Manage',
      );

      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await settle(tester);
      if (key('super-human-owner').evaluate().isEmpty)
        await tap(tester, key('project-sidebar-humans'));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await settle(tester);
      await tap(tester, key('super-human-owner'));
      expect(find.text('Terminal fixture'), findsNothing);
      await tap(tester, key('super-agent-first builder'));
      expect(
        find.text('Terminal fixture'),
        findsOneWidget,
        reason: 'back from a page',
      );
    },
  );

  // The second review of #4213: under 1260 the terminal, and under 1080 a pane, takes the chat's place, and a jump to a message
  // landed under it. A jump shows the chat.
  testWidgets(
    'a jump to a message in a narrow window shows the chat, not what it kept in its place',
    (tester) async {
      await show(tester, size: const Size(1100, 900));
      String firstBuilderLast() =>
          (server.messages.lastWhere(
                (m) => m['conversationId'] == 'agent-chat-first builder',
              )['id'])
              as String;
      final message = firstBuilderLast();
      await tap(tester, key('swarm-terminal-button'));
      expect(find.text('Terminal fixture'), findsOneWidget);
      await tap(tester, key('super-agent-second'));
      controller.openMessageLink(
        SwarmMessageLink(
          tabId: controller.tabId,
          conversationId: 'agent-chat-first builder',
          messageId: message,
        ),
      );
      await settle(tester);
      expect(controller.selectedId, 'agent-chat-first builder');
      expect(find.text('Terminal fixture'), findsNothing);
      expect(find.textContaining('Six tasks are up'), findsWidgets);

      // A pane in the chat's place, under 1080.
      await show(tester, size: const Size(1000, 900));
      await tap(tester, key('swarm-info-button'));
      await tap(tester, key('super-agent-second'));
      controller.openMessageLink(
        SwarmMessageLink(
          tabId: controller.tabId,
          conversationId: 'agent-chat-first builder',
          messageId: firstBuilderLast(),
        ),
      );
      await settle(tester);
      expect(key('swarm-agent-info'), findsNothing);
      expect(find.textContaining('Six tasks are up'), findsWidgets);

      // Beside the chat, a jump leaves what is kept.
      await show(tester);
      await tap(tester, key('swarm-terminal-button'));
      await tap(tester, key('super-agent-second'));
      controller.openMessageLink(
        SwarmMessageLink(
          tabId: controller.tabId,
          conversationId: 'agent-chat-first builder',
          messageId: firstBuilderLast(),
        ),
      );
      await settle(tester);
      expect(find.text('Terminal fixture'), findsOneWidget);
    },
  );

  testWidgets(
    'what was open beside a chat shows again after a restart, from the saved view',
    (tester) async {
      await show(tester);
      await tap(tester, key('swarm-info-button'));
      await tap(tester, key('super-agent-second'));
      await tap(tester, key('swarm-terminal-button'));
      final saved = Map<String, dynamic>.of(controller.savedForTest);
      await show(tester, saved: saved);
      expect(controller.selectedId, 'agent-chat-second');
      expect(find.text('Terminal fixture'), findsOneWidget);
      await tap(tester, key('super-agent-first builder'));
      expect(key('swarm-agent-info'), findsOneWidget);
    },
  );

  test('keeps what is open beside each chat with the rest of its saved view, and only the panes it knows', () async {
    final server = swarmV4Server();
    final saved = server.controller(
      account: 'owner',
      initial: {
        'tabId': 'tab',
        'accountId': 'owner',
        'panes': {
          'agent-chat-second': 'info',
          'agent-chat-first builder': 'nonsense',
          'x': 7,
        },
      },
    );
    addTearDown(saved.dispose);
    await saved.refresh();
    expect(saved.besidePane('agent-chat-second'), 'info');
    expect(saved.besidePane('agent-chat-first builder'), isNull);
    saved.showBeside('agent-chat-first builder', 'instructions');
    expect(saved.savedForTest['panes'], {
      'agent-chat-second': 'info',
      'agent-chat-first builder': 'instructions',
    });
    saved.showBeside('agent-chat-second', null);
    // A terminal asked for again, already open, still takes the place of a pane kept since (the second review of #4213).
    saved.selectTerminal('agent-chat-second', 'second');
    saved.showBeside('agent-chat-second', 'info');
    saved.selectTerminal('agent-chat-second', 'second');
    expect(saved.besidePane('agent-chat-second'), isNull);
    expect(saved.besidePane('agent-chat-second'), isNull);
    expect(saved.besidePane(null), isNull);
  });
}

/// Settles, and lets the read mark a chat saves 200 ms after it is read go, so no timer outlives the test.
Future<void> settle(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.pump(const Duration(milliseconds: 300));
}
