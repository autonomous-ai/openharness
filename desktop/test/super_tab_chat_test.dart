import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  test('work that waits on a person reads as people say it', () {
    expect(superTabWorkWaits('needs_human'), isTrue);
    expect(superTabWorkWaits('blocked'), isTrue);
    expect(superTabWorkWaits('working'), isFalse);
    expect(superTabWorkWaits(null), isFalse);
    expect(superTabWorkStatusLabel('blocked'), 'stuck');
    expect(superTabWorkStatusLabel('needs_human'), 'needs human');
    expect(superTabWorkStatusLabel('reconciling'), 'reconciling');
    expect(superTabWorkStatusLabel('cancelled'), 'cancelled');
    expect(superTabWorkWaits('cancelled'), isFalse);
  });

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    final c = server.controller();
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
    addTearDown(c.dispose);
    return c;
  }

  Future<void> showReadView(
    WidgetTester tester,
    SuperTabController c, {
    bool terminals = false,
    bool hidden = false,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: TickerMode(
            enabled: !hidden,
            child: Offstage(
              offstage: hidden,
              child: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Team Mac',
                terminalsVisible: terminals,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> closeReadView(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  }

  testWidgets('polling a displayed transcript does not keep requesting frames', (
    tester,
  ) async {
    final server = ConversationServer()..append('Already read');
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: server.request,
      save: server.save,
    );
    try {
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: ListenableBuilder(
              listenable: c,
              builder: (context, _) => SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Team Mac',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      c.start();
      server.append('New polled update');
      // Polling rebuilds the view during each frame. Reading its already-laid-out
      // tail must reuse that frame, rather than perpetually requesting another.
      await tester.pumpAndSettle(
        const Duration(seconds: 10),
        EnginePhase.sendSemanticsUpdate,
        const Duration(minutes: 1),
      );
      expect(find.text('New polled update'), findsOneWidget);
      expect(c.unread(c.selected!), isFalse);
    } finally {
      await closeReadView(tester, c);
      c.dispose();
    }
  });

  testWidgets('returning from terminals reads the already loaded transcript', (
    tester,
  ) async {
    final server = ConversationServer()..append('The result is ready.');
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await showReadView(tester, c, terminals: true);
    expect(c.unread(c.selected!), isTrue);
    await showReadView(tester, c);
    expect(find.text('The result is ready.'), findsOneWidget);
    expect(c.unread(c.selected!), isFalse);
    expect(tester.takeException(), isNull);
    await closeReadView(tester, c);
  });

  testWidgets(
    'revisiting a cached conversation acknowledges its visible tail',
    (tester) async {
      final server = ConversationServer()
        ..append('The lead has an update.')
        ..append('Workgroup result.', conversationId: 'offline');
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await showReadView(tester, c, terminals: true);
      expect(c.unread(c.selected!), isTrue);
      c.select('offline');
      await tester.pumpAndSettle();
      await showReadView(tester, c);
      expect(c.unread(c.selected!), isFalse);
      expect(c.unread(c.snapshot!.conversation('lead')!), isTrue);
      c.select('lead');
      await tester.pumpAndSettle();
      expect(find.text('The lead has an update.'), findsOneWidget);
      expect(c.unread(c.selected!), isFalse);
      await closeReadView(tester, c);
    },
  );

  testWidgets(
    'returning from pull requests reads only the displayed messages',
    (tester) async {
      final server = ConversationServer()..append('First update');
      final c = await show(tester, server);
      await tester.tap(find.byKey(const ValueKey('super-pull-requests')));
      await tester.pumpAndSettle();
      server.append('The review is ready.');
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.unread(c.selected!), isTrue);
      await tester.tap(find.byKey(const ValueKey('super-chat')));
      await tester.pumpAndSettle();
      expect(find.text('The review is ready.'), findsOneWidget);
      expect(c.unread(c.selected!), isFalse);
      await closeReadView(tester, c);
    },
  );

  testWidgets(
    'a read message does not become unread when its snapshot arrives',
    (tester) async {
      final server = ConversationServer()..append('First update');
      final c = await show(tester, server);
      server.append('Loaded before the snapshot');
      await c.loadMessages('lead');
      await tester.pumpAndSettle();
      expect(find.text('Loaded before the snapshot'), findsOneWidget);
      expect(c.selected!.lastMessageSequence, 1);
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.selected!.lastMessageSequence, 2);
      expect(c.unread(c.selected!), isFalse);
      await closeReadView(tester, c);
    },
  );

  testWidgets('a newer snapshot stays unread until its message is fetched', (
    tester,
  ) async {
    final server = ConversationServer()..append('Visible update');
    final c = await show(tester, server);
    await tester.tap(find.byKey(const ValueKey('super-pull-requests')));
    await tester.pumpAndSettle();
    server.append('Not yet fetched');
    c.snapshot = SuperTabSnapshot.fromJson(server.state);
    await tester.tap(find.byKey(const ValueKey('super-chat')));
    await tester.pumpAndSettle();
    expect(find.text('Not yet fetched'), findsNothing);
    expect(c.unread(c.selected!), isTrue);
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.text('Not yet fetched'), findsOneWidget);
    expect(c.unread(c.selected!), isFalse);
    await closeReadView(tester, c);
  });

  testWidgets('a hidden transcript does not consume a queued read callback', (
    tester,
  ) async {
    final server = ConversationServer()..append('Already read');
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await showReadView(tester, c);
    expect(c.unread(c.selected!), isFalse);
    server.append('Arrived as the tab was hidden');
    await c.refresh();
    // Hide before the callback scheduled by the message load can run.
    await showReadView(tester, c, hidden: true);
    expect(c.unread(c.selected!), isTrue);
    await showReadView(tester, c);
    expect(c.unread(c.selected!), isFalse);
    await closeReadView(tester, c);
  });

  testWidgets('background windows keep messages unread until foregrounded', (
    tester,
  ) async {
    final server = ConversationServer()..append('Already read');
    final c = await show(tester, server);
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    server.append('Arrived behind another window');
    await c.refresh();
    await tester.pumpAndSettle();
    expect(c.unread(c.selected!), isTrue);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(c.unread(c.selected!), isFalse);
    await closeReadView(tester, c);
  });

  for (final drawer in ['Conversations', 'Members and machines']) {
    testWidgets('$drawer keeps covered messages unread until revealed', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(600, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer()..append('Already read');
      final c = await show(tester, server);
      expect(c.unread(c.selected!), isFalse);

      await tester.tap(find.byTooltip(drawer));
      await tester.pumpAndSettle();
      server.append('Arrived behind the drawer');
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.unread(c.selected!), isTrue);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Arrived behind the drawer'), findsOneWidget);
      expect(c.unread(c.selected!), isFalse);

      await tester.tap(find.byTooltip(drawer));
      await tester.pumpAndSettle();
      server.append('Arrived before widening the window');
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.unread(c.selected!), isTrue);

      // Responsive side panes stop covering the chat even while their drawer
      // flags remain set, so this also needs to acknowledge the visible tail.
      await tester.binding.setSurfaceSize(const Size(1200, 700));
      await tester.pumpAndSettle();
      expect(find.text('Arrived before widening the window'), findsOneWidget);
      expect(c.unread(c.selected!), isFalse);
      await closeReadView(tester, c);
    });
  }

  for (final drawer in ['Conversations', 'Members and machines']) {
    testWidgets(
      '$drawer over the chat takes it from a device\'s voice until it closes or the window widens',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(600, 700));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final c = await show(tester, ConversationServer());
        expect(c.voiceConversation, isNotNull);

        await tester.tap(find.byTooltip(drawer));
        await tester.pumpAndSettle();
        expect(c.voiceConversation, isNull);

        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(c.voiceConversation, isNotNull);

        await tester.tap(find.byTooltip(drawer));
        await tester.pumpAndSettle();
        expect(c.voiceConversation, isNull);
        // Wide enough for the side panes, the drawer no longer covers the chat.
        await tester.binding.setSurfaceSize(const Size(1200, 700));
        await tester.pumpAndSettle();
        expect(c.voiceConversation, isNotNull);
        await closeReadView(tester, c);
      },
    );
  }

  testWidgets('a project stays unread until its unread workgroup is visited', (
    tester,
  ) async {
    final server = ConversationServer()
      ..append('The lead update')
      ..append('An unread workgroup update', conversationId: 'offline');
    final c = await show(tester, server);
    Finder projectDot() => find.descendant(
      of: find.byKey(const ValueKey('super-group-lead')),
      matching: find.byWidgetPredicate(
        (widget) =>
            widget is Semantics && widget.properties.label == 'Unread messages',
      ),
    );
    expect(c.unread(c.selected!), isFalse);
    expect(projectDot(), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('super-project-expand-lead')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-group-offline')));
    await tester.pumpAndSettle();
    expect(find.text('An unread workgroup update'), findsOneWidget);
    expect(c.unread(c.selected!), isFalse);
    expect(projectDot(), findsNothing);
    await closeReadView(tester, c);
  });

  testWidgets(
    'legacy messages resolve the same agent name in chat, replies and participants',
    (tester) async {
      final server = ConversationServer();
      (server.state['agents'] as List).add({
        'id': 'lead-agent',
        'name': 'hi',
        'displayName': 'Atlas',
        'machineId': 'm',
        'harnessId': 'native-lead',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      });
      (server.state['conversations'] as List)[0]
        ..['leadId'] = 'lead-agent'
        ..['agentIds'] = ['lead-agent'];
      server.append('What should we build?');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'lead-agent',
        'name': 'Lead',
      };
      final c = await show(tester, server);
      final row = find.byKey(const ValueKey('super-message-message-1'));
      expect(
        find.descendant(of: row, matching: find.text('Atlas')),
        findsOneWidget,
      );
      expect(find.text('hi'), findsNothing);
      expect(find.text('Lead'), findsNothing);
      tester
          .widget<Focus>(
            find.descendant(of: row, matching: find.byType(Focus)).first,
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
      await tester.pump();
      expect(find.text('Replying to Atlas'), findsOneWidget);
      final composer = find.byKey(const ValueKey('super-message-composer'));
      await tester.enterText(composer, 'Let’s discuss the plan.');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await c.refresh();
      await tester.pumpAndSettle();
      final reply = find.byKey(const ValueKey('super-message-message-2'));
      expect(
        find.descendant(of: reply, matching: find.text('Atlas')),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Members and machines'));
      await tester.pumpAndSettle();
      expect(find.text('hi'), findsNothing);
      expect(find.text('Atlas'), findsWidgets);
      expect(
        find.byKey(const ValueKey('super-member-lead-agent')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'a sent message whose credential was removed says so in one line above the composer',
    (tester) async {
      const notice =
          'Removed a credential (JWT) before saving. Revoke or rotate it.';
      final server = ConversationServer()
        ..commandResult['credentialNotice'] = notice;
      await show(tester, server);
      expect(
        find.byKey(const ValueKey('super-operation-notice')),
        findsNothing,
      );
      await tester.enterText(
        find.byKey(const ValueKey('super-message-composer')),
        'My login token is in here.',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text(notice), findsOneWidget);
      expect(
        find.byKey(const ValueKey('super-operation-notice')),
        findsOneWidget,
      );
      // Let the emptied draft's save run.
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets('the quote of your own message reads You, not your email', (
    tester,
  ) async {
    final server = ConversationServer()
      ..append('Where do we stand?')
      ..append('Almost done.');
    server.messages.last
      ..['replyTo'] = 'message-1'
      ..['author'] = {'kind': 'agent', 'id': 'builder', 'name': 'Builder'};
    await show(tester, server);
    final reply = find.byKey(const ValueKey('super-message-message-2'));
    final quote = find.descendant(
      of: reply,
      matching: find.byType(SuperTabReplyPreview),
    );
    expect(
      find.descendant(of: quote, matching: find.text('You')),
      findsOneWidget,
    );
    expect(find.text('owner@example.com'), findsNothing);
  });

  testWidgets('a removed agent keeps its recorded individual name', (
    tester,
  ) async {
    final server = ConversationServer()..append('The review is complete.');
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'removed-agent',
      'name': 'Builder',
      'displayName': 'Sage',
    };
    await show(tester, server);
    expect(find.text('Sage'), findsOneWidget);
    expect(find.text('Builder'), findsNothing);
  });

  test(
    'current agent identities resolve by ID; removed agents use recorded names',
    () {
      final server = ConversationServer()..append('An older message');
      (server.state['agents'] as List).add({
        'id': 'old-agent',
        'name': 'Builder',
        'displayName': 'Sage',
        'machineId': 'm',
        'harnessId': 'native',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      });
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'old-agent',
        'name': 'Builder',
      };
      final message = SuperTabMessage.fromJson(server.messages.last);
      expect(
        SuperTabSnapshot.fromJson(server.state).authorName(message),
        'Sage',
      );
      final renamed = SuperTabMessage.fromJson({
        ...server.messages.last,
        'author': {...message.author, 'displayName': 'Former name'},
      });
      expect(
        SuperTabSnapshot.fromJson(server.state).authorName(renamed),
        'Sage',
      );
      final human = SuperTabMessage.fromJson({
        ...server.messages.last,
        'author': {'kind': 'human', 'id': 'old-agent', 'name': 'Owner'},
      });
      expect(
        SuperTabSnapshot.fromJson(server.state).authorName(human),
        'Owner',
      );
      server.state['agents'] = <Object>[];
      expect(
        SuperTabSnapshot.fromJson(server.state).authorName(message),
        'Builder',
      );
      expect(
        SuperTabSnapshot.fromJson(server.state).authorName(renamed),
        'Former name',
      );
      expect(message.authorName, 'Builder');
    },
  );

  testWidgets(
    'a keyboard reply keeps its quoted context after sending and refreshing',
    (tester) async {
      final server = ConversationServer()
        ..append('Should edits survive restarting the app?');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'builder',
        'name': 'Builder',
      };
      final c = await show(tester, server);
      final row = find.byKey(const ValueKey('super-message-message-1'));
      tester
          .widget<Focus>(
            find.descendant(of: row, matching: find.byType(Focus)).first,
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
      await tester.pump();
      expect(find.text('Replying to Builder'), findsOneWidget);
      final composer = find.byKey(const ValueKey('super-message-composer'));
      expect(tester.widget<TextField>(composer).focusNode!.hasFocus, isTrue);
      await tester.enterText(composer, 'Yes, persist the local queue.');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect((server.posts.single['command'] as Map)['replyTo'], 'message-1');
      await c.refresh();
      await tester.pumpAndSettle();
      final reply = find.byKey(const ValueKey('super-message-message-2'));
      expect(
        find.descendant(of: reply, matching: find.byType(SuperTabReplyPreview)),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: reply,
          matching: find.text('Should edits survive restarting the app?'),
        ),
        findsOneWidget,
      );
      expect(find.text('Replying to Builder'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'incoming agent traffic preserves history and offers a scoped catch-up action',
    (tester) async {
      final server = ConversationServer();
      for (var i = 0; i < 35; i++) {
        server.append(
          'Agent update $i: checking the offline queue and reconnect behavior.',
        );
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'builder-$i',
          'name': 'Builder $i',
        };
      }
      final c = await show(tester, server);
      ScrollController scroll() => tester
          .widget<ListView>(
            find.byKey(const PageStorageKey('super-messages-tab-lead')),
          )
          .controller!;
      scroll().jumpTo(0);
      await tester.pumpAndSettle();
      final reading = scroll().offset;
      server.append('The reconnect check passed.');
      server.append('The restart check passed too.');
      await c.refresh();
      await tester.pumpAndSettle();
      expect(scroll().offset, reading);
      expect(find.text('2 new messages'), findsOneWidget);
      expect(c.unread(c.selected!), isTrue);
      await tester.tap(find.byKey(const ValueKey('super-pull-requests')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-chat')));
      await tester.pumpAndSettle();
      expect(scroll().offset, reading);
      expect(c.unread(c.selected!), isTrue);
      c.select('offline');
      await tester.pumpAndSettle();
      c.select('lead');
      await tester.pumpAndSettle();
      expect(scroll().offset, reading);
      expect(c.unread(c.selected!), isTrue);
      await tester.tap(find.byKey(const ValueKey('super-new-messages')));
      await tester.pumpAndSettle();
      expect(find.text('2 new messages'), findsNothing);
      expect(scroll().position.extentAfter, lessThan(40));
      expect(c.unread(c.selected!), isFalse);
      expect(find.text('The restart check passed too.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await closeReadView(tester, c);
    },
  );

  testWidgets(
    'revocation removes the quoted original as well as the transcript',
    (tester) async {
      final server = ConversationServer()..append('A private question');
      final c = await show(tester, server);
      await tester.tap(find.byTooltip('Reply'));
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabReplyPreview), findsOneWidget);
      c.revokeAccess('Access removed.');
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabReplyPreview), findsNothing);
      expect(find.text('A private question'), findsNothing);
      expect(
        tester
            .widget<TextField>(
              find.byKey(const ValueKey('super-message-composer')),
            )
            .controller!
            .text,
        isEmpty,
      );
    },
  );

  testWidgets(
    'a human request belongs only to its group and clears with the recorded state',
    (tester) async {
      final server = ConversationServer();
      server.state['agents'] = [
        {
          'id': 'builder',
          'name': 'Builder',
          'machineId': 'host',
          'harnessId': 'session',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      (server.state['conversations'] as List)[1]['agentIds'] = ['builder'];
      final group = (server.state['conversations'] as List)[1] as Map;
      group['assignment'] = {
        'id': 'attempt',
        'agentId': 'builder',
        'status': 'needs_human',
        'result': 'Which device should I test?',
      };
      final c = await show(tester, server);
      expect(find.text('Builder needs you'), findsNothing);
      c.select('offline');
      await tester.pumpAndSettle();
      expect(find.text('Builder needs you'), findsOneWidget);
      group['assignment']['status'] = 'working';
      server.revision++;
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Builder needs you'), findsNothing);
      // Stuck waits on a person as a decision does.
      group['assignment']
        ..['status'] = 'blocked'
        ..['result'] = 'The staging key is missing.';
      server.revision++;
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Builder needs you'), findsOneWidget);
    },
  );

  testWidgets(
    'Markdown preserves readable code and never loads message images',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 400,
              child: const SuperTabMessageText(
                '## Checked\n\n**Restart** preserves the queue.\n\n'
                '\u0060\u0060\u0060dart\nawait queue.flush();\n\u0060\u0060\u0060\n\n'
                '![Local image](file:///private/example.png)\n\n'
                '![Remote image](https://example.com/tracking.png)',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(MarkdownBody), findsOneWidget);
      expect(find.text('Checked'), findsOneWidget);
      expect(
        find.textContaining('queue.flush()', findRichText: true),
        findsWidgets,
      );
      expect(find.text('Image: Local image'), findsOneWidget);
      expect(find.text('Image: Remote image'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'messages wrap code without nested scrolling and link only known workgroups outside code',
    (tester) async {
      final opened = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SelectionArea(
              child: SizedBox(
                width: 260,
                child: SuperTabMessageText(
                  'See #12 and #99.\n\n`#12`\n\n```txt\n#12 long_code_that_must_wrap_without_a_second_scrollbar_abcdefghijklmnopqrstuvwxyz\n```',
                  references: const {12: 'work-id'},
                  onOpenGroup: opened.add,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(Scrollable), findsNothing);
      final links = <TextSpan>[];
      for (final text in tester.widgetList<RichText>(find.byType(RichText))) {
        text.text.visitChildren((span) {
          if (span is TextSpan && span.recognizer is TapGestureRecognizer) {
            links.add(span);
          }
          return true;
        });
      }
      expect(links.map((s) => s.text), ['#12']);
      (links.single.recognizer as TapGestureRecognizer).onTap!();
      expect(opened, ['work-id']);
      expect(tester.takeException(), isNull);
    },
  );

  test('message links permit only explicit http and https destinations', () {
    for (final href in [
      null,
      '',
      '/tmp/code',
      'file:///tmp/code',
      'javascript:alert(1)',
      'data:text/plain,hello',
      'https:///',
    ]) {
      expect(SuperTabMessageText.webLink(href), isNull);
    }
    expect(
      SuperTabMessageText.webLink('https://example.com/check#result')?.host,
      'example.com',
    );
    expect(SuperTabMessageText.webLink('http://localhost:3000')?.port, 3000);
  });

  test(
    'grouping preserves author, day, reply and native source boundaries',
    () {
      final server = ConversationServer()
        ..append('First update')
        ..append('Second update');
      SuperTabMessage message(int i) =>
          SuperTabMessage.fromJson(server.messages[i]);
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isTrue);
      server.append('Third update');
      server.append('Fourth update');
      expect(
        SuperTabMessageRow.consecutiveUpdates(
          server.messages.map(SuperTabMessage.fromJson).toList(),
        ),
        {'message-2', 'message-3'},
      );
      server.messages[1]['text'] = 'Should edits survive sign-out?';
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      expect(SuperTabMessageRow.groupsWith(message(2), message(1)), isFalse);
      server.messages[1]['text'] = '保留修改？';
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      server.messages[1]['text'] = 'Second update';
      server.messages[1]['author'] = {
        'kind': 'agent',
        'id': 'owner',
        'name': 'owner@example.com',
      };
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      server.messages[1]['author'] = server.messages[0]['author'];
      server.messages[1]['createdAt'] = '2026-10-19T00:00:00Z';
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      server.messages[1]['createdAt'] = server.messages[0]['createdAt'];
      server.messages[1]['replyTo'] = 'message-1';
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      server.messages[1].remove('replyTo');
      server.messages[1]['source'] = {'kind': 'native', 'phase': 'prompt'};
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
    },
  );

  test('a new display name starts its own message heading', () {
    final server = ConversationServer()
      ..append('Older update')
      ..append('Newer update');
    for (final row in server.messages) {
      row['author'] = {'kind': 'agent', 'id': 'same-agent', 'name': 'Lead'};
    }
    server.messages[1]['author']['displayName'] = 'Atlas';
    final messages = server.messages.map(SuperTabMessage.fromJson).toList();
    expect(messages.map((m) => m.authorName), ['Lead', 'Atlas']);
    expect(SuperTabMessageRow.groupsWith(messages[1], messages[0]), isFalse);
  });

  test(
    'reading loaded messages cannot mark an unfetched tail as read',
    () async {
      final server = ConversationServer()..append('Visible');
      final c = server.controller();
      await c.refresh();
      server.append('Not loaded');
      c.snapshot = SuperTabSnapshot.fromJson(server.state);
      c.markRead('lead', through: c.messages('lead').last.sequence);
      expect(c.unread(c.selected!), isTrue);
      await c.loadMessages('lead');
      c.markRead('lead', through: c.messages('lead').last.sequence);
      expect(c.unread(c.selected!), isFalse);
      await c.flush();
      c.dispose();
    },
  );
}
