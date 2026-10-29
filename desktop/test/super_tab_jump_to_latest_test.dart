import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Scrolled away from the newest message, a chat and a thread offer the way
/// back (Scholes, 2026-10-29): "Jump to latest", or the count of what arrived
/// meanwhile.
void main() {
  const jump = ValueKey('super-jump-latest');
  const newMessages = ValueKey('super-new-messages');
  const peer = {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'};

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
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

  ScrollController chatScroll(WidgetTester tester) => tester
      .widget<ScrollView>(
        find.byKey(const PageStorageKey('super-messages-tab-lead')),
      )
      .controller!;

  Finder panel() => find.byKey(const ValueKey('super-thread-panel'));
  Finder inPanel(Finder finder) =>
      find.descendant(of: panel(), matching: finder);
  ScrollController threadScroll(WidgetTester tester) =>
      tester.widget<ListView>(inPanel(find.byType(ListView))).controller!;

  ConversationServer chat(int count) {
    final server = ConversationServer();
    for (var i = 1; i <= count; i++) {
      server.append('Update $i: checking the offline queue and reconnect.');
    }
    return server;
  }

  testWidgets('a chat scrolled up offers Jump to latest and the click takes '
      'the reader back to the newest message', (tester) async {
    await show(tester, chat(40));
    expect(find.byKey(jump), findsNothing);
    chatScroll(tester).jumpTo(0);
    await tester.pumpAndSettle();
    expect(find.byKey(jump), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(jump),
        matching: find.text('Jump to latest'),
      ),
      findsOneWidget,
    );

    await tester.tap(find.byKey(jump));
    await tester.pumpAndSettle();

    expect(find.byKey(jump), findsNothing);
    expect(chatScroll(tester).position.extentAfter, lessThan(40));
    expect(
      find.text('Update 40: checking the offline queue and reconnect.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('new messages arriving meanwhile turn it into one control with '
      'their count', (tester) async {
    final server = chat(40);
    final c = await show(tester, server);
    chatScroll(tester).jumpTo(0);
    await tester.pumpAndSettle();
    server.append('The reconnect check passed.');
    server.append('The restart check passed too.');
    await c.refresh();
    await tester.pumpAndSettle();

    expect(find.byKey(jump), findsNothing);
    expect(find.byKey(newMessages), findsOneWidget);
    expect(find.text('2 new messages'), findsOneWidget);

    await tester.tap(find.byKey(newMessages));
    await tester.pumpAndSettle();
    expect(find.byKey(newMessages), findsNothing);
    expect(find.byKey(jump), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets('a reader who scrolls back to the end loses the control '
      'without clicking it', (tester) async {
    await show(tester, chat(40));
    chatScroll(tester).jumpTo(0);
    await tester.pumpAndSettle();
    expect(find.byKey(jump), findsOneWidget);
    final scroll = chatScroll(tester);
    scroll.jumpTo(scroll.position.maxScrollExtent);
    await tester.pumpAndSettle();
    expect(find.byKey(jump), findsNothing);
  });

  testWidgets('access removed while scrolled up takes the control and the '
      'rows away', (tester) async {
    final c = await show(tester, chat(40));
    chatScroll(tester).jumpTo(0);
    await tester.pumpAndSettle();
    expect(find.byKey(jump), findsOneWidget);

    c.revokeAccess('Access removed.');
    await tester.pumpAndSettle();

    expect(find.byKey(jump), findsNothing);
    expect(find.byKey(newMessages), findsNothing);
    expect(find.textContaining('Update 1:'), findsNothing);
    expect(find.text('Conversation unavailable.'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets('a chat that fits the view never offers it', (tester) async {
    await show(tester, chat(2));
    expect(find.byKey(jump), findsNothing);
    expect(find.byKey(newMessages), findsNothing);
  });

  ConversationServer threadOf(int replies) {
    final server = ConversationServer()..threads = true;
    (server.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    server.append('Should we do thread replies?');
    for (var i = 1; i <= replies; i++) {
      server.append('Reply $i: a long enough answer to fill the pane.');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1'
        ..['author'] = peer;
    }
    return server;
  }

  testWidgets('a thread scrolled up offers Jump to latest and the click '
      'scrolls it to the newest reply', (tester) async {
    final c = await show(tester, threadOf(30));
    c.openThread('message-1');
    await tester.pumpAndSettle();
    expect(panel(), findsOneWidget);
    // A thread opens at its root, replies below.
    expect(inPanel(find.byKey(jump)), findsOneWidget);

    await tester.tap(inPanel(find.byKey(jump)));
    await tester.pumpAndSettle();

    expect(inPanel(find.byKey(jump)), findsNothing);
    expect(threadScroll(tester).position.extentAfter, lessThan(40));
    expect(
      inPanel(find.text('Reply 30: a long enough answer to fill the pane.')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a reply that arrives while the thread is read back is counted '
      'on the control', (tester) async {
    final server = threadOf(30);
    final c = await show(tester, server);
    c.openThread('message-1');
    await tester.pumpAndSettle();
    threadScroll(tester).jumpTo(300);
    await tester.pumpAndSettle();
    server.append('Reply 31: late.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['author'] = peer;
    await c.refresh();
    await tester.pumpAndSettle();

    expect(inPanel(find.text('1 new reply')), findsOneWidget);

    await tester.tap(inPanel(find.text('1 new reply')));
    await tester.pumpAndSettle();
    expect(inPanel(find.text('1 new reply')), findsNothing);
    expect(inPanel(find.byKey(jump)), findsNothing);
    expect(inPanel(find.text('Reply 31: late.')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets('a reply arriving while the thread is at its end keeps it '
      'there with no control', (tester) async {
    final server = threadOf(30);
    final c = await show(tester, server);
    c.openThread('message-1');
    await tester.pumpAndSettle();
    final scroll = threadScroll(tester);
    scroll.jumpTo(scroll.position.maxScrollExtent);
    await tester.pumpAndSettle();
    server.append('Reply 31: late.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['author'] = peer;
    await c.refresh();
    await tester.pumpAndSettle();

    expect(inPanel(find.byKey(jump)), findsNothing);
    expect(inPanel(find.text('Reply 31: late.')), findsOneWidget);
    expect(threadScroll(tester).position.extentAfter, lessThan(40));
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets('a thread that fits the pane never offers it', (tester) async {
    final c = await show(tester, threadOf(2));
    c.openThread('message-1');
    await tester.pumpAndSettle();
    expect(panel(), findsOneWidget);
    expect(inPanel(find.byKey(jump)), findsNothing);
  });
}
