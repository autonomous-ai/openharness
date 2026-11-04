import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const _line = ValueKey('super-new-messages-line');

/// [count] messages from the Lead agent in the Lead conversation, read to
/// the end on the server.
ConversationServer _read(int count) {
  final server = ConversationServer();
  for (var i = 1; i <= count; i++) {
    server.append('Update $i');
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'lead-agent',
      'name': 'Lead',
    };
  }
  return server..markReadElsewhere('lead', count);
}

void main() {
  late SuperTabController c;

  Future<void> show(WidgetTester tester, ConversationServer server) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    c = server.controller();
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
  }

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));
  Finder more(String id) => find.descendant(
    of: row(id),
    matching: find.byKey(ValueKey('super-message-more-$id')),
  );

  Future<void> markUnread(WidgetTester tester, String id) async {
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(row(id)));
    await tester.pumpAndSettle();
    await tester.tap(more(id));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Mark unread'));
    await tester.pumpAndSettle();
    await mouse.removePointer();
    await tester.pumpAndSettle();
  }

  bool leadUnread() => c.unread(c.snapshot!.conversation('lead')!);

  testWidgets('Mark unread puts the New messages line above the message and '
      'the chat counts unread again', (tester) async {
    final server = _read(6);
    await show(tester, server);
    expect(find.byKey(_line), findsNothing);
    expect(leadUnread(), isFalse);

    await markUnread(tester, 'message-4');

    expect(server.unreadPosts, [
      {'conversationId': 'lead', 'sequence': 4},
    ]);
    expect(c.readMark('lead'), 3);
    expect(leadUnread(), isTrue);
    expect(find.byKey(_line), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      lessThan(tester.getTopLeft(find.text('Update 4')).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(_line)).dy,
      greaterThan(tester.getTopLeft(find.text('Update 3')).dy),
    );
    // The menu closes after a choice.
    expect(find.text('Mark unread'), findsNothing);
  });

  testWidgets('the open chat stays unread until the reader leaves it', (
    tester,
  ) async {
    final server = _read(6);
    await show(tester, server);
    await markUnread(tester, 'message-4');
    final sent = List.of(server.readMarkPosts);

    // Polls and the visible end being read do not read it again.
    await c.refresh();
    await tester.pumpAndSettle();
    c.markRead('lead');
    await tester.pumpAndSettle();
    expect(server.readMarkPosts, sent);
    expect(leadUnread(), isTrue);
    expect(find.byKey(_line), findsOneWidget);
    expect(c.readMark('lead'), 3);

    // Left and opened again: read as any chat is.
    await c.select('offline');
    await tester.pumpAndSettle();
    await c.select('lead');
    await tester.pumpAndSettle();
    c.markRead('lead');
    await tester.pumpAndSettle();
    expect(c.readMark('lead'), 6);
    expect(server.readMarkPosts.last, {
      'conversationId': 'lead',
      'sequence': 6,
    });
    // The view's short timers (a highlight) end before the tree goes.
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('a mark lowered on another device is taken here', (tester) async {
    final server = _read(6);
    await show(tester, server);
    expect(c.readMark('lead'), 6);
    // Another chat is open, so nothing here reads Lead again.
    await c.select('offline');
    await tester.pumpAndSettle();

    server.markUnreadElsewhere('lead', 2);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(c.readMark('lead'), 1);
    expect(leadUnread(), isTrue);

    // A read after it, here or elsewhere, wins again.
    server.markReadElsewhere('lead', 5);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(c.readMark('lead'), 5);
  });

  testWidgets('a reply only in its thread offers no Mark unread', (
    tester,
  ) async {
    final server = _read(3)..threads = true;
    server.append('Root');
    server.append('In the thread only');
    server.messages.last['thread'] = 'message-4';
    server.markReadElsewhere('lead', 5);
    await show(tester, server);
    c.openThread('message-4');
    await tester.pumpAndSettle();
    final reply = find.byKey(const ValueKey('super-thread-message-message-5'));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(reply));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: reply,
        matching: find.byKey(const ValueKey('super-message-more-message-5')),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Copy link to message'), findsOneWidget);
    expect(find.text('Mark unread'), findsNothing);
  });
}
