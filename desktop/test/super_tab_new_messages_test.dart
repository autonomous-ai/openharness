import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_link.dart';
import 'package:harness/super_tabs/unread_line.dart';
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
  _spread(server);
}

/// [server]'s messages a minute apart, with six more before every third: the
/// long chat of three-message groups these tests were measured on, now that
/// one sender's messages within five minutes share one header (#2419).
void _spread(ConversationServer server) {
  for (final row in server.messages) {
    final sequence = row['sequence'] as int;
    row['createdAt'] = DateTime.utc(2026, 10, 18)
        .add(Duration(minutes: sequence + 6 * ((sequence - 1) ~/ 3)))
        .toIso8601String();
  }
}

void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    _spread(server);
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

  testWidgets('with newer pages not read yet, the bar\'s count is a floor', (
    tester,
  ) async {
    final server = _server(200)..messagePage = 20;
    server.markReadElsewhere('lead', 5);
    final c = await show(tester, server);
    expect(c.hasNewer('lead'), isTrue);
    // Down past the line in wheel steps, as a reader scrolls.
    final list = tester.getCenter(
      find.byKey(const PageStorageKey('super-messages-tab-lead')),
    );
    for (var step = 0; step < 4; step++) {
      tester.binding.handlePointerEvent(
        PointerScrollEvent(position: list, scrollDelta: const Offset(0, 100)),
      );
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isFalse);
    expect(c.hasNewer('lead'), isTrue);
    expect(
      find.descendant(
        of: find.byKey(_jump),
        matching: find.textContaining(RegExp(r'^\d+\+ new messages · Jump$')),
      ),
      findsOneWidget,
    );
  });

  // Review of #2896, item 1.
  testWidgets('once the line\'s message is no longer held (Jump to latest '
      'read the newest page in its place), no bar leads to it', (tester) async {
    final server = _server(200)..messagePage = 20;
    server.markReadElsewhere('lead', 5);
    final c = await show(tester, server);
    expect(c.hasNewer('lead'), isTrue);
    final latest = find.byWidgetPredicate(
      (w) =>
          w.key == const ValueKey('super-jump-latest') ||
          w.key == const ValueKey('super-new-messages'),
    );
    expect(latest, findsOneWidget);
    await tester.tap(latest);
    await tester.pumpAndSettle();
    expect(c.messages('lead').any((m) => m.id == 'message-6'), isFalse);
    expect(find.byKey(_jump), findsNothing);
    expect(find.textContaining('0 new messages'), findsNothing);
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

  testWidgets('scrolled past the line, the bar says how many are new and '
      'jumps back to it', (tester) async {
    final server = _server(60)..markReadElsewhere('lead', 20);
    await show(tester, server);
    // Seen as the chat opened at it: the bar shows only once it is above.
    expect(onScreen(tester, find.byKey(_line)), isTrue);
    expect(find.byKey(_jump), findsNothing);
    final position = scroll(tester);
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isFalse);
    expect(find.byKey(_jump), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(_jump),
        matching: find.text('40 new messages · Jump'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(_jump),
        matching: find.byIcon(AppIcons.arrowUp),
      ),
      findsOneWidget,
    );
    // A row across the top, above the list: it covers no message.
    final list = tester.getRect(
      find.byKey(const PageStorageKey('super-messages-tab-lead')),
    );
    final bar = tester.getRect(find.byKey(_jump));
    expect(bar.bottom, lessThanOrEqualTo(list.top));
    expect(bar.width, moreOrLessEquals(list.width, epsilon: 1));
    await tester.tap(find.byKey(_jump));
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isTrue);
    expect(find.byKey(_jump), findsNothing);
  });

  testWidgets('with the message list focused, Esc dismisses the bar and '
      'reads the chat', (tester) async {
    final server = _server(60)..markReadElsewhere('lead', 20);
    final c = await show(tester, server);
    final position = scroll(tester);
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(find.byKey(_jump), findsOneWidget);
    // Focus leaves the composer for the messages.
    await tester.tap(find.text('Update 59'));
    await tester.pumpAndSettle();
    expect(
      FocusManager.instance.primaryFocus?.context?.widget.key,
      isNot(const ValueKey('super-message-composer')),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(_jump), findsNothing);
    expect(find.byKey(_line), findsNothing);
    expect(c.unread(c.selected!), isFalse);
  });

  // Tern's test of #2896: a click on the bar left focus nowhere in the chat, so
  // a later Esc never reached it.
  testWidgets('after a click on the bar, Esc still dismisses it once the line '
      'is above again', (tester) async {
    final server = _server(60)..markReadElsewhere('lead', 20);
    final c = await show(tester, server);
    final position = scroll(tester);
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: tester.getCenter(find.byKey(_jump)));
    await mouse.down(tester.getCenter(find.byKey(_jump)));
    await mouse.up();
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isTrue);
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(find.byKey(_jump), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(_jump), findsNothing);
    expect(c.unread(c.selected!), isFalse);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  test('the bar counts its messages, and says when there are more', () {
    expect(SuperTabUnreadBar.label(1, false), '1 new message · Jump');
    expect(SuperTabUnreadBar.label(2, false), '2 new messages · Jump');
    expect(SuperTabUnreadBar.label(12, true), '12+ new messages · Jump');
  });

  /// The offline chat's 60 messages from the Lead, read up to [mark].
  ConversationServer offlineChat(int mark) {
    final server = _server(2);
    for (var i = 1; i <= 60; i++) {
      _fromLead(server, 'Offline $i', conversationId: 'offline');
    }
    server.markReadElsewhere('offline', mark);
    return server;
  }

  testWidgets('in a long chat, the line on screen as it opens offers no way '
      'back to it until it is above the screen', (tester) async {
    final server = _server(150)..markReadElsewhere('lead', 20);
    await show(tester, server);
    expect(onScreen(tester, find.byKey(_line)), isTrue);
    expect(find.byKey(_jump), findsNothing);
    // Seen, and still the bar comes once the line is above the screen.
    final position = scroll(tester);
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isFalse);
    expect(find.byKey(_jump), findsOneWidget);
  });

  testWidgets('a long chat opening at its line never shows the pill on the '
      'way there', (tester) async {
    final server = _server(150)..markReadElsewhere('lead', 20);
    final c = server.controller();
    await c.refresh();
    addTearDown(c.dispose);
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
    for (var frame = 0; frame < 60; frame++) {
      await tester.pump(const Duration(milliseconds: 16));
      expect(find.byKey(_jump), findsNothing, reason: 'frame $frame');
    }
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line)), isTrue);
  });

  testWidgets('opened at a linked message with the line near the top, the '
      'pill is still the way back to it', (tester) async {
    final c = await show(tester, offlineChat(8));
    c.openMessageLink(
      const SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'offline',
        messageId: 'message-50',
      ),
    );
    await tester.pumpAndSettle();
    expect(
      onScreen(
        tester,
        find.byKey(const ValueKey('super-message-message-50')),
        chat: 'offline',
      ),
      isTrue,
    );
    // The jump to the link passed the line; the reader never saw it.
    expect(onScreen(tester, find.byKey(_line), chat: 'offline'), isFalse);
    expect(find.byKey(_jump), findsOneWidget);
    await tester.tap(find.byKey(_jump));
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line), chat: 'offline'), isTrue);
    expect(find.byKey(_jump), findsNothing);
  });

  testWidgets('a second link in a chat showing the pill keeps it steady on '
      'the way', (tester) async {
    final c = await show(tester, offlineChat(22));
    c.openMessageLink(
      const SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'offline',
        messageId: 'message-60',
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(_jump), findsOneWidget);
    c.openMessageLink(
      const SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'offline',
        messageId: 'message-40',
      ),
    );
    for (var frame = 0; frame < 30; frame++) {
      await tester.pump(const Duration(milliseconds: 16));
      expect(find.byKey(_jump), findsOneWidget, reason: 'frame $frame');
    }
    await tester.pumpAndSettle();
    expect(
      onScreen(
        tester,
        find.byKey(const ValueKey('super-message-message-40')),
        chat: 'offline',
      ),
      isTrue,
    );
    expect(find.byKey(_jump), findsOneWidget);
  });

  testWidgets('opened at a linked message below the line, a bar above the '
      'list takes the reader back to it, then goes until the line is above '
      'again', (tester) async {
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
    // Read on past it, the line is above: the bar takes the pill's place.
    expect(find.byKey(_jump), findsOneWidget);
    expect(find.textContaining('new messages · Jump'), findsOneWidget);
  });

  testWidgets('opened at a linked message above the line, the pill points '
      'down to it', (tester) async {
    final server = _server(2);
    for (var i = 1; i <= 60; i++) {
      _fromLead(server, 'Offline $i', conversationId: 'offline');
    }
    server.markReadElsewhere('offline', 42);
    final c = await show(tester, server);
    c.openMessageLink(
      const SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'offline',
        messageId: 'message-12',
      ),
    );
    await tester.pumpAndSettle();
    expect(
      onScreen(
        tester,
        find.byKey(const ValueKey('super-message-message-12')),
        chat: 'offline',
      ),
      isTrue,
    );
    expect(onScreen(tester, find.byKey(_line), chat: 'offline'), isFalse);
    expect(find.byKey(_jump), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(_jump),
        matching: find.byIcon(AppIcons.chevronDown),
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(_jump));
    await tester.pumpAndSettle();
    expect(onScreen(tester, find.byKey(_line), chat: 'offline'), isTrue);
    expect(find.byKey(_jump), findsNothing);
  });

  Finder offlineList() =>
      find.byKey(const PageStorageKey('super-messages-tab-offline'));

  Future<double> linkedTop(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    final c = await show(tester, server);
    c.openMessageLink(
      const SwarmMessageLink(
        tabId: 'tab',
        conversationId: 'offline',
        messageId: 'message-45',
      ),
    );
    await tester.pumpAndSettle();
    return tester
        .getTopLeft(find.byKey(const ValueKey('super-message-message-45')))
        .dy;
  }

  testWidgets('the pill\'s band appearing leaves the linked message where '
      'the link put it', (tester) async {
    final read = await linkedTop(tester, offlineChat(62));
    expect(find.byKey(_jump), findsNothing);
    final unread = await linkedTop(tester, offlineChat(22));
    expect(find.byKey(_jump), findsOneWidget);
    // Layout arithmetic differs in the last bits with the rows above.
    expect(unread, moreOrLessEquals(read, epsilon: .5));
  });

  testWidgets('the band going as the reader scrolls up to the line moves the '
      'messages only by the scroll', (tester) async {
    await linkedTop(tester, offlineChat(22));
    expect(find.byKey(_jump), findsOneWidget);
    final rows = find.byWidgetPredicate(
      (w) =>
          w.key is ValueKey<String> &&
          (w.key! as ValueKey<String>).value.startsWith(
            'super-message-message-',
          ),
    );
    var steps = 0;
    while (find.byKey(_jump).evaluate().isNotEmpty && steps++ < 60) {
      final list = tester.getRect(offlineList());
      // A message in the middle of the view, still on screen after the step.
      final middle = rows.evaluate().map((e) => e.widget.key!).firstWhere((
        key,
      ) {
        final top = tester.getTopLeft(find.byKey(key)).dy;
        return top > list.center.dy - 100 && top < list.center.dy + 100;
      });
      final before = tester.getTopLeft(find.byKey(middle)).dy;
      tester.binding.handlePointerEvent(
        PointerScrollEvent(
          position: list.center,
          scrollDelta: const Offset(0, -30),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(find.byKey(middle)).dy - before,
        moreOrLessEquals(30, epsilon: .5),
        reason: 'step $steps',
      );
    }
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
    await tester.tap(find.byKey(const ValueKey('super-group-lead')));
    await tester.pumpAndSettle();
    // A workgroup with no work is in The rest, which starts folded (#2309).
    await tester.tap(find.byKey(const ValueKey('super-task-group-lead-rest')));
    await tester.pumpAndSettle();
    expect(weight(), grid.AppFont.semibold);
    // Read on another device.
    server.markReadElsewhere('offline', 3);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(weight(), isNot(grid.AppFont.semibold));
  });
}
