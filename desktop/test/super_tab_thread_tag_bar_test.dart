import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// A tag of the reader inside a thread, when they open its chat: the top of
/// the chat names it and opens the thread at the reply (Lê Lộc, #2814).
void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.dark,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller();
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
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    return c;
  }

  const peer = {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'};

  /// [roots] top-level messages in the lead chat, each with one reply from
  /// a teammate that lives only in its thread: message-1 (root) and
  /// message-2 (its reply), message-3 and message-4, and so on.
  ConversationServer threads(int roots) {
    final server = ConversationServer()..threads = true;
    (server.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    for (var i = 0; i < roots; i++) {
      server.append('Topic ${i + 1}');
      final root = server.messages.last['id'] as String;
      server.append('Reply to topic ${i + 1}, @owner please look');
      server.messages.last
        ..['thread'] = root
        ..['replyTo'] = root
        ..['author'] = peer;
    }
    return server;
  }

  /// The reader is tagged in [reply], a reply only in [root]'s thread.
  void tagIn(ConversationServer server, String reply, String root) {
    final sequence = server.messages.firstWhere(
      (m) => m['id'] == reply,
    )['sequence'];
    server.tag(reply, threadId: root, messageSequence: sequence as int);
  }

  /// Lets Activity's next re-read run out, so no timer outlives the test.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump(SuperTabAttention.quietGap);
    await tester.pumpAndSettle();
  }

  Finder bar() => find.byKey(const ValueKey('super-thread-tag-bar'));
  Finder panel() => find.byKey(const ValueKey('super-thread-panel'));
  Finder line(String root) => find.byKey(ValueKey('super-thread-line-$root'));

  /// Whether [text]'s row in the thread panel is lit.
  bool litInPanel(WidgetTester tester, String text) {
    final highlight = find.ancestor(
      of: find.descendant(of: panel(), matching: find.text(text)),
      matching: find.byType(SuperTabMessageHighlight),
    );
    return tester
        .widgetList<SuperTabMessageHighlight>(highlight)
        .any((h) => h.on);
  }

  group('the thread tags of a chat', () {
    testWidgets('list oldest first, and leave out read ones, main-stream '
        'tags and other chats', (tester) async {
      final server = threads(2);
      tagIn(server, 'message-4', 'message-3');
      tagIn(server, 'message-2', 'message-1');
      server.tag('message-1', messageSequence: 1);
      final c = await show(tester, server);
      final attention = SuperTabAttention.of(c);
      expect(attention.threadTagsIn('lead').map((m) => m.messageId), [
        'message-2',
        'message-4',
      ]);
      c.markThreadRead('lead', 'message-1', 2);
      await tester.pumpAndSettle();
      expect(attention.threadTagsIn('lead').map((m) => m.messageId), [
        'message-4',
      ]);
      expect(attention.threadTagsIn('other'), isEmpty);
      await settle(tester);
    });
  });

  group('the chat names a thread tag at its top', () {
    testWidgets('1 new reply mentions you · Open opens the thread at the '
        'reply, lit; then the row and the red number go', (tester) async {
      final server = threads(1);
      server.append('Later news in the chat.');
      tagIn(server, 'message-2', 'message-1');
      final c = await show(tester, server);
      final attention = SuperTabAttention.of(c);
      expect(attention.mentionsIn('lead'), 1);
      expect(
        find.descendant(
          of: bar(),
          matching: find.text('1 new reply mentions you · Open'),
        ),
        findsOneWidget,
      );
      expect(panel(), findsNothing);

      await tester.tap(bar());
      await tester.pump();
      expect(c.openedThread?.root, 'message-1');
      await tester.pump();
      await tester.pump();
      expect(panel(), findsOneWidget);
      expect(litInPanel(tester, 'Reply to topic 1, @owner please look'), true);
      await tester.pumpAndSettle();
      expect(bar(), findsNothing);
      expect(attention.mentionsIn('lead'), 0);
      await settle(tester);
    });

    testWidgets('two threads: Open goes to the oldest first, then the next', (
      tester,
    ) async {
      final server = threads(2);
      tagIn(server, 'message-4', 'message-3');
      tagIn(server, 'message-2', 'message-1');
      final c = await show(tester, server);
      expect(
        find.descendant(
          of: bar(),
          matching: find.text('2 new replies mention you · Open'),
        ),
        findsOneWidget,
      );
      await tester.tap(bar());
      await tester.pumpAndSettle();
      expect(c.openedThread?.root, 'message-1');
      expect(
        find.descendant(
          of: bar(),
          matching: find.text('1 new reply mentions you · Open'),
        ),
        findsOneWidget,
      );
      await tester.tap(bar());
      await tester.pumpAndSettle();
      expect(c.openedThread?.root, 'message-3');
      expect(bar(), findsNothing);
      await settle(tester);
    });

    testWidgets('a thread read from the Threads view clears the row', (
      tester,
    ) async {
      final server = threads(1);
      tagIn(server, 'message-2', 'message-1');
      final c = await show(tester, server);
      expect(bar(), findsOneWidget);
      c.markThreadRead('lead', 'message-1', 2);
      await tester.pumpAndSettle();
      expect(bar(), findsNothing);
      await settle(tester);
    });

    testWidgets('a tag in the main chat adds no thread row', (tester) async {
      final server = threads(1);
      server.append('A note for @owner in the chat.');
      server.messages.last['author'] = peer;
      server.tag('message-3', messageSequence: 3);
      await show(tester, server);
      expect(bar(), findsNothing);
      await settle(tester);
    });
  });
}
