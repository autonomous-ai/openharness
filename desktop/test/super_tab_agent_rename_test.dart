import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/super_tabs/actions.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// Renaming a harness renames its agent in the Swarm (task #2912, Darren): the
/// sidebar Agents list showed the name the agent was added with, and a terminal
/// title when the pane had no name of its own.

/// A Swarm read by [account] whose agent-1, Sage, the owner runs.
Future<SuperTabController> _swarm({String account = 'owner'}) async {
  final server = ConversationServer();
  if (account != 'owner') {
    (server.state['people'] as List).add({
      'id': account,
      'email': '$account@example.com',
      'role': 'collaborator',
    });
  }
  server.state['agents'] = [
    for (final (i, name) in ['Atlas', 'Sage'].indexed)
      {
        'id': 'agent-$i',
        'projectId': 'lead',
        'name': name,
        'displayName': name,
        'machineId': 'm',
        'harnessId': 'a$i',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
  ];
  final c = server.controller(account: account);
  addTearDown(c.dispose);
  await c.refresh();
  return c;
}

void main() {
  final captureDir = Platform.environment['HARNESS_ROSTER_CAPTURE_DIR'];
  setUpAll(() => loadCaptureFonts(captureDir));

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
        superTabAddName(
          const Agent(id: 'a', name: 'Claude harness 11-04 09:30'),
        ),
        'Agent',
      );
    });
  });

  group('Rename Harness reaches the Swarm', () {
    test('its person renames it, and the Swarm shows the new name', () async {
      final c = await _swarm();
      expect(c.snapshot!.agentName('agent-1'), 'Sage');
      expect(await c.renameAgent('agent-1', ' Darren PM '), isNull);
      expect(c.snapshot!.agentName('agent-1'), 'Darren PM');
    });

    test(
      'a teammate who does not run the agent is refused, with why',
      () async {
        final teammate = await _swarm(account: 'peer');
        final refused = await teammate.renameAgent('agent-1', 'Stolen');
        expect(refused, contains('Only the person who runs this agent'));
        expect(teammate.snapshot!.agentName('agent-1'), 'Sage');
      },
    );

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
      final errors = await client.renameHarnessAgent(
        'm',
        'native-pm',
        'Darren',
      );
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
