import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/client.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// Names a person chose before #3015 reach the Swarm on their own (task
/// #2920, Darren): the daemon's frame says `nameChosen`, and Desktop sends
/// only those names, once.
void main() {
  group('the agent frame', () {
    test('carries whether a person chose the name; an older daemon says nothing',
        () {
      expect(Agent.fromJson({'id': 'a', 'name': 'x', 'nameChosen': true}).nameChosen,
          isTrue);
      expect(Agent.fromJson({'id': 'a', 'name': 'x', 'nameChosen': false}).nameChosen,
          isFalse);
      expect(Agent.fromJson({'id': 'a', 'name': 'x'}).nameChosen, isNull);
    });

    test('a change of it is a change of the agent', () {
      final before = Agent.fromJson({'id': 'a', 'name': 'x'});
      final after = Agent.fromJson({'id': 'a', 'name': 'x', 'nameChosen': true});
      expect(AppNotifier.agentsEqual([before], [after]), isFalse);
    });
  });

  group('sending chosen names to the Swarm', () {
    // A Swarm that holds the harness with the name it was added with: the
    // terminal title, as Darren's list showed.
    ConversationServer swarm({String contributor = 'owner'}) {
      final server = ConversationServer()..state['id'] = 'tab';
      server.state['agents'] = [
        {
          'id': 'pm',
          'name': 'Lead',
          'displayName': 'cd /Users/macbookpro/proj…',
          'machineId': 'm',
          'harnessId': 'native-pm',
          'contributorId': contributor,
          'machineOwnerId': contributor,
          'configuration': {'engine': 'claude'},
        },
      ];
      return server;
    }

    Future<(SuperTabClient, ConversationServer)> opened({
      String contributor = 'owner',
    }) async {
      final server = swarm(contributor: contributor);
      final client = SuperTabClient(
        transport: (method, path, {body}) async {
          if (Uri.parse(path).path == '/api/super-tabs/list') {
            return {
              'tabs': [
                {'id': 'tab', 'name': 'Pilot'},
              ],
              'next': null,
            };
          }
          return server.request(method, path, body: body);
        },
        storage: MemoryStore(),
        onTabs: (_, _) {},
      )..bind('owner');
      await client.open('tab');
      addTearDown(client.dispose);
      return (client, server);
    }

    Agent Function(String, String) local(Map<String, dynamic> frame) =>
        (machineId, harnessId) => Agent.fromJson({
          'id': 'native-pm',
          'name': 'Darren PM',
          ...frame,
        });

    test('a name chosen before the update shows in the Swarm, with no rename',
        () async {
      final (client, _) = await opened();
      final sent = await client.syncChosenNames(
        local({'nameChosen': true}),
      );
      expect(sent, 1);
      final c = await client.open('tab');
      await c.refresh();
      expect(c.snapshot!.agentName('pm'), 'Darren PM');
    });

    test('once per agent and name: the next look sends nothing', () async {
      final (client, server) = await opened();
      final lookup = local({'nameChosen': true});
      expect(await client.syncChosenNames(lookup), 1);
      expect(await client.syncChosenNames(lookup), 0);
      expect(server.commandCount('agent.rename'), 1);
    });

    test('a name nobody chose never sends the session title', () async {
      final (client, server) = await opened();
      final sent = await client.syncChosenNames(
        local({'name': 'cd /Users/macbookpro/proj…', 'nameChosen': false}),
      );
      expect(sent, 0);
      expect(server.commandCount('agent.rename'), 0);
    });

    test('an older daemon, with no flag, sends nothing', () async {
      final (client, server) = await opened();
      expect(await client.syncChosenNames(local({})), 0);
      expect(server.commandCount('agent.rename'), 0);
    });

    test('the Swarm already shows the name: nothing is sent', () async {
      final (client, server) = await opened();
      final sent = await client.syncChosenNames(
        local({'name': 'cd /Users/macbookpro/proj…', 'nameChosen': true}),
      );
      expect(sent, 0);
      expect(server.commandCount('agent.rename'), 0);
    });

    test('an agent this person does not run is left alone', () async {
      final (client, server) = await opened(contributor: 'teammate');
      expect(
        await client.syncChosenNames(local({'nameChosen': true})),
        0,
      );
      expect(server.commandCount('agent.rename'), 0);
    });

    test('a harness this machine does not know is left alone', () async {
      final (client, server) = await opened();
      expect(await client.syncChosenNames((_, _) => null), 0);
      expect(server.commandCount('agent.rename'), 0);
    });
  });
}
