import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _line = ValueKey('super-new-messages-line');
const _jump = ValueKey('super-jump-unread');

/// [count] messages in the Lead conversation from the Lead agent.
ConversationServer _server(int count) {
  final server = ConversationServer();
  for (var i = 1; i <= count; i++) {
    _fromLead(server, 'Update $i');
  }
  return server;
}

void _fromLead(
  ConversationServer server,
  String text, {
  String conversationId = 'lead',
}) {
  server.append(text, conversationId: conversationId);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}

void main() {
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

  ScrollPosition scroll(WidgetTester tester) => tester
      .widget<ScrollView>(
        find.byKey(const PageStorageKey('super-messages-tab-lead')),
      )
      .controller!
      .position;

  /// Whether [finder]'s top edge is inside the message list's viewport.
  bool onScreen(WidgetTester tester, Finder finder, {String chat = 'lead'}) {
    if (finder.evaluate().isEmpty) return false;
    final list = tester.getRect(
      find.byKey(PageStorageKey('super-messages-tab-$chat')),
    );
    final top = tester.getTopLeft(finder).dy;
    return top >= list.top && top < list.bottom;
  }

  testWidgets('opens at a New messages line just above the first unread '
      'message', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 30);
    await show(tester, server);
    expect(find.byKey(_line), findsOneWidget);
    // Words as well as colour.
    expect(
      find.descendant(
        of: find.byKey(_line),
        matching: find.text('New messages'),
      ),
      findsOneWidget,
    );
    expect(onScreen(tester, find.byKey(_line)), isTrue);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 31')).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      greaterThan(tester.getTopLeft(find.text('Update 30')).dy),
    );
    // The newest messages are below, not where the view opened.
    expect(scroll(tester).extentAfter, greaterThan(40));
  });

  testWidgets('the reader\'s own message after the mark is not unread', (
    tester,
  ) async {
    final server = _server(30)..markReadElsewhere('lead', 28);
    server.append('My own answer');
    _fromLead(server, 'After my answer');
    await show(tester, server);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      greaterThan(tester.getTopLeft(find.text('My own answer')).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('After my answer')).dy),
    );
  });

  /// [server]'s next message as a reply in message 5's thread, [inChat] when
  /// also sent to the chat.
  void threadReply(
    ConversationServer server,
    String text, {
    bool inChat = false,
  }) {
    _fromLead(server, text);
    server.messages.last
      ..['thread'] = 'message-5'
      ..['alsoInChat'] = inChat;
  }

  testWidgets('a reply that lives only in its thread never gets the line; '
      'one also sent to the chat does', (tester) async {
    final server = _server(30)..markReadElsewhere('lead', 30);
    threadReply(server, 'Thread-only reply');
    threadReply(server, 'Reply also in the chat', inChat: true);
    await show(tester, server);
    // The chat no longer lists the thread's own reply (its thread does).
    expect(find.text('Thread-only reply'), findsNothing);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      greaterThan(tester.getTopLeft(find.text('Update 30')).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Reply also in the chat')).dy),
    );
  });

  testWidgets('only thread replies past the mark: no line and no pill', (
    tester,
  ) async {
    final server = _server(30)..markReadElsewhere('lead', 30);
    threadReply(server, 'Thread-only reply');
    final c = await show(tester, server);
    expect(find.byKey(_line), findsNothing);
    scroll(tester).jumpTo(0);
    await tester.pumpAndSettle();
    expect(find.byKey(_jump), findsNothing);
    expect(c.unread(c.selected!), isFalse);
  });

  testWidgets('a conversation never read anywhere opens at its end, with no '
      'line', (tester) async {
    await show(tester, _server(40));
    expect(find.byKey(_line), findsNothing);
    expect(scroll(tester).extentAfter, lessThan(40));
  });

  // Review of #2131, item 1: the first unread is older than the latest page.
  testWidgets('a first unread a few pages back is loaded, and the view opens '
      'at it', (tester) async {
    final server = _server(80)..messagePage = 20;
    server.markReadElsewhere('lead', 5);
    final c = await show(tester, server);
    expect(c.messages('lead').any((m) => m.id == 'message-6'), isTrue);
    expect(onScreen(tester, find.text('Update 6')), isTrue);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 6')).dy),
    );
    // Nothing was marked read while the history loaded.
    expect(c.readMark('lead'), 5);
  });

  testWidgets('a first unread many pages back opens at its page, not the '
      'whole history', (tester) async {
    final server = _server(200)..messagePage = 20;
    server.markReadElsewhere('lead', 5);
    final reads = <String>[];
    server.onRead = reads.add;
    final c = await show(tester, server);
    expect(onScreen(tester, find.text('Update 6')), isTrue);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 6')).dy),
    );
    // Bounded: the latest page, three back, then the page after the mark;
    // the middle of the gap is never read.
    expect(reads.where((r) => r.contains('before=121')), isEmpty);
    expect(c.messages('lead').any((m) => m.id == 'message-100'), isFalse);
    expect(c.hasNewer('lead'), isTrue);
    expect(c.readMark('lead'), 5);
  });

  // Review of #2131, item 2.
  testWidgets('the reader\'s own reply in a thread does not read the chat', (
    tester,
  ) async {
    final server = _server(30)..markReadElsewhere('lead', 28);
    server.append('My thread reply');
    server.messages.last['thread'] = 'message-5';
    await show(tester, server);
    expect(find.byKey(_line), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 29')).dy),
    );
    // Seen at the end of the list, under the line, they are read as any
    // conversation read to its end is; the line stays for this visit.
    await tester.pump(const Duration(seconds: 5));
    expect(find.byKey(_line), findsOneWidget);
  });

  // Diego, 10-29: a chat left less than 15 minutes ago keeps its messages,
  // and the view redrew from that stale copy before the newest page landed.
  testWidgets('back in a chat left with everything read, the line sits above '
      'what arrived meanwhile and nothing new is marked read', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 40);
    final c = await show(tester, server);
    await c.select('offline');
    await tester.pumpAndSettle();
    for (var i = 41; i <= 80; i++) {
      _fromLead(server, 'Update $i');
    }
    await c.refresh();
    await tester.pumpAndSettle();
    server.readMarkPosts.clear();
    // The newest page is still on its way when the chat is drawn again.
    final hold = server.holdReads = Completer<void>();
    unawaited(c.select('lead'));
    await tester.pump();
    await tester.pump();
    server.holdReads = null;
    hold.complete();
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 5));
    expect(find.byKey(_line), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      greaterThan(tester.getTopLeft(find.text('Update 40')).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 41')).dy),
    );
    expect(
      server.readMarkPosts.where((p) => (p['sequence'] as int) > 40),
      isEmpty,
    );
    expect(c.readMark('lead'), 40);
    // Read to the end, the chat is read.
    final position = scroll(tester);
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 5));
    expect(c.readMark('lead'), 80);
  });

  /// Reads [server]'s Lead chat through 40, leaves it, and lets [arrive]
  /// more messages arrive while it is away.
  Future<SuperTabController> leaveRead(
    WidgetTester tester,
    ConversationServer server, {
    int arrive = 40,
  }) async {
    final c = await show(tester, server);
    await c.select('offline');
    await tester.pumpAndSettle();
    for (var i = 41; i <= 40 + arrive; i++) {
      _fromLead(server, 'Update $i');
    }
    await c.refresh();
    await tester.pumpAndSettle();
    server.readMarkPosts.clear();
    return c;
  }

  testWidgets('a read that fails on the way back waits; the next read places '
      'the line', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 40);
    final c = await leaveRead(tester, server);
    server.failReads = true;
    await c.select('lead');
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 5));
    expect(c.awaitsNewest('lead'), isTrue);
    expect(find.byKey(_line), findsNothing);
    server.failReads = false;
    await c.refresh();
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 5));
    expect(c.awaitsNewest('lead'), isFalse);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 41')).dy),
    );
    expect(
      server.readMarkPosts.where((p) => (p['sequence'] as int) > 40),
      isEmpty,
    );
  });

  testWidgets('scrolled to the end of the held copy while the newest page is '
      'on its way, nothing is marked read', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 30);
    final c = await show(tester, server);
    await c.select('offline');
    await tester.pumpAndSettle();
    for (var i = 41; i <= 80; i++) {
      _fromLead(server, 'Update $i');
    }
    await c.refresh();
    await tester.pumpAndSettle();
    server.readMarkPosts.clear();
    final hold = server.holdReads = Completer<void>();
    unawaited(c.select('lead'));
    await tester.pump();
    final position = scroll(tester);
    position.jumpTo(position.maxScrollExtent);
    await tester.pump();
    await tester.pump();
    expect(server.readMarkPosts, isEmpty);
    server.holdReads = null;
    hold.complete();
    await tester.pumpAndSettle();
    expect(c.readMark('lead'), 30);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 31')).dy),
    );
  });

  testWidgets('a read that fails over a held copy that is current does not '
      'wait', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 40);
    final c = await leaveRead(tester, server, arrive: 0);
    server.failReads = true;
    await c.select('lead');
    await tester.pumpAndSettle();
    expect(c.awaitsNewest('lead'), isFalse);
    expect(find.byKey(_line), findsNothing);
    server.failReads = false;
  });

  testWidgets('access revoked while the newest page is on its way: the held '
      'copy and the wait go, and the late answer is dropped', (tester) async {
    final server = _server(40)..markReadElsewhere('lead', 40);
    final c = await leaveRead(tester, server);
    final hold = server.holdReads = Completer<void>();
    unawaited(c.select('lead'));
    await tester.pump();
    c.revokeAccess('You no longer have access.');
    server.holdReads = null;
    hold.complete();
    await tester.pumpAndSettle();
    expect(c.awaitsNewest('lead'), isFalse);
    expect(c.messages('lead'), isEmpty);
    expect(find.text('Update 41'), findsNothing);
    expect(find.byKey(_line), findsNothing);
    expect(server.readMarkPosts, isEmpty);
  });

  testWidgets('no line when everything is read', (tester) async {
    final server = _server(10)..markReadElsewhere('lead', 10);
    await show(tester, server);
    expect(find.byKey(_line), findsNothing);
    expect(find.byKey(_jump), findsNothing);
  });

  testWidgets('the line stays where it was while new messages arrive', (
    tester,
  ) async {
    final server = _server(40)..markReadElsewhere('lead', 30);
    final c = await show(tester, server);
    _fromLead(server, 'Update 41');
    _fromLead(server, 'Update 42');
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.byKey(_line), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 31')).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      greaterThan(tester.getTopLeft(find.text('Update 30')).dy),
    );
  });

  testWidgets('once the line has been seen, reading on to the end offers no '
      'way back to it', (tester) async {
    final server = _server(60)..markReadElsewhere('lead', 20);
    await show(tester, server);
    expect(onScreen(tester, find.byKey(_line)), isTrue);
    final position = scroll(tester);
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isFalse);
    expect(find.byKey(_jump), findsNothing);
  });

  testWidgets('opened at a linked message below the line, a pill above the '
      'list takes the reader back to it, then goes', (tester) async {
    final server = _server(2);
    for (var i = 1; i <= 60; i++) {
      _fromLead(server, 'Offline $i', conversationId: 'offline');
    }
    server.markReadElsewhere('offline', 22);
    final c = await show(tester, server);
    c.openMessageLink(
      const SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'offline',
        messageId: 'message-60',
      ),
    );
    await tester.pumpAndSettle();
    expect(c.selectedId, 'offline');
    expect(
      onScreen(
        tester,
        find.byKey(const ValueKey('super-message-message-60')),
        chat: 'offline',
      ),
      isTrue,
    );
    expect(onScreen(tester, find.byKey(_line), chat: 'offline'), isFalse);
    expect(find.byKey(_jump), findsOneWidget);
    // In its own place above the list: it covers no message.
    final list = tester.getRect(
      find.byKey(const PageStorageKey('super-messages-tab-offline')),
    );
    expect(
      tester.getRect(find.byKey(_jump)).bottom,
      lessThanOrEqualTo(list.top),
    );
    await tester.tap(find.byKey(_jump));
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line), chat: 'offline'), isTrue);
    expect(find.byKey(_jump), findsNothing);
    final position = tester
        .widget<ScrollView>(
          find.byKey(const PageStorageKey('super-messages-tab-offline')),
        )
        .controller!
        .position;
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(find.byKey(_jump), findsNothing);
  });

  testWidgets('Esc marks the conversation read and clears the line', (
    tester,
  ) async {
    final server = _server(40)..markReadElsewhere('lead', 30);
    final c = await show(tester, server);
    expect(c.unread(c.selected!), isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(_line), findsNothing);
    expect(c.unread(c.selected!), isFalse);
    expect(server.readMarkPosts.last, {
      'conversationId': 'lead',
      'sequence': 40,
    });
  });

  testWidgets('the sidebar\'s bold follows the mark kept on the server', (
    tester,
  ) async {
    final server = _server(2);
    server.append('Elsewhere', conversationId: 'offline');
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'worker',
      'name': 'Worker',
    };
    final c = await show(tester, server);
    FontWeight? weight() => tester
        .widget<RichText>(
          find.descendant(
            of: find.byKey(const ValueKey('super-group-offline')),
            matching: find.byWidgetPredicate(
              (widget) =>
                  widget is RichText &&
                  widget.text.toPlainText() == 'Offline editing',
            ),
          ),
        )
        .text
        .style
        ?.fontWeight;
    await tester.tap(find.byKey(const ValueKey('super-project-toggle-lead')));
    await tester.pumpAndSettle();
    expect(weight(), grid.AppFont.semibold);
    // Read on another device.
    server.markReadElsewhere('offline', 3);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(weight(), isNot(grid.AppFont.semibold));
  });
}
