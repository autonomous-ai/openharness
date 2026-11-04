import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/actions.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';

import 'super_tab_roster_test.dart' show RosterFixture;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// Renaming a harness renames its agent in the Swarm (task #2912, Darren): the
/// sidebar Agents list showed the name the agent was added with, and a terminal
/// title when the pane had no name of its own.
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
    late RosterFixture f;
    setUp(() async {
      f = RosterFixture();
      await f.initialize();
    });

    test('its person renames it, and the Swarm shows the new name', () async {
      expect(f.controller.snapshot!.agentName('agent-1'), 'Sage');
      expect(await f.controller.renameAgent('agent-1', ' Darren PM '), isNull);
      expect(f.controller.snapshot!.agentName('agent-1'), 'Darren PM');
    });

    testWidgets('the sidebar row shows the Swarm\'s current name, in its list '
        'and under Idle', (tester) async {
      // Built inside the test: its server and controller run on the test's clock.
      final f = RosterFixture();
      await f.initialize();
      await f.show(tester);
      expect(find.text('Sage'), findsOneWidget);
      (f.server.state['agents'] as List)[1]['displayName'] = 'Darren PM';
      (f.server.state['agents'] as List)[3]['displayName'] = 'Idle PM';
      await f.controller.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Darren PM'), findsOneWidget);
      expect(find.text('Idle PM'), findsOneWidget);
      expect(find.text('Sage'), findsNothing);
      await f.close(tester);
    });

    test(
      'a teammate who does not run the agent is refused, with why',
      () async {
        final teammate = RosterFixture(account: 'peer');
        await teammate.initialize();
        final refused = await teammate.controller.renameAgent(
          'agent-1',
          'Stolen',
        );
        expect(refused, contains('Only the person who runs this agent'));
        expect(teammate.controller.snapshot!.agentName('agent-1'), 'Sage');
      },
    );

    for (final brightness in [Brightness.light, Brightness.dark]) {
      testWidgets(
        'the Agents list before and after a rename, ${brightness.name}',
        (tester) async {
          final f = RosterFixture();
          await f.initialize();
          await tester.binding.setSurfaceSize(const Size(560, 420));
          final previous = grid.AppTheme.brightness.value;
          grid.AppTheme.brightness.value = brightness;
          addTearDown(() => grid.AppTheme.brightness.value = previous);
          final agents = f.server.state['agents'] as List;
          // As Darren's list was: the name the agent was added with, and a
          // terminal title.
          agents[1]['displayName'] = 'cd /Users/macbookpro/proj…';
          agents[3]['displayName'] = 'Divide';
          await f.controller.refresh();
          await f.show(tester, brightness: brightness);
          await captureBoundary(
            tester,
            f.boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            captureDir,
            'agents-before-${brightness.name}',
          );
          agents[1]['displayName'] = 'Release PM';
          agents[3]['displayName'] = 'Docs writer';
          await f.controller.refresh();
          await tester.pumpAndSettle();
          expect(find.text('Release PM'), findsOneWidget);
          expect(find.text('Docs writer'), findsOneWidget);
          expect(find.textContaining('cd /Users'), findsNothing);
          await captureBoundary(
            tester,
            f.boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            captureDir,
            'agents-after-${brightness.name}',
          );
          await f.close(tester);
        },
      );
    }

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
