import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/super_tabs/actions.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';

import 'super_tab_roster_test.dart' show RosterFixture;
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// Renaming a harness renames its agent in the Swarm (task #2912, Darren): the
/// sidebar Agents list showed the name the agent was added with, and a terminal
/// title when the pane had no name of its own.
void main() {
  group('Add agent names the agent', () {
    test('an explicit harness name is sent as it is', () {
      expect(
        superTabAddName(const Agent(id: 'a', name: 'Release notes')),
        'Release notes',
      );
    });

    test('an automatic name is never its terminal title', () {
      // `displayName` of an automatic name is the session title: the
      // "cd /Users/…" row. The Swarm gives such an agent a member name.
      const agent = Agent(
        id: 'a',
        name: 'harness-3',
        title: 'cd /Users/macbookpro/projects/lamp',
      );
      expect(agent.displayName, startsWith('cd /Users'));
      expect(superTabAddName(agent), 'Agent');
      expect(
        superTabAddName(const Agent(id: 'a', name: 'harness 11-04 09:30')),
        'Agent',
      );
    });
  });

  group('Rename Harness reaches the Swarm', () {
    late RosterFixture f;
    setUp(() async {
      f = RosterFixture();
      await f.initialize();
    });

    testWidgets('the sidebar row shows the new name at once', (tester) async {
      await f.show(tester);
      expect(find.text('Sage'), findsOneWidget);
      final error = await f.controller.renameAgent('agent-1', 'Darren PM');
      expect(error, isNull);
      await tester.pumpAndSettle();
      expect(find.text('Darren PM'), findsOneWidget);
      expect(find.text('Sage'), findsNothing);
      await f.close(tester);
    });

    test('a refusal says why and changes nothing', () async {
      final other = f.server.controller(account: 'peer');
      await other.refresh();
      final refused = await other.renameAgent('agent-1', 'Stolen');
      expect(refused, contains('Only the person who runs this agent'));
      expect(other.snapshot!.agentName('agent-1'), isNot('Stolen'));
    });

    test('the client renames the agent in every loaded Swarm that holds '
        'the harness, and no other', () async {
      final holder = ConversationServer()..state['id'] = 'tab';
      holder.state['agents'] = [
        {
          'id': 'pm',
          'name': 'Lead',
          'displayName': 'Quinn',
          'machineId': 'm',
          'harnessId': 'native-pm',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      final bystander = ConversationServer()..state['id'] = 'other';
      final servers = {'tab': holder, 'other': bystander};
      final client = SuperTabClient(
        transport: (method, path, {body}) async {
          if (Uri.parse(path).path == '/api/super-tabs/list') {
            return {
              'tabs': [
                {'id': 'tab', 'name': 'Pilot'},
                {'id': 'other', 'name': 'Other'},
              ],
              'next': null,
            };
          }
          return servers[Uri.parse(path).pathSegments[2]]!.request(
            method,
            path,
            body: body,
          );
        },
        storage: MemoryStore(),
        onTabs: (_, _) {},
      )..bind('owner');
      final tab = await client.open('tab');
      await client.open('other');
      final errors = await client.renameHarnessAgent('m', 'native-pm', 'Darren');
      expect(errors, isEmpty);
      await tab.refresh();
      expect(tab.snapshot!.agentName('pm'), 'Darren');
      expect(
        await client.renameHarnessAgent('m', 'not-in-a-swarm', 'Nobody'),
        isEmpty,
      );
      client.dispose();
    });
  });
}
