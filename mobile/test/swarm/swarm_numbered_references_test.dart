import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart'
    show swarmCanOpenNumberedConversation, swarmNumberedReferences;
import 'package:harness_mobile/swarm/swarm_reader.dart';

import 'swarm_fixture.dart';

void main() {
  test(
    'numbered links resolve and authorize against the current reader',
    () async {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      final stale = SwarmReader(
        tabId: tab,
        accountId: me,
        request: fake.request,
      );
      addTearDown(stale.dispose);
      await stale.refresh();

      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [groupData('task-42', number: 42, title: 'Task 42')],
      );
      final current = SwarmReader(
        tabId: tab,
        accountId: me,
        request: fake.request,
      );
      addTearDown(current.dispose);
      await current.refresh();

      expect(swarmNumberedReferences(stale, '#42'), isEmpty);
      expect(swarmNumberedReferences(current, '#42'), {42: 'task-42'});
      expect(swarmCanOpenNumberedConversation(stale, 'task-42'), isFalse);
      expect(swarmCanOpenNumberedConversation(current, 'task-42'), isTrue);

      current.revoke();

      expect(swarmNumberedReferences(current, '#42'), isEmpty);
      expect(swarmCanOpenNumberedConversation(current, 'task-42'), isFalse);
    },
  );
}
