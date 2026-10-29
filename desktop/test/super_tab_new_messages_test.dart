import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
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

void _fromLead(ConversationServer server, String text) {
  server.append(text);
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
  bool onScreen(WidgetTester tester, Finder finder) {
    if (finder.evaluate().isEmpty) return false;
    final list = tester.getRect(
      find.byKey(const PageStorageKey('super-messages-tab-lead')),
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
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      greaterThan(tester.getTopLeft(find.text('Thread-only reply')).dy),
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

  testWidgets('scrolled away from the line, a pill jumps back to it', (
    tester,
  ) async {
    final server = _server(60)..markReadElsewhere('lead', 20);
    await show(tester, server);
    expect(find.byKey(_jump), findsNothing);
    final position = scroll(tester);
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isFalse);
    expect(find.byKey(_jump), findsOneWidget);
    expect(find.text('Jump to first unread'), findsOneWidget);
    await tester.tap(find.byKey(_jump));
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isTrue);
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
