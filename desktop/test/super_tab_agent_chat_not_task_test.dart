import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/backlog.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Audit #4211, finding 3: an agent's own chat is never a task card. The server
/// sends a v3 agent chat with no project; Desktop filed it under the first
/// project, so "Kestrel P2" sat in Next up on that project's Board.
void main() {
  test(
    'an agent\'s own chat is in no project and is not a Board task',
    () async {
      final server = swarm();
      (server.state['conversations'] as List).add({
        ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
        'kind': 'agent-chat',
        'agentIds': ['kestrel'],
      });
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      addTearDown(c.dispose);
      await c.refresh();
      final snapshot = c.snapshot!;
      final chat = snapshot.conversation('agent-chat-kestrel')!;
      expect(chat.isAgentChat, isTrue);
      expect(chat.projectId, '');
      final project = snapshot.projects.first;
      final titles = [
        for (final g in superTabProjectTasks(c, project)) g.label,
      ];
      expect(titles, isNot(contains('Kestrel')));
      // The project's real task is still listed.
      expect(titles, contains('Windows credential fix'));
      expect(
        c.projectConversations(project.id).map((g) => g.id),
        isNot(contains('agent-chat-kestrel')),
      );
    },
  );
}
