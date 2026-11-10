import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
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
}
