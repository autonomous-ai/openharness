import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/message_link_preview.dart';
import 'package:harness/super_tabs/message_link_swarms.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/pm_chat_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The Swarms of one account, for a link that points into another of them.
class _Swarms implements SwarmLinkSwarms {
  _Swarms(this.controllers);
  final Map<String, SuperTabController> controllers;
  final opened = <String>[];

  @override
  SuperTabController? loaded(String tabId) => controllers[tabId];

  @override
  SuperTabLinkTarget read(SwarmMessageLink link, VoidCallback onRead) =>
      const SuperTabLinkTarget.unavailable();

  @override
  Future<bool> open(SwarmMessageLink link) async {
    opened.add(link.url);
    return controllers[link.tabId]?.openMessageLink(link) ?? false;
  }
}

void main() {
  late SuperTabController c;

  Future<void> show(
    WidgetTester tester,
    ConversationServer server, {
    SwarmLinkSwarms? linkSwarms,
    SuperTabController? controller,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    c = controller ?? server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            linkSwarms: linkSwarms,
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
  }

  String linkTo(
    String messageId, {
    String tab = 'tab',
    String conversation = 'lead',
  }) => SwarmMessageLink(
    tabId: tab,
    conversationId: conversation,
    messageId: messageId,
  ).url;

  Finder preview(String messageId) =>
      find.byKey(ValueKey('super-message-link-preview-$messageId'));
  Finder inPreview(String messageId, String text) =>
      find.descendant(of: preview(messageId), matching: find.text(text));
  Finder note(String text) =>
      find.descendant(of: find.byType(SnackBar), matching: find.text(text));

  group('a message read that fails', () {
    /// Three notes in Offline editing, then a message in Lead linking to the
    /// first: Offline editing is not the open chat, so its message is read
    /// by itself.
    ConversationServer linking() {
      final server = ConversationServer()
        ..append('Offline note', conversationId: 'offline');
      return server
        ..append('See ${linkTo('message-1', conversation: 'offline')}');
    }

    testWidgets('a refusal reads Message unavailable, not Loading', (
      tester,
    ) async {
      final server = linking()..forbidMessageReads.add('offline');
      await show(tester, server);
      expect(inPreview('message-1', 'Message unavailable'), findsOneWidget);
      expect(find.text('Loading message…'), findsNothing);
      expect(find.textContaining('Offline note'), findsNothing);
    });

    testWidgets('a transient failure is read again and then shows', (
      tester,
    ) async {
      final reads = <String>[];
      final server = linking()
        ..onRead = reads.add
        ..failMessageReads = 2;
      await show(tester, server);
      expect(inPreview('message-1', 'Loading message…'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      expect(inPreview('message-1', 'Offline note'), findsOneWidget);
      expect(
        reads.where((p) => p.contains('messageId=message-1')),
        hasLength(3),
      );
    });

    testWidgets('a failure that lasts stops asking and says unavailable', (
      tester,
    ) async {
      final reads = <String>[];
      final server = linking()
        ..onRead = reads.add
        ..failMessageReads = 99;
      await show(tester, server);
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      expect(inPreview('message-1', 'Message unavailable'), findsOneWidget);
      await tester.pump(const Duration(minutes: 5));
      expect(
        reads.where((p) => p.contains('messageId=message-1')),
        hasLength(3),
      );
    });
  });

  group('a link into a hidden Chat with PM', () {
    Future<(ConversationServer, String, String)> hidden() async {
      final server = buddySwarm(enabled: false);
      final peer = server.controller(account: 'peer');
      await peer.refresh();
      await peer.openPmChat('lead');
      final chat = peer.pmChat('lead')!.id;
      await peer.select('lead');
      pmReply(server, chat, 'Earlier answer from the PM');
      final message = server.messages.last['id'] as String;
      await peer.refresh();
      server.state['buddies'] = true;
      giveBuddy(server);
      peer.dispose();
      return (server, chat, message);
    }

    testWidgets('stays where the reader is, with Message unavailable', (
      tester,
    ) async {
      final (server, chat, message) = await hidden();
      await show(
        tester,
        server,
        controller: server.controller(account: 'peer'),
      );
      expect(c.selectedId, 'lead');
      c.openMessageLink(
        SwarmMessageLink(
          tabId: 'tab',
          conversationId: chat,
          messageId: message,
        ),
      );
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      expect(note('Message unavailable'), findsOneWidget);
    });

    testWidgets('previews as unavailable', (tester) async {
      final (server, chat, message) = await hidden();
      server.append('See ${linkTo(message, conversation: chat)}');
      await show(
        tester,
        server,
        controller: server.controller(account: 'peer'),
      );
      expect(inPreview(message, 'Message unavailable'), findsOneWidget);
      expect(find.textContaining('Earlier answer'), findsNothing);
    });
  });

  group('a link into another Swarm', () {
    late ConversationServer other;
    late SuperTabController otherController;
    late _Swarms swarms;

    setUp(() {
      other = ConversationServer()
        ..state['id'] = 'tab2'
        ..state['name'] = 'Second';
      (other.state['conversations'] as List).add(
        conversationFixture('secret', 'Hidden plans'),
      );
      other
        ..append('Second Swarm note')
        ..append('Hidden plan text', conversationId: 'secret')
        ..forbidMessageReads.add('secret');
      otherController = other.controller(tabId: 'tab2');
      swarms = _Swarms({'tab2': otherController});
    });

    Future<ConversationServer> first(List<String> texts) async {
      final server = ConversationServer();
      for (final text in texts) {
        server.append(text);
      }
      await otherController.refresh();
      addTearDown(otherController.dispose);
      return server;
    }

    testWidgets('previews a message of a Swarm the account can read', (
      tester,
    ) async {
      final server = await first(['See ${linkTo('message-1', tab: 'tab2')}']);
      await show(tester, server, linkSwarms: swarms);
      expect(inPreview('message-1', 'Second Swarm note'), findsOneWidget);
      expect(inPreview('message-1', 'You'), findsOneWidget);
    });

    testWidgets('opens it in that Swarm, through the account’s Swarms', (
      tester,
    ) async {
      final server = await first(['See ${linkTo('message-1', tab: 'tab2')}']);
      await show(tester, server, linkSwarms: swarms);
      await tester.tap(preview('message-1'));
      await tester.pumpAndSettle();
      expect(swarms.opened, [linkTo('message-1', tab: 'tab2')]);
      expect(otherController.messageRequest, (
        conversationId: 'lead',
        messageId: 'message-1',
      ));
      expect(c.selectedId, 'lead');
    });

    testWidgets('a private chat there shows no title, author or text', (
      tester,
    ) async {
      final server = await first([
        'See ${linkTo('message-2', tab: 'tab2', conversation: 'secret')}',
      ]);
      await show(tester, server, linkSwarms: swarms);
      expect(inPreview('message-2', 'Message unavailable'), findsOneWidget);
      expect(find.textContaining('Hidden'), findsNothing);
      expect(
        find.descendant(of: preview('message-2'), matching: find.byType(Text)),
        findsOneWidget,
      );
    });

    testWidgets('a Swarm the account does not list reads nothing', (
      tester,
    ) async {
      final server = await first([
        'See ${linkTo('message-1', tab: 'not-mine')}',
      ]);
      await show(tester, server, linkSwarms: swarms);
      expect(inPreview('message-1', 'Message unavailable'), findsOneWidget);
      await tester.tap(preview('message-1'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(swarms.opened, isEmpty);
    });
  });
}
