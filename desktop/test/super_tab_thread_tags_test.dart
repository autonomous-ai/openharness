import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_mentions_test.dart' show tagRuns;
import 'support/super_tab_fixture.dart';

/// @ in a thread reply works as in the main chat (Dee, 10-31): the same
/// picker of people and agents, the same Backspace rule, and the reply
/// carries its tags, so the tagged person or agent is told.
void main() {
  final composer = find.byKey(const ValueKey('super-thread-composer'));
  final picker = find.byKey(const ValueKey('super-thread-completions'));
  final mainPicker = find.byKey(const ValueKey('super-composer-completions'));
  final panel = find.byKey(const ValueKey('super-thread-panel'));

  late SuperTabController shown;

  void testTags(
    String description,
    Future<void> Function(WidgetTester tester) body, {
    TestVariant<Object?> variant = const DefaultTestVariant(),
  }) => testWidgets(description, (tester) async {
    await body(tester);
    await tester.pumpWidget(const SizedBox());
    await shown.flush();
  }, variant: variant);

  /// The owner, ken and dee in a Swarm whose chats hold the agent Kestrel;
  /// the lead chat has a thread at message-1, and a second at message-3.
  ConversationServer swarm() {
    final server = ConversationServer()..threads = true;
    server.state['people'] = [
      {'id': 'owner', 'email': 'river@autonomous.ai', 'role': 'owner'},
      {'id': 'ken', 'email': 'ken15@autonomous.ai', 'role': 'collaborator'},
      {'id': 'dee', 'email': 'dee@autonomous.ai', 'role': 'collaborator'},
    ];
    server.state['agents'] = [
      {
        'id': 'kestrel',
        'name': 'Builder',
        'displayName': 'Kestrel',
        'machineId': 'host',
        'harnessId': 'session',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
      // In the Swarm, but in no chat here.
      {
        'id': 'outsider',
        'name': 'Builder',
        'displayName': 'Kelpie',
        'machineId': 'host',
        'harnessId': 'other',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
    ];
    for (final group in server.state['conversations'] as List) {
      (group as Map)['agentIds'] = ['kestrel'];
    }
    server.append('Should we do thread replies?');
    server.append('Yes, like Slack.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    server.append('Second topic.');
    return server;
  }

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    String root = 'message-1',
  }) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = shown = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
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
    c.openThread(root);
    await tester.pumpAndSettle();
    expect(panel, findsOneWidget);
    addTearDown(c.dispose);
    return c;
  }

  List<String> choices(WidgetTester tester) => [
    for (final tile in tester.widgetList<ListTile>(
      find.descendant(of: picker, matching: find.byType(ListTile)),
    ))
      (tile.title as Text).data!,
  ];

  String text(WidgetTester tester) =>
      tester.widget<TextField>(composer).controller!.text;

  Future<void> type(WidgetTester tester, String value) async {
    await tester.tap(composer);
    await tester.enterText(composer, value);
    await tester.pumpAndSettle();
  }

  Map<String, dynamic> lastCommand(ConversationServer server) =>
      Map<String, dynamic>.from(server.posts.last['command'] as Map);

  testTags('@ in a thread reply offers people, then agents, as typed', (
    tester,
  ) async {
    await show(tester, swarm());
    await type(tester, 'Please check @ke');
    expect(choices(tester), ['ken15', 'Kestrel']);
    expect(
      find.descendant(of: picker, matching: find.text('person')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: picker, matching: find.text('agent')),
      findsOneWidget,
    );
    // Never the reader; never an agent outside this chat.
    await type(tester, 'Please check @');
    expect(choices(tester), ['ken15', 'dee', 'Kestrel']);
    // The main chat's own picker does not open for the thread's box.
    expect(mainPicker, findsNothing);
  });

  testTags(
    'a picked tag is sent with the reply: a person tagged, an agent addressed',
    (tester) async {
      final server = swarm();
      final c = await show(tester, server);
      await type(tester, 'Please check @ke');
      // Enter picks, it does not send.
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(text(tester), 'Please check @ken15 ');
      expect(c.threadMentions('lead', 'message-1'), {'ken': '@ken15'});
      expect(server.posts, isEmpty);
      expect(picker, findsNothing);
      // Tab picks too.
      await type(tester, 'Please check @ken15 and @Kes');
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();
      expect(text(tester), 'Please check @ken15 and @Kestrel ');
      expect(server.posts, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final command = lastCommand(server);
      expect(command['type'], 'message.send');
      expect(command['replyTo'], 'message-1');
      expect(command['text'], 'Please check @ken15 and @Kestrel');
      expect(command['mentions'], ['ken']);
      expect(command['recipientIds'], ['kestrel']);
      // Sent, the box and its tags are free for the next reply.
      expect(text(tester), isEmpty);
      expect(c.threadMentions('lead', 'message-1'), isEmpty);
      // The reply in the thread shows its tag as the chat does.
      await c.loadThread();
      await tester.pumpAndSettle();
      expect(tagRuns(tester).where((run) => run == '@ken15'), isNotEmpty);
    },
  );

  testTags('a reply that tags no one goes to no one but the usual reader', (
    tester,
  ) async {
    final server = swarm();
    await show(tester, server);
    // Typed, not picked: no tag of the reader's choosing goes with it.
    await type(tester, 'Thanks @nobody');
    expect(picker, findsNothing);
    await tester.tap(find.byKey(const ValueKey('super-thread-send')));
    await tester.pumpAndSettle();
    final command = lastCommand(server);
    expect(command['recipientIds'], isEmpty);
    expect(command.containsKey('mentions'), isFalse);
  });

  testTags(
    'Backspace right after a tag takes the whole tag, and it is not sent',
    (tester) async {
      final server = swarm();
      final c = await show(tester, server);
      await type(tester, 'Please check @Kes');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(text(tester), 'Please check @Kestrel ');
      expect(c.threadMentions('lead', 'message-1'), {'kestrel': '@Kestrel'});
      // The space the tag brought goes first, as any character does.
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.pumpAndSettle();
      expect(text(tester), 'Please check @Kestrel');
      expect(c.threadMentions('lead', 'message-1'), {'kestrel': '@Kestrel'});
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.pumpAndSettle();
      expect(text(tester), 'Please check ');
      expect(
        tester.widget<TextField>(composer).controller!.selection,
        const TextSelection.collapsed(offset: 13),
      );
      expect(c.threadMentions('lead', 'message-1'), isEmpty);
      // No picker springs up in its place.
      expect(picker, findsNothing);
      await type(tester, 'Please check');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(lastCommand(server)['recipientIds'], isEmpty);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testTags('Escape closes the picker first, then the thread', (tester) async {
    final c = await show(tester, swarm());
    await type(tester, 'Please check @');
    expect(picker, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(picker, findsNothing);
    expect(panel, findsOneWidget);
    expect(text(tester), 'Please check @');
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(c.openedThread, isNull);
  });

  testTags('arrow keys move through the choices; a click picks one', (
    tester,
  ) async {
    final c = await show(tester, swarm());
    await type(tester, '@');
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(text(tester), '@dee ');
    await type(tester, '@dee @Kes');
    await tester.tap(
      find.descendant(of: picker, matching: find.text('Kestrel')),
    );
    await tester.pumpAndSettle();
    expect(text(tester), '@dee @Kestrel ');
    expect(c.threadMentions('lead', 'message-1'), {
      'dee': '@dee',
      'kestrel': '@Kestrel',
    });
  });

  testTags('a private chat offers only the people who read it', (tester) async {
    final server = swarm();
    ((server.state['conversations'] as List)[0] as Map)['audience'] = {
      'people': [
        {'id': 'owner', 'generation': 'fixture'},
        {'id': 'dee', 'generation': 'fixture'},
      ],
    };
    await show(tester, server);
    await type(tester, '@');
    expect(choices(tester), ['dee', 'Kestrel']);
  });

  testTags(
    'each thread keeps its own tags, apart from the main chat and each other',
    (tester) async {
      final server = swarm();
      final c = await show(tester, server);
      await type(tester, '@ke');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.threadMentions('lead', 'message-1'), {'ken': '@ken15'});
      // The main chat holds none of the thread's tags.
      expect(c.mentions('lead'), isEmpty);
      // Another thread starts with its own, empty.
      c.openThread('message-3');
      await tester.pumpAndSettle();
      expect(text(tester), isEmpty);
      expect(c.threadMentions('lead', 'message-3'), isEmpty);
      // The same name typed there, not picked, tags no one.
      await type(tester, '@ken15 look');
      expect(picker, findsNothing);
      await tester.tap(find.byKey(const ValueKey('super-thread-send')));
      await tester.pumpAndSettle();
      final command = lastCommand(server);
      expect(command['replyTo'], 'message-3');
      expect(command.containsKey('mentions'), isFalse);
      // Back in the first thread, its draft and tag are as left.
      c.openThread('message-1');
      await tester.pumpAndSettle();
      expect(text(tester), '@ken15 ');
      expect(c.threadMentions('lead', 'message-1'), {'ken': '@ken15'});
    },
  );

  testTags('an agent that left the chat since it was tagged is not sent', (
    tester,
  ) async {
    final server = swarm();
    final c = await show(tester, server);
    await type(tester, 'Please check @Kes');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    for (final group in server.state['conversations'] as List) {
      (group as Map)['agentIds'] = <String>[];
    }
    server.revision++;
    await c.refresh();
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(server.posts, isEmpty);
    expect(
      c.threadComposerError('lead', 'message-1') ?? c.error,
      contains('no longer in this conversation'),
    );
  });

  testTags('lost access clears the thread tags and the picker', (tester) async {
    final server = swarm();
    final c = await show(tester, server);
    await type(tester, '@ke');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await type(tester, '@ken15 @');
    expect(picker, findsOneWidget);
    c.revokeAccess('You no longer have access.');
    await tester.pumpAndSettle();
    expect(c.threadMentions('lead', 'message-1'), isEmpty);
    expect(picker, findsNothing);
    expect(find.text('ken15'), findsNothing);
  });

  group('Buddy threads', () {
    /// The reader's own Buddy chat ('offline') with its main Buddy, and a
    /// thread at its first message.
    ConversationServer buddyChat() {
      final server = swarm();
      server.state['threadSessions'] = true;
      final chat = (server.state['conversations'] as List)[1] as Map
        ..['kind'] = 'buddy'
        ..['buddyOwnerId'] = 'owner'
        ..['title'] = 'Wren';
      (server.state['agents'] as List).add({
        'id': 'buddy-main',
        'name': 'Wren',
        'displayName': 'Wren',
        'machineId': 'mac',
        'harnessId': 'h-main',
        'contributorId': 'owner',
        'buddyOf': {'personId': 'owner', 'generation': 'g1'},
        'configuration': {'engine': 'claude'},
      });
      chat['agentIds'] = ['buddy-main'];
      server.append('Measure prod CPU', conversationId: 'offline');
      server.append('Another question', conversationId: 'offline');
      return server;
    }

    Future<SuperTabController> showBuddy(
      WidgetTester tester,
      ConversationServer server,
      String root,
    ) async {
      final c = await show(tester, server);
      c.select('offline');
      await tester.pumpAndSettle();
      c.openThread(root);
      await tester.pumpAndSettle();
      return c;
    }

    testTags('a Buddy thread offers its Buddy, as the chat does', (
      tester,
    ) async {
      final server = buddyChat();
      await showBuddy(tester, server, 'message-4');
      await type(tester, '@');
      expect(choices(tester), ['Wren']);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final command = lastCommand(server);
      expect(command['conversationId'], 'offline');
      expect(command['replyTo'], 'message-4');
      expect(command['recipientIds'], ['buddy-main']);
    });

    testTags(
      'a thread its own session answers offers no agent: only the session '
      'hears it',
      (tester) async {
        final server = buddyChat();
        final chat = (server.state['conversations'] as List)[1] as Map;
        chat['buddySessions'] = [
          {
            'thread': 'message-4',
            'startId': 'start',
            'agentId': 'session-1',
            'at': 1,
          },
        ];
        (server.state['agents'] as List).add({
          'id': 'session-1',
          'name': 'Wren',
          'displayName': 'Wren',
          'machineId': 'mac',
          'harnessId': 'h-session',
          'contributorId': 'owner',
          'buddyOf': {'personId': 'owner', 'generation': 'g1'},
          'buddySession': {'thread': 'message-4', 'from': 1},
          'configuration': {'engine': 'claude'},
        });
        chat['agentIds'] = ['buddy-main', 'session-1'];
        final c = await showBuddy(tester, server, 'message-4');
        expect(c.threadSession('message-4'), isNotNull);
        await type(tester, '@');
        expect(picker, findsNothing);
        // In another thread of the chat, the Buddy is offered again.
        c.openThread('message-5');
        await tester.pumpAndSettle();
        await type(tester, '@');
        expect(choices(tester), ['Wren']);
      },
    );
  });
}
