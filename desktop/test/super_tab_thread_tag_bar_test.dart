import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/controller.dart';
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

  Finder bar() => find.byKey(const ValueKey('super-thread-tag-bar'));
  Finder panel() => find.byKey(const ValueKey('super-thread-panel'));
  Finder line(String root) => find.byKey(ValueKey('super-thread-line-$root'));

  /// Whether [text]'s row in the thread panel is lit.
  bool litInPanel(WidgetTester tester, String text) {
    final highlight = find.ancestor(
      of: find.descendant(of: panel(), matching: find.text(text)),
      matching: find.byType(SuperTabMessageHighlight),
    );
    return tester.widgetList<SuperTabMessageHighlight>(highlight).any(
      (h) => h.on,
    );
  }

  group('the thread tags of a chat', () {
    testWidgets('list oldest first, and leave out read ones, main-stream '
        'tags and muted chats', (tester) async {
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
    });
  });
}
