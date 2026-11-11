import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/profile_actions.dart';

import 'support/super_tab_fixture.dart';

void main() {
  test('a refusal is said in words, and a viewer sends nothing', () async {
    final server = ConversationServer()..append('Shipped');
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await c.loadMessages('lead');
    server.refuse = {'code': 'FORBIDDEN', 'message': 'Not yours.'};
    expect(
      await c.editMessage(c.messages('lead').single, 'Changed'),
      'Not yours.',
    );
    server.refuse = null;
    server.state['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'viewer'},
    ];
    await c.refresh();
    final sent = server.posts.length;
    expect(
      await c.editMessage(c.messages('lead').single, 'Changed'),
      isNotNull,
    );
    expect(server.posts, hasLength(sent));
  });

  // The backend refuses a person's edit where only agents post (AGENTS_ONLY), and still takes their delete.
  test('a person may delete their own post in a project\'s channel and not edit it; in their agent\'s chat, both', () async {
    final server = ConversationServer();
    (server.state['conversations'] as List).add({
      ...conversationFixture('agent-chat-pip', 'Pip'),
      'kind': 'agent-chat',
    });
    server
      ..append('In the channel')
      ..append('To Pip', conversationId: 'agent-chat-pip');
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    await c.loadMessages('lead');
    await c.loadMessages('agent-chat-pip');
    final channel = c.messages('lead').single;
    final chat = c.messages('agent-chat-pip').single;
    expect(c.canChange(channel), isTrue);
    expect(c.canEdit(channel), isFalse);
    expect(c.canChange(chat), isTrue);
    expect(c.canEdit(chat), isTrue);
  });
}
